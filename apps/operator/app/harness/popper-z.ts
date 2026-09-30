import { useSyncExternalStore } from 'react';

/**
 * The shared LAYER MODEL for everything that escapes the app shell — the
 * body-portaled Radix poppers (Popover / Select / Tooltip / Combobox) and the
 * Radix Dialogs behind `harness/Modal`.
 *
 * There are exactly TWO floors here, and they are ordered on purpose:
 *
 *     shell layers  <  POPPER_WRAPPER_FLOOR_Z (1500)  <  MODAL_FLOOR_Z (2000)
 *
 * A popper must clear the shell. A modal must clear the popper it was opened
 * FROM. And a popper opened INSIDE a modal must clear that modal — which is
 * why the popper floor is not a constant but a function of what is open (see
 * `popperFloorZ`). Getting only the first of those three right is what shipped
 * the bug this file's history is made of.
 *
 * WHY THE POPPER FLOOR IS A SHARED CONSTANT AND NOT A LITERAL PER COMPONENT
 * ------------------------------------------------------------------------
 * Radix wraps popper Content in `[data-radix-popper-content-wrapper]`, which is
 * `position: fixed` and therefore joins the ROOT stacking context. A z-index set
 * on the *Content* only orders things INSIDE the wrapper — except that Radix
 * reads the Content's computed z-index at mount and copies it onto the wrapper
 * as an INLINE style. Inline beats a stylesheet rule without `!important`, so a
 * Content that sets a LOW z-index actively OVERRIDES the CSS floor in
 * `harness.css` (`[data-radix-popper-content-wrapper] { z-index: 1500 }`) and
 * re-creates the "menus do nothing" bug: the menu mounts, positions correctly,
 * reports `opacity: 1` / `pointer-events: auto`, and is painted behind the shell.
 *
 * The value must clear EVERY shell layer, not just the obvious ones: `<main>` is
 * 70 and the floating Oracle controls are 80, but `.oracle-dock--maximal-hud`
 * reaches 1450 — which is why anything "high-looking" but under 1500 (1400 is
 * the tempting one) still loses in maximal-HUD mode.
 *
 * This value is asserted to equal the CSS floor by
 * `apps/operator/app/_lints/popper-stacking.test.ts`, so the two cannot drift.
 * Keep them in sync by changing BOTH, or the lint fails.
 */
export const POPPER_WRAPPER_FLOOR_Z = 1500;

/**
 * The z-index floor for `harness/Modal` (its Radix Dialog overlay; the centring
 * wrap takes floor+1).
 *
 * THE BUG THIS EXISTS TO PREVENT (owner-reported 2026-08-08, WI-35969):
 * `Modal` defaulted to **100**, chosen only to clear the OracleDock at 80. The
 * popper floor had since been raised to 1500 for the reasons above, so every
 * modal opened FROM a dropdown was painted UNDER the dropdown that launched it.
 * Measured in the live desktop: clicking a conversation in the agents-running
 * pill opened `AgentInspectorModal` at z 100/101 beneath a popover at 1500, and
 * the popover's 626x393 overlap landed squarely on the modal's header and its
 * newest turns. From the user's side the box "opened behind the dropdown", and
 * with the inactive-sessions list expanded (a taller popover) the readable part
 * was covered entirely, so it read as "the conversation never loaded" — the
 * transcript was in fact arriving intact in 39ms.
 *
 * WHY 2000. It has to clear the popper floor (1500) and the header popdowns
 * (`.pc-header .pc-operator-popdown`, 1502), and it has to stay UNDER the
 * layers that are meant to cover a modal: `.pc-route-loading-overlay` (4900),
 * `.pc-route-pending-overlay` (5000) and sonner's toaster (2147483646) — a toast
 * fired from inside a modal must still be readable. 2000 is the round number in
 * the middle of that band.
 */
export const MODAL_FLOOR_Z = 2000;

/**
 * The top of the modal band. Nested modals step UP from `MODAL_FLOOR_Z`, and
 * this is where that stepping stops — which is what makes the band a BAND and
 * not an open-ended climb, so `TOOLTIP_FLOOR_Z` below can be provably above
 * every modal instead of being a guess about how deeply anyone nests.
 *
 * At `LAYER_STEP` granularity this allows 20 levels of modal↔popper nesting;
 * the deepest real stack in this app is 2 (a modal, a Select inside it).
 */
export const MODAL_CEILING_Z = 2400;

/**
 * Tooltips sit above the whole modal band, always.
 *
 * A tooltip is transient, belongs to the control the pointer is already on, and
 * is never something you want to read "under" anything — so unlike a menu it
 * has no reason to participate in the open/close ordering dance, and giving it
 * a static floor keeps every `Tooltip` in the app free of the modal-registry
 * subscription (they are numerous, and a menu is not).
 *
 * Still below `.pc-route-loading-overlay` (4900) and sonner's toaster
 * (2147483646). Asserted `> MODAL_CEILING_Z` by the popper-stacking lint.
 */
export const TOOLTIP_FLOOR_Z = 2500;

/**
 * The gap between adjacent layers. Big enough that a surface can claim a couple
 * of internal levels (an overlay + its centring wrap) without colliding with the
 * next layer up.
 */
export const LAYER_STEP = 10;

/* ────────────────────────────────────────────────────────────────────────────
 * The open-modal registry.
 *
 * WHY A REGISTRY AND NOT TWO STATIC CONSTANTS. The two orderings a static pair
 * of floors can express are mutually exclusive: "modals above poppers" buries
 * every Select/Tooltip opened inside a modal, and "poppers above modals" is the
 * bug above. The ordering is not a property of the COMPONENT KINDS, it is a
 * property of WHAT IS OPEN — so it has to be read at open time.
 *
 * Not hypothetical in either direction: seven files pair `harness/Modal` with
 * `Select`/`Combobox` (PlanActions, CreateHarnessPicker, FeatureEditor,
 * PrReviewerSettings, settings/voice, AdvShell, AskComposer), and any of them
 * would have lost its dropdown to a naive modal bump.
 *
 * `harness/Popover` (and `Combobox`/`ComboboxMenu`, which are built on it) is
 * ALSO immune by a second, independent mechanism — it portals into the nearest
 * `[role=dialog][aria-modal=true]` ancestor so it lands inside the focus trap
 * (EI-19481149734783914). `Select` and `Tooltip` portal to `document.body` and
 * have no such protection, so the z axis is the only thing holding them up.
 * ──────────────────────────────────────────────────────────────────────────── */

let nextToken = 0;
const openModals = new Map<number, number>();
const listeners = new Set<() => void>();

/** Cached top-open-modal z. 0 = no modal open. Cached (rather than recomputed
 *  per call) because `useSyncExternalStore` requires a snapshot that is stable
 *  while the store has not changed. */
let topZ = 0;

function recomputeTop(): void {
  let next = 0;
  for (const z of openModals.values()) if (z > next) next = z;
  if (next === topZ) return;
  topZ = next;
  for (const l of listeners) l();
}

/**
 * Announce that a modal is on screen at `z`, so poppers opened while it is up
 * can clear it. Returns the deregister function — call it when the modal closes
 * (an effect cleanup).
 *
 * Keyed by an opaque token rather than by the z value itself, so two modals that
 * legitimately share a z (opened in the same commit) cannot delete each other's
 * registration.
 */
export function registerOpenModalZ(z: number): () => void {
  const token = ++nextToken;
  openModals.set(token, z);
  recomputeTop();
  return () => {
    openModals.delete(token);
    recomputeTop();
  };
}

/** The highest currently-open modal's z, or 0 when no modal is open. */
export function topOpenModalZ(): number {
  return topZ;
}

/** Subscribe to open-modal changes (for `useSyncExternalStore`). */
export function subscribeModalLayer(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** TEST-ONLY: drop every registration so one test cannot leak into the next. */
export function _resetModalLayerRegistry(): void {
  openModals.clear();
  recomputeTop();
}

/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * The floor a popper must clear RIGHT NOW: the shell floor normally, or one step
 * above the topmost open modal when there is one.
 *
 * Raising every popper (not just the ones whose trigger is inside the dialog) is
 * deliberate — it keeps this a pure function of the registry with no DOM
 * ancestry walk, and the case it over-serves cannot arise: a `modal` Radix
 * Dialog blocks pointer events outside itself, so there is no background popper
 * to open while one is up. For a non-modal dialog, "the thing you just opened
 * wins" is the behaviour you want anyway.
 */
export function popperFloorZ(): number {
  const top = topOpenModalZ();
  return top ? Math.max(POPPER_WRAPPER_FLOOR_Z, top + LAYER_STEP) : POPPER_WRAPPER_FLOOR_Z;
}

/**
 * Clamp a caller-supplied popper z-index UP to the current floor.
 *
 * Callers legitimately want to order poppers relative to each other, but any
 * value below the floor is not "lower ordering" — it is burial behind the app
 * shell (or, inside a modal, behind that modal), because the wrapper competes in
 * the ROOT stacking context. Clamping (rather than trusting the caller) is what
 * makes the whole class impossible at the primitive instead of relying on ~10
 * call sites each getting it right; measured 2026-08-03, every explicit call
 * site was below the floor (five at 200, three at 1400, one at 120).
 *
 * Ties are fine: equal z-indexes resolve by DOM order, so a popper opened later
 * still paints above one opened earlier.
 */
export function clampPopperZ(zIndex: number | undefined): number {
  return Math.max(zIndex ?? POPPER_WRAPPER_FLOOR_Z, popperFloorZ());
}

/**
 * The z a modal opening RIGHT NOW should take: the modal floor, or clear of the
 * whole stack when it is being opened from inside another modal's popper.
 *
 * `top + 2 * LAYER_STEP` rather than `+ LAYER_STEP` because a popper opened over
 * that modal already claimed `top + LAYER_STEP` — a modal launched from THAT
 * popper (modal → select → modal) has to clear the popper, not just the modal.
 */
export function nextModalZ(): number {
  const top = topOpenModalZ();
  return clampModalZ(top ? top + 2 * LAYER_STEP : MODAL_FLOOR_Z);
}

/**
 * Hold a modal z inside the band: never below the floor (which is the whole
 * point — a legacy explicit `zIndex={120}` is not "lower ordering", it is
 * burial behind every dropdown), and never above the ceiling, so the band stays
 * bounded and `TOOLTIP_FLOOR_Z` stays provably on top.
 */
export function clampModalZ(zIndex: number | undefined): number {
  return Math.min(Math.max(zIndex ?? MODAL_FLOOR_Z, MODAL_FLOOR_Z), MODAL_CEILING_Z);
}

/**
 * `clampPopperZ` as a hook that RE-RENDERS its component when a modal opens or
 * closes.
 *
 * WHY THE SUBSCRIPTION IS LOAD-BEARING AND NOT A NICETY. Radix reads the
 * Content's computed z-index ONCE, in a layout effect keyed on the content node,
 * and copies it onto the popper wrapper — so the only value that ever matters is
 * the one on the element at MOUNT. `Select` and `Tooltip` keep their open state
 * inside Radix, so opening them does NOT re-render our wrapper component: the
 * style object they hand to Radix is whatever the LAST wrapper render produced.
 * Without a subscription that render predates the modal, the menu mounts with a
 * 1500 it can never correct, and it is buried for as long as it is open.
 *
 * Subscribing means the wrapper re-renders the moment the modal registers, well
 * before any user can open the menu inside it — so the element Radix eventually
 * mounts already carries the raised floor.
 */
export function usePopperZ(zIndex?: number): number {
  // Snapshot is the raw top-modal z (a number, stable while unchanged) — the
  // derived floor is computed after, so getSnapshot cannot return a fresh value
  // on every call and spin useSyncExternalStore.
  useSyncExternalStore(subscribeModalLayer, topOpenModalZ, getServerTopZ);
  return clampPopperZ(zIndex);
}

/** No modal is open during SSR — there is no registry on the server. */
function getServerTopZ(): number {
  return 0;
}
