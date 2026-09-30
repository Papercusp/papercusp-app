/**
 * learning-infra-health — ONE composite "learning system offline/degraded"
 * status (self-improvement-consume-edges-2026-06-12 P-003 / D-002).
 *
 * The learning system's own dependencies are not improvements-queue work: an
 * auto-implement worker cannot fix a docker port mapping, and a queue row
 * generates no pressure (the 2026-06-12 audit found one dead transport had
 * silently starved the gym + llm-testing for ~2 days behind EI rows nobody
 * read). So infra failures ESCALATE — an owner notification on the transition
 * to offline + a standing Learning-tab chip — instead of only queueing.
 *
 * Three legs feed the composite:
 *   - **llm-spine** — can a stateless LLM call actually reach an LLM right now?
 *     The spine: the gym judge, llm-testing, and implement-lane judging all
 *     ride it. TWO dimensions, because the real egress changed under this leg:
 *     (1) CREDENTIAL — a transport resolves (live Claude session →
 *     anthropic-direct) on the SAME resolution the real calls use, never a
 *     network port probe;
 *     (2) GATEWAY — when INFERENCE_GATEWAY is ON those in-process calls egress
 *     through the localhost pacing gateway (operator-spawn + autoloop-cycle
 *     point ANTHROPIC_BASE_URL/PAPERCUSP_ANTHROPIC_URL at it), which can be DOWN
 *     while the credential is present — the false-"ok" mirror of EI-398's
 *     false-"offline" — so the leg ALSO requires the gateway's /healthz to
 *     answer. Flag off → credential alone (unchanged direct egress).
 *   - **spawn-path** — an OPEN improvement on the runner-spawn structural
 *     watchdog key means the auto-implement lane cannot dispatch workers.
 *   - **gym-circuit** — any enabled gym autoloop whose fire circuit is OPEN
 *     (autoloop_state consecutive_errors past the threshold).
 *
 * Composite rule (composeLearningHealth): llm-spine down alone ⇒ OFFLINE (the
 * spine); both non-spine legs down ⇒ OFFLINE (can neither run the gym nor
 * dispatch workers); exactly one non-spine leg down ⇒ DEGRADED. A leg whose
 * evaluation itself failed is 'unknown' and counts toward OK — a health
 * monitor error must not fabricate an outage (same fail-open stance as
 * checkFireGate).
 *
 * Cross-tick transition state is a module singleton, NOT PG — deliberately
 * mirroring service-health.ts: on operator restart prev resets to unknown, so
 * a restart re-alerts only a learning system that is actually still offline
 * (acceptable, arguably desirable) and never spams a healthy one. The
 * known-open aging escalation (P-020) is the durable pressure layer on top.
 *
 * Driven by a DBOS scheduled workflow (periodic-workflows.ts); read by the
 * `learning.health` sync resolver; gated by FLAGS.LEARNING_INFRA_HEALTH
 * (default ON).
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { probeStatelessTransport, type StatelessTransportProbe } from '@papercusp/papercusp-shared/agent';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { notifySyncInvalidate } from '../../sync-sse';
import { evaluateFireGate, readFireState } from '../../autoloop';
import { activeWorkspaceId } from '../../workspace-registry';
import { listAutoloopsForWorkspace } from '../../gym/control-plane';
import { readWatchdogKeyDups } from './watchdog';
import { probeHttpReachable } from '../../escalating-http-probe';

export type InfraLegStatus = 'ok' | 'down' | 'unknown';
export type InfraLegName = 'llm-spine' | 'spawn-path' | 'gym-circuit';

export interface InfraLeg {
  name: InfraLegName;
  status: InfraLegStatus;
  /** Human-readable evidence ("stateless transport: anthropic-direct", "circuit OPEN: gymloopharness …"). */
  detail: string;
}

export type LearningHealthStatus = 'ok' | 'degraded' | 'offline';

export interface LearningInfraHealth {
  status: LearningHealthStatus;
  /** One human line — the down legs' evidence, or "all legs up". */
  reason: string;
  legs: InfraLeg[];
  /** Epoch ms of this evaluation. */
  evaluatedAt: number;
}

/** The watchdog key the runner-spawn structural failure files under (EI-334 class). */
export const SPAWN_PATH_WATCHDOG_KEY = 'repeated-tool-error:cup:spawn:structural';

// Keep in sync with GYM_CYCLE_FIRE_ROLE in harness/routines/gym-actions.ts —
// not imported because that module registers system actions at import time,
// and this leaf is also loaded from the sync resolver.
const GYM_CYCLE_FIRE_ROLE = 'gym-cycle';

// A deliberate light copy of inference-gateway/spawn-env.ts's gatewayPort() +
// DEFAULT_GATEWAY_PORT — importing that module would transitively pull the
// gateway HTTP server + credential store into this sync-resolver leaf (same
// keep-this-leaf-light reason as GYM_CYCLE_FIRE_ROLE above).
const GATEWAY_DEFAULT_PORT = 8788;
function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : GATEWAY_DEFAULT_PORT;
}

// ── pure core ────────────────────────────────────────────────────────────────

/** Compose the three legs into the ONE status the chip + notification carry. */
export function composeLearningHealth(
  legs: InfraLeg[],
  nowMs: number,
  opts: { learningConsumersPresent?: boolean } = {},
): LearningInfraHealth {
  // No-consumer gate (WI-3167): on a host with no self-improvement workload — a
  // shipped end-user desktop has no enabled gym autoloop, no auto-implement lane,
  // and no Claude session — a down llm-spine is NOT an outage: nothing consumes the
  // spine. Without this gate every fresh desktop install perpetually reports the
  // learning system OFFLINE (its llm-spine leg is down for want of a Claude session)
  // and the Sentinel relays "owner-facing infra is degraded" into the user's chat.
  // Default true ⇒ unchanged behavior on the dev/owner fleet, where consumers exist.
  // The down llm-spine leg is still kept in `legs` for the chip's detail; only its
  // contribution to the composite STATUS is suppressed.
  const learningConsumersPresent = opts.learningConsumersPresent ?? true;
  const down = legs
    .filter((l) => l.status === 'down')
    .filter((l) => learningConsumersPresent || l.name !== 'llm-spine');
  const spineDown = down.some((l) => l.name === 'llm-spine');
  const status: LearningHealthStatus =
    spineDown || down.length >= 2 ? 'offline' : down.length === 1 ? 'degraded' : 'ok';
  const unknowns = legs.filter((l) => l.status === 'unknown');
  const spineSuppressed =
    !learningConsumersPresent && legs.some((l) => l.name === 'llm-spine' && l.status === 'down');
  const reason =
    down.length > 0
      ? down.map((l) => `${l.name}: ${l.detail}`).join('; ')
      : spineSuppressed
        ? 'no self-improvement workload on this host (no enabled gym autoloop) — a stateless-LLM spine is not required here'
        : unknowns.length > 0
          ? `all checkable legs up (${unknowns.map((l) => l.name).join(', ')} unknown)`
          : 'all legs up';
  return { status, reason, legs, evaluatedAt: nowMs };
}

export type LearningHealthTransition = 'offline' | 'recovered' | null;

/**
 * Pure transition detector. `prev === null` (first evaluation this process)
 * treats OFFLINE as a fresh alert — an operator booting into a dead learning
 * system must ping the owner, at the cost of a repeat alert per restart while
 * the outage persists (documented trade-off above). Recovery is the
 * offline→not-offline edge only; ok↔degraded moves are chip-only.
 */
export function diffLearningHealth(
  prev: LearningHealthStatus | null,
  next: LearningHealthStatus,
): LearningHealthTransition {
  if (next === 'offline' && prev !== 'offline') return 'offline';
  if (prev === 'offline' && next !== 'offline') return 'recovered';
  return null;
}

// ── leg collectors (IO — each fails soft to 'unknown') ──────────────────────

/** Reachability of the gateway's own `/healthz`. */
export interface GatewayReachability {
  reachable: boolean;
  /** Evidence: "HTTP 200" / "HTTP 503" (alive, pacing) when reachable; the network error otherwise. */
  detail: string;
}

/**
 * Probe the localhost inference-gateway's `/healthz`. ANY HTTP answer — incl. a
 * 503 rate-limit PAUSE (the gateway pacing by design) — means the gateway
 * PROCESS is alive and the spine is reachable; only a transport-level failure on
 * EVERY attempt is `reachable:false`, mirroring what a real `llmCall` through the
 * gateway hits (EI-398's lesson: probe the router the calls actually use).
 *
 * EI-1693: retries with an escalating (load-aware) timeout — one transient
 * timeout under load is NOT a down gateway. Delegates to the shared
 * escalating-http-probe so this stays in lock-step with system-health's gateway
 * probe (WI-266: that copy had drifted). Exported for the retry unit test.
 */
export function probeGatewayHealthz(
  port: number,
  opts: { timeouts?: readonly number[]; gapMs?: number } = {},
): Promise<GatewayReachability> {
  return probeHttpReachable(`http://127.0.0.1:${port}/healthz`, opts);
}

/** Injectable seams for checkLlmSpineLeg — tests pass fakes; production uses the defaults. */
export interface LlmSpineDeps {
  probe: () => StatelessTransportProbe;
  gatewayEnabled: () => Promise<boolean>;
  gatewayPort: () => number;
  gatewayReachable: (port: number) => Promise<GatewayReachability>;
}

const defaultLlmSpineDeps: LlmSpineDeps = {
  probe: probeStatelessTransport,
  // Same flag + distinctId the egress chokepoints read (operator-spawn.ts, autoloop-cycle.ts).
  gatewayEnabled: () => getFlag(FLAGS.INFERENCE_GATEWAY, 'system'),
  gatewayPort,
  gatewayReachable: (port) => probeGatewayHealthz(port),
};

/**
 * The LLM spine leg (see the module header for the two-dimension rationale):
 *   1. CREDENTIAL — `resolveStatelessTransport` resolves a transport, shared
 *      with the real call path so the leg can never disagree with it.
 *   2. GATEWAY — when INFERENCE_GATEWAY is ON the resolved transport actually
 *      egresses through the localhost gateway, so a creds-present box with a
 *      dead gateway is still spine-down; require `/healthz` to answer. Flag
 *      off → credential alone.
 * No credential ⇒ down (regardless of the gateway). A gateway-probe error
 * surfaces as `reachable:false` (= down) deliberately: when the flag is on a
 * gateway that won't answer IS a real outage. (`legSafe` still catches an
 * unexpected throw → 'unknown', so a bug never fabricates an outage.)
 */
export async function checkLlmSpineLeg(deps: Partial<LlmSpineDeps> = {}): Promise<InfraLeg> {
  const d = { ...defaultLlmSpineDeps, ...deps };
  const result = d.probe();
  if (!result.ok) return { name: 'llm-spine', status: 'down', detail: result.error };

  if (!(await d.gatewayEnabled())) {
    return { name: 'llm-spine', status: 'ok', detail: `stateless transport: ${result.label}` };
  }
  const port = d.gatewayPort();
  const gw = await d.gatewayReachable(port);
  return gw.reachable
    ? {
        name: 'llm-spine',
        status: 'ok',
        detail: `stateless transport: ${result.label} via inference-gateway :${port} (${gw.detail})`,
      }
    : {
        name: 'llm-spine',
        status: 'down',
        detail: `inference-gateway :${port} unreachable (${gw.detail}) — gym/llm-testing/implement-lane egress is down despite a present ${result.label} credential`,
      };
}

/** The runner spawn path: an OPEN improvement on the structural-spawn key = down. */
async function checkSpawnPathLeg(): Promise<InfraLeg> {
  const dups = await readWatchdogKeyDups([SPAWN_PATH_WATCHDOG_KEY]);
  const open = dups.some((d) => d.state === 'open');
  return open
    ? {
        name: 'spawn-path',
        status: 'down',
        detail: `open improvement on ${SPAWN_PATH_WATCHDOG_KEY} — runner spawns failing structurally`,
      }
    : { name: 'spawn-path', status: 'ok', detail: 'no open spawn-structural watchdog item' };
}

/** Gym circuit: any ENABLED gym autoloop whose fire gate is circuit-open = down. */
async function checkGymCircuitLeg(): Promise<InfraLeg> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const autoloops = await listAutoloopsForWorkspace(sql, { workspaceId: ws });
  const enabled = autoloops.filter((a) => a.enabled);
  if (enabled.length === 0) {
    return { name: 'gym-circuit', status: 'ok', detail: 'no enabled gym autoloops' };
  }
  const open: string[] = [];
  for (const a of enabled) {
    const verdict = evaluateFireGate(await readFireState(a.harnessSlug, GYM_CYCLE_FIRE_ROLE));
    if (!verdict.allow && verdict.reason === 'circuit-open') {
      open.push(`${a.harnessSlug} (${verdict.consecutiveErrors} consecutive errors)`);
    }
  }
  return open.length > 0
    ? { name: 'gym-circuit', status: 'down', detail: `circuit OPEN: ${open.join(', ')}` }
    : { name: 'gym-circuit', status: 'ok', detail: `${enabled.length} gym autoloop(s), all circuits closed` };
}

/** Run one leg, degrading its own failure to 'unknown' (never a fake outage). */
async function legSafe(name: InfraLegName, run: () => Promise<InfraLeg>): Promise<InfraLeg> {
  try {
    return await run();
  } catch (e) {
    return { name, status: 'unknown', detail: `leg check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function collectLegs(): Promise<InfraLeg[]> {
  return Promise.all([
    legSafe('llm-spine', () => checkLlmSpineLeg()),
    legSafe('spawn-path', checkSpawnPathLeg),
    legSafe('gym-circuit', checkGymCircuitLeg),
  ]);
}

/**
 * WI-3167: does this host actually run the self-improvement system? The concrete
 * signal is at least one ENABLED gym autoloop — the dev/owner fleet has them; a
 * shipped end-user desktop has none (no gym, no auto-implement lane, no Claude
 * session). When false, composeLearningHealth stops treating a down llm-spine as an
 * outage, so a fresh desktop no longer perpetually reports the learning system
 * OFFLINE and the Sentinel no longer surfaces a phantom "infra degraded" to the
 * user. Fail-SAFE to true on error — never suppress a real outage because the
 * consumer probe itself threw (same fail-open stance as legSafe / checkFireGate).
 */
async function hasLearningConsumers(): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const autoloops = await listAutoloopsForWorkspace(sql, { workspaceId: ws });
    return autoloops.some((a) => a.enabled);
  } catch {
    return true;
  }
}

// ── notification rail (D-002: infra escalates, it doesn't queue) ────────────

const LEARNING_HEALTH_IDENTITY: AgentIdentity = {
  ownerId: 'learning-infra-health',
  ownerLabel: 'learning-infra-health',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

const TOAST_RING_BUFFER = 2000;

/**
 * Owner notification on a transition: coord broadcast + a toast row (the rail
 * `notifications:recent` and the desktop notification panel read) — mirrors
 * agent-governor-observer.surfacePause. Best-effort: a notify failure never
 * fails the tick.
 */
async function notifyTransition(transition: 'offline' | 'recovered', health: LearningInfraHealth): Promise<void> {
  const offline = transition === 'offline';
  const summary = offline
    ? `🔴 learning system OFFLINE — ${health.reason}`
    : `✅ learning system recovered (${health.status})`;
  await sendMessage(LEARNING_HEALTH_IDENTITY, { to: ['*'], summary, category: 'learning-health' }).catch(() => {});
  try {
    const tl = generated.toastLogInHarnessShared;
    const { db } = getOrgPg();
    await db.insert(tl).values({
      level: offline ? 'error' : 'success',
      message: offline ? 'Learning system offline' : 'Learning system recovered',
      description: offline
        ? `Self-improvement infrastructure is down — ${health.reason}. Gym cycles, llm-testing, and the auto-implement lane are starved until this recovers. Infra failures escalate to you because the improvement queue cannot fix them itself.`
        : `Learning infrastructure recovered: ${health.legs.map((l) => `${l.name} ${l.status}`).join(', ')}.`,
      harnessSlug: null,
      createdAt: Date.now(),
      actionLabel: 'Open Learning',
      actionHref: '/adv?tab=learning',
    });
    void (async () => {
      const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(TOAST_RING_BUFFER);
      if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
    })().catch(() => {});
    void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
  } catch {
    /* PG not ready / write failed — the coord broadcast above is the floor */
  }
}

// ── tick + read surface ──────────────────────────────────────────────────────

/** Injectable seams (tests). Production callers pass nothing. */
export interface LearningInfraHealthDeps {
  legs: () => Promise<InfraLeg[]>;
  consumersPresent: () => Promise<boolean>;
  notify: (transition: 'offline' | 'recovered', health: LearningInfraHealth) => Promise<void>;
  invalidate: () => Promise<void>;
  now: () => number;
}

const defaultDeps: LearningInfraHealthDeps = {
  legs: collectLegs,
  consumersPresent: hasLearningConsumers,
  notify: notifyTransition,
  invalidate: () => notifySyncInvalidate('learning.health', undefined),
  now: () => Date.now(),
};

// WI-3167: a single OFFLINE tick must not page the owner. The dev/owner-fleet
// inference-gateway /healthz probe times out transiently under load (6s) and
// recovers within a tick, and the creds file has a brief unreadable window during
// its ~2-hourly atomic rotation — both produced repeated false OFFLINE→recovered
// flaps in the toast_log. Require this many CONSECUTIVE offline ticks before the
// owner-notifying 'offline' transition fires; a not-yet-confirmed offline presents
// as 'degraded' (a real leg IS down) so the chip still reflects the trouble.
const OFFLINE_DEBOUNCE_TICKS = 2;

// Cross-tick state — module singletons by design (see header).
let prevStatus: LearningHealthStatus | null = null;
let lastHealth: LearningInfraHealth | null = null;
let consecutiveOfflineTicks = 0;

/** Last composite evaluation in this process, or null if never evaluated. */
export function lastLearningInfraHealth(): LearningInfraHealth | null {
  return lastHealth;
}

/**
 * One health tick: collect legs, compose, detect the transition, notify the
 * owner on offline/recovered, invalidate `learning.health` on any status
 * change. Driven by the DBOS scheduled workflow; also runs on-demand from a
 * stale resolver read (same transition semantics either way).
 */
export async function runLearningInfraHealthTick(
  overrides: Partial<LearningInfraHealthDeps> = {},
): Promise<{ health: LearningInfraHealth; transition: LearningHealthTransition }> {
  const deps = { ...defaultDeps, ...overrides };
  const [legs, learningConsumersPresent] = await Promise.all([deps.legs(), deps.consumersPresent()]);
  const raw = composeLearningHealth(legs, deps.now(), { learningConsumersPresent });

  // Debounce the owner-facing escalation (see OFFLINE_DEBOUNCE_TICKS): a raw OFFLINE
  // becomes the CONFIRMED status only after N consecutive offline ticks. Before that
  // it presents as 'degraded' unless we were already confirmed-offline (a persistent
  // outage stays offline). Any non-offline tick clears the streak immediately, so
  // recovery is never delayed.
  consecutiveOfflineTicks = raw.status === 'offline' ? consecutiveOfflineTicks + 1 : 0;
  const confirmedStatus: LearningHealthStatus =
    raw.status === 'offline' && consecutiveOfflineTicks < OFFLINE_DEBOUNCE_TICKS
      ? prevStatus === 'offline'
        ? 'offline'
        : 'degraded'
      : raw.status;
  const health: LearningInfraHealth = { ...raw, status: confirmedStatus };

  const transition = diffLearningHealth(prevStatus, health.status);
  const statusChanged = prevStatus !== health.status;
  prevStatus = health.status;
  lastHealth = health;
  if (transition) {
    await deps.notify(transition, health).catch(() => {});
  }
  if (statusChanged) {
    await deps.invalidate().catch(() => {});
  }
  return { health, transition };
}

/**
 * Read surface for the `learning.health` sync resolver: the cached snapshot
 * when fresh, else a live tick. Returns null when the feature flag is off.
 */
export async function getLearningInfraHealth(maxAgeMs = 5 * 60_000): Promise<LearningInfraHealth | null> {
  if (!(await getFlag(FLAGS.LEARNING_INFRA_HEALTH, 'learning-infra-health'))) return null;
  if (lastHealth && Date.now() - lastHealth.evaluatedAt <= maxAgeMs) return lastHealth;
  const { health } = await runLearningInfraHealthTick();
  return health;
}

/** Test-only — reset the cross-tick singleton. */
export function _resetLearningInfraHealthState(): void {
  prevStatus = null;
  lastHealth = null;
  consecutiveOfflineTicks = 0;
}
