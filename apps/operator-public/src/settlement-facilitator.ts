/**
 * Fail-closed viem facilitator for P-033 batch settlement on the pilot L2.
 *
 * "Self-hosted facilitator" means exactly this file: Papercusp signs and
 * submits the batch claim itself against its own RPC endpoint, rather than
 * delegating settlement to a third-party x402 facilitator. It reuses the same
 * settlement contract, stablecoin, chain, and signer the P-032 channel adapter
 * funds through, because a claim against a channel must be made on the contract
 * that holds that channel's escrow.
 *
 * Every configuration read is fail-closed: a deployment missing a secret gets a
 * 503 from the door rather than a settlement attempt that cannot be signed.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  EvmBatchSettlementRequest,
  EvmSettlementFacilitator,
  EvmTransactionObservation,
  EvmTransactionReceipt,
} from '@papercusp/operator-core/lib/p2p/evm-settlement.ts';
import type { Env } from './env.ts';

/** Default confirmation depth before a claim is treated as final. */
export const DEFAULT_REQUIRED_CONFIRMATIONS = 12;

const SETTLEMENT_ABI = [
  {
    type: 'function',
    name: 'settleBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'requestHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refundChannel',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'refundAddress', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export type SettlementFacilitatorAvailability =
  | { readonly ok: true; readonly facilitator: EvmSettlementFacilitator }
  | {
      readonly ok: false;
      readonly code: 'not-configured' | 'invalid-config';
      readonly detail: string;
    };

function required(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function address(value: string | null): Address | null {
  return value && isAddress(value) ? getAddress(value) : null;
}

function channelKey(channelId: string): Hex {
  return keccak256(stringToHex(channelId));
}

/**
 * Parse the confirmation depth.
 *
 * An unset value takes the default; a SET but unparseable value is an error
 * rather than a silent fallback, because settling at depth 1 when the operator
 * meant 12 is exactly the claim-vs-finality mistake this item exists to stop.
 */
export function parseRequiredConfirmations(
  raw: string | undefined,
): { ok: true; value: number } | { ok: false; detail: string } {
  const value = required(raw);
  if (value === null) return { ok: true, value: DEFAULT_REQUIRED_CONFIRMATIONS };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    return {
      ok: false,
      detail: `SETTLEMENT_REQUIRED_CONFIRMATIONS must be an integer between 1 and 10000, got '${value}'`,
    };
  }
  return { ok: true, value: parsed };
}

export function createViemSettlementFacilitator(env: Env): SettlementFacilitatorAvailability {
  const rpcUrl = required(env.PAYMENT_CHANNEL_RPC_URL);
  const privateKey = required(env.PAYMENT_CHANNEL_PRIVATE_KEY);
  const settlementContract = address(required(env.PAYMENT_CHANNEL_SETTLEMENT_CONTRACT));
  const stablecoin = address(required(env.PAYMENT_CHANNEL_STABLECOIN));
  const chainId = Number(env.PAYMENT_CHANNEL_CHAIN_ID);

  const missing = [
    rpcUrl ? null : 'PAYMENT_CHANNEL_RPC_URL',
    privateKey ? null : 'PAYMENT_CHANNEL_PRIVATE_KEY',
    required(env.PAYMENT_CHANNEL_SETTLEMENT_CONTRACT) ? null : 'PAYMENT_CHANNEL_SETTLEMENT_CONTRACT',
    required(env.PAYMENT_CHANNEL_STABLECOIN) ? null : 'PAYMENT_CHANNEL_STABLECOIN',
    required(env.PAYMENT_CHANNEL_CHAIN_ID) ? null : 'PAYMENT_CHANNEL_CHAIN_ID',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'not-configured',
      detail: `settlement rail is unavailable; missing ${missing.join(', ')}`,
    };
  }

  const confirmations = parseRequiredConfirmations(env.SETTLEMENT_REQUIRED_CONFIRMATIONS);
  if (!confirmations.ok) return { ok: false, code: 'invalid-config', detail: confirmations.detail };
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '') ||
    !settlementContract ||
    !stablecoin ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    return { ok: false, code: 'invalid-config', detail: 'settlement rail configuration is invalid' };
  }

  const account = privateKeyToAccount(privateKey as Hex);
  const chain = defineChain({
    id: chainId,
    name: `Papercusp settlement chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl as string] } },
  });
  const transport = http(rpcUrl as string);
  const wallet = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  async function submit(
    functionName: 'settleBatch' | 'refundChannel',
    args: readonly [Hex, bigint, Hex] | readonly [Hex, bigint, Address],
  ): Promise<EvmTransactionReceipt> {
    const transactionHash = await wallet.writeContract({
      account,
      address: settlementContract as Address,
      abi: SETTLEMENT_ABI,
      functionName,
      args,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== 'success') throw new Error(`settlement ${functionName} transaction reverted`);
    return {
      transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
    };
  }

  const facilitator: EvmSettlementFacilitator = {
    chainId,
    settlementContract,
    stablecoin,
    signerAddress: account.address,
    requiredConfirmations: confirmations.value,
    signSettlementProof(bytes: Uint8Array) {
      // Signed as raw bytes, so a verifier recovers the same signer address
      // that appears as the transaction sender on chain.
      return account.signMessage({ message: { raw: bytes } });
    },
    submitBatchClaim(request: EvmBatchSettlementRequest) {
      return submit('settleBatch', [
        channelKey(request.channelId),
        request.amountMicros,
        `0x${request.requestHash}` as Hex,
      ]);
    },
    submitRefund(input: { channelId: string; amountMicros: bigint; refundAddress: string }) {
      return submit('refundChannel', [
        channelKey(input.channelId),
        input.amountMicros,
        getAddress(input.refundAddress),
      ]);
    },
    async observeTransaction(transactionHash: string): Promise<EvmTransactionObservation> {
      const headBlockNumber = await publicClient.getBlockNumber();
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: transactionHash as Hex });
        return {
          present: true,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          headBlockNumber,
          reverted: receipt.status !== 'success',
        };
      } catch {
        // viem throws TransactionReceiptNotFoundError for a transaction the
        // canonical chain no longer carries. That absence IS the reorg signal,
        // so it is reported as an observation rather than propagated as a fault.
        return { present: false, headBlockNumber };
      }
    },
  };
  return { ok: true, facilitator };
}
