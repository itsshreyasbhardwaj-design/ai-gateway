import { PGlite } from '@electric-sql/pglite';

interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

/**
 * Adapt PGlite to the pool shape `PostgresStore` expects.
 *
 * PGlite is a real PostgreSQL build compiled to WASM, so this exercises the
 * actual SQL — DDL, transactions, JSONB and array round-tripping, the partial
 * unique index, and the row mappers — without needing Docker or a server.
 *
 * It is not a substitute for testing against a real server: PGlite is a single
 * connection, so it cannot demonstrate concurrent behaviour such as
 * `FOR UPDATE SKIP LOCKED` actually skipping a locked row. CI runs the same
 * suite against a real PostgreSQL service, and these tests are written to pass
 * on both.
 */
export class PGlitePool {
  private constructor(private readonly db: PGlite) {}

  static async create(): Promise<PGlitePool> {
    const db = new PGlite();
    await db.waitReady;
    return new PGlitePool(db);
  }

  async query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    // Multi-statement SQL (the migration) has to go through exec(), which does
    // not take parameters.
    if (!values?.length && /;\s*\S/.test(text.replace(/--[^\n]*\n/g, ''))) {
      await this.db.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const result = await this.db.query<T>(text, values as never[]);
    return {
      rows: result.rows,
      rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : result.rows.length,
    };
  }

  async connect(): Promise<{ query: PGlitePool['query']; release: () => void }> {
    // Single connection, so a "client" is the same underlying database. That is
    // fine for transaction tests and is why concurrency is out of scope here.
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }

  async end(): Promise<void> {
    await this.db.close();
  }
}
