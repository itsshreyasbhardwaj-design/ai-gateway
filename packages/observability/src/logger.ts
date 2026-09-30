import { redact, redactHeaders } from '@ai-gateway/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  requestId?: string;
  organizationId?: string;
  projectId?: string;
  apiKeyId?: string;
  provider?: string;
  model?: string;
  status?: string | number;
  latencyMs?: number;
  errorType?: string;
  [key: string]: unknown;
}

export interface LogRecord extends LogFields {
  level: LogLevel;
  time: string;
  msg: string;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export class ConsoleSink implements LogSink {
  constructor(private readonly pretty = false) {}

  write(record: LogRecord): void {
    if (!this.pretty) {
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const { level, time, msg, ...rest } = record;
    const tail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    process.stdout.write(`${time} ${level.toUpperCase().padEnd(5)} ${msg}${tail}\n`);
  }
}

/** Collects records in memory. Used by tests to assert nothing sensitive is logged. */
export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
  clear(): void {
    this.records.length = 0;
  }
  get text(): string {
    return this.records.map((r) => JSON.stringify(r)).join('\n');
  }
}

/**
 * Structured logger.
 *
 * Every field passes through `redact` before it reaches a sink. That is
 * deliberately not optional: the gateway holds provider credentials and user
 * prompts, and a logger that trusts its callers to sanitize is a logger that
 * eventually leaks.
 */
export class Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly minLevel: LogLevel = 'info',
    private readonly base: LogFields = {},
  ) {}

  child(fields: LogFields): Logger {
    return new Logger(this.sink, this.minLevel, { ...this.base, ...fields });
  }

  debug(msg: string, fields?: LogFields): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.log('error', msg, fields);
  }

  private log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const merged = { ...this.base, ...fields };
    this.sink.write({
      level,
      time: new Date().toISOString(),
      msg: redact(msg),
      ...redact(merged),
    });
  }
}

export function createLogger(
  opts: { level?: LogLevel; pretty?: boolean; sink?: LogSink } = {},
): Logger {
  return new Logger(opts.sink ?? new ConsoleSink(opts.pretty), opts.level ?? 'info');
}

export { redactHeaders };
