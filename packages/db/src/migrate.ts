/* eslint-disable no-restricted-syntax -- This is a CLI: its console output IS
   the user interface, and it must run before any application logger exists. */
/**
 * Migration runner. Used by `pnpm db:migrate`, by CI, and by the deploy
 * pipeline. Drizzle records applied migrations in `drizzle.__drizzle_migrations`
 * so re-running is a no-op.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb } from "./client";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const target = new URL(connectionString);
  console.log(`Applying migrations to ${target.pathname.slice(1)} at ${target.host}`);

  const { db, pool } = createDb({ connectionString, max: 1 });
  try {
    await migrate(db, { migrationsFolder });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
