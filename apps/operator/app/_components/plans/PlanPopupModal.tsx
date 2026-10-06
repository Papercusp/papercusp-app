"use client";

/**
 * PlanPopupModal (owner-plans-single-pane-2026-07-17 P-003) — the plan opened
 * as a POPUP from the sidebar Plans face, instead of a navigation.
 *
 * READ-FIRST (D-001): the body is the SAME PlanDetail the Create tab renders
 * (4th mount context — /admin/plans, MainViewPanel, PlanEditorPanel, here),
 * which already defaults to its read/preview pane; editing stays one click
 * away inside the component. Tracking ≠ authoring — the Create dock keeps the
 * authoring posture.
 *
 * Known re-host traps, both handled (the dock's clipping lesson):
 *   - PlanDetail relies on a `.pc-plans__main` scroller for its overflow —
 *     provided here by `.plan-popup__body` (see plans-pane.css);
 *   - a dirty editor must not be silently discarded on close — PlanDetail's
 *     onDirtyChange feeds the useConfirmDialog guard (MainViewPanel pattern).
 *
 * Second tab (P-005): Sessions — every agent session that touched this plan,
 * with transcript search (PlanSessionsTab). Tab state is `?ppv` (nuqs, D-003)
 * so the popup is deep-linkable + agent-driveable.
 */
import { useMemo, useRef } from "react";
import { Maximize, Maximize2, Minimize, Minimize2 } from "lucide-react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { Modal } from "@/app/harness/Modal";
import { Tooltip } from "@/app/harness/Tooltip";
import PlanDetail from "@/app/admin/plans/PlanDetail";
import { usePlanList, type AuthorIdentity } from "@/app/admin/plans/plans-api";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";
import { usePopupMaximize } from "@/app/_components/chat/use-popup-maximize";
import PlanSessionsTab from "./PlanSessionsTab";
import PlanProvenanceBadge from "./PlanProvenanceBadge";
import { markInteractionPhase, PERF_INTERACTIONS } from "../perf/perf-marks";
// PlanDetail's chrome (pc-plans__*) is global CSS; importing it here makes the
// popup self-sufficient wherever the sidebar mounts (InboxPane precedent).
import "@/app/admin/plans/plans.css";
import "./plans-pane.css";

const POPUP_VIEWS = ["plan", "sessions"] as const;
export type PlanPopupView = (typeof POPUP_VIEWS)[number];

export default function PlanPopupModal({
  planSlug,
  harnessSlug,
  planTitle,
  origin,
  ownerIdentity,
  onClose,
}: {
  /** The open plan — null renders nothing (closed). */
  planSlug: string | null;
  /** The plan's OWN harness (from the loaded list row) — scoping plans:get to
   *  the wrong harness is the Create tab's old "Server: not_found" trap. */
  harnessSlug: string | null;
  planTitle?: string | null;
  /** Canonical plan-content provenance projected by plans:list. Callers that
   *  already hold the row pass it; global URL-driven callers omit it and this
   *  lazy boundary resolves the same canonical row itself. */
  origin?: "scout" | null;
  /** Resolved plan-owner identity from the same plans.list row. Omitted global
   * callers resolve it alongside origin inside this lazy boundary. */
  ownerIdentity?: AuthorIdentity | null;
  onClose: () => void;
}) {
  if (planSlug !== null) {
    markInteractionPhase(PERF_INTERACTIONS.planPopupOpen, "popup-render-started");
  }
  const [view, setView] = useQueryState(
    "ppv",
    parseAsStringEnum<PlanPopupView>([...POPUP_VIEWS]).withDefault("plan"),
  );
  const [, setPlanTarget] = useQueryState("jump", parseAsString);
  const dirtyRef = useRef(false);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // `wppop` carries only the stable scoped identity (`harness::slug`). The
  // router-root ChatRefPopupHost must stay tiny, so it cannot eagerly import
  // plans.list just to decorate this lazy popup. Resolve the missing fields
  // here, inside the chunk that already owns the heavy plan data stack. An
  // explicit null is authoritative User provenance / absent owner; only
  // undefined means the caller did not have that part of the row. Blender does
  // not need an owner lookup because its visible label is fixed.
  const needsProvenanceLookup =
    planSlug !== null &&
    (origin === undefined ||
      (origin !== "scout" && ownerIdentity === undefined));
  const planList = usePlanList({
    includeArchived: true,
    includeLegacy: true,
    harness_slugs: harnessSlug ? [harnessSlug] : undefined,
    enabled: needsProvenanceLookup,
  });
  const provenancePlan = useMemo(
    () =>
      needsProvenanceLookup
        ? ((planList.data?.plans ?? []).find(
            (plan) =>
              plan.slug === planSlug &&
              (!harnessSlug || plan.harness === harnessSlug),
          ) ?? null)
        : null,
    [harnessSlug, needsProvenanceLookup, planList.data, planSlug],
  );
  const provenanceResolved =
    origin === "scout" ||
    (origin !== undefined && ownerIdentity !== undefined) ||
    provenancePlan !== null;
  const resolvedOrigin = origin !== undefined ? origin : provenancePlan?.origin;
  const resolvedOwnerIdentity =
    ownerIdentity !== undefined
      ? ownerIdentity
      : (provenancePlan?.ownerIdentity ?? null);

  const open = planSlug !== null;
  const {
    mode: maximizeMode,
    maximized,
    screenActive,
    popupRef: popupSurfaceRef,
    toggleWindow,
    toggleScreen,
    reset: resetMaximize,
  } = usePopupMaximize({ param: "pmax", open });
  const windowActive = maximizeMode === "window";

  const reallyClose = () => {
    dirtyRef.current = false;
    resetMaximize();
    void setView(null); // drop ?ppv so the next open lands on the Plan tab
    void setPlanTarget(null); // a later open must not inherit a stale P/D jump
    onClose();
  };

  const guardedClose = () => {
    if (dirtyRef.current) {
      void askConfirm({
        title: "Discard unsaved edits?",
        body: "Your current plan edits will be discarded.",
        confirmLabel: "Discard",
        destructive: true,
      }).then((ok) => {
        if (ok) reallyClose();
      });
      return;
    }
    reallyClose();
  };

  return (
    <>
      {open ? (
        <Modal
          open
          onOpenChange={(o) => {
            if (!o) guardedClose();
          }}
          title={planTitle ?? planSlug ?? "Plan"}
          srOnlyTitle
          contentClassName="plan-popup"
          wrapStyle={maximized ? { padding: 0 } : undefined}
          closeOnEscape={!maximized}
          contentStyle={{
            width: maximized ? "100vw" : "94vw",
            maxWidth: maximized ? "100vw" : "1100px",
            height: maximized ? "100dvh" : "calc(100vh - 4rem)",
            maxHeight: maximized ? "100dvh" : "860px",
            borderRadius: maximized ? 0 : undefined,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            padding: 0,
          }}
        >
          <div
            ref={popupSurfaceRef}
            className="plan-popup__surface"
            data-testid="plan-popup-fullscreen-surface"
            onKeyDownCapture={(event) => {
              if (event.key === "Escape" && windowActive) {
                event.preventDefault();
                event.stopPropagation();
                toggleWindow();
              }
            }}
          >
            <div className="plan-popup__header">
              <div className="plan-popup__identity">
                <div
                  className="plan-popup__title"
                  title={planSlug ?? undefined}
                >
                  {planTitle ?? planSlug}
                </div>
                {provenanceResolved ? (
                  <PlanProvenanceBadge
                    origin={resolvedOrigin ?? null}
                    ownerIdentity={resolvedOwnerIdentity}
                    testId="plan-popup-provenance-badge"
                  />
                ) : null}
              </div>
              <div
                className="plan-popup__tabs"
                role="tablist"
                aria-label="Plan popup view"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "plan"}
                  className={`plan-popup__tab${view === "plan" ? " is-on" : ""}`}
                  onClick={() => void setView("plan")}
                  data-testid="plan-popup-tab-plan"
                >
                  Plan
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "sessions"}
                  className={`plan-popup__tab${view === "sessions" ? " is-on" : ""}`}
                  onClick={() => void setView("sessions")}
                  data-testid="plan-popup-tab-sessions"
                >
                  Sessions
                </button>
              </div>
              <Tooltip
                side="bottom"
                label={
                  windowActive
                    ? "Exit full window"
                    : "Fill the app window with this plan"
                }
              >
                <span
                  className="plan-popup__fullscreen-wrap"
                  data-testid="plan-popup-full-window-wrap"
                >
                  <button
                    type="button"
                    className="plan-popup__fullscreen"
                    onClick={toggleWindow}
                    aria-label={
                      windowActive ? "Exit full window" : "Full window"
                    }
                    aria-pressed={windowActive}
                    data-testid="plan-popup-full-window"
                  >
                    {windowActive ? (
                      <Minimize2 size={14} aria-hidden="true" />
                    ) : (
                      <Maximize2 size={14} aria-hidden="true" />
                    )}
                  </button>
                </span>
              </Tooltip>
              <Tooltip
                side="bottom"
                label={
                  screenActive
                    ? "Exit full screen"
                    : "Fill the whole screen with this plan"
                }
              >
                <span
                  className="plan-popup__fullscreen-wrap"
                  data-testid="plan-popup-full-screen-wrap"
                >
                  <button
                    type="button"
                    className="plan-popup__fullscreen"
                    onClick={toggleScreen}
                    aria-label={
                      screenActive ? "Exit full screen" : "Full screen"
                    }
                    aria-pressed={screenActive}
                    data-testid="plan-popup-full-screen"
                  >
                    {screenActive ? (
                      <Minimize size={14} aria-hidden="true" />
                    ) : (
                      <Maximize size={14} aria-hidden="true" />
                    )}
                  </button>
                </span>
              </Tooltip>
              <button
                type="button"
                className="plan-popup__close"
                onClick={guardedClose}
                aria-label="Close plan popup"
                data-testid="plan-popup-close"
              >
                ✕
              </button>
            </div>
            {view === "sessions" ? (
              <PlanSessionsTab planSlug={planSlug!} harnessSlug={harnessSlug} />
            ) : (
              <div
                className="pc-plans__main plan-popup__body"
                data-testid="plan-popup-body"
              >
                <PlanDetail
                  key={planSlug}
                  slug={planSlug!}
                  harnessSlug={harnessSlug}
                  showBack={false}
                  onClose={guardedClose}
                  onDirtyChange={(d: boolean) => {
                    dirtyRef.current = d;
                  }}
                  startStatus={null}
                  onStartStatusChange={() => {}}
                  onPlanStatusChange={() => {}}
                />
              </div>
            )}
          </div>
        </Modal>
      ) : null}
      {confirmEl}
    </>
  );
}
