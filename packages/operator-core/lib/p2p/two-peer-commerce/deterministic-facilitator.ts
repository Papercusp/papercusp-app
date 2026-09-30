/**
 * A deterministic, in-memory `EvmSettlementFacilitator` (P-036).
 *
 * WHY THIS SHIPS RATHER THAN LIVING IN A TEST FILE
 *
 * P-033 left the settlement facilitator as an INJECTED interface precisely so
 * the production door could take a real viem-backed implementation and a
 * deterministic one could stand in everywhere else. Until now the stand-ins
 * were `vi.fn` closures inside individual test files, which makes them
 * unreachable from anything that is not itself a vitest module — including the
 * P-036 two-host runner, which is a real binary and has no vitest available.
 *
 * The live rail needs `PAYMENT_CHANNEL_*` secrets, and those are OWNER-GATED
 * under P-038. That is a wall to CITE, not to block on: the properties P-036
 * asserts — that a claim is never reported as finality, that the escrow is
 * never over-drawn, that both peers agree — are properties of the settlement
 * STATE MACHINE, and a deterministic chain exercises that state machine exactly
 * as a real one does. What it cannot exercise is the live rail's own behaviour
 * (gas, mempool, real reorgs), which is why `advanceHead`/`reorg` are explicit
 * knobs rather than simulated randomness: an injected reorg is an honest
 * rehearsal, a randomised one would be a claim about a chain we did not run.
 */
import { createHash } from 'node:crypto';
import type {
  EvmBatchSettlementRequest,
  EvmSettlementFacilitator,
  EvmTransactionObservation,
  EvmTransactionReceipt,
} from '../evm-settlement';

export interface DeterministicFacilitatorOptions {
  readonly chainId?: number;
  readonly settlementContract?: string;
  readonly stablecoin?: string;
  readonly signerAddress?: string;
  readonly requiredConfirmations?: number;
}

export interface DeterministicFacilitator extends EvmSettlementFacilitator {
  /** Bury existing transactions by `blocks` — how a claim becomes final. */
  advanceHead(blocks: number): void;
  /** Drop a transaction from the canonical chain (the reorg signal). */
  reorg(transactionHash: string): void;
  /** Every batch claim submitted, in order — the double-submit falsifier. */
  readonly submissions: readonly string[];
}

const ADDR = (seed: string): string => `0x${createHash('sha256').update(seed).digest('hex').slice(0, 40)}`;

/**
 * `submitBatchClaim` is idempotent by `requestHash`, exactly as the interface
 * requires: a Worker that crashes between the chain accepting a claim and the
 * batch row recording it must converge on the existing claim rather than
 * spending the escrow twice. Re-submitting therefore returns the SAME receipt
 * and does NOT append to `submissions`.
 */
export function createDeterministicFacilitator(
  options: DeterministicFacilitatorOptions = {},
): DeterministicFacilitator {
  const chainId = options.chainId ?? 84_532;
  const byRequestHash = new Map<string, EvmTransactionReceipt>();
  const mined = new Map<string, { blockNumber: bigint; blockHash: string }>();
  const dropped = new Set<string>();
  const submissions: string[] = [];
  let head = 0n;

  const mine = (seed: string): EvmTransactionReceipt => {
    head += 1n;
    const transactionHash = `0x${createHash('sha256').update(`tx:${seed}`).digest('hex')}`;
    const blockHash = `0x${createHash('sha256').update(`block:${head}:${seed}`).digest('hex')}`;
    mined.set(transactionHash, { blockNumber: head, blockHash });
    return { transactionHash, blockNumber: head, blockHash };
  };

  return {
    chainId,
    settlementContract: options.settlementContract ?? ADDR('settlement-contract'),
    stablecoin: options.stablecoin ?? ADDR('stablecoin'),
    signerAddress: options.signerAddress ?? ADDR('facilitator-signer'),
    requiredConfirmations: options.requiredConfirmations ?? 2,
    submissions,

    async submitBatchClaim(request: EvmBatchSettlementRequest): Promise<EvmTransactionReceipt> {
      const existing = byRequestHash.get(request.requestHash);
      if (existing) return existing;
      const receipt = mine(request.requestHash);
      byRequestHash.set(request.requestHash, receipt);
      submissions.push(request.requestHash);
      return receipt;
    },

    async submitRefund(input: { channelId: string; amountMicros: bigint; refundAddress: string }): Promise<EvmTransactionReceipt> {
      return mine(`refund:${input.channelId}:${input.amountMicros}:${input.refundAddress}`);
    },

    async observeTransaction(transactionHash: string): Promise<EvmTransactionObservation> {
      const block = mined.get(transactionHash);
      if (!block || dropped.has(transactionHash)) return { present: false, headBlockNumber: head };
      return {
        present: true,
        blockNumber: block.blockNumber,
        blockHash: block.blockHash,
        headBlockNumber: head,
      };
    },

    async signSettlementProof(bytes: Uint8Array): Promise<string> {
      // A real facilitator signs with the key that submitted the claim. The
      // deterministic stand-in produces a stable digest over the same bytes so
      // a proof still round-trips signature-shaped validation.
      return createHash('sha256').update(Buffer.from(bytes)).digest('base64');
    },

    advanceHead(blocks: number): void {
      head += BigInt(Math.max(0, Math.trunc(blocks)));
    },

    reorg(transactionHash: string): void {
      dropped.add(transactionHash);
    },
  };
}
