/**
 * scan.ts — the neologism miner's PG + fs + capture glue
 * (self-learning-frontier-2026-06-12 P-011 / FB-05).
 *
 * One tick = recompute the emergent-term map + route the capped candidates
 * into Scout's improvement rail as abstraction proposals:
 *
 *   1. read prose coord envelopes (kind message / handoff / escalation /
 *      escalation_resolved) from harness_shared.coord_event_log over a
 *      trailing window, plus the insights corpus (agent-insights MDX) and
 *      the primitive namespaces (tool_invocations tool names, harness_shared
 *      + public table names, routine names/targets, flag keys);
 *   2. aggregate (miner-core, pure) — extract terms, drop namespace-covered
 *      ones, score emergence (recent-vs-prior growth, distinct speakers);
 *   3. file the capped candidate set through the shared capture core in
 *      Scout's proposal shape (improvementBody over a deterministic
 *      `Proposal` — D-007's improvement rail), watchdogKey-deduped,
 *      origin=organic (the signals are real fleet traffic, FB-03 vocab).
 *
 * No demand table and no watermark: the map is recomputed per tick and
 * capture-core's watchdogKey dedup is the cross-tick net (an open item
 * declines re-offers; a resolved one re-files only on post-resolution
 * evidence). Deps are injectable so the tick is unit-testable without
 * PG/fs; the flag + governor gates live in the routine action
 * (neologism-action.ts), not here. Mirrors the negative-space miner (FB-04).
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { ALL_FLAG_KEYS } from '@papercusp/flags';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import {
  aggregateNeologisms,
  buildNamespaceIndex,
  findPrimitiveNearMiss,
  neologismCaptureTitle,
  neologismNearMissBody,
  neologismNearMissTitle,
  neologismProposal,
  neologismWatchdogKey,
  selectNeologismCandidates,
  DEFAULT_NEOLOGISM_OPTIONS,
  type CoordTextRow,
  type InsightDoc,
  type NeologismEntry,
  type NeologismFilingOptions,
} from './miner-core';
import { improvementBody } from '../scout/router-deps';
import {
  captureImprovement,
  type CaptureImprovementInput,
  type CaptureImprovementResult,
} from '../harness/improvements/capture-core';

export const DEFAULT_WINDOW_DAYS = DEFAULT_NEOLOGISM_OPTIONS.windowDays;
/** Row-fetch safety ceiling — prose envelopes in a window. */
const READ_LIMIT = 20_000;
/** How far back the tool-name namespace looks (a superset window — primitives are stable). */
const NAMESPACE_TOOL_WINDOW_DAYS = 120;

// packages/operator-core/lib/neologism → repo root. ESM-safe: bare
// `__dirname` is UNDEFINED under tsx file-mode in this type:module package
// (the 2026-06-12 DBOS stall) — never use __dirname in operator-core.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const INSIGHTS_DIR = join(REPO_ROOT, 'apps/operator-docs/src/content/docs/agent-insights');

export interface NeologismTickOptions extends NeologismFilingOptions {
  /** Window anchor (ISO). Default: now. Injected for deterministic tests/backtests. */
  asOf?: string;
}

/** Injectable seams (tests run the tick without PG/fs). */
export interface NeologismTickDeps {
  readRows: (workspaceId: string, windowDays: number) => Promise<CoordTextRow[]>;
  readInsights: () => Promise<InsightDoc[]>;
  /** Raw primitive names (tools, tables, routines, flags) — indexed by the tick. */
  readNamespaces: () => Promise<string[]>;
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  log?: (message: string) => void;
}

export interface NeologismTickResult {
  scannedRows: number;
  insightDocs: number;
  namespaceNames: number;
  /** Emergent-term entries after namespace filtering (the whole ranked map). */
  terms: number;
  /** Entries over the fire bars this tick (pre-cap). */
  overBars: number;
  /** Improvement ids filed this tick. */
  filed: string[];
  /** Candidates the capture core declined (likely-duplicate / stale-evidence). */
  declined: number;
}

/** Prose coord envelopes over the window — the term-mining substrate. */
export async function readCoordTextRows(
  sql: Sql,
  workspaceId: string,
  windowDays: number,
): Promise<CoordTextRow[]> {
  const scopes = [...new Set([workspaceId, '*', DEFAULT_COORD_WORKSPACE])];
  const rows = await sql<{ speaker: string | null; summary: string | null; body: string | null; ts: string | Date }[]>`
    SELECT body->>'from' AS speaker,
           body->>'summary' AS summary,
           body->>'body' AS body,
           ts
      FROM harness_shared.coord_event_log
     WHERE ts > now() - make_interval(days => ${windowDays})
       AND workspace_id = ANY(${scopes}::text[])
       AND body->>'kind' IN ('message', 'handoff', 'escalation', 'escalation_resolved')
       -- ambient machine broadcasts (service-health, agent-governor, …) are
       -- templated prose, not coinage — same default exclusion as coord:inbox
       AND body->>'category' IS NULL
     ORDER BY ts DESC
     LIMIT ${READ_LIMIT}`;
  return rows
    .map((r) => ({
      speaker: r.speaker ?? 'unknown',
      text: [r.summary, r.body].filter(Boolean).join('\n'),
      at: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    }))
    .filter((r) => r.text.length > 0);
}

/** The insights corpus (agent-insights MDX) — corroborating evidence, fs-read in parallel. */
export async function readInsightDocsFromRepo(dir: string = INSIGHTS_DIR): Promise<InsightDoc[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.mdx') || f.endsWith('.md'));
  } catch {
    return []; // missing corpus (e.g. a stripped deploy tree) degrades to coord-only mining
  }
  const docs = await Promise.all(
    files.map(async (f): Promise<InsightDoc | null> => {
      try {
        return { slug: f.replace(/\.mdx?$/, ''), text: await readFile(join(dir, f), 'utf8') };
      } catch {
        return null;
      }
    }),
  );
  return docs.filter((d): d is InsightDoc => d !== null);
}

/**
 * The primitive namespaces a term must be ABSENT from to count as a
 * neologism: tool names actually invoked (tool_invocations — includes
 * plugin tools), harness_shared + public table names, routine names +
 * `system:*` targets, and flag keys (in-process — the registry is code).
 */
export async function readPrimitiveNames(sql: Sql): Promise<string[]> {
  const [tools, tables, routines] = await Promise.all([
    sql<{ tool_name: string }[]>`
      SELECT DISTINCT tool_name
        FROM harness_shared.tool_invocations
       WHERE invoked_at > now() - make_interval(days => ${NAMESPACE_TOOL_WINDOW_DAYS})
       LIMIT 5000`,
    sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema IN ('harness_shared', 'public')`,
    sql<{ name: string; target_role: string | null }[]>`
      SELECT name, target_role FROM harness_shared.routines`,
  ]);
  return [
    ...tools.map((r) => r.tool_name),
    ...tables.map((r) => r.table_name),
    ...routines.flatMap((r) => (r.target_role ? [r.name, r.target_role] : [r.name])),
    ...ALL_FLAG_KEYS,
  ];
}

/** The live PG/fs-backed deps (the routine action's default wiring). */
export function defaultNeologismDeps(sql: Sql): NeologismTickDeps {
  return {
    readRows: (ws, windowDays) => readCoordTextRows(sql, ws, windowDays),
    readInsights: () => readInsightDocsFromRepo(),
    readNamespaces: () => readPrimitiveNames(sql),
    capture: (input) => captureImprovement(input),
    log: (m) => console.log(m),
  };
}

/**
 * Shape one candidate as the capture-core input. Kind fidelity (frontier
 * P-044 / FB-18): a term that near-misses a real primitive phrase is a
 * vocabulary RESOLUTION GAP — clear correct state, regression-testable —
 * and files kind=bug; genuinely unnamed vocabulary stays the kind=change
 * Scout-rail abstraction proposal.
 */
export function neologismCaptureInput(
  entry: NeologismEntry,
  windowDays: number,
  nearMissPhrase: string | null = null,
): CaptureImprovementInput {
  const shared = {
    subTopic: 'neologism',
    sourceRole: 'system',
    source: 'su',
    watchdogKey: neologismWatchdogKey(entry.term),
    // 'all', not FB-04's 'open': a proposal stream has decision semantics,
    // not regression semantics — an owner-rejected abstraction stays
    // rejected (re-open the item to revisit), it must not re-file each time
    // the term resurges.
    dedupScope: 'all',
    evidenceAt: entry.lastSeenAt,
    createdBy: 'system:neologism-mine',
    // FB-03/D-002 provenance, explicit: the mined signals are REAL fleet
    // traffic — organic, never drill/replay/shadow.
    origin: 'organic',
  } satisfies Partial<CaptureImprovementInput>;
  if (nearMissPhrase) {
    return {
      ...shared,
      title: neologismNearMissTitle(entry.term, nearMissPhrase),
      kind: 'bug',
      body: neologismNearMissBody(entry, nearMissPhrase, windowDays),
      severity: 'minor',
      findingClass: 'neologism:primitive-near-miss',
    };
  }
  const proposal = neologismProposal(entry, windowDays);
  return {
    ...shared,
    title: neologismCaptureTitle(entry.term),
    kind: 'change',
    body: improvementBody(proposal),
    severity: 'minor',
    findingClass: 'neologism:abstraction-proposal',
  };
}

/**
 * One mining tick: read (parallel) → aggregate → select → file capped
 * candidates. Also the mine-only backtest entry (`maxPerTick: 0` skips
 * filing; pass `asOf` to anchor the window deterministically).
 */
export async function runNeologismTick(
  workspaceId: string,
  deps: NeologismTickDeps,
  opts: NeologismTickOptions = {},
): Promise<NeologismTickResult & { entries: NeologismEntry[] }> {
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : DEFAULT_WINDOW_DAYS;
  const asOf = opts.asOf ?? new Date().toISOString();
  const log = deps.log ?? (() => {});

  const [rows, insights, namespaceNames] = await Promise.all([
    deps.readRows(workspaceId, windowDays),
    deps.readInsights(),
    deps.readNamespaces(),
  ]);
  const index = buildNamespaceIndex(namespaceNames);
  const entries = await aggregateNeologisms(rows, insights, index, asOf, { ...opts, windowDays });

  const overBars = selectNeologismCandidates(entries, { ...opts, windowDays, maxPerTick: Number.MAX_SAFE_INTEGER });
  const candidates = selectNeologismCandidates(entries, { ...opts, windowDays });
  const filed: string[] = [];
  let declined = 0;
  for (const entry of candidates) {
    // Best-effort per candidate: one capture failure never aborts the tick.
    try {
      // Kind fidelity (frontier P-044): a candidate one word-edit from a real
      // primitive phrase is a vocabulary resolution gap (kind=bug); only over
      // the capped candidates, so the index sweep stays cheap.
      const nearMissPhrase = findPrimitiveNearMiss(entry.term, index);
      const result = await deps.capture(neologismCaptureInput(entry, windowDays, nearMissPhrase));
      if (result.created && result.issue) {
        filed.push(result.issue.id);
      } else {
        declined += 1;
        log(
          `[neologism] declined "${entry.term}" (${result.reason ?? 'not created'})` +
            (result.possibleDuplicates[0] ? ` — likely ${result.possibleDuplicates[0].id}` : ''),
        );
      }
    } catch (e) {
      declined += 1;
      log(`[neologism] capture FAILED for "${entry.term}": ${e instanceof Error ? e.message : e}`);
    }
  }

  return {
    scannedRows: rows.length,
    insightDocs: insights.length,
    namespaceNames: namespaceNames.length,
    terms: entries.length,
    overBars: overBars.length,
    filed,
    declined,
    entries,
  };
}
