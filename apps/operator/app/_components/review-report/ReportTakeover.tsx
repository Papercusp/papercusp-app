"use client";

/**
 * ReportTakeover (cleanup-report-flows-2026-08-24 P-001) — the app-pane
 * TAKEOVER chrome + nuqs-param helper shared by every report-review surface,
 * mirroring the PlanDashboardHost pattern (plan-visibility-revamp D-002): a
 * full-width layer over the routed <main> content while the routed page stays
 * MOUNTED underneath — back (clear the param) restores it with state intact,
 * which is what makes this a takeover rather than a navigation.
 *
 * The param KEY belongs to the consumer (one key per renderer — `?opcln=` for
 * the plan-cleanup review, the inbox review's own key for P-008), exactly as
 * pdash/pplan/wppop each own theirs. This module only standardizes the wiring
 * so state lives in the URL (nuqs, never useState — the agent → UI control
 * surface reads the URL) and the layer geometry/styling stays identical across
 * consumers.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { parseAsString, useQueryStates } from "nuqs";
import { toast } from "sonner";
import "./review-report.css";

/**
 * One URL marker arbitrates the heavyweight report foreground. The run params
 * remain independently deep-linkable; this marker only says which one may
 * hydrate and render its report tree.
 */
export const REPORT_TAKEOVER_OWNER_PARAM = "oprpt";

/**
 * Existing links predate the owner marker. Preserve their former paint-order
 * behavior deterministically: the later entry wins when several legacy run
 * params coexist. New report owners must register here before using the hook.
 */
export const REPORT_TAKEOVER_PARAM_PRIORITY = ["opcln", "opcbr"] as const;
export type ReportTakeoverParamKey =
  (typeof REPORT_TAKEOVER_PARAM_PRIORITY)[number];

const reportTakeoverParsers = {
  opcln: parseAsString,
  opcbr: parseAsString,
  [REPORT_TAKEOVER_OWNER_PARAM]: parseAsString,
};

function isReportTakeoverParamKey(
  value: string | null,
): value is ReportTakeoverParamKey {
  return REPORT_TAKEOVER_PARAM_PRIORITY.some((key) => key === value);
}

interface IsolatedSiblingState {
  count: number;
  inert: string | null;
  ariaHidden: string | null;
}

interface TakeoverParentState {
  count: number;
  restoreFocus: HTMLElement | null;
}

/** Multiple URL-owned takeovers can briefly coexist. Reference counts keep one
 * layer from exposing the routed page while another layer still covers it. */
const isolatedSiblings = new WeakMap<HTMLElement, IsolatedSiblingState>();
const takeoverParents = new WeakMap<HTMLElement, TakeoverParentState>();

function isolateSibling(node: HTMLElement): void {
  const existing = isolatedSiblings.get(node);
  if (existing) {
    existing.count += 1;
    return;
  }
  isolatedSiblings.set(node, {
    count: 1,
    inert: node.getAttribute("inert"),
    ariaHidden: node.getAttribute("aria-hidden"),
  });
  node.setAttribute("inert", "");
  node.setAttribute("aria-hidden", "true");
}

function releaseSibling(node: HTMLElement): void {
  const state = isolatedSiblings.get(node);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  isolatedSiblings.delete(node);
  if (state.inert === null) node.removeAttribute("inert");
  else node.setAttribute("inert", state.inert);
  if (state.ariaHidden === null) node.removeAttribute("aria-hidden");
  else node.setAttribute("aria-hidden", state.ariaHidden);
}

export interface ReportTakeoverParam {
  /** The raw param value (consumer-defined grammar), null when closed. */
  value: string | null;
  open: boolean;
  /** True only when this param owns the heavyweight report foreground. */
  foreground: boolean;
  /**
   * True only when the owner marker NAMES this param — i.e. someone called
   * `show()`, rather than the run param merely being present as a strip deep
   * link. The distinction is load-bearing for a LIVE run
   * (bulk-review-report-legibility-and-lifecycle-2026-08-31 D-005): a settled
   * run opens its report from any foreground claim, but a pending/running run
   * takes over the pane only when the owner asked for it, so the progress strip
   * keeps a bare `?opcln=`/`?opcbr=` deep link.
   */
  explicitOwner: boolean;
  /** Open the takeover with a value (a run ref, a phase, …). */
  show: (value: string) => Promise<URLSearchParams>;
  /** Clear the param — the routed page underneath resumes untouched. */
  close: () => Promise<URLSearchParams>;
}

export interface ReportTakeoverAvailability {
  /** False while the consumer's feature is disabled. */
  enabled: boolean;
  /** True until the explicit run lookup has settled. */
  loading: boolean;
  /** True once the selected run exists, regardless of its current phase. */
  available: boolean;
}

/**
 * Release a URL-marked foreground owner only after its explicit run lookup has
 * settled missing. A pending/running run is still available and keeps
 * ownership; a disabled or background consumer never mutates the URL.
 *
 * The ref prevents repeated close writes while nuqs is applying the atomic
 * run-param + owner-marker handoff. Once this consumer leaves foreground it is
 * reset, so revisiting the same now-missing deep link can recover again.
 */
export function useReleaseMissingReportTakeover(
  report: Pick<ReportTakeoverParam, "value" | "foreground" | "close">,
  availability: ReportTakeoverAvailability,
): void {
  const releasedValueRef = useRef<string | null>(null);
  const { value, foreground, close } = report;
  const { enabled, loading, available } = availability;

  useEffect(() => {
    if (!enabled || !foreground || !value) {
      releasedValueRef.current = null;
      return;
    }
    if (loading || available || releasedValueRef.current === value) return;
    releasedValueRef.current = value;
    toast.info(
      "That report run no longer exists. Its stale report link was cleared.",
    );
    void close();
  }, [available, close, enabled, foreground, loading, value]);
}

/** nuqs wiring for a report-takeover param. URL-owned on purpose: the takeover
 *  open/closed state is user-meaningful (deep-linkable, agent-visible via
 *  ui:get_state), unlike the in-review checkbox drafts which stay useState. */
export function useReportTakeoverParam(
  paramKey: ReportTakeoverParamKey,
): ReportTakeoverParam {
  const [params, setParams] = useQueryStates(reportTakeoverParsers);
  const value = params[paramKey];
  const markedOwner =
    isReportTakeoverParamKey(params[REPORT_TAKEOVER_OWNER_PARAM]) &&
    params[params[REPORT_TAKEOVER_OWNER_PARAM]] !== null
      ? params[REPORT_TAKEOVER_OWNER_PARAM]
      : null;
  const legacyOwner = [...REPORT_TAKEOVER_PARAM_PRIORITY]
    .reverse()
    .find((key) => params[key] !== null);
  const owner = markedOwner ?? legacyOwner ?? null;

  const ownerAfterClose =
    [...REPORT_TAKEOVER_PARAM_PRIORITY]
      .reverse()
      .find((key) => key !== paramKey && params[key] !== null) ?? null;
  const ownerPatch =
    owner === paramKey
      ? { [REPORT_TAKEOVER_OWNER_PARAM]: ownerAfterClose }
      : {};

  // Return the nuqs promise deliberately: consumers may need to sequence a
  // second URL-owned transition after this one (for example, closing the
  // report before opening a plan dashboard). Masking it with `void` makes an
  // `await report.close()` resolve before the URL update is applied.
  return {
    value,
    open: value !== null,
    foreground: value !== null && owner === paramKey,
    explicitOwner: value !== null && markedOwner === paramKey,
    show: (nextValue: string) =>
      setParams(
        paramKey === "opcln"
          ? { opcln: nextValue, [REPORT_TAKEOVER_OWNER_PARAM]: paramKey }
          : { opcbr: nextValue, [REPORT_TAKEOVER_OWNER_PARAM]: paramKey },
      ),
    close: () =>
      setParams(
        paramKey === "opcln"
          ? { opcln: null, ...ownerPatch }
          : { opcbr: null, ...ownerPatch },
      ),
  };
}

export interface ReportTakeoverLayerProps {
  children: ReactNode;
  /** Override the default testid when two takeovers could coexist in one DOM. */
  testId?: string;
  /** Accessible name for the app-pane region. */
  label?: string;
}

/** The takeover layer itself. Mount it (conditionally, when the param is set)
 *  inside `<main data-route-transition-page>` as a SIBLING of the routed
 *  content — same slot as `.plan-dash-takeover`. */
export function ReportTakeoverLayer({
  children,
  testId = "report-takeover",
  label = "Report review",
}: ReportTakeoverLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    const parent = layer?.parentElement;
    if (!layer || !parent) return;

    const active = document.activeElement;
    const priorFocus =
      active instanceof HTMLElement && active !== document.body ? active : null;
    const parentState = takeoverParents.get(parent);
    if (parentState) parentState.count += 1;
    else takeoverParents.set(parent, { count: 1, restoreFocus: priorFocus });

    // Move focus before hiding the prior pane so no focused descendant is ever
    // seated under aria-hidden/inert, even for the duration of one effect.
    layer.focus({ preventScroll: true });

    // The routed dock shell can mount after this host's first effect. A one-time
    // parent.children snapshot leaves that late sibling exposed beneath the
    // takeover, including every keyboard target it contains. Reconcile the
    // direct children for the whole layer lifetime; childList observation runs
    // before the browser's next paint, so a newly mounted pane never becomes an
    // assistive-technology or keyboard escape hatch.
    const acquiredSiblings = new Set<HTMLElement>();
    const reconcileSiblings = () => {
      if (layer.parentElement !== parent) return;
      const children = Array.from(parent.children);
      const layerIndex = children.indexOf(layer);
      const nextSiblings = new Set(
        children.filter(
          (node, index): node is HTMLElement =>
            node !== layer &&
            node instanceof HTMLElement &&
            // Equal-z takeover siblings later in DOM order paint above this
            // one. Leave those active; the later layer isolates this lower one.
            (!node.classList.contains("review-report-takeover") ||
              index < layerIndex),
        ),
      );

      for (const sibling of acquiredSiblings) {
        if (nextSiblings.has(sibling)) continue;
        releaseSibling(sibling);
        acquiredSiblings.delete(sibling);
      }
      for (const sibling of nextSiblings) {
        if (acquiredSiblings.has(sibling)) continue;
        isolateSibling(sibling);
        acquiredSiblings.add(sibling);
      }
    };

    reconcileSiblings();
    const siblingObserver = new MutationObserver(reconcileSiblings);
    siblingObserver.observe(parent, { childList: true });

    return () => {
      siblingObserver.disconnect();
      // React removes the focused subtree before passive-effect cleanup, so
      // browsers have already fallen back to <body> by the time this runs.
      // A real focus move to visible chrome remains a concrete non-body node
      // and must not be overwritten.
      const activeWasInside =
        layer.contains(document.activeElement) ||
        document.activeElement === document.body;
      for (const sibling of acquiredSiblings) releaseSibling(sibling);
      acquiredSiblings.clear();

      const current = takeoverParents.get(parent);
      if (!current) return;
      current.count -= 1;
      if (current.count === 0) {
        takeoverParents.delete(parent);
        if (activeWasInside) {
          const restoreTarget =
            current.restoreFocus?.isConnected &&
            !current.restoreFocus.closest("[inert]")
              ? current.restoreFocus
              : parent.matches(
                    '[data-route-transition-page="true"][tabindex]',
                  ) && !parent.closest("[inert]")
                ? parent
                : null;
          // Completing/dismissing a run can replace its strip or virtualized
          // row in the same commit that removes the takeover. The original
          // opener is then disconnected; return to the stable app-pane
          // landmark instead of leaving keyboard focus on <body>.
          restoreTarget?.focus({ preventScroll: true });
        }
        return;
      }

      if (activeWasInside) {
        const remainingLayer = Array.from(
          parent.querySelectorAll<HTMLElement>(".review-report-takeover"),
        )
          .filter((node) => node !== layer && !node.hasAttribute("inert"))
          .at(-1);
        remainingLayer?.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div
      ref={layerRef}
      className="review-report-takeover"
      data-testid={testId}
      role="region"
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}
