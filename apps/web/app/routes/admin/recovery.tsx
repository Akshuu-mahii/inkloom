/**
 * Recovery — can we get the data back right now?
 *
 * The failure mode of a backup system is SILENCE. Nothing breaks, no error is
 * raised, and the archives simply stop being written or stop being restorable.
 * Nobody finds out until the one day it matters. This page exists to turn that
 * silence into something an operator sees without running anything.
 *
 * It is read-only on purpose. See the note on the `/admin/recovery` endpoint
 * for why there is no download button and no restore button — briefly: an
 * archive is a complete copy of everyone's personal data, and restoring
 * discards every write since the recovery point. Neither belongs one click away
 * on a page people open when they are already panicking.
 */
import { Link } from "react-router";
import type { Route } from "./+types/recovery";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { formatRelative, PageHeader, Pill } from "../../components/ui";

interface JobHealth {
  job: string;
  maxAgeHours: number | null;
  healthy: boolean;
  lastRunAt: string | null;
  lastStatus: string;
  ageHours: number | null;
  rowsLastRun: number | null;
}

interface RecoveryInfo {
  jobs: JobHealth[];
  history: Array<{
    job: string;
    status: string;
    finishedAt: string;
    durationMs: number;
    rows: number;
    error: string | null;
  }>;
  integrity: {
    ledgerDrift: number;
    duplicateRedemptions: number;
    duplicateLedgerKeys: number;
    appendOnlyTriggers: number;
    serverErrors: number;
  };
  windows: { pitrHours: number; archiveRetentionDays: number };
}

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Recovery",
    description: "Backup, restore and integrity status.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<RecoveryInfo>("/admin/recovery", { request });
  return { info: result.data, error: result.error };
}

/** What each job is actually protecting, in the operator's terms. */
const JOBS: Record<string, { title: string; protects: string; whenStale: string }> = {
  database_backup: {
    title: "Nightly backup",
    protects: "An encrypted copy of the whole database, kept off-site for 30 days.",
    whenStale:
      "No new archive has been stored. You are back to the point-in-time window alone — " +
      "anything older than that is unrecoverable. Check the Backup workflow in GitHub Actions.",
  },
  restore_test: {
    title: "Weekly restore test",
    protects: "Proof that a stored archive can actually be decrypted and restored.",
    whenStale:
      "The archives exist but have not been shown to work recently. This is the half that " +
      "matters: a file can restore most of the way and still be unusable.",
  },
  retention_sweep: {
    title: "Retention sweep",
    protects: "Deletes data past the periods published at /privacy.",
    whenStale:
      "Data is being kept longer than the privacy policy promises. Not a recovery risk, " +
      "but it makes a published page untrue.",
  },
};

export default function Recovery({ loaderData }: Route.ComponentProps) {
  const { info, error } = loaderData;

  if (error || !info) {
    return (
      <>
        <PageHeader title="Recovery" description="Backup, restore and integrity status." />
        <p style={{ color: "var(--color-loop)" }}>
          {error?.message ?? "Could not load recovery status."}
        </p>
      </>
    );
  }

  const { integrity } = info;

  /*
   * Ledger drift is called out separately from everything else because it
   * changes what you should DO. A stale job is a thing to fix this week. Money
   * being wrong is a thing to stop the site for, and it gets worse every second
   * more writes land on top of it.
   */
  const moneyIsWrong =
    integrity.ledgerDrift > 0 ||
    integrity.duplicateRedemptions > 0 ||
    integrity.duplicateLedgerKeys > 0;
  const protectionsOff = integrity.appendOnlyTriggers < 2;

  return (
    <>
      <PageHeader
        title="Recovery"
        description="Whether the data could be recovered right now, and whether it needs to be."
      />

      {moneyIsWrong && (
        <section className="recovery-card recovery-alert">
          <h2 className="admin-h2">Stop and read this</h2>
          <p style={{ marginTop: "0.5rem" }}>
            The ledger does not balance. Every second the site stays up, more writes land on top
            of the damage and the recovery point moves further away. Put the site into
            maintenance before investigating, and do not delete anything — the damage is
            evidence, and the ledger will refuse to be rewritten anyway.
          </p>
        </section>
      )}

      {protectionsOff && (
        <section className="recovery-card recovery-alert">
          <h2 className="admin-h2">Append-only protection is missing</h2>
          <p style={{ marginTop: "0.5rem" }}>
            Expected two triggers, found {integrity.appendOnlyTriggers}. The credit ledger and the
            audit trail can currently be rewritten. This is more urgent than any backup problem:
            it means the record you would check against is no longer trustworthy.
          </p>
        </section>
      )}

      {/* --- The protections ------------------------------------------- */}
      <section className="admin-section">
        <h2 className="admin-h2">Protections</h2>
        <div style={{ display: "grid", gap: "0.875rem", marginTop: "1rem" }}>
          {info.jobs.map((job) => {
            const meta = JOBS[job.job] ?? {
              title: job.job,
              protects: "",
              whenStale: "This job has not run recently.",
            };
            return (
              <div key={job.job} className="recovery-card">
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    alignItems: "baseline",
                    flexWrap: "wrap",
                  }}
                >
                  <h3 style={{ fontSize: "1rem", margin: 0 }}>{meta.title}</h3>
                  <Pill tone={job.healthy ? "positive" : "critical"}>
                    {job.healthy ? "Healthy" : "Needs attention"}
                  </Pill>
                  <span style={{ color: "var(--color-muted)", fontSize: "0.875rem" }}>
                    {job.lastRunAt
                      ? `last ran ${formatRelative(job.lastRunAt)} · ${job.lastStatus}`
                      : "has never run"}
                  </span>
                </div>

                <p className="admin-note">{meta.protects}</p>

                {!job.healthy && (
                  <p style={{ marginTop: "0.5rem" }}>
                    <strong>What this means: </strong>
                    {meta.whenStale}
                  </p>
                )}

                <p
                  style={{
                    marginTop: "0.5rem",
                    color: "var(--color-muted)",
                    fontSize: "0.8125rem",
                  }}
                >
                  Counts as stale after {job.maxAgeHours ?? "—"}h
                  {job.rowsLastRun !== null ? ` · ${job.rowsLastRun} rows last run` : ""}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* --- Integrity --------------------------------------------------- */}
      <section className="admin-section">
        <h2 className="admin-h2">Integrity</h2>
        <p className="admin-note">
          These are the numbers that decide whether a restore is the right response at all.
        </p>
        <div className="table-scroll">
        <table className="admin-table">
          <tbody>
            {(
              [
                ["Ledger drift", integrity.ledgerDrift, "Wallets that disagree with the ledger"],
                [
                  "Duplicate redemptions",
                  integrity.duplicateRedemptions,
                  "One code granted twice to the same account",
                ],
                [
                  "Duplicate ledger keys",
                  integrity.duplicateLedgerKeys,
                  "The same idempotency key applied more than once",
                ],
                [
                  "Server errors, all time",
                  integrity.serverErrors,
                  "Unexplained 5xx across every route",
                ],
              ] as Array<[string, number, string]>
            ).map(([label, value, note]) => (
              <tr key={label}>
                <td style={{ fontWeight: 600 }}>{label}</td>
                <td>
                  <Pill tone={value === 0 ? "positive" : "critical"}>{value}</Pill>
                </td>
                <td style={{ color: "var(--color-muted)" }}>{note}</td>
              </tr>
            ))}
            <tr>
              <td style={{ fontWeight: 600 }}>Append-only triggers</td>
              <td>
                <Pill tone={integrity.appendOnlyTriggers === 2 ? "positive" : "critical"}>
                  {integrity.appendOnlyTriggers} of 2
                </Pill>
              </td>
              <td style={{ color: "var(--color-muted)" }}>
                The ledger and audit trail refuse to be rewritten
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      {/* --- How far back we can go -------------------------------------- */}
      <section className="admin-section">
        <h2 className="admin-h2">How far back we can recover</h2>
        <div className="table-scroll">
        <table className="admin-table">
          <tbody>
            <tr>
              <td style={{ fontWeight: 600 }}>Point-in-time</td>
              <td>{info.windows.pitrHours} hours</td>
              <td style={{ color: "var(--color-muted)" }}>
                Any moment in the window, no prior action needed
              </td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600 }}>Stored archives</td>
              <td>{info.windows.archiveRetentionDays} days</td>
              <td style={{ color: "var(--color-muted)" }}>
                Nightly, encrypted, only as good as the last successful run
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <p className="admin-note">
          Restoring is a deliberate procedure, not a button — it discards every write since the
          recovery point. The steps are in <code>docs/incident-runbook.md</code>. Archives are
          fetched from the Backup workflow by someone who already holds the decryption key, which
          is deliberately not stored in this application.
        </p>
      </section>

      {/* --- Recent runs -------------------------------------------------- */}
      <section className="admin-section">
        <h2 className="admin-h2">Recent runs</h2>
        <p className="admin-note">
          The last twenty, newest first. A job that keeps flapping shows up here even when its
          latest run happened to succeed.
        </p>
        <div className="table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Result</th>
              <th>Finished</th>
              <th>Took</th>
              <th>Rows</th>
            </tr>
          </thead>
          <tbody>
            {info.history.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: "var(--color-muted)" }}>
                  Nothing recorded yet.
                </td>
              </tr>
            )}
            {info.history.map((run, i) => (
              <tr key={`${run.job}-${run.finishedAt}-${i}`}>
                <td>{JOBS[run.job]?.title ?? run.job}</td>
                <td>
                  <Pill tone={run.status === "ok" ? "positive" : "critical"}>{run.status}</Pill>
                  {run.error && (
                    <div
                      style={{
                        color: "var(--color-muted)",
                        fontSize: "0.8125rem",
                        marginTop: "0.25rem",
                      }}
                    >
                      {run.error}
                    </div>
                  )}
                </td>
                <td>{formatRelative(run.finishedAt)}</td>
                <td>{(run.durationMs / 1000).toFixed(1)}s</td>
                <td>{run.rows}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <p className="admin-note">
        Related: <Link to="../system">System</Link> · <Link to="../performance">Performance</Link>
      </p>

      <style>{`
        .admin-section { margin-bottom: 2.75rem; }
        .admin-h2 { font-size: var(--text-h3); margin: 0 0 1rem; }
        .admin-note { margin: 1rem 0 0; color: var(--color-muted); font-size: var(--text-fine);
          max-width: 64ch; }
        .table-scroll { overflow-x: auto; }
        .admin-table { width: 100%; border-collapse: collapse; font-size: var(--text-fine);
          min-width: 36rem; }
        .admin-table th { text-align: left; padding: .5rem .75rem; color: var(--color-muted);
          border-bottom: 1px solid var(--color-rule); font-weight: 500; white-space: nowrap; }
        .admin-table td { padding: .625rem .75rem; border-bottom: 1px solid var(--color-hairline);
          vertical-align: top; }
        /* One card per protection. The left rule is the status at a glance,
           so an unhealthy job reads as different before any text is parsed. */
        .recovery-card { border: 1px solid var(--color-hairline); border-radius: .5rem;
          padding: 1rem 1.125rem; }
        .recovery-alert { border-left: 3px solid var(--color-loop); }
      `}</style>
    </>
  );
}
