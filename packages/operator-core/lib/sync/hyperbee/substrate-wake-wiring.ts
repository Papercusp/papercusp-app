/**
 * substrate-wake-wiring — binds the substrate-wake gossip to the boot layer
 * (shared-hive-cross-machine-scale-10k-2026-06-29 P-012 slice B / WI-6071).
 *
 * substrate-wake-gossip is deliberately pure (it knows about topics and frames,
 * nothing about harnesses or Postgres) and boot-all deliberately owns the handle
 * map. This module is the thin, process-scoped adapter between them:
 *
 *   arm(ws, slug)     → resolve the harness's federation topic and JOIN it,
 *                       holding no engine. Called when the boot sweep defers a
 *                       harness, and when the reaper evicts one.
 *   disarm(ws, slug)  → leave the topic once the real engine is resident (its
 *                       own swarm join supersedes the keepalive).
 *   announce(ws,slug) → the live send side: tell dark members "activity here".
 *
 * THE ONE NON-OBVIOUS PART — resolving a topic for a harness we never booted.
 * The topic normally falls out of booting (boot.ts derives it from the binding
 * it resolves on the way up), but a deferred harness never boots, so there is no
 * handle to ask. `defaultResolveSwarmBinding` is the seam that makes this
 * tractable: it reads the hive/shared-config binding straight from PG WITHOUT
 * booting anything, and `deriveSwarmTopic` is pure. A null binding means the
 * harness is private/local-only — it has no topic, federates with nobody, and
 * therefore needs no keepalive at all (its local writes are PG-direct and the
 * outbox LISTEN already covers it).
 *
 * CYCLE NOTE: boot-all imports THIS module (to arm/disarm at its call sites), so
 * every reference back into boot-all here is a LAZY `await import` — the static
 * graph stays one-way. Do not hoist these to top-level imports.
 *
 * Everything is best-effort. The keepalive is an OPTIMISATION that makes
 * eviction safe to attempt; a failure to arm must never fail a boot, and is
 * reported so the caller can decline to defer rather than defer blindly (see
 * `armSubstrateWakeKeepalive`'s return).
 */

import {
  createSubstrateWakeGossip,
  type SubstrateWakeGossipHandle,
} from './substrate-wake-gossip';
import { deriveSwarmTopic, type SwarmBinding } from './derive-swarm-topic';

/** One armed harness — kept so a wake never has to PARSE a composite key back
 *  into (workspace, slug), which would be fragile for slugs containing the
 *  separator. */
interface ArmedHarness {
  workspaceId: string;
  harnessSlug: string;
}

/** The process-wide gossip family. Created on first arm, torn down by close. */
let gossip: SubstrateWakeGossipHandle | null = null;
/** In-flight creation, so concurrent arms share ONE gossip (and one DHT identity). */
let creating: Promise<SubstrateWakeGossipHandle | null> | null = null;
/** gossipKey → the harness it stands for. */
const armed = new Map<string, ArmedHarness>();

/** The gossip's opaque key for a harness. Never parsed — see ArmedHarness. */
const gossipKey = (workspaceId: string, harnessSlug: string): string =>
  `${workspaceId}\x00${harnessSlug}`;

/** Overrides the DEFAULT binding resolver (tests only). Needed because callers
 *  on the eviction path arm without passing a resolver, so a unit test
 *  otherwise falls through to the real PG read — which "fails safe" to
 *  'uncovered' and makes coverage tests pass for the WRONG reason. */
let defaultBindingResolverForTests:
  | ((workspaceId: string, harnessSlug: string) => Promise<SwarmBinding | null> | SwarmBinding | null)
  | null = null;

/** Swap in a fake gossip (tests). Never call from production code. */
export function _setSubstrateWakeGossipForTests(fake: SubstrateWakeGossipHandle | null): void {
  gossip = fake;
  creating = null;
}

/** Override the default binding resolver (tests). Never call from production code. */
export function _setDefaultBindingResolverForTests(
  fn:
    | ((workspaceId: string, harnessSlug: string) => Promise<SwarmBinding | null> | SwarmBinding | null)
    | null,
): void {
  defaultBindingResolverForTests = fn;
}

/** Reset all wiring state (tests). Never call from production code. */
export function _resetSubstrateWakeWiringForTests(): void {
  gossip = null;
  creating = null;
  armed.clear();
  defaultBindingResolverForTests = null;
}

/** Create (once) the process gossip family, bound to boot-all's residency probe
 *  and wake path. Returns null when the shared swarm is unavailable — a host
 *  with no swarm simply has no remote peers to hear from. */
async function ensureGossip(): Promise<SubstrateWakeGossipHandle | null> {
  if (gossip) return gossip;
  if (creating) return creating;
  creating = (async () => {
    try {
      const { getSharedSwarm } = await import('./swarm');
      const swarm = await getSharedSwarm();
      if (!swarm) return null;
      const bootAll = await import('./boot-all');
      const g = createSubstrateWakeGossip({
        swarm,
        isResident: (k) => {
          const a = armed.get(k);
          return a ? bootAll.isHarnessEngineResident(a.workspaceId, a.harnessSlug) : false;
        },
        onWake: ({ key: k }) => {
          const a = armed.get(k);
          if (!a) return;
          // boot-all owns the eligibility check + the actual re-boot; a wake for
          // a harness that is resident/ineligible is simply dropped there.
          bootAll.handleRemoteWakeForDarkHarness(a.workspaceId, a.harnessSlug);
        },
      });
      gossip = g;
      return g;
    } catch (e) {
      console.warn(
        '[substrate-wake] could not start the wake keepalive — dark harnesses will only wake on local access/writes:',
        e instanceof Error ? e.message : String(e),
      );
      return null;
    } finally {
      creating = null;
    }
  })();
  return creating;
}

export interface ArmSubstrateWakeOpts {
  /** Binding resolver seam (tests / callers that already resolved one).
   *  Default: boot-all's defaultResolveSwarmBinding — reads PG, boots nothing.
   *  Shaped to accept boot-all's `SwarmBindingResolver` verbatim (it may resolve
   *  `undefined` as well as `null`) so a caller can pass its own through. */
  resolveSwarmBinding?: (
    workspaceId: string,
    harnessSlug: string,
  ) => Promise<SwarmBinding | null | undefined> | SwarmBinding | null | undefined;
}

/**
 * The outcome of an arm attempt — a THREE-way verdict, not a boolean, because
 * the two failure-ish cases must drive opposite decisions:
 *
 *   'covered'    — joined the topic; safe to leave the engine dark.
 *   'not-needed' — private/local-only (no binding ⇒ no topic, no peers). There
 *                  is nothing to cover: its writes are PG-direct and the outbox
 *                  LISTEN already wakes it. ALSO safe to leave dark.
 *   'uncovered'  — it DOES federate but we could not arm (PG unreachable,
 *                  malformed binding, no swarm). NOT safe to leave dark.
 *
 * Collapsing the first two into one boolean is a trap worth naming: a caller
 * gating deferral on `covered` alone would stop deferring the private harnesses
 * P-010 defers today (a regression), while a caller gating on `!== false` would
 * defer a federating harness with no wake coverage (the unheard-remote-push hole
 * this whole slice exists to close). The rule is: defer unless 'uncovered'.
 */
export type ArmWakeVerdict = 'covered' | 'not-needed' | 'uncovered';

/**
 * Join this harness's federation topic WITHOUT booting its engine, so a peer
 * that comes online (or writes) can wake it. See {@link ArmWakeVerdict} for how
 * a caller should read the result.
 */
export async function armSubstrateWakeKeepalive(
  workspaceId: string,
  harnessSlug: string,
  opts: ArmSubstrateWakeOpts = {},
): Promise<ArmWakeVerdict> {
  const k = gossipKey(workspaceId, harnessSlug);
  try {
    const resolve =
      opts.resolveSwarmBinding ??
      defaultBindingResolverForTests ??
      (await import('./boot-all')).defaultResolveSwarmBinding;
    const binding = await resolve(workspaceId, harnessSlug);
    // Private / local-only: no topic, no peers, no keepalive needed.
    if (!binding) return 'not-needed';
    const topic = deriveSwarmTopic(binding);
    const g = await ensureGossip();
    if (!g) {
      // It federates, but we have no transport to hear a peer on.
      console.warn(
        `[substrate-wake] no swarm for ${workspaceId}::${harnessSlug} — federating harness is NOT covered by a remote wake`,
      );
      return 'uncovered';
    }
    armed.set(k, { workspaceId, harnessSlug });
    // watch() is idempotent per key and moves the key on a re-key.
    g.watch(k, topic);
    return 'covered';
  } catch (e) {
    armed.delete(k);
    console.warn(
      `[substrate-wake] arm failed for ${workspaceId}::${harnessSlug} — not covered by a remote wake:`,
      e instanceof Error ? e.message : String(e),
    );
    return 'uncovered';
  }
}

/** Convenience for the boot sweep: may this harness be left dark? True unless
 *  it federates and we failed to cover it. Mirrors {@link ArmWakeVerdict}'s rule
 *  in one place so no call site has to re-derive it. */
export function mayDeferOnWakeVerdict(verdict: ArmWakeVerdict): boolean {
  return verdict !== 'uncovered';
}

/**
 * Stop watching a harness's topic — call once its real engine is resident. The
 * engine's own swarm join supersedes the keepalive (and holds the corestore
 * replication the keepalive deliberately does not).
 */
export async function disarmSubstrateWakeKeepalive(
  workspaceId: string,
  harnessSlug: string,
): Promise<void> {
  const k = gossipKey(workspaceId, harnessSlug);
  if (!armed.delete(k)) return; // never armed — nothing to do
  try {
    await gossip?.unwatch(k);
  } catch {
    /* best-effort — a topic we can't leave is left to close() */
  }
}

/**
 * Broadcast "activity here" on a harness's topic — the live send side, called
 * after a local write is captured. Reaches only members CONCURRENTLY online
 * (see substrate-wake-gossip's header on why store-and-forward is P-013's).
 * No-op for a harness that isn't armed.
 */
export function announceSubstrateWakeActivity(workspaceId: string, harnessSlug: string): void {
  gossip?.announceActivity(gossipKey(workspaceId, harnessSlug));
}

/** Observability: which harnesses are currently held dark under a keepalive. */
export function substrateWakeKeepaliveStatus(): {
  armed: Array<{ workspaceId: string; harnessSlug: string }>;
  topicCount: number;
} {
  return {
    armed: [...armed.values()],
    topicCount: gossip?.topicCount ?? 0,
  };
}

/** Tear down the whole keepalive family (host shutdown). Idempotent. */
export async function closeSubstrateWakeKeepalive(): Promise<void> {
  const g = gossip;
  gossip = null;
  creating = null;
  armed.clear();
  try {
    await g?.close();
  } catch {
    /* best-effort */
  }
}
