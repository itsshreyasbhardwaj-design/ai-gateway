import { ConfigError } from '@ai-gateway/config';
import { bootstrap } from './bootstrap.js';
import { buildApp } from './app.js';

/**
 * Process entrypoint.
 *
 * Boots the gateway, prints exactly what came up (including what did not), and
 * shuts down gracefully so in-flight streaming responses are allowed to finish.
 */
async function main(): Promise<void> {
  let booted: Awaited<ReturnType<typeof bootstrap>>;
  try {
    booted = await bootstrap();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\nSee .env.example and docs/self-hosting.md.\n\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const { ctx, banner, demo } = booted;
  const app = await buildApp(ctx);

  for (const line of banner) {
    const level = line.startsWith('warning:') ? 'warn' : 'info';
    ctx.logger[level](line.replace(/^warning:\s*/, ''));
  }

  if (demo?.apiKey && demo.apiKey.startsWith('aigw_')) {
    // Printed to stdout, not the structured log, so it is not shipped to a log
    // aggregator. It is shown exactly once.
    process.stdout.write(
      `\n  AI Gateway is ready.\n\n` +
        `  Organization : ${demo.organizationId}\n` +
        `  Project      : ${demo.projectId}\n` +
        `  API key      : ${demo.apiKey}\n\n` +
        `  This key is shown once and is not recoverable. Try it:\n\n` +
        `    curl http://localhost:${ctx.config.port}/v1/chat/completions \\\n` +
        `      -H "Authorization: Bearer ${demo.apiKey}" \\\n` +
        `      -H "Content-Type: application/json" \\\n` +
        `      -d '{"model":"gateway/auto","messages":[{"role":"user","content":"hello"}]}'\n\n`,
    );
  }

  await app.listen({ port: ctx.config.port, host: ctx.config.host });
  ctx.logger.info('gateway listening', { port: ctx.config.port, host: ctx.config.host });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.logger.info('shutting down', { signal });
    // Close the listener first so no new requests arrive, then let Fastify
    // drain in-flight ones before tearing down connections.
    const timer = setTimeout(() => {
      ctx.logger.warn('shutdown timed out; exiting');
      process.exit(1);
    }, 20_000);
    timer.unref();
    try {
      await app.close();
      await ctx.shutdown();
      ctx.logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      ctx.logger.error('shutdown failed', { error: (err as Error).message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    ctx.logger.error('unhandled rejection', { error: String(reason) });
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
