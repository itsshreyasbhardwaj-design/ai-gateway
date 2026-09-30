#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { AIGatewayConnectionError, AIGatewayError, AIGatewayTimeoutError } from '@ai-gateway/sdk';
import * as commands from './commands.js';
import { bold, cyan, dim, errOut, out, red } from './output.js';

const VERSION = '0.1.0';

interface Route {
  path: string[];
  summary: string;
  usage: string;
  run: (ctx: commands.CommandContext) => Promise<number>;
}

const ROUTES: Route[] = [
  {
    path: ['login'],
    summary: 'Store gateway credentials in a local profile',
    usage: 'aigw login [--url URL] [--key KEY] [--profile NAME]',
    run: commands.login,
  },
  {
    path: ['logout'],
    summary: 'Remove a stored profile',
    usage: 'aigw logout [--profile NAME]',
    run: commands.logout,
  },
  {
    path: ['whoami'],
    summary: 'Show which gateway and profile are in use',
    usage: 'aigw whoami',
    run: commands.whoami,
  },
  {
    path: ['models', 'list'],
    summary: 'List models this key can use',
    usage: 'aigw models list [--provider ID] [--capability CAP]',
    run: commands.modelsList,
  },
  {
    path: ['providers', 'list'],
    summary: 'Show provider health as measured by the gateway',
    usage: 'aigw providers list',
    run: commands.providersList,
  },
  {
    path: ['usage'],
    summary: 'Usage, cost and latency summary',
    usage: 'aigw usage [--range 1h|24h|7d|30d|90d] [--include-test]',
    run: commands.usage,
  },
  {
    path: ['requests', 'list'],
    summary: 'List recent requests',
    usage: 'aigw requests list [--limit N] [--status S] [--provider P] [--search Q]',
    run: commands.requestsList,
  },
  {
    path: ['request', 'get'],
    summary: 'Show a full request trace',
    usage: 'aigw request get REQUEST_ID',
    run: commands.requestGet,
  },
  {
    path: ['routing', 'list'],
    summary: 'List routing policies',
    usage: 'aigw routing list',
    run: commands.routingList,
  },
  {
    path: ['routing', 'validate'],
    summary: 'Validate a policy file without deploying it',
    usage: 'aigw routing validate POLICY_FILE',
    run: commands.routingValidate,
  },
  {
    path: ['routing', 'test'],
    summary: 'Dry-run the router; contacts no provider',
    usage: 'aigw routing test [PROMPT] [--model M] [--strategy S]',
    run: commands.routingTest,
  },
  {
    path: ['chat'],
    summary: 'Send a completion through the gateway',
    usage: 'aigw chat "PROMPT" [--model M] [--no-stream]',
    run: commands.chat,
  },
];

interface Parsed {
  path: string[];
  args: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Argument parsing.
 *
 * Deliberately hand-rolled: a CLI whose whole job is to talk to one HTTP API
 * does not need an argument-parsing dependency, and `npx aigw` staying fast is
 * worth more than the convenience.
 */
export function parseArgv(argv: string[]): Parsed {
  const path: string[] = [];
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let sawFlag = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      sawFlag = true;
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      sawFlag = true;
      flags[token.slice(1)] = true;
      continue;
    }

    // Subcommand words come before any flag; everything after is a positional.
    if (!sawFlag && path.length < 2) path.push(token);
    else args.push(token);
  }

  return { path, args, flags };
}

function findRoute(path: string[]): { route: Route; consumed: number } | undefined {
  // Prefer the two-word match ("models list") over the one-word one ("models").
  for (const length of [2, 1]) {
    const candidate = path.slice(0, length).join(' ');
    const route = ROUTES.find((r) => r.path.join(' ') === candidate);
    if (route) return { route, consumed: length };
  }
  return undefined;
}

function help(): void {
  out('');
  out(`${bold('aigw')} ${dim(VERSION)} - command line interface for AI Gateway`);
  out('');
  out(bold('  Usage'));
  out('    aigw <command> [options]');
  out('');
  out(bold('  Commands'));
  const width = Math.max(...ROUTES.map((r) => r.path.join(' ').length));
  for (const route of ROUTES) {
    out(`    ${cyan(route.path.join(' ').padEnd(width))}  ${route.summary}`);
  }
  out('');
  out(bold('  Global options'));
  out(`    ${cyan('--json')}            Machine-readable output`);
  out(`    ${cyan('--url URL')}         Override the gateway URL`);
  out(`    ${cyan('--profile NAME')}    Use a specific stored profile`);
  out(`    ${cyan('--help')}            Show help for a command`);
  out(`    ${cyan('--version')}         Print the version`);
  out('');
  out(bold('  Environment'));
  out(`    ${cyan('AI_GATEWAY_API_KEY')}  API key; takes precedence over stored profiles`);
  out(`    ${cyan('AI_GATEWAY_URL')}      Gateway base URL`);
  out('');
  out(dim('  Docs: docs/cli.md'));
  out('');
}

async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2));

  if (parsed.flags['version'] === true || parsed.path[0] === 'version') {
    out(VERSION);
    return 0;
  }

  if (parsed.path.length === 0 || parsed.path[0] === 'help') {
    help();
    return parsed.path.length === 0 && parsed.flags['help'] !== true ? 1 : 0;
  }

  const found = findRoute(parsed.path);
  if (!found) {
    errOut('');
    errOut(`${red('Unknown command')}: ${parsed.path.join(' ')}`);
    const suggestion = ROUTES.find((r) => r.path[0] === parsed.path[0]);
    if (suggestion) errOut(dim(`Did you mean: aigw ${suggestion.path.join(' ')}?`));
    errOut(dim('Run "aigw help" to see available commands.'));
    errOut('');
    return 2;
  }

  if (parsed.flags['help'] === true) {
    out('');
    out(`${bold(found.route.path.join(' '))}  ${found.route.summary}`);
    out('');
    out(`  ${found.route.usage}`);
    out('');
    return 0;
  }

  // Extra subcommand words that were not part of the route are positionals.
  const args = [...parsed.path.slice(found.consumed), ...parsed.args];
  return found.route.run({ args, flags: parsed.flags });
}

/**
 * Only run when invoked as the entrypoint. `index.ts` re-exports `parseArgv`
 * for tests, and importing a module must not execute a CLI.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return (
    import.meta.url === pathToFileURL(entry).href ||
    entry.endsWith('bin.ts') ||
    entry.endsWith('bin.js')
  );
})();

if (invokedDirectly) {
  run();
}

function run(): void {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      errOut('');
      if (AIGatewayError.isAIGatewayError(err)) {
        errOut(`${red(err.type)}  ${err.message}`);
        if (err.requestId) errOut(dim(`  request id: ${err.requestId}`));
        if (err.details) errOut(dim(`  details: ${JSON.stringify(err.details)}`));
      } else if (err instanceof AIGatewayConnectionError) {
        errOut(`${red('connection failed')}  ${err.message}`);
        errOut(dim('  Is the gateway running? Try: pnpm dev'));
      } else if (err instanceof AIGatewayTimeoutError) {
        errOut(`${red('timed out')}  ${err.message}`);
      } else {
        errOut(`${red('error')}  ${(err as Error).message}`);
      }
      errOut('');
      process.exit(1);
    });
}
