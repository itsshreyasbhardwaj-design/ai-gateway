import {
  GatewayError,
  estimatePromptTokens,
  hasScope,
  type ApiKeyScope,
  type AuthContext,
  type ChatRequest,
} from '@ai-gateway/core';
import type { RoutingPolicyDocument } from './schema.js';

export interface PolicySubject {
  auth: AuthContext;
  /** Org-level allowlist. `null` means every registered model. */
  organizationAllowedModels?: string[] | null;
  organizationDeniedModels?: string[];
  /** Project-level allowlist, which narrows the org one when present. */
  projectAllowedModels?: string[] | null;
  projectDeniedModels?: string[];
  policy: RoutingPolicyDocument;
  /** Every model registered on this gateway. */
  registeredModels: string[];
  requestBytes?: number;
}

export interface PolicyDecision {
  /** Models this request is permitted to route to, in policy order. */
  permittedModels: string[];
  /** Effective request after policy clamping (e.g. max_tokens lowered). */
  request: ChatRequest;
  /** Every adjustment made, surfaced on the trace so nothing is silent. */
  adjustments: string[];
  timeoutMs: number;
}

/**
 * Pre-execution policy evaluation.
 *
 * Everything here runs before a single token is sent upstream: scope checks,
 * allow/deny lists, streaming and tool permissions, and output-size clamping.
 * A request that a policy would reject must never reach a provider, because by
 * then it has already cost money.
 */
export function evaluatePolicy(subject: PolicySubject, request: ChatRequest): PolicyDecision {
  const adjustments: string[] = [];
  const { policy } = subject;

  requireScope(subject.auth, 'inference.create');

  if (request.stream && !policy.limits.allowStreaming) {
    throw new GatewayError('policy_violation', 'Streaming is disabled for this project by policy.');
  }

  if ((request.tools?.length || request.tool_choice) && !policy.limits.allowTools) {
    throw new GatewayError('policy_violation', 'Tool use is disabled for this project by policy.');
  }

  if (policy.limits.maxRequestBytes && subject.requestBytes && subject.requestBytes > policy.limits.maxRequestBytes) {
    throw new GatewayError(
      'payload_too_large',
      `Request body is ${subject.requestBytes} bytes, above the configured limit of ${policy.limits.maxRequestBytes}.`,
    );
  }

  if (policy.limits.maxInputTokens) {
    const estimated = estimatePromptTokens(request.messages);
    if (estimated > policy.limits.maxInputTokens) {
      throw new GatewayError(
        'policy_violation',
        `Estimated prompt size (~${estimated} tokens) exceeds the configured limit of ${policy.limits.maxInputTokens}.`,
        { details: { estimatedInputTokens: estimated, limit: policy.limits.maxInputTokens, estimateIsApproximate: true } },
      );
    }
  }

  let effective = request;
  const requestedMax = request.max_completion_tokens ?? request.max_tokens;
  if (policy.limits.maxOutputTokens !== undefined) {
    if (requestedMax === undefined) {
      effective = { ...effective, max_tokens: policy.limits.maxOutputTokens };
      adjustments.push(`max_tokens defaulted to the policy ceiling of ${policy.limits.maxOutputTokens}`);
    } else if (requestedMax > policy.limits.maxOutputTokens) {
      effective = { ...effective, max_tokens: policy.limits.maxOutputTokens, max_completion_tokens: undefined };
      adjustments.push(
        `max_tokens lowered from ${requestedMax} to the policy ceiling of ${policy.limits.maxOutputTokens}`,
      );
    }
  }

  const timeoutMs = Math.min(request.gateway?.timeoutMs ?? policy.limits.timeoutMs, policy.limits.timeoutMs);
  if (request.gateway?.timeoutMs && request.gateway.timeoutMs > policy.limits.timeoutMs) {
    adjustments.push(`timeout clamped from ${request.gateway.timeoutMs}ms to the policy limit of ${policy.limits.timeoutMs}ms`);
  }

  return {
    permittedModels: permittedModels(subject),
    request: effective,
    adjustments,
    timeoutMs,
  };
}

/**
 * Resolve the effective model allowlist.
 *
 * Deny always beats allow, and the narrowest scope wins: a project cannot grant
 * itself a model the organization has denied.
 */
export function permittedModels(subject: PolicySubject): string[] {
  const denied = new Set([
    ...(subject.organizationDeniedModels ?? []),
    ...(subject.projectDeniedModels ?? []),
    ...(subject.policy.models?.deny ?? []),
  ]);

  const allowLists = [
    subject.organizationAllowedModels,
    subject.projectAllowedModels,
    subject.policy.models?.allow ?? null,
  ].filter((list): list is string[] => Array.isArray(list));

  let permitted = subject.registeredModels;
  for (const list of allowLists) {
    const allowed = new Set(list);
    permitted = permitted.filter((m) => allowed.has(m));
  }
  return permitted.filter((m) => !denied.has(m));
}

/** Check a model against the allowlist, producing the spec's 403 MODEL_NOT_ALLOWED. */
export function assertModelAllowed(model: string, permitted: string[], registered: string[]): void {
  if (permitted.includes(model)) return;
  if (registered.includes(model)) {
    throw new GatewayError(
      'model_not_allowed',
      `Model "${model}" is not permitted for this project.`,
      { model, details: { code: 'MODEL_NOT_ALLOWED' } },
    );
  }
  throw new GatewayError('model_not_found', `Model "${model}" is not registered on this gateway.`, { model });
}

export function requireScope(auth: Pick<AuthContext, 'scopes'>, scope: ApiKeyScope): void {
  if (hasScope(auth, scope)) return;
  throw new GatewayError(
    'permission_denied',
    `This API key is missing the "${scope}" scope.`,
    { details: { requiredScope: scope, grantedScopes: auth.scopes } },
  );
}
