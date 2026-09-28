import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GatewayError } from '@ai-gateway/core';
import { routingPolicySchema, normalizeModelEntry, type RoutingPolicyDocument } from './schema.js';

export interface PolicyValidationIssue {
  path: string;
  message: string;
}

export type PolicyParseResult =
  | { ok: true; policy: RoutingPolicyDocument; checksum: string; warnings: PolicyValidationIssue[] }
  | { ok: false; issues: PolicyValidationIssue[]; warnings: PolicyValidationIssue[] };

/** Parse a policy from YAML or JSON without throwing, for the CLI validator and the editor. */
export function parsePolicy(source: string | unknown): PolicyParseResult {
  let raw: unknown = source;
  if (typeof source === 'string') {
    try {
      raw = parseYaml(source);
    } catch (err) {
      return {
        ok: false,
        issues: [{ path: '', message: `Not valid YAML or JSON: ${(err as Error).message}` }],
        warnings: [],
      };
    }
  }

  const result = routingPolicySchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      warnings: [],
    };
  }

  const { errors, warnings } = semanticChecks(result.data);
  if (errors.length > 0) return { ok: false, issues: errors, warnings };

  return { ok: true, policy: result.data, checksum: checksumPolicy(result.data), warnings };
}

export function parsePolicyOrThrow(source: string | unknown): RoutingPolicyDocument {
  const result = parsePolicy(source);
  if (!result.ok) {
    const first = result.issues[0];
    throw new GatewayError(
      'invalid_request',
      `Invalid routing policy${first?.path ? ` at "${first.path}"` : ''}: ${first?.message ?? 'failed validation'}`,
      { details: { issues: result.issues } },
    );
  }
  return result.policy;
}

/**
 * Checks the schema cannot express.
 *
 * Errors are mistakes that would silently misroute traffic, so they are
 * rejected at authoring time rather than discovered in production. Warnings are
 * shapes that are valid but probably not what the author meant; the CLI and the
 * policy editor surface them without blocking the save.
 */
function semanticChecks(policy: RoutingPolicyDocument): {
  errors: PolicyValidationIssue[];
  warnings: PolicyValidationIssue[];
} {
  const issues: PolicyValidationIssue[] = [];
  const warnings: PolicyValidationIssue[] = [];
  const entries = policy.routing.models.map(normalizeModelEntry);

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.model)) {
      issues.push({ path: 'routing.models', message: `duplicate model "${entry.model}"` });
    }
    seen.add(entry.model);
  }

  if (policy.routing.strategy === 'weighted' && entries.every((e) => e.weight === undefined)) {
    issues.push({
      path: 'routing.models',
      message: 'strategy "weighted" requires at least one model to declare a weight',
    });
  }

  if (policy.routing.strategy === 'priority' && entries.every((e) => e.priority === undefined)) {
    issues.push({
      path: 'routing.models',
      message: 'strategy "priority" requires at least one model to declare a priority',
    });
  }

  const denied = new Set(policy.models?.deny ?? []);
  for (const entry of entries) {
    if (denied.has(entry.model)) {
      issues.push({
        path: 'routing.models',
        message: `model "${entry.model}" is listed in routing.models but also denied by models.deny`,
      });
    }
  }

  const allowed = policy.models?.allow;
  if (allowed?.length) {
    for (const entry of entries) {
      if (!allowed.includes(entry.model)) {
        issues.push({
          path: 'routing.models',
          message: `model "${entry.model}" is not present in models.allow`,
        });
      }
    }
  }

  if (policy.fallback.enabled && policy.fallback.maxTargets > entries.length) {
    // Valid - the chain is simply shorter than the cap - but usually a sign of
    // a model the author meant to list, so it is surfaced rather than enforced.
    warnings.push({
      path: 'fallback.maxTargets',
      message: `maxTargets is ${policy.fallback.maxTargets} but only ${entries.length} model(s) are configured; the chain will be ${entries.length} long`,
    });
  }

  if (policy.cache.mode === 'semantic' && policy.cache.similarityThreshold < 0.8) {
    warnings.push({
      path: 'cache.similarityThreshold',
      message: `a threshold of ${policy.cache.similarityThreshold} is low for a semantic cache and will serve loosely-related answers`,
    });
  }

  if (policy.retry.maxAttempts > 1 && policy.retry.jitter === 'none') {
    warnings.push({
      path: 'retry.jitter',
      message: 'jitter is disabled; concurrent clients will retry in lockstep and can amplify a provider outage',
    });
  }

  if (policy.retry.maxDelayMs < policy.retry.initialDelayMs) {
    issues.push({ path: 'retry.maxDelayMs', message: 'maxDelayMs must be greater than or equal to initialDelayMs' });
  }

  return { errors: issues, warnings };
}

/** Content hash used to detect that a stored policy changed. */
export function checksumPolicy(policy: RoutingPolicyDocument): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('base64url').slice(0, 22);
}

export function policyToYaml(policy: RoutingPolicyDocument): string {
  return stringifyYaml(policy, { indent: 2 });
}

/** Ordered model references for the router. */
export function policyTargets(policy: RoutingPolicyDocument): Array<{ model: string; weight?: number; priority?: number }> {
  return policy.routing.models.map(normalizeModelEntry);
}

export const DEFAULT_POLICY: RoutingPolicyDocument = routingPolicySchema.parse({
  name: 'default',
  description: 'Starter policy: prefer the most reliable configured model, fall back twice.',
  routing: { strategy: 'highest_reliability', models: ['mock/mock-fast', 'mock/mock-smart'] },
  fallback: { enabled: true, maxTargets: 2 },
});
