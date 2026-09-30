/**
 * endpoint-ipc ENGAGEMENT — is the IPC bridge carrying anything, or is it
 * installed and connected to nothing?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * WI-6512, owner-reported and observed live 2026-07-28: the operator was
 * LISTENING on its IPC socket with **zero** connections to it, while the webview
 * held 6 TCP connections carrying 5 long-lived SSE streams. The IPC fix was
 * installed, connected to nothing, and had silently reverted to the exact
 * libsoup 6-socket-per-origin exhaustion it exists to prevent. Every half was
 * individually correct and fully unit-tested. The owner's symptom was "clicking
 * an agent takes several seconds"; nothing anywhere reported the gap.
 *
 * That is the whole defect class this module answers, generalised by D-025 on
 * `context-injection-audit-2026-07-28`: **a mechanism can be INSTALLED and
 * CARRYING NO TRAFFIC, and nothing compares installed-ness to engagement.**
 * D-025 is worth reading before extending this file — it establishes that the
 * class is an ENGAGEMENT property, not the constant-divergence property the
 * originating plan item assumed. (A constant-vs-locked-value check would have
 * caught none of the class's three motivating instances: two of the three had no
 * constant at all, and the third's constant was in force the whole time.)
 *
 * ── THE THREE READINGS THIS DELIBERATELY KEEPS APART ─────────────────────────
 *
 * A naive detector asks `connectionCount() === 0` and fires. That is wrong three
 * separate ways, and each had to be closed on its own:
 *
 *  (1) INSTANTANEOUS ZERO IS NOT "NEVER ENGAGED". `connectionCount()` is a live
 *      gauge; 0 is a perfectly healthy reading between reconnects, during a
 *      client restart, or before the client has booted. Closed by reading the
 *      monotonic {@link EngagementObservation.acceptedTotal} instead — the
 *      lifetime counter added to `@papercusp/ipc-endpoint-server` for exactly
 *      this question. This is the same epistemics the repo already relies on in
 *      `inference-gateway/gateway-wedge.ts`, where a FROZEN `totalRequests` is
 *      what separates "idle" from "wedged": a gauge cannot answer a question
 *      about history.
 *
 *  (2) "NOBODY DIALLED IT" IS NOT A DEFECT ON ITS OWN. On a box with no desktop
 *      app running, an IPC bridge with zero lifetime connections is correct and
 *      uninteresting — there is no client to carry. Firing there would produce a
 *      permanently-red detector that everyone learns to ignore, which is worse
 *      than no detector. Closed by {@link EngagementObservation.bypassClients}:
 *      the signal requires positive evidence that a client IS reaching this host
 *      by the very path the bridge was built to replace. `bypassed` and
 *      `idle-no-client` are therefore different verdicts, and only the first is
 *      a finding.
 *
 *  (3) A JUST-BOOTED SERVER HAS NOT HAD TIME. The bridge legitimately sits at
 *      zero across the whole startup window while the webview is still coming
 *      up. Closed by {@link EngagementThresholds.graceMs}; below it the verdict
 *      is `within-grace` and nothing fires.
 *
 * The resulting fire condition is exactly WI-6512's observed signature and
 * nothing looser: listening, past the grace window, never engaged by anyone,
 * WHILE clients are demonstrably being served over the bypassed transport.
 *
 * ── ⚠ THE PROBE MUST STAY REACHABLE ──────────────────────────────────────────
 *
 * `EndpointIpcServer.connectionCount()` existed for months with ZERO non-test
 * consumers tree-wide, because `apps/operator/bin/host-bootstrap.ts` held the
 * server handle in a local `const` inside a fire-and-forget IIFE, let
 * `socketPath` escape, and dropped the handle. The engagement probe for the
 * class's only confirmed instance was itself an instance of the class. That is
 * what {@link setLiveEndpointIpcServer} prevents: the boot site now publishes
 * the handle, and this module is its reader. If you refactor that boot site, the
 * registration must survive — a dropped handle silently returns this detector to
 * observing nothing while still presenting as coverage.
 */
import { activeStreams } from '../harness-active-streams';
import type { CollectorResult, WatchdogSignal } from '../harness/improvements/watchdog';
import type { EndpointIpcServer } from './server';

/** What the mechanism looks like from outside, at one instant. */
export interface EngagementObservation {
  /** Is the mechanism switched on and listening at all? */
  installed: boolean;
  /** How long it has been listening. */
  uptimeMs: number;
  /** Monotonic lifetime count of connections it has ever accepted. */
  acceptedTotal: number;
  /** Connections open right now (context for the body; never the trigger). */
  currentlyOpen: number;
  /**
   * Clients demonstrably reaching this host over the transport the mechanism
   * was built to REPLACE. For endpoint-ipc that is the count of live HTTP SSE
   * streams: those are precisely the long-lived connections that exhaust
   * libsoup's per-origin socket pool, and holding them over HTTP while the IPC
   * socket sits at zero IS the WI-6512 signature.
   */
  bypassClients: number;
}

export interface EngagementThresholds {
  /** Below this uptime the mechanism has not had a fair chance to be dialled. */
  graceMs: number;
  /** How many bypassing clients count as proof a client exists to be carried. */
  minBypassClients: number;
}

export const ENGAGEMENT_DEFAULTS: EngagementThresholds = {
  // Generous on purpose: a false "installed but unused" during a slow desktop
  // boot would train readers to ignore the one signal that matters.
  graceMs: 5 * 60_000,
  // One live bypassing stream is already proof a client exists and is not using
  // the bridge. WI-6512 was observed at five.
  minBypassClients: 1,
};

export type EngagementVerdict =
  /** Switched off — there is nothing to judge. */
  | 'not-installed'
  /** Listening, but too recently to conclude anything. */
  | 'within-grace'
  /** It has carried traffic. Healthy. */
  | 'engaged'
  /** Never engaged, and no evidence any client exists. NOT a defect. */
  | 'idle-no-client'
  /** Never engaged WHILE clients are served over the bypassed transport. THE DEFECT. */
  | 'bypassed';

export interface EngagementAssessment {
  verdict: EngagementVerdict;
  observation: EngagementObservation;
  thresholds: EngagementThresholds;
}

/**
 * The pure verdict. Total, side-effect free, and the only place the three
 * readings above are told apart — everything else in this file is plumbing.
 */
export function assessEngagement(
  observation: EngagementObservation,
  thresholds: EngagementThresholds = ENGAGEMENT_DEFAULTS,
): EngagementAssessment {
  const base = { observation, thresholds };
  if (!observation.installed) return { ...base, verdict: 'not-installed' };
  if (observation.uptimeMs < thresholds.graceMs) return { ...base, verdict: 'within-grace' };
  // Reading (1): history, not the live gauge. A bridge that carried traffic and
  // is idle right now is engaged — the mechanism demonstrably works.
  if (observation.acceptedTotal > 0) return { ...base, verdict: 'engaged' };
  // Reading (2): never engaged is only a defect when there was something to carry.
  if (observation.bypassClients < thresholds.minBypassClients) {
    return { ...base, verdict: 'idle-no-client' };
  }
  return { ...base, verdict: 'bypassed' };
}

/** Only `bypassed` is a finding; the other four verdicts are healthy or unjudgeable. */
export function isEngagementDefect(verdict: EngagementVerdict): boolean {
  return verdict === 'bypassed';
}

/* ─── the live handle registry (see "THE PROBE MUST STAY REACHABLE") ───────── */

interface LiveEntry {
  server: Pick<EndpointIpcServer, 'connectionCount' | 'acceptedTotal' | 'socketPath'>;
  listeningSinceMs: number;
}

let live: LiveEntry | null = null;

/**
 * Publish the running IPC server so its engagement is observable. Called once
 * from the operator boot site immediately after the server starts; pass `null`
 * on shutdown. Keeping this a module-level registry rather than a constructor
 * argument is deliberate — the boot site is a fire-and-forget IIFE and the
 * watchdog collector runs much later, in the same process, with no reference to
 * it.
 */
export function setLiveEndpointIpcServer(
  server: LiveEntry['server'] | null,
  nowMs: number = Date.now(),
): void {
  live = server ? { server, listeningSinceMs: nowMs } : null;
}

/** Test seam — drop the registered handle. */
export function _resetLiveEndpointIpcServer(): void {
  live = null;
}

/**
 * Read the current engagement observation, or `null` when no IPC server is
 * registered in this process (which is the honest answer, and distinct from an
 * observation reporting zeroes — a caller must not read "no server" as "server
 * carrying nothing").
 */
export function readEndpointIpcEngagement(
  bypassClients: number,
  nowMs: number = Date.now(),
): EngagementObservation | null {
  if (!live) return null;
  return {
    installed: true,
    uptimeMs: Math.max(0, nowMs - live.listeningSinceMs),
    acceptedTotal: live.server.acceptedTotal(),
    currentlyOpen: live.server.connectionCount(),
    bypassClients,
  };
}

/* ─── watchdog collector ──────────────────────────────────────────────────── */

/** Turn a defect assessment into the filed signal. Pure; exported for tests. */
export function engagementSignals(assessment: EngagementAssessment): WatchdogSignal[] {
  if (!isEngagementDefect(assessment.verdict)) return [];
  const { observation: o, thresholds: t } = assessment;
  const uptimeMin = Math.round(o.uptimeMs / 60_000);
  return [
    {
      source: 'endpoint-ipc-engagement',
      key: 'endpoint-ipc-installed-but-bypassed',
      title: 'Desktop IPC bridge is listening but carrying nothing — clients are bypassing it over HTTP',
      body:
        `Watchdog signal (endpoint-ipc-engagement): the operator's IPC endpoint has been ` +
        `listening for ~${uptimeMin}min and has accepted ZERO connections over its entire ` +
        `lifetime (currently open: ${o.currentlyOpen}), while ${o.bypassClients} live HTTP SSE ` +
        `stream(s) are being served right now — at or above the ${t.minBypassClients}-client ` +
        `threshold that proves a client exists and is reaching this host another way.\n\n` +
        `This is the WI-6512 signature exactly: the IPC fix installed, connected to nothing, ` +
        `and silently reverted to the libsoup ~6-socket-per-origin exhaustion it exists to ` +
        `prevent. The user-visible symptom is that clicking around the desktop UI takes ` +
        `seconds, because on-demand /api fetches starve behind long-lived SSE streams.\n\n` +
        `Check, in order: (1) is the webview actually installing the IPC polyfill ` +
        `(desktop-bootstrap) — a bridge nobody dials is usually a client-side wiring loss, ` +
        `not a server fault; (2) is \`forceHttp\` set, which deliberately routes everything ` +
        `over HTTP; (3) does the socket the client discovered match the one this process is ` +
        `listening on (a stale discovery file points the client at a dead socket).\n\n` +
        `Judged on the LIFETIME accept count, not the instantaneous connection count: 0 open ` +
        `right now is a healthy reading between reconnects, so only "never dialled by anyone" ` +
        `is treated as evidence of non-engagement (D-025).`,
      severity: 'major',
      kind: 'bug',
      paths: [
        'libs/generic/desktop-ipc/src/desktop-bootstrap.ts',
        'packages/operator-core/lib/endpoint-ipc/engagement.ts',
        'apps/operator/bin/host-bootstrap.ts',
      ],
    },
  ];
}

/**
 * Tunables, in the repo's collector convention: the watchdog's `CollectOptions`
 * extends this (alongside `LearningSloOptions`) so the single shared options bag
 * carries them to the collector.
 */
export interface EngagementCollectorOptions {
  /** Uptime below which the bridge has not had a fair chance to be dialled. */
  engagementGraceMs?: number;
  /** Bypassing clients that count as proof a client exists to be carried. */
  engagementMinBypassClients?: number;
}

export interface EngagementCollectorDeps {
  /**
   * Clients reaching this host over the transport IPC was meant to replace.
   * Defaults to the live HTTP SSE stream registry.
   */
  readBypassClients?: () => number;
  now?: () => number;
}

/**
 * endpoint-ipc engagement: compare INSTALLED against ENGAGED once per tick.
 *
 * Every non-firing path returns an explanatory `note` rather than a bare empty
 * result. That is deliberate and load-bearing: the failure this detector exists
 * to catch is a mechanism that observes nothing while presenting as coverage, so
 * "I ran and here is what I saw" must be distinguishable from "I ran and saw
 * nothing" in the tick record. A permanently silent detector is the bug.
 */
export async function endpointIpcEngagementCollector(
  opts: EngagementCollectorOptions = {},
  deps: EngagementCollectorDeps = {},
): Promise<CollectorResult> {
  const now = deps.now ?? Date.now;
  // Statically imported, NOT `require`d: operator-core is ESM ("type":"module"),
  // so a `require` here is a ReferenceError at runtime — which the guard below
  // would have swallowed into a permanent bypassClients=0, silently disabling
  // the only clause that can make this detector fire. A detector that can never
  // fire while presenting as coverage is the exact defect this module exists to
  // catch, so it must not be reintroduced. The registry is hung off globalThis,
  // so a static import shares the one true Map.
  const readBypassRaw = deps.readBypassClients ?? (() => activeStreams.size);
  // Guarded at the CALL, not inside the default — an injected probe is just as
  // able to throw, and a collector must never take a watchdog tick down over an
  // annotation. Degrading to 0 is the conservative direction: it can only
  // SUPPRESS this signal, never manufacture one.
  const readBypass = (): number => {
    try {
      return readBypassRaw();
    } catch {
      return 0;
    }
  };

  const thresholds: EngagementThresholds = {
    graceMs: opts.engagementGraceMs ?? ENGAGEMENT_DEFAULTS.graceMs,
    minBypassClients: opts.engagementMinBypassClients ?? ENGAGEMENT_DEFAULTS.minBypassClients,
  };

  const observation = readEndpointIpcEngagement(readBypass(), now());
  if (!observation) {
    return {
      signals: [],
      note:
        'endpoint-ipc: no IPC server registered in this process — engagement not judged. ' +
        'Expected when the bridge is disabled (PAPERCUSP_IPC_ENABLE=0); if the bridge IS ' +
        'running, the boot site stopped publishing its handle and this detector is blind.',
    };
  }

  const assessment = assessEngagement(observation, thresholds);
  const signals = engagementSignals(assessment);
  return {
    signals,
    note:
      `endpoint-ipc engagement: ${assessment.verdict} ` +
      `(lifetime accepts ${observation.acceptedTotal}, open now ${observation.currentlyOpen}, ` +
      `bypassing HTTP stream clients ${observation.bypassClients}, ` +
      `uptime ${Math.round(observation.uptimeMs / 60_000)}min).`,
  };
}
