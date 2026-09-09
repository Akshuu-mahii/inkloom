/**
 * Secret scanner.
 *
 *   pnpm secrets:check
 *
 * Two jobs, both of which run in CI and fail the build:
 *
 *   1. Scan tracked source for anything that looks like a live credential.
 *   2. Scan the BUILT CLIENT BUNDLE for server-side secrets. This is the check
 *      that actually matters — a secret can be perfectly safe in a server file
 *      and catastrophic if a bundler inlines it into JavaScript the browser
 *      downloads.
 *
 * `.env.example` is scanned too, but its deliberate `dev-only-...` placeholders
 * are allowlisted: they exist precisely so nobody is tempted to paste a real
 * value there, and the config loader refuses to boot on them outside
 * development.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./_env";

interface Rule {
  name: string;
  pattern: RegExp;
  /** Matches that are known-safe (placeholders, test keys, examples). */
  allow?: RegExp[];
  /**
   * Skip this rule inside test files.
   *
   * Only ever set on the low-confidence NAME-SHAPE heuristic. Test suites are
   * full of literal fixture passwords by necessity — they have to sign in as
   * somebody — and flagging every one of them trains people to ignore the
   * scanner, which is worse than the narrow gap it closes.
   *
   * Every high-confidence rule (real key formats, private key blocks, live
   * connection strings) still applies to test files, because a genuine
   * credential pasted into a test is exactly as leaked as one pasted anywhere
   * else.
   */
  skipInTests?: boolean;
}

/** Test and fixture paths, for `skipInTests`. */
const TEST_PATH = /(?:__tests__|[./](?:test|spec)s?[./]|\.test\.|\.spec\.|^e2e\/|\/e2e\/)/;

const RULES: Rule[] = [
  {
    name: "AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "Private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: "Resend API key",
    pattern: /\bre_[A-Za-z0-9]{20,}\b/,
  },
  {
    name: "Stripe secret key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/,
  },
  {
    name: "GitHub token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  },
  {
    name: "Google OAuth client secret",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    name: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: "Postgres URL with a non-local password",
    pattern: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{6,}@(?!localhost|127\.0\.0\.1|postgres\b)/,
    allow: [/inkloom_local_dev/],
  },
  {
    name: "Hardcoded assignment to a secret-looking name",
    skipInTests: true,
    pattern:
      /\b(?:SECRET|PEPPER|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*[:=]\s*["'`][^"'`\n]{12,}["'`]/i,
    allow: [
      // Deliberate placeholders in .env.example — never valid outside dev.
      /dev-only-insecure/,
      // Cloudflare's published always-passing Turnstile test keys.
      /1x0{6,}/,
      // Test fixtures, which are obviously fake by their own text.
      /test-(?:secret|pepper|access-code|ip-hash)/,
      /integration-test-pepper/,
      /a-perfectly-fine-passphrase/,
      // Reading from the environment is the correct pattern, not a finding.
      /process\.env\./,
      /env\[["']/,
      // Type declarations and schema definitions, not values.
      /z\.string\(\)/,
      /:\s*string\b/,
    ],
  },
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".react-router",
  ".wrangler",
  "coverage",
  "playwright-report",
  "test-results",
]);

const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".jsonc",
  ".md",
  ".sql",
  ".example",
  ".sh",
  ".html",
  ".css",
]);

interface Finding {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.has(path.extname(entry)) || entry === ".env.example") out.push(full);
  }
  return out;
}

function scanFile(file: string): Finding[] {
  const findings: Finding[] = [];
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const relative = path.relative(repoRoot, file);
  const isTest = TEST_PATH.test(relative);

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.skipInTests && isTest) continue;
      if (!rule.pattern.test(line)) continue;
      if (rule.allow?.some((allow) => allow.test(line))) continue;
      findings.push({
        file: path.relative(repoRoot, file),
        line: index + 1,
        rule: rule.name,
        // Truncated: the report itself must not become a place a secret lives.
        excerpt: `${line.trim().slice(0, 60)}…`,
      });
    }
  });

  return findings;
}

/**
 * Server-side values that must NEVER appear in a client bundle, matched by
 * variable name. A bundler that inlines one of these has turned a server secret
 * into a public one.
 */
const CLIENT_FORBIDDEN = [
  "BETTER_AUTH_SECRET",
  "ACCESS_CODE_PEPPER",
  "IP_HASH_PEPPER",
  "RESEND_API_KEY",
  "TURNSTILE_SECRET_KEY",
  "GOOGLE_CLIENT_SECRET",
  "DATABASE_URL",
];

function scanClientBundle(): Finding[] {
  const clientDir = path.join(repoRoot, "apps", "web", "build", "client");
  let files: string[];
  try {
    files = walk(clientDir);
  } catch {
    console.log("  (no client build found — run `pnpm build` to scan the bundle)");
    return [];
  }

  const findings: Finding[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const name of CLIENT_FORBIDDEN) {
      if (content.includes(name)) {
        findings.push({
          file: path.relative(repoRoot, file),
          line: 0,
          rule: `Server secret name "${name}" present in the CLIENT bundle`,
          excerpt: "(a server-only value must never be bundled for the browser)",
        });
      }
    }
    // The pepper and auth secret are high-entropy; catch a leaked VALUE even if
    // the variable name was minified away.
    for (const envKey of ["ACCESS_CODE_PEPPER", "BETTER_AUTH_SECRET", "IP_HASH_PEPPER"]) {
      const value = process.env[envKey];
      if (
        value &&
        value.length >= 16 &&
        !value.startsWith("dev-only-") &&
        content.includes(value)
      ) {
        findings.push({
          file: path.relative(repoRoot, file),
          line: 0,
          rule: `VALUE of ${envKey} found in the CLIENT bundle`,
          excerpt: "(redacted)",
        });
      }
    }
  }
  return findings;
}

function main() {
  console.log("\n  Scanning source for committed secrets…");
  const sourceFindings = walk(repoRoot).flatMap(scanFile);

  console.log("  Scanning the client bundle for server-side secrets…");
  const bundleFindings = scanClientBundle();

  const findings = [...sourceFindings, ...bundleFindings];

  if (findings.length === 0) {
    console.log("\n  No secrets found in source or client bundle.\n");
    process.exit(0);
  }

  console.log(`\n  ${findings.length} potential secret(s):\n`);
  for (const finding of findings) {
    const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.log(`    ${where}`);
    console.log(`      ${finding.rule}`);
    console.log(`      ${finding.excerpt}\n`);
  }
  console.log("  If one is a false positive, add an `allow` pattern in scripts/check-secrets.ts.");
  console.log("  If one is real: rotate it first, then remove it from history.\n");
  process.exit(1);
}

main();
