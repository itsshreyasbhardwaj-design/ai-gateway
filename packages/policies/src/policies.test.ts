import { describe, expect, it } from 'vitest';
import { GatewayError, type AuthContext, type ChatRequest } from '@ai-gateway/core';
import { DEFAULT_POLICY, parsePolicy, parsePolicyOrThrow, policyTargets, policyToYaml } from './policy.js';
import { PolicyVersionStore } from './versions.js';
import { assertModelAllowed, evaluatePolicy, permittedModels, requireScope, type PolicySubject } from './engine.js';
import { routingPolicySchema } from './schema.js';

const validYaml = `
name: production
description: Reliability-first with two fallbacks.
routing:
  strategy: highest_reliability
  models:
    - openai/gpt-4o-mini
    - anthropic/claude-haiku-4-20250514
    - mock/mock-fast
fallback:
  enabled: true
  maxTargets: 3
retry:
  maxAttempts: 3
  initialDelayMs: 200
limits:
  maxOutputTokens: 16384
  timeoutMs: 60000
`;

describe('policy parsing', () => {
  it('parses a valid YAML policy and fills defaults', () => {
    const result = parsePolicy(validYaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.routing.strategy).toBe('highest_reliability');
    expect(result.policy.retry.jitter).toBe('full');
    expect(result.policy.cache.mode).toBe('off');
    expect(result.checksum).toHaveLength(22);
  });

  it('accepts a plain JSON object as well as YAML', () => {
    const result = parsePolicy({ name: 'p', routing: { strategy: 'explicit', models: ['mock/mock-fast'] } });
    expect(result.ok).toBe(true);
  });

  it('warns without blocking when the fallback cap exceeds the model list', () => {
    const result = parsePolicy({ name: 'p', routing: { strategy: 'explicit', models: ['mock/a'] } });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.path)).toContain('fallback.maxTargets');
  });

  it('warns about a loose semantic threshold and about disabled jitter', () => {
    const result = parsePolicy({
      name: 'p',
      routing: { strategy: 'explicit', models: ['mock/a', 'mock/b', 'mock/c'] },
      cache: { mode: 'semantic', similarityThreshold: 0.4 },
      retry: { maxAttempts: 3, jitter: 'none' },
    });
    expect(result.ok).toBe(true);
    const paths = result.warnings.map((w) => w.path);
    expect(paths).toContain('cache.similarityThreshold');
    expect(paths).toContain('retry.jitter');
  });

  it('reports the path of a schema error rather than throwing', () => {
    const result = parsePolicy({ name: 'p', routing: { strategy: 'nonsense', models: ['mock/mock-fast'] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('routing.strategy');
  });

  it('rejects malformed model references', () => {
    const result = parsePolicy({ name: 'p', routing: { strategy: 'explicit', models: ['not-a-reference'] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('<provider>/<model>');
  });

  it('rejects unknown top-level keys so typos do not silently no-op', () => {
    const result = parsePolicy({ name: 'p', routing: { strategy: 'explicit', models: ['mock/mock-fast'] }, fallbak: {} });
    expect(result.ok).toBe(false);
  });

  it('rejects broken YAML with a readable message', () => {
    const result = parsePolicy('name: [unterminated');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('Not valid YAML');
  });

  it('catches duplicate models', () => {
    const result = parsePolicy({ name: 'p', routing: { strategy: 'explicit', models: ['mock/a', 'mock/a'] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('duplicate model');
  });

  it('requires weights for the weighted strategy', () => {
    const result = parsePolicy({ name: 'p', routing: { strategy: 'weighted', models: ['mock/a', 'mock/b'] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('requires at least one model to declare a weight');
  });

  it('requires priorities for the priority strategy', () => {
    const result = parsePolicy({ name: 'p', routing: { strategy: 'priority', models: ['mock/a'] } });
    expect(result.ok).toBe(false);
  });

  it('catches a model that is both routed to and denied', () => {
    const result = parsePolicy({
      name: 'p',
      routing: { strategy: 'explicit', models: ['mock/a'] },
      models: { deny: ['mock/a'] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('also denied');
  });

  it('catches a routed model missing from the allow list', () => {
    const result = parsePolicy({
      name: 'p',
      routing: { strategy: 'explicit', models: ['mock/a'] },
      models: { allow: ['mock/b'] },
    });
    expect(result.ok).toBe(false);
  });

  it('catches a backoff cap below the initial delay', () => {
    const result = parsePolicy({
      name: 'p',
      routing: { strategy: 'explicit', models: ['mock/a'] },
      retry: { initialDelayMs: 5000, maxDelayMs: 100 },
    });
    expect(result.ok).toBe(false);
  });

  it('throws a normalized error from the strict form', () => {
    expect(() => parsePolicyOrThrow('name: x')).toThrow(GatewayError);
  });

  it('round-trips through YAML', () => {
    const policy = parsePolicyOrThrow(validYaml);
    expect(parsePolicyOrThrow(policyToYaml(policy))).toEqual(policy);
  });

  it('normalizes weighted and priority entries', () => {
    const policy = routingPolicySchema.parse({
      name: 'p',
      routing: { strategy: 'weighted', models: [{ model: 'mock/a', weight: 9 }, 'mock/b'] },
    });
    expect(policyTargets(policy)).toEqual([{ model: 'mock/a', weight: 9 }, { model: 'mock/b' }]);
  });

  it('ships a valid default policy', () => {
    expect(parsePolicy(DEFAULT_POLICY).ok).toBe(true);
  });
});

describe('PolicyVersionStore', () => {
  const doc = parsePolicyOrThrow(validYaml);

  function store() {
    const s = new PolicyVersionStore();
    const { policy } = s.create({ organizationId: 'org_1', name: 'production', document: doc, createdBy: 'alice' });
    return { s, policyId: policy.id };
  }

  it('creates version 1 active', () => {
    const { s, policyId } = store();
    expect(s.active(policyId)?.version).toBe(1);
    expect(s.history(policyId)).toHaveLength(1);
  });

  it('publishes without activating, so editing is not deploying', () => {
    const { s, policyId } = store();
    const v2 = s.publish(policyId, { ...doc, routing: { ...doc.routing, strategy: 'lowest_cost' } }, 'bob', 'try cost routing');
    expect(v2.version).toBe(2);
    expect(v2.active).toBe(false);
    expect(s.active(policyId)?.version).toBe(1);
    expect(s.active(policyId)?.document.routing.strategy).toBe('highest_reliability');
  });

  it('activates a published version as a separate, attributed step', () => {
    const { s, policyId } = store();
    s.publish(policyId, { ...doc, routing: { ...doc.routing, strategy: 'lowest_cost' } }, 'bob');
    s.activate(policyId, 2);
    expect(s.active(policyId)?.version).toBe(2);
    expect(s.get(policyId)?.activeVersion).toBe(2);
    expect(s.history(policyId).filter((v) => v.active)).toHaveLength(1);
  });

  it('rolls back to the previous version', () => {
    const { s, policyId } = store();
    s.publish(policyId, { ...doc, routing: { ...doc.routing, strategy: 'lowest_cost' } }, 'bob');
    s.activate(policyId, 2);
    const restored = s.rollback(policyId);
    expect(restored.version).toBe(1);
    expect(s.active(policyId)?.document.routing.strategy).toBe('highest_reliability');
  });

  it('refuses to roll back past the first version', () => {
    const { s, policyId } = store();
    expect(() => s.rollback(policyId)).toThrow(/no earlier version/);
  });

  it("keeps a checksum per version so tampering is detectable", () => {
    const { s, policyId } = store();
    const v2 = s.publish(policyId, { ...doc, name: 'renamed' }, 'bob');
    expect(v2.checksum).not.toBe(s.history(policyId)[0]?.checksum);
  });

  it('produces a readable diff between versions', () => {
    const { s, policyId } = store();
    s.publish(policyId, { ...doc, routing: { strategy: 'lowest_cost', models: ['mock/mock-fast'] } }, 'bob');
    const diff = s.diff(policyId, 1, 2);
    expect(diff.join('\n')).toContain('~ routing.strategy: "highest_reliability" -> "lowest_cost"');
  });

  it('scopes listing by organization and project', () => {
    const s = new PolicyVersionStore();
    s.create({ organizationId: 'org_1', projectId: 'proj_1', name: 'a', document: doc, createdBy: 'x' });
    s.create({ organizationId: 'org_2', name: 'b', document: doc, createdBy: 'x' });
    expect(s.list('org_1')).toHaveLength(1);
    expect(s.list('org_1', 'proj_1')).toHaveLength(1);
    expect(s.list('org_1', 'proj_2')).toHaveLength(0);
  });
});

describe('policy engine', () => {
  const auth: AuthContext = {
    organizationId: 'org_1',
    projectId: 'proj_1',
    apiKeyId: 'key_1',
    scopes: ['inference.create', 'models.read'],
  };

  const registered = ['openai/gpt-4o-mini', 'anthropic/claude-haiku-4-20250514', 'mock/mock-fast', 'mock/mock-smart'];

  function subject(over: Partial<PolicySubject> = {}): PolicySubject {
    return {
      auth,
      policy: parsePolicyOrThrow(validYaml),
      registeredModels: registered,
      ...over,
    };
  }

  const request: ChatRequest = { model: 'mock/mock-fast', messages: [{ role: 'user', content: 'hi' }] };

  it('requires the inference.create scope', () => {
    const readOnly = { ...auth, scopes: ['models.read' as const] };
    expect(() => evaluatePolicy(subject({ auth: readOnly }), request)).toThrow(/missing the "inference.create" scope/);
  });

  it('treats admin as satisfying any scope', () => {
    expect(() => requireScope({ scopes: ['admin'] }, 'logs.read')).not.toThrow();
  });

  it('clamps max_tokens to the policy ceiling and says so', () => {
    const decision = evaluatePolicy(subject(), { ...request, max_tokens: 999_999 });
    expect(decision.request.max_tokens).toBe(16_384);
    expect(decision.adjustments[0]).toContain('lowered from 999999');
  });

  it('defaults max_tokens when the caller omitted it', () => {
    const decision = evaluatePolicy(subject(), request);
    expect(decision.request.max_tokens).toBe(16_384);
    expect(decision.adjustments[0]).toContain('defaulted');
  });

  it('leaves a max_tokens under the ceiling untouched', () => {
    const decision = evaluatePolicy(subject(), { ...request, max_tokens: 100 });
    expect(decision.request.max_tokens).toBe(100);
    expect(decision.adjustments).toHaveLength(0);
  });

  it('clamps a request timeout to the policy limit', () => {
    const decision = evaluatePolicy(subject(), { ...request, gateway: { timeoutMs: 600_000 } });
    expect(decision.timeoutMs).toBe(60_000);
    expect(decision.adjustments.join(' ')).toContain('timeout clamped');
  });

  it('blocks streaming when policy disallows it', () => {
    const policy = { ...parsePolicyOrThrow(validYaml) };
    policy.limits = { ...policy.limits, allowStreaming: false };
    expect(() => evaluatePolicy(subject({ policy }), { ...request, stream: true })).toThrow(/Streaming is disabled/);
  });

  it('blocks tool use when policy disallows it', () => {
    const policy = { ...parsePolicyOrThrow(validYaml) };
    policy.limits = { ...policy.limits, allowTools: false };
    expect(() =>
      evaluatePolicy(subject({ policy }), { ...request, tools: [{ type: 'function', function: { name: 'f' } }] }),
    ).toThrow(/Tool use is disabled/);
  });

  it('rejects an oversized body', () => {
    const policy = { ...parsePolicyOrThrow(validYaml) };
    policy.limits = { ...policy.limits, maxRequestBytes: 1024 };
    expect(() => evaluatePolicy(subject({ policy, requestBytes: 2048 }), request)).toThrow(/above the configured limit/);
  });

  it('rejects a prompt over the input limit and labels the count as an estimate', () => {
    const policy = { ...parsePolicyOrThrow(validYaml) };
    policy.limits = { ...policy.limits, maxInputTokens: 5 };
    try {
      evaluatePolicy(subject({ policy }), { ...request, messages: [{ role: 'user', content: 'x'.repeat(1000) }] });
      expect.unreachable();
    } catch (err) {
      expect((err as GatewayError).details?.['estimateIsApproximate']).toBe(true);
    }
  });
});

describe('model allow and deny lists', () => {
  const registered = ['a/1', 'a/2', 'b/1', 'c/1'];
  const auth: AuthContext = { organizationId: 'o', projectId: 'p', apiKeyId: 'k', scopes: ['inference.create'] };
  const base = { auth, policy: DEFAULT_POLICY, registeredModels: registered };

  it('returns every registered model when nothing is restricted', () => {
    expect(permittedModels(base)).toEqual(registered);
  });

  it('narrows to the organization allowlist', () => {
    expect(permittedModels({ ...base, organizationAllowedModels: ['a/1', 'b/1'] })).toEqual(['a/1', 'b/1']);
  });

  it('lets a project narrow further but never widen', () => {
    const permitted = permittedModels({
      ...base,
      organizationAllowedModels: ['a/1', 'b/1'],
      projectAllowedModels: ['a/1', 'c/1'],
    });
    expect(permitted).toEqual(['a/1']);
  });

  it('lets deny beat allow at every scope', () => {
    expect(permittedModels({ ...base, organizationAllowedModels: ['a/1'], projectDeniedModels: ['a/1'] })).toEqual([]);
    expect(permittedModels({ ...base, organizationDeniedModels: ['a/1'] })).not.toContain('a/1');
  });

  it('applies the policy document deny list too', () => {
    const policy = { ...DEFAULT_POLICY, models: { deny: ['b/1'] } };
    expect(permittedModels({ ...base, policy })).not.toContain('b/1');
  });

  it('returns 403 model_not_allowed for a registered but forbidden model', () => {
    try {
      assertModelAllowed('c/1', ['a/1'], registered);
      expect.unreachable();
    } catch (err) {
      const gw = err as GatewayError;
      expect(gw.type).toBe('model_not_allowed');
      expect(gw.status).toBe(403);
      expect(gw.details?.['code']).toBe('MODEL_NOT_ALLOWED');
    }
  });

  it('returns 404 model_not_found for an unregistered model', () => {
    try {
      assertModelAllowed('z/9', ['a/1'], registered);
      expect.unreachable();
    } catch (err) {
      expect((err as GatewayError).status).toBe(404);
    }
  });
});
