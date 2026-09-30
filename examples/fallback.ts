/**
 * Fallback, demonstrated rather than described.
 *
 * Induces a real failure on the synthetic mock provider, sends a request
 * through it, and reads back the trace showing the retries and the failover.
 *
 *   AI_GATEWAY_API_KEY=aigw_... node --import tsx examples/fallback.ts
 *
 * Requires the mock provider (ENABLE_MOCK_PROVIDER=true, the default outside
 * production). Real providers cannot be made to fail from the API.
 */
import { AIGateway } from '@ai-gateway/sdk';

const BASE = process.env['AI_GATEWAY_URL'] ?? 'http://localhost:8787';
const KEY = process.env['AI_GATEWAY_API_KEY'];

async function admin(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('set AI_GATEWAY_API_KEY');
  const client = AIGateway.fromEnv();

  console.log('1. Make the primary model fail with a 500.');
  await admin('/api/v1/playground/simulate-failure', {
    model: 'mock/mock-flaky',
    failureMode: 'server_error',
  });

  console.log('2. Send a request whose chain starts with the failing model.');
  const completion = await client.chat.completions.create({
    model: 'gateway/auto',
    messages: [{ role: 'user', content: 'Survive a provider outage.' }],
    gateway: { models: ['mock/mock-flaky', 'mock/mock-fast'] },
  });

  const receipt = completion.gateway!;
  console.log(`   succeeded, served by ${receipt.model}`);
  console.log(`   ${receipt.attempts} attempt(s), fallback used: ${receipt.fallbackUsed}`);

  console.log('\n3. The failure is in the trace, not swallowed.');
  const trace = await client.requests.retrieve(receipt.requestId);
  for (const attempt of trace.attempts) {
    const outcome = attempt.status === 'success' ? 'success' : (attempt.errorType ?? 'error');
    const backoff = attempt.backoffMs ? `, waited ${attempt.backoffMs}ms first` : '';
    console.log(
      `   attempt ${attempt.attemptNumber}: ${attempt.modelId} -> ${outcome} (${attempt.durationMs}ms${backoff})`,
    );
  }

  console.log('\n4. Let the provider recover.');
  await admin('/api/v1/playground/simulate-failure', {
    model: 'mock/mock-flaky',
    failureMode: 'none',
  });

  const recovered = await client.chat.completions.create({
    model: 'gateway/auto',
    messages: [{ role: 'user', content: 'And now?' }],
    gateway: { models: ['mock/mock-flaky', 'mock/mock-fast'] },
  });
  console.log(
    `   served by ${recovered.gateway?.model} in ${recovered.gateway?.attempts} attempt(s)`,
  );

  console.log(
    '\nNote: a single failure never removes a provider from rotation. Tripping a\n' +
      'circuit needs either a run of consecutive failures or a sustained failure\n' +
      'rate over a minimum call volume.',
  );
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
