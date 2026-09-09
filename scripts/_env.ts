/**
 * Loads `.env` for CLI scripts and fails loudly on a missing variable, rather
 * than letting a script run against the wrong database because a var was blank.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(root, ".env"), quiet: true });

export function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`\n  Missing required environment variable: ${name}`);
    console.error(`  Copy .env.example to .env and fill it in.\n`);
    process.exit(1);
  }
  return value;
}

export function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export function describeTarget(connectionString: string): string {
  const u = new URL(connectionString);
  return `${u.pathname.slice(1)} @ ${u.host}`;
}

/** True when the connection string points at something that is clearly not local. */
export function looksRemote(connectionString: string): boolean {
  const host = new URL(connectionString).hostname;
  return !["localhost", "127.0.0.1", "::1", "postgres", "host.docker.internal"].includes(host);
}

export { root as repoRoot };
