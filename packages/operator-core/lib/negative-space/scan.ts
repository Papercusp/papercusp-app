/**
 * scan.ts — the negative-space miner's PG + capture glue
 * (self-learning-frontier-2026-06-12 P-010 / FB-04).
 *
 * One tick = recompute the demand map + file the capped candidates:
 *
 *   1. read zero-hit docs:search / plans:search / memory:search rows from
 *      harness_shared.tool_invocations over a trailing window (the hit counts
 *      the handlers emit via ctx.metadata: docs `hit_count`, plans/memory
 *      `count`; the query is args_json->>'query');
 *   2. aggregate (miner-core, pure) and REWRITE
 *      harness_shared.negative_space_demand for the workspace — idempotent,
 *      no watermark; only candidate_improvement_id survives the rewrite;
 *   3. file the capped candidate set as kind=change improvements through the
 *      shared capture core (search-first dedup + watchdogKey — the existing
 *      anti-flood path), stamping each filed id back onto its demand row.
 *
 * Workspace scoping mirrors collectToolErrorSignals (watchdog audit P-013):
 * the given workspace PLUS the box-global buckets ('*' — unscoped SU
 * sessions, the bulk of real traffic — and the coord workspace).
 *
 * Deps are injectable so the tick is unit-testable without PG; the flag gate
 * lives in the routine action (negative-space-action.ts), not here.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import {
  aggregateZeroHits,
  selectDemandCandidates,
  classifyDemandEntry,
  demandWatchdogKey,
  demandCaptureTitle,
  demandCaptureBody,
  isReferenceShapedQuery,
  type DemandEntry,
  type DemandFilingOptions,
  type DemandSurface,
  type ZeroHitRow,
} from './miner-core';
import {
  captureImprovement,
  type CaptureImprovementInput,
  type CaptureImprovementResult,
} from '../harness/improvements/capture-core';

export const DEFAULT_WINDOW_DAYS = 30;
/** Row-fetch safety ceiling — zero-hit rows in a window, not all searches. */
const READ_LIMIT = 20_000;

export interface NegativeSpaceTickOptions extends DemandFilingOptions {
  /** Trailing mining window in days. Default 30. */
  windowDays?: number;
}

/** Injectable seams (tests run the tick without PG). */
export interface NegativeSpaceTickDeps {
  readRows: (workspaceId: string, windowDays: number) => Promise<ZeroHitRow[]>;
  persist: (workspaceId: string, entries: DemandEntry[]) => Promise<DemandEntry[]>;
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  markFiled: (workspaceId: string, entry: DemandEntry, improvementId: string) => Promise<void>;
  /**
   * Does the demanded artifact actually EXIST under this exact identifier?
   * Returns its ref (`plan:<slug>` / `doc:<slug>` / `memory-anchor:<value>`) or
   * null. Drives the kind-fidelity split (frontier P-044): exists + zero-hit =
   * resolution gap (kind=bug, EI-397 shape); absent = missing knowledge
   * (kind=change). Only called for reference-shaped queries; absent dep ⇒
   * never bug-shaped.
   */
  probeArtifact?: (surface: DemandSurface, queryNorm: string) => Promise<string | null>;
  log?: (message: string) => void;
}

export interface NegativeSpaceTickResult {
  scanned: number;
  demandEntries: number;
  /** Improvement ids filed this tick. */
  filed: string[];
  /** Candidates the capture core declined (likely-duplicate / stale-evidence). */
  declined: number;
}

/** Zero-hit search invocations over the window — the raw demand signal. */
export async function readZeroHitRows(sql: Sql, workspaceId: string, windowDays: number): Promise<ZeroHitRow[]> {
  const scopes = [...new Set([workspaceId, '*', DEFAULT_COORD_WORKSPACE])];
  const rows = await sql<
    { tool_name: string; query: string | null; agent: string | null; invoked_at: string | Date }[]
  >`
    SELECT tool_name,
           args_json->>'query' AS query,
           COALESCE(NULLIF(spawn_id, ''), NULLIF(role, ''), 'unknown') AS agent,
           invoked_at
      FROM harness_shared.tool_invocations
     WHERE status = 'ok'
       AND invoked_at > now() - make_interval(days => ${windowDays})
       AND workspace_id = ANY(${scopes}::text[])
       AND args_json->>'query' IS NOT NULL
       AND (
             (tool_name = 'docs:search' AND (metadata_json->>'hit_count')::int = 0)
          OR (tool_name IN ('plans:search', 'memory:search') AND (metadata_json->>'count')::int = 0)
       )
     ORDER BY invoked_at DESC
     LIMIT ${READ_LIMIT}`;
  return rows
    .filter((r) => typeof r.query === 'string' && r.query !== '')
    .map((r) => ({
      toolName: r.tool_name,
      query: r.query as string,
      agent: r.agent ?? 'unknown',
      invokedAt: r.invoked_at instanceof Date ? r.invoked_at.toISOString() : String(r.invoked_at),
    }));
}

/**
 * Rewrite the workspace's demand map in one transaction, carrying
 * candidate_improvement_id forward from the previous generation (a filed
 * candidate must never re-file after a re-mine). Returns the persisted
 * entries with filed ids merged in.
 */
export async function persistDemandMap(sql: Sql, workspaceId: string, entries: DemandEntry[]): Promise<DemandEntry[]> {
  const filed = await sql<{ surface: string; query_norm: string; candidate_improvement_id: string }[]>`
    SELECT surface, query_norm, candidate_improvement_id
      FROM harness_shared.negative_space_demand
     WHERE workspace_id = ${workspaceId}
       AND candidate_improvement_id IS NOT NULL`;
  const filedByKey = new Map(filed.map((r) => [`${r.surface} ${r.query_norm}`, r.candidate_improvement_id]));
  const merged = entries.map((e) => ({
    ...e,
    candidateImprovementId: e.candidateImprovementId ?? filedByKey.get(`${e.surface} ${e.queryNorm}`) ?? null,
  }));
  await sql.begin(async (tx) => {
    await tx`DELETE FROM harness_shared.negative_space_demand WHERE workspace_id = ${workspaceId}`;
    for (const e of merged) {
      await tx`
        INSERT INTO harness_shared.negative_space_demand
          (workspace_id, surface, query_norm, example_query, miss_count, distinct_agents,
           first_missed_at, last_missed_at, candidate_improvement_id, updated_at)
        VALUES (${workspaceId}, ${e.surface}, ${e.queryNorm}, ${e.exampleQuery}, ${e.missCount},
                ${e.distinctAgents}, ${e.firstMissedAt}, ${e.lastMissedAt},
                ${e.candidateImprovementId ?? null}, now())`;
    }
  });
  return merged;
}

/** Stamp a filed candidate's improvement id onto its demand row. */
export async function markDemandFiled(
  sql: Sql,
  workspaceId: string,
  entry: Pick<DemandEntry, 'surface' | 'queryNorm'>,
  improvementId: string,
): Promise<void> {
  await sql`
    UPDATE harness_shared.negative_space_demand
       SET candidate_improvement_id = ${improvementId}, updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND surface = ${entry.surface}
       AND query_norm = ${entry.queryNorm}`;
}

// packages/operator-core/lib/negative-space → repo root. ESM-safe: bare
// `__dirname` is UNDEFINED under tsx file-mode in this type:module package —
// never use __dirname in operator-core (the neologism miner carries the same note).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOCS_CONTENT_DIR = join(REPO_ROOT, 'apps/operator-docs/src/content/docs');

/**
 * The live artifact probe behind the kind-fidelity split (frontier P-044):
 *   plans  — exact plan_slug anywhere in harness_shared.harness_plans (the
 *            EI-397 case: harness-scoped agents zero-hitting an operator-scope
 *            plan they name exactly);
 *   docs   — a page whose slug (basename or section/slug path) equals the
 *            query, in the MDX corpus (missing corpus degrades to null, the
 *            neologism reader's stripped-deploy-tree rule);
 *   memory — an ACTIVE memory whose anchor (file/plan/symbol/feature/migration)
 *            value equals the query exactly: the record exists under that exact
 *            identifier yet recall zero-hit it. memory_anchors ARE the
 *            identifier-keyed index (the cosine + lexical recall legs are
 *            similarity-based, which is why the original FB-18 probe left this
 *            null); the reference-shaped gate keeps collision-prone bare words
 *            from ever reaching here.
 * Never throws: a probe failure means "not proven to exist" — the candidate
 * files in today's change shape rather than a falsely-confident bug.
 */
export async function probeDemandArtifact(
  sql: Sql,
  surface: DemandSurface,
  queryNorm: string,
  docsDir: string = DOCS_CONTENT_DIR,
): Promise<string | null> {
  try {
    if (surface === 'plans') {
      const rows = await sql<{ plan_slug: string }[]>`
        SELECT plan_slug FROM harness_shared.harness_plans
         WHERE plan_slug = ${queryNorm}
         LIMIT 1`;
      return rows.length > 0 ? `plan:${rows[0].plan_slug}` : null;
    }
    if (surface === 'docs') {
      const entries = await readdir(docsDir, { recursive: true, withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !/\.mdx?$/.test(e.name)) continue;
        const full = join(e.parentPath, e.name);
        const rel = full.startsWith(docsDir) ? full.slice(docsDir.length).replace(/^\//, '') : e.name;
        const relSlug = rel.replace(/\.mdx?$/, '').toLowerCase();
        const baseSlug = e.name.replace(/\.mdx?$/, '').toLowerCase();
        if (baseSlug === queryNorm || relSlug === queryNorm) return `doc:${relSlug}`;
      }
      return null;
    }
    if (surface === 'memory') {
      // An ACTIVE memory anchored to this exact value that a memory:search
      // still zero-hit is a recall RESOLUTION GAP, not missing knowledge — the
      // record exists under that exact identifier (anchors are the
      // identifier-keyed index; cosine/lexical recall is similarity-based).
      // Global match mirrors the cross-scope plans probe (the EI-397 shape). A
      // non-active (forgotten/superseded/…) memory is a deliberate removal, not
      // a gap — state='active' only.
      const rows = await sql<{ value: string }[]>`
        SELECT a.value
          FROM harness_shared.memory_anchors a
          JOIN harness_shared.memory_canonical m ON m.id = a.memory_id
         WHERE m.state = 'active'
           AND lower(a.value) = ${queryNorm}
         LIMIT 1`;
      return rows.length > 0 ? `memory-anchor:${rows[0].value}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The live PG-backed deps (the routine action's default wiring). */
export function defaultNegativeSpaceDeps(sql: Sql): NegativeSpaceTickDeps {
  return {
    readRows: (ws, windowDays) => readZeroHitRows(sql, ws, windowDays),
    persist: (ws, entries) => persistDemandMap(sql, ws, entries),
    capture: (input) => captureImprovement(input),
    markFiled: (ws, entry, id) => markDemandFiled(sql, ws, entry, id),
    probeArtifact: (surface, queryNorm) => probeDemandArtifact(sql, surface, queryNorm),
    log: (m) => console.log(m),
  };
}

/** One mining tick: read → aggregate → persist → file capped candidates. */
export async function runNegativeSpaceTick(
  workspaceId: string,
  deps: NegativeSpaceTickDeps,
  opts: NegativeSpaceTickOptions = {},
): Promise<NegativeSpaceTickResult> {
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : DEFAULT_WINDOW_DAYS;
  const log = deps.log ?? (() => {});

  const rows = await deps.readRows(workspaceId, windowDays);
  const entries = await deps.persist(workspaceId, aggregateZeroHits(rows));

  const candidates = selectDemandCandidates(entries, opts);
  const filed: string[] = [];
  let declined = 0;
  for (const entry of candidates) {
    // Best-effort per candidate: one capture failure never aborts the tick.
    try {
      // Kind fidelity (frontier P-044): probe reference-shaped queries for an
      // existing artifact — exists + zero-hit = resolution gap (kind=bug, the
      // EI-397 shape); otherwise today's missing-knowledge change. A probe
      // failure degrades to null (change shape), never aborts the candidate.
      const artifactRef =
        deps.probeArtifact && isReferenceShapedQuery(entry.queryNorm)
          ? await deps.probeArtifact(entry.surface, entry.queryNorm).catch(() => null)
          : null;
      const classification = classifyDemandEntry(entry, artifactRef);
      const result = await deps.capture({
        title: demandCaptureTitle(entry, classification),
        kind: classification.kind,
        body: demandCaptureBody(entry, windowDays, classification),
        severity: classification.severity,
        findingClass: classification.findingClass,
        subTopic: 'negative-space',
        sourceRole: 'system',
        source: 'su',
        watchdogKey: demandWatchdogKey(entry),
        dedupScope: 'open',
        evidenceAt: entry.lastMissedAt,
        createdBy: 'system:negative-space-mine',
      });
      if (result.created && result.issue) {
        filed.push(result.issue.id);
        await deps.markFiled(workspaceId, entry, result.issue.id);
      } else {
        declined += 1;
        log(
          `[negative-space] declined "${entry.surface}:${entry.queryNorm}" (${result.reason ?? 'not created'})` +
            (result.possibleDuplicates[0] ? ` — likely ${result.possibleDuplicates[0].id}` : ''),
        );
      }
    } catch (e) {
      declined += 1;
      log(`[negative-space] capture FAILED for "${entry.surface}:${entry.queryNorm}": ${e instanceof Error ? e.message : e}`);
    }
  }

  if (entries.length > 0 || filed.length > 0) {
    // Nudge the Knowledge view's demand panel (learning.demand is not
    // table-backed for PG-trigger invalidation). Lazy + fire-and-forget.
    import('../sync-sse')
      .then((m) => m.notifySyncInvalidate('learning.demand'))
      .catch(() => {});
  }

  return { scanned: rows.length, demandEntries: entries.length, filed, declined };
}
