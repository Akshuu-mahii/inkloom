/**
 * No page may hardcode the console's URL.
 *
 * `ADMIN_PATH` is a deployment secret. When it is set, "/admin" is a DECOY that
 * returns 404 for everyone — so a literal "/admin" in a link is not a cosmetic
 * slip, it is a link that works locally and is guaranteed to fail in every
 * deployed environment, for the one person allowed to use it.
 *
 * That happened. The dashboard's staff "Admin" link was written as
 * `<Link to="/admin">`, which is correct in development (where ADMIN_PATH is
 * unset and the route really is at /admin) and points at the decoy anywhere the
 * secret is configured. It survived 103 end-to-end tests for the same reason:
 * they run with ADMIN_PATH unset, so the decoy never engages and the wrong link
 * is indistinguishable from the right one.
 *
 * A source-level assertion rather than a browser test, because the only
 * environment that reproduces the failure is one with a secret path configured
 * — which is precisely the environment tests do not run in.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Every .ts/.tsx file under app/, except the console's own routes. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/*
 * routes/admin/** is exempt: inside the console, links are built with
 * `adminUrl(adminPath, …)` from the layout's loader data, and routes.ts is
 * where the prefix is legitimately read from the environment.
 */
const EXEMPT = [join("routes", "admin"), "routes.ts"];

const isExempt = (file: string) => {
  const rel = relative(APP_DIR, file);
  return EXEMPT.some((e) => rel === e || rel.startsWith(e));
};

describe("the console's URL is never hardcoded", () => {
  it("has no literal /admin link outside the console's own routes", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(APP_DIR)) {
      if (isExempt(file)) continue;
      /*
       * Comments are blanked, not skipped, so line numbers still point at the
       * real line. Prose about the decoy — including the paragraph in
       * routes/app/layout.tsx explaining this exact bug — is not a link, and a
       * guard that fires on its own documentation gets deleted rather than
       * fixed.
       */
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

      source.split("\n").forEach((line, index) => {
        // `to="/admin"`, `to='/admin/...'`, href, redirect("/admin"), etc.
        if (/["'`]\/admin(?:\/[^"'`]*)?["'`]/.test(line)) {
          offenders.push(`${relative(APP_DIR, file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Hardcoded console URLs found. With ADMIN_PATH set these point at the 404 ` +
        `decoy. Take the path from a loader instead:\n\n${offenders.join("\n")}\n`,
    ).toEqual([]);
  });

  it("still finds files to check, so the guard cannot pass by scanning nothing", () => {
    const checked = sourceFiles(APP_DIR).filter((f) => !isExempt(f));

    expect(checked.length).toBeGreaterThan(20);
  });
});
