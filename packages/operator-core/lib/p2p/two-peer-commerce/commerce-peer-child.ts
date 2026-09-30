/**
 * commerce-peer-child.ts — ONE peer machine of a shared Hive, as a REAL OS
 * process, exchanging P2P commerce and settlement events (P-036).
 *
 * P-036 asks for two peers that are "not in-process". That word is load-bearing
 * and rules out the obvious rig: `sync/hyperbee/__tests__/_cross-peer-rig.ts`
 * runs genuinely separate corestores, swarms and databases, but all inside ONE
 * vitest worker, so a whole class of failure — module-level singletons shared
 * between "peers", a merge cursor that only converges because both sides share
 * a heap — is invisible to it by construction. This binary is the shape that
 * cannot fake convergence: a separate process, a separate corestore root, its
 * own Hyperswarm, talking over a real DHT.
 *
 * It is the commerce sibling of `deployment/p2p-perf-tier3/loop-agent.ts` and
 * deliberately reuses that file's proven conventions — env-carried config,
 * ndjson on stdout, explicit `joinPeer` mesh formation, `partition on|off` as
 * an injected transport fault — so the two rigs stay legible as one family.
 * What it drops is the whole authority/claim leg: commerce needs no HTTP RPC,
 * because under D-055 the hive log carries CLAIMS and the escrow authority
 * (`escrow-authority.ts`) is what decides which of them get paid.
 *
 * FRESH STORE. D-057 records that the dogfood hive log has no retention and is
 * 46 GB on the dev box. Every peer here boots on a caller-supplied throwaway
 * corestore root, and the launcher makes one per peer per run.
 *
 * PARTITION. `partition on` buffers inbound remote ops at this peer's
 * projection boundary and `partition off` replays them, which is the same
 * injected-fault posture loop-agent documents ("the REAL network cut on metal
 * is nftables, layered on top by the test"). The observable property is the one
 * that matters and is not weakened by the injection point: while cut, this
 * peer's rollup does not contain the other peer's claims; after the heal, both
 * peers' rollups are identical.
 *
 * Launch: `node --import tsx <this file>` with JSON config in COMMERCE_PEER
 * (spawned by commerce-peer-launcher.ts — never run by hand).
 *
 * Wire protocol (ndjson, child stdout → parent):
 *   {evt:'ready', peerId, logKey, swarmKey}     — store + substrate up
 *   {evt:'admitted', size}                      — mesh formed (size ≥ meshSize)
 *   {evt:'emitted', eventId, sequence}          — a commerce fact left this peer
 *   {evt:'observed', eventId}                   — a REMOTE commerce fact landed
 *   {evt:'partition-ack', partitioned, buffered}
 *   {evt:'state', seq, ...}                     — `dump` response
 *   {evt:'error', message}                      — fatal; exits 1
 * Parent stdin → child: `peers <hex,…>`, `emit <json>`, `partition on|off`,
 * `dump <seq>`, `stop`.
 */
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../../sync/hyperbee/boot';
import { closeHarnessStore } from '../../sync/hyperbee/corestore';
import type { OpEnvelope } from '../../sync/hyperbee/op-envelope-types';
import type { SwarmBinding } from '../../sync/hyperbee/derive-swarm-topic';
import type { HyperswarmLike } from '../../sync/hyperbee/swarm';
import { makePeerIdentity } from '../../sync/hyperbee/perf/fixture';
import { reduceCommerceEvents, type CommerceEvent } from '../commerce-events';
import { createPaymentChannel } from '../payment-channel';
import { perUseRollup } from '../../cupboard/ledger-p2p-bridge';
import { adjudicateEscrowClaims, readUsageClaims } from './escrow-authority';

/** The hyperbee table commerce facts ride on. */
export const COMMERCE_TABLE = 'commerce-event';

export interface CommercePeerConfig {
  readonly peerIndex: number;
  /** Stable machine label — this is what tells two forked claims apart. */
  readonly peerId: string;
  /** Throwaway corestore root. MUST NOT be a dogfood hive store (D-057). */
  readonly root: string;
  readonly workspaceId: string;
  readonly harnessSlug: string;
  /** Base64 hive pubkey; every peer of one run shares it (the federation topic). */
  readonly hivePubkey: string;
  /** Local-testnet DHT bootstrap. Absent/empty → the PUBLIC DHT (metal posture). */
  readonly bootstrap?: Array<{ host: string; port: number }>;
  /** Peers this one must see before reporting `admitted`. */
  readonly meshSize: number;
  /** The seller escrow every claim in this run is adjudicated against. */
  readonly channelId: string;
  readonly escrowMicros: string;
  readonly mergePollMs?: number;
}

/** The converged view one peer reports — the thing two peers must agree on. */
export interface CommercePeerState {
  readonly peerId: string;
  readonly acceptedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
  readonly conflicts: ReadonlyArray<{ streamId: string; sequence: number; eventIds: string[]; reason: string }>;
  readonly invalid: ReadonlyArray<{ eventId: string | null; code: string }>;
  /** Per-channel claim-vs-finality position (`perUseRollup`). */
  readonly rollup: ReturnType<typeof perUseRollup>;
  /** Worker + chain verdict over the converged claims (D-055). */
  readonly escrow: {
    readonly dispositions: unknown;
    readonly admittedMicros: string;
    readonly escrowRemainingMicros: string;
    readonly doubleSpendCount: number;
    readonly settledMicros: string;
  };
  readonly bufferedByPartition: number;
}

const out = (o: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

/**
 * Fold this peer's whole observed commerce stream into the converged state.
 *
 * Exported because it is the ONE fold both the child and any in-process
 * assertion must share: two peers "agreeing" is only meaningful if they ran
 * identical code over their own observations.
 */
export function foldPeerState(input: {
  readonly peerId: string;
  readonly events: readonly CommerceEvent[];
  readonly channelId: string;
  readonly escrowMicros: bigint;
  readonly nowMs: number;
  readonly bufferedByPartition: number;
}): CommercePeerState {
  const reduction = reduceCommerceEvents(input.events);
  const { claims } = readUsageClaims(reduction.accepted);
  const verdict = adjudicateEscrowClaims({
    channel: createPaymentChannel(input.channelId, 'evm-x402', input.escrowMicros),
    claims,
    nowMs: input.nowMs,
  });
  return {
    peerId: input.peerId,
    acceptedEventIds: reduction.accepted.map((e) => e.eventId),
    duplicateEventIds: [...reduction.duplicates].sort(),
    conflicts: reduction.conflicts.map((c) => ({ ...c, eventIds: [...c.eventIds] })),
    invalid: reduction.invalid,
    rollup: perUseRollup(reduction.accepted),
    escrow: {
      dispositions: verdict.dispositions,
      admittedMicros: verdict.admittedMicros,
      escrowRemainingMicros: verdict.escrowRemainingMicros,
      doubleSpendCount: verdict.doubleSpend.length,
      settledMicros: verdict.channel.settledMicros.toString(),
    },
    bufferedByPartition: input.bufferedByPartition,
  };
}

async function main(): Promise<void> {
  const raw = process.env.COMMERCE_PEER;
  if (!raw) throw new Error('commerce-peer-child: COMMERCE_PEER config is required');
  const cfg = JSON.parse(raw) as CommercePeerConfig;
  if (!cfg.peerId || !cfg.root || !cfg.hivePubkey || !cfg.channelId) {
    throw new Error('commerce-peer-child: config missing peerId/root/hivePubkey/channelId');
  }
  const escrowMicros = BigInt(cfg.escrowMicros);

  /** Everything this peer has observed, own writes included. Ids may repeat: the
   *  reducer owns idempotency, and hiding duplicates here would hide the very
   *  re-delivery a healed partition is supposed to produce. */
  const observed: CommerceEvent[] = [];
  /** Remote ops withheld while partitioned, replayed on heal. */
  const partitionBuffer: CommerceEvent[] = [];
  let partitioned = false;
  let ownSequence = 0;

  const record = (event: CommerceEvent, remote: boolean): void => {
    observed.push(event);
    if (remote) out({ evt: 'observed', eventId: event.eventId });
  };

  const identity = makePeerIdentity(`commerce-${cfg.peerIndex}`, 2_000 + cfg.peerIndex);
  const swarm = new Hyperswarm(
    cfg.bootstrap && cfg.bootstrap.length ? { bootstrap: cfg.bootstrap } : {},
  ) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
    keyPair: { publicKey: Buffer };
    joinPeer(publicKey: Buffer): void;
  };

  const binding: SwarmBinding = { kind: 'hive', hive_pubkey: cfg.hivePubkey };
  let handle: BootedHarnessHandle | null = null;
  try {
    handle = await bootHarnessSubstrate({
      workspaceRoot: cfg.root,
      workspaceId: cfg.workspaceId,
      harnessSlug: cfg.harnessSlug,
      swarmBinding: binding,
      swarmOverride: swarm,
      verifyBindingOverride: async () => 'verified',
      applyOverride: async (op: OpEnvelope) => {
        const view = op as unknown as { type?: string; table?: string; value?: unknown };
        if (view.type !== 'put' || view.table !== COMMERCE_TABLE) return true;
        const event = view.value as CommerceEvent;
        // The injected transport fault: while cut, the fact is held rather than
        // projected. It is NOT dropped — a dropped fact would make the heal
        // untestable, and a real network cut does not destroy the sender's log.
        if (partitioned) partitionBuffer.push(event);
        else record(event, true);
        return true;
      },
      mergePollMs: cfg.mergePollMs ?? 400,
      pendingRetryMs: 1_000,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: identity.override,
    });

    out({
      evt: 'ready',
      peerId: cfg.peerId,
      logKey: handle.ownLog.keyHex,
      swarmKey: swarm.keyPair.publicKey.toString('hex'),
    });

    let admittedReported = false;
    const reportAdmitted = (): void => {
      if (!admittedReported && handle!.admitted.size >= cfg.meshSize) {
        admittedReported = true;
        out({ evt: 'admitted', size: handle!.admitted.size });
      }
    };
    const offAdmitted = handle.onAdmitted(reportAdmitted);
    reportAdmitted();

    /** Append a signed commerce fact to the own log AND project it locally
     *  (own ops are not read-merged back — same shape as loop-agent's appendOp). */
    const emit = async (event: CommerceEvent): Promise<void> => {
      const op = {
        type: 'put' as const,
        table: COMMERCE_TABLE,
        hbKey: event.eventId,
        value: event,
        ts: Date.now(),
        schema_version: 1,
        writerPubkey: identity.devicePubkey,
      };
      await handle!.append(op);
      record(event, false);
      out({ evt: 'emitted', eventId: event.eventId, sequence: ownSequence++ });
    };

    let stopping = false;
    process.stdin.setEncoding('utf8');
    let stdinBuf = '';
    process.stdin.on('data', (chunk: string) => {
      stdinBuf += chunk;
      for (;;) {
        const nl = stdinBuf.indexOf('\n');
        if (nl < 0) break;
        const line = stdinBuf.slice(0, nl).trim();
        stdinBuf = stdinBuf.slice(nl + 1);
        if (!line) continue;
        void handleLine(line);
      }
    });

    const handleLine = async (line: string): Promise<void> => {
      try {
        if (line === 'stop') {
          stopping = true;
          return;
        }
        if (line.startsWith('peers ')) {
          for (const hex of line.slice(6).split(',').map((s) => s.trim()).filter(Boolean)) {
            const key = Buffer.from(hex, 'hex');
            if (key.length === 32 && !key.equals(swarm.keyPair.publicKey)) swarm.joinPeer(key);
          }
          return;
        }
        if (line.startsWith('partition ')) {
          const next = line.endsWith('on');
          if (partitioned && !next) {
            for (const event of partitionBuffer.splice(0)) record(event, true);
          }
          partitioned = next;
          out({ evt: 'partition-ack', partitioned, buffered: partitionBuffer.length });
          return;
        }
        if (line.startsWith('emit ')) {
          await emit(JSON.parse(line.slice(5)) as CommerceEvent);
          return;
        }
        if (line.startsWith('dump')) {
          const seq = Number(line.slice(4).trim() || '0');
          const state = foldPeerState({
            peerId: cfg.peerId,
            events: observed,
            channelId: cfg.channelId,
            escrowMicros,
            // A FIXED clock: two peers must fold to the same verdict, and a
            // wall-clock read would make voucher expiry differ between them.
            nowMs: 0,
            bufferedByPartition: partitionBuffer.length,
          });
          out({ evt: 'state', seq, ...state });
          return;
        }
        out({ evt: 'error', message: `unknown command '${line}'` });
      } catch (e) {
        out({ evt: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    };

    while (!stopping) await new Promise((r) => setTimeout(r, 100));
    offAdmitted();
  } finally {
    try {
      await handle?.close();
      await closeHarnessStore({ workspaceRoot: cfg.root, harnessSlug: cfg.harnessSlug });
    } catch {
      /* teardown must not mask the run's own failure */
    }
    try {
      await swarm.destroy();
    } catch {
      /* idem */
    }
  }
}

// Only run when executed as a binary; importing this module (for its types and
// `foldPeerState`) must never spawn a swarm.
if (process.env.COMMERCE_PEER) {
  main().catch((e: unknown) => {
    out({ evt: 'error', message: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
