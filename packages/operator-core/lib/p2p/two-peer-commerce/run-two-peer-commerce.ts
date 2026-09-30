/**
 * run-two-peer-commerce.ts — the P-036 production door.
 *
 * Drives TWO REAL PEER PROCESSES (never in-process) through the offline
 * convergence and double-spend end-to-end scenario, and returns a structured
 * verdict. It is the headless two-host extension of the P-019 pilot suite:
 * P-019 composed the shipped commerce modules inside one process and asserted
 * the properties that only exist at the SEAMS between them; this runner asserts
 * the properties that only exist at the seam between two MACHINES, which no
 * single-process composition can reach — a claim that converges, a partition
 * that heals, and an escrow that two peers who never spoke agree about.
 *
 * WHAT IT PROVES, AND WHERE EACH PROPERTY LIVES
 *
 *   mesh-formed              two separate OS processes federate over a real DHT
 *   partitioned-divergence   while cut, neither peer holds the other's claim
 *   converged-after-heal     after the heal both peers' folds are IDENTICAL
 *   duplicate-receipt        re-delivery is idempotent; claimed money unchanged
 *   conflict-quarantined     contradictory facts are quarantined, not merged
 *   double-spend-refused     the escrow admits ONE forked claim (D-055)
 *   claim-is-not-finality    claimed → pending → settled are three states
 *
 * The first three are the hive log's job; `double-spend-refused` is the Worker
 * and chain's, and keeping them in one report is the point — D-055 puts those
 * two authorities in different places, so a run that only checked one would
 * pass while the system was wrong.
 *
 * SECRETS. The live rail's `PAYMENT_CHANNEL_*` credentials are owner-gated
 * under P-038, so this runner injects `createDeterministicFacilitator`. That
 * bounds the claim: the settlement STATE MACHINE is exercised for real, the
 * live rail's own behaviour is not.
 *
 * Run it: `npm run p2p:two-peer-commerce` (or
 * `node --import tsx packages/operator-core/lib/p2p/two-peer-commerce/run-two-peer-commerce.ts`).
 * `--json` prints the machine-readable report; exit code is 0 only if every
 * scenario passed.
 */
import { generateKeyPairSync, randomBytes, sign as nodeSign, createHash } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import { isCliEntry } from '../../util/cli-entry';
import type { ClaimAgentHandle } from '../../deployment/p2p-perf-tier3/claim-launcher';
import { commerceEventSigningBytes, type CommerceEvent } from '../commerce-events';
import { createPaymentChannel } from '../payment-channel';
import { revenueSplitManifest } from '../revenue-settlement';
import {
  assessClaimFinality,
  buildSettlementProofEvent,
  planBatchSettlement,
  type EvmSettlementConfig,
} from '../evm-settlement';
import type { CumulativePaymentVoucher } from '../microcharge';
import { buildUsageReceiptEvent } from './escrow-authority';
import { localCommercePeerLauncher, type CommercePeerLauncher } from './commerce-peer-launcher';
import type { CommercePeerConfig, CommercePeerState } from './commerce-peer-child';
import { createDeterministicFacilitator } from './deterministic-facilitator';

export const CHANNEL_ID = 'chan-p036';
export const PAYER = 'gh:buyer';
export const SELLER = 'gh:seller';
export const RELEASE_REF = 'release:widget@1.0.0';
/** Deliberately smaller than the two forked claims together — that IS the fork. */
export const DEFAULT_ESCROW_MICROS = 12_000n;
/**
 * Floor and ceiling for the observation window the partition is judged over.
 *
 * The window is NOT a constant: it is MEASURED each run (see the
 * `propagates-without-partition` control) and then multiplied, because a fixed
 * guess is exactly how a partition assertion goes vacuous. The first green run
 * of this rig used a flat 2s and passed `partitioned-divergence`; the control
 * added immediately afterwards showed real propagation here is SLOWER than 2s,
 * so that pass had been measuring impatience, not a cut.
 */
export const PROPAGATION_FLOOR_MS = 4_000;
export const PROPAGATION_SAFETY_FACTOR = 3;
export const PROPAGATION_MEASURE_TIMEOUT_MS = 120_000;

export interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface TwoPeerCommerceReport {
  readonly ok: boolean;
  readonly peerIds: readonly string[];
  readonly scenarios: readonly ScenarioResult[];
  /** Each peer's final converged fold — the evidence behind every verdict. */
  readonly finalStates: readonly CommercePeerState[];
}

export interface TwoPeerCommerceOptions {
  /** Injected for a real two-HOST run (sshCommercePeerLauncher). Default: local processes. */
  readonly launcher?: CommercePeerLauncher;
  /** Absent → this runner stands up its OWN local testnet DHT. */
  readonly bootstrap?: Array<{ host: string; port: number }>;
  readonly escrowMicros?: bigint;
  readonly log?: (line: string) => void;
  readonly readyTimeoutMs?: number;
  readonly meshTimeoutMs?: number;
  readonly convergeTimeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fixtures

const eventSigner = (() => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return (event: Omit<CommerceEvent, 'signature'>): CommerceEvent => ({
    ...event,
    signature: nodeSign(null, commerceEventSigningBytes(event), privateKey).toString('base64'),
  });
})();

function voucherFor(input: {
  readonly usageNonce: string;
  readonly cumulativeClaimMicros: bigint;
  readonly splitManifestHash: string;
}): CumulativePaymentVoucher {
  return {
    channelId: CHANNEL_ID,
    payer: PAYER,
    seller: SELLER,
    releaseRef: RELEASE_REF,
    usageNonce: input.usageNonce,
    meterQuantity: 10n,
    pricePerUnitMicros: input.cumulativeClaimMicros / 10n,
    priceVersion: 'price-v1',
    splitManifestHash: input.splitManifestHash,
    // The child folds at a FIXED nowMs of 0 so two peers cannot disagree about
    // expiry; the voucher window simply has to contain that instant.
    expiresAtMs: 1_000_000,
    cumulativeClaimMicros: input.cumulativeClaimMicros,
    signature: `voucher-sig-${input.usageNonce}`,
  };
}

// -------------------------------------------------------------------- driver

async function dump(handle: ClaimAgentHandle, seq: number, timeoutMs: number): Promise<CommercePeerState> {
  handle.send(`dump ${seq}`);
  const evt = await handle.waitFor((e) => e.evt === 'state' && Number((e as { seq?: unknown }).seq) === seq, timeoutMs);
  if (!evt) throw new Error(`peer ${handle.index} did not answer dump ${seq} within ${timeoutMs}ms`);
  return evt as unknown as CommercePeerState;
}

/** Poll both peers until `predicate` holds for every peer, or time out. */
async function waitForConvergence(
  handles: readonly ClaimAgentHandle[],
  seqBase: number,
  predicate: (states: readonly CommercePeerState[]) => boolean,
  timeoutMs: number,
): Promise<readonly CommercePeerState[]> {
  const deadline = Date.now() + timeoutMs;
  let seq = seqBase;
  let last: readonly CommercePeerState[] = [];
  for (;;) {
    last = await Promise.all(handles.map((h) => dump(h, seq, 15_000)));
    seq += 1;
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await sleep(500);
  }
}

/** Both peers folded the SAME facts — the convergence property, stated once. */
function foldsAgree(states: readonly CommercePeerState[]): boolean {
  if (states.length < 2) return false;
  const key = (s: CommercePeerState): string =>
    JSON.stringify({ accepted: [...s.acceptedEventIds].sort(), rollup: s.rollup, escrow: s.escrow });
  const first = key(states[0]);
  return states.every((s) => key(s) === first);
}

const check = (name: string, ok: boolean, detail: string): ScenarioResult => ({ name, ok, detail });

export async function runTwoPeerCommerce(
  opts: TwoPeerCommerceOptions = {},
): Promise<TwoPeerCommerceReport> {
  const log = opts.log ?? (() => {});
  const escrowMicros = opts.escrowMicros ?? DEFAULT_ESCROW_MICROS;
  const scenarios: ScenarioResult[] = [];

  const testnet = opts.bootstrap ? null : await createTestnet(3);
  const bootstrap = opts.bootstrap ?? (testnet as { bootstrap: Array<{ host: string; port: number }> }).bootstrap;
  const launcher = opts.launcher ?? localCommercePeerLauncher({ count: 2, log });
  const hivePubkey = randomBytes(32).toString('base64');
  const workspaceId = `ws-p036-${randomBytes(4).toString('hex')}`;
  const harnessSlug = 'two-peer-commerce';
  let finalStates: readonly CommercePeerState[] = [];

  try {
    const handles = launcher.slots.map((slot, i) => {
      const cfg: CommercePeerConfig = {
        peerIndex: i,
        peerId: `machine-${String.fromCharCode(97 + i)}`,
        root: slot.root,
        workspaceId,
        harnessSlug,
        hivePubkey,
        bootstrap,
        meshSize: launcher.slots.length,
        channelId: CHANNEL_ID,
        escrowMicros: escrowMicros.toString(),
      };
      return slot.launch(cfg);
    });
    const [peerA, peerB] = handles;

    // ── mesh ────────────────────────────────────────────────────────────────
    const readys = await Promise.all(handles.map((h) => h.waitFor('ready', opts.readyTimeoutMs ?? 120_000)));
    if (readys.some((r) => !r)) throw new Error('a peer process never reported ready (see stderr log)');
    const swarmKeys = readys.map((r) => String((r as { swarmKey?: unknown }).swarmKey ?? '')).filter(Boolean);
    // Announces ride per-connection channels, so a full mesh needs an explicit
    // joinPeer per pair — concurrent topic joins race the DHT announce.
    for (const h of handles) h.send(`peers ${swarmKeys.join(',')}`);
    const admits = await Promise.all(handles.map((h) => h.waitFor('admitted', opts.meshTimeoutMs ?? 120_000)));
    scenarios.push(
      check(
        'mesh-formed',
        admits.every(Boolean),
        `${admits.filter(Boolean).length}/${handles.length} peer processes admitted each other over the DHT`,
      ),
    );
    if (!admits.every(Boolean)) {
      return { ok: false, peerIds: [], scenarios, finalStates: [] };
    }

    // ── positive control: propagation IS fast, un-cut ───────────────────────
    // Without this the `partitioned-divergence` verdict below could pass
    // vacuously — two peers that simply had not synced yet look exactly like
    // two peers that were partitioned, and a rig whose central assertion is
    // satisfied by a slow network is measuring nothing. So: federate one fact
    // with NO partition in force and require it to land inside the SAME window
    // the cut is later observed over. An `offer` is used deliberately — it is a
    // kind `perUseRollup` ignores, so the control cannot perturb the money.
    const probe = eventSigner({
      eventId: 'probe:propagation',
      streamId: 'channel:chan-probe',
      kind: 'offer',
      version: 1,
      issuer: SELLER,
      sequence: 0,
      occurredAtMs: 500,
      idempotencyKey: 'probe-propagation',
      payload: { releaseRef: RELEASE_REF },
    });
    peerA.send(`emit ${JSON.stringify(probe)}`);
    await peerA.waitFor((e) => e.evt === 'emitted' && e.eventId === probe.eventId, 20_000);

    // The emitter must accept its OWN probe before the other peer's silence can
    // mean anything. Without this, an invalid or mis-folded probe presents
    // exactly as a dead mesh — the two failures need entirely different fixes,
    // so the control says which one it saw rather than blaming the network.
    const selfFold = await dump(peerA, -1, 15_000);
    const acceptedLocally = selfFold.acceptedEventIds.includes(probe.eventId);

    const startedAt = Date.now();
    let observedAfterMs = -1;
    if (acceptedLocally) {
      for (let seq = 0; Date.now() - startedAt < PROPAGATION_MEASURE_TIMEOUT_MS; seq += 1) {
        const control = await dump(peerB, seq, 15_000);
        if (control.acceptedEventIds.includes(probe.eventId)) {
          observedAfterMs = Date.now() - startedAt;
          break;
        }
        await sleep(250);
      }
    }
    // The cut is judged over a window several times the MEASURED latency, so
    // "nothing arrived while partitioned" can never be explained by the mesh
    // simply being slower than a number someone typed.
    const propagationWindowMs = Math.max(PROPAGATION_FLOOR_MS, observedAfterMs * PROPAGATION_SAFETY_FACTOR);
    scenarios.push(
      check(
        'propagates-without-partition',
        observedAfterMs >= 0,
        observedAfterMs >= 0
          ? `an un-cut fact reached the other peer in ${observedAfterMs}ms; the partition below is judged over ${propagationWindowMs}ms`
          : acceptedLocally
            ? `the probe was accepted on the EMITTER but never reached the other peer within ${PROPAGATION_MEASURE_TIMEOUT_MS}ms — replication, not the probe, is what failed; no divergence result from this run can be trusted`
            : `the EMITTER never accepted its own probe, so this run measured nothing about the mesh — the probe itself is invalid or mis-folded (peerA accepted ${selfFold.acceptedEventIds.length} event(s))`,
      ),
    );
    if (observedAfterMs < 0) {
      return { ok: false, peerIds: [], scenarios, finalStates: [] };
    }

    // ── partition, then each machine bills offline ───────────────────────────
    for (const h of handles) {
      h.send('partition on');
      await h.waitFor((e) => e.evt === 'partition-ack' && e.partitioned === true, 15_000);
    }

    const split = revenueSplitManifest({
      version: 'v1',
      sharesBps: { creator: 6_000, host: 2_000, component: 500, dao: 1_000, reserve: 300, tax: 100, operating: 100 },
    });
    // Two machines, ONE payer identity, ONE seller escrow: 10_000 + 9_000
    // cannot both be paid out of 12_000.
    const voucherA = voucherFor({ usageNonce: 'nonce-a', cumulativeClaimMicros: 10_000n, splitManifestHash: split.manifestHash });
    const voucherB = voucherFor({ usageNonce: 'nonce-b', cumulativeClaimMicros: 9_000n, splitManifestHash: split.manifestHash });

    const receiptA = eventSigner(
      buildUsageReceiptEvent({ streamId: `channel:${CHANNEL_ID}`, issuer: PAYER, issuerMachine: 'machine-a', sequence: 0, occurredAtMs: 1_000, voucher: voucherA }),
    );
    const receiptB = eventSigner(
      buildUsageReceiptEvent({ streamId: `channel:${CHANNEL_ID}`, issuer: PAYER, issuerMachine: 'machine-b', sequence: 1, occurredAtMs: 2_000, voucher: voucherB }),
    );

    peerA.send(`emit ${JSON.stringify(receiptA)}`);
    await peerA.waitFor((e) => e.evt === 'emitted' && e.eventId === receiptA.eventId, 20_000);
    peerB.send(`emit ${JSON.stringify(receiptB)}`);
    await peerB.waitFor((e) => e.evt === 'emitted' && e.eventId === receiptB.eventId, 20_000);
    // The SAME window the positive control above proved is enough for a fact to
    // arrive — so "nothing arrived" here is a real cut, not an impatient read.
    await sleep(propagationWindowMs);

    const cut = await Promise.all(handles.map((h) => dump(h, 1_000, 15_000)));
    const divergent =
      cut[0].acceptedEventIds.includes(receiptA.eventId) &&
      !cut[0].acceptedEventIds.includes(receiptB.eventId) &&
      cut[1].acceptedEventIds.includes(receiptB.eventId) &&
      !cut[1].acceptedEventIds.includes(receiptA.eventId);
    scenarios.push(
      check(
        'partitioned-divergence',
        divergent,
        divergent
          ? 'while partitioned each machine held only its own claim'
          : `partition leaked: A=${JSON.stringify(cut[0].acceptedEventIds)} B=${JSON.stringify(cut[1].acceptedEventIds)}`,
      ),
    );

    // ── heal ────────────────────────────────────────────────────────────────
    for (const h of handles) {
      h.send('partition off');
      await h.waitFor((e) => e.evt === 'partition-ack' && e.partitioned === false, 15_000);
    }
    const healed = await waitForConvergence(
      handles,
      2_000,
      (states) =>
        foldsAgree(states) &&
        states.every((s) => s.acceptedEventIds.includes(receiptA.eventId) && s.acceptedEventIds.includes(receiptB.eventId)),
      opts.convergeTimeoutMs ?? 90_000,
    );
    const converged =
      foldsAgree(healed) && healed.every((s) => s.acceptedEventIds.includes(receiptA.eventId) && s.acceptedEventIds.includes(receiptB.eventId));
    scenarios.push(
      check(
        'converged-after-heal',
        converged,
        converged
          ? 'both peer processes folded an identical accepted set, rollup and escrow verdict'
          : `folds still differ after the heal: ${JSON.stringify(healed.map((s) => s.acceptedEventIds))}`,
      ),
    );

    // ── the escrow refuses the fork (D-055) ─────────────────────────────────
    const escrowVerdict = healed[0]?.escrow;
    const doubleSpendRefused =
      converged &&
      escrowVerdict?.doubleSpendCount === 1 &&
      BigInt(escrowVerdict.settledMicros) <= escrowMicros;
    scenarios.push(
      check(
        'double-spend-refused',
        Boolean(doubleSpendRefused),
        doubleSpendRefused
          ? `escrow admitted ${escrowVerdict!.admittedMicros} of ${escrowMicros} micros and quarantined 1 forked claim`
          : `expected exactly one quarantined double spend within escrow; got ${JSON.stringify(escrowVerdict)}`,
      ),
    );

    // ── a claim is not finality ─────────────────────────────────────────────
    const claimedBeforeSettlement = healed[0]?.rollup.totals;
    scenarios.push(
      check(
        'claim-is-not-finality',
        claimedBeforeSettlement?.claimedMicros === '19000' && claimedBeforeSettlement.settledMicros === '0',
        `after two usage receipts and before any settlement proof: claimed=${claimedBeforeSettlement?.claimedMicros} settled=${claimedBeforeSettlement?.settledMicros}`,
      ),
    );

    // ── duplicate receipt: re-federate A's receipt verbatim ─────────────────
    peerB.send(`emit ${JSON.stringify(receiptA)}`);
    await peerB.waitFor((e) => e.evt === 'emitted' && e.eventId === receiptA.eventId, 20_000);
    const afterDuplicate = await waitForConvergence(
      handles,
      3_000,
      (states) => foldsAgree(states) && states.some((s) => s.duplicateEventIds.includes(receiptA.eventId)),
      opts.convergeTimeoutMs ?? 90_000,
    );
    const duplicateOk =
      afterDuplicate.every((s) => s.duplicateEventIds.includes(receiptA.eventId)) &&
      afterDuplicate.every((s) => s.rollup.totals.claimedMicros === '19000');
    scenarios.push(
      check(
        'duplicate-receipt',
        duplicateOk,
        duplicateOk
          ? 're-federating a receipt was folded as a duplicate and did not inflate claimed money'
          : `duplicate handling wrong: ${JSON.stringify(afterDuplicate.map((s) => ({ dup: s.duplicateEventIds, claimed: s.rollup.totals.claimedMicros })))}`,
      ),
    );

    // ── conflict quarantine, on its own stream ──────────────────────────────
    // Two contradictory facts sharing one issuer idempotency key. They ride a
    // SEPARATE stream on purpose: quarantining them must be observable without
    // disturbing the escrow assertions above, which is also how a real peer
    // survives one bad stream.
    const conflictBase = buildUsageReceiptEvent({
      streamId: 'channel:chan-conflict',
      issuer: 'gh:forger',
      issuerMachine: 'machine-b',
      sequence: 0,
      occurredAtMs: 3_000,
      voucher: voucherFor({ usageNonce: 'nonce-x', cumulativeClaimMicros: 5_000n, splitManifestHash: split.manifestHash }),
    });
    const conflictOne = eventSigner({ ...conflictBase, eventId: 'conflict:one', idempotencyKey: 'conflict-key' });
    const conflictTwo = eventSigner({
      ...conflictBase,
      eventId: 'conflict:two',
      idempotencyKey: 'conflict-key',
      payload: { ...conflictBase.payload, amountMicros: '1' },
    });
    for (const event of [conflictOne, conflictTwo]) {
      peerB.send(`emit ${JSON.stringify(event)}`);
      await peerB.waitFor((e) => e.evt === 'emitted' && e.eventId === event.eventId, 20_000);
    }
    const afterConflict = await waitForConvergence(
      handles,
      4_000,
      (states) => foldsAgree(states) && states.every((s) => s.conflicts.length > 0),
      opts.convergeTimeoutMs ?? 90_000,
    );
    const quarantined =
      afterConflict.every((s) => s.conflicts.some((c) => c.reason === 'idempotency-conflict')) &&
      afterConflict.every((s) => !s.acceptedEventIds.includes('conflict:one') && !s.acceptedEventIds.includes('conflict:two')) &&
      afterConflict.every((s) => s.rollup.totals.claimedMicros === '19000');
    scenarios.push(
      check(
        'conflict-quarantined',
        quarantined,
        quarantined
          ? 'both peers quarantined the contradictory pair and neither entered the accepted fold'
          : `conflict not quarantined identically: ${JSON.stringify(afterConflict.map((s) => s.conflicts))}`,
      ),
    );

    // ── settle the admitted claim: claimed → pending → final ────────────────
    const facilitator = createDeterministicFacilitator();
    const config: EvmSettlementConfig = {
      chainId: facilitator.chainId,
      settlementContract: facilitator.settlementContract,
      stablecoin: facilitator.stablecoin,
      maxBatchSize: 50,
    };
    const plan = planBatchSettlement({
      config,
      channel: createPaymentChannel(CHANNEL_ID, 'evm-x402', escrowMicros),
      vouchers: [voucherA],
      nowMs: 0,
      settlementId: `settle-${createHash('sha256').update(voucherA.usageNonce).digest('hex').slice(0, 12)}`,
      splitManifest: split,
      daoTreasury: facilitator.signerAddress,
    });
    if (!plan.ok) throw new Error(`settlement plan refused: ${plan.code} — ${plan.detail}`);
    const transaction = await facilitator.submitBatchClaim(plan.plan.request);

    const proofOf = async (finality: 'claimed' | 'final', confirmations: number, sequence: number): Promise<CommerceEvent> =>
      eventSigner(
        buildSettlementProofEvent({
          streamId: `channel:${CHANNEL_ID}`,
          issuer: facilitator.signerAddress,
          sequence,
          occurredAtMs: 4_000 + sequence,
          plan: plan.plan,
          finality,
          confirmations,
          chainId: facilitator.chainId,
          transaction,
        }),
      );

    const claimedProof = await proofOf('claimed', 1, 10);
    peerA.send(`emit ${JSON.stringify(claimedProof)}`);
    await peerA.waitFor((e) => e.evt === 'emitted' && e.eventId === claimedProof.eventId, 20_000);
    const afterClaimed = await waitForConvergence(
      handles,
      5_000,
      (states) => foldsAgree(states) && states.every((s) => s.rollup.totals.pendingSettlementMicros !== '0'),
      opts.convergeTimeoutMs ?? 90_000,
    );
    const pendingOk = afterClaimed.every(
      (s) => s.rollup.totals.pendingSettlementMicros === plan.plan.claimMicros.toString() && s.rollup.totals.settledMicros === '0',
    );
    scenarios.push(
      check(
        'settlement-claimed-is-pending',
        pendingOk,
        pendingOk
          ? `a 'claimed' proof moved ${plan.plan.claimMicros} micros to pending, and settled stayed 0`
          : `claimed proof mis-folded: ${JSON.stringify(afterClaimed.map((s) => s.rollup.totals))}`,
      ),
    );

    facilitator.advanceHead(facilitator.requiredConfirmations);
    const observation = await facilitator.observeTransaction(transaction.transactionHash);
    const verdict = assessClaimFinality({
      claim: transaction,
      observation,
      requiredConfirmations: facilitator.requiredConfirmations,
    });
    if (verdict.state !== 'final') throw new Error(`chain did not reach finality: ${JSON.stringify(verdict)}`);
    const finalProof = await proofOf('final', verdict.confirmations, 11);
    peerB.send(`emit ${JSON.stringify(finalProof)}`);
    await peerB.waitFor((e) => e.evt === 'emitted' && e.eventId === finalProof.eventId, 20_000);
    const afterFinal = await waitForConvergence(
      handles,
      6_000,
      (states) => foldsAgree(states) && states.every((s) => s.rollup.totals.settledMicros !== '0'),
      opts.convergeTimeoutMs ?? 90_000,
    );
    const finalityOk = afterFinal.every(
      (s) =>
        s.rollup.totals.settledMicros === plan.plan.claimMicros.toString() &&
        s.rollup.totals.pendingSettlementMicros === '0' &&
        s.rollup.totals.claimedMicros === '19000',
    );
    scenarios.push(
      check(
        'settlement-final-is-money-received',
        finalityOk,
        finalityOk
          ? `a 'final' proof moved ${plan.plan.claimMicros} micros out of pending into settled on BOTH peers, with claimed unchanged`
          : `finality mis-folded: ${JSON.stringify(afterFinal.map((s) => s.rollup.totals))}`,
      ),
    );
    // A single-submit facilitator is what makes the escrow claim above honest.
    scenarios.push(
      check(
        'settlement-submitted-once',
        facilitator.submissions.length === 1,
        `facilitator recorded ${facilitator.submissions.length} batch submission(s)`,
      ),
    );

    finalStates = afterFinal;
    return {
      ok: scenarios.every((s) => s.ok),
      peerIds: finalStates.map((s) => s.peerId),
      scenarios,
      finalStates,
    };
  } finally {
    await launcher.cleanup();
    if (testnet) {
      try {
        await (testnet as { destroy(): Promise<void> }).destroy();
      } catch {
        /* a leaked testnet node must never fail the run it was measuring */
      }
    }
  }
}

// ----------------------------------------------------------------------- CLI

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const report = await runTwoPeerCommerce({ log: json ? undefined : (line) => process.stderr.write(`${line}\n`) });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const s of report.scenarios) {
      process.stdout.write(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(34)} ${s.detail}\n`);
    }
    process.stdout.write(`\n${report.ok ? 'ALL SCENARIOS PASSED' : 'FAILED'}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}

if (isCliEntry(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
