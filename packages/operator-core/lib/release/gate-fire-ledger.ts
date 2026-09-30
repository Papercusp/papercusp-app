/**
 * gate-fire-ledger — P-001 (gate-verdict-liveness-and-repair-reliability-2026-08-31):
 * the durable per-fire ledger over `harness_shared.pipeline_events`.
 *
 * ## What existed before this module
 *
 * The mid-streak taxonomy work (D-004 of green-main-fast, the typed pre-suite no-verdict
 * writers in release-actions.ts) already gives every OUTCOME a typed
 * `kind='green_checkpoint'` pipeline event: skips (`skipped-locked`, `skipped-held`,
 * `skipped-memory-budget`, …), infra aborts (`migrations-pending`, `error`, `cancelled`,
 * `deadline-exceeded`, `infra-inconclusive`), reds (`not-green`), greens (`advanced`,
 * `up-to-date`, `advanced-prefix`), promotion failures (`not-fast-forward`,
 * `create-failed`) and the mid-run `decision-pending` bridge. The table is append-only
 * with NO pruning path (measured 2026-09-01: zero DELETE/prune sites outside tests), so
 * the ≥90d retention requirement holds by construction.
 *
 * ## The gap this module closes
 *
 * Nothing marked the FIRE itself. A tick or detached launch whose process died before its
 * first write — SIGKILL, OOM of the routine cage, a bg-host restart mid-run: exactly the
 * 74h-blackout class the 11-day-red audit measured — left ZERO rows, so "27 fires → 3
 * verdicts" was only reconstructable from logs, never SQL. `recordGateFire` writes one
 * ANCHOR row per fire at ENTRY (before admission/skip/suite), under its own kind:
 *
 *   kind = 'green_checkpoint_fire', status = 'fired'
 *
 * ⚠ The separate kind is load-bearing, not taste: at least four consumers treat "a
 * green_checkpoint row exists" as "an outcome happened" — green-stall-watchdog's
 * `last_verdict_ms` subquery is the CLOCK of the D-006 verdict-less limb, and an anchor
 * row under that kind would reset it every fire, structurally blinding the limb built to
 * catch fires-that-record-nothing. Anchors ride their own kind; every existing consumer
 * filters `kind = 'green_checkpoint'` exactly and never sees them. The DB CHECK admits
 * the new kind once migration 1054 applies; until then `appendPipelineEvent`'s
 * best-effort contract turns each anchor write into a warn-and-noop (visible, harmless).
 *
 * ## Reconstruction (the P-001 acceptance)
 *
 * `reconstructGateFireDays` answers, from SQL alone for any past day: how many fires,
 * how many of each outcome class, and how many fires are UNACCOUNTED (fired with no
 * outcome row after it that day — the killed/vanished class). Correlation uses the
 * stable gateFireId when both launcher and producer carry it: distinct anchor ids are
 * matched to at most one terminal outcome, while pending/diagnostic rows remain
 * non-terminal. Legacy rows without a valid id retain the historical per-day count
 * fallback because their historical rows cannot be correlated after the fact.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { appendPipelineEvent } from '../harness/git-sync/pipeline-events';

/** The anchor kind. See the module doc — DO NOT fold anchors into 'green_checkpoint'. */
export const GATE_FIRE_KIND = 'green_checkpoint_fire' as const;
/** The one status anchors carry. */
export const GATE_FIRE_STATUS = 'fired' as const;
/** Environment transport from a launcher into the checkpoint producer. */
export const GATE_FIRE_ID_ENV = 'PAPERCUSP_GATE_FIRE_ID' as const;

/** Gate-fire identities are launcher-minted opaque values, bounded for env/detail transport. */
export function isGateFireId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}

/** Mint one stable identity for one accepted scheduled or detached fire. */
export function mintGateFireId(): string {
  return randomUUID();
}

/** Read a valid transported identity; malformed env is treated as absent, never trusted. */
export function gateFireIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[GATE_FIRE_ID_ENV]?.trim();
  return isGateFireId(value) ? value : undefined;
}

export interface GateFireTarget {
  workspaceId: string;
  installSlug: string;
}

export interface GateFireContext {
  /** Which door fired the gate. */
  route: 'scheduled' | 'detached' | 'manual';
  /** The integration root the run will judge, when the caller knows it. */
  root?: string;
  /** The transient unit for a detached launch, when known. */
  unit?: string;
  /** Stable identity shared by this fire's anchor and terminal/pending rows. */
  gateFireId?: string;
  /** Free evidence (e.g. the routine tick id); bounded by the caller. */
  note?: string;
}

/**
 * Append one fire ANCHOR row. Best-effort by contract (appendPipelineEvent swallows +
 * warns): a ledger write must never break the fire it is recording — identical to every
 * other pipeline-event writer.
 */
export async function recordGateFire(target: GateFireTarget, ctx: GateFireContext, sql?: Sql): Promise<void> {
  await appendPipelineEvent(
    {
      workspaceId: target.workspaceId,
      installSlug: target.installSlug,
      kind: GATE_FIRE_KIND,
      status: GATE_FIRE_STATUS,
      detail: {
        route: ctx.route,
        ...(ctx.root ? { root: ctx.root } : {}),
        ...(ctx.unit ? { unit: ctx.unit } : {}),
        ...(isGateFireId(ctx.gateFireId) ? { gateFireId: ctx.gateFireId } : {}),
        ...(ctx.note ? { note: ctx.note } : {}),
      },
    },
    sql,
  );
}

/**
 * The outcome classes the reconstruction rolls green_checkpoint statuses into.
 * `verdict-green` / `verdict-red` are the only two that count as VERDICTS — the number
 * the audit's "27 fires → 3 verdicts" table is about. `promotion-failed` means the suite
 * judged green but main could not advance; it is deliberately NOT a verdict-green
 * (nothing shipped) and NOT a no-verdict (the code WAS judged) — it gets its own column.
 */
export type GateOutcomeClass =
  | 'verdict-green'
  | 'verdict-red'
  | 'no-verdict'
  | 'skip'
  | 'pending'
  | 'promotion-failed'
  | 'unknown';

/**
 * The known-status → class map behind `classifyGateOutcomeStatus`. A MAP rather than a
 * switch so derived views (P-003's `VERDICT_BEARING_STATUSES`, usable in SQL `= ANY`)
 * are computed FROM it mechanically instead of hand-copied beside it (derived-truth
 * ladder rung 1 — a second list is how `failed`-vs-`fail` never-match bugs happen).
 */
const GATE_OUTCOME_CLASS_BY_STATUS: Record<string, GateOutcomeClass> = {
  advanced: 'verdict-green',
  'advanced-prefix': 'verdict-green',
  'up-to-date': 'verdict-green',
  // the one red
  'not-green': 'verdict-red',
  // infra aborts / withheld verdicts
  error: 'no-verdict',
  cancelled: 'no-verdict',
  'deadline-exceeded': 'no-verdict',
  'migrations-pending': 'no-verdict',
  'disk-headroom': 'no-verdict',
  'infra-inconclusive': 'no-verdict',
  // Standing pre-suite abort: the repair queue's staging expectation mismatched the tree.
  'repair-staging-mismatch': 'no-verdict',
  // P-006/P-007 exit-74 prerequisite outages: refused before any test ran.
  'dependency-prewarm-missing': 'no-verdict',
  'dependency-generation-unusable': 'no-verdict',
  // WI-42207: a WITHHELD verdict (candidate older than the fossil cap at verdict time) —
  // the suite's opinion was discarded, so nothing was established about the code.
  'candidate-fossil': 'no-verdict',
  'not-fast-forward': 'promotion-failed',
  'create-failed': 'promotion-failed',
  // The suite judged the code green but the perf gate held promotion — same shape as
  // not-fast-forward: judged, nothing shipped. See green-checkpoint.ts stampPromotion(false, …).
  'perf-held': 'promotion-failed',
  'desktop-perf-held': 'promotion-failed',
  // mid-run bridge
  'decision-pending': 'pending',
  'repair-in-progress': 'skip',
  // WI-42350's decline-to-rejudge self-clears on tree movement.
  'unchanged-since-verdict': 'skip',
  // A release-fixer DISPATCH diagnostic row, not a tick outcome — it rides the
  // green_checkpoint kind but records fixer routing, so it must not read as a verdict.
  'release-fixer-skipped-stale': 'skip',
};

/**
 * The statuses that COUNT as a verdict about the code — derived from the map above, so it
 * cannot drift from `classifyGateOutcomeStatus`. P-003's rate alarm passes this to SQL
 * (`status = ANY(...)`) to find the newest verdict-bearing row without a second hand list.
 */
export const VERDICT_BEARING_STATUSES: readonly string[] = Object.entries(GATE_OUTCOME_CLASS_BY_STATUS)
  .filter(([, cls]) => cls === 'verdict-green' || cls === 'verdict-red')
  .map(([status]) => status);

/**
 * Rows written under `green_checkpoint` that are not terminal outcomes for a fire.
 * `decision-pending` is an in-run bridge and the release-fixer statuses are dispatch
 * diagnostics; none may satisfy a fire in the liveness ledger.
 */
export const NON_TERMINAL_GATE_OUTCOME_STATUSES = [
  'decision-pending',
  'release-fixer-skipped-scope',
  'release-fixer-skipped-stale',
  'release-fixer-skipped-no-measured-failures',
] as const;

export function isTerminalGateOutcomeStatus(status: string): boolean {
  return !(NON_TERMINAL_GATE_OUTCOME_STATUSES as readonly string[]).includes(status);
}

/**
 * Classify one `kind='green_checkpoint'` status string. Single-homed here on purpose —
 * P-002's taxonomy work and P-003's rate alarm both need this exact map, and two copies
 * of it is how `failed`-vs-`fail` style never-match bugs happen.
 *
 * Unknown statuses fall back by prefix (`skipped-*` ⇒ skip) and then to 'unknown', so a
 * future status is VISIBLE in the reconstruction (its own column) rather than silently
 * absorbed into a class it may not belong to.
 */
export function classifyGateOutcomeStatus(status: string): GateOutcomeClass {
  const cls = GATE_OUTCOME_CLASS_BY_STATUS[status];
  if (cls) return cls;
  return status.startsWith('skipped-') ? 'skip' : 'unknown';
}

/** One reconstructed day. `unaccounted` = fires with no outcome row that day (killed/vanished). */
export interface GateFireDay {
  /** ISO date (UTC day). */
  day: string;
  /** Anchor rows (kind='green_checkpoint_fire'). 0 for days before the anchor landed. */
  fires: number;
  /** Outcome rows (kind='green_checkpoint'), total, including pending/diagnostic rows. */
  outcomes: number;
  /** Terminal outcome rows only; pending/diagnostic rows are excluded. */
  terminalOutcomes: number;
  verdictsGreen: number;
  verdictsRed: number;
  noVerdicts: number;
  skips: number;
  pending: number;
  promotionFailed: number;
  unknown: number;
  /**
   * max(0, fires - outcomes): fires that left NO outcome row — the silent-death class.
   * Meaningful only once the anchor is live; a pre-anchor day reads fires=0 so this
   * stays 0 rather than inventing negative history.
   */
  unaccounted: number;
  /** Distinct raw statuses that classified 'unknown', so a new status is nameable. */
  unknownStatuses: string[];
}

/**
 * The acceptance query: reconstruct the per-day fires→outcomes table for `sinceDays`
 * back, from SQL alone. Classification happens HERE (TS) so it stays single-homed with
 * `classifyGateOutcomeStatus`; the SQL is one grouped fetch over both kinds.
 */
export async function reconstructGateFireDays(
  sql: Sql,
  target: GateFireTarget,
  opts: { sinceDays?: number } = {},
): Promise<GateFireDay[]> {
  const sinceDays = Math.max(1, Math.min(365, Math.floor(opts.sinceDays ?? 14)));
  const rows = await sql<{
    day: string;
    kind: string;
    status: string;
    gate_fire_id: string | null;
    n: string | number;
  }[]>`
    SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           kind,
           status,
           NULLIF(detail->>'gateFireId', '') AS gate_fire_id,
           count(*) AS n
      FROM harness_shared.pipeline_events
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND kind IN ('green_checkpoint', ${GATE_FIRE_KIND})
       AND created_at >= now() - make_interval(days => ${sinceDays})
     GROUP BY 1, 2, 3, 4
     ORDER BY 1`;
  type DayAccumulator = GateFireDay & {
    anchorIds: Set<string>;
    terminalIds: Set<string>;
    legacyFires: number;
    legacyOutcomes: number;
  };
  const byDay = new Map<string, DayAccumulator>();
  const dayOf = (day: string): DayAccumulator => {
    let d = byDay.get(day);
    if (!d) {
      d = {
        day,
        fires: 0,
        outcomes: 0,
        terminalOutcomes: 0,
        verdictsGreen: 0,
        verdictsRed: 0,
        noVerdicts: 0,
        skips: 0,
        pending: 0,
        promotionFailed: 0,
        unknown: 0,
        unaccounted: 0,
        unknownStatuses: [],
        anchorIds: new Set<string>(),
        terminalIds: new Set<string>(),
        legacyFires: 0,
        legacyOutcomes: 0,
      };
      byDay.set(day, d);
    }
    return d;
  };
  for (const row of rows) {
    const d = dayOf(row.day);
    const n = Number(row.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (row.kind === GATE_FIRE_KIND) {
      if (row.status === GATE_FIRE_STATUS) {
        d.fires += n;
        if (isGateFireId(row.gate_fire_id)) d.anchorIds.add(row.gate_fire_id);
        else d.legacyFires += n;
      }
      continue;
    }
    d.outcomes += n;
    if (!isGateFireId(row.gate_fire_id)) d.legacyOutcomes += n;
    const terminal = isTerminalGateOutcomeStatus(row.status);
    if (terminal) {
      d.terminalOutcomes += n;
      if (isGateFireId(row.gate_fire_id)) d.terminalIds.add(row.gate_fire_id);
    }
    switch (classifyGateOutcomeStatus(row.status)) {
      case 'verdict-green':
        d.verdictsGreen += n;
        break;
      case 'verdict-red':
        d.verdictsRed += n;
        break;
      case 'no-verdict':
        d.noVerdicts += n;
        break;
      case 'skip':
        d.skips += n;
        break;
      case 'pending':
        d.pending += n;
        break;
      case 'promotion-failed':
        d.promotionFailed += n;
        break;
      case 'unknown':
        d.unknown += n;
        if (!d.unknownStatuses.includes(row.status)) d.unknownStatuses.push(row.status);
        break;
    }
  }
  for (const d of byDay.values()) {
    // Stable identities reconcile one terminal outcome to one fire, so a pending bridge,
    // duplicate terminal row, or a different fire's healthy outcome cannot mask a death.
    // Legacy rows have no correlation identity; preserve the historical count fallback
    // (including pending/diagnostic rows) rather than inventing terminal ownership.
    const identifiedFires = d.anchorIds.size;
    const identifiedTerminalFires = [...d.anchorIds].filter((id) => d.terminalIds.has(id)).length;
    const legacyFires = Math.max(0, d.fires - identifiedFires);
    d.unaccounted =
      d.fires > 0
        ? Math.max(0, identifiedFires - identifiedTerminalFires) +
          Math.max(0, legacyFires - d.legacyOutcomes)
        : 0;
    d.unknownStatuses.sort();
    delete (d as Partial<DayAccumulator>).anchorIds;
    delete (d as Partial<DayAccumulator>).terminalIds;
    delete (d as Partial<DayAccumulator>).legacyFires;
    delete (d as Partial<DayAccumulator>).legacyOutcomes;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
