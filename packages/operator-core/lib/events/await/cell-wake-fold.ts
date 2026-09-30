/**
 * `cell-wake-fold` — the DELIVERY-TIME reading folded into a predicate wake's turn
 * (state-plane-interest-and-hardening-2026-08-21 P-022, implementing D-007).
 *
 * ── WHY THIS IS NOT DONE AT THE FIRE SITE ───────────────────────────────────
 *
 * P-001 put a `reread` HANDLE in the fire payload, which fixed the leak that a wake
 * handed an agent a volatile value (`observed`) with no way to re-answer it. But the
 * payload's `observed` is still a FIRE-TIME snapshot, and the gap between fire and
 * delivery is not small: a parked session has to boot, a cold carry has to respawn, a
 * busy session drains its input queue first. The agent is woken BECAUSE of that value
 * and is therefore maximally likely to act on it — at exactly the moment it is most
 * likely to be stale. Resolving at the fire site would only move the staleness earlier.
 *
 * So the reading is resolved HERE, when the turn is assembled, and stamped with the
 * instant it was taken. The handle rides along regardless, because a stamped reading is
 * still a snapshot — it is just a snapshot the agent can date.
 *
 * ── THE DEGRADED PATH IS THE COMMON PATH ────────────────────────────────────
 *
 * A wake is an interrupt, and D-007 is explicit that resolving must never delay one.
 * That is not a theoretical constraint here. The census behind P-004 measured
 * `state:subscribe`'s own inline resolver eval at p50 324ms, p95 2037ms, max 45511ms
 * against these very cells — so the p95 case ALREADY blows any wake-safe budget. The
 * budget breach is ordinary, not exceptional, and the handle-only degrade is a
 * first-class outcome rather than an error path.
 *
 * Which is why a degrade is ANNOUNCED rather than silently omitted. A wake that simply
 * lacked a fold would read as "nothing to say about the value", and an agent that reads
 * absence as reassurance is the false-all-clear failure this whole subsystem is built
 * to refuse. When the reading cannot be taken, the block says so and names the handle.
 *
 * TOTAL: never throws, never blocks. Every failure — an unparseable key, a GC'd watch
 * row, an unregistered cell, a reader now outside the audience, a slow or throwing
 * resolver — yields the handle-only form or `null`, i.e. the pre-P-022 wake.
 */

import { briefCellValue, cellAssessmentLines, formatCellHoist, readCell } from '../../cell-read';
import { deriveCellReread, getPredicateWatch } from './predicate-watch';

/** Wake-safe resolve budget. Deliberately far below `readCell`'s own ~10s bound: that
 *  ceiling exists to stop a hung resolver wedging a caller, which is a different job
 *  from "must not delay an interrupt". */
export const CELL_WAKE_FOLD_BUDGET_MS = 1200;

const PREDICATE_KEY_PREFIX = 'predicate:';

export interface CellWakeFoldInput {
  eventKey: string;
  workspaceId: string;
  /** Overridable for tests; the real budget is CELL_WAKE_FOLD_BUDGET_MS. */
  budgetMs?: number;
}

function handleCall(handle: { args: { cell: string; as?: string } }): string {
  const { cell, as } = handle.args;
  return `state:read { cell: '${cell}'${as ? `, as: '${as}'` : ''} }`;
}

/**
 * Resolve with a hard ceiling. The loser of the race is ABANDONED, not cancelled —
 * `readCell` has no abort seam and inventing one for this would be a far larger change
 * than the fold warrants. The abandoned promise settles into a no-op, so the cost of a
 * breach is a wasted resolver call, never a delayed wake.
 */
async function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | 'budget-exceeded'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'budget-exceeded'>((resolve) => {
        timer = setTimeout(() => resolve('budget-exceeded'), budgetMs);
        // Never hold the process open for a fold.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build the block for a predicate wake, or `null` when this delivery is not a
 * cell-backed predicate fire at all (an ordinary `events:await`, an inbox wake, a loop
 * fire — none of which have a cell to fold).
 */
export async function prepareCellWakeFold(input: CellWakeFoldInput): Promise<string | null> {
  try {
    if (!input.eventKey.startsWith(PREDICATE_KEY_PREFIX)) return null;
    const watchId = input.eventKey.slice(PREDICATE_KEY_PREFIX.length);
    if (!watchId) return null;

    // The row is the identity source. A delivery carries workspace + subscriber but not
    // the reader's ROLE or HARNESS, and readCell needs both to run the audience check;
    // the watch row has carried them since registration.
    const row = await getPredicateWatch(watchId);
    if (!row) return null; // GC'd or already reaped — nothing to say.

    /**
     * Re-derive from the REGISTRY at delivery time rather than trusting the fire
     * payload's stored `reread` (D-038 axis 5). A stored cell id cannot notice a rename,
     * a re-scope, or the reader having left the cell's audience between fire and
     * delivery; this can, and out-of-audience correctly yields no handle rather than
     * leaking that the cell exists (P-019).
     */
    const handle = deriveCellReread(row);
    if (!handle) return null;

    const reader = {
      ownerId: row.ownerId,
      roles: row.role ? [row.role] : [],
      harnessSlug: row.harnessSlug ?? undefined,
    };
    const env = { workspaceId: input.workspaceId, harnessSlug: row.harnessSlug, role: row.role };

    const outcome = await withBudget(
      readCell(handle.args.cell, reader, env, handle.args.as).catch(() => 'resolver-failed' as const),
      input.budgetMs ?? CELL_WAKE_FOLD_BUDGET_MS,
    );

    // Both degrades say the same thing to the agent — the value was not re-read — and
    // differ only in why. Naming the reason keeps a chronically slow resolver
    // distinguishable from a broken one in the transcript.
    if (outcome === 'budget-exceeded' || outcome === 'resolver-failed') {
      const why =
        outcome === 'budget-exceeded'
          ? `did not resolve within ${input.budgetMs ?? CELL_WAKE_FOLD_BUDGET_MS}ms`
          : 'could not be resolved';
      return (
        `[cell] ${handle.args.cell} — NOT re-read at delivery: it ${why}, so the value quoted above ` +
        `is the FIRE-TIME snapshot and may be stale. Re-read before acting: ${handleCall(handle)}`
      );
    }

    const read = outcome;
    const stamp = new Date().toISOString();

    if (read.status === 'absent') {
      // Deliberately uninformative, exactly as state:read is: never distinguish
      // "unregistered" from "not yours".
      return null;
    }

    const lines: string[] = [];
    if (read.status === 'value') {
      /**
       * P-005 / D-014 — THE ASSESSMENT PRECEDES THE RAW MEASUREMENT, here exactly as in
       * `state:read`. A wake is an interrupt: the agent is being resumed BECAUSE of this
       * value and will act on the first thing it reads, so the first thing it reads is
       * what the value MEANS, not the number it happens to hold. Rendered by the SHARED
       * formatter (D-014 §2) so a push and a pull cannot drift apart.
       */
      lines.push(`[cell] ${read.cell}  (re-read at delivery ${stamp})`);
      if (read.assessment) {
        lines.push(...cellAssessmentLines(read.assessment));
      } else {
        // ANNOUNCED, never silently omitted — the same rule the degrade path above
        // follows. A cell with no declared assessment means nobody stated what its value
        // means, and a reader who simply sees no semantics block would read that absence
        // as reassurance, which is the false all-clear this whole subsystem refuses.
        lines.push('  ⚠ assessment · NONE DECLARED for this cell — the measurement below is UNINTERPRETED');
      }
      lines.push(`  measurement · ${read.headline} = ${briefCellValue(read.value)}`);
      if (read.material) {
        // P-021: the MATERIAL answer is a lens on the same derivation, and it is the one
        // a subscriber watching a high-churn cell actually asked about.
        lines.push(`  material · ${read.material.path} = ${briefCellValue(read.material.value)}`);
      }
      const hoist = read.unknownHoist ? formatCellHoist(read.unknownHoist) : null;
      if (hoist) lines.push(`  ⚠ ${hoist}`);
      if (read.source && !read.source.authoritative) {
        lines.push(
          `  ⚠ INFERRED, not observed: ${read.headline} came from ` +
            `${read.source.value === null ? 'an unattributed source' : `\`${read.source.value}\``} — ${read.source.why}`,
        );
      }
    } else {
      // `unknown` — in-band and BRANCHABLE, so the code is what the agent needs
      // (`not-measured` ⇒ asking again is pointless, `resolver-failed` ⇒ retry,
      // `insufficient-data` ⇒ supply more input). Saying so beats omitting the block,
      // which would read as "the value is fine".
      lines.push(
        `[cell] ${read.cell} — UNKNOWN at delivery ${stamp}: ${read.unknown.code}` +
          `${read.unknown.detail ? ` — ${read.unknown.detail}` : ''}`,
      );
    }

    // The handle rides along on the healthy path too: this reading is itself a snapshot,
    // just a dated one, and the agent may act minutes from now.
    lines.push(`  re-read: ${handleCall(handle)}`);
    return lines.join('\n');
  } catch {
    // A fold must never break a wake.
    return null;
  }
}
