import { useEffect } from 'react';
import { endInteraction, type PerfInteractionName } from './perf-marks';

/**
 * The settle half of a named interaction, as a hook — so the ONE rule that is
 * easy to get wrong lives in one place instead of being re-derived at every
 * settle site.
 *
 * ## Why `active` exists (EI-19383745196363732)
 *
 * The obvious settle effect is `useEffect(() => { if (settled) end() },
 * [settled])`. That is correct only when the panel UNMOUNTS on the way out and
 * remounts on the way back, because it relies on either a mount or a
 * loading→settled transition to run.
 *
 * A panel kept warm breaks it. LearningTab keeps the current pane and the two
 * most recent mounted (`warmViews`) and only flips `hidden`, so a normal
 * back-and-forth never remounts. The pane is already settled, `settled`
 * therefore never CHANGES, the effect never re-runs — and the interaction the
 * parent just began is never ended.
 *
 * That is the SILENT ZERO failure mode described in perf-marks.ts: no garbage
 * measure, just nothing. The start mark dangles until the next begin replaces
 * it, so the budget check passes by measuring zero — on the WARM path, which is
 * the one a real user takes most. Measured 2026-08-02: a run switching
 * pipeline → improvements → pipeline → learnings → pipeline → observations
 * emitted a measure for each view's FIRST visit and nothing at all for either
 * pipeline revisit, because pipeline was the landing view and so was warm both
 * times.
 *
 * Gating on `settled && active` fixes it without re-opening the false-green it
 * would be tempting to trade for: ending the moment a warm pane becomes visible
 * would report ~0ms for a pane that is warm but still LOADING (visit a view,
 * switch away before it settles, come straight back). Here `active` flips true
 * while `settled` is still false, nothing is emitted, and the measure lands
 * when the content is actually final — spanning the whole wait, which is what
 * the user experienced.
 *
 * Keep this PASSIVE (`useEffect`, never `useLayoutEffect`): the ordering
 * contract in perf-marks.ts requires every settle to run after the layout-phase
 * begin it pairs with.
 *
 * @param name    the interaction being measured
 * @param settled true once this panel is showing its FINAL content — resolved
 *                or faulted, but not still loading
 * @param active  true when this panel is the one actually on screen. Defaults
 *                to true for panels that are only ever rendered when visible.
 */
export function useInteractionSettle(
  name: PerfInteractionName | string,
  settled: boolean,
  active = true,
): void {
  useEffect(() => {
    if (settled && active) endInteraction(name);
  }, [name, settled, active]);
}
