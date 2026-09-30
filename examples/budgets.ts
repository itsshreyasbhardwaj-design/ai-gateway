/**
 * Budgets, demonstrated.
 *
 * Sets a deliberately tiny budget, watches the gateway refuse a request before
 * it reaches a provider, then removes it.
 *
 *   AI_GATEWAY_API_KEY=aigw_... node --import tsx examples/budgets.ts
 */
import { AIGateway, AIGatewayError } from '@ai-gateway/sdk';

const BASE = process.env['AI_GATEWAY_URL'] ?? 'http://localhost:8787';
const KEY = process.env['AI_GATEWAY_API_KEY'];

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('set AI_GATEWAY_API_KEY');
  const client = AIGateway.fromEnv();

  console.log('1. Create a monthly budget far below one request.');
  const budget = await api<{ id: string }>('POST', '/api/v1/budgets', {
    scope: 'organization',
    period: 'monthly',
    limit: 0.0000001,
    currency: 'USD',
    action: 'BLOCK',
  });

  console.log('2. Send a request. It is refused before any provider is contacted.');
  try {
    await client.chat.completions.create({
      model: 'gateway/auto',
      messages: [{ role: 'user', content: 'This should not reach a model.' }],
    });
    console.log('   unexpectedly succeeded — is another budget shadowing this one?');
  } catch (err) {
    if (AIGatewayError.isAIGatewayError(err)) {
      console.log(`   refused: ${err.type} (HTTP ${err.status})`);
      console.log(`   ${err.message}`);
      console.log(`   retryable: ${err.retryable}`);
      console.log(`   detail: ${JSON.stringify(err.details)}`);
    }
  }

  console.log('\n3. No request-level flag can bypass it.');
  for (const attempt of [{ test: true }, { fallback: false }, { cache: 'no-store' as const }]) {
    try {
      await client.chat.completions.create({
        model: 'gateway/auto',
        messages: [{ role: 'user', content: 'bypass attempt' }],
        gateway: attempt,
      });
      console.log(`   ${JSON.stringify(attempt)} -> unexpectedly allowed`);
    } catch (err) {
      const type = AIGatewayError.isAIGatewayError(err) ? err.type : 'unknown';
      console.log(`   ${JSON.stringify(attempt).padEnd(26)} -> ${type}`);
    }
  }

  console.log('\n4. Remove the budget; requests flow again.');
  await api('DELETE', `/api/v1/budgets/${budget.id}`);
  const completion = await client.chat.completions.create({
    model: 'gateway/auto',
    messages: [{ role: 'user', content: 'And now?' }],
  });
  console.log(`   served by ${completion.gateway?.model}`);

  console.log(
    '\nNotes\n' +
      '  · Budgets evaluate on the *projected* cost, before dispatch: 50 spent of\n' +
      '    100 with a request projected at 60 is refused, not discovered after.\n' +
      '  · A BLOCK at any scope wins over a softer action at another.\n' +
      '  · Spend is measured against the configured price table, so budget\n' +
      '    thresholds are exactly as accurate as that table is.',
  );
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
