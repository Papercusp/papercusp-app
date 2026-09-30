/**
 * Nightly Layer 1 memory-anchor audit CLI.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 5 P-019).
 *
 * Loads all memory_canonical rows + their memory_anchors, runs the
 * structural check via `lib/memory/audit-anchors.runAnchorAudit`,
 * writes back:
 *   - memory_anchors.last_checked_at + last_check_ok
 *   - memory_canonical.state = 'broken_anchor' (when any anchor fails)
 *
 * Skip-paths (graceful):
 *   - Migration 085 not applied → log + exit 0 (script is a no-op until
 *     the schema lands)
 *   - PG unreachable → log + exit 1
 *
 * Runs nightly via systemd-timer or cron. Manual invocation is fine
 * for ad-hoc audits.
 *
 * Usage:
 *   tsx apps/operator/bin/audit-memory-anchors.ts            # full run
 *   tsx apps/operator/bin/audit-memory-anchors.ts --dry-run  # report only
 */

import * as path from 'node:path';
import {
  runAnchorAudit,
  fileChecker,
  planCheckerPg,
  migrationChecker,
  featureChecker,
  type AuditCheckers,
  type MemoryWithAnchors,
} from './audit-anchors';
import { pgClientFields } from './mem0-connection';
import { detectPapercupRoot } from '../harness/register-papercusp';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '../util/cli-entry';

interface CliOptions {
  dryRun: boolean;
  repoRoot: string;
}

function parseArgs(argv: string[]): CliOptions {
  const dryRun = argv.includes('--dry-run');
  // Repo root: detect the papercup checkout (markers: apps/operator + libs/papercusp
  // package.json), falling back to the path relative to THIS file. This file lives at
  // packages/operator-core/lib/memory/ → FOUR levels up is the repo root. (The old
  // `..×3` calc was a stale carry-over from when the CLI lived at apps/operator/bin/;
  // it resolved to `…/packages` and made the fileChecker stat anchors against the
  // wrong root — every file anchor false-flagged.) operator-core is "type":"module",
  // so `__dirname` isn't defined under ESM — derive the dir from import.meta.url.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = detectPapercupRoot() ?? path.resolve(here, '..', '..', '..', '..');
  return { dryRun, repoRoot };
}

interface AuditState {
  memories: MemoryWithAnchors[];
  /** Map memory_id → current state column. */
  states: Map<string, string>;
}

async function loadAuditState(client: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<AuditState | null> {
  // Probe migration 085. If memory_anchors doesn't exist, we're not
  // ready to audit — skip cleanly.
  try {
    await client.query(
      `SELECT 1 FROM harness_shared.memory_anchors LIMIT 1`,
    );
  } catch {
    return null;
  }

  type AnchorRow = {
    memory_id: string;
    kind: string;
    value: string;
    state: string;
  };
  const res = await client.query(
    `SELECT a.memory_id, a.kind, a.value, c.state
     FROM harness_shared.memory_anchors a
     JOIN harness_shared.memory_canonical c ON c.id = a.memory_id
     ORDER BY a.memory_id, a.kind, a.value`,
  );

  const byMem = new Map<string, MemoryWithAnchors>();
  const states = new Map<string, string>();
  for (const r of res.rows as AnchorRow[]) {
    states.set(r.memory_id, r.state);
    const existing = byMem.get(r.memory_id);
    if (existing) {
      existing.anchors.push({
        kind: r.kind as 'file' | 'feature' | 'plan' | 'migration' | 'symbol',
        value: r.value,
      });
    } else {
      byMem.set(r.memory_id, {
        memoryId: r.memory_id,
        anchors: [{
          kind: r.kind as 'file' | 'feature' | 'plan' | 'migration' | 'symbol',
          value: r.value,
        }],
      });
    }
  }

  return { memories: [...byMem.values()], states };
}

async function writeAuditResults(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  results: ReturnType<typeof runAnchorAudit> extends Promise<infer R> ? R : never,
  prevStates: Map<string, string>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  const now = new Date().toISOString();

  // Stamp every anchor's last_checked_at + ok
  for (const mem of results.all) {
    for (const a of mem.anchors) {
      await client.query(
        `UPDATE harness_shared.memory_anchors
         SET last_checked_at = $1, last_check_ok = $2
         WHERE memory_id = $3 AND kind = $4 AND value = $5`,
        [now, a.ok, mem.memoryId, a.anchor.kind, a.anchor.value],
      );
    }
  }

  // Flip parent memory state: broken_anchor when any anchor failed.
  // When a previously-broken memory's anchors all pass now, restore to
  // 'active' (but only if it was previously broken-because-of-anchors;
  // don't clobber 'superseded' / 'contradicted' states).
  for (const mem of results.all) {
    const prev = prevStates.get(mem.memoryId) ?? 'active';
    if (mem.hasBroken && prev !== 'broken_anchor') {
      await client.query(
        `UPDATE harness_shared.memory_canonical
         SET state = 'broken_anchor', updated_at = $1
         WHERE id = $2`,
        [now, mem.memoryId],
      );
    } else if (!mem.hasBroken && prev === 'broken_anchor') {
      await client.query(
        `UPDATE harness_shared.memory_canonical
         SET state = 'active', updated_at = $1
         WHERE id = $2`,
        [now, mem.memoryId],
      );
    }
  }
}

async function buildCheckers(
  opts: CliOptions,
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
): Promise<AuditCheckers> {
  return {
    file: fileChecker(opts.repoRoot),
    // Plans went PG-canonical (plans-pg-canonical-migration-2026-06-03): a
    // 'plan' anchor is valid iff a harness_plans row exists for the slug.
    plan: planCheckerPg(async (planSlug) => {
      const r = await client.query(
        'SELECT 1 FROM harness_shared.harness_plans WHERE plan_slug = $1 LIMIT 1',
        [planSlug],
      );
      return r.rows.length > 0;
    }),
    migration: migrationChecker(
      path.join(opts.repoRoot, 'libs', 'papercusp', 'libs', 'db', 'sql'),
    ),
    feature: featureChecker(async () => {
      // No-op until the harness_features query is wired. Until then
      // every feature anchor passes — Layer 1 catches file / plan /
      // migration breakage; feature staleness comes later.
      return true;
    }),
    // symbol checker stays default (skip — deferred to Layer 3)
  };
}

export async function audit(opts: CliOptions): Promise<{
  skipped: boolean;
  ok?: boolean;
  summary?: string;
}> {
  // Lazy-require pg so unit tests can import this module without a
  // live pg dep (the CLI side wires real pg below).
  const { Client } = await import('pg');
  const fields = await pgClientFields();
  const client = new Client(fields);
  await client.connect();

  try {
    const state = await loadAuditState(client as { query: typeof client.query });
    if (state === null) {
      console.log('audit-memory-anchors: migration 085 not applied yet — skipping');
      return { skipped: true };
    }
    if (state.memories.length === 0) {
      console.log('audit-memory-anchors: zero memories with anchors — nothing to do');
      return { skipped: false, ok: true, summary: 'empty' };
    }

    const checkers = await buildCheckers(opts, client as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> });
    const report = await runAnchorAudit({ memories: state.memories, checkers });
    await writeAuditResults(client as { query: typeof client.query }, report, state.states, opts.dryRun);

    const summary = [
      `checked=${report.memoriesChecked}`,
      `anchors=${report.anchorsChecked}`,
      `broken_anchors=${report.anchorsBroken}`,
      `broken_memories=${report.memoriesBroken}`,
      opts.dryRun ? '(dry-run, no writes)' : '',
    ].filter(Boolean).join(' ');
    console.log(`audit-memory-anchors: ${summary}`);
    return { skipped: false, ok: true, summary };
  } finally {
    await client.end();
  }
}

/**
 * Single-run wrapper for the periodic scheduler (dbos/periodic-workflows.ts).
 * Resolves the repo root via {@link detectPapercupRoot} and SKIPS when there is
 * none (a packaged install / non-repo cwd) — so a source-less host never marks
 * every file anchor `broken_anchor`. Deps are injected so the skip + pass-through
 * logic is unit-testable without a live pg connection.
 */
export async function runMemoryAnchorAuditOnce(opts: {
  dryRun?: boolean;
  /** Override the repo-root resolver (test seam). */
  resolveRepoRoot?: () => string | null;
  /** Override the audit runner (test seam). */
  auditFn?: (o: CliOptions) => Promise<{ skipped: boolean; ok?: boolean; summary?: string }>;
} = {}): Promise<{ skipped: boolean; ok?: boolean; summary?: string; reason?: string }> {
  const resolveRepoRoot = opts.resolveRepoRoot ?? detectPapercupRoot;
  const repoRoot = resolveRepoRoot();
  if (!repoRoot) {
    return {
      skipped: true,
      reason: 'no repo root (packaged install / non-repo cwd) — memory-anchor audit skipped',
    };
  }
  const auditFn = opts.auditFn ?? audit;
  return auditFn({ dryRun: opts.dryRun ?? false, repoRoot });
}

// CLI entry — ESM-safe (operator-core is "type":"module"). The old
// `require.main === module` threw `require is not defined` under ESM, so the
// module crashed the instant it was *imported* (e.g. by the DBOS periodic
// registry) — which would have taken down every scheduled timer. isCliEntry()
// is the bundle-safe ESM equivalent: fires only on a direct
// `tsx …/audit-memory-anchors.ts` invocation, never on import (scheduler /
// tests) and never when inlined into the desktop sidecar bundle (EI-650).
if (isCliEntry(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  audit(opts).then(
    (r) => process.exit(r.skipped ? 0 : (r.ok ? 0 : 1)),
    (err) => {
      console.error('audit-memory-anchors: failed', err);
      process.exit(1);
    },
  );
}
