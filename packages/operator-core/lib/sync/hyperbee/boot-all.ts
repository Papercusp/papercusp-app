/**
 * boot-all — workspace-scoped Hyperbee substrate orchestrator.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24
 *       + papercusp-dogfood-phase11-multi-engineer-2026-05-25 (P-078).
 *
 * One entry point per process. Discovers every harness across every
 * workspace FROM THE PG REGISTRY (`harness_shared.harness_registry`, the
 * single source of truth since mig 025 — audit P-078: the old
 * registry.json + readdirSync read silently booted ZERO harnesses when
 * the file was stale), calls `bootHarnessSubstrate` per harness, stashes
 * the handle in a module-level Map keyed by
 * `${workspaceId}::${harnessSlug}`, and exposes lookup + teardown.
 *
 * Idempotent at every level:
 *   - Re-booting an already-booted harness returns the cached handle.
 *   - Booting after partial failure retries only the failed harnesses.
 *   - Closing a non-existent handle is a no-op.
 *
 * Phase 11 P-078 — when a harness has a committed
 * `.papercusp/shared.json`, this module resolves the harness's project
 * directory (PG-canonical via `resolveHarnessPaths`), reads the
 * config, and synthesizes a `gh:<repository_id>` SwarmBinding so the
 * substrate joins Hyperswarm at boot. Private harnesses (no
 * shared.json) get no binding and stay local-only.
 *
 * What this DOES NOT do:
 *   - Boot retry / backoff. A failure logs + moves on; the next
 *     bootAllHarnessesForActiveWorkspace() call retries.
 *
 * Always runs at host boot (bin/host-bootstrap.ts) — the opt-in gate was
 * removed in Stage 4d; the Model B substrate is the default.
 */

import { existsSync } from 'node:fs';
import { workspacesRoot } from '../../workspace-registry';
import type { ProjectEntry } from '../../harness-registry';
import { join } from 'node:path';
import {
  bootHarnessSubstrate,
  type BootedAnnounceIdentity,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from './boot';
import type { SwarmBinding } from './derive-swarm-topic';
import { gitServingUnavailable, validateGitServingState, type GitServingRequest, type GitServingState } from '../pot-git/serving-capability';
import type { MergeCursorStore } from './read-merge';
import { createPgMergeCursorStore } from './pg-merge-cursor-store';
import { loadSharedConfigFromProjectDir } from '../../harness/load-shared-config';
import { refreshOutboxEpochEncryptForHarness, wireOutboxForHarness } from './wire-outbox';
import { wirePresenceAnnounceForHarness } from './wire-presence';
import { mapWithConcurrency } from '../../gym/concurrency';
import { pinRepoKeysForWorkspace } from '../pot-git/pin-repo-keys';
import { adoptAnnouncedRepoKeysForWorkspace } from '../pot-git/adopt-announced-repo-keys';
import { rekeyLinkJoinedRepoKeysForWorkspace } from '../pot-git/rekey-link-joined-repo-keys';
import type { BootedHarnessFacts } from './substrate-eviction-policy';
// P-012 slice B — the swarm-presence keepalive that lets a federating harness be
// left dark. This import is one-way: substrate-wake-wiring reaches BACK into
// this module only through lazy `await import`s, so there is no static cycle.
import {
  armSubstrateWakeKeepalive,
  disarmSubstrateWakeKeepalive,
  mayDeferOnWakeVerdict,
  type ArmWakeVerdict,
} from './substrate-wake-wiring';
import { RemoteBootedHarnessHandle } from './remote-booted-harness';
import { backgroundWorkersEnabled } from '../../background-workers';
import { pinModuleState } from '@papercusp/module-singleton';
import { getOwnLogForkState } from './own-log-fork-guard';

/**
 * THE SUBSTRATE BOOT REGISTRY — pinned to the realm, not to this module record.
 *
 * Every collection below answers some form of "is this hive resident in THIS
 * process, and what is its lifecycle state". If the module record splits, so do
 * they, and the process starts giving two different answers to that one question.
 *
 * MEASURED 2026-08-08 (P-014 / EI-19899917753028359), the failure this prevents:
 * bg-host pid 1923950 HELD the papercusp corestore write lock (hyperbee/db/LOCK,
 * fd 164uW) while answering `booted: false` for that exact hive on its own
 * /api/internal/substrate/head-snapshot route — same pid, same instant,
 * contradictory answers. One module instance had booted the hive and owned the
 * lock; the route resolved a SECOND instance whose `handles` map was empty.
 *
 * It is a self-sustaining deadlock, not a transient miss: `getBootedHarness`
 * answers null, fires reboot-on-access, and that re-boot can never acquire the
 * corestore lock — because the lock is held by its own twin inside the same
 * process. Five probes over four minutes never recovered. Downstream, the P-019
 * no-outage sparse release cut refuses ("no operator process here reports having
 * booted ..."), so releases silently keep shipping full history.
 *
 * The seam is real and measured, not theoretical: bg-host's own managed-timers
 * route reports `evaluations: 2` for many ALREADY-PINNED modules
 * (`@papercusp/flags.server`, `memory:host`, `lexicon:host`,
 * `deployment-driver:registry`, ...). Those are correct DESPITE the double
 * evaluation precisely because they are pinned. This registry was not, so it was
 * the one that split — the same class as `@papercusp/scheduled-registry`, which
 * reaped every 2 minutes while absent from the timer inventory of its own pid.
 *
 * Pinned as ONE object because these are interdependent: a shared `handles` beside
 * a per-instance `evicted`/`wiringInflight` would just relocate the split-brain.
 *
 * ⚠ RESIDUAL, deliberately not addressed here: the module-scoped `let` scalars in
 * this file (`evictionTrackingEnabled`, `defaultBootHarness`, `rebootOnAccess`,
 * `routingDecisionPending`, `defaultSkipSendSideWiring`,
 * `defaultMergeCursorStoreFactory`) still live per-record — pinning them means
 * rewriting every assignment site, and they are configure-time seams rather than
 * the residency answer. The worst remaining symptom is a missed LRU bump, NOT a
 * hive that reports itself absent while holding its own lock.
 */
const bootRegistry = pinModuleState('@papercusp/operator-core.hyperbeeBootAll', () => ({
  handles: new Map<string, BootedHarnessHandle>(),
  inflight: new Map<string, Promise<BootedHarnessHandle>>(),
  lastAccess: new Map<string, number>(),
  evicted: new Set<string>(),
  deferredActivation: new Set<string>(),
  outboxWired: new Set<string>(),
  presenceWired: new Set<string>(),
  wiringInflight: new Map<string, Promise<void>>(),
}));

// Destructured so every existing access site reads unchanged: these are const
// bindings to MUTABLE containers, so the alias and the pinned object are the same
// object. Do NOT convert any of these to a reassignable `let` — that would silently
// re-privatise it to this module record and reintroduce the split.
const { handles, inflight, lastAccess, evicted, deferredActivation, outboxWired, presenceWired, wiringInflight } =
  bootRegistry;

function key(workspaceId: string, harnessSlug: string): string {
  return `${workspaceId}::${harnessSlug}`;
}

// ── Process-global substrate boot defaults (SUBSTRATE_SIDECAR routing) ────────
//
// THE BUG this closes (shared-hive-member-content-federation): in SUBSTRATE_SIDECAR
// mode the sidecar `bootHarness` factory + `skipSendSideWiring:true` were wired into
// ONLY the single `bootAllHarnessesForActiveWorkspace(...)` call in
// `bootSubstrateWithFallback` (the host-bootstrap sweep) — captured in that closure,
// never stored process-globally. So EVERY STANDALONE boot route — `rekeyHarness` /
// `bootSingleHarness` called by `publishCreatedHive` (owner "go shared"),
// `joinHiveAsView` step 2c (joiner), and `join-shared-harness` (joiner) — silently
// fell back to the IN-PROCESS `bootHarnessSubstrate`, NOT the sidecar. A harness
// created/joined/published AFTER host-bootstrap (the common case — the live owner
// creates the hive+content harness at runtime, so it was never in the registry the
// bootstrap sweep read) therefore booted in the WRONG process: the main operator,
// not the sidecar that owns every corestore. With Corestore's process-level file
// lock that boot can't open the relocated store, so it fails or split-brains; either
// way the sidecar's `ensureRelocatedSendSideWired` (which starts the outbox DRAIN)
// never runs → `substrate_outbox` stays UNDRAINED forever → content captured,
// peer_connected, but federation = 0 (the live cross-machine blocker).
//
// FIX: register the sidecar boot config ONCE process-globally (set by
// `bootSubstrateWithFallback` when the flag is on), so EVERY boot path — the
// bootstrap sweep AND every standalone `rekeyHarness`/`bootSingleHarness` — routes
// through the sidecar consistently. The sidecar then wires the drain in
// `handleBootHarness`/`handleRekey`, under the SAME workspaceId the content is
// captured under. OFF (in-process mode) leaves these null/false ⇒ byte-identical to
// today's in-process boot + in-process send-side wiring.
let defaultBootHarness: ((opts: BootHarnessOpts) => Promise<BootedHarnessHandle>) | null = null;
let defaultSkipSendSideWiring = false;

// WI-3297: durable merge-cursor persistence for the IN-PROCESS boot path. The
// WI-2105 PG-cursor store was constructed ONLY in substrate-sidecar-host, so a
// host whose substrate boots in-process (SUBSTRATE_SIDECAR off — every packaged
// desktop install) passed `mergeCursorStore: null`: positions never persisted
// (harness_shared.substrate_merge_cursor stayed EMPTY) and every process boot
// re-folded every admitted log from index 0 — on a seeded install that is the
// whole 112k-op seed log, replaying its epoch-decrypt-fail storm each boot.
// Installed process-globally by `bootSubstrateWithFallback`'s in-process
// branches (flag-gated THERE, mirroring the sidecar host); tests never install
// it, so `bootHarnessSubstrate` stays PG-free/hermetic by default. A per-call
// `opts.bootHarness` override (tests, sidecar factory) bypasses it entirely.
let defaultMergeCursorStoreFactory: ((workspaceId: string, harnessSlug: string) => MergeCursorStore) | null = null;

// ── Routing-decision latch (WI-2105) ─────────────────────────────────────────
//
// THE RACE this closes (bg-host, 2026-07-03): a caller reached
// `bootSingleHarness` in the window between process start and
// `bootSubstrateWithFallback` installing the defaults above (~75s on bg-host —
// the wrapper waits on migrations + the substrate boot-gate first, while DBOS
// routines are already ticking). With `defaultBootHarness` still null the call
// booted a FULL in-process engine, cached its handle (the later sidecar sweep
// then short-circuited on it: `alreadyBooted=1`), and held the canonical
// corestore lock — leaving TWO concurrent substrate instances for the harness
// (main process + sidecar), each with its own store / own-log / announcer,
// racing the outbox drain and churning peer connections at ~1s: the tower↔VM
// federation outage (WI-2105).
//
// Hosts that will decide routing (host-bootstrap, when it will later run
// `bootSubstrateWithFallback`) arm this latch at process start;
// `bootSingleHarness` then WAITS for the decision instead of silently
// defaulting to in-process. Processes that never arm it (tests, the sidecar
// itself, perf rigs) are byte-identical to before. Bounded: a wedged wrapper
// degrades LOUDLY to today's in-process behavior instead of deadlocking boots.
const SUBSTRATE_ROUTING_WAIT_MS = 300_000;
let routingDecisionPending: Promise<void> | null = null;
let resolveRoutingDecision: (() => void) | null = null;
// A migration-gated host can decide that substrate routing is unavailable
// before `bootSubstrateWithFallback()` ever runs. Keep that decision separate
// from the pending promise: otherwise every standalone boot waits the full
// five-minute timeout and then silently takes the in-process path with no
// durable cursor store (the WI-2144760 failure mode).
let routingDecisionFailure: string | null = null;

/** Arm the routing latch. Call ONLY from a process that will later run
 *  `bootSubstrateWithFallback` (which settles it via setSubstrateBootDefaults),
 *  BEFORE any subsystem that could issue a bootSingleHarness starts. */
export function markSubstrateBootRoutingPending(): void {
  // A failed migration gate is terminal for this boot. Do not let a late
  // dynamic import of the normal pending marker resurrect the latch and put
  // callers back into the five-minute timeout path.
  if (routingDecisionFailure) return;
  if (routingDecisionPending) return;
  routingDecisionPending = new Promise<void>((resolve) => {
    resolveRoutingDecision = resolve;
  });
}

/**
 * Mark substrate routing unavailable for the current host boot.
 *
 * `host-bootstrap` withholds all schema-dependent background machinery when a
 * migration is pending or fails. Any standalone `bootSingleHarness` caller
 * arriving in that window must fail closed immediately; waiting for the
 * timeout and booting in-process would both duplicate a possible sidecar and
 * bypass WI-3297's PG merge-cursor injection.
 */
export function markSubstrateBootRoutingFailed(reason: string): void {
  const detail = reason.trim() || 'substrate routing was not decided because boot migrations did not complete';
  routingDecisionFailure = detail;
  settleSubstrateBootRouting();
}

function settleSubstrateBootRouting(): void {
  resolveRoutingDecision?.();
  resolveRoutingDecision = null;
  routingDecisionPending = null;
}

/**
 * Register the process-global substrate boot defaults. Called once by
 * `bootSubstrateWithFallback`: in SUBSTRATE_SIDECAR mode it installs the remote
 * (sidecar) boot factory + `skipSendSideWiring:true`; the in-process path clears
 * them (passing `{ bootHarness: null, skipSendSideWiring: false }`). Every
 * `bootSingleHarness`/`rekeyHarness` then routes the same way regardless of who
 * called it (the bootstrap sweep, an owner publish, or a joiner). An explicit
 * per-call `opts.bootHarness` / `opts.skipSendSideWiring` still wins.
 */
export function setSubstrateBootDefaults(opts: {
  bootHarness?: ((o: BootHarnessOpts) => Promise<BootedHarnessHandle>) | null;
  skipSendSideWiring?: boolean;
  /** WI-3297: per-(workspace,harness) durable merge-cursor store for IN-PROCESS
   *  boots (null clears). Ignored whenever a bootHarness override is in play —
   *  the sidecar host constructs its own store on its side of the IPC. */
  mergeCursorStoreFactory?: ((workspaceId: string, harnessSlug: string) => MergeCursorStore) | null;
}): void {
  // A later successful routing decision (for example, a retry after the
  // migration is repaired) supersedes the fail-closed marker.
  routingDecisionFailure = null;
  if (opts.bootHarness !== undefined) defaultBootHarness = opts.bootHarness;
  if (opts.skipSendSideWiring !== undefined) defaultSkipSendSideWiring = opts.skipSendSideWiring;
  if (opts.mergeCursorStoreFactory !== undefined) defaultMergeCursorStoreFactory = opts.mergeCursorStoreFactory;
  // Either mode (sidecar factory installed OR cleared-to-in-process) IS the
  // routing decision — release any boots waiting on the WI-2105 latch.
  settleSubstrateBootRouting();
}

/** Test seam: clear the process-global boot defaults. Never call from production. */
export function _resetSubstrateBootDefaultsForTests(): void {
  defaultBootHarness = null;
  defaultSkipSendSideWiring = false;
  defaultMergeCursorStoreFactory = null;
  routingDecisionFailure = null;
  settleSubstrateBootRouting();
}

/** Split a handle-map key back into (workspaceId, harnessSlug). Workspace ids
 *  never contain "::" (they are slugs like `papercusp-workspace` / `default`),
 *  so a split on the FIRST separator is unambiguous. */
function parseKey(k: string): { workspaceId: string; harnessSlug: string } | null {
  const i = k.indexOf('::');
  if (i < 0) return null;
  return { workspaceId: k.slice(0, i), harnessSlug: k.slice(i + 2) };
}

function defaultInProcessBootAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  // Vitest unit coverage injects fake boot factories and should not inherit the
  // live host's machinery gate. Production request-only hosts must never take
  // the default bootHarnessSubstrate path; the bg-host/sidecar is the sole
  // corestore owner.
  if (env.VITEST) return true;
  return backgroundWorkersEnabled(env);
}

// ── LAZY_SUBSTRATE_BOOT (P-008) reaper support ──────────────────────────────
// All inert until `enableSubstrateEvictionTracking()` is called (the reaper is
// started, i.e. the flag is ON). With the flag OFF none of this runs, so boot
// is byte-identical to eager all-harness boot.
//
// `lastAccess` is the LRU + idle signal: bumped on every `getBootedHarness` hit
// (any consumer access) + at boot time. `evicted` records engines the reaper
// tore down so a later `getBootedHarness` for one can fire a background re-boot
// (the lazy-boot "reboot-on-access" dual of eviction).
let evictionTrackingEnabled = false;
// `lastAccess` + `evicted` are pinned in `bootRegistry` at the top of this file.

/**
 * P-010: harnesses the ACTIVATE-ON-DEMAND boot policy deliberately did NOT boot
 * (see substrate-active-set-policy). Functionally identical to `evicted` for the
 * on-demand wake paths — the engine is not resident and any access or captured
 * local write must bring it up — but tracked separately because the two arise
 * differently and the distinction matters when reading logs/telemetry: `evicted`
 * means "was resident, reaped for idleness", `deferredActivation` means "never
 * booted this process".
 *
 * This set is what makes deferral SAFE. Both wake paths (`getBootedHarness` and
 * `handleOutboxNotifyForEvictedHarness`) previously keyed on `evicted` ALONE, so
 * a never-booted harness was invisible to them: its NOTIFY was dropped and its
 * outbox rows would accumulate undrained forever (the EI-126 divergence class).
 * Every membership test on `evicted` in a wake path must also test this set.
 */
// `deferredActivation` is pinned in `bootRegistry` at the top of this file.

/** True when this harness is not resident but IS wake-eligible — either the
 *  reaper evicted it, or the activation policy deferred it at boot. Consuming
 *  the flag CLEARS it: the caller is about to trigger the re-boot, and leaving
 *  it set would let a second caller fire a duplicate boot. */
function takeWakeEligible(k: string): boolean {
  if (evicted.delete(k)) return true;
  return deferredActivation.delete(k);
}

/**
 * P-010: record that the boot sweep deliberately left this harness dark, making
 * it eligible for on-demand wake. No-op unless eviction/lazy tracking is on, so
 * the LAZY_SUBSTRATE_BOOT-OFF path stays byte-identical.
 */
export function markHarnessActivationDeferred(workspaceId: string, harnessSlug: string): void {
  if (!evictionTrackingEnabled) return;
  deferredActivation.add(key(workspaceId, harnessSlug));
}

/** Observability: how many harnesses this process is holding dark on purpose. */
export function deferredActivationCount(): number {
  return deferredActivation.size;
}

/** The reboot-on-access trigger — fires a background re-boot for an evicted
 *  engine on its next access. Default calls `bootSingleHarness` fire-and-forget;
 *  overridable in tests so a unit test never triggers a real corestore boot. */
let rebootOnAccess: (workspaceId: string, harnessSlug: string) => void = (workspaceId, harnessSlug) => {
  void bootSingleHarness(workspaceId, harnessSlug).catch(() => {
    // best-effort re-boot; a failure leaves the harness unbooted (a later
    // boot-all reconcile / access retries it) — never throws into the caller.
  });
};

/** Turn on access tracking + reboot-on-access. Called once when the eviction
 *  reaper starts (LAZY_SUBSTRATE_BOOT on). Idempotent. */
export function enableSubstrateEvictionTracking(): void {
  evictionTrackingEnabled = true;
}

/** Test seam: override the reboot-on-access trigger. Never call from production. */
export function _setRebootOnAccessForTests(fn: (workspaceId: string, harnessSlug: string) => void): void {
  rebootOnAccess = fn;
}

/** Test seam: reset the reaper-support state. Never call from production code. */
export function _resetEvictionTrackingForTests(): void {
  evictionTrackingEnabled = false;
  lastAccess.clear();
  evicted.clear();
  deferredActivation.clear();
}

/**
 * Per-harness "send-side wiring" state (EI-521).
 *
 * After a substrate handle boots, two additive loops must come online: the
 * outbox DRAIN (feature/issue/coord federation send-side) and the presence
 * ANNOUNCE. These were previously wired inline AFTER `handles.set`, in a
 * swallowing try/catch — so a transient wiring failure (e.g. a getOrgPg hiccup
 * during boot) left a CACHED handle whose drain never started, and because the
 * handle was cached, every later `bootSingleHarness` short-circuited to
 * `already-booted` and NEVER re-wired. Symptom: `peer_connected` ✓ but the
 * outbox sits undrained forever (0 drain loops) → a joined hive member's writes
 * never federate to the peer.
 *
 * Fix: wiring is idempotent + RETRYABLE. Each step is marked wired ONLY on
 * success, and `ensureSendSideWired` runs on BOTH the fresh-boot and the
 * already-booted paths, so a failed step self-heals on the next boot pass
 * (boot-all reconcile re-invokes `bootSingleHarness` per registry harness).
 * Concurrent calls coalesce on `wiringInflight` so a step never double-starts
 * (a second drain loop would double-append + double-GC the same outbox).
 */
// `outboxWired`, `presenceWired` + `wiringInflight` are pinned in `bootRegistry`
// at the top of this file.

export interface SendSideWiringDeps {
  /** Default: getOrgPg() + wireOutboxForHarness. Tests inject a fake.
   *  `onSessionClosed` (2nd param) is provided by `ensureSendSideWired` — a
   *  test fake with the old 1-arg shape still type-checks (JS ignores extra
   *  call args; a `void`-returning target accepts a narrower callback). */
  wireOutbox?: (handle: BootedHarnessHandle, onSessionClosed: () => void) => Promise<void>;
  /** Default: wirePresenceAnnounceForHarness. Tests inject a fake. */
  wirePresence?: (handle: BootedHarnessHandle, onSessionClosed: () => void) => Promise<void>;
}

/** Default outbox wiring: resolve the org PG, then wire the drain loop. */
async function defaultWireOutbox(handle: BootedHarnessHandle, onSessionClosed: () => void): Promise<void> {
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  await wireOutboxForHarness(handle, sql, { onSessionClosed });
}

/** Default presence wiring: wirePresenceAnnounceForHarness with the session-closed hook. */
async function defaultWirePresence(handle: BootedHarnessHandle, onSessionClosed: () => void): Promise<void> {
  await wirePresenceAnnounceForHarness(handle, { onSessionClosed });
}

/**
 * WI-3684 send-side twin: un-mark ONE step (outbox|presence) as wired for a
 * harness so the NEXT `ensureSendSideWired` call — the periodic boot-all
 * reconcile pass, or a fresh boot — re-attempts it against whatever handle is
 * current then, instead of the permanently-closed session's drain/announce
 * loop blind-retrying every poll tick forever. This is the send-side
 * counterpart to boot.ts's repair-on-detect (`drainRepairQueue`): react to a
 * dead session by clearing it for re-wire, rather than leaving a zombie loop
 * to keep failing against it. Idempotent — a step that was never marked wired
 * (e.g. a wiring attempt that itself never succeeded) is a silent no-op.
 */
function markSendSideUnwired(
  k: string,
  step: 'outbox' | 'presence',
  reason = `session is SESSION_CLOSED — the next boot pass re-wires a fresh ${step} loop`,
): void {
  const set = step === 'outbox' ? outboxWired : presenceWired;
  const wasWired = set.delete(k);
  if (wasWired) {
    console.error(`[boot-all] un-marking ${step} wiring for ${k} — ${reason}`);
  }
}

/**
 * Bring a booted handle's send-side loops (outbox drain + presence announce)
 * online — idempotently + resiliently. Safe to call repeatedly: each step runs
 * only until it SUCCEEDS, then no-ops. A step failure is LOGGED (never thrown,
 * so it can't block boot) and retried on the next call. Concurrent calls for the
 * same handle coalesce so a step never double-starts.
 *
 * Exported for tests (the retry/idempotence/coalesce contract is the EI-521 fix).
 */
export async function ensureSendSideWired(handle: BootedHarnessHandle, deps: SendSideWiringDeps = {}): Promise<void> {
  const k = key(handle.workspaceId, handle.harnessSlug);
  // EI-21157761175098740: a Hypercore own-log fork permanently closes every
  // session for the current writable core. Re-creating an outbox drain against
  // this SAME cached handle cannot recover it; it only recreates the
  // SESSION_CLOSED → self-stop → re-wire cycle as fast as promises settle
  // (~45-50 times/sec in the measured incident). The fork guard is a latch,
  // cleared only after the supported store-reset recovery, so make it the
  // cross-loop circuit breaker: presence may stay wired, but the outbox step
  // remains explicitly unwired until recovery clears the latch and reboots.
  const forkState = getOwnLogForkState(handle.workspaceId, handle.harnessSlug);
  if (forkState.forked) {
    markSendSideUnwired(
      k,
      'outbox',
      `own-log fork ${forkState.keyHex?.slice(0, 12) ?? 'unknown'}… is latched — ` +
        `refusing to re-wire the closed session until store-reset recovery clears the latch`,
    );
  }
  if (outboxWired.has(k) && presenceWired.has(k)) return;
  const existing = wiringInflight.get(k);
  if (existing) return existing;

  const wireOutbox = deps.wireOutbox ?? defaultWireOutbox;
  const wirePresence = deps.wirePresence ?? defaultWirePresence;

  // EI-13917: unmark-only (the pre-existing behavior) leaves a step un-wired
  // until SOME unrelated future trigger happens to call `ensureSendSideWired`
  // again for this exact harness — which may be arbitrarily delayed (or, for a
  // harness with no other natural boot-all trigger, may not happen again for a
  // long time). Immediately re-attempt wiring against a FRESH handle/client
  // right after unmarking, mirroring the existing `onSwarmJoinRecovered`
  // re-wire pattern in `bootSingleHarness` below. Fire-and-forget + best-effort
  // (the caller is a failed loop's own self-stop callback — it must never
  // throw or block on this). A no-op if `handle` was since evicted (`h` null)
  // or already re-wired by the time this runs.
  const rewireSoon = (step: 'outbox' | 'presence', reason?: string): void => {
    const currentFork = step === 'outbox' ? getOwnLogForkState(handle.workspaceId, handle.harnessSlug) : null;
    const forkBlocked = currentFork?.forked === true;
    markSendSideUnwired(
      k,
      step,
      reason ??
        (forkBlocked
          ? `own-log fork ${currentFork?.keyHex?.slice(0, 12) ?? 'unknown'}… is latched — ` +
            `refusing to re-wire the closed session until store-reset recovery clears the latch`
          : undefined),
    );
    // The explicit recovery path clears the fork latch only after retiring the
    // damaged store. Its subsequent reboot/boot-all pass is the safe re-wire
    // trigger; recursively wiring this cached handle is precisely the hot loop.
    if (forkBlocked) return;
    const h = handles.get(k);
    if (h) void ensureSendSideWired(h, deps).catch(() => {});
  };

  const run = (async () => {
    // (1) Outbox drain — the critical federation send-side (EI-521). Best-effort
    //     so a failure never blocks boot, but RETRYABLE: only marked wired on
    //     success, so the next boot pass re-attempts it. WI-3684: also passed an
    //     `onSessionClosed` hook — fired by the drain loop itself if it later
    //     self-stops on a permanently closed own-log session (or, EI-13917, a
    //     permanently CONNECTION_ENDED PG client) — `rewireSoon` un-marks AND
    //     immediately re-attempts, so THIS successful wiring doesn't stay
    //     silently dead until some unrelated trigger happens to reconcile it.
    if (!outboxWired.has(k) && !getOwnLogForkState(handle.workspaceId, handle.harnessSlug).forked) {
      try {
        await wireOutbox(handle, () => rewireSoon('outbox'));
        outboxWired.add(k);
      } catch (e) {
        console.error(
          `[boot-all] outbox wiring failed for ${k} (boot still succeeded; ` + `will retry on the next boot pass):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    // (2) Presence announce — additive (the per-Hive lock authority, P-009,
    //     elects over the live roster). Same retryable best-effort posture (+ the
    //     same WI-3684/EI-13917 rewireSoon hook); a no-op for a private/unswarmed
    //     harness (handle.swarm null).
    if (!presenceWired.has(k)) {
      try {
        await wirePresence(handle, () => rewireSoon('presence'));
        presenceWired.add(k);
      } catch (e) {
        console.error(
          `[boot-all] presence wiring failed for ${k} (boot still succeeded; ` + `will retry on the next boot pass):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  })();
  wiringInflight.set(k, run);
  try {
    await run;
  } finally {
    wiringInflight.delete(k);
  }
}

/**
 * Resolve the workspace root on disk for a given workspaceId. Mirrors
 * `apps/operator/lib/papercusp-root.ts` resolution but stops one level
 * above `.papercusp/` so the substrate (which appends `.papercusp/...`)
 * lands in the right place.
 *
 * Exported so a caller that must address a harness's on-disk store
 * (dev:own_log_fork_recover) resolves it exactly the way every boot does.
 */
export function workspaceRootForId(workspaceId: string): string {
  return join(workspacesRoot(), workspaceId);
}

/**
 * Is a registry entry a BOOTABLE substrate harness?
 *
 * Two independent bootability signals — a row is bootable if EITHER holds:
 *
 *  (1) PATH-LIVENESS — its project `path` is a LIVE on-disk CODE checkout.
 *      A code harness's substrate needs its checkout, and registry debris
 *      with deleted paths is real at scale (live DB 2026-06-10: 73 of 99
 *      entries dead — 72 from a test-clone workspace); booting those ghosts
 *      re-creates the EI-125 thundering herd. This is the original filter.
 *
 *  (2) HIVE HARNESS — `harness_kind:'hive'` (an owned home OR a joined
 *      `remote_hive` VIEW). A Hive home is repo-LESS: its `path` is the Hive's
 *      gist/PG-backed STATE dir, NOT a code checkout (see
 *      `resolveHarnessContentPath`), so an ABSENT dir is NORMAL, not debris,
 *      and MUST NOT gate boot. THIS IS THE D-057 LIVE BLOCKER: the SWARM-JOIN
 *      source of truth (`resolveHiveSwarmBinding`) federates a Hive home — an
 *      owned home unconditionally, a joined `remote_hive` view on the owner's
 *      Hive-pubkey topic — but the SUBSTRATE-BOOT enumeration here filtered the
 *      joined view out via `existsSync(path)` (its gist-backed
 *      `~/.papercusp/remote-hives/<slug>` dir need not exist on the spawned
 *      sidecar / cloud frame), so the joined-hive substrate NEVER BOOTED →
 *      no outbox drain wired → no send + no merge/apply → every cross-machine
 *      content/coord probe = 0. The two sources of truth diverged: the join
 *      put the peer on the Hive topic, but the boot enumeration omitted the
 *      Hive. Booting it is SAFE without the dir — the substrate store is
 *      WORKSPACE-rooted (`bootHarnessSubstrate` uses `workspaceRoot`+slug, not
 *      `p.path`) and the Hive identity lives in PG, not on disk. Hives are FEW
 *      (≪ the code-clone debris the path filter targets), so this does not
 *      re-open the thundering herd; a dissolved Hive removes its registry row.
 */
function isBootableHarnessEntry(p: ProjectEntry): boolean {
  if (p.path && existsSync(p.path)) return true;
  // A gist/PG-backed Hive home (owned OR a joined remote_hive view) boots
  // without a code checkout — align with the swarm-join hive-identity source of
  // truth so a joined hive's substrate actually boots + drains (D-057).
  if (p.harness_kind === 'hive') return true;
  return false;
}

/**
 * Harness slugs for a workspace — from the PG registry (audit P-078).
 * `harness_shared.harness_registry` (loadHarnessRegistry, mig 025) is the
 * single source of truth; the old `readdirSync('.papercusp/harnesses')`
 * returned [] on ANY error, silently booting zero harnesses when the dir
 * was stale/missing. PG failures here are LOUD: they throw to the per-
 * workspace catch in `bootAllHarnessesForActiveWorkspace`.
 *
 * Liveness gate via `isBootableHarnessEntry` (see there): a live on-disk code
 * checkout OR a gist/PG-backed Hive harness (the D-057 joined-hive fix). Skips
 * are logged once per boot pass; the durable cleanup belongs in the registry.
 */
async function harnessSlugsFromPgRegistry(workspaceId: string): Promise<string[]> {
  const { loadHarnessRegistry } = await import('../../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  const live: string[] = [];
  const dead: string[] = [];
  for (const p of reg.projects) {
    if (isBootableHarnessEntry(p)) live.push(p.slug);
    else dead.push(p.slug);
  }
  if (dead.length > 0) {
    console.warn(
      `[boot-all] workspace '${workspaceId}': skipping ${dead.length} registry ` +
        `entr${dead.length === 1 ? 'y' : 'ies'} with missing project path ` +
        `(stale registry debris): ${dead.slice(0, 5).join(', ')}${dead.length > 5 ? ', …' : ''}`,
    );
  }
  return live;
}

export interface BootSingleResult {
  workspaceId: string;
  harnessSlug: string;
  state: 'booted' | 'already-booted' | 'failed' | 'deferred';
  error?: string;
  /** Present on `state:'deferred'` — why the activation policy left it dark. */
  deferReason?: 'inactive';
}

export interface BootAllOpts {
  /** Override workspace list. Default: every workspace with a
   *  `harness_shared.harness_registry` row (PG — audit P-078). */
  workspaceIds?: string[];
  /** Per-harness boot timeout. Default 30s. */
  perHarnessTimeoutMs?: number;
  /**
   * Max harnesses whose substrate boot runs CONCURRENTLY. Default 4
   * (env `PAPERCUSP_SUBSTRATE_BOOT_CONCURRENCY` overrides). A joiner with
   * many remote-hive members otherwise booted ALL substrates at once via an
   * unbounded `Promise.all`, saturating a shared boot resource (hyperswarm /
   * DHT join) so EVERY substrate — local ones included — exceeded the 30s
   * `perHarnessTimeoutMs` and the node booted ZERO (witnessed live on the
   * fed-rig 2026-06-25: 11 concurrent → all timed out; 2 → booted in 5.5s).
   * Bounding concurrency lets them boot in batches. WI-779.
   */
  bootConcurrency?: number;
  /**
   * Override per-workspace harness discovery (tests inject; unit tests must
   * not touch PG). Default: the PG registry via `loadHarnessRegistry`.
   */
  discoverHarnessSlugs?: (workspaceId: string) => Promise<string[]>;
  /**
   * P-010: override the activation-fact probe (tests inject; unit tests must not
   * touch PG). Default reads undrained `substrate_outbox` counts + recent
   * `shared_presence` in two grouped queries.
   */
  activationFactDeps?: import('./substrate-active-set-facts').ActivationFactDeps;
  /** P-010: presence newer than this counts as live activity. Default 15m. */
  activationPresenceWindowMs?: number;
  /**
   * P-010/P-012 SAFETY INTERLOCK — allow deferring harnesses that FEDERATE
   * (Hive home or member). P-012's always-on remote wake keepalive now covers
   * each dark federation topic before deferral, so production defaults this to
   * true. Pass false only as a fail-safe rollback to keep every federating
   * harness eager.
   */
  deferFederatingHarnesses?: boolean;
  /**
   * Override the swarm-binding resolver. Default reads
   * `.papercusp/shared.json` via `resolveHarnessPaths` and returns
   * `{ kind: 'gh', github_repository_id }` when present. Tests
   * inject a synchronous fake.
   */
  resolveSwarmBinding?: SwarmBindingResolver;
  /** Override per-harness boot (sidecar cutover + tests). Default: in-process bootHarnessSubstrate. */
  bootHarness?: (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>;
  /** Remote handles are wired in their owning process; skip main-process send-side loops. */
  skipSendSideWiring?: boolean;
}

/**
 * Given (workspaceId, harnessSlug) decide whether the substrate
 * should join a Hyperswarm topic at boot.
 *
 *   - `null` / `undefined` → private harness, skip swarm join.
 *   - `SwarmBinding` → boot joins the derived 32-byte topic.
 *
 * Async so the default resolver can hit PG via `resolveHarnessPaths`
 * for the project directory.
 */
export type SwarmBindingResolver = (
  workspaceId: string,
  harnessSlug: string,
) => Promise<SwarmBinding | null | undefined>;

export interface BootAllResult {
  attempted: number;
  booted: number;
  alreadyBooted: number;
  failed: number;
  /** P-010: harnesses the activation policy deliberately left dark this sweep.
   *  They are NOT failures — each is wake-eligible on access / captured write. */
  deferred: number;
  results: BootSingleResult[];
}

/** Resolve the cached handle for (workspace, harness). */
export function getBootedHarness(workspaceId: string, harnessSlug: string): BootedHarnessHandle | null {
  const k = key(workspaceId, harnessSlug);
  const handle = handles.get(k) ?? null;
  if (handle) {
    // LRU/idle signal (P-008): any consumer access marks the harness HOT, so the
    // reaper won't evict an engine something is actively using. No-op when the
    // reaper is off — keeps the OFF path byte-identical.
    if (evictionTrackingEnabled) lastAccess.set(k, Date.now());
    return handle;
  }
  // Reboot-on-access (P-008): if the reaper evicted this engine, bring it back in
  // the BACKGROUND so the next access finds it resident. This access still gets
  // null (the consumer's null-handling is graceful — feature-queue returns
  // `substrate-off`, claims fall back to legacy — never data loss). bootSingleHarness
  // coalesces on `inflight`, so a burst of accesses triggers a single re-boot.
  // P-010: `takeWakeEligible` covers BOTH "the reaper evicted it" and "the
  // activation policy never booted it", so a deferred harness wakes on access
  // exactly like an evicted one.
  if (evictionTrackingEnabled && takeWakeEligible(k)) {
    rebootOnAccess(workspaceId, harnessSlug);
  }
  return null;
}

/**
 * Default swarm-binding resolver. Precedence:
 *   1. shared-hive-federation P-004 — if the harness is a Hive HOME, or a
 *      member of a shared/joined Hive, federate over the Hive PUBKEY topic
 *      (`resolveHiveSwarmBinding` → `{ kind: 'hive', hive_pubkey }`). This is the
 *      federation re-key: the Hive id, not the harness slug, is the topic key.
 *   2. else read `.papercusp/shared.json` (PG-canonical via `resolveHarnessPaths`)
 *      and return a `gh:<repository_id>` binding when present.
 *   2a. WI-275 EXCEPTION: a harness that IS a Hive member (per
 *       `potHomeSlugForHarness`) but whose Hive binding above came back null for
 *       some OTHER reason than "not a member" — an unresolvable/un-backfilled Hive
 *       identity — and whose shared.json has no explicit topic either, must NOT
 *       fall through to the gh-repo topic: that derives a DIFFERENT topic than the
 *       owner's `hive:<pubkey>` topic, silently splitting the member onto the wrong
 *       swarm (the join-vs-owner topic-split footgun). Stay LOCAL (null) + warn
 *       instead. A malformed-but-PRESENT topic still falls through to gh below
 *       unchanged (existing "never strand the joiner" recovery path) — this
 *       exception is scoped to a topic that is entirely ABSENT.
 *   3. else `null` (private / local-only — no swarm join).
 * Errors swallow to `null` so a missing/corrupt config never blocks the boot loop.
 */
export async function defaultResolveSwarmBinding(
  workspaceId: string,
  harnessSlug: string,
): Promise<SwarmBinding | null> {
  try {
    // (1) A Hive-home harness (plus shared/joined member harnesses) federates over
    // the Hive pubkey topic, replacing the per-harness gh/local topic (D-001/D-003).
    // A non-hive or local-only member harness returns null here and falls through
    // to the gh-binding path unchanged.
    const { resolveHiveSwarmBinding, potHomeSlugForHarness } = await import('../../hive-federation');
    const hiveBinding = await resolveHiveSwarmBinding(workspaceId, harnessSlug);
    if (hiveBinding) return hiveBinding;

    // (2) A committed shared.json. PREFER the EXPLICIT topic it carries: a
    // joiner learns a Hive's topic from its member/invite link (persisted here
    // by join-shared-harness) but NOT the Hive's pubkey, so it cannot rebuild a
    // `hive:` binding. Re-deriving a `gh:<repo_id>` topic would split the joiner
    // onto a DIFFERENT topic than the owner's `hive:<pubkey>` topic — the
    // join-vs-owner topic-split bug where the initial join-handshake merge lands
    // but no incremental write ever crosses. Honoring the stored topic lands the
    // joiner on the owner's EXACT topic. For a plain shared harness this is just
    // the gh-repo topic (== what gh:<repo_id> derives), so no behavior change.
    const { resolveHarnessPaths } = await import('../../resolve-harness-paths');
    const { projectDir } = await resolveHarnessPaths(harnessSlug, workspaceId);
    if (projectDir.startsWith('/tmp/papercusp-unresolved/')) return null;
    const cfg = loadSharedConfigFromProjectDir(projectDir);
    if (!cfg) return null;
    if (cfg.topic && /^[0-9a-f]{64}$/i.test(cfg.topic)) {
      return { kind: 'topic', topic_hex: cfg.topic };
    }

    // (2a) WI-275: no usable topic in shared.json — before falling to the gh-repo
    // topic, confirm this ISN'T a Hive member whose binding just failed to resolve.
    // `potHomeSlugForHarness` answers pure membership (registry `hive_slug` / a
    // `kind:'hive'` home), independent of WHY `resolveHiveSwarmBinding` returned
    // null above (unresolvable identity, un-backfilled, or private/unpublished all
    // land here) — in every one of those cases gh-splitting a real member is wrong,
    // so treat "is a member" as the gate, not "why the hive lookup failed".
    if (!cfg.topic) {
      const potHomeSlug = await potHomeSlugForHarness(workspaceId, harnessSlug);
      if (potHomeSlug) {
        console.warn(
          `[boot-all] harness '${harnessSlug}' is a Hive member (home '${potHomeSlug}') but its ` +
            'Hive binding is unresolvable and shared.json has no stored topic — staying LOCAL ' +
            'instead of falling back to the gh-repo topic (would silently split it off the ' +
            "Hive's topic). WI-275.",
        );
        return null;
      }
    }

    return { kind: 'gh', github_repository_id: cfg.github_repository_id };
  } catch {
    return null;
  }
}

/** Boot a single (workspace, harness). Idempotent; safe to race. */
export async function bootSingleHarness(
  workspaceId: string,
  harnessSlug: string,
  opts: {
    workspaceRoot?: string;
    timeoutMs?: number;
    resolveSwarmBinding?: SwarmBindingResolver;
    /** Test seam — override the send-side wiring fns (default: getOrgPg + the
     *  real wireOutboxForHarness / wirePresenceAnnounceForHarness). */
    wireSendSide?: SendSideWiringDeps;
    /** Override the boot factory. Default: in-process bootHarnessSubstrate. */
    bootHarness?: (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>;
    /** Remote handles are wired in their owning process; skip main-process send-side loops. */
    skipSendSideWiring?: boolean;
    /** Override the replication-liveness stall grace (ms) for the
     *  no_replicator/frozen axes (+ the legacy checkReplicationStall). Default:
     *  bootHarnessSubstrate's own DEFAULT_REPLICATION_STALL_GRACE_MS (180s). */
    replicationStallGraceMs?: number;
    /** WI-5686: override the connected_never_replicated (zombie-socket) axis's
     *  OWN grace (ms), separate from `replicationStallGraceMs`. Default: env
     *  PAPERCUSP_REPLICATION_STALL_GRACE_MS if set, else `replicationStallGraceMs`
     *  (which itself falls back to the 180s production default). */
    connectedNeverReplicatedGraceMs?: number;
    /** WI-38376: override the `frozen` axis's OWN grace (ms), separate from
     *  `replicationStallGraceMs`. Default: env
     *  PAPERCUSP_REPLICATION_FROZEN_GRACE_MS if set, else `replicationStallGraceMs`
     *  (which itself falls back to the 180s production default). */
    frozenGraceMs?: number;
  } = {},
): Promise<BootSingleResult> {
  const k = key(workspaceId, harnessSlug);
  let routingTimedOut = false;
  // A failed migration gate is an explicit routing decision, not an invitation
  // to wait out SUBSTRATE_ROUTING_WAIT_MS. The host has withheld the
  // schema-dependent background plane; starting a local engine here could
  // duplicate a sidecar and would run without the durable cursor contract.
  if (!opts.bootHarness && routingDecisionFailure) {
    return {
      workspaceId,
      harnessSlug,
      state: 'failed',
      error: `substrate routing unavailable: ${routingDecisionFailure}`,
    };
  }
  // WI-2105: a boot arriving before this process's substrate routing is decided
  // (host-bootstrap armed the latch; bootSubstrateWithFallback hasn't installed
  // the defaults yet) WAITS — defaulting to in-process here is exactly the
  // duplicate-engine race. Explicit per-call factories (the sweep) skip the wait.
  if (!opts.bootHarness && routingDecisionPending) {
    const outcome = await Promise.race([
      routingDecisionPending.then(() => 'decided' as const),
      new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), SUBSTRATE_ROUTING_WAIT_MS);
        t.unref?.();
      }),
    ]);
    if (outcome === 'timeout') {
      routingTimedOut = true;
      console.error(
        `[boot-all] substrate routing still undecided after ${SUBSTRATE_ROUTING_WAIT_MS}ms — ` +
          `booting ${k} IN-PROCESS (duplicate-engine risk; check bootSubstrateWithFallback)`,
      );
    }
  }
  // The failure can be published while the caller was waiting on the latch.
  // Re-check after the await so a migration error cannot fall through to the
  // timeout fallback merely because this call started a few milliseconds
  // earlier than the failure notification.
  if (!opts.bootHarness && routingDecisionFailure) {
    return {
      workspaceId,
      harnessSlug,
      state: 'failed',
      error: `substrate routing unavailable: ${routingDecisionFailure}`,
    };
  }
  // SUBSTRATE_SIDECAR routing: an explicit per-call opt wins; else the process-global
  // default (set by bootSubstrateWithFallback). In sidecar mode this is the remote
  // factory + skipSendSideWiring:true so a standalone publish/join boots through the
  // sidecar (which wires the drain), never in-process.
  if (!opts.bootHarness && !defaultBootHarness && !defaultInProcessBootAllowed()) {
    return {
      workspaceId,
      harnessSlug,
      state: 'failed',
      error:
        'substrate default boot disabled on request-only host (PAPERCUSP_BACKGROUND_WORKERS=0 / :3170); bg-host owns corestore',
    };
  }
  const bootHarness = opts.bootHarness ?? defaultBootHarness ?? bootHarnessSubstrate;
  const skipSendSideWiring = opts.skipSendSideWiring ?? defaultSkipSendSideWiring;
  const cached = handles.get(k);
  if (cached) {
    // EI-521: re-attempt any send-side wiring that hasn't yet succeeded. A prior
    // boot may have cached the handle but failed to wire the drain (which would
    // otherwise stay broken until restart, since this path short-circuits). No-op
    // once both steps are wired. SKIPPED in sidecar mode (the sidecar wires the
    // drain; re-wiring here would double-append the outbox).
    if (!skipSendSideWiring) await ensureSendSideWired(cached, opts.wireSendSide);
    return {
      workspaceId,
      harnessSlug,
      state: 'already-booted',
    };
  }
  const existing = inflight.get(k);
  if (existing) {
    try {
      await existing;
      return {
        workspaceId,
        harnessSlug,
        state: 'already-booted',
      };
    } catch (e) {
      return {
        workspaceId,
        harnessSlug,
        state: 'failed',
        error: (e as Error)?.message ?? String(e),
      };
    }
  }
  const workspaceRoot = opts.workspaceRoot ?? workspaceRootForId(workspaceId);
  // WI-1892/P-059: 30s is routinely too short under a 35-substrate boot storm
  // (RocksDB open + merge catch-up + swarm join contend for I/O), and a timed-out
  // boot is NOT unwound — the detached bootHarness keeps running, holding the
  // corestore lock + the joined swarm topic with NO registered handle, so the
  // send-side drain is never wired and peers see a zombie endpoint that answers
  // announces but never replicates/drains (2026-07-03: 16/35 harnesses on bg-host,
  // incl. papercusp-workspace::papercusp — the P-059 outage). Until timeout
  // CANCELLATION is implemented, make the budget operator-tunable.
  const envBootTimeout = Number(process.env.PAPERCUSP_SUBSTRATE_BOOT_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envBootTimeout) && envBootTimeout > 0 ? envBootTimeout : 30_000);
  // EI-13317/WI-5481 rig-isolation follow-up: the connected_never_replicated
  // (zombie-socket) DETECTION grace (replication-liveness.ts's
  // DEFAULT_LIVENESS_GRACE_MS) defaults to 180s — structurally larger than
  // replication_soak's 90s SLA, so whenever the zombie path actually triggers
  // during a kill/restart cycle the soak fails by construction, REGARDLESS of
  // how promptly EI-13317's forced-rejoin escalation fires afterward
  // (live-evidenced: gate run 20260720-054709, cycles 3/4 both legs FAIL,
  // "204s"/"217s connected-but-dead" before the episode even fires — the
  // escalation itself is prompt, the DETECTION isn't). Same operator-tunable
  // pattern as the WI-1892 boot timeout above: env-only override, PRODUCTION
  // DEFAULT UNCHANGED (180s) unless explicitly set — this exists so the local
  // rig (bin/local-matrix.sh) can test a shorter grace without touching the
  // production constant.
  //
  // WI-5686: this env var feeds ONLY the zombie axis's OWN grace
  // (`connectedNeverReplicatedGraceMs`), never the general
  // `replicationStallGraceMs` (no_replicator/frozen + the legacy
  // checkReplicationStall). It used to feed the SHARED `replicationStallGraceMs`
  // directly — which, since sampleReplicationLiveness/getReplicationLiveness
  // apply one grace value to ALL THREE axes, silently collapsed no_replicator's
  // and frozen's grace to the same ~15s the rig sets for the zombie axis. A
  // cold-restart+re-peer cycle legitimately holds 0 peers well past 15s while
  // perfectly healthy, so every ordinary restart cycle false-fired
  // no_replicator — which ALSO triggers repair-on-detect's disruptive session
  // close+reopen — discovered as the WI-5672/WI-5686 false-positive class
  // (content_bidir/planpart_bidir/coord_bidir/concurrent_lww probe=0 failures
  // and replication_soak's own detector-noise assert, both traced to this same
  // rig launch config). `replicationStallGraceMs` now ALWAYS stays at its own
  // default (180s) unless a caller passes it explicitly.
  const envGraceMs = Number(process.env.PAPERCUSP_REPLICATION_STALL_GRACE_MS);
  const replicationStallGraceMs = opts.replicationStallGraceMs;
  const connectedNeverReplicatedGraceMs =
    opts.connectedNeverReplicatedGraceMs ?? (Number.isFinite(envGraceMs) && envGraceMs > 0 ? envGraceMs : undefined);
  // WI-38376: the frozen axis gets its own env knob for the same reason the
  // zombie axis got one above — with the difference that shortening THIS one
  // is safe against the WI-5672/WI-5686 false-positive class. That class came
  // from a cold restart legitimately holding 0 peers past a short grace;
  // `frozen` requires peersCount > 0 AND a writer-ahead position AND zero
  // merge progress, so a 0-peer re-peer window cannot arm it at all.
  //
  // Why a SEPARATE var rather than reusing PAPERCUSP_REPLICATION_STALL_GRACE_MS:
  // that one must keep meaning "zombie axis only" — the rig sets it to 15s and
  // widening its reach to `frozen` would be a behavior change to every existing
  // rig config. PRODUCTION DEFAULT UNCHANGED (180s) unless explicitly set.
  const envFrozenGraceMs = Number(process.env.PAPERCUSP_REPLICATION_FROZEN_GRACE_MS);
  const frozenGraceMs =
    opts.frozenGraceMs ?? (Number.isFinite(envFrozenGraceMs) && envFrozenGraceMs > 0 ? envFrozenGraceMs : undefined);
  const resolver = opts.resolveSwarmBinding ?? defaultResolveSwarmBinding;
  // If the routing latch itself timed out, this is the documented last-resort
  // in-process path. Preserve WI-3297's restart durability there as well: the
  // normal wrapper could not install its process-global factory because it was
  // the component that failed to reach this decision point. The factory is
  // only used for the timeout fallback and remains opt-out when a caller has
  // explicitly installed a different factory.
  // WI-1892: keep a reference to the RAW boot promise (not the raced one) so a
  // boot that outlives the timeout can be ADOPTED instead of zombified — see the
  // catch below. Without this, the detached boot keeps the corestore lock + the
  // joined swarm topic forever with NO registered handle: peers connect and
  // exchange announces with a substrate that can never drain or merge.
  let rawBoot: Promise<BootedHarnessHandle> | null = null;
  const bootPromise = (async () => {
    const swarmBinding = (await resolver(workspaceId, harnessSlug)) ?? null;
    // WI-3297: durable merge-cursor for the DEFAULT in-process engine only. An
    // explicit override or an installed sidecar factory builds/owns its own
    // (or deliberately goes without — tests), so it is never injected there.
    const mergeCursorStoreFactory =
      defaultMergeCursorStoreFactory ?? (routingTimedOut ? createPgMergeCursorStore : null);
    const mergeCursorStore =
      bootHarness === bootHarnessSubstrate && mergeCursorStoreFactory
        ? mergeCursorStoreFactory(workspaceId, harnessSlug)
        : undefined;
    rawBoot = bootHarness({
      workspaceRoot,
      workspaceId,
      harnessSlug,
      swarmBinding,
      mergeCursorStore,
      replicationStallGraceMs,
      connectedNeverReplicatedGraceMs,
      frozenGraceMs,
      // WI-752 late-join re-wire: the presence step no-ops against a swarm-less
      // handle and is then marked wired, so a join that only succeeds via the
      // retry left presence-gossip dead for the process lifetime (tower bg-host,
      // 2026-07-17). Un-mark JUST presence (outbox never needs the swarm and a
      // re-wire there could double-arm its drain loop) and re-attempt against
      // the registered handle, which now sees the live swarm.
      onSwarmJoinRecovered: () => {
        markSendSideUnwired(
          k,
          'presence',
          'swarm join recovered after boot (WI-752 retry) — re-wiring presence against the live swarm',
        );
        const h = handles.get(k);
        if (h && !skipSendSideWiring) {
          void ensureSendSideWired(h, opts.wireSendSide).catch(() => {});
        }
      },
    });
    return await Promise.race([
      rawBoot,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`boot timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  })();
  inflight.set(k, bootPromise);
  try {
    const handle = await bootPromise;
    handles.set(k, handle);
    // P-008: a freshly-booted engine is HOT (seed its access time) and is no
    // longer "evicted". No-op when the reaper is off.
    if (evictionTrackingEnabled) {
      lastAccess.set(k, Date.now());
      evicted.delete(k);
      // P-010: it is no longer being held dark on purpose either. Without this,
      // a deferred harness that later boots normally stays in the set forever
      // and `deferredActivationCount()` over-reports how much of the fleet is
      // actually dark — the observability signal the whole activate-on-demand
      // rollout is judged by.
      deferredActivation.delete(k);
    }
    // P-012 slice B: the engine is resident, so its OWN swarm join now covers
    // the topic (with the corestore replication the keepalive deliberately does
    // not hold). Drop the lightweight keepalive. Fire-and-forget + best-effort:
    // a keepalive we fail to release is harmless (its frames find a resident
    // engine and are dropped by the residency gate), so it must never delay or
    // fail a boot.
    void disarmSubstrateWakeKeepalive(workspaceId, harnessSlug).catch(() => {});
    // Stage 5 (feature-content federation): bring the send-side online — the
    // one-time backfill + outbox drain loop, plus the P-008 presence-announce
    // loop. Both are additive + best-effort (a failure must NEVER block the boot
    // result; PG-direct still works) AND retryable: `ensureSendSideWired` marks
    // each step wired only on success, so a transient failure self-heals on the
    // next boot pass rather than leaving this cached handle drainless forever
    // (EI-521). The drain/presence stoppers register close-hooks on the handle,
    // so closeBootedHarness/closeAllBootedHarnesses tear them down automatically.
    // SKIPPED in sidecar mode (skipSendSideWiring) — the sidecar wires the drain.
    if (!skipSendSideWiring) await ensureSendSideWired(handle, opts.wireSendSide);
    return { workspaceId, harnessSlug, state: 'booted' };
  } catch (e) {
    const errMsg = (e as Error)?.message ?? String(e);
    // WI-1892 (zombie-substrate guard): the race timed out but the REAL boot is
    // still running detached — holding the corestore lock and (once it gets
    // there) the joined swarm topic. When it eventually settles, ADOPT a success
    // (register the handle + wire the send-side, exactly as the happy path
    // would) unless a newer boot got there first — in which case close the late
    // one so it releases the corestore instead of squatting. A late FAILURE
    // needs no action (bootHarnessSubstrate unwinds its own partial state).
    // (assertion: TS's CFA ignores the closure assignment at :628 and narrows
    // `rawBoot` to null here, typing the guarded promise as `never`)
    const lateBoot = rawBoot as Promise<BootedHarnessHandle> | null;
    if (lateBoot && errMsg.startsWith('boot timeout')) {
      // EI-13317/EI-13521 re-entrancy fix: the `finally` below used to delete
      // this harness's `inflight` reservation the INSTANT the artificial
      // timeout won the race — before the real boot (lateBoot) had settled.
      // Any OTHER caller for the same (workspaceId, harnessSlug) landing in
      // that zombie window saw neither `handles` nor `inflight` and launched a
      // SECOND, independent `bootHarness()` call for the SAME corestore —
      // contending for the same lock/I/O and making ITS OWN boot more likely to
      // also blow its timeout budget. Under real contention this is a
      // self-reinforcing pile-up: repeated competing boots, each one resetting
      // the per-boot repair-ladder closures (checkReplicationStall /
      // repairAttempts in boot.ts) back to zero, which is why the
      // forceRejoin/rung(a,b) escalation could never accumulate enough strikes
      // to fire (root-caused live on gate run 174333: the same log key fired
      // "repair-on-detect ... attempt 1/3" twice, never progressing).
      //
      // Fix: re-point `inflight[k]` at the REAL boot (lateBoot) instead of
      // deleting it. A re-entrant caller's `inflight.get(k)` (above, at the
      // top of this function) now finds `lateBoot` and attaches to — awaits —
      // the SAME pending real boot, getting its late-adopt outcome, instead of
      // starting a competing one. The caller-facing contract is unchanged:
      // THIS call still returns the 30s timeout failure immediately below;
      // only the dedup bookkeeping moves to track the real boot's lifecycle.
      inflight.set(k, lateBoot);

      console.info(
        `[hyperbee-substrate] (${k}) zombie window entered after '${errMsg}' — ` +
          'a re-entrant caller for this harness will attach to the in-flight real boot instead of racing a new one',
      );
      void lateBoot
        .then(async (handle) => {
          // `inflight` is now guaranteed to be pointing at THIS lateBoot (no
          // other path can replace it while it's pending — a re-entrant call
          // attaches via the `existing` branch above rather than starting a
          // fresh boot), so `handles.has(k)` is the only remaining supersession
          // signal: something OUTSIDE this function (e.g. a direct
          // `_setHandleForTests`, or a future out-of-band caller) claimed the
          // slot first.
          if (!handles.has(k)) {
            handles.set(k, handle);
            if (evictionTrackingEnabled) {
              lastAccess.set(k, Date.now());
              evicted.delete(k);
            }

            console.info(
              `[hyperbee-substrate] (${k}) late boot ADOPTED after '${errMsg}' — registering handle + wiring send-side`,
            );
            if (!skipSendSideWiring) await ensureSendSideWired(handle, opts.wireSendSide);
          } else {
            console.info(
              `[hyperbee-substrate] (${k}) late boot superseded by a newer boot — closing it to release the corestore`,
            );
            await (handle as { close?: () => Promise<void> }).close?.();
          }
        })
        .catch(() => {
          // late failure — bootHarnessSubstrate's own cleanup applies
        })
        .finally(() => {
          // Leak guard (design constraint): only clear OUR OWN reservation —
          // if something newer already replaced it, that owns its own cleanup.
          // `lateBoot` (a normal awaited bootHarness() call) is guaranteed to
          // settle, so this `finally` always eventually runs — the harness
          // never wedges permanently reserved.
          if (inflight.get(k) === lateBoot) inflight.delete(k);
        });
    }
    return {
      workspaceId,
      harnessSlug,
      state: 'failed',
      error: errMsg,
    };
  } finally {
    // Only delete OUR OWN reservation — the timeout branch above may already
    // have re-pointed `inflight[k]` at the real boot (lateBoot); in that case
    // this must NOT clobber it (its own `.finally()` above owns that cleanup).
    if (inflight.get(k) === bootPromise) inflight.delete(k);
  }
}

/**
 * Discover + boot every harness across every workspace in the registry
 * (or just the workspaceIds passed in). Errors per harness are caught;
 * the result rolls them up so callers can log + continue.
 */
/**
 * P-010: decide which of this sweep's pairs to leave DARK (activate on demand).
 *
 * Returns an EMPTY set — i.e. eager boot, byte-identical to today — unless
 * LAZY_SUBSTRATE_BOOT is ON. That flag already gates this entire lazy-boot
 * feature family (eviction reaper + outbox keepalive), so activation rides it
 * rather than introducing a second, separately-flippable half of one behaviour.
 *
 * FAIL-OPEN throughout: every error path returns an empty set. Deferring is the
 * only decision here that can lose data, so anything we cannot verify boots.
 */
async function resolveActivationDeferrals(
  pairs: ReadonlyArray<{ wsId: string; slug: string }>,
  opts: BootAllOpts,
): Promise<Set<string>> {
  const empty = new Set<string>();
  if (pairs.length === 0) return empty;
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    const on = await getFlag(FLAGS.LAZY_SUBSTRATE_BOOT, 'system').catch(() => false);
    if (!on) return empty;

    const { loadHarnessRegistry } = await import('../../harness-registry');
    const { gatherActivationFacts, createPgActivationFactDeps } = await import('./substrate-active-set-facts');
    const { planSubstrateActivation } = await import('./substrate-active-set-policy');

    // Registry lookup per WORKSPACE (not per harness) — harness_kind/hive_slug
    // for every pair costs one cached registry read each.
    const slugsByWs = new Map<string, string[]>();
    for (const p of pairs) {
      const list = slugsByWs.get(p.wsId);
      if (list) list.push(p.slug);
      else slugsByWs.set(p.wsId, [p.slug]);
    }
    const entries: Array<{
      workspaceId: string;
      harnessSlug: string;
      harnessKind?: string;
      potSlug?: string;
    }> = [];
    for (const [wsId, slugs] of slugsByWs) {
      const reg = await loadHarnessRegistry(wsId);
      const bySlug = new Map(reg.projects.map((pr) => [pr.slug, pr]));
      for (const slug of slugs) {
        const pr = bySlug.get(slug);
        // UNKNOWN PROVENANCE ⇒ ACTIVATE. A pair the registry has no entry for
        // (a caller-injected discovery seam, a registry/discovery disagreement)
        // is one we know NOTHING about — not one we know to be idle. Judging it
        // on absent facts would read "no pending rows, no presence, doesn't
        // federate" and defer it, which is the fail-CLOSED direction this whole
        // module refuses. Omitting it from `entries` leaves it out of
        // `decision.defer`, so it boots.
        if (!pr) continue;
        entries.push({
          workspaceId: wsId,
          harnessSlug: slug,
          harnessKind: pr.harness_kind,
          potSlug: pr.hive_slug,
        });
      }
    }

    // Keep the documented test/caller injection genuinely PG-free. Resolving
    // getOrgPg() before the nullish choice made an injected dependency useless:
    // request-only hosts threw here, the outer fail-open catch eagerly booted
    // everything, and the production composition could not be verified.
    const activationFactDeps =
      opts.activationFactDeps ??
      createPgActivationFactDeps(
        (await import('@papercusp/db-org')).getOrgPg()
          .sql as unknown as Parameters<typeof createPgActivationFactDeps>[0],
      );
    const facts = await gatherActivationFacts(entries, activationFactDeps);
    const decision = planSubstrateActivation(facts, {
      now: Date.now(),
      presenceActiveMs: opts.activationPresenceWindowMs ?? 15 * 60 * 1000,
      // P-012's always-on remote wake signal is live. Default ON so the
      // production boot sweep can actually bound shared-hive footprint; callers
      // may still force eager federation with an explicit false rollback.
      deferFederating: opts.deferFederatingHarnesses !== false,
    });
    return new Set(decision.defer);
  } catch (e) {
    console.warn(
      '[boot-all] activation planning failed — booting every harness eagerly (fail-open):',
      e instanceof Error ? e.message : String(e),
    );
    return empty;
  }
}

export async function bootAllHarnessesForActiveWorkspace(opts: BootAllOpts = {}): Promise<BootAllResult> {
  const workspaceIds = opts.workspaceIds ?? (await readRegistryWorkspaceIds());
  const discover = opts.discoverHarnessSlugs ?? harnessSlugsFromPgRegistry;
  // Collect (workspace, slug) pairs FIRST (don't start the boots), then run them
  // through a BOUNDED-concurrency mapper. An unbounded `Promise.all` over every
  // harness saturated a shared boot resource on joiners with many members and
  // timed out ALL substrates (WI-779) — see `bootConcurrency`.
  const pairs: Array<{ wsId: string; slug: string }> = [];
  for (const wsId of workspaceIds) {
    // EI-18788176839043286: freeze every entry's pot-git repoKey BEFORE anything
    // boots. The key names both the bare store on disk and the repo on the wire,
    // and it used to be re-derived from mutable registry coords on every call —
    // so a pot created local-only silently re-keyed itself the moment it gained a
    // GitHub binding, abandoning its store and orphaning every peer (the P-302
    // rig sat disconnected for 7 days reporting ok:true). Pinning writes down the
    // key already in use, so this changes no behaviour now and makes that drift
    // impossible later. Must run ahead of the boots — git-sync and publish both
    // read the key. Idempotent and fail-soft: it never throws.
    //
    // WI-10003590: FIRST repair invite-link-joined entries an older build left
    // without upstream coords — backfill them from the clone's shared.json and
    // move a stale bare-slug 'local' pin to the entry's own best rung. Ahead of
    // the pin pass so a never-pinned entry is pinned correctly on the first try;
    // pot homes are never touched (only `joined_via_link` members). Fail-soft.
    await rekeyLinkJoinedRepoKeysForWorkspace(wsId);
    await pinRepoKeysForWorkspace(wsId);
    // A3: then CORRECT that guess against the pot owner. Pinning alone only makes
    // a key stable, not shared — two devices still have to arrive at the same
    // value, which for a pot home minted locally on both (ensure-papercusp-hive
    // does exactly that on every install) happens only by luck. This adopts the
    // owner's announced `homeRepoKey` over any key stamped 'local'. Order matters:
    // the backfill above writes the guess down, this pass overrides it — which is
    // the whole reason that stamp exists. Fail-soft; never throws.
    await adoptAnnouncedRepoKeysForWorkspace(wsId);
    let slugs: string[];
    try {
      slugs = await discover(wsId);
    } catch (e) {
      // LOUD per-workspace failure (audit P-078): the old FS read returned []
      // on any error — a silent zero-boot. Other workspaces still boot.

      console.error(
        `[boot-all] harness discovery failed for workspace '${wsId}' — booting NOTHING for it:`,
        e instanceof Error ? e.message : String(e),
      );
      continue;
    }
    for (const slug of slugs) pairs.push({ wsId, slug });
  }
  const envConcurrency = Number(process.env.PAPERCUSP_SUBSTRATE_BOOT_CONCURRENCY);
  const bootConcurrency =
    opts.bootConcurrency ?? (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : 4);
  // P-010 activate-on-demand: leave inactive harnesses DARK and wake them on
  // access / captured write. Empty set (⇒ eager boot) unless LAZY_SUBSTRATE_BOOT
  // is on; see resolveActivationDeferrals.
  const deferKeys = await resolveActivationDeferrals(pairs, opts);
  const deferredResults: BootSingleResult[] = [];
  let toBoot = pairs;
  if (deferKeys.size > 0) {
    // Deferral is only SAFE with wake tracking on — the wake paths
    // (getBootedHarness / handleOutboxNotifyForEvictedHarness) no-op while it is
    // off, which would strand every deferred harness. Enable it BEFORE marking
    // (markHarnessActivationDeferred itself no-ops when tracking is off), rather
    // than relying on the caller's post-boot reaper start. Idempotent.
    enableSubstrateEvictionTracking();
    toBoot = [];
    // P-012 slice B: a harness may only be left dark if SOMETHING can wake it.
    // Local access + captured local writes were always covered; P-012 added the
    // REMOTE push wake that makes the production default safe for shared hives.
    // Arm the swarm-presence keepalive FIRST and read its verdict per harness:
    //   'not-needed' — private/local-only: no topic, no peers, nothing to miss;
    //   'covered'    — joined its topic, a peer's frame will wake it;
    //   'uncovered'  — it federates but we could NOT arm (PG down, malformed
    //                  binding, no swarm). Leaving THAT dark is the EI-126
    //                  divergence class, so it boots instead.
    // Arming is I/O (a PG binding read), so it runs under the same bounded
    // concurrency as booting rather than serially or as floating promises.
    const deferCandidates = pairs.filter((p) => deferKeys.has(key(p.wsId, p.slug)));
    const wakeVerdicts = new Map<string, ArmWakeVerdict>();
    await mapWithConcurrency(deferCandidates, bootConcurrency, async (p) => {
      wakeVerdicts.set(
        key(p.wsId, p.slug),
        await armSubstrateWakeKeepalive(p.wsId, p.slug, {
          resolveSwarmBinding: opts.resolveSwarmBinding,
        }),
      );
    });
    let uncovered = 0;
    for (const p of pairs) {
      const k = key(p.wsId, p.slug);
      // A candidate with no recorded verdict is treated as UNCOVERED — the
      // fail-CLOSED direction for deferral, matching how the activation policy
      // treats unknown provenance (boot it rather than judge it on absent facts).
      const mayDefer = deferKeys.has(k) && mayDeferOnWakeVerdict(wakeVerdicts.get(k) ?? 'uncovered');
      if (mayDefer) {
        markHarnessActivationDeferred(p.wsId, p.slug);
        deferredResults.push({
          workspaceId: p.wsId,
          harnessSlug: p.slug,
          state: 'deferred',
          deferReason: 'inactive',
        });
      } else {
        if (deferKeys.has(k)) uncovered += 1;
        toBoot.push(p);
      }
    }
    console.log(
      `[boot-all] activate-on-demand: booting ${toBoot.length}/${pairs.length} harness(es); ` +
        `${deferredResults.length} deferred (wake on access, captured write, or peer frame)` +
        (uncovered > 0 ? `; ${uncovered} federating harness(es) booted because no remote wake could be armed` : ''),
    );
  }
  const bootResults = await mapWithConcurrency(toBoot, bootConcurrency, ({ wsId, slug }) =>
    bootSingleHarness(wsId, slug, {
      timeoutMs: opts.perHarnessTimeoutMs,
      resolveSwarmBinding: opts.resolveSwarmBinding,
      bootHarness: opts.bootHarness,
      skipSendSideWiring: opts.skipSendSideWiring,
    }),
  );
  const results: BootSingleResult[] = [...bootResults, ...deferredResults];

  // p2p-hive-directory P-003 boot-join: after the harnesses boot, join the global
  // hive-directory topic + announce this workspace's owned public/invite hives.
  // Fully best-effort + fire-and-forget — a directory failure (e.g. gh
  // unauthenticated → no announce identity) must NEVER affect harness boot, so
  // this is a detached promise with its own catch.
  for (const wsId of workspaceIds) {
    void (async () => {
      try {
        const { wireHiveDirectoryForWorkspace } = await import('../../hive-directory-boot');
        await wireHiveDirectoryForWorkspace(wsId);
      } catch {
        /* best-effort; boot-all never fails on the directory */
      }
    })();
  }

  // hive-network-surface-2026-06-11 P-001 (B-01): light the cross-Hive boundary
  // for each directory-PUBLISHED Hive (private hives stay dark) + run the boot
  // drain of its durable outbox. Same posture as the directory wire above —
  // fully best-effort + fire-and-forget with its own catch; the boundary must
  // NEVER affect harness boot. Re-runs reconcile idempotently (the periodic
  // `system:cross-hive-outbox-drain` routine keeps later publish/visibility
  // changes converging without a restart).
  for (const wsId of workspaceIds) {
    void (async () => {
      try {
        const { ensureCrossHiveBoundariesWired } = await import('../../cross-hive-boundary-boot');
        await ensureCrossHiveBoundariesWired(wsId);
      } catch {
        /* best-effort; boot-all never fails on the boundary */
      }
    })();
  }

  // hive-from-repo-hardening-2026-06-11 P-009: once-per-process registry
  // github-coords revalidation — re-fetch each coord-bearing project by its
  // IMMUTABLE github_repository_id and repair github_remote /
  // github_default_branch drift after an upstream GitHub rename. Same posture
  // as the hive-directory wire above: fully best-effort + fire-and-forget with
  // its own catch — it must NEVER affect harness boot. The once-guard lives in
  // the module, so retry passes of this function no-op. Workspace omitted →
  // the ACTIVE workspace (the registry helpers' default scope).
  void (async () => {
    try {
      const { ensureRepoCoordsRevalidatedOnce } = await import('../../harness/revalidate-repo-coords');
      ensureRepoCoordsRevalidatedOnce();
    } catch {
      /* best-effort; boot-all never fails on coord revalidation */
    }
  })();

  // git-sync-any-hive-2026-06-12 P-004 (B-04): once-per-process reconcile —
  // walk each workspace's registry and seed any MISSING `system:git-sync`
  // routine rows for hive MEMBER checkouts (hives created before the seeding
  // sites existed, or members that slipped past them). ADD-only: existing
  // rows — `papercup`'s hand-tuned one included — are never mutated. Same
  // posture as the hygiene blocks above: lazy-import + fire-and-forget with
  // its own catch — it must NEVER affect harness boot — and the once-guard
  // lives in the module, so retry passes of this function no-op.
  void (async () => {
    try {
      const { ensureGitSyncRoutinesReconciledOnce } = await import('../../harness/git-sync/git-sync-reconcile');
      ensureGitSyncRoutinesReconciledOnce(workspaceIds);
    } catch {
      /* best-effort; boot-all never fails on git-sync reconcile */
    }
  })();

  // WI-5327 (p2p-public-release-remaining-lanes-2026-07-16 P-407): once-
  // per-process seeding of THIS host's p2p production routines
  // (sweep-orphaned-foreign-harnesses, p2p-foreign-supervision) — host identity
  // resolved from existing seams only (see
  // ensure-host-routines.ts's module doc), never fabricated. Same posture as
  // the git-sync reconcile hygiene block above: lazy-import + fire-and-forget
  // with its own catch — it must NEVER affect harness boot — and the
  // once-guard lives in the module, so retry passes of this function no-op.
  void (async () => {
    try {
      const { ensureP2pHostRoutinesSeededOnce } = await import('../../p2p/ensure-host-routines');
      // WI-5771: workspaceIds (the FULL registry list) is no longer used to
      // seed — see ensure-host-routines.ts's module doc. Kept as an arg for
      // now only for call-site symmetry with the sibling hygiene hooks above.
      ensureP2pHostRoutinesSeededOnce(workspaceIds);
    } catch {
      /* best-effort; boot-all never fails on p2p host-routine seeding */
    }
  })();

  // plan-federation-regrain-2026-06-13 P-005/P-007: once-per-process per-part
  // plan-federation reconcile/backfill — decompose each plan into harness_plan_parts
  // (origin='local') so local plan edits federate per-part. FLAG-GATED inside the
  // function: it no-ops unless papercusp-plan-part-federation is on, so this is DARK
  // by default. Same fire-and-forget + own-catch posture; must NEVER affect boot.
  void (async () => {
    try {
      const { ensurePlanPartsReconciledOnce } = await import('../../plan-parts/reconcile');
      ensurePlanPartsReconciledOnce(workspaceIds);
    } catch {
      /* best-effort; boot-all never fails on plan-parts reconcile */
    }
  })();

  // shared-hive-hardening-2026-06-13 P-013 (B-04): once-per-process join-state
  // self-heal — re-register the ONE residual boot-all can't heal itself, a join
  // whose clone landed on disk but whose registry write also failed (so this
  // boot never visited it). Registered joins are already federated by the boot
  // loop above; this only closes the unregistered-ghost gap. Joins target the
  // active workspace (activeWorkspaceId at join time), so heal into it. Same
  // posture as the reconcile blocks above: lazy-import + fire-and-forget with
  // its own catch + module once-guard — it must NEVER affect harness boot.
  void (async () => {
    try {
      const { activeWorkspaceId } = await import('../../workspace-registry');
      const { ensureJoinStatesReconciledOnce } = await import('../../harness/join-state-reconcile');
      ensureJoinStatesReconciledOnce(activeWorkspaceId());
    } catch {
      /* best-effort; boot-all never fails on join-state reconcile */
    }
  })();

  return {
    // `attempted` stays "boots we actually tried" — a deferred harness was
    // deliberately not attempted, so counting it here would misreport the sweep
    // (and, with the flag OFF, deferredResults is empty ⇒ unchanged).
    attempted: bootResults.length,
    booted: results.filter((r) => r.state === 'booted').length,
    alreadyBooted: results.filter((r) => r.state === 'already-booted').length,
    failed: results.filter((r) => r.state === 'failed').length,
    deferred: deferredResults.length,
    results,
  };
}

/** Tear down a single handle. Idempotent. */
export async function closeBootedHarness(workspaceId: string, harnessSlug: string): Promise<boolean> {
  const k = key(workspaceId, harnessSlug);
  const handle = handles.get(k);
  if (!handle) return false;
  handles.delete(k);
  // Drop the send-side wiring state so a future re-boot re-wires from scratch
  // (the drain/presence loops are torn down by the handle's close-hooks below).
  outboxWired.delete(k);
  presenceWired.delete(k);
  wiringInflight.delete(k);
  // A DELIBERATE close (leave-hive, reboot, shutdown) is not a reaper eviction —
  // drop its access record and never mark it for reboot-on-access.
  lastAccess.delete(k);
  evicted.delete(k);
  try {
    await handle.close();
  } catch {
    // close errors are non-fatal; the handle is gone from the map
  }
  return true;
}

/** WI-2105 sidecar takeover: close every IN-PROCESS (non-remote) booted handle.
 *  Called by bootSubstrateWithFallback right after it installs the sidecar
 *  routing defaults — an engine that raced in-process before the decision
 *  (latch-timeout straggler, a direct bootHarnessSubstrate import) is torn down
 *  so the sweep re-boots it through the sidecar; leaving it alive means TWO
 *  concurrent substrate instances for that harness (the WI-2105 outage class).
 *  Remote (sidecar-backed) handles are untouched. */
export async function closeInProcessBootedHarnesses(): Promise<string[]> {
  const closed: string[] = [];
  for (const [k, handle] of [...handles.entries()]) {
    if (handle instanceof RemoteBootedHarnessHandle) continue;
    handles.delete(k);
    outboxWired.delete(k);
    presenceWired.delete(k);
    wiringInflight.delete(k);
    lastAccess.delete(k);
    evicted.delete(k);
    try {
      await handle.close();
    } catch {
      // close errors are non-fatal; the handle is out of the map either way
    }
    closed.push(k);
  }
  return closed;
}

export interface RebootHarnessResult {
  /** True if a live handle was torn down before re-booting. */
  closed: boolean;
  /** Result of the (re)boot attempt. */
  boot: BootSingleResult;
}

/**
 * Tear down a harness's substrate handle (if booted) and boot it fresh.
 *
 * Why this exists: `bootSingleHarness` short-circuits to `already-booted`
 * for a cached handle and never re-resolves the swarm binding. So after a
 * harness writes `.papercusp/shared.json` (the "go shared" flip), nothing
 * makes the already-booted, `swarm: null` handle actually join the swarm.
 * `rebootHarness` closes the stale handle — which drops it from the map —
 * then boots again, so the boot re-runs `defaultResolveSwarmBinding`
 * against the now-present config and joins the derived Hyperswarm topic.
 *
 * Idempotent + safe when not booted: `closeBootedHarness` no-ops (returns
 * false) and `bootSingleHarness` boots fresh. The substrate always boots
 * (Stage 4d), so this can be called whenever a harness's shared.json changes.
 */
export async function rebootHarness(
  workspaceId: string,
  harnessSlug: string,
  opts: {
    workspaceRoot?: string;
    timeoutMs?: number;
    resolveSwarmBinding?: SwarmBindingResolver;
  } = {},
): Promise<RebootHarnessResult> {
  const closed = await closeBootedHarness(workspaceId, harnessSlug);
  const boot = await bootSingleHarness(workspaceId, harnessSlug, opts);
  return { closed, boot };
}

/**
 * Re-key a BOOTED harness onto its freshly-resolved swarm binding IN PLACE —
 * leave the old topic + join the new one while keeping the substrate's store /
 * own log / admitted set / merge loop ALIVE. The "go shared" primitive for an
 * already-running harness whose binding changed (it joined/published a hive, so
 * its `gh:<repo_id>` topic must switch to the hive-pubkey topic).
 *
 * EI-681: PREFER this over `rebootHarness` for a re-key. A full reboot tears
 * down + re-creates the Corestore-backed substrate, which disrupts the OWNER's
 * corestore replication-SERVING of its own log core — the re-keyed owner admits
 * + connects to the joiner but never UPLOADS its log, so the feature never
 * crosses (confirmed via the two-instance hive-from-repo smoke: owner fires zero
 * `upload` events post-reboot; re-key-in-place serves seamlessly). Re-key in
 * place never tears down the replication streams.
 *
 * Falls back to a fresh `bootSingleHarness` when the harness isn't booted yet
 * (which resolves + joins the new binding itself). Idempotent + safe-when-unbooted.
 */
export async function rekeyHarness(
  workspaceId: string,
  harnessSlug: string,
  opts: {
    workspaceRoot?: string;
    resolveSwarmBinding?: SwarmBindingResolver;
    /** Test seam — override the send-side wiring fns (default: getOrgPg + the
     *  real wireOutboxForHarness / wirePresenceAnnounceForHarness). Threaded into
     *  both the fresh-boot (bootSingleHarness) and the in-place re-key wiring. */
    wireSendSide?: SendSideWiringDeps;
    /** Remote handles are wired in their owning (sidecar) process; skip the
     *  main-process send-side loops. Defaults false; a remote handle is also
     *  auto-detected below so a missed flag never double-wires the sidecar. */
    skipSendSideWiring?: boolean;
  } = {},
): Promise<{ rekeyed: boolean; boot?: BootSingleResult }> {
  const handle = handles.get(key(workspaceId, harnessSlug));
  if (!handle) {
    // Not booted yet → a fresh boot resolves + joins the new binding itself
    // (bootSingleHarness wires the outbox drain + presence via ensureSendSideWired).
    const boot = await bootSingleHarness(workspaceId, harnessSlug, opts);
    return { rekeyed: false, boot };
  }
  const resolver = opts.resolveSwarmBinding ?? defaultResolveSwarmBinding;
  const binding = (await resolver(workspaceId, harnessSlug)) ?? null;
  if (!binding) {
    // No binding resolved (still private / unresolvable) — leave as-is rather
    // than dropping the harness off its current topic.
    return { rekeyed: false };
  }
  await handle.rekey(binding);
  // EI-521: a re-key joins the harness's federation topic IN PLACE (so it
  // peer_connects), but — unlike bootSingleHarness — it never wired the outbox
  // DRAIN / presence-announce loops. A harness booted WITHOUT its send-side wired
  // (or whose wiring failed) would then sit peer_connected with its
  // substrate_outbox UNDRAINED forever (content captured but never federated) —
  // the live cross-machine blocker on joined/created hive harnesses, whose ONLY
  // route onto the Hive topic is rekeyHarness (publishCreatedHive / joinHiveAsView).
  // ensureSendSideWired is idempotent (a no-op once wired), so this is safe on an
  // already-wired handle. A REMOTE (sidecar) handle is skipped: its owning sidecar
  // process wires the drain, so re-wiring here would double-append the outbox.
  if (!opts.skipSendSideWiring && !(handle instanceof RemoteBootedHarnessHandle)) {
    // WI-40905: an already-running drain may have been wired while this
    // harness was still private, when buildHiveRekeyBootDeps correctly returned
    // null. Refresh its capability against the now-committed Hive registry
    // state before the idempotence guard below no-ops. This updates the existing
    // drain; it never starts a second LISTEN/poll loop. If no controller exists
    // (boot wiring never ran), ensureSendSideWired performs first-time wiring.
    await refreshOutboxEpochEncryptForHarness(handle);
    await ensureSendSideWired(handle, opts.wireSendSide);
  }
  return { rekeyed: true };
}

export interface ReconcileRemoteHandlesResult {
  /** `${workspaceId}::${harnessSlug}` keys successfully re-booted onto the new sidecar. */
  rebooted: string[];
  /** Keys that failed to re-boot, with the error. */
  failed: Array<{ key: string; error: string }>;
}

/**
 * WI-1877 — after a substrate-sidecar crash+respawn, every cached
 * `RemoteBootedHarnessHandle` in THIS process still refers to the OLD sidecar
 * instance's (now-gone) in-memory store: the new sidecar process boots with
 * ZERO harnesses registered (no topic joins, no swarm, no federation) and
 * `bootSingleHarness` would otherwise short-circuit every one of them to
 * `already-booted` forever (the cache says it's booted, so nothing ever
 * re-issues the boot call onto the fresh sidecar) — silently dark until a full
 * app restart (live repro: mac VM 2026-07-03, 10+ min zero topic joins).
 *
 * Call this once a fresh sidecar is confirmed ready after an auto-respawn
 * (wired via `onSidecarRespawned` in substrate-boot-wrapper.ts). Re-issues
 * `bootHarness` (via `rebootHarness`, which closes the stale handle then boots
 * fresh) for every currently-cached REMOTE handle, in bounded-concurrency
 * batches — mirrors `bootAllHarnessesForActiveWorkspace`'s WI-779 guard so a
 * respawn during a many-harness boot doesn't saturate the fresh sidecar the
 * same way an unbounded initial boot once did. In-process (non-remote)
 * handles are left untouched — a sidecar crash never affects them. Per-harness
 * failures are collected, never thrown — one bad harness must never block the
 * rest from re-registering.
 */
export async function reconcileRemoteHandlesAfterSidecarRestart(
  bootConcurrency?: number,
): Promise<ReconcileRemoteHandlesResult> {
  const remoteKeys = [...handles.entries()].filter(([, h]) => h instanceof RemoteBootedHarnessHandle).map(([k]) => k);

  const envConcurrency = Number(process.env.PAPERCUSP_SUBSTRATE_BOOT_CONCURRENCY);
  const concurrency = bootConcurrency ?? (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : 4);

  const failed: Array<{ key: string; error: string }> = [];
  const rebooted: string[] = [];
  await mapWithConcurrency(remoteKeys, concurrency, async (k) => {
    const parsed = parseKey(k);
    if (!parsed) return;
    try {
      const { boot } = await rebootHarness(parsed.workspaceId, parsed.harnessSlug);
      if (boot.state === 'booted') {
        rebooted.push(k);
      } else {
        failed.push({ key: k, error: boot.error ?? `unexpected post-respawn state '${boot.state}'` });
      }
    } catch (e) {
      failed.push({ key: k, error: e instanceof Error ? e.message : String(e) });
    }
  });

  if (failed.length > 0) {
    console.error(
      `[boot-all] sidecar-respawn reconcile: ${failed.length}/${remoteKeys.length} harness(es) failed to re-boot onto the new sidecar:`,
      failed,
    );
  }
  if (rebooted.length > 0) {
    console.log(
      `[boot-all] sidecar-respawn reconcile: re-booted ${rebooted.length}/${remoteKeys.length} harness(es) onto the new sidecar: ${rebooted.join(', ')}`,
    );
  }
  return { rebooted, failed };
}

/**
 * EI-16949 (WI-183-orphan-class): drop EVERY booted handle's replication-liveness
 * REGISTRY tracking (auto-resolving any durable EI a latched stall alarm had
 * filed) WITHOUT touching the native Hypercore/Hyperswarm teardown at all.
 *
 * `closeAllBootedHarnesses()` normally does this as a side effect of each
 * handle's `.close()` (boot.ts calls `dropReplicationLiveness` first thing) —
 * but `gracefulHostRecycle` (host-recycle.ts) deliberately SKIPS calling
 * `closeAllBootedHarnesses()` entirely when the event loop is under pressure
 * (WI-3795) or for a memory-watchdog recycle (EI-9649), to avoid starting the
 * native substrate close that can throw an uncaught Napi::Error/SIGABRT below
 * the JS layer. That skip is correct for the native teardown, but it ALSO
 * skipped this pure-JS/PG registry cleanup as an unintended side effect — so
 * any harness with a currently-latched replication-liveness alarm (e.g. the
 * `papercusp` dev harness's OWN merge loop, which restarts routinely under
 * `papercup-staging-sync.timer`'s 5-minute freshness cadence) left its durable
 * EI open FOREVER: the only path that could ever auto-resolve it (a live
 * process re-sampling the SAME logKeyHex as healthy) can never run once this
 * process exits, and the drop-on-close path that WOULD have resolved it was
 * the very thing just skipped. Observed live: 173 open `[replication-liveness]`
 * EIs (2026-07-19), the single largest class in the papercusp bug backlog,
 * the majority against `harness=papercusp` itself.
 *
 * This function is the safe subset of `closeAllBootedHarnesses()` — registry
 * bookkeeping + a best-effort durable-EI resolve write, no native calls at
 * all — so `gracefulHostRecycle` can call it EVEN WHEN it skips the real
 * substrate teardown, closing the orphaned-EI leak without reintroducing the
 * crash risk the skip exists to avoid. Awaits every handle's resolve writes
 * (bounded by the caller's own shutdown budget) so they get a real chance to
 * land before the process exits. Best-effort per-handle: one harness's
 * failure never blocks the rest. Does NOT clear `handles`/wiring state — the
 * caller is about to exit the process anyway (or, in a non-shutdown test
 * call, the handles remain live and bootable as normal).
 */
export async function dropAllReplicationLivenessTracking(): Promise<string[]> {
  const { dropReplicationLiveness } = await import('./replication-liveness');
  const entries = Array.from(handles.values());
  const dropped: string[] = [];
  await Promise.all(
    entries.map(async (h) => {
      try {
        await dropReplicationLiveness(h.workspaceId, h.harnessSlug);
        dropped.push(key(h.workspaceId, h.harnessSlug));
      } catch {
        // best-effort — one harness's failure never blocks the rest
      }
    }),
  );
  return dropped;
}

/** Tear down every cached handle. For test cleanup + process shutdown. */
export async function closeAllBootedHarnesses(): Promise<number> {
  const entries = Array.from(handles.entries());
  handles.clear();
  outboxWired.clear();
  presenceWired.clear();
  wiringInflight.clear();
  lastAccess.clear();
  evicted.clear();
  let closed = 0;
  await Promise.all(
    entries.map(async ([, h]) => {
      try {
        await h.close();
        closed += 1;
      } catch {
        // ignore
      }
    }),
  );
  return closed;
}

/**
 * Snapshot of every booted handle. Read-only — returns a fresh array
 * each call. Used by the admin status endpoint + diagnostic tools.
 */
export interface BootedHandleSummary {
  workspaceId: string;
  harnessSlug: string;
  /**
   * The identity this harness's swarm hello/announce carries — the ONLY device
   * peers will accept an announcement from for this pot, because it is the
   * device they filed our socket under.
   *
   * Published with the handle list (WI-2142873) because the readers that need
   * it live in OTHER PROCESSES: this registry is deliberately process-local, so
   * a git-sync routine running outside the substrate owner sees no handle at
   * all and used to sign pot announcements as the gh-login device instead —
   * announcements no peer can dial. Enumerating a handle without saying WHO it
   * serves as is what made that silent; same reasoning as the `healthInputs`
   * bundle (EI-20575137548097507), one field over.
   *
   * `null` = this handle genuinely has no swarm identity (no join). Absent on a
   * summary produced by a pre-WI-2142873 owner, which a reader must treat as
   * UNKNOWN, never as null — see `pickHiveGitActor`.
   */
  announceIdentity?: BootedAnnounceIdentity | null;
}

export function listBootedHandles(): BootedHandleSummary[] {
  const out: BootedHandleSummary[] = [];
  for (const handle of handles.values()) {
    out.push({
      workspaceId: handle.workspaceId,
      harnessSlug: handle.harnessSlug,
      announceIdentity: handle.announceIdentity ?? null,
    });
  }
  return out;
}

export interface GitServingAdvertisement {
  request: GitServingRequest;
  state: GitServingState;
}

/** One bounded pass per existing owner heartbeat, sharing each workspace's
 * registry/hive reads. Remote handles ask the actual sidecar on its existing
 * status RPC; their cached boot-time announce identity is never authoritative. */
/**
 * WI-10000734 — the pass MUST finish well inside GIT_SERVING_LEASE_MS (30s).
 *
 * Each entry's `getGitServingCapability` MINTS a capability that stamps
 * `issuedAtMs = now()` at its own moment, but the whole batch is published only
 * once the pass ends. A SERIAL pass therefore burns the lease of everything it
 * minted early. Measured 2026-09-08 on this box: ~70 entries, pass duration
 * ~94s (mints spanning 90s-184s before read) against the 30s lease, so 43 of 43
 * published capabilities were already expired on arrival and pot-git serving was
 * PERMANENTLY unavailable. That failed ref-announce's buildSigrefs, froze
 * `ref_announce.replayFloors`, made integrator-tick reject every member snapshot
 * ("waiting for verified ref announcement"), froze hive canonical `refs/hive/staging`
 * and therefore `origin/staging` for ~5h with ~99 commits stranded and all fleet
 * promotion blocked.
 *
 * It degraded by SCALE, not by an event: the pass was ~20s when written and grew
 * past the lease as pot count grew, so it is a cliff any host re-reaches. Keep the
 * per-entry mints parallel, and do not reintroduce an await inside a serial loop here.
 */
const GIT_SERVING_MINT_CONCURRENCY = 8;

export async function listGitServingCapabilities(): Promise<GitServingAdvertisement[]> {
  const [{ loadHarnessRegistry }, { getHiveBySlug }, { canonicalRepoKey }] = await Promise.all([
    import('../../harness-registry'), import('../../hive-store'), import('../pot-git/repo-identity'),
  ]);
  const out: GitServingAdvertisement[] = [];
  for (const workspaceId of new Set([...handles.values()].map(h => h.workspaceId))) {
    const entries = (await loadHarnessRegistry(workspaceId)).projects;
    // Plan first — every skip below is pure, so the awaited work that follows is
    // exactly the independent per-entry part and nothing else.
    const planned = entries.flatMap((entry) => {
      const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
      if (!potHomeSlug) return [];
      const candidates = [...new Set([entry.slug, potHomeSlug])]
        .map(slug => handles.get(key(workspaceId, slug))).filter((h): h is BootedHarnessHandle => Boolean(h));
      if (candidates.length === 0) return [];
      return [{ entry, potHomeSlug, candidates }];
    });
    // Resolve each DISTINCT pot's hive id once, up front. The previous
    // `if (!hives.has(slug))` memo was only safe because the pass was serial; a
    // check-then-await memo races under parallelism and would issue duplicate
    // reads. Resolving up front keeps the one-read-per-pot property without it.
    const hiveIds = new Map<string, string | null>(
      await mapWithConcurrency(
        [...new Set(planned.map(p => p.potHomeSlug))],
        GIT_SERVING_MINT_CONCURRENCY,
        async (slug) => [slug, (await getHiveBySlug(workspaceId, slug))?.pubkeyBase64 ?? null] as [string, string | null],
      ),
    );
    // mapWithConcurrency is order-preserving, so `out` keeps registry order.
    const minted = await mapWithConcurrency(
      planned,
      GIT_SERVING_MINT_CONCURRENCY,
      async ({ entry, potHomeSlug, candidates }): Promise<GitServingAdvertisement | null> => {
        const hiveId = hiveIds.get(potHomeSlug);
        if (!hiveId) return null;
        const request: GitServingRequest = { workspaceId, installSlug: entry.slug, potHomeSlug,
          scope: { hive_id: hiveId, repo_key: canonicalRepoKey(entry) } };
        let state: GitServingState = gitServingUnavailable('unknown', 'owner supplies no serving capability');
        // Candidates stay SEQUENTIAL: this is a first-ready fallback, not a fan-out,
        // and it must not mint from a second handle once one has answered ready.
        for (const handle of candidates) {
          try {
            const answer = validateGitServingState(await handle.getGitServingCapability?.(request), request);
            if (answer.status === 'ready') { state = answer; break; }
            if (state.status === 'unknown') state = answer;
          } catch (error) {
            if (state.status === 'unknown') state = gitServingUnavailable('unknown', error instanceof Error ? error.message : String(error));
          }
        }
        return { request, state };
      },
    );
    for (const advertisement of minted) if (advertisement) out.push(advertisement);
  }
  return out;
}

/**
 * Snapshot only the handles whose engine lives in the substrate sidecar.
 *
 * Kept separate from `listBootedHandles()` so the long-standing diagnostic
 * shape remains stable.  The cross-service PG publisher uses this list to
 * advertise the sidecar socket only when the owner can prove that the exact
 * handle is relocated; an in-process handle must never make another process
 * attempt a sidecar dial.
 */
export function listRelocatedBootedHandles(): BootedHandleSummary[] {
  const out: BootedHandleSummary[] = [];
  for (const handle of handles.values()) {
    if (!(handle instanceof RemoteBootedHarnessHandle)) continue;
    out.push({
      workspaceId: handle.workspaceId,
      harnessSlug: handle.harnessSlug,
      announceIdentity: handle.announceIdentity ?? null,
    });
  }
  return out;
}

/**
 * Gather each booted harness's eviction-relevant liveness facts for the
 * LAZY_SUBSTRATE_BOOT reaper (P-008). Pure read over the live handle map.
 *
 * ── v2 SAFETY BOUNDARY ── A harness with a live swarm connection is reported
 * `hasActivePeer`, so `planSubstrateEviction` NEVER evicts it. An idle swarmed
 * in-process harness is now a candidate: the race-guarded eviction path first
 * transfers its topic to P-012's lightweight wake keepalive and refuses to
 * close when that coverage cannot be established. Relocated handles remain
 * pinned because their real peer/swarm facts live in the sidecar process.
 *
 * `lastAccessMs` defaults to `now` for a handle with no recorded access (treated
 * HOT — never evicted on a missing signal). `admitted` is historical log
 * identity state and therefore is deliberately not used as a live-peer gauge;
 * `SwarmHandle.liveConnectionCount` is the current connection signal.
 */
export function gatherBootedHarnessFacts(now: number): BootedHarnessFacts[] {
  const facts: BootedHarnessFacts[] = [];
  for (const [k, handle] of handles) {
    // WI-1544 Leg D: a RELOCATED (sidecar) handle reports swarm=null and
    // admitted=∅ BY DESIGN — the real swarm + admitted set live in the sidecar
    // process, and sidecar drain/replication activity never bumps operator-side
    // lastAccess either. Reading those proxy fields here made every packaged-app
    // harness look inert, so the reaper evicted LIVE federated engines
    // (substrate:closeStore → left the topic, killed announce + log serving; the
    // owner's hive-home harness then never re-booted — no local writes — and the
    // roster blacked out permanently). v1 boundary, restated: only IN-PROCESS
    // engines whose liveness we can actually observe are eviction candidates;
    // every remote handle is pinned until facts come from sidecar status (v2).
    const remote = handle instanceof RemoteBootedHarnessHandle;
    const hasLivePeer = !remote && (handle.swarm?.liveConnectionCount ?? 0) > 0;
    facts.push({
      key: k,
      lastAccessMs: lastAccess.get(k) ?? now,
      hasActivePeer: hasLivePeer,
      // v2: in-process swarmed and private handles both enter the idle/LRU
      // candidate set. evictBootedHarnessEngine owns the load-bearing second
      // check: active peers dominate, and a swarmed engine closes only after
      // its wake keepalive reports coverage. Sidecar proxies stay pinned.
      pinned: remote,
    });
  }
  return facts;
}

/**
 * Tear down ONE booted harness ENGINE for the reaper (P-008) and mark it for
 * reboot-on-access. Returns whether it actually evicted.
 *
 * Re-checks freshness + swarm/peer state IMMEDIATELY before close to close the
 * access↔evict race: between the reaper's fact snapshot and this call, a consumer
 * may have grabbed the handle (bumping `lastAccess`) or a peer may have connected
 * (live swarm connection) — in which case we SKIP, leaving the engine resident.
 */
export async function evictBootedHarnessEngine(k: string, guard: { now: number; idleMs: number }): Promise<boolean> {
  const handle = handles.get(k);
  if (!handle) return false;
  // WI-1544 Leg D: NEVER evict a relocated (sidecar) handle — its swarm/admitted
  // proxies are blind (always null/∅), so the v1 liveness re-check below cannot
  // see a live federated engine. Mirrors the pin in gatherBootedHarnessFacts.
  if (handle instanceof RemoteBootedHarnessHandle) return false;
  // Got hot since the snapshot? Skip.
  const last = lastAccess.get(k);
  if (last != null && guard.now - last < guard.idleMs) return false;
  // Acquired a peer since the snapshot? Skip — D-005's dominating rule: a
  // harness with an ACTIVE peer must stay resident and keep merging, or that
  // peer's pushes are silently lost (the EI-126 divergence class).
  if ((handle.swarm?.liveConnectionCount ?? 0) > 0) return false;
  const parsed = parseKey(k);
  if (!parsed) return false;
  // P-012 slice B: a FEDERATING (swarmed) engine may only be evicted once the
  // lightweight wake keepalive has taken over its topic — otherwise it goes
  // dark with no way to hear a peer's push, which is exactly the hole that made
  // `pinned: hasSwarm` necessary in v1. Arm BEFORE closing (not after) so the
  // window where the harness is on NEITHER the real swarm nor the keepalive is
  // as small as possible; if we cannot cover it, leave the engine resident.
  if (handle.swarm != null) {
    const verdict = await armSubstrateWakeKeepalive(parsed.workspaceId, parsed.harnessSlug);
    if (!mayDeferOnWakeVerdict(verdict)) return false;
  }
  const closed = await closeBootedHarness(parsed.workspaceId, parsed.harnessSlug);
  if (closed) {
    // closeBootedHarness cleared lastAccess + evicted; re-mark for reboot-on-access.
    evicted.add(k);
  } else if (handle.swarm != null) {
    // The close did not happen, so the engine is still resident and owns its
    // topic — release the keepalive we just armed rather than leaving a stray
    // watcher behind.
    void disarmSubstrateWakeKeepalive(parsed.workspaceId, parsed.harnessSlug).catch(() => {});
  }
  return closed;
}

/**
 * Re-boot-on-NOTIFY (AC#2 / P-008): called by the process-global outbox keepalive
 * when it receives a `pg_notify('substrate_outbox', '${ws}::${slug}')` for a harness
 * that is NOT currently booted. If the engine was evicted by the reaper (it's in the
 * `evicted` set), clear the mark and fire the same background re-boot-on-access trigger,
 * so the drain starts and the captured rows are consumed instead of piling up.
 *
 * No-op when:
 *   - eviction tracking is off (flag OFF — byte-identical eager path)
 *   - the harness is currently booted (the resident drain handles the NOTIFY)
 *   - the key was never evicted (paranoid check — a non-evicted unbooted harness
 *     shouldn't receive outbox NOTIFYs during normal operation)
 */
export function handleOutboxNotifyForEvictedHarness(workspaceId: string, harnessSlug: string): void {
  if (!evictionTrackingEnabled) return;
  const k = key(workspaceId, harnessSlug);
  if (handles.has(k)) return; // currently booted; running drain handles this NOTIFY
  // P-010: a harness the activation policy DEFERRED is equally wake-eligible —
  // keying on `evicted` alone dropped this NOTIFY on the floor and left the
  // captured write undrained forever.
  if (takeWakeEligible(k)) {
    rebootOnAccess(workspaceId, harnessSlug);
  }
}

/**
 * True when this harness's ENGINE is currently resident in THIS process.
 *
 * The residency probe substrate-wake-gossip injects: a live engine is already
 * joined + replicating, so a wake frame on its topic is noise and must not fire
 * a redundant boot. Exported (rather than letting the gossip reach into
 * `handles`) so the handle map stays this module's private business — the same
 * boundary `getBootedHarness` draws for consumers.
 */
export function isHarnessEngineResident(workspaceId: string, harnessSlug: string): boolean {
  return handles.has(key(workspaceId, harnessSlug));
}

/**
 * Re-boot-on-REMOTE-WAKE (P-012 slice B / WI-6071): the swarm-presence dual of
 * `handleOutboxNotifyForEvictedHarness`. Called by the substrate-wake gossip
 * when a peer frame lands on the federation topic of a harness whose engine is
 * NOT resident — i.e. a member of this hive is online (or just wrote), and a
 * dark member must come up to replicate with it.
 *
 * This closes the half of the eviction keepalive that was documented in
 * substrate-eviction-policy's header but never built: the LISTEN outbox watch
 * covers LOCAL writes, this covers REMOTE ones. Without it, every wake trigger
 * was local-side, so a remote push to a dark harness was simply unheard. P-012
 * supplies that third trigger; boot-all now enables federating deferral by
 * default and the reaper can evict a swarmed engine after coverage is armed.
 *
 * Same no-op conditions and same wake path as the outbox-NOTIFY dual, so the
 * two cannot drift:
 *   - eviction tracking off (flag OFF ⇒ byte-identical eager path)
 *   - the harness is currently booted (its resident engine handles the peer)
 *   - the key is not wake-eligible (never evicted / never deferred)
 *
 * NOTE the deliberate boundary: this can only fire while some peer is
 * CONCURRENTLY online. A write made while every member is dark reaches nobody
 * until a peer returns — that store-and-forward case is P-013's relay tier, not
 * this path (see substrate-wake-gossip's header).
 */
export function handleRemoteWakeForDarkHarness(workspaceId: string, harnessSlug: string): boolean {
  if (!evictionTrackingEnabled) return false;
  const k = key(workspaceId, harnessSlug);
  if (handles.has(k)) return false; // resident engine is already replicating
  if (!takeWakeEligible(k)) return false;
  rebootOnAccess(workspaceId, harnessSlug);
  return true;
}

/** For tests. Clears the handle map WITHOUT closing — useful when the
 * handles were faked. Never call from production code. */
export function _resetHandleMapForTests(): void {
  handles.clear();
  inflight.clear();
  outboxWired.clear();
  presenceWired.clear();
  wiringInflight.clear();
}

/** For tests. Inject a handle directly (skips real boot). */
export function _setHandleForTests(workspaceId: string, harnessSlug: string, handle: BootedHarnessHandle): void {
  handles.set(key(workspaceId, harnessSlug), handle);
}

/**
 * Workspace ids to boot — every workspace holding a PG harness_registry row
 * (a workspace without one has no harnesses to boot). Replaces the stale-able
 * `~/.papercusp-workspaces/registry.json` read (audit P-078). Throws on a PG
 * failure: host-bootstrap's caller logs it loudly — a visible boot failure
 * beats the old silent zero-harness boot.
 */
async function readRegistryWorkspaceIds(): Promise<string[]> {
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  const rows = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id FROM harness_shared.harness_registry`;
  return rows.map((r) => r.workspace_id);
}
