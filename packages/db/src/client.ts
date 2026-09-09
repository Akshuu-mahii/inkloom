import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index";

export type Database = NodePgDatabase<typeof schema>;
/**
 * Either a pool-backed database or a transaction handle. Every service in
 * @inkloom/core accepts this type, so the same function works standalone or
 * composed inside a caller's transaction.
 */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DbConfig {
  connectionString: string;
  /** Keep small on Workers: each isolate gets its own pool. */
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  ssl?: boolean;
}

/**
 * `pg` is the single driver for every environment.
 *
 * - Local dev and CI reach the Docker Postgres over plain TCP.
 * - Tests use the isolated `inkloom_test` database.
 * - Production reaches Neon through a Cloudflare Hyperdrive binding, which
 *   presents an ordinary Postgres connection string. Using one driver
 *   everywhere means transaction semantics under test are the same semantics
 *   that run in production — which is the whole basis of the concurrency
 *   guarantees around redemption. See docs/ARCHITECTURE.md.
 */
export function createDb(config: DbConfig): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 5,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    // Never let a runaway statement hold a lock on the campaign row.
    statement_timeout: 15_000,
    query_timeout: 15_000,
  });

  /**
   * A pool-level error handler is mandatory, not optional.
   *
   * `pg` emits 'error' on an IDLE client when the server or the network drops
   * it. With no listener, Node treats that as an unhandled 'error' event and
   * tears the process down — so one closed connection would kill the whole
   * Worker rather than costing a single retry.
   */
  pool.on("error", () => {
    // Intentionally swallowed: the pool discards the client and the next
    // acquisition opens a fresh one. Logging here would need a logger this
    // low-level module deliberately does not depend on.
  });

  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool };
}

export { schema };
export * from "./schema/index";
