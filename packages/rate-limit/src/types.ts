export type RateLimitUnit = 'requests' | 'tokens';

export type RateLimitWindow = 'second' | 'minute' | 'hour' | 'day';

export const WINDOW_SECONDS: Record<RateLimitWindow, number> = {
  second: 1,
  minute: 60,
  hour: 3_600,
  day: 86_400,
};

/** What the limit is counted against. */
export type RateLimitSubject =
  'api_key' | 'user' | 'project' | 'organization' | 'model' | 'provider';

export interface RateLimitRule {
  id: string;
  subject: RateLimitSubject;
  unit: RateLimitUnit;
  window: RateLimitWindow;
  limit: number;
  /** Restrict the rule to one model or provider id. */
  target?: string;
}

export interface RateLimitContext {
  organizationId: string;
  projectId: string;
  apiKeyId: string;
  userId?: string;
  modelId?: string;
  providerId?: string;
}

export interface RateLimitCheck {
  allowed: boolean;
  /** The first rule that rejected, when `allowed` is false. */
  violated?: RateLimitRule;
  /** Per-rule state, in rule order, for response headers and the trace. */
  results: RateLimitRuleResult[];
  /** Seconds the caller should wait, derived from the violated rule's window. */
  retryAfterSeconds?: number;
}

export interface RateLimitRuleResult {
  rule: RateLimitRule;
  used: number;
  limit: number;
  remaining: number;
  /** Unix seconds at which this window resets. */
  resetAt: number;
  allowed: boolean;
}

/** Standard rate-limit response headers, following the OpenAI-compatible naming. */
export function rateLimitHeaders(check: RateLimitCheck): Record<string, string> {
  const headers: Record<string, string> = {};
  const requestRule = check.results.find((r) => r.rule.unit === 'requests');
  const tokenRule = check.results.find((r) => r.rule.unit === 'tokens');

  if (requestRule) {
    headers['x-ratelimit-limit-requests'] = String(requestRule.limit);
    headers['x-ratelimit-remaining-requests'] = String(Math.max(0, requestRule.remaining));
    headers['x-ratelimit-reset-requests'] = String(requestRule.resetAt);
  }
  if (tokenRule) {
    headers['x-ratelimit-limit-tokens'] = String(tokenRule.limit);
    headers['x-ratelimit-remaining-tokens'] = String(Math.max(0, tokenRule.remaining));
    headers['x-ratelimit-reset-tokens'] = String(tokenRule.resetAt);
  }
  if (check.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(check.retryAfterSeconds);
  }
  return headers;
}
