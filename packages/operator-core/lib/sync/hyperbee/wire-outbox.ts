/**
 * wire-outbox — Stage 5 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * The per-harness boot seam: after a harness boots (boot-all.ts), bring its
 * feature/issue federation send-side fully online:
 *
 *   1. `backfillLocalState(handle, pg)` — one-time enqueue of existing local
 *      `*_consolidated` rows into the outbox (idempotent; the marker makes the
 *      second boot a no-op). BEST-EFFORT: a backfill failure must NOT block the
 *      drain (which federates ongoing writes); it's logged + swallowed.
 *   2. `startOutboxDrain(handle, pg)` — the LISTEN + poll drain loop that appends
 *      undrained outbox rows to the own log.
 *   3. register the drain's `stop()` as a `close()` hook on the handle, so the
 *      LISTEN connection + poll timer release exactly once on teardown without
 *      boot-all tracking a parallel stopper Map.
 *
 * WI-1942 (bounded backfill retry): `backfillLocalState`'s own enqueue-bail cap
 * (backfill-local-state.ts `DEFAULT_ENQUEUE_BAIL_CAP`) can trip on the FIRST boot
 * of any harness whose pre-existing (`*_consolidated` + friends) corpus exceeds
 * the cap — a very common case for an established harness. Before this fix, a
 * bail was silent to this caller (the return value was never inspected) and the
 * ONLY retry path was the NEXT full process boot — an UNBOUNDED wait on a
 * long-running process (hours/days), during which a late-joining peer's
 * pre-existing (historical) content federation never gets enqueued at all, while
 * ongoing (live-tail) writes federate normally via the already-running drain —
 * exactly the "historical entries apply minutes-to-never late, live-tail applies
 * in seconds" asymmetry the bug reported. We now inspect the result and, on a
 * bail, arm a BOUNDED periodic retry (within this same process) that re-attempts
 * the backfill on a fixed cadence until it stops bailing, closing the gap
 * without changing the bail cap's own protective semantics.
 *
 * Extracted as a standalone, dependency-injected helper purely for testability:
 * the production deps default to the real backfill + drain, and the unit test
 * passes fakes (no PG, no swarm). `boot-all.ts` calls
 * `wireOutboxForHarness(handle, pg)` with the defaults.
 */

import type postgres from 'postgres';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import type { BootedHarnessHandle } from './boot';
import { backfillLocalState as realBackfillLocalState, type BackfillResult } from './backfill-local-state';
import {
  startOutboxDrain as realStartOutboxDrain,
  type OutboxDrainHandle,
  type StartDrainOptions,
  type EpochEncryptCapability,
} from './outbox-drain';
import { fanoutOutboxRow } from './fanout-projection';
import { hubListen, listenHubEnabled } from '../../pg-listen-hub';
import { buildHiveRekeyBootDeps } from './hive-epoch-boot-deps';
import type { HiveRekeyBootDeps } from './hive-epoch-boot-deps';
import { registerPlanClobberNotifier } from './plan-clobber-notify';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { pinModuleState } from '@papercusp/module-singleton';

/** WI-1942 default cadence (ms) for retrying a BAILED backfill within this same
 *  process, instead of only on the next full boot. Deliberately a few minutes —
 *  the bail check runs several COUNT(*) queries across every unswept target, so
 *  this must stay cheap/rare, not a tight poll. */
export const DEFAULT_BACKFILL_RETRY_MS = 2 * 60 * 1000;

/** System sender for the P-007 plan-clobber notice (mirrors LEARNING_HEALTH_IDENTITY). */
const PLAN_CLOBBER_IDENTITY: AgentIdentity = {
  ownerId: 'plan-clobber-watch',
  ownerLabel: 'plan-clobber-watch',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export interface WireOutboxDeps {
  backfillLocalState?: (handle: BootedHarnessHandle, pg: postgres.Sql) => Promise<BackfillResult>;
  startOutboxDrain?: (handle: BootedHarnessHandle, pg: postgres.Sql, opts?: StartDrainOptions) => OutboxDrainHandle;
  /** WI-40905 lifecycle seam: tests model private-at-boot → Hive-after-rekey
   *  without process-global identity/registry state. Production uses the real
   *  boot-dependency composer. */
  buildHiveRekeyBootDeps?: (opts: { workspaceId: string; harnessSlug: string }) => Promise<HiveRekeyBootDeps | null>;
  /** WI-3684 send-side twin: threaded to `startOutboxDrain`'s `onSessionClosed`
   *  (see outbox-drain.ts) — fires once the drain self-stops on a permanently
   *  closed own-log session, so `ensureSendSideWired` (boot-all.ts) can un-mark
   *  this harness as wired and re-wire on the next boot pass. */
  onSessionClosed?: () => void;
  /** WI-1942: cadence (ms) for retrying a BAILED backfill within this process.
   *  `<= 0` disables the retry (restores the legacy next-boot-only behavior).
   *  Default {@link DEFAULT_BACKFILL_RETRY_MS}. Tests inject a small value +
   *  fake timers to drive it deterministically. */
  backfillRetryMs?: number;
}

interface EpochEncryptRefreshState {
  current(): EpochEncryptCapability | undefined;
  refresh(): Promise<boolean>;
}

/**
 * WI-40905: the drain is keyed by the booted handle, so keep its refreshable
 * encryption state keyed the same way. Pin the WeakMap across duplicate module
 * evaluation: boot-all's residency registry is already pinned for this exact
 * same-realm split class, and a second wire-outbox module record must not make a
 * live drain invisible to the re-key hook that needs to refresh it.
 */
const { epochEncryptByHandle, epochEncryptByScope } = pinModuleState(
  '@papercusp/operator-core.hyperbeeWireOutbox',
  () => ({
    epochEncryptByHandle: new WeakMap<BootedHarnessHandle, EpochEncryptRefreshState>(),
    // WI-40905 exact witness: production re-key can re-enter through an
    // equivalent BootedHarnessHandle facade for the same live sidecar store.
    // Object identity is therefore not a durable lookup key for the drain's
    // controller. Keep the handle WeakMap for the common path, plus the same
    // process-global scope key boot-all/send-side idempotence already uses.
    epochEncryptByScope: new Map<string, EpochEncryptRefreshState>(),
  }),
);

function epochEncryptScope(handle: BootedHarnessHandle): string {
  return `${handle.workspaceId}::${handle.harnessSlug}`;
}

/**
 * Refresh the epoch-encrypt capability owned by an already-running outbox
 * drain. Returns false when this handle has no wire-outbox controller yet (the
 * caller should continue into normal first-time wiring); true means the
 * controller existed and the refresh attempt completed.
 *
 * Null is NOT allowed to erase a previously-good capability. Null means the
 * composer definitively resolved an off/non-Hive scope; readiness ambiguity
 * rejects. Either way, a live encrypted drain is never downgraded to plaintext.
 * Initial private-harness null still stays absent.
 */
export async function refreshOutboxEpochEncryptForHarness(handle: BootedHarnessHandle): Promise<boolean> {
  const state = epochEncryptByHandle.get(handle) ?? epochEncryptByScope.get(epochEncryptScope(handle));
  if (!state) return false;
  // Return encryption READINESS, not merely "a controller object existed".
  // Callers can now distinguish a successful refresh from the dangerous
  // PRE-Hive/null state instead of silently treating both as refreshed.
  return state.refresh();
}

function createEpochEncryptRefreshState(
  handle: BootedHarnessHandle,
  buildDeps: NonNullable<WireOutboxDeps['buildHiveRekeyBootDeps']>,
): EpochEncryptRefreshState {
  let current: EpochEncryptCapability | undefined;
  // Serialize every requested refresh instead of coalescing it away: if a boot
  // refresh and a re-key refresh race, the later request must observe the later
  // committed registry state.
  let refreshTail: Promise<void> = Promise.resolve();

  return {
    current: () => current,
    refresh: () => {
      const run = refreshTail.then(async () => {
        const next = await buildDeps({
          workspaceId: handle.workspaceId,
          harnessSlug: handle.harnessSlug,
        });
        if (next) current = next.epochEncrypt;
        return current !== undefined;
      });
      refreshTail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}

/**
 * Wire feature/issue federation send-side for one booted harness. Returns the
 * drain handle (also registered as a `close()` hook so teardown stops it).
 */
export async function wireOutboxForHarness(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  deps: WireOutboxDeps = {},
): Promise<OutboxDrainHandle> {
  // P-007: register the plan-clobber → human-notify listener (idempotent — the
  // clobber emitter is process-global, so a per-harness boot collapses to one
  // listener). A raced plan edit then surfaces a coord notice to the human
  // ("your edit raced X's") instead of a silent LWW loss. Best-effort send.
  registerPlanClobberNotifier((notice) =>
    sendMessage(PLAN_CLOBBER_IDENTITY, {
      to: ['human'],
      summary: notice.summary,
      body: notice.body,
      plan_slug: notice.planSlug,
      category: 'clobber',
    }).then(
      () => {},
      () => {},
    ),
  );

  const backfill = deps.backfillLocalState ?? realBackfillLocalState;
  // Re-key encrypt-on-capture (C-001, shared-hive-rekey-2026-06-19): the
  // private-at-boot → Hive-after-rekey lifecycle means boot-time null is NOT a
  // permanent answer. Own a refreshable controller beside the drain; re-key
  // hooks update it in place, and startOutboxDrain resolves its current value at
  // each selected row's encryption point. The drain/LISTEN itself is still
  // started once.
  const rekeyState = createEpochEncryptRefreshState(handle, deps.buildHiveRekeyBootDeps ?? buildHiveRekeyBootDeps);
  epochEncryptByHandle.set(handle, rekeyState);
  const scope = epochEncryptScope(handle);
  epochEncryptByScope.set(scope, rekeyState);
  try {
    await rekeyState.refresh();
  } catch (e) {
    // No drain exists yet, so this controller must not remain discoverable as if
    // a live wire-outbox had been created. A later boot pass will retry cleanly.
    if (epochEncryptByHandle.get(handle) === rekeyState) epochEncryptByHandle.delete(handle);
    if (epochEncryptByScope.get(scope) === rekeyState) epochEncryptByScope.delete(scope);
    throw e;
  }

  const start = deps.startOutboxDrain ?? realStartOutboxDrain;
  const startOpts: StartDrainOptions = {
    fanout: fanoutOutboxRow,
    resolveEpochEncrypt: rekeyState.current,
    onSessionClosed: deps.onSessionClosed,
    // P-008 (shared-hive-cross-machine-scale-10k): this is the PRODUCTION seam,
    // so it is the one place that may safely route the drain's LISTEN through
    // the shared hub — it runs against the real harness-admin database the hub
    // itself connects to (`getHarnessAdminUrl()`). Without this, `pg.listen`
    // reserves a dedicated PG backend PER HARNESS on the single global
    // `substrate_outbox` channel: N harnesses = N connections, each discarding
    // the other N-1 harnesses' payloads. The hub multiplexes them onto ONE
    // ref-counted backend. Kill-switch: PAPERCUSP_LISTEN_HUB=0 (also OFF by
    // default on laptop/workstation hosts) restores the per-harness listener.
    listen: listenHubEnabled() ? hubListen : undefined,
  };

  // (1) Best-effort one-time backfill. A failure here must not stop the drain —
  // the backfill catches up rows that PRE-DATE federation; the drain handles
  // every ONGOING write, which is the more important guarantee. The marker is
  // only written on a successful run, so a transient failure re-runs next boot.
  const attemptBackfill = async (): Promise<BackfillResult | null> => {
    try {
      return await backfill(handle, pg);
    } catch (e) {
      console.error(
        `[wire-outbox] backfillLocalState failed for ${handle.workspaceId}::${handle.harnessSlug} ` +
          `(continuing — drain still starts):`,
        e instanceof Error ? e.message : String(e),
      );
      return null;
    }
  };

  const initialResult = await attemptBackfill();

  // WI-1942: a BAIL (candidate corpus over the enqueue cap) previously had no
  // retry within this process — only the next full boot re-attempted it, an
  // unbounded wait during which a late-joining peer never receives pre-existing
  // (historical) content while ongoing writes federate normally. Arm a bounded
  // periodic retry until a re-attempt stops bailing.
  const backfillRetryMs = deps.backfillRetryMs ?? DEFAULT_BACKFILL_RETRY_MS;
  if (initialResult?.bailed && backfillRetryMs > 0) {
    let retrying = false;
    const retryTimer = managedSetInterval(
      `hyperbee-backfill-retry:${handle.workspaceId}:${handle.harnessSlug}`,
      backfillRetryMs,
      () => {
        if (retrying) return; // don't overlap a slow retry with the next tick
        retrying = true;
        void attemptBackfill()
          .then((result) => {
            // Stop once a re-attempt actually ran without bailing (success OR
            // already-skipped) — a thrown/null result keeps retrying.
            if (result && !result.bailed) retryTimer.stop();
          })
          .finally(() => {
            retrying = false;
          });
      },
      { category: 'lifecycle', instanced: true },
    );
    handle.registerCloseHook(() => retryTimer.stop());
  }

  // (2) Start the drain loop.
  const drain = start(handle, pg, startOpts);

  // (3) Register the stopper as a close-hook so shutdown releases the LISTEN
  // connection + poll timer exactly once (the handle drains its hook set once).
  handle.registerCloseHook(() => {
    if (epochEncryptByScope.get(scope) === rekeyState) epochEncryptByScope.delete(scope);
    return drain.stop();
  });

  return drain;
}
