/**
 * The first-party TypeScript SDK.
 *
 *   pnpm --filter @ai-gateway/examples exec tsx examples/typescript-sdk.ts
 *   # or, from the repo root:
 *   AI_GATEWAY_API_KEY=aigw_... node --import tsx examples/typescript-sdk.ts
 */
import { AIGateway, AIGatewayError } from '@ai-gateway/sdk';

const client = AIGateway.fromEnv();

async function main(): Promise<void> {
  // ── what this key can reach ───────────────────────────────────────────
  const models = await client.models.list();
  console.log(`${models.data.length} model(s) available:`);
  for (const model of models.data) {
    const price = model.gateway.pricing;
    console.log(
      `  ${model.id.padEnd(34)} ${String(model.gateway.contextWindow).padStart(9)} ctx  ` +
        (price ? `$${price.inputPerMillionTokens}/M in` : 'unpriced'),
    );
  }
  if (models.gateway.pricingAgeDays > 30) {
    console.warn(
      `\n  note: the price table "${models.gateway.pricingVersion}" was last verified ` +
        `${models.gateway.pricingAgeDays} days ago. Cost figures are only as current as it is.`,
    );
  }

  // ── a completion, with the routing decision attached ──────────────────
  console.log('\n── completion ──');
  const completion = await client.chat.completions.create({
    model: 'gateway/auto',
    messages: [{ role: 'user', content: 'Name three columnar storage formats.' }],
  });

  console.log(completion.choices[0]?.message.content);
  const receipt = completion.gateway;
  if (receipt) {
    console.log(`\n  routed to ${receipt.provider}/${receipt.model} via ${receipt.strategy}`);
    for (const reason of receipt.reasons) console.log(`    · ${reason}`);
    if (receipt.estimatedCost) {
      console.log(
        `  estimated cost ${receipt.estimatedCost.amount.toFixed(6)} ${receipt.estimatedCost.currency}` +
          ` (price table ${receipt.estimatedCost.pricingVersion})`,
      );
    }
    if (completion.usage?.source === 'estimated') {
      console.log(
        '  note: token counts were estimated by the gateway, not reported by the provider',
      );
    }
  }

  // ── streaming ─────────────────────────────────────────────────────────
  console.log('\n── streaming ──');
  const stream = await client.chat.completions.stream({
    model: 'gateway/auto',
    messages: [{ role: 'user', content: 'Count from one to five.' }],
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta.content ?? '');
  }
  console.log(`\n\n  ${stream.receipt?.attempts} attempt(s), ${stream.receipt?.latencyMs}ms`);

  // ── controlling the route ─────────────────────────────────────────────
  console.log('\n── explicit candidates, cheapest first ──');
  const cheap = await client.chat.completions.create({
    model: 'gateway/cheapest',
    messages: [{ role: 'user', content: 'Reply with one word.' }],
    gateway: {
      strategy: 'lowest_cost',
      // Restrict this one request to a known-good pair.
      models: models.data.slice(0, 2).map((m) => m.id),
      // Opt this request out of the cache entirely, whatever the policy says.
      cache: 'no-store',
      tags: ['example', 'cheapest'],
    },
  });
  console.log(`  served by ${cheap.gateway?.model}`);

  // ── a dry-run: no provider is contacted, nothing is billed ────────────
  console.log('\n── routing dry-run ──');
  const plan = await client.routing.test({
    model: 'gateway/auto',
    prompt: 'Explain this SQL query.',
  });
  console.log(`  would select ${plan.selected?.model} (score ${plan.selected?.score})`);
  for (const entry of plan.chain.slice(1))
    console.log(`  fallback ${entry.position}: ${entry.model}`);
  for (const rejection of plan.rejected)
    console.log(`  excluded ${rejection.target}: ${rejection.reason}`);

  // ── the full trace for a request you already made ─────────────────────
  if (receipt) {
    console.log('\n── trace ──');
    const trace = await client.requests.retrieve(receipt.requestId);
    for (const step of trace.steps) {
      console.log(`  ${step.status.padEnd(8)} ${step.name.padEnd(20)} ${step.durationMs}ms`);
    }
  }

  // ── errors carry everything needed to act on them ─────────────────────
  console.log('\n── error handling ──');
  try {
    await client.chat.completions.create({
      model: 'nonexistent/model',
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (err) {
    if (AIGatewayError.isAIGatewayError(err)) {
      console.log(`  ${err.type} (HTTP ${err.status}) retryable=${err.retryable}`);
      console.log(`  ${err.message}`);
      console.log(`  request ${err.requestId}`);
    }
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
