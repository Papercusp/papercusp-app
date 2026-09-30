'use client';

/**
 * RecorderHost — mounted in the root layout when ?perf-recorder=1 is set.
 *
 * Listens on the BroadcastChannel for a `start` message from the
 * controller window, then dynamically loads Gremlins.js and runs it in
 * the recorder window. Posts back per-click events + a final summary
 * over the same channel.
 *
 * Why a separate window instead of an iframe: keeps the controller UI
 * alive while the app navigates underneath, but avoids the same-origin
 * gymnastics + double-React-tree memory cost of iframing the app.
 */

import { useEffect } from 'react';
import { CHANNEL_NAME, type ControllerMsg, type RecorderMsg, type RecorderEvent, type RunSummary, rollupRoutes, saveRun } from './recorder-channel';
import { readRecorderStartParams } from './recorder-start-params';

declare global {
  interface Window { __papercuspRecorderActive?: boolean }
}

interface Gremlins {
  createHorde(opts: { strategies?: unknown[]; mogwais?: unknown[]; before?: () => Promise<void> }): {
    gremlin(g: unknown): unknown;
    mogwai(m: unknown): unknown;
    strategy(s: unknown): unknown;
    seed(s: number): unknown;
    unleash(opts?: { nb: number }): Promise<void>;
    stop(): void;
  };
  strategies: { distribution(opts: { delay?: number; nb?: number }): unknown };
  mogwais: {
    alert(): unknown;
    fps(): unknown;
    gizmo(opts: { maxErrors?: number }): unknown;
  };
}

const BLOCKABLE_SELECTOR = 'button, [role="button"], a, [role="tab"], [role="menuitem"], [role="switch"]';

function isBlocked(node: Element, blocklist: string[]): boolean {
  const text = `${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`.toLowerCase();
  return blocklist.some((b) => b && text.includes(b.toLowerCase()));
}

/**
 * Tag blocklisted controls within ONE changed subtree.
 *
 * The initial call uses `document`; MutationObserver calls use only each added
 * node (or its parent for an added text node). This distinction is the WI-39527
 * fix: the old observer re-ran document.querySelectorAll + textContent over the
 * whole app after every chaos-triggered child mutation — a confirmed
 * synchronous O(N) common path across all four surfaces and therefore the
 * first mechanism to remove before attributing their shared long frame.
 */
export function tagBlockedElements(
  root: ParentNode,
  blocklist: string[],
  blocked: Set<Element>,
  force = false,
): void {
  const visit = (el: Element) => {
    if (blocked.has(el) || (!force && !isBlocked(el, blocklist))) return;
    blocked.add(el);
    (el as HTMLElement).dataset.perfBlocked = '1';
  };
  if (root instanceof Element && root.matches(BLOCKABLE_SELECTOR)) visit(root);
  root.querySelectorAll(BLOCKABLE_SELECTOR).forEach(visit);
}

export default function RecorderHost() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('perf-recorder') !== '1') return;
    // Note: previously bailed on window.__papercuspRecorderActive to
    // prevent double-mount duplication. That broke under React strict
    // mode in dev: mount → cleanup → mount; the second mount bailed,
    // and the first effect's listener was torn down before the async
    // listen() ever resolved. Allow re-registration on every mount;
    // the return cleanup will properly tear down any prior listener.
    window.__papercuspRecorderActive = true;
    let cancelled = false;
    const suiteRunKey = params.get('__suiteRun');
    const expectedRunId = params.get('perf-run-id');
    const fallbackStart = readRecorderStartParams(params);
    const reloadStorageKey = suiteRunKey ? `papercusp.testing.chaos-reloads.${suiteRunKey}` : null;
    const activeRunStorageKey = expectedRunId ? `papercusp.testing.chaos-active.${expectedRunId}` : null;
    if (reloadStorageKey && activeRunStorageKey && sessionStorage.getItem(activeRunStorageKey) === '1') {
      const prev = Number(sessionStorage.getItem(reloadStorageKey) || '0');
      sessionStorage.setItem(reloadStorageKey, String(prev + 1));
    }

    const inTauri = Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    const channel = inTauri ? null : new BroadcastChannel(CHANNEL_NAME);
    const tauriEvent = (window as unknown as {
      __TAURI__?: { event?: { emit?: (name: string, payload: unknown) => Promise<void>; listen?: (name: string, cb: (event: { payload: unknown }) => void) => Promise<() => void> } };
    }).__TAURI__?.event;
    let offTauri: (() => void) | null = null;
    let currentRunId: string | null = null;
    let runEvents: RecorderEvent[] = [];
    let clickCount = 0;
    let startedAt = 0;
    let stopRun: (() => void) | null = null;
    let finishCurrent: (() => void) | null = null;

    function send(msg: RecorderMsg) {
      try { channel?.postMessage(msg); } catch { /* noop on desktop path */ }
      void tauriEvent?.emit?.(CHANNEL_NAME, msg);
    }

    function describe(node: EventTarget | null): string {
      if (!(node instanceof Element)) return '(unknown)';
      const role = node.getAttribute('role');
      const aria = node.getAttribute('aria-label');
      const text = (node.textContent ?? '').trim().slice(0, 40);
      const tag = node.tagName.toLowerCase();
      if (aria) return `${tag}[aria-label="${aria}"]`;
      if (text) return `${tag} "${text}"`;
      if (role) return `${tag}[role=${role}]`;
      return tag;
    }

    function recordEvent(e: RecorderEvent) {
      runEvents.push(e);
      send({ type: 'event', runId: currentRunId!, event: e });
    }


    const ignoredInteractionEvents = new Set([
      'mouseover',
      'mouseout',
      'pointerover',
      'pointerout',
      'mouseenter',
      'mouseleave',
      'pointerenter',
      'pointerleave',
    ]);

    function setupObservers(): () => void {
      const obs: PerformanceObserver[] = [];
      try {
        const intObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const ev = entry as PerformanceEventTiming;
            if (ignoredInteractionEvents.has(ev.name)) continue;
            if (ev.duration < 16) continue;
            recordEvent({
              ts: Date.now(),
              route: window.location.pathname,
              kind: 'click',
              target: describe(ev.target ?? null),
              inp: Math.round(ev.duration),
            });
            send({ type: 'progress', runId: currentRunId!, clicks: clickCount, elapsedMs: Date.now() - startedAt });
          }
        });
        intObs.observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
        obs.push(intObs);
      } catch { /* not supported */ }

      try {
        const ltObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            recordEvent({
              ts: Date.now(),
              route: window.location.pathname,
              kind: 'long-task',
              target: 'main-thread',
              duration: Math.round(entry.duration),
            });
          }
        });
        ltObs.observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
        obs.push(ltObs);
      } catch { /* not supported */ }

      try {
        const lsObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const ls = entry as PerformanceEntry & { value: number; hadRecentInput?: boolean };
            if (ls.hadRecentInput || ls.value < 0.01) continue;
            recordEvent({
              ts: Date.now(),
              route: window.location.pathname,
              kind: 'layout-shift',
              target: 'viewport',
              duration: Math.round(ls.value * 1000),
            });
          }
        });
        lsObs.observe({ type: 'layout-shift', buffered: false } as PerformanceObserverInit);
        obs.push(lsObs);
      } catch { /* not supported */ }

      const origErr = console.error;
      console.error = (...args: unknown[]) => {
        origErr(...args);
        recordEvent({
          ts: Date.now(),
          route: window.location.pathname,
          kind: 'console-error',
          target: 'console',
          detail: args.map((a) => (typeof a === 'string' ? a : (a as Error)?.message ?? String(a))).join(' ').slice(0, 200),
        });
      };
      const onClick = (event: MouseEvent) => {
        clickCount += 1;
        // Synthetic Gremlins clicks are intentionally absent from Event Timing
        // in this WebKit build, so record the dispatch target/time ourselves.
        // This is attribution only (no invented INP duration): the controller
        // correlates the last dispatch before maxFrameAtMs.
        recordEvent({
          ts: Date.now(),
          route: window.location.pathname,
          kind: 'click-dispatch',
          target: describe(event.target),
        });
        send({ type: 'progress', runId: currentRunId!, clicks: clickCount, elapsedMs: Date.now() - startedAt });
      };
      const onErr = (e: ErrorEvent) => {
        recordEvent({ ts: Date.now(), route: window.location.pathname, kind: 'unhandled-error', target: e.filename ?? 'window', detail: (e.message ?? '').slice(0, 200) });
      };
      const onRej = (e: PromiseRejectionEvent) => {
        recordEvent({ ts: Date.now(), route: window.location.pathname, kind: 'unhandled-error', target: 'promise', detail: String(e.reason).slice(0, 200) });
      };
      window.addEventListener('click', onClick, true);
      window.addEventListener('error', onErr);
      window.addEventListener('unhandledrejection', onRej);

      return () => {
        obs.forEach((o) => o.disconnect());
        console.error = origErr;
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('error', onErr);
        window.removeEventListener('unhandledrejection', onRej);
      };
    }

    async function startRun(msg: Extract<ControllerMsg, { type: 'start' }>) {
      currentRunId = msg.runId;
      runEvents = [];
      clickCount = 0;
      if (activeRunStorageKey) sessionStorage.setItem(activeRunStorageKey, '1');
      try {
        const currentWindow = (window as unknown as {
          __TAURI__?: { window?: { getCurrentWindow?: () => { setFocus?: () => Promise<void> } } };
        }).__TAURI__?.window?.getCurrentWindow?.();
        await currentWindow?.setFocus?.();
      } catch {
        // noop
      }
      const focusDeadline = Date.now() + 3_000;
      while (Date.now() < focusDeadline) {
        if (document.visibilityState === 'visible' && document.hasFocus()) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      try {
        const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
        if (fonts?.ready) await fonts.ready;
      } catch {
        // noop
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      startedAt = Date.now();
      send({ type: 'started', runId: currentRunId });
      // Count only severe frame gaps here; maxFrameMs still captures smaller
      // 50–100ms hitches without making the chaos suite fail on benign jitter.
      //
      // ARMING IS NOT FREE, AND IT USED TO BE CHARGED TO THE APP. The frame loop
      // starts here, but the recorder is not armed yet: below, it dynamically
      // imports the ~226KB `gremlins-runtime` chunk and then walks the entire
      // document to tag blocked elements. Evaluating that chunk blocks the main
      // thread, so the gap landed in `maxFrameMs` and the chaos suite failed a
      // 200ms app budget on the INSTRUMENT's own startup.
      //
      // Setup frames are therefore measured into a SEPARATE bucket and reported
      // alongside the graded ones — never silently dropped. A discarded
      // measurement nobody can see is exactly how a real regression hides, so
      // the discard is made visible instead of invisible.
      const frameDropThresholdMs = 100;
      let frameDrops = 0;
      let maxFrameMs = 0;
      /** Worst frame gap observed while ARMING (before the measured window). */
      let setupMaxFrameMs = 0;
      let setupFrameDrops = 0;
      /** Offset of the worst graded frame within the measured window. */
      let maxFrameAtMs = 0;
      let maxFrameTimerTicks = 0;
      let maxFrameTimerGapMs = 0;
      /** False until arming completes; see the window-open below. */
      let measuring = false;
      let windowStart = 0;
      let windowStartedAt = 0;
      let rafStop = false;
      let lastFrame = performance.now();
      let lastSetupSevereAt = lastFrame;
      // WebKit can throttle rAF while ordinary JS timers keep running. A tiny
      // heartbeat lets the worst-frame verdict distinguish that compositor /
      // scheduling shape from a genuinely blocked main thread.
      const timerTicks: number[] = [];
      let timerStop = false;
      let timerId = 0;
      const timerHeartbeat = () => {
        if (timerStop) return;
        const now = performance.now();
        timerTicks.push(now);
        while (timerTicks.length && timerTicks[0] < now - 3_000) timerTicks.shift();
        timerId = window.setTimeout(timerHeartbeat, 16);
      };
      timerId = window.setTimeout(timerHeartbeat, 16);
      // A Tauri runner may briefly focus the controller webview between two
      // recorder rAF callbacks. If focus returns before the next callback, a
      // callback-time hasFocus() check alone cannot see the interruption and
      // incorrectly charges the background-throttled gap to the app. Reset at
      // the transition itself so only continuously foregrounded time is graded.
      const resetFrameClock = () => {
        lastFrame = performance.now();
      };
      window.addEventListener('blur', resetFrameClock);
      window.addEventListener('focus', resetFrameClock);
      document.addEventListener('visibilitychange', resetFrameClock);
      const raf = () => {
        if (rafStop) return;
        const now = performance.now();
        if (document.visibilityState !== 'visible' || !document.hasFocus()) {
          lastFrame = now;
          requestAnimationFrame(raf);
          return;
        }
        const delta = now - lastFrame;
        if (measuring) {
          if (delta > frameDropThresholdMs) frameDrops += 1;
          if (delta > maxFrameMs) {
            maxFrameMs = delta;
            maxFrameAtMs = now - windowStart;
            const inside = timerTicks.filter((tick) => tick > lastFrame && tick <= now);
            const points = [lastFrame, ...inside, now];
            maxFrameTimerTicks = inside.length;
            maxFrameTimerGapMs = points.slice(1).reduce(
              (max, point, i) => Math.max(max, point - points[i]),
              0,
            );
          }
        } else {
          if (delta > frameDropThresholdMs) setupFrameDrops += 1;
          if (delta > frameDropThresholdMs) lastSetupSevereAt = now;
          if (delta > setupMaxFrameMs) setupMaxFrameMs = delta;
        }
        lastFrame = now;
        requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
      const teardownObservers = setupObservers();
      const teardown = () => {
        teardownObservers();
        window.removeEventListener('blur', resetFrameClock);
        window.removeEventListener('focus', resetFrameClock);
        document.removeEventListener('visibilitychange', resetFrameClock);
      };

      // Dynamic import gremlins.js — keeps it out of the main app bundle.
      let gremlins: Gremlins | null = null;
      try {
        const mod = await import('./gremlins-runtime');
        gremlins = (mod as unknown as { default: Gremlins }).default ?? (mod as unknown as Gremlins);
      } catch (err) {
        recordEvent({ ts: Date.now(), route: window.location.pathname, kind: 'unhandled-error', target: 'gremlins-import', detail: String(err).slice(0, 200) });
      }

      let horde: ReturnType<Gremlins['createHorde']> | null = null;
      if (gremlins && !msg.dryRun) {
        // Filter out elements matching the blocklist before each gremlin tick.
        // Gremlins doesn't expose pre-click hooks, so we tag blocked elements
        // with pointer-events:none for the duration of the run.
        const blocked = new Set<Element>();
        const contentRoot = document.querySelector('main');
        const effectiveBlocklist = [...msg.blocklist];
        // Controls outside the app content are always blocked. Tag them once;
        // later mutations are scoped to their added subtree just like content.
        document.querySelectorAll(BLOCKABLE_SELECTOR).forEach((el) => {
          if (contentRoot instanceof Element && !contentRoot.contains(el) && !blocked.has(el)) {
            blocked.add(el);
            (el as HTMLElement).dataset.perfBlocked = '1';
          }
        });
        tagBlockedElements(document, effectiveBlocklist, blocked);
        const mutObs = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              const root = node instanceof Element ? node : node.parentElement;
              if (!root) continue;
              if (contentRoot instanceof Element && !contentRoot.contains(root)) {
                tagBlockedElements(root, effectiveBlocklist, blocked, true);
              } else {
                tagBlockedElements(root, effectiveBlocklist, blocked);
              }
            }
          }
        });
        mutObs.observe(document.body, { childList: true, subtree: true });

        // Inject CSS to neuter blocked elements.
        const style = document.createElement('style');
        style.textContent = '[data-perf-blocked="1"] { pointer-events: none !important; }';
        document.head.appendChild(style);

        horde = gremlins.createHorde({
          strategies: [gremlins.strategies.distribution({ delay: 50 })],
          // fps() mogwai omitted: it fires console.error when FPS drops, which is
          // expected during chaos testing and pollutes the error count.
          mogwais: [gremlins.mogwais.alert(), gremlins.mogwais.gizmo({ maxErrors: 50 })],
        });

        stopRun = () => {
          horde?.stop();
          mutObs.disconnect();
          style.remove();
          blocked.forEach((el) => delete (el as HTMLElement).dataset.perfBlocked);
        };

      }

      // The recorder window navigates to a real route before arming. A fixed
      // 750ms delay was insufficient: async route data/hydration produced a
      // 673ms frame at +815ms even with dryRun=true and zero clicks (WI-39527).
      // Wait until the setup bucket has seen 500ms without a severe frame,
      // bounded to 3s so persistent background jank remains visible rather than
      // waiting forever. Gremlins starts only AFTER this gate, so setup cannot
      // consume or hide any chaos interaction.
      const settleDeadline = performance.now() + 3_000;
      while (performance.now() < settleDeadline && performance.now() - lastSetupSevereAt < 500) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }

      // ARMING COMPLETE — open the measured window. Deliberately placed OUTSIDE
      // the horde branch: a dry run, or a gremlins import that failed, must still
      // produce a measured window. Inside the branch, those paths would leave
      // `measuring` false forever and report maxFrameMs=0 — an unmeasured budget
      // rendered as a perfect score, which is the failure mode this whole suite
      // keeps rediscovering.
      // Resetting `lastFrame` is what charges the arming gap to setup rather than
      // to the first chaos frame.
      lastFrame = performance.now();
      windowStart = lastFrame;
      windowStartedAt = Date.now();
      measuring = true;
      horde?.unleash({ nb: Math.floor(msg.durationMs / 50) }).catch(() => { /* horde aborted */ });

      // Stop after durationMs even if horde is still running or in dry-run.
      const timer = setTimeout(() => finishRun(), msg.durationMs);
      finishCurrent = finishRun;

      function finishRun() {
        clearTimeout(timer);
        rafStop = true;
        timerStop = true;
        clearTimeout(timerId);
        stopRun?.();
        stopRun = null;
        teardown();
        const reloads = reloadStorageKey ? Number(sessionStorage.getItem(reloadStorageKey) || '0') : 0;
        if (reloadStorageKey) sessionStorage.removeItem(reloadStorageKey);
        if (activeRunStorageKey) sessionStorage.removeItem(activeRunStorageKey);
        const summary: RunSummary = {
          runId: currentRunId!,
          startedAt,
          windowStartedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          clicks: clickCount,
          events: runEvents,
          routes: rollupRoutes(runEvents),
          reloads,
          frameDrops,
          maxFrameMs: Math.round(maxFrameMs),
          maxFrameAtMs: Math.round(maxFrameAtMs),
          maxFrameTimerTicks,
          maxFrameTimerGapMs: Math.round(maxFrameTimerGapMs),
          setupMaxFrameMs: Math.round(setupMaxFrameMs),
          setupFrameDrops,
        };
        saveRun(summary);
        send({ type: 'done', runId: currentRunId!, summary: { ...summary, events: [] } });
        window.setTimeout(() => {
          const currentWindow = (window as unknown as {
            __TAURI__?: { webviewWindow?: { getCurrentWebviewWindow?: () => { close?: () => Promise<void> } } };
          }).__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
          void currentWindow?.close?.().catch(() => undefined);
        }, 250);
        currentRunId = null;
        finishCurrent = null;
      }

      // Allow controller to stop early.
      channel?.addEventListener('message', (e) => {
        const m = e.data as ControllerMsg;
        if (m.type === 'stop' && m.runId === currentRunId) finishRun();
      });
    }

    const handleControllerMsg = (m: ControllerMsg) => {
      if (m.type === 'start') {
        if (currentRunId !== null) return; // already running — ignore duplicate kicks
        if (!expectedRunId || m.runId === expectedRunId) void startRun(m);
      } else if (m.type === 'stop' && m.runId === currentRunId) {
        finishCurrent?.();
      }
    };

    channel?.addEventListener('message', (e) => {
      handleControllerMsg(e.data as ControllerMsg);
    });

    // Register Tauri listener BEFORE sending ready, otherwise the
    // controller's 'start' reply races our listener registration and
    // is delivered to nothing.
    (async () => {
      if (tauriEvent?.listen) {
        try {
          const off = await tauriEvent.listen(CHANNEL_NAME, (event) => {
            handleControllerMsg(event.payload as ControllerMsg);
          });
          if (cancelled) {
            off();
            return;
          }
          offTauri = off;
        } catch {
          // capability denied; fall back to channel path if available
        }
      }
      if (!cancelled) {
        send({ type: 'ready', runId: expectedRunId ?? '' });
        if (fallbackStart) {
          window.setTimeout(() => {
            if (cancelled || currentRunId !== null) return;
            void startRun(fallbackStart);
          }, 2_000);
        }
      }
    })();

    return () => {
      cancelled = true;
      offTauri?.();
      channel?.close();
      finishCurrent?.();
      stopRun?.();
    };
  }, []);

  return null;
}
