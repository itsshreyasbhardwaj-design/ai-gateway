import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliProfile {
  baseUrl: string;
  apiKey: string;
  label?: string;
}

export interface CliConfig {
  current: string;
  profiles: Record<string, CliProfile>;
}

/**
 * Credential file.
 *
 * Written with 0600 because it holds a live API key. The environment always
 * wins over the file, so CI never needs to write one.
 */
export function configPath(): string {
  const override = process.env['AIGW_CONFIG'];
  if (override) return override;
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'aigw', 'config.json');
}

export function readConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) return { current: 'default', profiles: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
  } catch {
    return { current: 'default', profiles: {} };
  }
}

export function writeConfig(config: CliConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export interface ResolvedCredentials {
  baseUrl: string;
  apiKey: string;
  source: 'environment' | 'profile';
  profile?: string;
}

/** Environment first, then the stored profile. */
export function resolveCredentials(profileName?: string): ResolvedCredentials {
  const envKey = process.env['AI_GATEWAY_API_KEY'];
  const envUrl = process.env['AI_GATEWAY_URL'];
  if (envKey) {
    return { apiKey: envKey, baseUrl: envUrl ?? 'http://localhost:8787', source: 'environment' };
  }

  const config = readConfig();
  const name = profileName ?? config.current;
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(
      `No credentials found. Run "aigw login" or set AI_GATEWAY_API_KEY.\n` +
        `  config file: ${configPath()}\n` +
        `  profiles   : ${Object.keys(config.profiles).join(', ') || '(none)'}`,
    );
  }
  return { apiKey: profile.apiKey, baseUrl: profile.baseUrl, source: 'profile', profile: name };
}
