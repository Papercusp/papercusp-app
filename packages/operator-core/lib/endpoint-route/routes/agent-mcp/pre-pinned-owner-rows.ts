import { DISPLAY_TERMINAL_LAUNCH } from '../../../adv-sessions';
import type { LivenessVerdict } from '../../../agent-tools/coordination/liveness-oracle';

/**
 * The shape bootstrap-su reads when deciding whether a PRE-PINNED coord owner id
 * (`psu --owner-id=…`) may be used: every un-ended `adv_sessions` row currently
 * carrying that id.
 */
export type PrePinnedOwnerRow = {
  id: string;
  display: string | null;
  has_session: boolean;
  /** True once a PUI process won the workbench row's claim-before-open gate. */
  launched: boolean;
  /** The shared liveness-oracle verdict, reduced by
   * `mapPrePinnedOwnerSessionState` for this launch guard. */
  liveness?: PrePinnedOwnerLiveness;
};

export type PrePinnedOwnerLiveness = 'live' | 'dead' | 'unknown';

export type PrePinnedOwnerClassification<T extends PrePinnedOwnerRow> = {
  precursors: T[];
  /** Non-precursor rows whose shared oracle verdict is `ended` or `suspect`. */
  reclaimableConflicts: T[];
  /** Non-precursor rows with any other, missing, or unknown verdict. */
  conflicts: T[];
};

/**
 * Split the live rows for a pre-pinned owner into the launcher's own PRECURSOR
 * rows and genuine CONFLICTS.
 *
 * A precursor is either the starting terminal row `launch-su` writes for the very
 * launch now booting, or a `display='workbench'` row after PUI atomically claimed
 * it (`launched_at` set) and opened its one psu pane. bootstrap-su ADOPTS either
 * precursor instead of inserting a second row, which keeps the deferred row's
 * advSessionId stable into the running session. An unclaimed workbench row is not
 * a precursor: accepting it would route around PUI's single-launcher claim gate.
 * A conflict is anything else — which is the split-identity case the freshness
 * guard exists to refuse (WI-5002/EI-13277). A conflict may be
 * placed in `reclaimableConflicts` only when the shared oracle maps the owner to
 * `dead` from its `ended`/`suspect` verdict; live and unknown rows stay in `conflicts`.
 *
 * ⚠ Why this is ONE pass and not two filters. The original shape was:
 *
 *     const precursors = live.filter(isPrecursor);
 *     const conflicts  = live.filter((r) => !precursors.includes(r));
 *
 * which quietly requires that iterating the query result TWICE yields the SAME
 * object references. Nothing in the data promises that — it is a property of the
 * driver. postgres.js satisfies it today, but this pool is reached through the
 * `withWorkspace` acquire seam, and any lazily-mapped, proxied, or instrumented
 * result would hand back fresh objects on the second traversal. `includes` would
 * then miss for EVERY row, every precursor would be reclassified as a conflict, and
 * psu would be refused adoption of its own starting row — the exact owner-facing
 * symptom of WI-37743 ("+ New session" dies with "its terminal closed before the
 * session came online"), reappearing with no code change to blame.
 *
 * Classifying by VALUE in a single pass cannot express that bug. Note the branches
 * are exhaustive on purpose: every row lands in exactly one bucket, so a row can
 * never be silently dropped from all three.
 */
export function classifyPrePinnedOwnerRows<T extends PrePinnedOwnerRow>(
  live: Iterable<T>,
): PrePinnedOwnerClassification<T> {
  const precursors: T[] = [];
  const reclaimableConflicts: T[] = [];
  const conflicts: T[] = [];
  for (const row of live) {
    const terminalPrecursor = row.display === DISPLAY_TERMINAL_LAUNCH && !row.has_session;
    const claimedWorkbenchPrecursor = row.display === 'workbench' && row.launched && !row.has_session;
    if (terminalPrecursor || claimedWorkbenchPrecursor) precursors.push(row);
    else if (row.liveness === 'dead') reclaimableConflicts.push(row);
    else conflicts.push(row);
  }
  return { precursors, reclaimableConflicts, conflicts };
}

/**
 * Map the shared oracle's owner-level verdict to the narrower launch-guard
 * vocabulary. The caller resolves the owner once through the shared liveness
 * oracle and every candidate row receives that same owner-level verdict.
 */
export function mapPrePinnedOwnerSessionState(
  sessionState: LivenessVerdict['sessionState'] | undefined,
): PrePinnedOwnerLiveness {
  // Reclaim is deliberately narrower than the oracle's full state machine:
  // only its confirmed terminal states (`ended` / `suspect`) may release an
  // existing binding. `recorded`, `live`, `parked`, `draining`, null, and a
  // failed/omitted read all remain non-reclaimable and therefore block.
  if (sessionState === 'ended' || sessionState === 'suspect') return 'dead';
  if (sessionState === 'live') return 'live';
  return 'unknown';
}

/**
 * The per-row evidence appended to a refusal, e.g.
 * `14746(display=terminal,session=bound)`.
 *
 * The refusal is launch-blocking and owner-visible (psu prints it, and since
 * WI-37841 it lands in `~/.papercusp/psu-launch-logs/<owner>.log`), so it must
 * explain ITSELF. Naming only a row id cost a full forensic session on WI-37858:
 * the row named in the message satisfied the precursor predicate by the time anyone
 * read it, leaving no way to tell a real conflict from a misclassified precursor.
 */
export function describePrePinnedConflicts(conflicts: readonly PrePinnedOwnerRow[]): string {
  return conflicts
    .map((c) => `${c.id}(display=${c.display ?? 'null'},session=${c.has_session ? 'bound' : 'none'})`)
    .join(', ');
}
