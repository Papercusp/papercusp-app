/**
 * Launch-profile resolver — dims decide WHERE, the work statement decides WHAT.
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-007, decision D-005,
 * owner-approved 2026-07-12).
 *
 * One resolver consumed by every injection moment (MCP initialize, the
 * post-compaction re-prime, turn-start, fleet wake-briefs) and by the
 * injection ports (D-006):
 *
 *   - The launch DIMS (harness / plan / fleet — each optional) decide WHERE
 *     recall looks (which pools fan out; hive resolution stays inside
 *     injection.ts) and WHICH deterministic sections the consumer should
 *     assemble (anything living in a keyed ledger — facts, plan Now, claimed
 *     items + checkpoints, fleet mission + gates — is a deterministic
 *     section, never a vector query).
 *
 *   - The MOST-SPECIFIC available work statement decides WHAT we ask: 1–3
 *     TARGETED queries picked off a specificity ladder, never one blended
 *     mega-query (the Mug L1d lesson):
 *       rung 0  post-compaction: held work-item checkpoints + compaction focus
 *       rung 1  kickoff / launchContext text
 *       rung 2  plan claimed items (+ ## Now) — one query per claimed title
 *       rung 3  fleet mission
 *       rung 4  harness identity  [owner-approved: DO query at initialize]
 *       rung 5  bare — NO initialize-time recall; defer to the first
 *               turn-start delta.
 *
 * Each consumer supplies the dims IT knows (the initialize path knows the
 * harness; the compact hook knows the held checkpoints + focus; a wake-brief
 * knows its kickoff text) — the ladder degrades gracefully to whatever is
 * available. Post-compaction consumers re-resolve over the session's
 * REGISTERED associations, so every dim combination inherits its behavior
 * for free and the epoch reset (P-002) re-primes the pool.
 */

import { buildMemoryContextBlock, type MemoryInjectionInput } from './injection';
import { collapseNearDuplicates } from './recall-admission';
import { initializeQueryForHarness } from './mcp-prelude';

export type LaunchRung =
  | 'post-compaction'
  | 'kickoff'
  | 'plan'
  | 'fleet'
  | 'harness'
  | 'bare';

/** Deterministic-section markers a consumer should assemble (keyed-ledger reads). */
export type DeterministicSection =
  | 'recovery-block'
  | 'facts'
  | 'insights-index'
  | 'plan-now'
  | 'claimed-items'
  | 'checkpoints'
  | 'decisions'
  | 'fleet-mission'
  | 'announced-gates';

export interface LaunchProfileInput {
  harnessSlug?: string | null;
  planSlug?: string | null;
  fleetSlug?: string | null;
  /** Rung 1: explicit kickoff / launchContext text (fleet member, dispatched task). */
  kickoffText?: string | null;
  /** Rung 2: titles of the session's claimed plan items. */
  claimedItemTitles?: readonly string[];
  /** Rung 2 supplement: the plan's ## Now line. */
  planNow?: string | null;
  /** Rung 3: the fleet's mission / kickoff summary. */
  fleetMission?: string | null;
  /** Rung 0: held work-item checkpoint heads (post-compaction). */
  heldCheckpointTitles?: readonly string[];
  /** Rung 0: the compaction focus text (post-compaction). */
  compactionFocus?: string | null;
}

export interface LaunchProfile {
  rung: LaunchRung;
  /** 0–3 targeted recall queries, most-specific work statement first. */
  queries: string[];
  /** Harness pools to fan out (hive resolution stays in injection.ts). */
  harnessSlugs: string[];
  /** Which keyed-ledger sections the consumer should assemble deterministically. */
  deterministicSections: DeterministicSection[];
}

/** Hard cap per D-005: 1–3 targeted queries, never a blended mega-query. */
export const MAX_LAUNCH_QUERIES = 3;
/** Per-query clamp — a query is a STATEMENT, not a document. */
const QUERY_CLAMP_CHARS = 300;

function clampQuery(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > QUERY_CLAMP_CHARS ? t.slice(0, QUERY_CLAMP_CHARS) : t;
}

function nonEmpty(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function resolveLaunchProfile(input: LaunchProfileInput): LaunchProfile {
  const harnessSlugs = nonEmpty(input.harnessSlug) ? [input.harnessSlug.trim()] : [];

  const deterministicSections: DeterministicSection[] = [];
  if (harnessSlugs.length > 0) deterministicSections.push('facts', 'insights-index');
  if (nonEmpty(input.planSlug)) {
    deterministicSections.push('plan-now', 'claimed-items', 'checkpoints', 'decisions');
  }
  if (nonEmpty(input.fleetSlug)) deterministicSections.push('fleet-mission', 'announced-gates');

  // ── The specificity ladder (first rung with material wins) ──
  const checkpointTitles = (input.heldCheckpointTitles ?? []).filter(nonEmpty);
  if (nonEmpty(input.compactionFocus) || checkpointTitles.length > 0) {
    const queries: string[] = [];
    if (nonEmpty(input.compactionFocus)) queries.push(clampQuery(input.compactionFocus));
    for (const t of checkpointTitles) {
      if (queries.length >= MAX_LAUNCH_QUERIES) break;
      queries.push(clampQuery(t));
    }
    return {
      rung: 'post-compaction',
      queries,
      harnessSlugs,
      deterministicSections: ['recovery-block', ...deterministicSections],
    };
  }

  if (nonEmpty(input.kickoffText)) {
    return {
      rung: 'kickoff',
      queries: [clampQuery(input.kickoffText)],
      harnessSlugs,
      deterministicSections,
    };
  }

  const claimed = (input.claimedItemTitles ?? []).filter(nonEmpty);
  if (claimed.length > 0) {
    // One query PER claimed item (capped): "wire the prelude" and "epoch
    // ledger" recall DIFFERENT memories — averaging them into one embedding
    // recalls neither well.
    const queries = claimed.slice(0, MAX_LAUNCH_QUERIES).map(clampQuery);
    if (queries.length < MAX_LAUNCH_QUERIES && nonEmpty(input.planNow)) {
      queries.push(clampQuery(input.planNow));
    }
    return { rung: 'plan', queries, harnessSlugs, deterministicSections };
  }

  if (nonEmpty(input.fleetMission)) {
    return {
      rung: 'fleet',
      queries: [clampQuery(input.fleetMission)],
      harnessSlugs,
      deterministicSections,
    };
  }

  if (harnessSlugs.length > 0) {
    // Owner-approved rung (D-005): a harness-only session DOES vector-query
    // at initialize — it is what primes hive-pack + convention knowledge
    // before the first turn.
    return {
      rung: 'harness',
      queries: [initializeQueryForHarness(harnessSlugs[0])],
      harnessSlugs,
      deterministicSections,
    };
  }

  // Bare session: no initialize-time recall; the first turn-start delta
  // (which HAS a work statement — the user's message) carries it.
  return { rung: 'bare', queries: [], harnessSlugs, deterministicSections };
}

/* ────────────────────────────────────────────────────────────────────── */

export interface LaunchMemoryBlockInput {
  profile: LaunchProfile;
  userId?: string | null;
  workspaceId: string;
  /** Warm-session epoch-dedup identity (P-002). */
  session?: MemoryInjectionInput['session'];
  heading?: string;
  /** Per-query hit limit (defaults to injection.ts's default). */
  limit?: number;
  /** Opt into closed validity windows for an explicit history brief. */
  includeSuperseded?: boolean;
  /**
   * Per-query char budget override (defaults to injection.ts's global inject
   * budget). A port piggybacking on a tool response (claim/create — P-008/9)
   * passes a small budget so recall never dominates the response.
   */
  budgetChars?: number;
  /**
   * P-005 telemetry override: the recall-stats surface label, for a caller
   * with no dedup session to carry it (the Mug/cup brief passes 'brief').
   * Telemetry only.
   */
  telemetrySurface?: string;
}

/** Matches the `(id=<uuid>)` suffix injection.ts renders per line. */
const LINE_ID_RE = /\(id=([0-9a-f-]{20,})\)/i;

/**
 * The memory TEXT of a rendered recall line — strips the "- [scope] (id=uuid) " framing so the
 * P-008 near-duplicate collapse compares CONTENT, not the differing id/scope. (`buildLaunchMemoryBlock`
 * already dedups by id + exact line; this catches the same fact stored under DIFFERENT ids across
 * separate queries, whose lines differ only in the id suffix.)
 */
function lineMemoryText(line: string): string {
  const m = LINE_ID_RE.exec(line);
  if (m) return line.slice(m.index + m[0].length).trim();
  return line.replace(/^-\s*/, '').replace(/^\[[^\]]*\]\s*/, '').trim();
}

/**
 * Run the profile's targeted queries through the ONE admission pipeline
 * (floors · muted packs · tombstones · epoch/watermark dedup · budget) and
 * merge the results under a single heading, deduping lines across queries by
 * memory id (the P-002 stamp is fire-and-forget, so back-to-back queries
 * within one call can't rely on it alone). Sequential on purpose — each
 * query's stamps get their chance to suppress the next query's repeats.
 *
 * Returns null when no query produced anything (or the profile has none).
 */
export async function buildLaunchMemoryBlock(
  input: LaunchMemoryBlockInput,
): Promise<string | null> {
  const heading = input.heading ?? 'Session memory (relevant entries)';
  const seenIds = new Set<string>();
  const seenLines = new Set<string>();
  const merged: string[] = [];

  for (const query of input.profile.queries.slice(0, MAX_LAUNCH_QUERIES)) {
    if (!query.trim()) continue;
    let block: string | null = null;
    try {
      block = await buildMemoryContextBlock({
        userId: input.userId ?? null,
        workspaceId: input.workspaceId,
        harnessSlugs: input.profile.harnessSlugs,
        queryContext: query,
        ...(input.limit ? { limit: input.limit } : {}),
        ...(input.includeSuperseded ? { includeSuperseded: true } : {}),
        ...(input.budgetChars ? { budgetChars: input.budgetChars } : {}),
        ...(input.telemetrySurface ? { telemetrySurface: input.telemetrySurface } : {}),
        ...(input.session ? { session: input.session } : {}),
        heading,
      });
    } catch {
      block = null; // best-effort per query; the others still run
    }
    if (!block) continue;
    for (const line of block.split('\n')) {
      if (!line.startsWith('- ')) continue; // drop per-block headings
      const id = LINE_ID_RE.exec(line)?.[1];
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      } else if (seenLines.has(line)) {
        continue;
      }
      seenLines.add(line);
      merged.push(line);
    }
  }

  if (merged.length === 0) return null;
  // P-008 (WI-4538): collapse near-duplicate lines that slipped past the id/exact-line dedup
  // above — the SAME fact stored under different ids renders as different lines (only the
  // (id=…) suffix differs), so both survive and spend the budget twice on one fact. Compare on
  // the memory TEXT, keeping the first (highest-ranked) copy.
  const { kept: dedupedLines } = collapseNearDuplicates(merged, lineMemoryText);
  return `## ${heading}\n\n${dedupedLines.join('\n')}`;
}
