/**
 * Consumer attestation for a landed plan-item status flip (WI-10005199,
 * generalizing EI-23770243810745552).
 *
 * `plans:set-status` writes the status into the plan BODY (a markdown line, under
 * `withPlanLock`); the structured `items` index and `op_*` columns are a DERIVED
 * projection maintained on write. Every downstream CONSUMER — `plans:get-item`,
 * `plans:items`, the scheduler's lane derivation, `plans:set-plan-status`'s ship gate —
 * reads `getPlanRow → planItemsForRow → resolveEffectiveStatusForItems`, i.e. the
 * index (falling back to a markdown parse only when the index is empty) and then the
 * blocked-by graph. So a flip that reports `ok` has only proven the body write: the
 * index can still say `todo` (observed: "structured plan index stays todo despite
 * canonical content being done"), and a `todo`/`wip` flip on an item whose blockers are
 * unresolved legitimately reads `blocked` to every consumer.
 *
 * This compares what the write intended (`status`) with the `effectiveStatus` the
 * consumer read returns for that item. It is exception-only: `attestLandedPlanItemStatus`
 * returns `undefined` when the two agree, so an ordinary flip's response is unchanged and
 * only a disagreement grows a `consumerView`.
 *
 * Leaf on purpose: no runtime imports beyond the shared consumer-view primitive. The
 * consumer read is INJECTED (`PlanItemConsumerReader`), so unit tests are PG-free and
 * `set-status.ts` does not pull a second read-side graph into its own import closure; the
 * production reader is `plan-item-consumer-read.ts`.
 *
 * The read is NOT memoized across a batch: `plans:set-status` batches write item N+1
 * after item N, so a row cached after N is stale for N+1 and would report a false
 * divergence. One bounded read per LANDED flip is the correct unit.
 */
import { buildConsumerView, type ConsumerView } from '../../consumer-view';

/** The path the consumer reads for an item's status — NOT the plan body, the write target. */
export const PLAN_ITEM_CONSUMER_READ_PATH =
  'plans:get-item → getPlanRow → planItemsForRow → resolveEffectiveStatusForItems (effectiveStatus)';

/** Upper bound on the consumer read; an unreadable result is reported as diverged, never awaited forever. */
export const PLAN_ITEM_CONSUMER_READ_TIMEOUT_MS = 2_000;

/** The slice of a resolved plan item the attestation needs (structural — a `ResolvedItem` satisfies it). */
export interface ConsumedPlanItem {
  id: string;
  effectiveStatus?: string | null;
}

/** Reads the plan's items the way a consumer does. `null` = nothing readable (missing/legacy plan). */
export type PlanItemConsumerReader = (slug: string) => Promise<readonly ConsumedPlanItem[] | null>;

export interface PlanItemConsumerObservation {
  itemId: string;
  /** `null` = the consumer read returned nothing readable for this item (unreadable, timed out, or item absent). */
  status: string | null;
}

/** Pure comparison: what the write intended vs. what the consumer's item list says. */
export function attestPlanItemConsumerView(
  written: { itemId: string; status: string },
  consumedItems: readonly ConsumedPlanItem[] | null,
): ConsumerView<PlanItemConsumerObservation> {
  const item = consumedItems?.find((i) => i.id === written.itemId);
  return buildConsumerView<PlanItemConsumerObservation>({
    readPath: PLAN_ITEM_CONSUMER_READ_PATH,
    written: { itemId: written.itemId, status: written.status },
    consumed: { itemId: written.itemId, status: item?.effectiveStatus ?? null },
  });
}

/**
 * Bounded, fail-soft attestation of a landed flip. Never throws and never outlives
 * `timeoutMs`: a reader that rejects, hangs, or returns nothing is the "cannot prove
 * agreement" case and is reported as diverged (`value.status === null`) — an attestation
 * that cannot prove agreement must not claim it. Returns `undefined` on agreement, so the
 * caller can spread it unconditionally.
 */
export async function attestLandedPlanItemStatus(input: {
  slug: string;
  itemId: string;
  status: string;
  read: PlanItemConsumerReader;
  timeoutMs?: number;
}): Promise<{ consumerView: ConsumerView<PlanItemConsumerObservation> } | undefined> {
  const timeoutMs = input.timeoutMs ?? PLAN_ITEM_CONSUMER_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consumed: readonly ConsumedPlanItem[] | null = null;
  try {
    consumed = await Promise.race([
      input.read(input.slug),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    consumed = null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const consumerView = attestPlanItemConsumerView({ itemId: input.itemId, status: input.status }, consumed);
  return consumerView.divergedFromWrite ? { consumerView } : undefined;
}
