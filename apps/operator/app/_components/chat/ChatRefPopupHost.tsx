'use client';

/**
 * ChatRefPopupHost (WI-6601) — the ONE mount of the chat ref-pill popups.
 *
 * THE BUG THIS FIXES. `wpop`/`wppop` are global nuqs state, but the popups that
 * render them used to be mounted INSIDE `OperatorChat`, gated on that
 * instance's own `harnessSlug` prop:
 *
 *     {harnessSlug ? (<WorkItemPopupModal … /><PlanPopupModal … />) : null}
 *
 * The gate existed for a real reason — the persistent sidebar instance and a
 * harness-scoped instance (SessionChatModal via HudView) can be mounted at the
 * same time, and two mounts of one param is a duplicate stacked popup. But the
 * sidebar is a CROSS-HARNESS surface and never receives a `harnessSlug`, so on
 * any mount without a resolvable `?slug` the gate closed on the only instance
 * present: the drill-in wrote a perfectly correct `wpop=papercusp::WI-6594`
 * and NOTHING rendered it (measured live 2026-07-28, `nModals: 0`). A dead
 * click whose URL looks right.
 *
 * WHY A SINGLETON AND NOT A WIDER GATE. Widening the per-instance gate
 * re-introduces the duplicate-render it was added to prevent — the two failures
 * are opposite ends of the same missing invariant ("exactly one renderer"). So
 * own the popups in one place, driven purely by the param, and let every chat
 * surface keep WRITING the param without any of them rendering it. The popups
 * were already pure functions of props, so nothing about them had to change.
 *
 * WHERE IT MOUNTS: the router root (`apps/operator-vite/src/routes/__root.tsx`),
 * INSIDE `NuqsAdapter` (it reads query state) but OUTSIDE the `!chromeless`
 * gate. That last part is load-bearing: `/quick-panel` is chromeless, so
 * `ChromeShell` never renders there — mounting this in the chrome would have
 * left the exact surface WI-6601 names still broken.
 *
 * BUNDLE: both popups are lazy — `PlanPopupModal` pulls `PlanDetail`, which
 * pulls the Vditor editor. A static import here would drag that onto every
 * route including `/login`. Loading them only once a param is actually set
 * makes this strictly lighter than the per-instance mount it replaces.
 * `lazyWithRetry`, not bare `React.lazy`: on the packaged WebKitGTK desktop a
 * transient chunk-load failure must not escalate to the fatal route boundary
 * (WI-2902).
 */
import { Suspense, useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  decodeScopedRef,
  encodeScopedRef,
} from './chat-ref-popup-params';

const WorkItemPopupModal = lazy(() => import('../work-items/WorkItemPopupModal'));
const PlanPopupModal = lazy(() => import('../plans/PlanPopupModal'));

/**
 * What the click paints WHILE the lazy chunk resolves (WI-7088).
 *
 * The Suspense fallback here used to be `null`, which meant a click on a ref
 * pill produced NOTHING on screen until the chunk (and, for a plan, the whole
 * Vditor stack behind it) had loaded — indistinguishable from a dead click, and
 * the reason the delay read as "several seconds" rather than "a moment". The
 * dominant cost was Vditor fetching ~4.9MB from unpkg.com, fixed separately by
 * pointing `cdn` at a local mirror; this is the perceived-latency half — the
 * frame appears on the same frame as the click, so the wait is legible.
 *
 * Deliberately dependency-free inline styles: this component mounts at the
 * ROUTER ROOT, so anything it imports statically lands in the eager bundle for
 * every route including /login. Using the real <Modal> would drag Radix Dialog
 * in and undo the very code-splitting this file's header documents. The
 * dimensions mirror each popup's own `contentStyle` so the skeleton does not
 * visibly resize when the real content swaps in.
 */
function PopupSkeleton({ width, height }: { width: string; height: string }) {
  return (
    <div
      // aria-hidden: it is a purely visual placeholder, and the real dialog
      // announces itself when it mounts a moment later. Announcing a nameless
      // dialog first would make screen readers narrate the load, not the plan.
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(3, 10, 18, 0.62)',
      }}
    >
      <div
        style={{
          width,
          height,
          borderRadius: 14,
          border: '1px solid var(--border, rgba(125,211,252,0.18))',
          background: 'var(--bg-popover, #0d1829)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
          overflow: 'hidden',
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {[38, 0, 92, 78, 85, 60].map((w, i) => (
          <div
            key={i}
            style={{
              height: i === 0 ? 22 : 12,
              width: w === 0 ? '100%' : `${w}%`,
              marginTop: w === 0 ? 6 : 0,
              borderRadius: 6,
              background: 'var(--border, rgba(125,211,252,0.14))',
              animation: 'pc-ref-popup-pulse 1.15s ease-in-out infinite',
              animationDelay: `${i * 90}ms`,
            }}
          />
        ))}
      </div>
      <style>{`@keyframes pc-ref-popup-pulse { 0%,100% { opacity: .38 } 50% { opacity: .85 } }`}</style>
    </div>
  );
}

export default function ChatRefPopupHost({
  fallbackHarnessSlug,
}: {
  /**
   * The MOUNTING HOST's own harness, for a host that knows it out of band
   * (WI-10001509 — the portal is served one harness by its server and has no
   * `?slug` to resolve). Used only when a ref did not carry a harness of its
   * own; see the precedence note below.
   */
  fallbackHarnessSlug?: string | null;
} = {}) {
  const [openWorkItem, setOpenWorkItem] = useQueryState(
    CHAT_WORK_ITEM_POPUP_PARAM,
    parseAsString,
  );
  const [openPlan, setOpenPlan] = useQueryState(CHAT_PLAN_POPUP_PARAM, parseAsString);

  // The surrounding surface's harness is the FALLBACK only. A ref that named
  // its own harness is the stricter source and wins — it is right even on a
  // cross-harness mount, where `?slug` is absent entirely. Same precedence
  // HudView applies to its own `hudwi`/`hudplanpop`.
  //
  // UNCONDITIONAL on purpose even when the host passed `fallbackHarnessSlug`:
  // it is a hook, so gating the call on a prop would break the rules of hooks.
  // It reads nuqs + localStorage only, which is why it is safe on a non-operator
  // host (the portal already runs it today through the /plans surface).
  const resolvedHarness = useResolvedHarnessSlug();
  // Precedence: the ref's own harness ?? the mounting host's ?? whatever this
  // surface resolves. The host's value outranks the resolved one because a host
  // that was TOLD its harness knows better than a URL/storage guess; the ref
  // still outranks both.
  const hostHarness = fallbackHarnessSlug ?? resolvedHarness;

  const workItem = useMemo(() => decodeScopedRef(openWorkItem), [openWorkItem]);
  const plan = useMemo(() => decodeScopedRef(openPlan), [openPlan]);

  const workItemHarness = workItem.harness ?? hostHarness;
  const planHarness = plan.harness ?? hostHarness;

  return (
    <>
      {workItem.id ? (
        <Suspense fallback={<PopupSkeleton width="min(760px, 94vw)" height="min(720px, calc(100vh - 4rem))" />}>
          <WorkItemPopupModal
            id={workItem.id}
            harnessSlug={workItemHarness}
            // A related-item ref inside the open detail RE-TARGETS this same
            // popup (the component's own documented contract). Re-encode with
            // the harness we resolved, so the follow-on item stays scoped.
            onSelect={(id) => void setOpenWorkItem(encodeScopedRef(workItemHarness, id))}
            onClose={() => void setOpenWorkItem(null)}
          />
        </Suspense>
      ) : null}
      {plan.id ? (
        <Suspense fallback={<PopupSkeleton width="min(1100px, 94vw)" height="min(860px, calc(100vh - 4rem))" />}>
          <PlanPopupModal
            planSlug={plan.id}
            harnessSlug={planHarness}
            onClose={() => void setOpenPlan(null)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
