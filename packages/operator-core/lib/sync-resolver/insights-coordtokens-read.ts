/**
 * insights-coordtokens-read.ts — the coord-token snapshot, BOUNDED and shared by
 * BOTH callers (WI-39825).
 *
 * ## Why this is its own module
 *
 * Two reasons, and the second is the one that made it urgent.
 *
 * 1. GUARDABILITY. Proving a read deadline fires means MOVING it, and a
 *    resolver's only input is its wire `argsSchema` — so the knob has to live
 *    off the wire or the guard has to genuinely wait the budget out (6s per
 *    case, past vitest's 5s default). `opts.budgetMs` is a FUNCTION parameter
 *    here, so the guard shrinks the budget to milliseconds and the shipped
 *    contract is untouched. Same seam as `learning-gym-read.ts` and
 *    `adv-roster-read.ts`.
 *
 * 2. TWO CALL SITES, ONE FAN-OUT. The `insights.coordTokens` resolver and the
 *    `insights.coordTokens` DERIVED-READ PRODUCER each had their own copy of the
 *    same three-leg `Promise.all`. Bounding only the resolver would have left the
 *    copy that actually runs unattended — the producer, on a 5-minute TTL — still
 *    able to hang. `learning.improvements` already shares its compute between
 *    producer and resolver for exactly this reason ("so the precomputed default
 *    and the on-read non-default variants can never drift"); this follows it.
 *
 * ## What the bound fixes
 *
 * Three legs fan out under one `Promise.all` with no deadline and no catch, and
 * every one is a GROUP BY / COUNT aggregation over the two highest-volume
 * telemetry tables in the system (a 7d window of `agent_usage_samples`, a 1d
 * `COUNT` + `COUNT(DISTINCT)` over `tool_invocations`). `Promise.all` waits for
 * the slowest, so one wedged aggregate took the whole snapshot down — past the
 * sync layer's `RESOLVER_READ_TIMEOUT_MS` on the read path, and, worse, with no
 * bound at all on the PRODUCER path, where a hang occupies a scheduled routine
 * rather than one user's request.
 *
 * The loaders are each already defensive about a missing column or table, so a
 * THROW was handled before this change. A HANG was not, and slowness — not
 * absence — is the characteristic symptom of an aggregate over the busiest
 * tables here. That is the gap the deadline closes.
 *
 * The legs are NOT equal:
 *
 *   - `coordBreakdown` IS the snapshot — the coord-cost rollup everything else
 *     annotates. A lapse PROPAGATES: a snapshot without it is not degraded, it
 *     is empty of the only thing it exists to carry.
 *   - `pricingBook` is a rate table rendered beside the breakdown. Its lapse
 *     degrades to `[]` plus a NAMED `degradedFields` entry.
 *   - `pollVolume` degrades to `null`, NOT to a zeroed `CoordPollVolume`. This
 *     is the one deliberate asymmetry in the file: that shape's fields are
 *     `wakePollCalls` and `wakePollRowSharePct`, so a synthetic empty would
 *     ASSERT "zero coord polls happened" — a confident wrong answer, in a
 *     payload whose entire purpose is quantifying that number. `null` says the
 *     one true thing available: not read.
 *
 * ⚠ CONTEXT (EI-20819071902373252): this query currently has NO client consumer
 * — the "Learnings → Tokens Coordination panel" it names was never ported to
 * operator-vite, so only the producer exercises it. Bounding it is still worth
 * doing (that producer is a scheduled routine), but if the filed delete lands,
 * this module goes with it and that is a feature, not a loss.
 */

import { classifyReadFailure, type DegradedField } from './degraded-snapshot';
import { createReadDeadline } from './read-deadline';
import type {
  CoordPollVolume,
  CoordTokenBreakdown,
  ModelPricingBookRow,
  RunQuery,
} from '../harness-insights/load-token-rollups';

/**
 * Deadline for the three-leg fan-out — the budget the other bounded reads carry
 * (see `adv-roster-read.ts` for the measurement), and, as there, deliberately
 * under the sync layer's `RESOLVER_READ_TIMEOUT_MS`: a budget at or above it
 * cannot prevent the timeout it exists to prevent.
 */
export const COORD_TOKENS_READ_BUDGET_MS = 6_000;

export interface CoordTokensSnapshot {
  /** The per-MTok rate book. `[]` when its leg lapsed — see `degradedFields`. */
  pricingBook: ModelPricingBookRow[];
  /** The coord-cost rollup. The primary leg: absent means the read rejected. */
  coordBreakdown: CoordTokenBreakdown;
  /** `null` when its leg lapsed — never a zeroed shape (see the header). */
  pollVolume: CoordPollVolume | null;
  /** Present ONLY when a supplementary leg degraded. */
  degradedFields?: DegradedField[];
}

export interface ReadCoordTokensOptions {
  /**
   * The tx-bound query runner. Passed in rather than acquired here because the
   * two callers acquire a tx differently (`routeWithWorkspace` on the read path,
   * `withWorkspace` on the producer path) — the fan-out is what they share, not
   * the transaction.
   */
  runQuery: RunQuery;
  workspaceId: string;
  /** Optional harness narrowing; omit for the fleet-wide read. */
  harness?: string;
  /** Optional window override; omit for the fixed defaults (7d cost / 1d poll). */
  windowMs?: number;
  /**
   * Deadline for the whole fan-out. A FUNCTION parameter, never a wire field —
   * it exists so the guard can prove the deadline fires without waiting
   * {@link COORD_TOKENS_READ_BUDGET_MS} out.
   */
  budgetMs?: number;
}

/**
 * Read the coord-token snapshot as the 1-element array both call sites return.
 *
 * Rejects only when `coordBreakdown` fails or lapses. A lapsed supplementary leg
 * returns a snapshot that is TRUE about its intact legs and names the casualty.
 */
export async function readCoordTokens(
  opts: ReadCoordTokensOptions,
): Promise<[CoordTokensSnapshot]> {
  const {
    runQuery,
    workspaceId,
    harness,
    windowMs,
    budgetMs = COORD_TOKENS_READ_BUDGET_MS,
  } = opts;
  const { loadModelPricingBook, loadCoordTokenBreakdown, loadCoordPollVolume } = await import(
    '../harness-insights/load-token-rollups'
  );

  const degradedFields: DegradedField[] = [];
  /** Note a supplementary leg's failure instead of swallowing it. */
  const noteDegraded = <T>(field: string, empty: T) => (err: unknown): T => {
    const { kind, reason } = classifyReadFailure(err);
    console.warn(`[insights.coordTokens] ${field} read failed:`, reason);
    degradedFields.push({ field, kind, reason });
    return empty;
  };

  const withinBudget = createReadDeadline(budgetMs);
  const [pricingBook, coordBreakdown, pollVolume] = await Promise.all([
    withinBudget(loadModelPricingBook(runQuery), 'coordTokens pricingBook').catch(
      noteDegraded<ModelPricingBookRow[]>('pricingBook', []),
    ),
    // PRIMARY: a lapse propagates, as a throw from this loader does today.
    withinBudget(
      loadCoordTokenBreakdown({ workspace_id: workspaceId, harness_slug: harness, windowMs, runQuery }),
      'coordTokens coordBreakdown',
    ),
    withinBudget(
      loadCoordPollVolume({ workspace_id: workspaceId, windowMs, runQuery }),
      'coordTokens pollVolume',
    ).catch(noteDegraded<CoordPollVolume | null>('pollVolume', null)),
  ]);

  return [
    {
      pricingBook,
      coordBreakdown,
      pollVolume,
      // Omitted entirely when every leg succeeded, so a healthy snapshot stays
      // byte-identical to what it was before the bound — the field's PRESENCE is
      // the signal, exactly as `unavailable` is for a whole-snapshot fault.
      ...(degradedFields.length > 0 ? { degradedFields } : {}),
    },
  ];
}
