'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { gatewayFetch, gatewayPublicFetch, GatewayRequestError } from '@/lib/gateway';
import { clearSession, defaultGatewayUrl, setSession } from '@/lib/session';

/**
 * Server actions.
 *
 * Every mutation goes through the gateway's admin API with the operator's key,
 * so the gateway's own authorization and audit logging apply. The dashboard has
 * no privileged path of its own.
 */

export interface ActionResult {
  ok: boolean;
  message?: string;
  /** A secret shown exactly once, e.g. a freshly minted API key. */
  secret?: string;
  data?: Record<string, unknown>;
}

function describe(err: unknown): ActionResult {
  if (err instanceof GatewayRequestError) {
    return { ok: false, message: `${err.type}: ${err.message}` };
  }
  return { ok: false, message: (err as Error).message };
}

// -------------------------------------------------------------- connect

export async function connectGateway(formData: FormData): Promise<ActionResult> {
  const gatewayUrl = String(formData.get('gatewayUrl') ?? '').trim() || defaultGatewayUrl();
  const apiKey = String(formData.get('apiKey') ?? '').trim();

  if (!apiKey) return { ok: false, message: 'An API key is required.' };

  // Verify before storing, so a bad key produces a clear error here rather than
  // a broken dashboard on every subsequent page.
  try {
    await gatewayFetch<{ object: string }>('/v1/models', {
      session: { apiKey, gatewayUrl, source: 'cookie' },
    });
  } catch (err) {
    if (err instanceof GatewayRequestError && err.status === 0) {
      return { ok: false, message: `Could not reach a gateway at ${gatewayUrl}. Is it running?` };
    }
    if (err instanceof GatewayRequestError && err.status === 401) {
      return { ok: false, message: 'The gateway rejected that API key.' };
    }
    return describe(err);
  }

  // Admin screens need the admin scope; warn rather than silently 403 later.
  let adminCapable = true;
  try {
    await gatewayFetch<unknown>('/api/v1/providers', {
      session: { apiKey, gatewayUrl, source: 'cookie' },
    });
  } catch (err) {
    if (err instanceof GatewayRequestError && err.status === 403) adminCapable = false;
  }

  await setSession(apiKey, gatewayUrl);
  redirect(adminCapable ? '/dashboard' : '/dashboard?limitedScope=1');
}

export async function disconnectGateway(): Promise<void> {
  await clearSession();
  redirect('/connect');
}

export async function probeGateway(gatewayUrl: string): Promise<ActionResult> {
  try {
    const info = await gatewayPublicFetch<Record<string, unknown>>(gatewayUrl, '/');
    return { ok: true, data: info };
  } catch (err) {
    return describe(err);
  }
}

// ------------------------------------------------------------- api keys

export async function createApiKey(formData: FormData): Promise<ActionResult> {
  try {
    const scopes = formData.getAll('scopes').map(String);
    const result = await gatewayFetch<{ secret: string; prefix: string; id: string }>(
      '/api/v1/api-keys',
      {
        method: 'POST',
        body: {
          name: String(formData.get('name') ?? ''),
          projectId: String(formData.get('projectId') ?? ''),
          scopes: scopes.length ? scopes : ['inference.create', 'models.read'],
          environment: String(formData.get('environment') ?? 'live'),
          ...(formData.get('expiresAt')
            ? { expiresAt: new Date(String(formData.get('expiresAt'))).toISOString() }
            : {}),
        },
      },
    );
    revalidatePath('/api-keys');
    return {
      ok: true,
      secret: result.secret,
      message: 'Key created. This is the only time the full secret is shown.',
    };
  } catch (err) {
    return describe(err);
  }
}

export async function revokeApiKey(id: string): Promise<ActionResult> {
  try {
    await gatewayFetch(`/api/v1/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    revalidatePath('/api-keys');
    return { ok: true, message: 'Key revoked.' };
  } catch (err) {
    return describe(err);
  }
}

export async function rotateApiKey(id: string): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<{ secret: string; id: string }>(
      `/api/v1/api-keys/${encodeURIComponent(id)}/rotate`,
      { method: 'POST' },
    );
    revalidatePath('/api-keys');
    return {
      ok: true,
      secret: result.secret,
      message: 'Rotated. The previous key was revoked immediately.',
    };
  } catch (err) {
    return describe(err);
  }
}

// ------------------------------------------------------------- projects

export async function createProject(formData: FormData): Promise<ActionResult> {
  try {
    await gatewayFetch('/api/v1/projects', {
      method: 'POST',
      body: {
        name: String(formData.get('name') ?? ''),
        slug: String(formData.get('slug') ?? ''),
      },
    });
    revalidatePath('/projects');
    return { ok: true, message: 'Project created.' };
  } catch (err) {
    return describe(err);
  }
}

export async function updateProjectModels(formData: FormData): Promise<ActionResult> {
  try {
    const raw = String(formData.get('allowedModels') ?? '').trim();
    const allowedModels = raw ? raw.split(/[\s,]+/).filter(Boolean) : null;
    await gatewayFetch(
      `/api/v1/projects/${encodeURIComponent(String(formData.get('projectId')))}`,
      {
        method: 'PATCH',
        body: { allowedModels },
      },
    );
    revalidatePath('/projects');
    return {
      ok: true,
      message: allowedModels
        ? `Allowlist set to ${allowedModels.length} model(s).`
        : 'Allowlist cleared; every registered model is permitted.',
    };
  } catch (err) {
    return describe(err);
  }
}

// -------------------------------------------------------------- budgets

export async function createBudget(formData: FormData): Promise<ActionResult> {
  try {
    const scope = String(formData.get('scope') ?? 'organization');
    const scopeId = String(formData.get('scopeId') ?? '').trim();
    await gatewayFetch('/api/v1/budgets', {
      method: 'POST',
      body: {
        scope,
        ...(scope !== 'organization' && scopeId ? { scopeId } : {}),
        period: String(formData.get('period') ?? 'monthly'),
        limit: Number(formData.get('limit') ?? 0),
        currency: String(formData.get('currency') ?? 'USD'),
        action: String(formData.get('action') ?? 'BLOCK'),
        ...(formData.get('warnThreshold')
          ? { warnThreshold: Number(formData.get('warnThreshold')) / 100 }
          : {}),
      },
    });
    revalidatePath('/budgets');
    return { ok: true, message: 'Budget created.' };
  } catch (err) {
    return describe(err);
  }
}

export async function deleteBudget(id: string): Promise<ActionResult> {
  try {
    await gatewayFetch(`/api/v1/budgets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    revalidatePath('/budgets');
    return { ok: true, message: 'Budget deleted.' };
  } catch (err) {
    return describe(err);
  }
}

// ------------------------------------------------------------- providers

export async function createProvider(formData: FormData): Promise<ActionResult> {
  try {
    const modelsRaw = String(formData.get('models') ?? '').trim();
    const models = modelsRaw
      ? modelsRaw
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((providerModelId) => ({
            providerModelId,
            contextWindow: Number(formData.get('contextWindow') ?? 8192),
            capabilities: ['chat', 'streaming'] as const,
          }))
      : undefined;

    const result = await gatewayFetch<{ registered: boolean; registrationError?: string }>(
      '/api/v1/providers',
      {
        method: 'POST',
        body: {
          id: String(formData.get('id') ?? ''),
          kind: String(formData.get('kind') ?? 'openai-compatible'),
          displayName: String(formData.get('displayName') ?? ''),
          ...(formData.get('baseUrl') ? { baseUrl: String(formData.get('baseUrl')) } : {}),
          ...(formData.get('credentialValue')
            ? { credentialValue: String(formData.get('credentialValue')) }
            : {}),
          ...(models ? { models } : {}),
        },
      },
    );
    revalidatePath('/providers');
    revalidatePath('/models');
    return {
      ok: true,
      message: result.registered
        ? 'Provider registered and available for routing.'
        : `Provider saved but not registered: ${result.registrationError ?? 'unknown reason'}`,
    };
  } catch (err) {
    return describe(err);
  }
}

export async function deleteProvider(id: string): Promise<ActionResult> {
  try {
    await gatewayFetch(`/api/v1/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    revalidatePath('/providers');
    revalidatePath('/models');
    return { ok: true, message: 'Provider removed.' };
  } catch (err) {
    return describe(err);
  }
}

export async function probeProvider(id: string): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<{
      probe: { state: string; latencyMs?: number; message?: string };
    }>(`/api/v1/providers/${encodeURIComponent(id)}/health`, { method: 'POST' });
    revalidatePath('/providers');
    return {
      ok: true,
      message: `Probe: ${result.probe.state}${result.probe.latencyMs !== undefined ? ` in ${result.probe.latencyMs}ms` : ''}${result.probe.message ? ` — ${result.probe.message}` : ''}`,
    };
  } catch (err) {
    return describe(err);
  }
}

// -------------------------------------------------------------- routing

export async function validatePolicy(document: string): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<{
      valid: boolean;
      errors?: Array<{ path: string; message: string }>;
      warnings?: Array<{ path: string; message: string }>;
      checksum?: string;
    }>('/api/v1/routing-policies/validate', { method: 'POST', body: { document } });
    return { ok: result.valid, data: result as unknown as Record<string, unknown> };
  } catch (err) {
    return describe(err);
  }
}

export async function createPolicy(formData: FormData): Promise<ActionResult> {
  try {
    await gatewayFetch('/api/v1/routing-policies', {
      method: 'POST',
      body: {
        name: String(formData.get('name') ?? ''),
        document: String(formData.get('document') ?? ''),
        ...(formData.get('projectId') ? { projectId: String(formData.get('projectId')) } : {}),
        ...(formData.get('note') ? { note: String(formData.get('note')) } : {}),
      },
    });
    revalidatePath('/routing');
    return { ok: true, message: 'Policy created at version 1 and activated.' };
  } catch (err) {
    return describe(err);
  }
}

/** Publish a new version without activating it: editing is not deploying. */
export async function publishPolicyVersion(
  policyId: string,
  document: string,
  note: string,
): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<{ version: { version: number } }>(
      `/api/v1/routing-policies/${encodeURIComponent(policyId)}/versions`,
      { method: 'POST', body: { document, note } },
    );
    revalidatePath('/routing');
    return {
      ok: true,
      message: `Published version ${result.version.version}. It is not live until you activate it.`,
    };
  } catch (err) {
    return describe(err);
  }
}

export async function activatePolicyVersion(
  policyId: string,
  version: number,
): Promise<ActionResult> {
  try {
    await gatewayFetch(`/api/v1/routing-policies/${encodeURIComponent(policyId)}/activate`, {
      method: 'POST',
      body: { version },
    });
    revalidatePath('/routing');
    return { ok: true, message: `Version ${version} is now serving production traffic.` };
  } catch (err) {
    return describe(err);
  }
}

// ------------------------------------------------------------- webhooks

export async function createWebhook(formData: FormData): Promise<ActionResult> {
  try {
    const events = formData.getAll('events').map(String);
    const result = await gatewayFetch<{ secret: string }>('/api/v1/webhooks', {
      method: 'POST',
      body: {
        url: String(formData.get('url') ?? ''),
        events: events.length ? events : ['budget.exceeded'],
      },
    });
    revalidatePath('/webhooks');
    return {
      ok: true,
      secret: result.secret,
      message: 'Webhook created. Store the signing secret now; it is shown only once.',
    };
  } catch (err) {
    return describe(err);
  }
}

export async function deleteWebhook(id: string): Promise<ActionResult> {
  try {
    await gatewayFetch(`/api/v1/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    revalidatePath('/webhooks');
    return { ok: true, message: 'Webhook deleted.' };
  } catch (err) {
    return describe(err);
  }
}

// --------------------------------------------------------------- alerts

export async function createAlert(formData: FormData): Promise<ActionResult> {
  try {
    const metric = String(formData.get('metric') ?? 'error_rate');
    const raw = Number(formData.get('threshold') ?? 0);
    // Rate metrics are entered as percentages and stored as fractions.
    const threshold = metric === 'error_rate' || metric === 'fallback_rate' ? raw / 100 : raw;
    await gatewayFetch('/api/v1/alerts', {
      method: 'POST',
      body: {
        name: String(formData.get('name') ?? ''),
        metric,
        comparator: String(formData.get('comparator') ?? 'gt'),
        threshold,
        forMinutes: Number(formData.get('forMinutes') ?? 5),
        cooldownMinutes: Number(formData.get('cooldownMinutes') ?? 30),
      },
    });
    revalidatePath('/alerts');
    return { ok: true, message: 'Alert rule created.' };
  } catch (err) {
    return describe(err);
  }
}

// ----------------------------------------------------------- playground

export async function runRouteTest(formData: FormData): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<Record<string, unknown>>('/api/v1/playground/route-test', {
      method: 'POST',
      body: {
        model: String(formData.get('model') ?? 'gateway/auto'),
        prompt: String(formData.get('prompt') ?? ''),
        ...(formData.get('strategy') ? { strategy: String(formData.get('strategy')) } : {}),
        requireTools: formData.get('requireTools') === 'on',
        requireVision: formData.get('requireVision') === 'on',
        stream: formData.get('stream') === 'on',
      },
    });
    return { ok: true, data: result };
  } catch (err) {
    return describe(err);
  }
}

export async function runPlaygroundRequest(formData: FormData): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<Record<string, unknown>>('/api/v1/playground/run', {
      method: 'POST',
      body: {
        model: String(formData.get('model') ?? 'gateway/auto'),
        messages: [{ role: 'user', content: String(formData.get('prompt') ?? '') }],
        ...(formData.get('temperature')
          ? { temperature: Number(formData.get('temperature')) }
          : {}),
        ...(formData.get('maxTokens') ? { max_tokens: Number(formData.get('maxTokens')) } : {}),
        ...(formData.get('strategy')
          ? { gateway: { strategy: String(formData.get('strategy')) } }
          : {}),
      },
    });
    revalidatePath('/requests');
    return { ok: true, data: result };
  } catch (err) {
    return describe(err);
  }
}

export async function simulateProviderFailure(formData: FormData): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<{ note: string }>('/api/v1/playground/simulate-failure', {
      method: 'POST',
      body: {
        model: String(formData.get('model') ?? ''),
        failureMode: String(formData.get('failureMode') ?? 'none'),
        ...(formData.get('failFirstN') ? { failFirstN: Number(formData.get('failFirstN')) } : {}),
      },
    });
    return { ok: true, message: result.note };
  } catch (err) {
    return describe(err);
  }
}

export async function resetCircuits(): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<{ reset: number }>('/api/v1/playground/reset-circuits', {
      method: 'POST',
    });
    revalidatePath('/providers');
    revalidatePath('/models');
    return { ok: true, message: `Reset ${result.reset} circuit breaker(s).` };
  } catch (err) {
    return describe(err);
  }
}

/** Replay is always an explicit, confirmed action - never implicit. */
export async function replayRequest(requestId: string): Promise<ActionResult> {
  try {
    const result = await gatewayFetch<{ note: string }>(
      `/api/v1/requests/${encodeURIComponent(requestId)}/replay`,
      { method: 'POST', body: { confirm: true } },
    );
    revalidatePath('/requests');
    return { ok: true, message: result.note };
  } catch (err) {
    return describe(err);
  }
}
