/**
 * Reading apps/web/wrangler.jsonc from a script.
 *
 * Shared because two scripts were each reaching into this file their own way,
 * and the second did it by slicing the text between `"staging"` and
 * `"production"` — which silently stops meaning anything the moment an
 * environment is added, renamed, or reordered.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./_env";

/**
 * Strip comments and trailing commas from JSONC.
 *
 * String-aware on purpose: wrangler.jsonc is full of `"https://..."` values,
 * and a naive `//` strip truncates the config at the first URL — producing a
 * parse error that reads like a corrupt file rather than a bad stripper.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export interface WranglerEnv {
  hyperdrive?: Array<{ binding: string; id: string }>;
  triggers?: { crons?: string[] };
  routes?: unknown;
  vars?: Record<string, unknown>;
}

export interface WranglerConfig {
  hyperdrive?: Array<{ binding: string; id: string }>;
  env?: Record<string, WranglerEnv>;
}

/** The parsed config. */
export function wranglerConfig(): WranglerConfig {
  const file = path.join(repoRoot, "apps", "web", "wrangler.jsonc");
  return parseJsonc(readFileSync(file, "utf8")) as WranglerConfig;
}

/** One deployed environment's block, or undefined if it is not declared. */
export function wranglerEnv(name: string): WranglerEnv | undefined {
  return wranglerConfig().env?.[name];
}

/**
 * Every deployed environment's Hyperdrive id, keyed by environment name.
 * Exits rather than returning an empty map: a caller that got none would go on
 * to report "unknown environment" for an environment that plainly exists.
 */
export function hyperdriveIdsByEnv(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [name, env] of Object.entries(wranglerConfig().env ?? {})) {
    const id = env.hyperdrive?.find((h) => h.binding === "HYPERDRIVE")?.id;
    if (id) ids.set(name, id);
  }
  if (ids.size === 0) {
    console.error("No environment Hyperdrive bindings found in apps/web/wrangler.jsonc.");
    process.exit(1);
  }
  return ids;
}
