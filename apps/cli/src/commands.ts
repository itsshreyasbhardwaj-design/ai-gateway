import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { AIGateway, AIGatewayError, type ModelInfo } from '@ai-gateway/sdk';
import { parsePolicy } from '@ai-gateway/policies';
import { readConfig, resolveCredentials, writeConfig, configPath } from './config.js';
import {
  bold, cyan, dim, errOut, formatCost, formatDuration, green, healthBadge, json, out, red,
  statusBadge, table, yellow,
} from './output.js';

export interface CommandContext {
  args: string[];
  flags: Record<string, string | boolean>;
}

function client(flags: Record<string, string | boolean>): AIGateway {
  const creds = resolveCredentials(typeof flags['profile'] === 'string' ? flags['profile'] : undefined);
  const baseUrl = typeof flags['url'] === 'string' ? flags['url'] : creds.baseUrl;
  return new AIGateway({ apiKey: creds.apiKey, baseUrl });
}

const asJson = (flags: Record<string, string | boolean>) => flags['json'] === true;

// --------------------------------------------------------------- login

export async function login(ctx: CommandContext): Promise<number> {
  const urlFlag = typeof ctx.flags['url'] === 'string' ? ctx.flags['url'] : undefined;
  const keyFlag = typeof ctx.flags['key'] === 'string' ? ctx.flags['key'] : undefined;
  const profileName = typeof ctx.flags['profile'] === 'string' ? ctx.flags['profile'] : 'default';

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answered = urlFlag ?? (await rl.question('Gateway URL [http://localhost:8787]: '));
    const baseUrl = answered.trim() || 'http://localhost:8787';
    // Read the key from a flag, the environment, or a prompt. It is never
    // echoed back and never printed after storage.
    const apiKey = keyFlag ?? process.env['AI_GATEWAY_API_KEY'] ?? (await rl.question('API key: '));
    if (!apiKey.trim()) {
      errOut(red('No API key provided.'));
      return 1;
    }

    const probe = new AIGateway({ apiKey: apiKey.trim(), baseUrl: baseUrl.trim() });
    const models = await probe.models.list();

    const config = readConfig();
    config.profiles[profileName] = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() };
    config.current = profileName;
    const path = writeConfig(config);

    out('');
    out(`${green('Authenticated.')} ${models.data.length} model(s) available.`);
    out(dim(`Credentials stored with 0600 permissions at ${path}`));
    out(dim(`Profile: ${profileName}`));
    return 0;
  } finally {
    rl.close();
  }
}

export async function whoami(ctx: CommandContext): Promise<number> {
  const creds = resolveCredentials(typeof ctx.flags['profile'] === 'string' ? ctx.flags['profile'] : undefined);
  const gateway = client(ctx.flags);
  const models = await gateway.models.list();
  if (asJson(ctx.flags)) {
    json({ baseUrl: creds.baseUrl, source: creds.source, profile: creds.profile, models: models.data.length });
    return 0;
  }
  out('');
  out(`${bold('gateway')}   ${creds.baseUrl}`);
  out(`${bold('source')}    ${creds.source}${creds.profile ? ` (profile "${creds.profile}")` : ''}`);
  out(`${bold('models')}    ${models.data.length} available`);
  out(`${bold('pricing')}   ${models.gateway.pricingVersion} ${dim(`(${models.gateway.pricingAgeDays}d old)`)}`);
  out('');
  return 0;
}

export async function logout(ctx: CommandContext): Promise<number> {
  const profileName = typeof ctx.flags['profile'] === 'string' ? ctx.flags['profile'] : 'default';
  const config = readConfig();
  if (!config.profiles[profileName]) {
    errOut(`No profile named "${profileName}".`);
    return 1;
  }
  delete config.profiles[profileName];
  writeConfig(config);
  out(`Removed profile "${profileName}" from ${configPath()}.`);
  return 0;
}

// -------------------------------------------------------------- models

export async function modelsList(ctx: CommandContext): Promise<number> {
  const gateway = client(ctx.flags);
  const list = await gateway.models.list();
  let models = list.data;

  const provider = ctx.flags['provider'];
  if (typeof provider === 'string') models = models.filter((m) => m.gateway.provider === provider);
  const capability = ctx.flags['capability'];
  if (typeof capability === 'string') models = models.filter((m) => m.gateway.capabilities.includes(capability));

  if (asJson(ctx.flags)) {
    json(models);
    return 0;
  }

  out('');
  out(
    table<ModelInfo>(models, [
      { header: 'MODEL', value: (m) => cyan(m.id) },
      { header: 'PROVIDER', value: (m) => m.gateway.provider },
      { header: 'CONTEXT', value: (m) => m.gateway.contextWindow.toLocaleString(), align: 'right' },
      { header: 'IN $/M', value: (m) => (m.gateway.pricing ? m.gateway.pricing.inputPerMillionTokens.toFixed(2) : dim('-')), align: 'right' },
      { header: 'OUT $/M', value: (m) => (m.gateway.pricing ? m.gateway.pricing.outputPerMillionTokens.toFixed(2) : dim('-')), align: 'right' },
      { header: 'STATUS', value: (m) => (m.gateway.status === 'available' ? green(m.gateway.status) : yellow(m.gateway.status)) },
      { header: 'CAPABILITIES', value: (m) => m.gateway.capabilities.join(',') },
    ]),
  );
  out('');
  out(dim(`  ${models.length} model(s). Virtual: ${list.gateway.virtualModels.join(', ')}`));
  const unverified = models.some((m) => m.gateway.pricing?.source.startsWith('seed:unverified'));
  if (unverified) {
    out(yellow(`  Pricing "${list.gateway.pricingVersion}" is the shipped placeholder set and is not verified against provider price lists.`));
  }
  out('');
  return 0;
}

// ----------------------------------------------------------- providers

export async function providersList(ctx: CommandContext): Promise<number> {
  const creds = resolveCredentials(typeof ctx.flags['profile'] === 'string' ? ctx.flags['profile'] : undefined);
  const response = await fetch(`${creds.baseUrl}/health/providers`);
  const body = (await response.json()) as {
    data: Array<{ provider: string; state: string; measured: Record<string, number> }>;
    note: string;
  };

  if (asJson(ctx.flags)) {
    json(body);
    return 0;
  }

  out('');
  out(
    table(body.data, [
      { header: 'PROVIDER', value: (p) => cyan(p.provider) },
      { header: 'STATE', value: (p) => healthBadge(p.state) },
      { header: 'REQUESTS', value: (p) => String(p.measured['requests'] ?? 0), align: 'right' },
      { header: 'SUCCESS', value: (p) => `${(((p.measured['successRate'] as number) ?? 0) * 100).toFixed(1)}%`, align: 'right' },
      { header: 'P50', value: (p) => formatDuration(p.measured['p50LatencyMs']), align: 'right' },
      { header: 'P95', value: (p) => formatDuration(p.measured['p95LatencyMs']), align: 'right' },
    ]),
  );
  out('');
  out(dim(`  ${body.note}`));
  out('');
  return 0;
}

// ------------------------------------------------------------- usage

export async function usage(ctx: CommandContext): Promise<number> {
  const gateway = client(ctx.flags);
  const range = (typeof ctx.flags['range'] === 'string' ? ctx.flags['range'] : '24h') as '24h';
  const report = await gateway.usage.retrieve({ range, includeTest: ctx.flags['include-test'] === true });

  if (asJson(ctx.flags)) {
    json(report);
    return 0;
  }

  const summary = report.summary as Record<string, unknown>;
  const num = (key: string): number => {
    const value = summary[key];
    return typeof value === 'number' ? value : 0;
  };
  const currency = typeof summary['currency'] === 'string' ? summary['currency'] : 'USD';

  out('');
  out(`${bold('Usage')} ${dim(`${report.range.from} -> ${report.range.to}`)}`);
  out('');
  out(`  requests        ${num('totalRequests')} ${dim(`(${num('successfulRequests')} ok, ${num('failedRequests')} failed)`)}`);
  out(`  success rate    ${(num('successRate') * 100).toFixed(2)}%`);
  out(`  tokens          ${num('totalTokens').toLocaleString()} ${dim(`(in ${num('inputTokens').toLocaleString()} / out ${num('outputTokens').toLocaleString()})`)}`);
  out(`  estimated cost  ${formatCost(num('estimatedCost'), currency)}`);
  out(`  avg latency     ${formatDuration(num('avgLatencyMs'))} ${dim(`(p95 ${formatDuration(num('p95LatencyMs'))})`)}`);
  out(`  cache hit rate  ${(num('cacheHitRate') * 100).toFixed(1)}%`);
  out(`  fallback rate   ${(num('fallbackRate') * 100).toFixed(1)}%`);
  out('');

  const byProvider = report.breakdown['provider'] ?? [];
  if (byProvider.length > 0) {
    out(bold('  By provider'));
    out(
      table(byProvider as Array<Record<string, number | string>>, [
        { header: 'PROVIDER', value: (r) => cyan(String(r['key'])) },
        { header: 'REQUESTS', value: (r) => String(r['requests']), align: 'right' },
        { header: 'ERRORS', value: (r) => String(r['errors']), align: 'right' },
        { header: 'TOKENS', value: (r) => Number(r['tokens']).toLocaleString(), align: 'right' },
        { header: 'COST', value: (r) => formatCost(Number(r['cost']), currency), align: 'right' },
        { header: 'P95', value: (r) => formatDuration(Number(r['p95LatencyMs'])), align: 'right' },
      ]),
    );
    out('');
  }

  out(dim(`  ${report.disclosure.note}`));
  out(dim(`  pricing version ${report.disclosure.pricingVersion} (${report.disclosure.pricingAgeDays}d old), estimated usage share ${(report.disclosure.estimatedUsageShare * 100).toFixed(1)}%`));
  out('');
  return 0;
}

// ---------------------------------------------------------- requests

export async function requestsList(ctx: CommandContext): Promise<number> {
  const gateway = client(ctx.flags);
  const result = await gateway.requests.list({
    limit: typeof ctx.flags['limit'] === 'string' ? Number(ctx.flags['limit']) : 20,
    status: typeof ctx.flags['status'] === 'string' ? ctx.flags['status'] : undefined,
    providerId: typeof ctx.flags['provider'] === 'string' ? ctx.flags['provider'] : undefined,
    modelId: typeof ctx.flags['model'] === 'string' ? ctx.flags['model'] : undefined,
    search: typeof ctx.flags['search'] === 'string' ? ctx.flags['search'] : undefined,
    includeTest: ctx.flags['include-test'] === true ? true : undefined,
  });

  if (asJson(ctx.flags)) {
    json(result);
    return 0;
  }

  const rows = result.data as Array<Record<string, unknown>>;
  out('');
  out(
    table(rows, [
      { header: 'REQUEST ID', value: (r) => cyan(String(r['id'])) },
      { header: 'STATUS', value: (r) => statusBadge(String(r['status'])) },
      { header: 'MODEL', value: (r) => String(r['resolvedModelId'] ?? r['requestedModel']) },
      { header: 'LATENCY', value: (r) => formatDuration(Number(r['latencyMs'])), align: 'right' },
      { header: 'TOKENS', value: (r) => String((r['usage'] as { total?: number } | undefined)?.total ?? '-'), align: 'right' },
      { header: 'COST', value: (r) => formatCost(r['estimatedCost'] as number | undefined, String(r['currency'] ?? 'USD')), align: 'right' },
      { header: 'CACHE', value: (r) => (r['cacheStatus'] === 'miss' ? dim('miss') : green(String(r['cacheStatus']))) },
      { header: 'FALLBACK', value: (r) => (r['fallbackUsed'] ? yellow('yes') : dim('no')) },
    ]),
  );
  out('');
  if (result.nextCursor) out(dim(`  more: aigw requests list --cursor ${result.nextCursor}`));
  out('');
  return 0;
}

export async function requestGet(ctx: CommandContext): Promise<number> {
  const id = ctx.args[0];
  if (!id) {
    errOut('Usage: aigw request get <REQUEST_ID>');
    return 2;
  }
  const gateway = client(ctx.flags);
  const trace = await gateway.requests.retrieve(id);

  if (asJson(ctx.flags)) {
    json(trace);
    return 0;
  }

  const r = trace.request as Record<string, unknown>;
  out('');
  out(`${bold('Request')} ${cyan(String(r['id']))}`);
  out('');
  out(`  status          ${statusBadge(String(r['status']))}${r['errorType'] ? ` ${red(String(r['errorType']))}` : ''}`);
  out(`  requested       ${r['requestedModel']}`);
  out(`  routed to       ${r['resolvedProviderId'] ?? dim('-')} / ${r['resolvedModelId'] ?? dim('-')}`);
  out(`  strategy        ${r['strategy'] ?? dim('-')}`);
  out(`  latency         ${formatDuration(Number(r['latencyMs']))}${r['timeToFirstTokenMs'] ? dim(` (ttft ${formatDuration(Number(r['timeToFirstTokenMs']))})`) : ''}`);
  out(`  cache           ${r['cacheStatus']}`);
  out(`  attempts        ${r['attemptCount']}${r['fallbackUsed'] ? yellow(' (fallback used)') : ''}`);
  const usageInfo = r['usage'] as { input: number; output: number; total: number; source: string } | undefined;
  if (usageInfo) {
    const label = usageInfo.source === 'estimated' ? yellow('estimated') : green('provider-reported');
    out(`  tokens          ${usageInfo.total} ${dim(`(in ${usageInfo.input} / out ${usageInfo.output})`)} ${label}`);
  }
  out(`  estimated cost  ${formatCost(r['estimatedCost'] as number | undefined, String(r['currency'] ?? 'USD'))}${r['pricingVersion'] ? dim(` @ ${r['pricingVersion']}`) : ''}`);

  if (Array.isArray(r['routingReasons']) && r['routingReasons'].length > 0) {
    out('');
    out(bold('  Why this route'));
    for (const reason of r['routingReasons'] as string[]) out(`    ${dim('·')} ${reason}`);
  }

  out('');
  out(bold('  Timeline'));
  for (const step of trace.steps) {
    const mark = step.status === 'ok' ? green('✓') : step.status === 'skipped' ? dim('–') : red('✗');
    out(`    ${mark} ${step.name.padEnd(20)} ${formatDuration(step.durationMs).padStart(8)}  ${step.detail ? dim(JSON.stringify(step.detail).slice(0, 90)) : ''}`);
  }

  if (trace.attempts.length > 0) {
    out('');
    out(bold('  Attempts'));
    out(
      table(trace.attempts, [
        { header: '#', value: (a) => String(a.attemptNumber), align: 'right' },
        { header: 'PROVIDER', value: (a) => a.providerId },
        { header: 'MODEL', value: (a) => a.modelId },
        { header: 'RESULT', value: (a) => (a.status === 'success' ? green('success') : red(a.errorType ?? 'error')) },
        { header: 'DURATION', value: (a) => formatDuration(a.durationMs), align: 'right' },
        { header: 'BACKOFF', value: (a) => (a.backoffMs ? formatDuration(a.backoffMs) : dim('-')), align: 'right' },
      ]),
    );
  }

  out('');
  out(dim(`  ${trace.privacy.note}`));
  out('');
  return 0;
}

// ---------------------------------------------------------- routing

export async function routingList(ctx: CommandContext): Promise<number> {
  const creds = resolveCredentials(typeof ctx.flags['profile'] === 'string' ? ctx.flags['profile'] : undefined);
  const response = await fetch(`${creds.baseUrl}/api/v1/routing-policies`, {
    headers: { authorization: `Bearer ${creds.apiKey}` },
  });
  if (!response.ok) {
    errOut(red(`Gateway returned HTTP ${response.status}: ${await response.text()}`));
    return 1;
  }
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };

  if (asJson(ctx.flags)) {
    json(body);
    return 0;
  }

  out('');
  out(
    table(body.data, [
      { header: 'POLICY ID', value: (p) => cyan(String(p['id'])) },
      { header: 'NAME', value: (p) => String(p['name']) },
      { header: 'PROJECT', value: (p) => String(p['projectId'] ?? dim('(org default)')) },
      { header: 'ACTIVE V', value: (p) => String(p['activeVersion']), align: 'right' },
      { header: 'UPDATED', value: (p) => String(p['updatedAt']).slice(0, 19).replace('T', ' ') },
    ]),
  );
  out('');
  return 0;
}

/**
 * Validate a policy file locally.
 *
 * Runs the same parser the gateway uses, so `aigw routing validate` in CI gives
 * the same verdict a deploy would.
 */
export async function routingValidate(ctx: CommandContext): Promise<number> {
  const path = ctx.args[0];
  if (!path) {
    errOut('Usage: aigw routing validate <POLICY_FILE>');
    return 2;
  }

  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (err) {
    errOut(red(`Could not read ${path}: ${(err as Error).message}`));
    return 1;
  }

  const result = parsePolicy(source);

  if (asJson(ctx.flags)) {
    json(result.ok ? { valid: true, warnings: result.warnings, checksum: result.checksum } : { valid: false, errors: result.issues, warnings: result.warnings });
    return result.ok ? 0 : 1;
  }

  out('');
  if (!result.ok) {
    out(`${red('✗')} ${bold(path)} is not a valid routing policy.`);
    out('');
    for (const issue of result.issues) {
      out(`  ${red('error')}  ${issue.path ? `${cyan(issue.path)}: ` : ''}${issue.message}`);
    }
    for (const warning of result.warnings) {
      out(`  ${yellow('warn')}   ${warning.path ? `${cyan(warning.path)}: ` : ''}${warning.message}`);
    }
    out('');
    return 1;
  }

  out(`${green('✓')} ${bold(path)} is valid. ${dim(`checksum ${result.checksum}`)}`);
  const policy = result.policy;
  out('');
  out(`  strategy   ${policy.routing.strategy}`);
  out(`  models     ${policy.routing.models.map((m) => (typeof m === 'string' ? m : m.model)).join(' → ')}`);
  out(`  fallback   ${policy.fallback.enabled ? `up to ${policy.fallback.maxTargets} targets` : 'disabled'}`);
  out(`  retry      ${policy.retry.maxAttempts} attempts, ${policy.retry.backoff} backoff, ${policy.retry.jitter} jitter`);
  out(`  cache      ${policy.cache.mode}${policy.cache.mode !== 'off' ? ` (ttl ${policy.cache.ttlSeconds}s, threshold ${policy.cache.similarityThreshold})` : ''}`);
  if (result.warnings.length > 0) {
    out('');
    for (const warning of result.warnings) {
      out(`  ${yellow('warn')}   ${warning.path ? `${cyan(warning.path)}: ` : ''}${warning.message}`);
    }
  }
  out('');
  return 0;
}

/** Dry-run the router against the live gateway. No provider is contacted. */
export async function routingTest(ctx: CommandContext): Promise<number> {
  const gateway = client(ctx.flags);
  const model = typeof ctx.flags['model'] === 'string' ? ctx.flags['model'] : 'gateway/auto';
  const result = await gateway.routing.test({
    model,
    prompt: ctx.args.join(' ') || undefined,
    strategy: typeof ctx.flags['strategy'] === 'string' ? ctx.flags['strategy'] : undefined,
    candidates: typeof ctx.flags['candidates'] === 'string' ? ctx.flags['candidates'].split(',') : undefined,
    requireTools: ctx.flags['require-tools'] === true,
    requireVision: ctx.flags['require-vision'] === true,
    stream: ctx.flags['stream'] === true,
  });

  if (asJson(ctx.flags)) {
    json(result);
    return 0;
  }

  out('');
  out(`${bold('Routing test')} ${dim(`strategy: ${result.strategy}`)}`);
  out(dim(`  ${result.note}`));
  out('');
  if (result.selected) {
    out(`  ${green('selected')}  ${cyan(result.selected.model)} ${dim(`(score ${result.selected.score})`)}`);
    for (const reason of result.selected.reasons) out(`            ${dim('·')} ${reason}`);
  } else {
    out(`  ${red('no eligible target')}`);
  }

  if (result.chain.length > 1) {
    out('');
    out(bold('  Fallback chain'));
    for (const entry of result.chain.slice(1)) {
      out(`    ${entry.position}. ${entry.model} ${dim(`score ${entry.score}`)}`);
    }
  }

  if (result.rejected.length > 0) {
    out('');
    out(bold('  Excluded'));
    for (const rejection of result.rejected) {
      out(`    ${red('✗')} ${rejection.target} ${dim(rejection.reason)}`);
    }
  }
  out('');
  return 0;
}

// ---------------------------------------------------------- inference

/** Send a completion and stream it to stdout. Useful as a smoke test. */
export async function chat(ctx: CommandContext): Promise<number> {
  const prompt = ctx.args.join(' ');
  if (!prompt) {
    errOut('Usage: aigw chat "your prompt here" [--model gateway/auto] [--no-stream]');
    return 2;
  }

  const gateway = client(ctx.flags);
  const model = typeof ctx.flags['model'] === 'string' ? ctx.flags['model'] : 'gateway/auto';
  const params = { model, messages: [{ role: 'user' as const, content: prompt }] };

  try {
    if (ctx.flags['no-stream'] === true) {
      const completion = await gateway.chat.completions.create(params);
      if (asJson(ctx.flags)) {
        json(completion);
        return 0;
      }
      out('');
      out(String(completion.choices[0]?.message.content ?? ''));
      out('');
      printReceipt(completion.gateway);
      return 0;
    }

    const stream = await gateway.chat.completions.stream(params);
    out('');
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (delta) process.stdout.write(delta);
    }
    out('');
    out('');
    printReceipt(stream.receipt);
    return 0;
  } catch (err) {
    if (AIGatewayError.isAIGatewayError(err)) {
      errOut('');
      errOut(`${red(err.type)} ${err.message}`);
      if (err.requestId) errOut(dim(`  request id: ${err.requestId}`));
      if (err.retryable) errOut(dim('  this error is retryable'));
      errOut('');
      return 1;
    }
    throw err;
  }
}

function printReceipt(receipt: { provider: string; model: string; strategy: string; attempts: number; fallbackUsed: boolean; cache: string; latencyMs: number; usageSource?: string; estimatedCost?: { amount: number; currency: string; pricingVersion: string }; reasons: string[] } | undefined): void {
  if (!receipt) return;
  out(dim(`  routed to ${receipt.provider}/${receipt.model} via ${receipt.strategy}`));
  out(
    dim(
      `  ${receipt.attempts} attempt(s)${receipt.fallbackUsed ? ', fallback used' : ''}, cache ${receipt.cache}, ${formatDuration(receipt.latencyMs)}` +
        (receipt.estimatedCost
          ? `, est. ${formatCost(receipt.estimatedCost.amount, receipt.estimatedCost.currency)} @ ${receipt.estimatedCost.pricingVersion}`
          : ''),
    ),
  );
  if (receipt.usageSource === 'estimated') {
    out(yellow('  token counts were estimated by the gateway, not reported by the provider'));
  }
}
