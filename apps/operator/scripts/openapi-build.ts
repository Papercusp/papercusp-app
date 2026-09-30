#!/usr/bin/env -S npx tsx
/**
 * openapi-build — emit the OpenAPI 3.1 document for the projected-tool
 * surface to a checked-in snapshot file, OR verify the snapshot is
 * current.
 *
 * Phase 7 step 3 (build artifact) + step 5 (CI drift gate), combined.
 *
 *   cd apps/operator && npx tsx scripts/openapi-build.ts          # write
 *   cd apps/operator && npx tsx scripts/openapi-build.ts --check  # verify
 *   OPERATOR_BASE_URL=http://localhost:3055 npx tsx scripts/openapi-build.ts
 *
 * The document is sourced by fetching the canonical runtime route
 * GET /api/openapi.json from a running operator. The script does NOT
 * import the tool registry directly: the operator-side tool barrel
 * (lib/agent-tools/index.ts) transitively imports Next-coupled modules
 * (`server-only`, next/headers) that don't resolve under plain tsx.
 * The runtime route is the catalog's real home anyway — this script
 * just persists a snapshot of it.
 *
 * Write mode: fetch, pretty-print, write openapi.snapshot.json.
 * Check mode: fetch, compare against the checked-in snapshot, exit 1
 *   with a diff hint if they differ. The CI gate — a PR that changes a
 *   tool's args/events without regenerating the snapshot fails here.
 *
 * Requires a running operator. CI that wants the drift gate already
 * boots one for the e2e suite; point OPERATOR_BASE_URL at it.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '..', 'openapi.snapshot.json');
const BASE_URL = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3055';

async function fetchDocument(): Promise<string> {
  const url = `${BASE_URL}/api/openapi.json`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(
      `[openapi-build] could not reach ${url}\n` +
        `  Start the operator (cd papercusp-desktop && npm run dev) or set\n` +
        `  OPERATOR_BASE_URL to a running instance.\n` +
        `  ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`[openapi-build] ${url} returned HTTP ${res.status}`);
    process.exit(1);
  }
  const doc = await res.json();
  // Re-serialize locally so formatting is ours, not the route's
  // NextResponse.json() default. Trailing newline → git-diff-friendly.
  return JSON.stringify(doc, null, 2) + '\n';
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const built = await fetchDocument();
  const toolCount = Object.keys(
    (JSON.parse(built) as { paths: Record<string, unknown> }).paths,
  ).length;

  if (check) {
    if (!existsSync(SNAPSHOT_PATH)) {
      console.error(
        `[openapi-build] --check: snapshot missing at ${SNAPSHOT_PATH}\n` +
          `  Run \`npx tsx scripts/openapi-build.ts\` and commit the result.`,
      );
      process.exit(1);
    }
    const current = readFileSync(SNAPSHOT_PATH, 'utf8');
    if (current !== built) {
      console.error(
        `[openapi-build] --check: openapi.snapshot.json is STALE.\n` +
          `  The projected-tool surface changed but the snapshot wasn't regenerated.\n` +
          `  Run \`npx tsx scripts/openapi-build.ts\` and commit openapi.snapshot.json.`,
      );
      process.exit(1);
    }
    console.log(`[openapi-build] --check: snapshot current (${toolCount} operations).`);
    return;
  }

  writeFileSync(SNAPSHOT_PATH, built);
  console.log(`[openapi-build] wrote ${SNAPSHOT_PATH} (${toolCount} operations).`);
}

void main();
