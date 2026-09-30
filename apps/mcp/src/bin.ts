#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

/**
 * stdio entrypoint.
 *
 * Nothing is written to stdout except MCP protocol frames: stdout is the
 * transport, so diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const apiKey = process.env['AI_GATEWAY_API_KEY'];
  if (!apiKey) {
    process.stderr.write(
      'AI_GATEWAY_API_KEY is not set. The MCP server needs a gateway API key with the ' +
        'models.read, usage.read and logs.read scopes.\n',
    );
    process.exit(78);
  }

  const server = createMcpServer({
    apiKey,
    baseUrl: process.env['AI_GATEWAY_URL'] ?? 'http://localhost:8787',
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('ai-gateway MCP server ready (read-only tools over stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
