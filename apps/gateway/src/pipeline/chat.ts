import {
  GatewayError,
  addUsage,
  estimateCompletionTokens,
  estimatePromptTokens,
  estimatedUsage,
  newRequestId,
  redact,
  sseData,
  SSE_DONE,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type MeasuredUsage,
  type RequestRecord,
  type RoutingReceipt,
} from '@ai-gateway/core';
import {
  decideCache,
  modelScopeFor,
  type CachedCompletion,
  type CacheDecision,
  type CachePolicy,
  type CacheScope,
  type EnabledCacheDecision,
} from '@ai-gateway/cache';
import { assertModelAllowed, evaluatePolicy, permittedModels } from '@ai-gateway/policies';
import { computeCost, projectCost } from '@ai-gateway/pricing';
import { TraceBuilder } from '@ai-gateway/observability';
import { METRICS } from '@ai-gateway/observability';
import {
  executeWithFallback,
  isRoutingStrategy,
  planRoute,
  requiredCapabilities,
  resolveCandidates,
  type RetryPolicy,
  type RouteTarget,
  type RoutePlan,
  type RoutingStrategy,
  type ScoredTarget,
  type TargetSignals,
} from '@ai-gateway/router';
import { buildState, evaluateBudgets, budgetError, type BudgetState } from '@ai-gateway/usage';
import { rateLimitHeaders, defaultRules } from '@ai-gateway/rate-limit';
import type { AuthenticatedKey } from '../auth.js';
import { targetKey, type GatewayContext } from '../context.js';
import { streamErrorFrame } from '../errors.js';
import { loadTenant, type TenantContext } from './tenant.js';

export interface ChatPipelineInput {
  auth: AuthenticatedKey;
  request: ChatRequest;
  requestId?: string;
  signal: AbortSignal;
  userAgent?: string;
  requestBytes?: number;
  endpoint?: RequestRecord['endpoint'];
}

export type PipelineResult =
  | { kind: 'json'; requestId: string; headers: Record<string, string>; body: ChatResponse }
  | { kind: 'stream'; requestId: string; headers: Record<string, string>; frames: AsyncIterable<string> };

/**
 * The gateway request pipeline.
 *
 * Every stage that can change the outcome opens a trace step, and the reason
 * for each decision is recorded rather than inferred. That is the whole point:
 * a caller should be able to answer "why did my request go there, what did it
 * cost, and what else was tried?" from the trace alone.
 *
 * Order matters and is deliberate:
 *   auth -> rate limit -> policy -> budget -> cache -> route -> execute
 * Nothing that costs money happens before every gate that could refuse it.
 */
export class ChatPipeline {
  constructor(private readonly ctx: GatewayContext) {}

  async run(input: ChatPipelineInput): Promise<PipelineResult> {
    const requestId = input.requestId ?? newRequestId();
    const trace = new TraceBuilder(requestId, this.ctx.clock);
    const logger = this.ctx.logger.child({
      requestId,
      organizationId: input.auth.organizationId,
      projectId: input.auth.projectId,
      apiKeyId: input.auth.apiKeyId,
    });

    trace.mark('request_received', 'ok', {
      endpoint: input.endpoint ?? '/v1/chat/completions',
      requestedModel: input.request.model,
      stream: input.request.stream === true,
    });
    // Authentication already succeeded upstream of the pipeline; recorded here
    // so the trace timeline is complete rather than starting mid-request.
    trace.mark('authentication', 'ok', { apiKeyPrefix: input.auth.prefix });

    const headers: Record<string, string> = { 'x-request-id': requestId };

    try {
      const tenant = await loadTenant(this.ctx, input.auth);

      // ---------------------------------------------------- rate limiting
      const rateStep = trace.step('rate_limit');
      const estimatedInput = estimatePromptTokens(input.request.messages);
      const rules = defaultRules();
      const limitCtx = {
        organizationId: tenant.organization.id,
        projectId: tenant.project.id,
        apiKeyId: input.auth.apiKeyId,
        userId: input.request.user,
        modelId: undefined as string | undefined,
        providerId: undefined as string | undefined,
      };
      const rateCheck = await this.ctx.rateLimiter.check(rules, limitCtx, estimatedInput);
      Object.assign(headers, rateLimitHeaders(rateCheck));

      if (!rateCheck.allowed) {
        rateStep.fail('rate_limit', `rule ${rateCheck.violated?.id} exceeded`);
        this.ctx.metrics.increment(METRICS.rateLimited, { rule: rateCheck.violated?.id ?? 'unknown' });
        throw new GatewayError(
          'rate_limit',
          `Rate limit exceeded: ${describeRule(rateCheck.violated)}.`,
          {
            requestId,
            retryAfterSeconds: rateCheck.retryAfterSeconds,
            details: { rule: rateCheck.violated?.id, limit: rateCheck.violated?.limit },
          },
        );
      }
      rateStep.end({ rulesEvaluated: rateCheck.results.length });

      // -------------------------------------------------- policy evaluation
      const policyStep = trace.step('policy_evaluation');
      const registeredIds = tenant.registeredModels.map((m) => m.id);
      const subject = {
        auth: input.auth,
        organizationAllowedModels: tenant.organization.allowedModels,
        organizationDeniedModels: tenant.organization.deniedModels,
        projectAllowedModels: tenant.project.allowedModels,
        projectDeniedModels: tenant.project.deniedModels,
        policy: tenant.policy,
        registeredModels: registeredIds,
        requestBytes: input.requestBytes,
      };
      const decision = evaluatePolicy(subject, input.request);
      const permitted = decision.permittedModels;

      const needed = requiredCapabilities(effectiveRequestCapabilityProbe(input.request));

      // An exact model reference is checked against the allowlist before the
      // router sees it, so a forbidden model returns 403 rather than being
      // quietly replaced by a fallback.
      if (!input.request.model.startsWith('gateway/')) {
        assertModelAllowed(input.request.model, permitted, registeredIds);

        // A named model that cannot serve the request is an error, not an
        // occasion to substitute a different one. Fallback exists for provider
        // failures; silently answering with a model the caller did not ask for
        // would make the response untrustworthy.
        const named = this.ctx.providers.getModel(input.request.model);
        const missing = named ? needed.filter((cap) => !named.capabilities.includes(cap)) : [];
        if (named && missing.length > 0) {
          policyStep.fail('capability_unsupported', `model lacks ${missing.join(', ')}`);
          throw new GatewayError(
            'capability_unsupported',
            `Model "${named.id}" does not support ${missing.join(', ')}, which this request requires. ` +
              `It supports: ${named.capabilities.join(', ')}.`,
            { model: named.id, details: { required: needed, missing, supported: named.capabilities } },
          );
        }
      }
      policyStep.end({
        policy: tenant.policy.name,
        policyVersion: tenant.policyVersion,
        permittedModels: permitted.length,
        adjustments: decision.adjustments,
      });

      const effectiveRequest = decision.request;
      const maxOutput = effectiveRequest.max_completion_tokens ?? effectiveRequest.max_tokens ?? 1024;

      // --------------------------------------------------- candidate set
      const candidates = this.buildCandidates(permitted, tenant);
      const resolved = resolveCandidates({
        requestedModel: effectiveRequest.model,
        allowed: candidates,
        explicitModels: effectiveRequest.gateway?.models,
        policyModels: tenant.policy.routing.models.map((m) => (typeof m === 'string' ? m : m.model)),
      });

      const strategy = this.pickStrategy(effectiveRequest, tenant, resolved.impliedStrategy);

      // ----------------------------------------------------- budget check
      const budgetStep = trace.step('budget_check');
      const budgetStates = await this.loadBudgetStates(tenant);
      const cheapestProjection = this.cheapestProjection(resolved.candidates, estimatedInput, maxOutput);
      const budgetOutcome = evaluateBudgets({ states: budgetStates, projectedCost: cheapestProjection });

      let budgetCeiling: number | undefined;
      if (budgetOutcome.decision === 'block') {
        budgetStep.fail('budget_exceeded', `budget ${budgetOutcome.blocked.budget.id} exhausted`);
        this.ctx.metrics.increment(METRICS.budgetBlocks, { action: 'BLOCK' });
        void this.emitBudgetEvent(tenant, budgetOutcome.blocked, 'exceeded', requestId);
        throw budgetError(budgetOutcome.blocked);
      }
      if (budgetOutcome.decision === 'downgrade') {
        budgetCeiling = budgetOutcome.maxSpend;
        budgetStep.end({
          action: 'FALLBACK_TO_CHEAPER_MODEL',
          remainingBudget: budgetCeiling,
          note: 'routing restricted to targets within the remaining budget',
        });
        this.ctx.metrics.increment(METRICS.budgetBlocks, { action: 'FALLBACK_TO_CHEAPER_MODEL' });
        void this.emitBudgetEvent(tenant, budgetOutcome.trigger, 'downgraded', requestId);
      } else {
        budgetStep.end({ budgetsEvaluated: budgetStates.length, projectedCost: cheapestProjection });
      }
      for (const warning of budgetOutcome.warnings) {
        void this.emitBudgetEvent(tenant, warning, 'warning', requestId);
      }

      // ------------------------------------------------------ cache lookup
      const cachePolicy = tenant.policy.cache as CachePolicy;
      const cacheDecision = decideCache(cachePolicy, effectiveRequest);
      const cacheStep = trace.step('cache_lookup');

      if (!cacheDecision.read) {
        cacheStep.skip('reason' in cacheDecision ? cacheDecision.reason : 'caching disabled');
        this.ctx.metrics.increment(METRICS.cacheLookups, { result: 'disabled' });
      } else {
        const scope = this.cacheScope(tenant, effectiveRequest, cachePolicy, resolved.candidates);
        const hit = await this.lookupCache(scope, effectiveRequest, cacheDecision, input.signal);
        if (hit) {
          cacheStep.end({ result: hit.status, similarity: hit.similarity, producedBy: hit.entry.producedBy });
          this.ctx.metrics.increment(METRICS.cacheLookups, { result: hit.status });
          return this.serveFromCache({
            requestId,
            trace,
            headers,
            tenant,
            input,
            request: effectiveRequest,
            hit,
            strategy,
          });
        }
        cacheStep.end({ result: 'miss' });
        this.ctx.metrics.increment(METRICS.cacheLookups, { result: 'miss' });
      }

      // ----------------------------------------------------------- routing
      const routeStep = trace.step('routing');
      const plan = planRoute({
        request: effectiveRequest,
        candidates: resolved.candidates,
        strategy,
        requiredCapabilities: needed,
        signals: (target) => this.signalsFor(target, estimatedInput, maxOutput),
        maxChainLength: tenant.policy.fallback.maxTargets,
        fallbackEnabled: effectiveRequest.gateway?.fallback ?? tenant.policy.fallback.enabled,
        remainingBudget: budgetCeiling,
        roundRobinCursor: this.ctx.nextRoutingCursor(),
      });
      routeStep.end({
        strategy: plan.strategy,
        chain: plan.chain.map((t) => t.target.modelId),
        rejected: plan.rejected,
        reasons: plan.reasons,
      });

      logger.debug('route planned', {
        strategy: plan.strategy,
        primary: plan.chain[0]?.target.modelId,
        chainLength: plan.chain.length,
      });

      const retry = this.retryPolicyFor(tenant);

      // ---------------------------------------------------------- execute
      if (effectiveRequest.stream) {
        return this.runStreaming({
          requestId, trace, headers, tenant, input, request: effectiveRequest, plan, retry, cacheDecision, cachePolicy, strategy, estimatedInput,
        });
      }
      return await this.runBuffered({
        requestId, trace, headers, tenant, input, request: effectiveRequest, plan, retry, cacheDecision, cachePolicy, strategy, estimatedInput,
      });
    } catch (err) {
      const error = GatewayError.from(err);
      error.requestId ??= requestId;
      await this.recordFailure({ requestId, trace, input, error, logger });
      throw error;
    }
  }

  // ------------------------------------------------------------ execution

  private async runBuffered(args: ExecutionArgs): Promise<PipelineResult> {
    const { requestId, trace, headers, tenant, input, request, plan, retry } = args;

    const result = await executeWithFallback<ChatResponse>({
      plan,
      retry,
      trace,
      signal: input.signal,
      clock: this.ctx.clock,
      onRetry: ({ target, delayMs, error, attemptNumber }) =>
        this.ctx.logger.warn('retrying upstream', {
          requestId,
          provider: target.target.providerId,
          model: target.target.modelId,
          errorType: error.type,
          delayMs,
          attempt: attemptNumber,
        }),
      onFallback: ({ from, to, error }) => {
        this.ctx.metrics.increment(METRICS.fallbacks, { from: from.target.modelId, to: to.target.modelId });
        this.ctx.logger.warn('failing over', {
          requestId,
          from: from.target.modelId,
          to: to.target.modelId,
          errorType: error.type,
        });
      },
      attempt: async ({ target, recorder, signal }) => {
        const provider = this.ctx.providers.requireProvider(target.target.providerId);
        const breaker = this.ctx.circuits.get(targetKey(target.target.providerId, target.target.modelId));
        if (!breaker.allow()) {
          throw new GatewayError('circuit_open', `Circuit is open for ${target.target.modelId}.`, {
            provider: target.target.providerId,
            model: target.target.modelId,
          });
        }

        const startedAt = this.ctx.clock.now();
        const providerStep = trace.step('provider_request');
        try {
          const response = await provider.chat(request, {
            requestId,
            attempt: recorder.record.attemptNumber,
            signal,
            timeoutMs: this.timeoutFor(tenant, request),
            model: target.target.model,
          });
          const elapsed = this.ctx.clock.now() - startedAt;
          providerStep.end({ provider: target.target.providerId, model: target.target.modelId, durationMs: elapsed });
          breaker.recordSuccess();
          this.ctx.health.recordSuccess(targetKey(target.target.providerId, target.target.modelId), elapsed);
          this.ctx.health.recordSuccess(targetKey(target.target.providerId), elapsed);
          this.ctx.metrics.observe(METRICS.providerDuration, elapsed, {
            provider: target.target.providerId,
            model: target.target.modelId,
          });
          this.ctx.metrics.increment(METRICS.providerAttempts, {
            provider: target.target.providerId,
            outcome: 'success',
          });
          recorder.succeed(response.usage);
          return response;
        } catch (err) {
          const error = GatewayError.from(err);
          const elapsed = this.ctx.clock.now() - startedAt;
          providerStep.fail(error.type, error.message, { provider: target.target.providerId, model: target.target.modelId });
          this.noteAttemptFailure(target, error, elapsed);
          throw error;
        }
      },
    });

    const usage = this.resolveUsage(result.value.usage, request, textOf(result.value));
    const finalized = await this.finalize({
      requestId, trace, tenant, input, request, plan, strategy: args.strategy,
      target: result.target, usage, cacheStatus: 'miss', httpStatus: 200, streamed: false,
      attempts: result.attempts, fallbackUsed: result.fallbackUsed,
    });

    // Writing to the cache must never fail the request that populated it.
    if (args.cacheDecision.write) {
      const cacheStep = trace.step('cache_write');
      try {
        await this.writeCache(args, result.target, { ...result.value, usage }, finalized.receipt);
        cacheStep.end({ mode: 'mode' in args.cacheDecision ? args.cacheDecision.mode : 'off' });
      } catch (err) {
        cacheStep.fail('internal_error', 'cache write failed');
        this.ctx.logger.warn('cache write failed', { requestId, error: (err as Error).message });
      }
    }

    trace.mark('response_sent', 'ok', { httpStatus: 200 });
    await this.persist(finalized.record, trace, input, request, result.value, tenant);

    return {
      kind: 'json',
      requestId,
      headers: { ...headers, ...finalized.headers },
      body: { ...result.value, usage, gateway: finalized.receipt },
    };
  }

  /**
   * Streaming execution.
   *
   * The response is forwarded chunk by chunk and never buffered as a unit; the
   * only thing accumulated is the assembled text, and that only when the cache
   * is enabled for this request. Recording happens after the stream drains,
   * including when the client disconnects mid-stream.
   */
  private runStreaming(args: ExecutionArgs): PipelineResult {
    const { requestId, trace, headers, tenant, input, request, plan, retry } = args;
    const self = this;

    const frames = (async function* (): AsyncGenerator<string> {
      let assembled = '';
      let usage: MeasuredUsage | undefined;
      let target: ScoredTarget | undefined;
      let attempts = 0;
      let fallbackUsed = false;
      let firstTokenAt: number | undefined;
      let failure: GatewayError | undefined;

      try {
        const stream = await executeWithFallback<AsyncIterable<ChatChunk>>({
          plan,
          retry,
          trace,
          signal: input.signal,
          clock: self.ctx.clock,
          onFallback: ({ from, to, error }) => {
            self.ctx.metrics.increment(METRICS.fallbacks, { from: from.target.modelId, to: to.target.modelId });
            self.ctx.logger.warn('failing over mid-stream setup', {
              requestId, from: from.target.modelId, to: to.target.modelId, errorType: error.type,
            });
          },
          attempt: async ({ target: candidate, recorder, signal }) => {
            const provider = self.ctx.providers.requireProvider(candidate.target.providerId);
            const breaker = self.ctx.circuits.get(targetKey(candidate.target.providerId, candidate.target.modelId));
            if (!breaker.allow()) {
              throw new GatewayError('circuit_open', `Circuit is open for ${candidate.target.modelId}.`, {
                provider: candidate.target.providerId,
                model: candidate.target.modelId,
              });
            }

            const providerStep = trace.step('provider_request');
            const startedAt = self.ctx.clock.now();
            const iterator = provider.stream(request, {
              requestId,
              attempt: recorder.record.attemptNumber,
              signal,
              timeoutMs: self.timeoutFor(tenant, request),
              model: candidate.target.model,
            })[Symbol.asyncIterator]();

            // Pull the first chunk inside the retry boundary. A provider that
            // fails on connect is still failoverable; once bytes have reached
            // the client it is too late to switch.
            let first: IteratorResult<ChatChunk>;
            try {
              first = await iterator.next();
            } catch (err) {
              const error = GatewayError.from(err);
              providerStep.fail(error.type, error.message, { provider: candidate.target.providerId });
              self.noteAttemptFailure(candidate, error, self.ctx.clock.now() - startedAt);
              throw error;
            }

            providerStep.end({ provider: candidate.target.providerId, model: candidate.target.modelId, firstChunk: true });
            recorder.firstToken();
            firstTokenAt = self.ctx.clock.now() - startedAt;
            target = candidate;

            return {
              async *[Symbol.asyncIterator]() {
                if (!first.done && first.value) yield first.value;
                for (;;) {
                  const next = await iterator.next();
                  if (next.done) return;
                  yield next.value;
                }
              },
            };
          },
        });

        target = stream.target;
        attempts = stream.attempts;
        fallbackUsed = stream.fallbackUsed;

        const resolvedTarget = stream.target;
        const breaker = self.ctx.circuits.get(
          targetKey(resolvedTarget.target.providerId, resolvedTarget.target.modelId),
        );
        const streamStartedAt = self.ctx.clock.now();

        try {
          for await (const chunk of stream.value) {
            if (input.signal.aborted) {
              throw new GatewayError('client_disconnected', 'The client disconnected mid-stream.');
            }
            const delta = chunk.choices[0]?.delta.content;
            if (delta) assembled += delta;
            if (chunk.usage) usage = addUsage(usage, chunk.usage) ?? chunk.usage;
            yield sseData(stripGatewayFields(chunk));
          }

          const elapsed = self.ctx.clock.now() - streamStartedAt;
          breaker.recordSuccess();
          self.ctx.health.recordSuccess(targetKey(resolvedTarget.target.providerId, resolvedTarget.target.modelId), elapsed);
          self.ctx.health.recordSuccess(targetKey(resolvedTarget.target.providerId), elapsed);
          self.ctx.metrics.increment(METRICS.providerAttempts, {
            provider: resolvedTarget.target.providerId,
            outcome: 'success',
          });
          if (firstTokenAt !== undefined) {
            self.ctx.metrics.observe(METRICS.timeToFirstToken, firstTokenAt, {
              provider: resolvedTarget.target.providerId,
              model: resolvedTarget.target.modelId,
            });
          }
        } catch (err) {
          const error = GatewayError.from(err);
          self.noteAttemptFailure(resolvedTarget, error, self.ctx.clock.now() - streamStartedAt);
          throw error;
        }

        const finalUsage = self.resolveUsage(usage, request, assembled);
        const finalized = await self.finalize({
          requestId, trace, tenant, input, request, plan, strategy: args.strategy,
          target: resolvedTarget, usage: finalUsage, cacheStatus: 'miss', httpStatus: 200, streamed: true,
          attempts, fallbackUsed, timeToFirstTokenMs: firstTokenAt,
        });

        if (args.cacheDecision.write && assembled) {
          const cacheStep = trace.step('cache_write');
          try {
            await self.writeCache(
              args,
              resolvedTarget,
              synthesizeResponse(requestId, resolvedTarget.target.modelId, assembled, finalUsage),
              finalized.receipt,
            );
            cacheStep.end({ mode: 'mode' in args.cacheDecision ? args.cacheDecision.mode : 'off', fromStream: true });
          } catch {
            cacheStep.skip('cache write failed');
          }
        }

        // Terminal receipt: routing detail for a response whose headers are long gone.
        yield sseData({ gateway: finalized.receipt });
        yield sseData(SSE_DONE);

        trace.mark('response_sent', 'ok', { httpStatus: 200, streamed: true });
        await self.persist(finalized.record, trace, input, request, undefined, tenant);
      } catch (err) {
        failure = GatewayError.from(err);
        failure.requestId ??= requestId;

        if (failure.type === 'client_disconnected') {
          self.ctx.logger.info('client disconnected mid-stream', { requestId });
        } else {
          self.ctx.logger.error('stream failed', { requestId, errorType: failure.type, error: failure.message });
          yield streamErrorFrame(failure, requestId);
          yield sseData(SSE_DONE);
        }

        await self.recordStreamFailure({
          requestId, trace, tenant, input, request, plan, strategy: args.strategy,
          target, error: failure, attempts, fallbackUsed, usage, assembled, timeToFirstTokenMs: firstTokenAt,
        });
      }
    })();

    return {
      kind: 'stream',
      requestId,
      headers: {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      frames,
    };
  }

  // -------------------------------------------------------------- caching

  private cacheScope(
    tenant: TenantContext,
    request: ChatRequest,
    policy: CachePolicy,
    candidates: RouteTarget[],
  ): CacheScope {
    const primary = candidates[0];
    const modelScope = modelScopeFor(policy, primary?.modelId ?? request.model, primary?.model.family);
    return {
      organizationId: tenant.organization.id,
      ...(policy.perProject ? { projectId: tenant.project.id } : {}),
      modelScope,
    };
  }

  private async lookupCache(
    scope: CacheScope,
    request: ChatRequest,
    decision: EnabledCacheDecision,
    signal: AbortSignal,
  ): Promise<CacheHit | null> {
    const exact = await this.ctx.exactCache.lookup(scope, request);
    if (exact.hit && exact.entry) return { status: 'exact_hit', entry: exact.entry };

    if (decision.mode === 'semantic' && this.ctx.semanticCache) {
      const hit = await this.ctx.semanticCache.lookup(scope, request, decision.threshold, signal);
      if (hit) return { status: 'semantic_hit', entry: hit.entry, similarity: hit.similarity };
    }
    return null;
  }

  private async writeCache(
    args: ExecutionArgs,
    target: ScoredTarget,
    response: ChatResponse,
    receipt: RoutingReceipt,
  ): Promise<void> {
    if (!args.cacheDecision.write || !('mode' in args.cacheDecision)) return;
    const scope = this.cacheScope(args.tenant, args.request, args.cachePolicy, [target.target]);
    const entry = {
      response,
      storedAt: Date.now(),
      producedBy: { providerId: target.target.providerId, modelId: target.target.modelId },
      usage: response.usage,
      pricingVersion: receipt.estimatedCost?.pricingVersion,
    };
    await this.ctx.exactCache.store(scope, args.request, entry, args.cacheDecision.ttlSeconds);
    if (args.cacheDecision.mode === 'semantic' && this.ctx.semanticCache) {
      await this.ctx.semanticCache.store(scope, args.request, entry);
    }
  }

  /**
   * Serve a cache hit.
   *
   * The receipt keeps the original producer's attribution and records a zero
   * cost for this request: a cached answer did not call a provider, and
   * pretending otherwise would corrupt both cost and provider analytics.
   */
  private async serveFromCache(args: {
    requestId: string;
    trace: TraceBuilder;
    headers: Record<string, string>;
    tenant: TenantContext;
    input: ChatPipelineInput;
    request: ChatRequest;
    hit: CacheHit;
    strategy: RoutingStrategy;
  }): Promise<PipelineResult> {
    const { requestId, trace, tenant, input, hit } = args;
    const receipt: RoutingReceipt = {
      requestId,
      provider: hit.entry.producedBy.providerId,
      model: hit.entry.producedBy.modelId,
      strategy: args.strategy,
      reasons: [
        `served from ${hit.status === 'exact_hit' ? 'exact' : 'semantic'} cache`,
        `originally produced by ${hit.entry.producedBy.modelId}`,
        ...(hit.similarity !== undefined ? [`similarity ${hit.similarity.toFixed(4)}`] : []),
      ],
      cache: hit.status,
      cacheSimilarity: hit.similarity,
      attempts: 0,
      fallbackUsed: false,
      latencyMs: trace.elapsedMs,
      usageSource: hit.entry.usage?.source,
      estimatedCost: { amount: 0, currency: tenant.organization.currency, pricingVersion: this.ctx.pricing.version },
    };

    const record: RequestRecord = {
      id: requestId,
      organizationId: tenant.organization.id,
      projectId: tenant.project.id,
      apiKeyId: input.auth.apiKeyId,
      createdAt: new Date(this.ctx.clock.now()).toISOString(),
      endpoint: input.endpoint ?? '/v1/chat/completions',
      requestedModel: input.request.model,
      resolvedProviderId: hit.entry.producedBy.providerId,
      resolvedModelId: hit.entry.producedBy.modelId,
      strategy: args.strategy,
      status: 'success',
      httpStatus: 200,
      streamed: input.request.stream === true,
      latencyMs: trace.elapsedMs,
      cacheStatus: hit.status,
      cacheSimilarity: hit.similarity,
      fallbackUsed: false,
      attemptCount: 0,
      usage: hit.entry.usage,
      usageSource: hit.entry.usage?.source,
      // A cache hit costs nothing. Only the request that populated it did.
      estimatedCost: 0,
      currency: tenant.organization.currency,
      pricingVersion: hit.entry.pricingVersion,
      isTest: input.request.gateway?.test === true,
      tags: input.request.gateway?.tags,
      routingReasons: receipt.reasons,
      userAgent: input.userAgent,
    };

    this.ctx.metrics.increment(METRICS.requests, { status: 'success', cache: hit.status });
    this.ctx.metrics.observe(METRICS.requestDuration, trace.elapsedMs, { cache: hit.status });
    trace.mark('response_sent', 'ok', { httpStatus: 200, cache: hit.status });
    await this.persist(record, trace, input, args.request, hit.entry.response, tenant);

    const headers = { ...args.headers, 'x-gateway-cache': hit.status };

    if (input.request.stream) {
      // Replay a cached response as a well-formed stream so a streaming client
      // does not need a separate code path for hits.
      const response = hit.entry.response;
      const frames = (async function* (): AsyncGenerator<string> {
        const text = textOf(response);
        yield sseData(chunkFrame(requestId, response.model, { role: 'assistant', content: '' }, null));
        if (text) yield sseData(chunkFrame(requestId, response.model, { content: text }, null));
        yield sseData({ ...chunkFrame(requestId, response.model, {}, 'stop'), usage: hit.entry.usage });
        yield sseData({ gateway: receipt });
        yield sseData(SSE_DONE);
      })();
      return {
        kind: 'stream',
        requestId,
        headers: {
          ...headers,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
        },
        frames,
      };
    }

    return {
      kind: 'json',
      requestId,
      headers,
      body: { ...hit.entry.response, gateway: receipt },
    };
  }

  // ------------------------------------------------------------ bookkeeping

  private async finalize(args: {
    requestId: string;
    trace: TraceBuilder;
    tenant: TenantContext;
    input: ChatPipelineInput;
    request: ChatRequest;
    plan: RoutePlan;
    strategy: RoutingStrategy;
    target: ScoredTarget;
    usage: MeasuredUsage;
    cacheStatus: RequestRecord['cacheStatus'];
    httpStatus: number;
    streamed: boolean;
    attempts: number;
    fallbackUsed: boolean;
    timeToFirstTokenMs?: number;
  }): Promise<{ record: RequestRecord; receipt: RoutingReceipt; headers: Record<string, string> }> {
    const { requestId, trace, tenant, input, target, usage } = args;

    const usageStep = trace.step('usage_extraction');
    const pricing = this.ctx.pricing.lookup(target.target.modelId);
    const cost = pricing ? computeCost(usage, pricing.pricing, pricing.version) : undefined;
    usageStep.end({
      source: usage.source,
      inputTokens: usage.input,
      outputTokens: usage.output,
      priced: !!pricing,
      ...(pricing ? {} : { note: 'no pricing configured for this model; cost not recorded' }),
    });

    const isTest = input.request.gateway?.test === true;
    if (cost && !isTest) {
      // Test traffic is metered for rate limits but never charged against a budget.
      await this.ctx.spend.record(
        { organizationId: tenant.organization.id, projectId: tenant.project.id, apiKeyId: input.auth.apiKeyId },
        cost.totalCost,
      );
    }

    await this.ctx.rateLimiter.settle(
      defaultRules(),
      {
        organizationId: tenant.organization.id,
        projectId: tenant.project.id,
        apiKeyId: input.auth.apiKeyId,
        userId: input.request.user,
        modelId: target.target.modelId,
        providerId: target.target.providerId,
      },
      usage.total,
    );

    const receipt: RoutingReceipt = {
      requestId,
      provider: target.target.providerId,
      model: target.target.modelId,
      strategy: args.strategy,
      reasons: [...args.plan.reasons],
      cache: args.cacheStatus,
      attempts: args.attempts,
      fallbackUsed: args.fallbackUsed,
      rejected: args.plan.rejected.length ? args.plan.rejected : undefined,
      latencyMs: trace.elapsedMs,
      usageSource: usage.source,
      estimatedCost: cost
        ? { amount: cost.totalCost, currency: cost.currency, pricingVersion: cost.pricingVersion }
        : undefined,
    };

    const record: RequestRecord = {
      id: requestId,
      organizationId: tenant.organization.id,
      projectId: tenant.project.id,
      apiKeyId: input.auth.apiKeyId,
      createdAt: new Date(this.ctx.clock.now()).toISOString(),
      endpoint: input.endpoint ?? '/v1/chat/completions',
      requestedModel: input.request.model,
      resolvedProviderId: target.target.providerId,
      resolvedModelId: target.target.modelId,
      strategy: args.strategy,
      status: 'success',
      httpStatus: args.httpStatus,
      streamed: args.streamed,
      latencyMs: trace.elapsedMs,
      timeToFirstTokenMs: args.timeToFirstTokenMs,
      cacheStatus: args.cacheStatus,
      fallbackUsed: args.fallbackUsed,
      attemptCount: args.attempts,
      usage,
      usageSource: usage.source,
      estimatedCost: cost?.totalCost,
      currency: cost?.currency ?? tenant.organization.currency,
      pricingVersion: cost?.pricingVersion,
      isTest,
      tags: input.request.gateway?.tags,
      routingReasons: receipt.reasons,
      userAgent: input.userAgent,
    };

    this.recordMetrics(record, trace);

    return {
      record,
      receipt,
      headers: {
        'x-gateway-provider': target.target.providerId,
        'x-gateway-model': target.target.modelId,
        'x-gateway-strategy': args.strategy,
        'x-gateway-attempts': String(args.attempts),
        'x-gateway-cache': args.cacheStatus,
        'x-gateway-usage-source': usage.source,
        ...(cost ? { 'x-gateway-estimated-cost': cost.totalCost.toFixed(8) } : {}),
      },
    };
  }

  private recordMetrics(record: RequestRecord, trace: TraceBuilder): void {
    const labels = {
      status: record.status,
      provider: record.resolvedProviderId ?? 'none',
      model: record.resolvedModelId ?? 'none',
    };
    this.ctx.metrics.increment(METRICS.requests, labels);
    this.ctx.metrics.observe(METRICS.requestDuration, record.latencyMs, labels);
    this.ctx.metrics.observe(METRICS.gatewayOverhead, trace.overheadMs(), {
      provider: record.resolvedProviderId ?? 'none',
    });
    if (record.usage) {
      this.ctx.metrics.increment(METRICS.tokens, { direction: 'input', source: record.usage.source }, record.usage.input);
      this.ctx.metrics.increment(METRICS.tokens, { direction: 'output', source: record.usage.source }, record.usage.output);
    }
    if (record.estimatedCost) {
      this.ctx.metrics.increment(METRICS.estimatedCost, { currency: record.currency ?? 'USD' }, record.estimatedCost);
    }
  }

  /** Persist the request row, its trace, and any body the retention policy allows. */
  private async persist(
    record: RequestRecord,
    trace: TraceBuilder,
    input: ChatPipelineInput,
    request: ChatRequest,
    response: ChatResponse | undefined,
    tenant: TenantContext,
  ): Promise<void> {
    const { steps, attempts } = trace.snapshot();
    try {
      await this.ctx.store.recordRequest({ ...record, attemptCount: attempts.length || record.attemptCount }, steps, attempts);
      await this.storeBodies(record, request, response, tenant);
    } catch (err) {
      // Losing a log line must never fail a request the caller already paid for.
      this.ctx.logger.error('failed to persist request record', {
        requestId: record.id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Store request/response bodies per the organization's retention mode.
   *
   * Default is `metadata_only`, so nothing is written unless an operator has
   * deliberately opted in. `redacted` runs the same redactor used by the logger.
   */
  private async storeBodies(
    record: RequestRecord,
    request: ChatRequest,
    response: ChatResponse | undefined,
    tenant: TenantContext,
  ): Promise<void> {
    const privacy = tenant.privacy;
    if (privacy.mode === 'none' || privacy.mode === 'metadata_only') return;

    const expiresAt = new Date(this.ctx.clock.now() + privacy.retentionDays * 86_400_000).toISOString();

    await this.ctx.store.putPromptBody({
      requestId: record.id,
      organizationId: record.organizationId,
      request: privacy.mode === 'redacted' ? redact(request) : request,
      response: response ? (privacy.mode === 'redacted' ? redact(response) : response) : undefined,
      storedAt: new Date(this.ctx.clock.now()).toISOString(),
      expiresAt,
    });
  }

  private async recordFailure(args: {
    requestId: string;
    trace: TraceBuilder;
    input: ChatPipelineInput;
    error: GatewayError;
    logger: GatewayContext['logger'];
  }): Promise<void> {
    const { requestId, trace, input, error } = args;
    trace.mark('response_sent', 'error', { httpStatus: error.status, errorType: error.type });

    const record: RequestRecord = {
      id: requestId,
      organizationId: input.auth.organizationId,
      projectId: input.auth.projectId,
      apiKeyId: input.auth.apiKeyId,
      createdAt: new Date(this.ctx.clock.now()).toISOString(),
      endpoint: input.endpoint ?? '/v1/chat/completions',
      requestedModel: input.request.model,
      resolvedProviderId: error.provider,
      resolvedModelId: error.model,
      status: error.type === 'client_disconnected' ? 'cancelled' : 'error',
      errorType: error.type,
      errorMessage: error.message,
      httpStatus: error.status,
      streamed: input.request.stream === true,
      latencyMs: trace.elapsedMs,
      cacheStatus: 'miss',
      fallbackUsed: trace.fallbackUsed(),
      attemptCount: trace.attemptCount,
      isTest: input.request.gateway?.test === true,
      tags: input.request.gateway?.tags,
      userAgent: input.userAgent,
    };

    this.ctx.metrics.increment(METRICS.requests, { status: record.status, errorType: error.type });
    args.logger.warn('request failed', {
      errorType: error.type,
      status: error.status,
      latencyMs: record.latencyMs,
      attempts: record.attemptCount,
    });

    const { steps, attempts } = trace.snapshot();
    await this.ctx.store.recordRequest(record, steps, attempts).catch(() => undefined);
  }

  private async recordStreamFailure(args: {
    requestId: string;
    trace: TraceBuilder;
    tenant: TenantContext;
    input: ChatPipelineInput;
    request: ChatRequest;
    plan: RoutePlan;
    strategy: RoutingStrategy;
    target?: ScoredTarget;
    error: GatewayError;
    attempts: number;
    fallbackUsed: boolean;
    usage?: MeasuredUsage;
    assembled: string;
    timeToFirstTokenMs?: number;
  }): Promise<void> {
    const { requestId, trace, tenant, input, error } = args;
    trace.mark('response_sent', 'error', { httpStatus: 200, errorType: error.type, partialStream: true });

    // Tokens already produced were still billed by the provider, so partial
    // usage is recorded rather than discarded.
    const usage = args.usage ?? (args.assembled
      ? estimatedUsage(estimatePromptTokens(args.request.messages), estimateCompletionTokens(args.assembled))
      : undefined);

    const record: RequestRecord = {
      id: requestId,
      organizationId: tenant.organization.id,
      projectId: tenant.project.id,
      apiKeyId: input.auth.apiKeyId,
      createdAt: new Date(this.ctx.clock.now()).toISOString(),
      endpoint: input.endpoint ?? '/v1/chat/completions',
      requestedModel: input.request.model,
      resolvedProviderId: args.target?.target.providerId ?? error.provider,
      resolvedModelId: args.target?.target.modelId ?? error.model,
      strategy: args.strategy,
      status: error.type === 'client_disconnected' ? 'cancelled' : 'error',
      errorType: error.type,
      errorMessage: error.message,
      // The HTTP status was already 200 when the stream opened; the trace is
      // what records what actually happened.
      httpStatus: 200,
      streamed: true,
      latencyMs: trace.elapsedMs,
      timeToFirstTokenMs: args.timeToFirstTokenMs,
      cacheStatus: 'miss',
      fallbackUsed: args.fallbackUsed,
      attemptCount: args.attempts || trace.attemptCount,
      usage,
      usageSource: usage?.source,
      currency: tenant.organization.currency,
      isTest: input.request.gateway?.test === true,
      tags: input.request.gateway?.tags,
      routingReasons: args.plan.reasons,
      userAgent: input.userAgent,
    };

    this.ctx.metrics.increment(METRICS.requests, { status: record.status, errorType: error.type, streamed: 'true' });
    const { steps, attempts } = trace.snapshot();
    await this.ctx.store.recordRequest(record, steps, attempts).catch(() => undefined);
  }

  // --------------------------------------------------------------- helpers

  private buildCandidates(permitted: string[], tenant: TenantContext): RouteTarget[] {
    const weights = new Map<string, { weight?: number; priority?: number }>();
    for (const entry of tenant.policy.routing.models) {
      if (typeof entry === 'string') weights.set(entry, {});
      else weights.set(entry.model, { weight: entry.weight, priority: entry.priority });
    }

    const permittedSet = new Set(permitted);
    const ordered: RouteTarget[] = [];

    // Policy order first, then any other permitted model, so a policy's intent
    // survives while still leaving the rest available as fallbacks.
    for (const [modelId, meta] of weights) {
      if (!permittedSet.has(modelId)) continue;
      const model = this.ctx.providers.getModel(modelId);
      if (!model) continue;
      ordered.push({ providerId: model.providerId, modelId, model, ...meta });
    }
    for (const modelId of permitted) {
      if (weights.has(modelId)) continue;
      const model = this.ctx.providers.getModel(modelId);
      if (!model) continue;
      ordered.push({ providerId: model.providerId, modelId, model });
    }
    return ordered;
  }

  private pickStrategy(
    request: ChatRequest,
    tenant: TenantContext,
    implied: RoutingStrategy | undefined,
  ): RoutingStrategy {
    const requested = request.gateway?.strategy;
    if (requested) {
      if (!isRoutingStrategy(requested)) {
        throw new GatewayError('invalid_request', `Unknown routing strategy "${requested}".`);
      }
      return requested;
    }
    // An explicit model reference beats the policy's strategy; the policy's
    // strategy beats the virtual-model default.
    if (implied === 'explicit') return 'explicit';
    return (tenant.policy.routing.strategy as RoutingStrategy) ?? implied ?? 'highest_reliability';
  }

  private signalsFor(target: RouteTarget, estimatedInput: number, maxOutput: number): TargetSignals {
    const modelKey = targetKey(target.providerId, target.modelId);
    const stats = this.ctx.health.stats(modelKey);
    const providerStats = this.ctx.health.stats(targetKey(target.providerId));
    // Prefer per-model history; fall back to the provider's when the model is new.
    const effective = stats.total > 0 ? stats : providerStats;
    const pricing = this.ctx.pricing.lookup(target.modelId);

    return {
      health: effective,
      healthState: effective.state,
      circuit: this.ctx.circuits.get(modelKey).currentState,
      projectedCost: pricing ? projectCost(estimatedInput, maxOutput, pricing.pricing) : undefined,
      p95LatencyMs: effective.total > 0 ? effective.p95LatencyMs : undefined,
      successRate: effective.total > 0 ? effective.successRate : undefined,
    };
  }

  private cheapestProjection(candidates: RouteTarget[], estimatedInput: number, maxOutput: number): number {
    const projections = candidates
      .map((c) => this.ctx.pricing.lookup(c.modelId))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => projectCost(estimatedInput, maxOutput, p.pricing));
    // No pricing means no projection; the budget gate cannot invent a cost.
    return projections.length ? Math.min(...projections) : 0;
  }

  private async loadBudgetStates(tenant: TenantContext): Promise<BudgetState[]> {
    const now = new Date(this.ctx.clock.now());
    return Promise.all(
      tenant.budgets.map(async (budget) =>
        buildState(budget, await this.ctx.spend.readForBudget(budget, now), now),
      ),
    );
  }

  private retryPolicyFor(tenant: TenantContext): RetryPolicy {
    const retry = tenant.policy.retry;
    return {
      maxAttempts: retry.maxAttempts,
      initialDelayMs: retry.initialDelayMs,
      maxDelayMs: retry.maxDelayMs,
      backoff: retry.backoff,
      factor: retry.factor,
      jitter: retry.jitter,
      respectRetryAfter: retry.respectRetryAfter,
      retryableErrors: [
        'provider_timeout',
        'provider_unavailable',
        'provider_overloaded',
        'provider_error',
        'provider_rate_limit',
      ],
    };
  }

  private timeoutFor(tenant: TenantContext, request: ChatRequest): number {
    return Math.min(
      request.gateway?.timeoutMs ?? tenant.policy.limits.timeoutMs,
      tenant.policy.limits.timeoutMs,
      this.ctx.config.defaultTimeoutMs,
    );
  }

  private noteAttemptFailure(target: ScoredTarget, error: GatewayError, elapsedMs: number): void {
    const modelKey = targetKey(target.target.providerId, target.target.modelId);
    // A client hang-up is not the provider's fault and must not damage its
    // health score or trip its breaker.
    if (error.type === 'client_disconnected') return;

    const breaker = this.ctx.circuits.get(modelKey);
    if (error.retryable || error.failoverable) {
      breaker.recordFailure();
      this.ctx.health.recordFailure(modelKey, elapsedMs, error.type);
      this.ctx.health.recordFailure(targetKey(target.target.providerId), elapsedMs, error.type);
    }
    this.ctx.metrics.increment(METRICS.providerAttempts, {
      provider: target.target.providerId,
      outcome: 'error',
      errorType: error.type,
    });
    this.ctx.metrics.setGauge(METRICS.circuitState, circuitGauge(breaker.currentState), {
      provider: target.target.providerId,
      model: target.target.modelId,
    });
  }

  /**
   * Prefer the provider's own token counts; estimate only when it reported none.
   * An estimate is always labelled as such and never presented as reported.
   */
  private resolveUsage(usage: MeasuredUsage | undefined, request: ChatRequest, text: string): MeasuredUsage {
    if (usage && usage.total > 0) return usage;
    return estimatedUsage(estimatePromptTokens(request.messages), estimateCompletionTokens(text));
  }

  private async emitBudgetEvent(
    tenant: TenantContext,
    state: BudgetState,
    kind: 'warning' | 'exceeded' | 'downgraded',
    requestId: string,
  ): Promise<void> {
    const event = kind === 'warning' ? 'budget.warning' : 'budget.exceeded';
    await this.ctx.webhooks
      .emit({
        event,
        organizationId: tenant.organization.id,
        occurredAt: new Date(this.ctx.clock.now()).toISOString(),
        data: {
          kind,
          requestId,
          budgetId: state.budget.id,
          scope: state.budget.scope,
          period: state.budget.period,
          limit: state.budget.limit,
          spent: state.spent,
          utilization: state.utilization,
          currency: state.budget.currency,
          action: state.budget.action,
        },
      })
      .catch(() => undefined);
  }
}

interface CacheHit {
  status: 'exact_hit' | 'semantic_hit';
  entry: CachedCompletion;
  similarity?: number;
}

interface ExecutionArgs {
  requestId: string;
  trace: TraceBuilder;
  headers: Record<string, string>;
  tenant: TenantContext;
  input: ChatPipelineInput;
  request: ChatRequest;
  plan: RoutePlan;
  retry: RetryPolicy;
  cacheDecision: CacheDecision;
  cachePolicy: CachePolicy;
  strategy: RoutingStrategy;
  estimatedInput: number;
}

/**
 * The request as the capability check should see it.
 *
 * Policy clamping can lower `max_tokens` but never changes which capabilities a
 * request needs, so the original request is the right input here.
 */
function effectiveRequestCapabilityProbe(request: ChatRequest): ChatRequest {
  return request;
}

function describeRule(rule: { unit: string; window: string; limit: number; subject: string } | undefined): string {
  if (!rule) return 'limit exceeded';
  return `${rule.limit} ${rule.unit} per ${rule.window} per ${rule.subject.replace('_', ' ')}`;
}

function textOf(response: ChatResponse): string {
  const content = response.choices[0]?.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return '';
}

/** Strip gateway-only fields so forwarded chunks stay byte-compatible with OpenAI's. */
function stripGatewayFields(chunk: ChatChunk): ChatChunk {
  return chunk;
}

function chunkFrame(
  id: string,
  model: string,
  delta: ChatChunk['choices'][number]['delta'],
  finish: ChatChunk['choices'][number]['finish_reason'],
): ChatChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function synthesizeResponse(id: string, model: string, text: string, usage: MeasuredUsage): ChatResponse {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage,
  };
}

function circuitGauge(state: string): number {
  return state === 'OPEN' ? 2 : state === 'HALF_OPEN' ? 1 : 0;
}
