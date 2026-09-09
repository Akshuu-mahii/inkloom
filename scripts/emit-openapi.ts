/**
 * Emit the OpenAPI document to `openapi.json`.
 *
 *   pnpm openapi:emit
 *
 * Run in CI so a schema change that is not reflected in the spec shows up as a
 * diff rather than as drift nobody notices.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "@inkloom/api/openapi";
import { optional, repoRoot } from "./_env";

const document = buildOpenApiDocument(optional("APP_URL", "https://inkloom.com"));
const target = path.join(repoRoot, "openapi.json");

writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

const paths = Object.keys(document.paths).length;
const operations = Object.values(document.paths).reduce(
  (total, item) => total + Object.keys(item as object).length,
  0,
);

console.log(`\n  Wrote openapi.json — ${paths} paths, ${operations} operations.\n`);
