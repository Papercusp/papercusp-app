/**
 * tool-sequence-promote.ts — the LOOP-CLOSING half of workstream D
 * (okf-frontmatter-adoption-2026-08-08 §D).
 *
 * The design's §10 states the problem exactly: "the existing promotion path
 * still ends at a human decision — D's job is to replace that ending with the
 * graduation engine, not to build a new front end for it." Today
 * `recipeCandidates` computes a worklist and someone has to read it. This
 * module removes the reader.
 *
 * What replaces the human is NOT an automatic code change — it is evidence plus
 * a work-item another AGENT claims. A graduated tool-sequence has cleared two
 * independent bars before anything is filed:
 *
 *   1. It is a real cross-agent pattern, not ambient telemetry and not one
 *      agent's habit (the mining floors + lift — see tool-sequence-patterns).
 *   2. It PERSISTED across consecutive windows, so it is not one busy afternoon
 *      (the graduation streak, counted by the same frontier tracker the autonomy
 *      tripwires use).
 *
 * Only then does it file. Nothing here promotes code, edits a registry, or needs
 * ratification — the act is "open a work-item describing a proven repetition",
 * which is the autonomous path the owner's no-human-gates mandate asks for.
 *
 * Idempotence is the property that makes this safe to run on a schedule: every
 * filing carries a stable `watchdogKey` derived from the sequence itself, so a
 * pattern that graduates again next week COALESCES onto the open row instead of
 * minting a duplicate. Without that, a weekly sweep over a persistent pattern is
 * a duplicate generator — and persistence is precisely what we select for, so
 * every single row it files would recur.
 *
 * Server-only.
 */
import type postgres from 'postgres';
import {
  graduateToolSequences,
  type GraduateToolSequencesOpts,
  type PersistentToolSequenceCandidate,
} from './tool-sequence-patterns';
import type { CaptureImprovementInput, CaptureImprovementResult } from './harness/improvements/capture-core';

/** Source tag stamped on every filing, so the population is queryable later. */
export const SEQUENCE_PROMOTION_SOURCE = 'tool-sequence-graduation';

/** Kill switch (default ON — finished work never ships dark). */
export const SEQUENCE_PROMOTION_KILL_ENV = 'PAPERCUSP_TOOL_SEQUENCE_PROMOTION';

/** Cap filings per sweep, so a tuning slip cannot flood the queue. */
export const DEFAULT_MAX_FILINGS = 5;

/**
 * A workspace with fewer agent-initiated calls than this over the span cannot
 * clear the miner's cohort/occurrence floors, so mining it is pure cost.
 */
export const DEFAULT_MIN_WORKSPACE_ROWS = 5_000;

export interface PromoteToolSequencesDeps {
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  log?: (msg: string) => void;
}

export interface PromoteToolSequencesOpts extends GraduateToolSequencesOpts {
  /** Max work-items filed in one sweep (default 5). */
  maxFilings?: number;
  /** Compute candidates and render, but do not file. */
  dryRun?: boolean;
  /**
   * Harness the filing is SCOPED to — deliberately separate from `harnessSlug`,
   * which scopes the MINING query.
   *
   * Conflating the two silently shrinks the evidence: most agent traffic carries
   * the wildcard harness (measured 514,614 rows vs 19,620 for the named one), so
   * mining "the harness we want to file into" throws away the cohort the pattern
   * lives in. The pattern is found across everything; the work-item still has to
   * land somewhere claimable. Defaults to `harnessSlug` when a caller genuinely
   * did scope the mining, and omitting both homes the filing to the platform Pot.
   */
  filingHarness?: string;
}

export interface PromoteToolSequencesResult {
  /** Candidates that cleared both bars this sweep. */
  graduated: PersistentToolSequenceCandidate[];
  /** Sequence ids actually filed (or that WOULD file under dryRun). */
  filed: string[];
  /** Sequence ids the capture path declined as duplicates — the coalesce working. */
  coalesced: string[];
  /** Sequence ids suppressed because a longer graduated sequence is their strict prefix extension. */
  suppressed: string[];
  /** Mined but still accruing evidence. */
  heldForEvidence: number;
  /**
   * The read hit its row ceiling, so this sweep judged a SHORTER span than asked
   * for. Reported rather than swallowed: it degrades results silently (weaker
   * marginals, fewer graduates) and looks exactly like a quiet week.
   */
  truncated: boolean;
  dryRun: boolean;
  disabled: boolean;
}

/** Stable cross-sweep identity for one sequence — the coalesce key. */
export function sequenceWatchdogKey(candidate: PersistentToolSequenceCandidate): string {
  return `${SEQUENCE_PROMOTION_SOURCE}:${candidate.id}`;
}

/**
 * Keep only maximal graduated sequences for filing.
 *
 * The generic miner already removes many subsumed patterns, but its support
 * ratio intentionally keeps a shorter run when overlapping occurrences make it
 * look independently useful. That is the wrong boundary for promotion: a
 * repeated-call ladder such as `code:run → code:run`, then three, four, and
 * five calls can otherwise occupy one queue row per prefix even though the
 * longer stable run is the actionable evidence. A strict PREFIX rule is
 * deliberately narrower than arbitrary substring suppression: a sequence that
 * merely shares a suffix or an interior step remains a distinct candidate.
 *
 * The selection is deterministic and preserves input order among representatives.
 * Graduated evidence is returned separately by the caller; only the suppressed
 * ids are excluded from capture.
 */
export function selectMaximalSequenceCandidates(
  candidates: readonly PersistentToolSequenceCandidate[],
): {
  kept: PersistentToolSequenceCandidate[];
  suppressed: PersistentToolSequenceCandidate[];
} {
  const isStrictPrefix = (prefix: readonly string[], longer: readonly string[]): boolean =>
    prefix.length < longer.length && prefix.every((tool, index) => tool === longer[index]);

  const suppressed = candidates.filter((candidate, index) =>
    candidates.some(
      (other, otherIndex) =>
        index !== otherIndex && isStrictPrefix(candidate.toolsUsed, other.toolsUsed),
    ),
  );
  const suppressedIndexes = new Set(suppressed.map((candidate) => candidates.indexOf(candidate)));

  return {
    kept: candidates.filter((candidate, index) => !suppressedIndexes.has(index)),
    suppressed,
  };
}

/**
 * Render the work-item body. Deliberately leads with the EVIDENCE and states the
 * concrete act, because the reader is an agent deciding whether to claim it —
 * a body that only says "this pattern is frequent" is not actionable.
 */
export function renderSequenceFiling(c: PersistentToolSequenceCandidate): {
  title: string;
  body: string;
} {
  const title = `Repeated ${c.toolsUsed.length}-call tool dance across ${c.distinctAgents} agents: ${c.label}`;
  const body = [
    `**${c.distinctAgents} distinct agents** independently perform this exact ordered sequence, and it has persisted for **${c.windowStreak} consecutive windows** (seen in ${c.windowsSeen} of ${c.windowsExamined}).`,
    '',
    '```',
    c.toolsUsed.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    '```',
    '',
    `- Occurrences: **${c.occurrences}** across ${c.bursts} separate work bursts`,
    `- Strength: **${c.strength}** (mean per-transition log10 lift; ambient traffic sits near 0)`,
    `- Agents (sample): ${c.agentSample.slice(0, 8).join(', ')}`,
    '',
    '**Why this is filed automatically.** It cleared two independent bars: it is a genuine',
    'cross-agent pattern rather than ambient telemetry or one agent\'s habit, AND it persisted',
    'across consecutive windows rather than spiking during one incident. Mined from',
    '`tool_invocations` by `tool-sequence-patterns.ts`; the persistence streak is counted by the',
    'same graduation tracker the autonomy tripwires use.',
    '',
    '**The act.** Decide whether this dance should collapse into ONE call — a new tool, a new',
    'argument on the first tool, or a batch form. Repeated identical calls in the sequence',
    '(e.g. the same verb three times) usually mean the tool should accept an array.',
    'If it should NOT collapse, resolve with the reason: that is a real answer, and it stops',
    'the pattern being re-proposed.',
    '',
    'The promotion guard files only maximal sequences: a graduated sequence that is a strict',
    'prefix of a longer graduated sequence is suppressed in favor of the broader evidence.',
    '',
    `_Source: ${SEQUENCE_PROMOTION_SOURCE} · sequence id \`${c.id}\`_`,
  ].join('\n');
  return { title, body };
}

/**
 * One promotion sweep: mine, graduate, file. Never throws — a scheduled caller
 * must not be taken down by a filing failure, so each capture is guarded and its
 * failure is logged and counted rather than propagated.
 */
export async function promoteToolSequences(
  sql: postgres.Sql,
  opts: PromoteToolSequencesOpts,
  deps: PromoteToolSequencesDeps,
): Promise<PromoteToolSequencesResult> {
  const log = deps.log ?? (() => {});
  if (process.env[SEQUENCE_PROMOTION_KILL_ENV] === 'off') {
    return {
      graduated: [],
      filed: [],
      coalesced: [],
      suppressed: [],
      heldForEvidence: 0,
      truncated: false,
      dryRun: false,
      disabled: true,
    };
  }

  const mined = await graduateToolSequences(sql, opts);
  const selected = selectMaximalSequenceCandidates(mined.graduated);
  const maxFilings = Math.max(0, opts.maxFilings ?? DEFAULT_MAX_FILINGS);
  const toFile = selected.kept.slice(0, maxFilings);

  const filed: string[] = [];
  const coalesced: string[] = [];

  for (const c of toFile) {
    if (opts.dryRun) {
      filed.push(c.id);
      continue;
    }
    const { title, body } = renderSequenceFiling(c);
    const filingHarness = opts.filingHarness ?? opts.harnessSlug;
    try {
      const res = await deps.capture({
        title,
        body,
        kind: 'change',
        severity: 'minor',
        scope: filingHarness ? `harness:${filingHarness}` : undefined,
        foundDuring: SEQUENCE_PROMOTION_SOURCE,
        // Stable identity ⇒ a re-graduation coalesces instead of duplicating.
        watchdogKey: sequenceWatchdogKey(c),
        // Only an OPEN duplicate declines: if a prior filing was RESOLVED and the
        // dance is STILL being performed, that is a regression worth re-raising.
        dedupScope: 'open',
      } as CaptureImprovementInput);
      if (res?.created) filed.push(c.id);
      else coalesced.push(c.id);
    } catch (err) {
      log(`promoteToolSequences: capture failed for ${c.id} (${(err as Error)?.message ?? String(err)})`);
    }
  }

  return {
    graduated: mined.graduated,
    filed,
    coalesced,
    suppressed: selected.suppressed.map((c) => c.id),
    heldForEvidence: mined.stats.heldForEvidence,
    truncated: mined.stats.truncated,
    dryRun: !!opts.dryRun,
    disabled: false,
  };
}

/** One workspace worth mining, plus the harness its filings should land in. */
export interface PromotionTarget {
  workspaceId: string;
  /** Agent-initiated rows over the span — the reason it qualified. */
  rows: number;
  /**
   * Modal REAL harness among that workspace's traffic, or undefined when there
   * is none. Undefined ⇒ the filing homes to the workspace platform Pot.
   */
  harnessSlug?: string;
}

/**
 * Which workspaces are worth a promotion sweep — asked of the data, never
 * configured.
 *
 * A scheduled routine must not carry a hardcoded workspace id: this ships in the
 * desktop app, where the id is whatever that install generated, so a constant
 * here would make the whole loop a silent no-op everywhere except the box it was
 * written on.
 *
 * The harness is derived the same way, and needs care because `harness_slug` is
 * NOT the filing target for most rows. Measured 2026-08-09 over 7 days: 514,614
 * agent rows carry the wildcard `'*'` (su sessions are not harness-scoped) against
 * 19,620 for `papercusp` — so grouping the MINING by harness would shatter the
 * cohort the pattern actually lives in. Mining is therefore per WORKSPACE, and
 * the harness is used only to scope the resulting work-item so agents of that
 * harness can claim it (an unclaimable filing closes no loop). Wildcard and empty
 * slugs are excluded from that vote precisely because they name no claim pool.
 */
export async function discoverPromotionTargets(
  sql: postgres.Sql,
  opts: { hours?: number; minRows?: number; limit?: number } = {},
): Promise<PromotionTarget[]> {
  const hours = Math.max(1, Math.min(720, opts.hours ?? 168));
  const minRows = Math.max(0, opts.minRows ?? DEFAULT_MIN_WORKSPACE_ROWS);
  const limit = Math.max(1, Math.min(50, opts.limit ?? 5));
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const rows = (await sql`
      WITH agent_rows AS (
        SELECT workspace_id, harness_slug
          FROM harness_shared.tool_invocations
         WHERE invoked_at > ${sinceIso}::timestamptz
           AND transport = 'mcp'
           AND status = 'ok'
           AND coord_owner_id IS NOT NULL
           AND workspace_id IS NOT NULL
      ), totals AS (
        SELECT workspace_id, count(*) AS rows FROM agent_rows GROUP BY 1
      ), named AS (
        SELECT workspace_id, harness_slug, count(*) AS n,
               row_number() OVER (PARTITION BY workspace_id ORDER BY count(*) DESC, harness_slug) AS rk
          FROM agent_rows
         WHERE harness_slug IS NOT NULL AND harness_slug <> '' AND harness_slug <> '*'
         GROUP BY 1, 2
      )
      SELECT t.workspace_id, t.rows, n.harness_slug
        FROM totals t
        LEFT JOIN named n ON n.workspace_id = t.workspace_id AND n.rk = 1
       WHERE t.rows >= ${minRows}
       ORDER BY t.rows DESC
       LIMIT ${limit}
  `) as unknown as { workspace_id: string; rows: string | number; harness_slug: string | null }[];

  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    rows: Number(r.rows),
    ...(r.harness_slug ? { harnessSlug: r.harness_slug } : {}),
  }));
}

export interface PromoteEverywhereResult {
  targets: PromotionTarget[];
  filed: number;
  coalesced: number;
  suppressed: number;
  graduated: number;
  heldForEvidence: number;
  /** Any workspace whose read hit the row ceiling — see PromoteToolSequencesResult. */
  truncated: boolean;
  disabled: boolean;
}

/**
 * Sweep every qualifying workspace. This is the entry point a scheduled caller
 * wants: it needs no per-install configuration and no workspace argument.
 *
 * A failure in one workspace never stops the others — the sweep's job is to
 * make progress where it can, not to be all-or-nothing.
 */
export async function promoteToolSequencesEverywhere(
  sql: postgres.Sql,
  opts: Omit<PromoteToolSequencesOpts, 'workspaceId'> & { minWorkspaceRows?: number; maxWorkspaces?: number } = {},
  deps: PromoteToolSequencesDeps,
): Promise<PromoteEverywhereResult> {
  const log = deps.log ?? (() => {});
  if (process.env[SEQUENCE_PROMOTION_KILL_ENV] === 'off') {
    return {
      targets: [],
      filed: 0,
      coalesced: 0,
      suppressed: 0,
      graduated: 0,
      heldForEvidence: 0,
      truncated: false,
      disabled: true,
    };
  }

  const spanHours = (opts.windows ?? 7) * (opts.windowHours ?? 24);
  const targets = await discoverPromotionTargets(sql, {
    hours: spanHours,
    ...(opts.minWorkspaceRows !== undefined ? { minRows: opts.minWorkspaceRows } : {}),
    ...(opts.maxWorkspaces !== undefined ? { limit: opts.maxWorkspaces } : {}),
  });

  const out: PromoteEverywhereResult = {
    targets,
    filed: 0,
    coalesced: 0,
    suppressed: 0,
    graduated: 0,
    heldForEvidence: 0,
    truncated: false,
    disabled: false,
  };

  for (const t of targets) {
    try {
      const r = await promoteToolSequences(
        sql,
        // NOTE the asymmetry, and do not "tidy" it into harnessSlug: the mining
        // stays workspace-wide; only the FILING is harness-scoped.
        { ...opts, workspaceId: t.workspaceId, ...(t.harnessSlug ? { filingHarness: t.harnessSlug } : {}) },
        deps,
      );
      out.filed += r.filed.length;
      out.coalesced += r.coalesced.length;
      out.suppressed += r.suppressed.length;
      out.graduated += r.graduated.length;
      out.heldForEvidence += r.heldForEvidence;
      out.truncated ||= r.truncated;
    } catch (err) {
      log(`promoteToolSequencesEverywhere: ${t.workspaceId} failed (${(err as Error)?.message ?? String(err)})`);
    }
  }
  return out;
}
