/**
 * The `wpop` / `wppop` URL grammar — the chat ref-pill popups' shared encoding
 * (chat-ref-pills-2026-07-26 P-008 / D-002 seam; extracted for WI-6601, shared
 * with the portal for WI-10001509).
 *
 * WHY THIS IS A MODULE and not two inline `indexOf('::')` calls: these params
 * are written by SEVERAL surfaces across BOTH hosts (OperatorChat's own ref
 * pills, the sidebar's curator-card drill-in, the portal's PortalPapercupChat)
 * and read by ONE renderer per host (ChatRefPopupHost). A writer and the reader
 * disagreeing about the grammar is an invisible dead click — the param looks
 * right in the URL and nothing opens, which is exactly the WI-6601 failure
 * mode. One encoder + one decoder means they cannot drift.
 *
 * WHY IT LIVES HERE rather than in `apps/operator`: the portal writes these
 * params too (WI-10001509), and it reaches the operator's chat only through
 * this package. A second copy of the grammar on the portal side would be the
 * same drift risk one repo boundary out — so the grammar moved to the shared
 * chat package and the operator keeps a re-export shim at its historical path.
 *
 * GRAMMAR: `<harnessSlug>::<id>`, mirroring `curator-card-drill-in.ts`'s
 * `<planSlug>::<itemId>` `sel` convention. The harness is part of the VALUE
 * rather than read from the surrounding surface because both lookups
 * (`workItems.detail`, `plans:get`) are harness-scoped while the surfaces that
 * open them are not: the persistent chat sidebar is a cross-harness mount with
 * no `?slug` at all. A ref that carries its own harness therefore opens
 * correctly from ANY surface, which a surface-derived harness cannot do.
 *
 * A BARE value (no `::`) is accepted and decodes to `{ harness: null, id }` —
 * both for back-compat with links minted before `wppop` carried a harness, and
 * so a writer with genuinely no harness context can still name the id and let
 * the reader fall back to the resolved surface harness (the same
 * `<ref's own> ?? <surface's>` precedence HudView already applies to `hudwi`).
 */

import type { WorkRefKind } from './parse-work-refs';

/** The open work-item popup (`WI-`/`EI-`/`F-`). */
export const CHAT_WORK_ITEM_POPUP_PARAM = 'wpop';
/** The open plan popup. Distinct from PlansPane's own `pplan` so a plan opened
 *  from chat and one opened from the Plans pane don't fight over one key. */
export const CHAT_PLAN_POPUP_PARAM = 'wppop';

const SEP = '::';

/** Build a param value. A null/empty harness yields the bare id rather than a
 *  `"::id"` with an empty scope — the decoder treats those identically, but a
 *  bare value is what every pre-existing link already looks like. */
export function encodeScopedRef(harness: string | null | undefined, id: string): string {
  return harness ? `${harness}${SEP}${id}` : id;
}

/** Split a param value into its harness + id. Never throws; an absent/blank
 *  value decodes to all-null (i.e. "closed"), which is what both popups render
 *  as nothing. */
export function decodeScopedRef(
  raw: string | null | undefined,
): { harness: string | null; id: string | null } {
  if (!raw) return { harness: null, id: null };
  const sep = raw.indexOf(SEP);
  if (sep < 0) return { harness: null, id: raw || null };
  return {
    harness: raw.slice(0, sep) || null,
    id: raw.slice(sep + SEP.length) || null,
  };
}

/** A ref activation, in the shape `PapercupChat`'s `onWorkRefActivate` seam emits. */
export interface ChatWorkRef {
  id: string;
  kind: WorkRefKind;
  planSlug?: string | null;
}

/** Which popup param a ref activation writes, and with what value. */
export interface ChatRefPopupTarget {
  param: typeof CHAT_WORK_ITEM_POPUP_PARAM | typeof CHAT_PLAN_POPUP_PARAM;
  value: string;
}

/**
 * The ref-activation DECISION, shared by every host that writes these params.
 *
 * WHY THIS IS SHARED and not re-written per host: the seam is deliberately
 * host-injected, so each host supplies its own `onWorkRefActivate`. That is
 * exactly how the two hosts drifted into WI-10001509 — one wired the seam and
 * the other rendered a dead pill. The GRAMMAR being shared (above) stops a
 * writer and the reader disagreeing; this stops two WRITERS disagreeing, which
 * is the same failure one layer up. A host keeps its own setters; only the
 * decision is common.
 *
 * `null` means OPEN NOTHING, and both such cases are deliberate:
 *   - a plan-item ref with no plan context — there is no plan to open, so a
 *     guess would open the wrong one (P-006's "no plan context" stance);
 *   - a work-item ref with no harness — `workItems.detail` is harness-scoped,
 *     so there is nothing safe to ENCODE (mirrors HydratedWorkRefPill's own
 *     hydration gate one layer down).
 */
export function workRefPopupTarget(
  ref: ChatWorkRef,
  harnessSlug: string | null | undefined,
): ChatRefPopupTarget | null {
  if (ref.kind === 'plan-item') {
    if (!ref.planSlug) return null;
    return { param: CHAT_PLAN_POPUP_PARAM, value: encodeScopedRef(harnessSlug, ref.planSlug) };
  }
  if (!harnessSlug) return null;
  return { param: CHAT_WORK_ITEM_POPUP_PARAM, value: encodeScopedRef(harnessSlug, ref.id) };
}

/**
 * Whether activating this ref would open ANYTHING — i.e. whether the pill has
 * earned an interactive affordance (WI-10001541).
 *
 * WHY THIS EXISTS: `workRefPopupTarget` returning `null` is a legitimate,
 * deliberate outcome (see its two cases above), but the renderer used to decide
 * a pill's TAG from a different question — "did the host wire a seam at all?" —
 * and those two questions disagree for exactly the refs that resolve to
 * nothing. The result was a `<button>` that could be focused, tabbed to and
 * clicked and did nothing at all: the same dead-click symptom WI-10001509 fixed
 * for work-item pills, surviving one layer up for plan-item pills. A control
 * that cannot act is worse than plain text, because only the control claims it
 * can.
 *
 * So the ONE decision that already governs what activation does now also
 * governs whether the pill offers activation; a ref that opens nothing renders
 * as the inert `<span>` branch instead. Gating on the shared decision rather
 * than on a per-host predicate is deliberate: both hosts wire this seam to
 * these popups, and the whole point of this module is that they cannot drift.
 * A future host with genuinely different activation semantics is when to add a
 * host-supplied predicate — not before.
 */
export function canOpenWorkRef(
  ref: ChatWorkRef,
  harnessSlug: string | null | undefined,
): boolean {
  return workRefPopupTarget(ref, harnessSlug) !== null;
}
