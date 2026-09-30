'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from '@/lib/router-compat/navigation';
import { useEffectiveVisualEffects } from '@/lib/visual-effects';

/**
 * Route-transition "jump-gate" warp.
 *
 * History: this used to be driven by `next-transition-router`'s
 * `<TransitionRouter leave enter>` machine. That library serialises
 * navigation through a single in-flight transition and *swallows* any
 * click that arrives while a prior transition is still settling — which,
 * combined with variable route-render latency, made ordinary navigation
 * (e.g. clicking between settings tabs) intermittently do nothing or take
 * 0.2–0.9s. Since we are on TanStack Router now, that dependency was pure
 * overhead: it was only ever wired up to animate the two `data-route-
 * transition-intent="jump-gate"` links in ChromeShell (`/` and `/adv`).
 *
 * Now: ordinary navigation is plain TanStack `<Link>` (instant, no
 * machine). The warp is driven directly here — a capture-phase click
 * listener intercepts only jump-gate anchors, plays the "leave" overlay
 * via the Web Animations API (transform/opacity only — GPU-composited,
 * no gsap), navigates via the TSR-backed `next/navigation` shim, and
 * snaps the overlay away once the route changes (with a backstop timer).
 */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TRANSITION_LABEL_PLACEHOLDER = 'SYSTEM';

const JUMP_GATE_INTENT_ATTR = 'data-route-transition-intent';
const JUMP_GATE_INTENT_VALUE = 'jump-gate';
// Backstop: force the overlay away if the route never reports a change
// (e.g. the destination redirected so pathname never equals the click
// target). Keeps the warp from getting stuck "leaving".
const JUMP_GATE_ENTER_BACKSTOP_MS = 1200;

const LEAVE_BLADE_MS = 140;
const LEAVE_PAGE_DIM_MS = 120;
const EASE_OUT_CUBIC = 'cubic-bezier(0.215, 0.61, 0.355, 1)';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function normalizeRouteLabel(value?: string) {
  if (!value) return TRANSITION_LABEL_PLACEHOLDER;

  const [path = '/'] = value.split('?');
  return path === '/' ? '/harness' : path.toUpperCase();
}

// Warp-owned WAAPI animations. Tracked so reset/enter can cancel exactly
// these — `el.getAnimations()` would also return the decorative CSS
// keyframe loops, which must keep their play state.
const warpAnimations = new Set<Animation>();

function trackWarpAnimation(anim: Animation) {
  warpAnimations.add(anim);
  // Entries leave the set ONLY via cancelWarpAnimations(). Do NOT drop on
  // `finished`: a finished fill-forwards animation still applies its effect
  // (the page dim parked at 0.55), and clearInlineProps can't clear a WAAPI
  // effect — dropping it here made the dim permanent whenever the route
  // committed after the 120ms dim finished, i.e. on every warp navigation.
  // Swallow the rejection cancel() puts on `finished` so it never surfaces
  // as an unhandled-rejection.
  anim.finished.catch(() => {});
  return anim;
}

function cancelWarpAnimations() {
  for (const anim of warpAnimations) anim.cancel();
  warpAnimations.clear();
}

/** Test-only — the module-private warp-animation registry (see the
 * trackWarpAnimation comment: finished animations MUST stay cancellable). */
export const __warpAnimationsForTests = {
  track: trackWarpAnimation,
  cancelAll: cancelWarpAnimations,
  registry: warpAnimations,
};

function clearInlineProps(el: HTMLElement | null, props: string[]) {
  if (!el) return;
  for (const p of props) el.style.removeProperty(p);
}

function resetRouteTransitionVisualState() {
  if (typeof document === 'undefined') return;
  const overlay = document.querySelector<HTMLElement>('.pc-route-transition');
  const page = document.querySelector<HTMLElement>('[data-route-transition-page="true"]');

  cancelWarpAnimations();

  if (overlay) {
    overlay.style.opacity = '0';
    overlay.style.visibility = 'hidden';
    overlay.style.pointerEvents = 'none';
  }
  clearInlineProps(page, ['opacity', 'visibility', 'scale', 'filter', 'transform']);
}

function updateRouteLabels(from?: string, to?: string) {
  const fromNode = document.querySelector<HTMLElement>('[data-route-transition-from]');
  const toNode = document.querySelector<HTMLElement>('[data-route-transition-to]');

  if (fromNode) fromNode.textContent = normalizeRouteLabel(from);
  if (toNode) toNode.textContent = normalizeRouteLabel(to);
}

function setWarpStatus(text: string) {
  const statusNode = document.querySelector<HTMLElement>('[data-route-transition-status]');
  if (statusNode) statusNode.textContent = text;
}

function RouteTransitionChrome({ stage }: { stage: 'idle' | 'leaving' | 'entering' }) {
  return (
    <div className="pc-route-transition" data-route-transition-stage={stage} aria-hidden="true">
      <div className="pc-route-transition__backdrop" />
      <div className="pc-route-transition__grid" />
      <div className="pc-route-transition__starfield" />
      <div className="pc-route-transition__blade pc-route-transition__blade--top" />
      <div className="pc-route-transition__blade pc-route-transition__blade--bottom" />
      <div className="pc-route-transition__sweep pc-route-transition__sweep--a" />
      <div className="pc-route-transition__sweep pc-route-transition__sweep--b" />
      <div className="pc-route-transition__scan pc-route-transition__scan--vertical" />
      <div className="pc-route-transition__scan pc-route-transition__scan--horizontal" />
      <div className="pc-route-transition__core">
        <div className="pc-route-transition__ring pc-route-transition__ring--outer" />
        <div className="pc-route-transition__ring pc-route-transition__ring--middle" />
        <div className="pc-route-transition__ring pc-route-transition__ring--inner" />
        <div className="pc-route-transition__reticle" />
        <div className="pc-route-transition__title">JUMP GATE</div>
        <div className="pc-route-transition__subtitle">SYNCHRONIZING ORACLE MEMORY</div>
      </div>
      <div className="pc-route-transition__telemetry pc-route-transition__telemetry--left">
        <span>FROM</span>
        <strong data-route-transition-from>{TRANSITION_LABEL_PLACEHOLDER}</strong>
      </div>
      <div className="pc-route-transition__telemetry pc-route-transition__telemetry--right">
        <span>TO</span>
        <strong data-route-transition-to>{TRANSITION_LABEL_PLACEHOLDER}</strong>
      </div>
      <div className="pc-route-transition__status">
        <span>WARP STATUS</span>
        <strong data-route-transition-status>STANDING BY</strong>
      </div>
      <div className="pc-route-transition__ticks">
        {Array.from({ length: 18 }, (_, index) => (
          <i key={index} />
        ))}
      </div>
      <div className="pc-route-transition__checksum">
        <span>ORACLE // VECTOR LOCK // SIGNAL CLEAN</span>
      </div>
    </div>
  );
}

export default function RouteTransitionProvider({ children }: { children: ReactNode }) {
  const visualEffects = useEffectiveVisualEffects();
  const minimalVisualEffects = visualEffects === 'minimal';
  const router = useRouter();
  const pathname = usePathname();
  const [stage, setStage] = useState<'idle' | 'leaving' | 'entering'>('idle');

  // Set while a jump-gate navigation is in flight; holds the origin path so
  // we can detect "the route changed" robustly (even through redirects).
  const pendingRef = useRef<{ fromPath: string } | null>(null);
  const backstopRef = useRef<number | null>(null);

  const playEnter = useCallback(() => {
    if (backstopRef.current !== null) {
      window.clearTimeout(backstopRef.current);
      backstopRef.current = null;
    }
    pendingRef.current = null;

    // Snap enter: no animation. The leave overlay was visible while the new
    // route mounted; the moment the route commits, snap everything back to
    // base state instantly. Animating the reveal here queues tweens behind
    // the main-thread render work and stretches into a multi-second laggy
    // fade — the leave overlay already did the "something is happening"
    // job, so revealing the page should be instant.
    resetRouteTransitionVisualState();
    setWarpStatus('STANDING BY');
    setStage('idle');
  }, []);

  // When the pending jump-gate navigation actually changes the route, snap
  // the overlay away on the next frame.
  useEffect(() => {
    if (pendingRef.current && pathname !== pendingRef.current.fromPath) {
      requestAnimationFrame(() => playEnter());
    }
  }, [pathname, playEnter]);

  const runJumpGate = useCallback(
    (to: string, fromPath: string, toPath: string) => {
      const go = () => {
        router.push(to);
      };

      if (minimalVisualEffects || prefersReducedMotion()) {
        resetRouteTransitionVisualState();
        go();
        return;
      }

      const overlay = document.querySelector<HTMLElement>('.pc-route-transition');
      const page = document.querySelector<HTMLElement>('[data-route-transition-page="true"]');
      if (!overlay) {
        resetRouteTransitionVisualState();
        go();
        return;
      }

      updateRouteLabels(fromPath, toPath);
      setStage('leaving');
      cancelWarpAnimations();
      clearInlineProps(page, ['opacity', 'visibility', 'scale', 'filter', 'transform']);

      // Idempotent commit: navigation fires exactly once, from whichever
      // comes first — the blade animation's finished promise (~140ms) or the
      // 240ms rAF-starvation fallback. The overlay is fully up before the
      // route swaps; the snap-enter (above) reveals the new page instantly.
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        pendingRef.current = { fromPath };
        go();
        backstopRef.current = window.setTimeout(playEnter, JUMP_GATE_ENTER_BACKSTOP_MS);
      };

      overlay.style.opacity = '1';
      overlay.style.visibility = 'visible';
      overlay.style.pointerEvents = 'auto';
      setWarpStatus('VECTOR LOCKED');

      const bladeTop = overlay.querySelector<HTMLElement>('.pc-route-transition__blade--top');
      const bladeBottom = overlay.querySelector<HTMLElement>('.pc-route-transition__blade--bottom');

      if (bladeTop) {
        const anim = trackWarpAnimation(
          bladeTop.animate(
            [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0%)' }],
            { duration: LEAVE_BLADE_MS, easing: EASE_OUT_CUBIC, fill: 'forwards' },
          ),
        );
        anim.finished.then(commit, () => {});
      }
      if (bladeBottom) {
        trackWarpAnimation(
          bladeBottom.animate(
            [{ transform: 'translateY(100%)' }, { transform: 'translateY(0%)' }],
            { duration: LEAVE_BLADE_MS, easing: EASE_OUT_CUBIC, fill: 'forwards' },
          ),
        );
      }
      if (page) {
        trackWarpAnimation(
          page.animate([{ opacity: 1 }, { opacity: 0.55 }], {
            duration: LEAVE_PAGE_DIM_MS,
            easing: EASE_OUT_CUBIC,
            fill: 'forwards',
          }),
        );
      }

      // Backstop in case rAF is starved and the finished promise never
      // resolves; `commit` is idempotent so this never double-navigates.
      window.setTimeout(commit, 240);
    },
    [minimalVisualEffects, router, playEnter],
  );

  useEffect(() => {
    function handleClickCapture(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>(
        `a[${JUMP_GATE_INTENT_ATTR}="${JUMP_GATE_INTENT_VALUE}"]`,
      );
      if (!anchor) return;
      if (anchor.hasAttribute('download') || anchor.target === '_blank') return;

      const targetUrl = new URL(anchor.href);
      const currentUrl = new URL(window.location.href);
      if (targetUrl.origin !== currentUrl.origin) return;
      if (targetUrl.href === currentUrl.href) return;

      // Take over navigation so the warp plays; TanStack's <Link> sees
      // defaultPrevented and skips its own navigation.
      event.preventDefault();
      const to = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
      runJumpGate(to, currentUrl.pathname, targetUrl.pathname);
    }

    document.addEventListener('click', handleClickCapture, { capture: true });
    return () => document.removeEventListener('click', handleClickCapture, { capture: true });
  }, [runJumpGate]);

  useEffect(
    () => () => {
      if (backstopRef.current !== null) window.clearTimeout(backstopRef.current);
    },
    [],
  );

  return (
    <>
      <RouteTransitionChrome stage={stage} />
      {children}
    </>
  );
}
