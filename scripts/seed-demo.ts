/**
 * Generate demo request history.
 *
 *   pnpm seed:demo                       # against http://localhost:8787
 *   AI_GATEWAY_URL=… AI_GATEWAY_API_KEY=… pnpm seed:demo
 *
 * Every request it sends is real: it goes through the actual pipeline, is
 * really routed, and is really recorded. What makes it demo data is that it is
 * flagged `test` and tagged `demo`, so it is excluded from production analytics
 * and visibly labelled in the dashboard. Nothing is written directly into the
 * analytics tables, because fabricated rows are exactly the corruption the
 * project set out to avoid.
 */

const BASE_URL = process.env['AI_GATEWAY_URL'] ?? 'http://localhost:8787';
const API_KEY = process.env['AI_GATEWAY_API_KEY'] ?? process.env['DEMO_API_KEY'];

const PROMPTS = [
  'Summarize the tradeoffs between optimistic and pessimistic locking.',
  'Explain this SQL query and suggest an index.',
  'Write a regex that matches an ISO 8601 timestamp.',
  'What is the difference between a p95 and a p99 latency?',
  'Draft a short changelog entry for a bug fix.',
  'Explain backpressure in a streaming system.',
  'When would you choose a circuit breaker over a retry?',
  'Describe the tradeoffs of semantic caching for LLM responses.',
];

interface Options {
  count: number;
  streamShare: number;
  failureShare: number;
}

async function main(): Promise<void> {
  if (!API_KEY) {
    process.stderr.write(
      'No API key. Set AI_GATEWAY_API_KEY to a key with the inference.create and admin scopes.\n' +
        'The gateway prints a bootstrap key once on first boot.\n',
    );
    process.exit(78);
  }

  const options: Options = {
    count: Number(process.env['DEMO_REQUESTS'] ?? 60),
    streamShare: 0.3,
    failureShare: 0.12,
  };

  const info = await getJson<{ providers: string[]; models: number }>('/');
  process.stdout.write(
    `Gateway at ${BASE_URL}: ${info.providers.join(', ') || 'no providers'}, ${info.models} model(s)\n`,
  );

  const models = await getJson<{
    data: Array<{ id: string; gateway: { capabilities: string[] } }>;
  }>('/v1/models', API_KEY);
  const chatModels = models.data
    .filter((m) => m.gateway.capabilities.includes('chat'))
    .map((m) => m.id);
  if (chatModels.length === 0) {
    process.stderr.write(
      'No chat-capable models are registered. Set a provider key or ENABLE_MOCK_PROVIDER=true.\n',
    );
    process.exit(1);
  }

  const mockModels = chatModels.filter((id) => id.startsWith('mock/'));
  const flaky = mockModels.find((id) => id.includes('flaky'));

  let ok = 0;
  let failed = 0;
  let streamed = 0;

  for (let i = 0; i < options.count; i++) {
    const prompt = PROMPTS[i % PROMPTS.length]!;
    const stream = Math.random() < options.streamShare;
    // Steer a slice of traffic at the flaky mock model so the demo history
    // contains genuine retries and fallbacks rather than invented ones.
    const wantFailure = flaky !== undefined && Math.random() < options.failureShare;
    const model = wantFailure ? flaky : pick(chatModels);

    const body = {
      model,
      messages: [{ role: 'user', content: `${prompt} (demo ${i + 1})` }],
      ...(stream ? { stream: true } : {}),
      gateway: { test: true, tags: ['demo'] },
    };

    try {
      const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (stream) {
        // Drain it: an abandoned stream is recorded as a client disconnect.
        await response.text();
        streamed++;
      } else {
        await response.json();
      }
      if (response.ok) ok++;
      else failed++;
    } catch (err) {
      failed++;
      process.stderr.write(`  request ${i + 1} failed: ${(err as Error).message}\n`);
    }

    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${options.count}\n`);
    // Spread the traffic over time so the time-series charts have shape.
    await sleep(40 + Math.random() * 120);
  }

  process.stdout.write(
    `\nSeeded ${options.count} demo requests: ${ok} succeeded, ${failed} failed, ${streamed} streamed.\n` +
      `All of them are flagged as test traffic, so production analytics are unchanged.\n` +
      `View them at /requests with "Include test traffic" enabled.\n`,
  );
}

function pick<T>(values: T[]): T {
  return values[Math.floor(Math.random() * values.length)]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(path: string, key?: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  }).catch((err: Error) => {
    process.stderr.write(
      `Could not reach the gateway at ${BASE_URL}: ${err.message}\nIs it running? Try: pnpm dev\n`,
    );
    process.exit(1);
  });
  if (!response.ok) {
    process.stderr.write(`Gateway returned HTTP ${response.status} for ${path}.\n`);
    process.exit(1);
  }
  return (await response.json()) as T;
}

void main();
