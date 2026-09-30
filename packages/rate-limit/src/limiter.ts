import { systemClock, type Clock } from '@ai-gateway/core';
import type { KeyValueStore } from '@ai-gateway/cache';
import {
  WINDOW_SECONDS,
  type RateLimitCheck,
  type RateLimitContext,
  type RateLimitRule,
  type RateLimitRuleResult,
} from './types.js';

export interface RateLimiterOptions {
  kv: KeyValueStore;
  clock?: Clock;
  /** Prefix for every key, so one Redis can host several environments. */
  namespace?: string;
}

/**
 * Distributed sliding-window rate limiter.
 *
 * Fixed windows let a caller send 2x the limit across a window boundary, which
 * is exactly the burst a gateway in front of a metered API must not pass
 * upstream. This uses a sliding log per rule: timestamps in a sorted set,
 * trimmed to the window on every check.
 *
 * Token limits are inherently two-phase - the true token count only exists
 * after the model responds - so `check` reserves an estimate and `settle`
 * reconciles it against the provider's reported usage.
 */
export class RateLimiter {
  private readonly kv: KeyValueStore;
  private readonly clock: Clock;
  private readonly namespace: string;

  constructor(opts: RateLimiterOptions) {
    this.kv = opts.kv;
    this.clock = opts.clock ?? systemClock;
    this.namespace = opts.namespace ?? 'rl';
  }

  /**
   * Evaluate every applicable rule.
   *
   * Request-unit rules are consumed here. Token-unit rules are only *read*
   * here; they are consumed by `settle` once the real usage is known.
   */
  async check(
    rules: RateLimitRule[],
    ctx: RateLimitContext,
    estimatedTokens = 0,
  ): Promise<RateLimitCheck> {
    const applicable = rules.filter((rule) => this.applies(rule, ctx));
    const results: RateLimitRuleResult[] = [];
    let violated: RateLimitRule | undefined;

    for (const rule of applicable) {
      const key = this.keyFor(rule, ctx);
      const windowMs = WINDOW_SECONDS[rule.window] * 1000;
      const now = this.clock.now();

      await this.kv.zremrangebyscore(key, 0, now - windowMs);
      const used = rule.unit === 'requests' ? await this.kv.zcard(key) : await this.readTokens(key);
      const cost = rule.unit === 'requests' ? 1 : estimatedTokens;
      const wouldBe = used + cost;
      const allowed = wouldBe <= rule.limit;

      results.push({
        rule,
        used,
        limit: rule.limit,
        // Reported after this request's cost, which is what callers pacing
        // themselves against the header expect.
        remaining: Math.max(0, rule.limit - wouldBe),
        resetAt: Math.ceil((now + windowMs) / 1000),
        allowed,
      });

      if (!allowed && !violated) violated = rule;
    }

    if (violated) {
      return {
        allowed: false,
        violated,
        results,
        retryAfterSeconds: retryAfterFor(violated),
      };
    }

    // Only consume once every rule has passed: a request rejected by rule 3
    // must not have burned quota on rules 1 and 2.
    for (const rule of applicable) {
      if (rule.unit !== 'requests') continue;
      const key = this.keyFor(rule, ctx);
      const ttl = WINDOW_SECONDS[rule.window] * 2;
      await this.kv.zadd(key, this.clock.now(), `${this.clock.now()}-${Math.random().toString(36).slice(2, 10)}`, ttl);
    }

    return { allowed: true, results };
  }

  /** Record the tokens a completed request actually consumed. */
  async settle(rules: RateLimitRule[], ctx: RateLimitContext, actualTokens: number): Promise<void> {
    if (actualTokens <= 0) return;
    for (const rule of rules) {
      if (rule.unit !== 'tokens' || !this.applies(rule, ctx)) continue;
      const key = this.keyFor(rule, ctx);
      const ttl = WINDOW_SECONDS[rule.window] * 2;
      await this.kv.incrBy(`${key}:tokens`, actualTokens, ttl);
    }
  }

  /** Read-only view for the dashboard and for `/v1/limits`. */
  async peek(rules: RateLimitRule[], ctx: RateLimitContext): Promise<RateLimitRuleResult[]> {
    const out: RateLimitRuleResult[] = [];
    for (const rule of rules.filter((r) => this.applies(r, ctx))) {
      const key = this.keyFor(rule, ctx);
      const windowMs = WINDOW_SECONDS[rule.window] * 1000;
      const now = this.clock.now();
      await this.kv.zremrangebyscore(key, 0, now - windowMs);
      const used = rule.unit === 'requests' ? await this.kv.zcard(key) : await this.readTokens(key);
      out.push({
        rule,
        used,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - used),
        resetAt: Math.ceil((now + windowMs) / 1000),
        allowed: used < rule.limit,
      });
    }
    return out;
  }

  async reset(rules: RateLimitRule[], ctx: RateLimitContext): Promise<void> {
    for (const rule of rules) {
      const key = this.keyFor(rule, ctx);
      await this.kv.del(key, `${key}:tokens`);
    }
  }

  private async readTokens(key: string): Promise<number> {
    const raw = await this.kv.get(`${key}:tokens`);
    return raw ? Number(raw) || 0 : 0;
  }

  private applies(rule: RateLimitRule, ctx: RateLimitContext): boolean {
    if (rule.subject === 'user' && !ctx.userId) return false;
    if (rule.subject === 'model') return !!ctx.modelId && (!rule.target || rule.target === ctx.modelId);
    if (rule.subject === 'provider') return !!ctx.providerId && (!rule.target || rule.target === ctx.providerId);
    if (rule.target) {
      // A targeted rule on a non-model/provider subject still has to match the
      // model or provider in play, otherwise it silently applies everywhere.
      return rule.target === ctx.modelId || rule.target === ctx.providerId;
    }
    return true;
  }

  private keyFor(rule: RateLimitRule, ctx: RateLimitContext): string {
    const subjectId = this.subjectId(rule.subject, ctx);
    const parts = [this.namespace, rule.id, rule.subject, subjectId, rule.window, rule.unit];
    if (rule.target) parts.push(rule.target);
    return parts.join(':');
  }

  private subjectId(subject: RateLimitRule['subject'], ctx: RateLimitContext): string {
    switch (subject) {
      case 'api_key':
        return ctx.apiKeyId;
      case 'user':
        return ctx.userId ?? 'anonymous';
      case 'project':
        return ctx.projectId;
      case 'organization':
        return ctx.organizationId;
      case 'model':
        // Still scoped per organization: one tenant must not exhaust another's
        // share of a model limit.
        return `${ctx.organizationId}:${ctx.modelId ?? '*'}`;
      case 'provider':
        return `${ctx.organizationId}:${ctx.providerId ?? '*'}`;
    }
  }
}

function retryAfterFor(rule: RateLimitRule): number {
  // Suggest a fraction of the window rather than the whole thing: a caller
  // that just crossed a per-minute limit usually frees capacity sooner.
  const seconds = WINDOW_SECONDS[rule.window];
  return Math.max(1, Math.min(seconds, Math.ceil(seconds / 10)));
}

/** Sensible starting limits for a new project, used when a policy sets none. */
export function defaultRules(): RateLimitRule[] {
  return [
    { id: 'key-rpm', subject: 'api_key', unit: 'requests', window: 'minute', limit: 600 },
    { id: 'key-tpm', subject: 'api_key', unit: 'tokens', window: 'minute', limit: 2_000_000 },
    { id: 'org-rph', subject: 'organization', unit: 'requests', window: 'hour', limit: 20_000 },
    { id: 'org-tpd', subject: 'organization', unit: 'tokens', window: 'day', limit: 200_000_000 },
  ];
}

/** Limits a routing policy may declare. Every field is optional. */
export interface RateLimitPolicy {
  requestsPerMinutePerKey?: number;
  requestsPerHourPerOrganization?: number;
  tokensPerMinutePerKey?: number;
  tokensPerDayPerOrganization?: number;
}

/**
 * Build rules from a policy, falling back to the defaults when it declares
 * none. A policy that declares *any* limit replaces the default set entirely,
 * so an operator who deliberately configures one high limit does not silently
 * inherit three others.
 */
export function rulesFromPolicy(policy: RateLimitPolicy | undefined): RateLimitRule[] {
  if (!policy) return defaultRules();

  const rules: RateLimitRule[] = [];
  if (policy.requestsPerMinutePerKey !== undefined) {
    rules.push({ id: 'key-rpm', subject: 'api_key', unit: 'requests', window: 'minute', limit: policy.requestsPerMinutePerKey });
  }
  if (policy.tokensPerMinutePerKey !== undefined) {
    rules.push({ id: 'key-tpm', subject: 'api_key', unit: 'tokens', window: 'minute', limit: policy.tokensPerMinutePerKey });
  }
  if (policy.requestsPerHourPerOrganization !== undefined) {
    rules.push({ id: 'org-rph', subject: 'organization', unit: 'requests', window: 'hour', limit: policy.requestsPerHourPerOrganization });
  }
  if (policy.tokensPerDayPerOrganization !== undefined) {
    rules.push({ id: 'org-tpd', subject: 'organization', unit: 'tokens', window: 'day', limit: policy.tokensPerDayPerOrganization });
  }

  return rules.length > 0 ? rules : defaultRules();
}
