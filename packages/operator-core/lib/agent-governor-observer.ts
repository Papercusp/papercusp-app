/**
 * Agent rate-limit-governor observability wiring (RB-009).
 *
 * The domain-free `RateLimitGovernor` fires `onPause` (via the registry's `onGovernorPause`
 * emitter) whenever a bucket's pause is newly set or extended — i.e. on a real 429 /
 * backpressure transition. This module is the OPERATOR-side host for that signal: it surfaces
 * a "rate-limited — paused until <reset>" status to coord (a broadcast message, mirroring the
 * service-health monitor) and the toast stream (`notifications:recent`), so a human/agent sees
 * the fleet is throttled instead of silently waiting. The on-demand snapshot lives in the
 * `dev:rate_governor_status` tool.
 *
 * Lib stays domain-free; all the coord/PG coupling is here. Best-effort + throttled — a
 * surfacing failure must never affect the limiter or the spawn path.
 */
import { onGovernorPause } from '@papercusp/papercusp-shared/agent';
import { getOrgPg, generated } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { escalateAlarm } from './alarm-attention';
import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { notifySyncInvalidate } from './sync-sse';

const GOVERNOR_IDENTITY: AgentIdentity = {
  ownerId: 'rate-governor',
  ownerLabel: 'rate-governor',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

// Per-bucket throttle: a sustained rate-limit can extend the pause several times; surface at
// most once per bucket per window so we don't spam coord/toasts.
const SURFACE_THROTTLE_MS = 30_000;
const TOAST_RING_BUFFER = 2000;
/** A brief provider pause is expected backpressure; a pause beyond 90s needs a
 * human. This stays below the account-blind governor's ~2m re-probe cap, so the
 * policy is reachable for the normal fleet-wide bucket. */
export const GOVERNOR_ESCALATION_MIN_PAUSE_MS = 90_000;
const GOVERNOR_ESCALATE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const GOVERNOR_ESCALATION_TITLE = 'Agent rate-limit pause sustained';
const lastSurfaced = new Map<string, number>();
let initialized = false;
let unsubscribePause: (() => void) | undefined;

export interface AgentGovernorObserverDeps {
  /** Injectable for tests — defaults to the shared attention-notify rail. */
  escalate?: (t: { title: string; body: string }) => Promise<void>;
  /** Injectable for tests — the persistent cross-restart cooldown floor. */
  recentlyEscalated?: () => Promise<boolean>;
}

/** Register the pause→coord+toast surfacing. Idempotent; call once at operator boot. */
export function initAgentGovernorObserver(deps: AgentGovernorObserverDeps = {}): void {
  if (initialized) return;
  initialized = true;
  unsubscribePause = onGovernorPause((ev) => {
    // A transport pause (egress-proxy circuit) is not a rate-limit — surfacing "rate-limited — paused"
    // for a flaky proxy is misleading noise. The egress circuit has its own observability.
    if (ev.source === 'transport') return;
    const now = Date.now();
    if (now - (lastSurfaced.get(ev.key) ?? 0) < SURFACE_THROTTLE_MS) return;
    lastSurfaced.set(ev.key, now);
    const untilIso = new Date(ev.pausedUntil).toISOString();
    const pauseDurationMs = Math.max(0, ev.pausedUntil - now);
    void surfacePause(ev.key, untilIso, ev.source, pauseDurationMs, deps).catch(() => {
      /* observability is best-effort */
    });
  });
}

async function surfacePause(
  bucketKey: string,
  untilIso: string,
  source: string,
  pauseDurationMs: number,
  deps: AgentGovernorObserverDeps,
): Promise<void> {
  const summary = `⏳ agent rate-limit — bucket "${bucketKey}" paused until ${untilIso} (${source})`;
  // Coord broadcast (transition only), mirroring the service-health monitor.
  // Ambient category → default-excluded from coord:inbox (opt-in to see it).
  // P-033 (d): see service-health — `rate-governor` does not match the
  // conservative MACHINE_SENDER_PATTERN, so mark it machine chatter explicitly;
  // the sendMessage seam then stamps `expects:'none'` (D-072).
  await sendMessage(GOVERNOR_IDENTITY, {
    to: ['*'],
    summary,
    category: 'agent-governor',
    extra: { auto: true },
  }).catch(() => {});
  // Toast stream (notifications:recent), mirroring writeVerifierWarningToast.
  try {
    const tl = generated.toastLogInHarnessShared;
    const { db } = getOrgPg();
    await db.insert(tl).values({
      level: 'warning',
      message: 'Agent rate-limited — paused',
      description: `Rate-limit bucket "${bucketKey}" is paused until ${untilIso}. Agent spawns + in-process LLM calls on this provider/model-class wait until the reset (no work is lost; they resume automatically).`,
      harnessSlug: null,
      createdAt: Date.now(),
      actionLabel: null,
      actionHref: null,
    });
    void (async () => {
      const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(TOAST_RING_BUFFER);
      if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
    })().catch(() => {});
    void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
  } catch {
    /* PG not ready / write failed — best-effort */
  }

  // The coord transition remains the fast agent-facing signal. A human ping is
  // reserved for a pause beyond the reachable 90-second threshold, so a brief
  // 429/backpressure event does not train the owner to ignore this rail.
  if (pauseDurationMs >= GOVERNOR_ESCALATION_MIN_PAUSE_MS) {
    await escalateAlarm(
      {
        title: GOVERNOR_ESCALATION_TITLE,
        body: `Rate-limit bucket "${bucketKey}" is paused until ${untilIso} (${source}), for at least 90 seconds. ` +
          'Provider capacity is holding agent work; inspect account routing and governor state.',
        cooldownMs: GOVERNOR_ESCALATE_COOLDOWN_MS,
        source: 'agent-governor-observer',
      },
      { notify: deps.escalate, recentlyEscalated: deps.recentlyEscalated },
    );
  }
}

/** Test-only — reset the throttle + init flag. */
export function _resetAgentGovernorObserver(): void {
  unsubscribePause?.();
  unsubscribePause = undefined;
  initialized = false;
  lastSurfaced.clear();
}
