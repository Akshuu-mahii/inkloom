/**
 * Record the outcome of a scheduled job that ran somewhere else.
 *
 *   DATABASE_URL="<url>" pnpm tsx scripts/record-job.ts \
 *     --job restore_test --status ok --note "weekly restore test"
 *
 * Exists because of where the restore test runs. It restores into a scratch
 * Postgres, so its own `DATABASE_URL` points at the scratch database — and a
 * `job_runs` row written there disappears with the container. The result has to
 * land in the REAL database, which is the only place the admin console and the
 * staleness signal can see it.
 *
 * Deliberately dumb: it records what it is told. The job it describes has
 * already run and already decided whether it passed; this only carries that
 * verdict across a process boundary.
 */
import { createDb } from "@inkloom/db/client";
import { recordJobRun } from "@inkloom/core/retention";
import { describeTarget, required } from "./_env";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const url = required("DATABASE_URL");
  const job = arg("job");
  const status = arg("status") as "ok" | "partial" | "failed" | undefined;
  const note = arg("note") ?? "";
  const durationMs = Number(arg("duration") ?? 0);

  if (!job || !status || !["ok", "partial", "failed"].includes(status)) {
    console.error(
      "\n  Usage: --job <name> --status <ok|partial|failed> [--note <text>] [--duration <ms>]\n",
    );
    process.exit(1);
  }

  const { db, pool } = createDb({ connectionString: url, max: 1 });
  const now = new Date();

  try {
    await recordJobRun(db, {
      job,
      startedAt: new Date(now.getTime() - durationMs),
      finishedAt: now,
      status,
      durationMs,
      steps: [{ name: "external", note }],
      error: status === "failed" ? note || "reported failed by an external runner" : undefined,
    });
    console.log(`\n  recorded ${job}=${status} against ${describeTarget(url)}\n`);
  } finally {
    await pool.end();
  }
}

void main();
