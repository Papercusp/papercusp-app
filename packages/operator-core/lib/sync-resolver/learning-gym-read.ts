/**
 * learning-gym-read.ts — the Learning tab's Gym snapshot, BOUNDED (WI-39825).
 *
 * ## Why this is its own module and not still inline in the resolver
 *
 * The compute used to live inside `sync-resolver/index.ts`'s `learning.gym`
 * resolver as a local `fetchSnapshot`. Bounding it there is possible; GUARDING
 * the bound there is not, and an unfalsifiable guard is the thing this whole
 * class of work exists to avoid.
 *
 * A resolver's only input is its wire `argsSchema`. To prove a deadline fires
 * you need to move the deadline, and the only way to move it through a resolver
 * is to put a `budgetMs` knob into the CLIENT CONTRACT — a private test lever
 * shipped to every caller. The alternative, leaving the budget hardcoded at
 * {@link GYM_READ_BUDGET_MS} and genuinely waiting it out, costs 6s per test
 * case, blows vitest's 5s default, and produces exactly the kind of slow suite
 * somebody eventually deletes.
 *
 * Extraction is the seam that dissolves both problems, and it is the seam this
 * repo already chose: `learning-observations-read.ts`, `learning-frontier-read.ts`,
 * `learning-retain-read.ts`, `learning-hive-read.ts` and `learning-scout-read.ts`
 * are all this same shape. `opts.budgetMs` is a FUNCTION parameter here, never a
 * wire field, so the guard can shrink the budget to milliseconds and the shipped
 * contract is unchanged.
 *
 * ## What the bound actually fixes
 *
 * Five legs fan out under one `Promise.all`. Three of them already had
 * `.catch(…) => noteDegraded(…)`, which is real leg isolation for a leg that
 * THROWS and nothing at all for a leg that HANGS: `Promise.all` waits for the
 * slowest, so one wedged read takes the whole snapshot past the sync layer's
 * ~10s resolver timeout and the view 500s — shipping no rows and no
 * `degradedFields` either, because the response itself never ships. See
 * `read-deadline.ts` for the mechanism and the measured store latencies that
 * make slowness the characteristic symptom here rather than the exception.
 *
 * The legs are NOT equal, so they do not degrade equally:
 *
 *   - `proposals` / `autoloops` ARE the Gym view. A snapshot without them is
 *     not a degraded view, it is a wrong one — so a lapse propagates, exactly
 *     as a throw from those readers does today. The gain is a FAST, LABELLED
 *     failure at the budget instead of a hang the resolver timeout eventually
 *     converts into an unlabelled 500.
 *   - `archiveSeeds` / `cycles` / `runs` are supplementary sections that render
 *     empty perfectly well. Their lapse routes into the EXISTING `noteDegraded`
 *     path, so a timeout lands as a named entry in `degradedFields` — the same
 *     place a read failure already lands, carrying `<label> exceeded the read
 *     budget` verbatim as its reason.
 *
 * On the kind: a lapse is classified `read-failed`, not a new `timed-out`
 * member. `UnavailableKind` is a shared union consumed by the client guards in
 * `learning-degraded-provenance.*`; widening it to say something the verbatim
 * reason already says would strand those consumers for no information gain.
 */

import { classifyReadFailure, type DegradedField } from './degraded-snapshot';
import { createReadDeadline } from './read-deadline';

/**
 * The whole snapshot's budget, shared by every leg (see `createReadDeadline`:
 * one deadline, not a per-call budget). Sits under the sync layer's
 * `RESOLVER_READ_TIMEOUT_MS` ceiling so the bound can actually prevent the 500
 * it exists to prevent, and matches the roster read's budget.
 */
export const GYM_READ_BUDGET_MS = 6_000;

// A leg that degraded is recorded next to the intact data (WI-6395) as a shared
// `DegradedField` — the per-leg analog of `DegradedProvenance`, which lives in
// `degraded-snapshot.ts` beside the `classifyReadFailure` that populates it. It
// started life as a local `GymDegradedField` here and was lifted the moment the
// roster read needed the same three fields (WI-39825): one shape, one place, so
// a client guard written against it holds for every fan-out that reports one.

export interface ReadGymSnapshotOptions {
  /** Active workspace id — the gym is scoped per (workspace_id, harness_slug). */
  workspaceId: string;
  /**
   * The Hive HOME slug, which IS the gym harness_slug (per-hive-learning-loops
   * P-041). Omit for the cross-harness workspace rollup.
   */
  harnessSlug?: string;
  /**
   * Deadline for the whole fan-out. A FUNCTION parameter, never a wire field —
   * it exists so the guard can prove the deadline fires without waiting
   * {@link GYM_READ_BUDGET_MS} out. Defaults to {@link GYM_READ_BUDGET_MS}.
   */
  budgetMs?: number;
}

/**
 * Read the Gym snapshot: proposals + autoloops + the three supplementary
 * sections, bounded by one shared deadline.
 *
 * Rejects only when a leg the view cannot render without (proposals/autoloops)
 * fails or lapses. Every other failure mode returns a snapshot that is TRUE
 * about its intact legs and names the casualties in `degradedFields`.
 */
export async function readGymSnapshot(opts: ReadGymSnapshotOptions) {
  const { workspaceId, harnessSlug, budgetMs = GYM_READ_BUDGET_MS } = opts;
  const { routeWithWorkspace } = await import('../route-workspace');
  const {
    listRecentProposalsForWorkspace,
    listAutoloopsForWorkspace,
    listScoutArchiveSeeds,
    listRecentCyclesForWorkspace,
    listRecentGymRunsForWorkspace,
  } = await import('../gym/control-plane');

  const slugArg = harnessSlug ? { harnessSlug } : {};
  const degradedFields: DegradedField[] = [];
  /** Note a best-effort leg's failure instead of swallowing it into `[]`. */
  const noteDegraded = (field: string, err: unknown): never[] => {
    const { kind, reason } = classifyReadFailure(err);
    console.warn(`[learning.gym] ${field} read failed:`, reason);
    degradedFields.push({ field, kind, reason });
    return [];
  };

  return routeWithWorkspace(async (tx) => {
    const withinBudget = createReadDeadline(budgetMs);
    const [proposals, autoloops, archiveSeeds, cycles, runs] = await Promise.all([
      // PRIMARY: a lapse propagates, as a throw from this reader does today.
      withinBudget(
        listRecentProposalsForWorkspace(tx, { workspaceId, limit: 50, ...slugArg }),
        'gym proposals',
      ),
      withinBudget(listAutoloopsForWorkspace(tx, { workspaceId, ...slugArg }), 'gym autoloops'),
      // WI-5412 item 4: the Scout-seeded MAP-Elites niches — where the Ideas
      // view's gym-rail pills (`gym:SP-…`) actually land. Best-effort: a missing
      // archive table degrades to an absent section, never a 500.
      withinBudget(listScoutArchiveSeeds(tx, { workspaceId, ...slugArg }), 'gym archiveSeeds').catch(
        (err) => noteDegraded('archiveSeeds', err),
      ),
      // WI-5685: recent completed CYCLES from the durable run-analytics. A cycle
      // whose candidate loses mints NO proposal, so without this leg a finished
      // gym run is invisible here ("I was expecting runs from today").
      withinBudget(
        listRecentCyclesForWorkspace(tx, { workspaceId, limit: 20, ...slugArg }),
        'gym cycles',
      ).catch((err) => noteDegraded('cycles', err)),
      // WI-5808: recent RUN activity, straight from gym_runs. The cycles leg
      // above can be a single stale row, which is why the tab kept reading "no
      // recent runs" while the gym was plainly running.
      withinBudget(
        listRecentGymRunsForWorkspace(tx, { workspaceId, limit: 20, ...slugArg }),
        'gym runs',
      ).catch((err) => noteDegraded('runs', err)),
    ]);
    return {
      proposals,
      autoloops,
      archiveSeeds,
      cycles,
      runs,
      generatedAt: new Date().toISOString(),
      // Omitted entirely when every leg succeeded, so a healthy snapshot is
      // byte-identical to what it was before — the flag's PRESENCE is the
      // signal, exactly as `unavailable` is for a whole-snapshot fault.
      ...(degradedFields.length > 0 ? { degradedFields } : {}),
    };
  });
}
