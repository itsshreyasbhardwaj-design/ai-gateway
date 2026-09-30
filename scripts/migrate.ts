/**
 * Apply the database schema.
 *
 *   DATABASE_URL=postgresql://... pnpm db:migrate
 *
 * Safe to run repeatedly: the migration is written with IF NOT EXISTS
 * throughout and runs inside a transaction, so a partial failure rolls back.
 */
import { createStore } from '@ai-gateway/database';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write(
      'DATABASE_URL is not set.\n\n' +
        'The gateway runs without a database using its in-memory store, so\n' +
        'migration is only needed for a durable deployment. Start Postgres with:\n\n' +
        '  docker compose up -d postgres\n' +
        '  DATABASE_URL=postgresql://aigw:aigw@localhost:5432/aigw pnpm db:migrate\n\n',
    );
    process.exit(78);
  }

  process.stdout.write(`Applying schema to ${redactUrl(url)}…\n`);
  const store = await createStore(url);
  try {
    await store.migrate();
    const healthy = await store.healthCheck();
    process.stdout.write(
      healthy ? 'Schema applied.\n' : 'Schema applied but the health check failed.\n',
    );
    process.exit(healthy ? 0 : 1);
  } catch (err) {
    process.stderr.write(`Migration failed: ${(err as Error).message}\n`);
    process.exit(1);
  } finally {
    await store.close().catch(() => undefined);
  }
}

/** Never print a connection string with its password intact. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

void main();
