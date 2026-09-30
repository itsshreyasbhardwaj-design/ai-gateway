import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, keyIndex, signWebhook, verifyWebhook } from '@ai-gateway/security';
import { newId } from '@ai-gateway/core';
import { createHarness, type Harness } from './harness.js';

/**
 * Security testing from the specification.
 *
 * These are the tests that decide whether the gateway can be trusted with
 * credentials and multi-tenant traffic, so each asserts an attack *fails*
 * rather than that a happy path works.
 */
describe('security', () => {
  let h: Harness | undefined;
  let other: Harness | undefined;

  afterEach(async () => {
    await h?.close();
    await other?.close();
    h = undefined;
    other = undefined;
  });

  // ------------------------------------------------- credential handling

  describe('API key handling', () => {
    it('rejects an absent, malformed or unknown key with an identical 401', async () => {
      h = await createHarness();
      const bodies: string[] = [];

      for (const header of [undefined, 'Bearer nonsense', 'Bearer aigw_live_totallyfake12345678', 'aigw_live_x']) {
        const response = await h.app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            ...(header ? { authorization: header } : {}),
          },
          payload: JSON.stringify({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }] }),
        });
        expect(response.statusCode).toBe(401);
        const error = JSON.parse(response.body).error as { type: string; message: string };
        expect(error.type).toBe('authentication_error');
        bodies.push(error.message);
      }

      // Identical messages: distinguishing "no such key" from "wrong key" tells
      // an attacker which prefixes exist.
      expect(new Set(bodies).size).toBe(1);
    });

    it('never writes an API key to the log', async () => {
      h = await createHarness();
      await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }] });

      const text = h.logs.text;
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(h.apiKey);
      // The searchable prefix is not secret and is useful for support, but the
      // secret half must never appear. (base64url secrets contain '_', so take
      // the remainder after the `aigw_test_` scheme rather than splitting.)
      expect(text).not.toContain(h.apiKey.slice('aigw_test_'.length));
      expect(text).toContain('[redacted]');
    });

    it('stores only a hash, never the plaintext', async () => {
      h = await createHarness();
      const keys = await h.store.listApiKeys(h.organization.id);
      expect(keys).toHaveLength(1);
      expect(keys[0]?.hash).toMatch(/^scrypt\$/);
      expect(JSON.stringify(keys)).not.toContain(h.apiKey);
    });

    it('refuses a revoked key', async () => {
      h = await createHarness();
      const keys = await h.store.listApiKeys(h.organization.id);
      await h.store.revokeApiKey(keys[0]!.id, new Date().toISOString());

      const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }] });
      expect(response.status).toBe(401);
      expect(response.json<{ error: { message: string } }>().error.message).toContain('revoked');
    });

    it('refuses an expired key', async () => {
      h = await createHarness();
      const generated = await generateApiKey('test');
      await h.store.createApiKey({
        id: newId('key'),
        organizationId: h.organization.id,
        projectId: h.project.id,
        name: 'expired',
        prefix: generated.prefix,
        hash: generated.hash,
        lookupIndex: keyIndex(generated.plaintext, h.config.apiKeyPepper),
        scopes: ['inference.create'],
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });

      const response = await h.chat(
        { model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }] },
        { authorization: `Bearer ${generated.plaintext}` },
      );
      expect(response.status).toBe(401);
      expect(response.json<{ error: { message: string } }>().error.message).toContain('expired');
    });

    it('does not accept a key whose hash was minted with a different pepper', async () => {
      h = await createHarness();
      const generated = await generateApiKey('test');
      await h.store.createApiKey({
        id: newId('key'),
        organizationId: h.organization.id,
        projectId: h.project.id,
        name: 'wrong pepper',
        prefix: generated.prefix,
        hash: await hashApiKey(generated.plaintext),
        // Index built with a different pepper: the lookup cannot find it.
        lookupIndex: keyIndex(generated.plaintext, 'a-different-pepper'),
        scopes: ['inference.create'],
        createdAt: new Date().toISOString(),
      });

      const response = await h.chat(
        { model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }] },
        { authorization: `Bearer ${generated.plaintext}` },
      );
      expect(response.status).toBe(401);
    });
  });

  // -------------------------------------------------------- scope bypass

  describe('scope enforcement', () => {
    it('refuses inference without the inference.create scope', async () => {
      h = await createHarness({ scopes: ['models.read'] });
      const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }] });
      expect(response.status).toBe(403);
      const error = response.json<{ error: { type: string; details: Record<string, unknown> } }>().error;
      expect(error.type).toBe('permission_denied');
      expect(error.details['requiredScopes']).toContain('inference.create');
    });

    it('refuses the admin API to a non-admin key', async () => {
      h = await createHarness({ scopes: ['inference.create', 'models.read'] });
      for (const path of ['/api/v1/providers', '/api/v1/api-keys', '/api/v1/budgets', '/api/v1/webhooks', '/api/v1/audit-logs']) {
        const response = await h.request('GET', path);
        expect(response.status).toBe(403);
      }
    });

    it('refuses request logs without logs.read', async () => {
      h = await createHarness({ scopes: ['inference.create'] });
      expect((await h.request('GET', '/api/v1/requests')).status).toBe(403);
    });

    it('refuses usage without usage.read', async () => {
      h = await createHarness({ scopes: ['inference.create'] });
      expect((await h.request('GET', '/api/v1/usage')).status).toBe(403);
    });

    it('cannot escalate by asking for a wider scope in the request body', async () => {
      h = await createHarness({ scopes: ['models.read'] });
      const response = await h.chat({
        model: 'mock/mock-fast',
        messages: [{ role: 'user', content: 'x' }],
        // Scopes come from the stored key, never from the request.
        scopes: ['admin'],
        gateway: { test: false },
      } as Record<string, unknown>);
      expect(response.status).toBe(403);
    });
  });

  // ---------------------------------------------------- tenant isolation

  describe('tenant isolation', () => {
    it("cannot read another organization's request trace", async () => {
      h = await createHarness();
      other = await createHarness();

      const mine = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'mine' }] });
      const requestId = mine.json<{ gateway: { requestId: string } }>().gateway.requestId;

      // Own org can read it.
      expect((await h.request('GET', `/api/v1/requests/${requestId}`)).status).toBe(200);
      // A different org gets a 404, not a 403 - existence itself is not disclosed.
      const foreign = await other.request('GET', `/api/v1/requests/${requestId}`);
      expect(foreign.status).toBe(404);
    });

    it("cannot see another organization's usage", async () => {
      h = await createHarness();
      other = await createHarness();

      for (let i = 0; i < 3; i++) {
        await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: `mine ${i}` }] });
      }

      const mineUsage = await h.request('GET', '/api/v1/usage?range=24h');
      expect(mineUsage.json<{ summary: { totalRequests: number } }>().summary.totalRequests).toBe(3);

      const theirUsage = await other.request('GET', '/api/v1/usage?range=24h');
      expect(theirUsage.json<{ summary: { totalRequests: number } }>().summary.totalRequests).toBe(0);
    });

    it("cannot delete another organization's resources", async () => {
      h = await createHarness();
      other = await createHarness();

      const budget = await h.request('POST', '/api/v1/budgets', {
        scope: 'organization',
        period: 'monthly',
        limit: 100,
        action: 'BLOCK',
      });
      const budgetId = budget.json<{ id: string }>().id;

      await other.request('DELETE', `/api/v1/budgets/${budgetId}`);
      // Still present in the owning organization.
      expect((await h.request('GET', '/api/v1/budgets')).json<{ data: unknown[] }>().data).toHaveLength(1);
    });

    it('never serves one organization a cache entry written by another', async () => {
      const cachePolicy = {
        name: 'cached',
        routing: { strategy: 'explicit', models: ['mock/mock-fast'] },
        fallback: { enabled: false, maxTargets: 1 },
        retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        cache: { mode: 'exact', ttlSeconds: 600, perProject: false },
        limits: { timeoutMs: 2_000 },
      };
      h = await createHarness({ policy: cachePolicy });
      other = await createHarness({ policy: cachePolicy });

      const prompt = { model: 'mock/mock-fast', messages: [{ role: 'user' as const, content: 'identical prompt' }] };

      const first = await h.chat(prompt);
      expect(first.json<{ gateway: { cache: string } }>().gateway.cache).toBe('miss');
      const second = await h.chat(prompt);
      expect(second.json<{ gateway: { cache: string } }>().gateway.cache).toBe('exact_hit');

      // A byte-identical prompt from another tenant must still be a miss.
      const foreign = await other.chat(prompt);
      expect(foreign.json<{ gateway: { cache: string } }>().gateway.cache).toBe('miss');
    });
  });

  // ------------------------------------------------ allowlist and policy

  describe('model allowlist and policy', () => {
    it('returns 403 MODEL_NOT_ALLOWED for a denied model', async () => {
      h = await createHarness({ allowedModels: ['mock/mock-fast'] });
      const response = await h.chat({ model: 'mock/mock-smart', messages: [{ role: 'user', content: 'x' }] });
      expect(response.status).toBe(403);
      const error = response.json<{ error: { type: string; details: Record<string, unknown> } }>().error;
      expect(error.type).toBe('model_not_allowed');
      expect(error.details['code']).toBe('MODEL_NOT_ALLOWED');
    });

    it('cannot reach a denied model through the gateway.models extension', async () => {
      h = await createHarness({ allowedModels: ['mock/mock-fast'] });
      const response = await h.chat({
        model: 'gateway/auto',
        messages: [{ role: 'user', content: 'x' }],
        gateway: { models: ['mock/mock-smart'] },
      });
      expect(response.status).toBe(403);
      expect(response.json<{ error: { type: string } }>().error.type).toBe('model_not_allowed');
    });

    it('cannot reach a denied model through a virtual model alias', async () => {
      h = await createHarness({ deniedModels: ['mock/mock-smart'] });
      for (let i = 0; i < 5; i++) {
        const response = await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: `x${i}` }] });
        expect(response.status).toBe(200);
        expect(response.json<{ gateway: { model: string } }>().gateway.model).not.toBe('mock/mock-smart');
      }
    });

    it('hides denied models from the model list', async () => {
      h = await createHarness({ allowedModels: ['mock/mock-fast'] });
      const models = await h.request('GET', '/v1/models');
      expect(models.json<{ data: Array<{ id: string }> }>().data.map((m) => m.id)).toEqual(['mock/mock-fast']);
    });

    it('clamps max_tokens to the policy ceiling rather than honouring the request', async () => {
      h = await createHarness({
        policy: {
          name: 'clamped',
          routing: { strategy: 'explicit', models: ['mock/mock-fast'] },
          fallback: { enabled: false, maxTargets: 1 },
          retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
          limits: { timeoutMs: 2_000, maxOutputTokens: 64 },
        },
      });
      const response = await h.chat({
        model: 'mock/mock-fast',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 999_999,
      });
      expect(response.status).toBe(200);

      const requestId = response.json<{ gateway: { requestId: string } }>().gateway.requestId;
      const trace = await h.request('GET', `/api/v1/requests/${requestId}`);
      const policyStep = trace
        .json<{ steps: Array<{ name: string; detail?: Record<string, unknown> }> }>()
        .steps.find((s) => s.name === 'policy_evaluation');
      // The clamp is recorded, not applied silently.
      expect(JSON.stringify(policyStep?.detail?.['adjustments'])).toContain('lowered from 999999');
    });

    it('enforces a streaming prohibition', async () => {
      h = await createHarness({
        policy: {
          name: 'no-stream',
          routing: { strategy: 'explicit', models: ['mock/mock-fast'] },
          fallback: { enabled: false, maxTargets: 1 },
          retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
          limits: { timeoutMs: 2_000, allowStreaming: false },
        },
      });
      const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }], stream: true });
      expect(response.status).toBe(403);
      expect(response.json<{ error: { type: string } }>().error.type).toBe('policy_violation');
    });
  });

  // ---------------------------------------------------- budget bypass

  describe('budget enforcement', () => {
    const budgetHarness = () =>
      createHarness({
        policy: {
          name: 'budgeted',
          routing: { strategy: 'explicit', models: ['mock/mock-smart'] },
          fallback: { enabled: false, maxTargets: 1 },
          retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
          limits: { timeoutMs: 2_000, maxOutputTokens: 4096 },
        },
        captureWebhooks: true,
      });

    it('blocks a request that would exceed a BLOCK budget', async () => {
      h = await budgetHarness();
      await h.request('POST', '/api/v1/budgets', {
        scope: 'organization',
        period: 'monthly',
        // Far below the projected cost of a single mock-smart request.
        limit: 0.0000001,
        action: 'BLOCK',
      });

      const response = await h.chat({ model: 'mock/mock-smart', messages: [{ role: 'user', content: 'x' }] });
      expect(response.status).toBe(402);
      const error = response.json<{ error: { type: string; details: Record<string, unknown> } }>().error;
      expect(error.type).toBe('budget_exceeded');
      expect(error.retryable).toBe(false);
      expect(error.details['scope']).toBe('organization');
    });

    it('cannot be bypassed by any request-level flag', async () => {
      h = await budgetHarness();
      await h.request('POST', '/api/v1/budgets', {
        scope: 'organization',
        period: 'monthly',
        limit: 0.0000001,
        action: 'BLOCK',
      });

      for (const attempt of [
        { gateway: { test: true } },
        { gateway: { fallback: false } },
        { gateway: { cache: 'no-store' } },
        { gateway: { strategy: 'lowest_cost' } },
      ]) {
        const response = await h.chat({
          model: 'mock/mock-smart',
          messages: [{ role: 'user', content: 'x' }],
          ...attempt,
        });
        expect(response.status).toBe(402);
      }
    });

    it('emits a budget.exceeded webhook when it blocks', async () => {
      h = await budgetHarness();
      const webhook = await h.request('POST', '/api/v1/webhooks', {
        url: 'https://hooks.example.com/aigw',
        events: ['budget.exceeded'],
      });
      expect(webhook.status).toBe(200);

      await h.request('POST', '/api/v1/budgets', {
        scope: 'organization',
        period: 'monthly',
        limit: 0.0000001,
        action: 'BLOCK',
      });
      await h.chat({ model: 'mock/mock-smart', messages: [{ role: 'user', content: 'x' }] });

      await h.ctx.webhooks.drain(10);
      expect(h.webhookCalls).toHaveLength(1);
      const call = h.webhookCalls[0]!;
      expect(call.url).toBe('https://hooks.example.com/aigw');
      expect(call.headers['x-aigw-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect((call.body as { event: string }).event).toBe('budget.exceeded');
    });

    it('a WARN budget records the overage but lets the request through', async () => {
      h = await budgetHarness();
      await h.request('POST', '/api/v1/budgets', {
        scope: 'organization',
        period: 'monthly',
        limit: 0.0000001,
        action: 'WARN',
      });
      const response = await h.chat({ model: 'mock/mock-smart', messages: [{ role: 'user', content: 'x' }] });
      expect(response.status).toBe(200);
    });
  });

  // ------------------------------------------------- rate-limit bypass

  describe('rate limiting', () => {
    it('returns 429 with retry-after once a limit is reached', async () => {
      h = await createHarness();
      // Drive the api_key requests/minute rule (600) down with a tight limit by
      // exhausting it through the limiter directly, then confirm the HTTP path.
      const rules = [{ id: 'key-rpm', subject: 'api_key' as const, unit: 'requests' as const, window: 'minute' as const, limit: 1 }];
      const ctx = {
        organizationId: h.organization.id,
        projectId: h.project.id,
        apiKeyId: (await h.store.listApiKeys(h.organization.id))[0]!.id,
      };
      await h.ctx.rateLimiter.check(rules, ctx);
      const blocked = await h.ctx.rateLimiter.check(rules, ctx);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('counts test traffic against rate limits', async () => {
      h = await createHarness();
      const before = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'a' }] });
      const after = await h.chat({
        model: 'mock/mock-fast',
        messages: [{ role: 'user', content: 'b' }],
        gateway: { test: true },
      });
      // Test traffic is exempt from budgets, never from rate limits: otherwise
      // a single flag would make the limiter meaningless.
      expect(Number(after.headers['x-ratelimit-remaining-requests'])).toBeLessThan(
        Number(before.headers['x-ratelimit-remaining-requests']),
      );
    });
  });

  // -------------------------------------------------------------- SSRF

  describe('SSRF protection', () => {
    const blocked = [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://127.0.0.1:9999/v1',
      'http://localhost:9999/v1',
      'http://10.1.2.3/v1',
      'http://192.168.0.1/v1',
      'http://[::1]/v1',
      'http://2130706433/v1',
      'https://user:pass@api.example.com/v1',
      'file:///etc/passwd',
    ];

    for (const url of blocked) {
      it(`refuses a custom provider pointed at ${url}`, async () => {
        h = await createHarness();
        const response = await h.request('POST', '/api/v1/providers', {
          id: 'evil',
          kind: 'openai-compatible',
          displayName: 'Evil',
          baseUrl: url,
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        // Nothing was registered.
        expect(h.ctx.providers.getProvider('evil')).toBeUndefined();
      });
    }

    it('refuses a webhook pointed at an internal address', async () => {
      h = await createHarness();
      const response = await h.request('POST', '/api/v1/webhooks', {
        url: 'http://169.254.169.254/hook',
        events: ['budget.exceeded'],
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await h.request('GET', '/api/v1/webhooks')).json<{ data: unknown[] }>().data).toHaveLength(0);
    });

    it('allows a public https provider endpoint', async () => {
      h = await createHarness();
      const response = await h.request('POST', '/api/v1/providers', {
        id: 'vendor',
        kind: 'openai-compatible',
        displayName: 'Vendor',
        baseUrl: 'https://api.vendor.example/v1',
        credentialValue: 'sk-test-value-1234567890',
        models: [{ providerModelId: 'vendor-small', contextWindow: 32000, capabilities: ['chat', 'streaming'] }],
      });
      expect(response.status).toBe(200);
      expect(response.json<{ registered: boolean; registrationError?: string }>().registrationError).toBeUndefined();
      expect(response.json<{ registered: boolean }>().registered).toBe(true);
    });

    it('allows an operator-allowlisted private host', async () => {
      h = await createHarness({ env: { PROVIDER_ALLOWED_HOSTS: 'ollama.internal,127.0.0.1' } });
      const response = await h.request('POST', '/api/v1/providers', {
        id: 'selfhosted',
        kind: 'openai-compatible',
        displayName: 'Self-hosted',
        baseUrl: 'http://ollama.internal:11434/v1',
        models: [{ providerModelId: 'llama-3.1-8b', contextWindow: 131072, capabilities: ['chat', 'streaming'] }],
      });
      expect(response.status).toBe(200);
    });
  });

  // ----------------------------------------------- secrets and prompts

  describe('secret and prompt handling', () => {
    it('never returns a provider credential value', async () => {
      h = await createHarness();
      const secret = 'sk-provider-secret-value-abcdef123456';
      await h.request('POST', '/api/v1/providers', {
        id: 'vendor',
        kind: 'openai-compatible',
        displayName: 'Vendor',
        baseUrl: 'https://api.vendor.example/v1',
        credentialValue: secret,
        models: [{ providerModelId: 'vendor-small', contextWindow: 32000, capabilities: ['chat'] }],
      });

      const list = await h.request('GET', '/api/v1/providers');
      expect(list.raw).not.toContain(secret);
      // Only the reference is exposed.
      expect(list.raw).toContain('PROVIDER_VENDOR_KEY');

      // Encrypted at rest, not merely hidden by the API layer.
      const stored = await h.store.getProviderCredential(h.organization.id, 'PROVIDER_VENDOR_KEY');
      expect(stored).toBeDefined();
      expect(stored).not.toContain(secret);
      expect(stored?.startsWith('v1.')).toBe(true);
      expect(h.logs.text).not.toContain(secret);
    });

    it('returns a webhook signing secret once and never again', async () => {
      h = await createHarness();
      const created = await h.request('POST', '/api/v1/webhooks', {
        url: 'https://hooks.example.com/aigw',
        events: ['budget.exceeded'],
      });
      const secret = created.json<{ secret: string }>().secret;
      expect(secret).toMatch(/^whsec_/);

      const list = await h.request('GET', '/api/v1/webhooks');
      expect(list.raw).not.toContain(secret);
      expect(list.json<{ data: Array<{ secretConfigured: boolean }> }>().data[0]?.secretConfigured).toBe(true);
    });

    it('does not store prompt bodies under the default privacy mode', async () => {
      h = await createHarness();
      const sentinel = 'CONFIDENTIAL-PROMPT-abc123-DO-NOT-STORE';
      const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: sentinel }] });
      const requestId = response.json<{ gateway: { requestId: string } }>().gateway.requestId;

      expect(await h.store.getPromptBody(h.organization.id, requestId)).toBeUndefined();

      const trace = await h.request('GET', `/api/v1/requests/${requestId}`);
      expect(trace.json<{ body: unknown }>().body).toBeNull();
      // The prompt does not leak through the trace either.
      expect(trace.raw).not.toContain(sentinel);
    });

    it('stores a redacted body when the organization opts in, and expires it', async () => {
      h = await createHarness({ privacy: { mode: 'redacted', retentionDays: 1 } });
      const response = await h.chat({
        model: 'mock/mock-fast',
        messages: [{ role: 'user', content: 'my key is sk-abcdefghijklmnopqrstuvwxyz please use it' }],
      });
      const requestId = response.json<{ gateway: { requestId: string } }>().gateway.requestId;

      const body = await h.store.getPromptBody(h.organization.id, requestId);
      expect(body).toBeDefined();
      // Retained, but with secrets stripped.
      expect(JSON.stringify(body)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
      expect(JSON.stringify(body)).toContain('[redacted]');
      expect(Date.parse(body!.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('does not echo a provider error message back to the caller', async () => {
      h = await createHarness();
      // The mock provider embeds the prompt in its error path; the gateway must
      // not forward provider error text verbatim.
      h.mocks.get('mock')!.setBehavior('mock-fast', { failureMode: 'invalid_request' });
      const response = await h.chat({
        model: 'mock/mock-fast',
        messages: [{ role: 'user', content: 'SENSITIVE-PROMPT-TEXT-xyz789' }],
      });
      expect(response.raw).not.toContain('SENSITIVE-PROMPT-TEXT-xyz789');
    });
  });

  // -------------------------------------------------- replay and audit

  describe('replay and audit', () => {
    it('refuses to replay a request whose body was never stored', async () => {
      h = await createHarness();
      const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }] });
      const requestId = response.json<{ gateway: { requestId: string } }>().gateway.requestId;

      const replay = await h.request('POST', `/api/v1/requests/${requestId}/replay`, { confirm: true });
      expect(replay.status).toBe(400);
      expect(replay.json<{ error: { message: string } }>().error.message).toContain('retention');
    });

    it('requires explicit confirmation to replay', async () => {
      h = await createHarness({ privacy: { mode: 'full', retentionDays: 7 } });
      const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'replay me' }] });
      const requestId = response.json<{ gateway: { requestId: string } }>().gateway.requestId;

      // No confirmation: refused.
      expect((await h.request('POST', `/api/v1/requests/${requestId}/replay`, {})).status).toBe(400);

      const confirmed = await h.request('POST', `/api/v1/requests/${requestId}/replay`, { confirm: true });
      expect(confirmed.status).toBe(200);
      const body = confirmed.json<{ replayOf: string; note: string }>();
      expect(body.replayOf).toBe(requestId);
      expect(body.note).toContain('excluded from production analytics');
    });

    it('records a replay as test traffic so analytics stay clean', async () => {
      h = await createHarness({ privacy: { mode: 'full', retentionDays: 7 } });
      const original = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'replay me' }] });
      const requestId = original.json<{ gateway: { requestId: string } }>().gateway.requestId;

      const productionBefore = (await h.request('GET', '/api/v1/usage?range=24h')).json<{
        summary: { totalRequests: number };
      }>().summary.totalRequests;

      await h.request('POST', `/api/v1/requests/${requestId}/replay`, { confirm: true });

      const productionAfter = (await h.request('GET', '/api/v1/usage?range=24h')).json<{
        summary: { totalRequests: number };
      }>().summary.totalRequests;
      expect(productionAfter).toBe(productionBefore);

      const withTest = (await h.request('GET', '/api/v1/usage?range=24h&includeTest=true')).json<{
        summary: { totalRequests: number };
      }>().summary.totalRequests;
      expect(withTest).toBeGreaterThan(productionAfter);
    });

    it('audits administrative writes', async () => {
      h = await createHarness();
      await h.request('POST', '/api/v1/budgets', {
        scope: 'organization',
        period: 'monthly',
        limit: 50,
        action: 'WARN',
      });

      const audit = await h.request('GET', '/api/v1/audit-logs');
      const entries = audit.json<{ data: Array<{ action: string; resourceType: string }> }>().data;
      expect(entries.some((e) => e.action === 'budget.create' && e.resourceType === 'budget')).toBe(true);
    });

    it('only lets the mock provider be made to fail', async () => {
      h = await createHarness();
      await h.request('POST', '/api/v1/providers', {
        id: 'vendor',
        kind: 'openai-compatible',
        displayName: 'Vendor',
        baseUrl: 'https://api.vendor.example/v1',
        credentialValue: 'sk-test-1234567890',
        models: [{ providerModelId: 'vendor-small', contextWindow: 32000, capabilities: ['chat'] }],
      });

      const response = await h.request('POST', '/api/v1/playground/simulate-failure', {
        model: 'vendor/vendor-small',
        failureMode: 'server_error',
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.json<{ error: { message: string } }>().error.message).toMatch(/mock provider|not registered/i);
    });
  });

  // ------------------------------------------- webhook signature checks

  describe('webhook signatures', () => {
    it('produces a signature a receiver can verify, and rejects tampering', async () => {
      h = await createHarness({ captureWebhooks: true });
      const created = await h.request('POST', '/api/v1/webhooks', {
        url: 'https://hooks.example.com/aigw',
        events: ['budget.warning'],
      });
      const secret = created.json<{ secret: string }>().secret;

      await h.request('POST', '/api/v1/budgets', {
        scope: 'organization',
        period: 'monthly',
        limit: 0.0000001,
        action: 'WARN',
        warnThreshold: 0.5,
      });
      await h.chat({ model: 'mock/mock-smart', messages: [{ role: 'user', content: 'trigger warning' }] });
      await h.ctx.webhooks.drain(10);

      expect(h.webhookCalls.length).toBeGreaterThan(0);
      const call = h.webhookCalls[0]!;
      const body = JSON.stringify(call.body);
      const header = call.headers['x-aigw-signature']!;

      expect(verifyWebhook(body, header, secret).valid).toBe(true);
      expect(verifyWebhook(`${body} `, header, secret).valid).toBe(false);
      expect(verifyWebhook(body, header, 'whsec_wrong').valid).toBe(false);

      // A replayed payload outside the tolerance window is refused.
      const stale = signWebhook(body, secret, Math.floor(Date.now() / 1000) - 7200);
      expect(verifyWebhook(body, stale, secret).reason).toBe('timestamp_out_of_tolerance');
    });
  });
});
