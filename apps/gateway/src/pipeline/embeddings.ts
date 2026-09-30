import {
  GatewayError,
  estimateCompletionTokens,
  estimatedUsage,
  newRequestId,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type RequestRecord,
} from '@ai-gateway/core';
import { assertModelAllowed, evaluatePolicy, permittedModels } from '@ai-gateway/policies';
import { computeCost } from '@ai-gateway/pricing';
import { METRICS, TraceBuilder } from '@ai-gateway/observability';
import { rulesFromPolicy } from '@ai-gateway/rate-limit';
import { buildState, budgetError, evaluateBudgets } from '@ai-gateway/usage';
import type { AuthenticatedKey } from '../auth.js';
import { targetKey, type GatewayContext } from '../context.js';
import { loadTenant } from './tenant.js';

export interface EmbeddingsPipelineInput {
  auth: AuthenticatedKey;
  request: EmbeddingsRequest;
  requestId?: string;
  signal: AbortSignal;
  userAgent?: string;
}

/**
 * Embeddings pipeline.
 *
 * Shares the gates the chat pipeline uses - auth, rate limit, policy, budget,
 * allowlist - because an embeddings call spends money exactly like a completion
 * does. It has no routing chain: embedding vectors from different models are
 * not interchangeable, so silently failing over to another model would return
 * vectors that do not match the caller's existing index.
 */
export class EmbeddingsPipeline {
  constructor(private readonly ctx: GatewayContext) {}

  async run(input: EmbeddingsPipelineInput): Promise<{ requestId: string; body: EmbeddingsResponse; headers: Record<string, string> }> {
    const requestId = input.requestId ?? newRequestId();
    const trace = new TraceBuilder(requestId, this.ctx.clock);
    trace.mark('request_received', 'ok', { endpoint: '/v1/embeddings', requestedModel: input.request.model });
    trace.mark('authentication', 'ok', { apiKeyPrefix: input.auth.prefix });

    try {
      const tenant = await loadTenant(this.ctx, input.auth);
      const inputs = Array.isArray(input.request.input) ? input.request.input : [input.request.input];
      const estimatedTokens = inputs.reduce((sum, text) => sum + estimateCompletionTokens(text), 0);

      const rateStep = trace.step('rate_limit');
      const limitCtx = {
        organizationId: tenant.organization.id,
        projectId: tenant.project.id,
        apiKeyId: input.auth.apiKeyId,
        modelId: input.request.model,
      };
      const rules = rulesFromPolicy(tenant.policy.rateLimits);
      const rateCheck = await this.ctx.rateLimiter.check(rules, limitCtx, estimatedTokens);
      if (!rateCheck.allowed) {
        rateStep.fail('rate_limit', 'rate limit exceeded');
        throw new GatewayError('rate_limit', 'Rate limit exceeded.', {
          requestId,
          retryAfterSeconds: rateCheck.retryAfterSeconds,
        });
      }
      rateStep.end();

      const policyStep = trace.step('policy_evaluation');
      const registeredIds = tenant.registeredModels.map((m) => m.id);
      const permitted = permittedModels({
        auth: input.auth,
        organizationAllowedModels: tenant.organization.allowedModels,
        organizationDeniedModels: tenant.organization.deniedModels,
        projectAllowedModels: tenant.project.allowedModels,
        projectDeniedModels: tenant.project.deniedModels,
        policy: tenant.policy,
        registeredModels: registeredIds,
      });
      // Reuse the chat policy gate for its scope and limit checks; embeddings
      // requests carry no messages, so a single synthetic turn stands in.
      evaluatePolicy(
        {
          auth: input.auth,
          policy: tenant.policy,
          registeredModels: registeredIds,
          organizationAllowedModels: tenant.organization.allowedModels,
          projectAllowedModels: tenant.project.allowedModels,
        },
        { model: input.request.model, messages: [{ role: 'user', content: inputs.join('\n') }] },
      );
      assertModelAllowed(input.request.model, permitted, registeredIds);
      policyStep.end({ permittedModels: permitted.length });

      const model = this.ctx.providers.requireModel(input.request.model);
      if (!model.capabilities.includes('embeddings')) {
        throw new GatewayError(
          'capability_unsupported',
          `Model "${model.id}" does not support embeddings.`,
          { model: model.id, details: { capabilities: model.capabilities } },
        );
      }

      const budgetStep = trace.step('budget_check');
      const pricing = this.ctx.pricing.lookup(model.id);
      const projected = pricing ? (estimatedTokens * pricing.pricing.inputPerMillionTokens) / 1_000_000 : 0;
      const now = new Date(this.ctx.clock.now());
      const states = await Promise.all(
        tenant.budgets.map(async (b) => buildState(b, await this.ctx.spend.readForBudget(b, now), now)),
      );
      const outcome = evaluateBudgets({ states, projectedCost: projected });
      if (outcome.decision === 'block') {
        budgetStep.fail('budget_exceeded', 'budget exhausted');
        throw budgetError(outcome.blocked);
      }
      budgetStep.end({ projectedCost: projected });

      trace.mark('cache_lookup', 'skipped', { reason: 'embeddings responses are not cached by the gateway' });
      trace.mark('routing', 'ok', {
        strategy: 'explicit',
        reason: 'embedding vectors are model-specific, so no fallback chain is built',
      });

      const provider = this.ctx.providers.requireProvider(model.providerId);
      if (!provider.embed) {
        throw new GatewayError(
          'capability_unsupported',
          `Provider "${provider.id}" does not expose an embeddings endpoint.`,
          { provider: provider.id },
        );
      }

      const breaker = this.ctx.circuits.get(targetKey(model.providerId, model.id));
      if (!breaker.allow()) {
        throw new GatewayError('circuit_open', `Circuit is open for ${model.id}.`, { provider: model.providerId });
      }

      const recorder = trace.startAttempt(model.providerId, model.id, 1);
      const providerStep = trace.step('provider_request');
      const startedAt = this.ctx.clock.now();

      let response: EmbeddingsResponse;
      try {
        response = await provider.embed(input.request, {
          requestId,
          attempt: 1,
          signal: input.signal,
          timeoutMs: Math.min(tenant.policy.limits.timeoutMs, this.ctx.config.defaultTimeoutMs),
          model,
        });
        const elapsed = this.ctx.clock.now() - startedAt;
        providerStep.end({ durationMs: elapsed, vectors: response.data.length });
        breaker.recordSuccess();
        this.ctx.health.recordSuccess(targetKey(model.providerId, model.id), elapsed);
        this.ctx.health.recordSuccess(targetKey(model.providerId), elapsed);
        recorder.succeed(response.usage);
      } catch (err) {
        const error = GatewayError.from(err);
        const elapsed = this.ctx.clock.now() - startedAt;
        providerStep.fail(error.type, error.message);
        recorder.fail(error.type, error.message, error.providerStatus);
        if (error.type !== 'client_disconnected') {
          breaker.recordFailure();
          this.ctx.health.recordFailure(targetKey(model.providerId, model.id), elapsed, error.type);
        }
        throw error;
      }

      const usageStep = trace.step('usage_extraction');
      const usage = response.usage ?? estimatedUsage(estimatedTokens, 0);
      const cost = pricing ? computeCost(usage, pricing.pricing, pricing.version) : undefined;
      usageStep.end({ source: usage.source, priced: !!pricing });

      const isTest = input.request.gateway?.test === true;
      if (cost && !isTest) {
        await this.ctx.spend.record(
          { organizationId: tenant.organization.id, projectId: tenant.project.id, apiKeyId: input.auth.apiKeyId },
          cost.totalCost,
        );
      }
      await this.ctx.rateLimiter.settle(rules, limitCtx, usage.total);

      const record: RequestRecord = {
        id: requestId,
        organizationId: tenant.organization.id,
        projectId: tenant.project.id,
        apiKeyId: input.auth.apiKeyId,
        createdAt: new Date(this.ctx.clock.now()).toISOString(),
        endpoint: '/v1/embeddings',
        requestedModel: input.request.model,
        resolvedProviderId: model.providerId,
        resolvedModelId: model.id,
        strategy: 'explicit',
        status: 'success',
        httpStatus: 200,
        streamed: false,
        latencyMs: trace.elapsedMs,
        cacheStatus: 'disabled',
        fallbackUsed: false,
        attemptCount: 1,
        usage,
        usageSource: usage.source,
        estimatedCost: cost?.totalCost,
        currency: cost?.currency ?? tenant.organization.currency,
        pricingVersion: cost?.pricingVersion,
        isTest,
        tags: input.request.gateway?.tags,
        userAgent: input.userAgent,
      };

      this.ctx.metrics.increment(METRICS.requests, { status: 'success', endpoint: 'embeddings', provider: model.providerId });
      this.ctx.metrics.observe(METRICS.requestDuration, trace.elapsedMs, { endpoint: 'embeddings' });
      if (cost) {
        this.ctx.metrics.increment(METRICS.estimatedCost, { currency: cost.currency }, cost.totalCost);
      }

      trace.mark('response_sent', 'ok', { httpStatus: 200 });
      const { steps, attempts } = trace.snapshot();
      await this.ctx.store.recordRequest(record, steps, attempts).catch(() => undefined);

      return {
        requestId,
        headers: {
          'x-request-id': requestId,
          'x-gateway-provider': model.providerId,
          'x-gateway-model': model.id,
          'x-gateway-usage-source': usage.source,
          ...(cost ? { 'x-gateway-estimated-cost': cost.totalCost.toFixed(8) } : {}),
        },
        body: {
          ...response,
          usage,
          gateway: { requestId, provider: model.providerId, model: model.id, latencyMs: trace.elapsedMs },
        },
      };
    } catch (err) {
      const error = GatewayError.from(err);
      error.requestId ??= requestId;
      trace.mark('response_sent', 'error', { httpStatus: error.status, errorType: error.type });
      const { steps, attempts } = trace.snapshot();
      await this.ctx.store
        .recordRequest(
          {
            id: requestId,
            organizationId: input.auth.organizationId,
            projectId: input.auth.projectId,
            apiKeyId: input.auth.apiKeyId,
            createdAt: new Date(this.ctx.clock.now()).toISOString(),
            endpoint: '/v1/embeddings',
            requestedModel: input.request.model,
            status: error.type === 'client_disconnected' ? 'cancelled' : 'error',
            errorType: error.type,
            errorMessage: error.message,
            httpStatus: error.status,
            streamed: false,
            latencyMs: trace.elapsedMs,
            cacheStatus: 'disabled',
            fallbackUsed: false,
            attemptCount: trace.attemptCount,
            isTest: input.request.gateway?.test === true,
            userAgent: input.userAgent,
          },
          steps,
          attempts,
        )
        .catch(() => undefined);
      throw error;
    }
  }
}
