import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AIGateway, AIGatewayError } from '@ai-gateway/sdk';

export interface McpServerOptions {
  apiKey: string;
  baseUrl?: string;
}

/**
 * MCP server exposing AI Gateway observability.
 *
 * Read-only by design. The tools here answer questions - what models exist, how
 * is a provider doing, what did this request do, what is the routing policy -
 * and nothing more. An agent with this server attached cannot create keys,
 * change routing, publish pricing, or spend money.
 *
 * `simulate_route` is the one tool that computes rather than reads, and it is
 * still side-effect free: it calls the gateway's dry-run endpoint, which
 * contacts no provider.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const gateway = new AIGateway({ apiKey: options.apiKey, baseUrl: options.baseUrl });

  const server = new McpServer({
    name: 'ai-gateway',
    version: '0.1.0',
  });

  const text = (value: unknown) => ({
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  });

  const fail = (err: unknown) => ({
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: AIGatewayError.isAIGatewayError(err)
          ? `${err.type}: ${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`
          : `error: ${(err as Error).message}`,
      },
    ],
  });

  server.tool(
    'list_models',
    'List the models this gateway can route to, with capabilities, context windows and configured pricing.',
    {
      provider: z.string().optional().describe('Filter to one provider id.'),
      capability: z.string().optional().describe('Filter to models with this capability, e.g. "tools" or "vision".'),
    },
    async ({ provider, capability }) => {
      try {
        const list = await gateway.models.list();
        let models = list.data;
        if (provider) models = models.filter((m) => m.gateway.provider === provider);
        if (capability) models = models.filter((m) => m.gateway.capabilities.includes(capability));
        return text({
          models: models.map((m) => ({
            id: m.id,
            provider: m.gateway.provider,
            displayName: m.gateway.displayName,
            contextWindow: m.gateway.contextWindow,
            maxOutputTokens: m.gateway.maxOutputTokens,
            capabilities: m.gateway.capabilities,
            status: m.gateway.status,
            pricing: m.gateway.pricing,
          })),
          virtualModels: list.gateway.virtualModels,
          pricing: {
            version: list.gateway.pricingVersion,
            ageDays: list.gateway.pricingAgeDays,
            note: 'Pricing is operator-configured, not fetched from providers. Verify before relying on cost figures.',
          },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'get_model',
    'Get the full record for one model, including capabilities and configured pricing.',
    { model: z.string().describe('Model id, e.g. "openai/gpt-4o-mini".') },
    async ({ model }) => {
      try {
        return text(await gateway.models.retrieve(model));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'list_providers',
    'List configured providers with the health this gateway has measured from its own traffic.',
    {},
    async () => {
      try {
        const response = await fetch(`${gateway.baseUrl}/health/providers`);
        return text(await response.json());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'get_provider_health',
    'Measured health for one provider: success rate, error rate, latency percentiles and circuit state.',
    { provider: z.string().describe('Provider id, e.g. "openai".') },
    async ({ provider }) => {
      try {
        const response = await fetch(`${gateway.baseUrl}/health/providers`);
        const body = (await response.json()) as { data: Array<{ provider: string }>; note: string };
        const found = body.data.find((p) => p.provider === provider);
        if (!found) return text(`No provider "${provider}" is registered. Known: ${body.data.map((p) => p.provider).join(', ')}`);
        return text({ ...found, note: body.note });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'get_usage',
    'Usage, cost and latency summary over a time range, with per-provider and per-model breakdowns.',
    {
      range: z.enum(['1h', '24h', '7d', '30d', '90d']).default('24h'),
      projectId: z.string().optional(),
      includeTest: z.boolean().default(false).describe('Include playground and replay traffic.'),
    },
    async ({ range, projectId, includeTest }) => {
      try {
        const report = await gateway.usage.retrieve({ range, projectId, includeTest });
        return text({
          range: report.range,
          summary: report.summary,
          breakdown: report.breakdown,
          disclosure: report.disclosure,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'list_requests',
    'List recent gateway requests with status, model, latency and cost.',
    {
      limit: z.number().int().min(1).max(100).default(20),
      status: z.enum(['success', 'error', 'cancelled']).optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      search: z.string().optional(),
      includeTest: z.boolean().default(false),
    },
    async ({ limit, status, provider, model, search, includeTest }) => {
      try {
        return text(
          await gateway.requests.list({
            limit,
            status,
            providerId: provider,
            modelId: model,
            search,
            includeTest: includeTest || undefined,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'get_request',
    'Full trace for one request: every pipeline step, every provider attempt, and why it was routed where it was.',
    { requestId: z.string().describe('Request id, e.g. "req_01J...".') },
    async ({ requestId }) => {
      try {
        const trace = await gateway.requests.retrieve(requestId);
        return text({
          request: trace.request,
          timeline: trace.steps.map((s) => ({
            step: s.name,
            status: s.status,
            durationMs: s.durationMs,
            detail: s.detail,
          })),
          attempts: trace.attempts,
          // Bodies are governed by the org's retention policy; this states
          // plainly whether one exists rather than implying none was ever sent.
          privacy: trace.privacy,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'get_routing_policy',
    'List routing policies and their active versions.',
    {},
    async () => {
      try {
        const response = await fetch(`${gateway.baseUrl}/api/v1/routing-policies`, {
          headers: { authorization: `Bearer ${options.apiKey}` },
        });
        if (!response.ok) return text(`Gateway returned HTTP ${response.status}. The API key may lack the admin scope.`);
        return text(await response.json());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    'simulate_route',
    'Dry-run the router for a hypothetical request. Returns the chain that would be attempted and why each candidate was chosen or excluded. Contacts no provider and costs nothing.',
    {
      model: z.string().default('gateway/auto'),
      prompt: z.string().optional(),
      strategy: z
        .enum(['explicit', 'lowest_cost', 'lowest_latency', 'highest_reliability', 'weighted', 'priority', 'round_robin', 'fallback_chain'])
        .optional(),
      candidates: z.array(z.string()).optional(),
      requireTools: z.boolean().default(false),
      requireVision: z.boolean().default(false),
    },
    async ({ model, prompt, strategy, candidates, requireTools, requireVision }) => {
      try {
        return text(
          await gateway.routing.test({ model, prompt, strategy, candidates, requireTools, requireVision }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
