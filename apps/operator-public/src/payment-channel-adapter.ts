/**
 * Fail-closed viem adapter for the Base-compatible P-032 pilot rail.
 *
 * The configured settlement contract must expose idempotent channel operations
 * keyed by the bytes32 digest of the public channel id.
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
  PaymentChannelCloseInput,
  PaymentChannelFundingAdapter,
  PaymentChannelOpenInput,
  PaymentChannelRailReceipt,
} from '@papercusp/operator-core/lib/p2p/channel-funding.ts';
import type { Env } from './env.ts';

const CHANNEL_ABI = [
  {
    type: 'function',
    name: 'openChannel',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'stablecoin', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'refundAddress', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'closeChannel',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'committedAmount', type: 'uint256' },
      { name: 'refundAddress', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export type PaymentChannelAdapterAvailability =
  | { readonly ok: true; readonly adapter: PaymentChannelFundingAdapter }
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

function successfulReceipt(
  operation: 'open' | 'close',
  transactionHash: Hex,
  receipt: { status: 'success' | 'reverted'; blockNumber: bigint },
): PaymentChannelRailReceipt {
  if (receipt.status !== 'success') {
    throw new Error(`payment channel ${operation} transaction reverted`);
  }
  return { transactionHash, blockNumber: receipt.blockNumber };
}

export function createViemPaymentChannelAdapter(
  env: Env,
): PaymentChannelAdapterAvailability {
  const rpcUrl = required(env.PAYMENT_CHANNEL_RPC_URL);
  const privateKey = required(env.PAYMENT_CHANNEL_PRIVATE_KEY);
  const settlementContractAddress = address(
    required(env.PAYMENT_CHANNEL_SETTLEMENT_CONTRACT),
  );
  const stablecoinAddress = address(required(env.PAYMENT_CHANNEL_STABLECOIN));
  const chainId = Number(env.PAYMENT_CHANNEL_CHAIN_ID);

  const missing = [
    rpcUrl ? null : 'PAYMENT_CHANNEL_RPC_URL',
    privateKey ? null : 'PAYMENT_CHANNEL_PRIVATE_KEY',
    required(env.PAYMENT_CHANNEL_SETTLEMENT_CONTRACT)
      ? null
      : 'PAYMENT_CHANNEL_SETTLEMENT_CONTRACT',
    required(env.PAYMENT_CHANNEL_STABLECOIN)
      ? null
      : 'PAYMENT_CHANNEL_STABLECOIN',
    required(env.PAYMENT_CHANNEL_CHAIN_ID)
      ? null
      : 'PAYMENT_CHANNEL_CHAIN_ID',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'not-configured',
      detail: `payment channel rail is unavailable; missing ${missing.join(', ')}`,
    };
  }
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '') ||
    !settlementContractAddress ||
    !stablecoinAddress ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    return {
      ok: false,
      code: 'invalid-config',
      detail: 'payment channel rail configuration is invalid',
    };
  }

  const account = privateKeyToAccount(privateKey as Hex);
  const chain = defineChain({
    id: chainId,
    name: `Papercusp payment-channel chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl as string] } },
  });
  const transport = http(rpcUrl as string);
  const wallet = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  async function submit(
    operation: 'open' | 'close',
    functionName: 'openChannel' | 'closeChannel',
    args: readonly [Hex, Address, bigint, Address] | readonly [Hex, bigint, Address],
  ): Promise<PaymentChannelRailReceipt> {
    const transactionHash = await wallet.writeContract({
      account,
      address: settlementContractAddress,
      abi: CHANNEL_ABI,
      functionName,
      args,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    });
    return successfulReceipt(operation, transactionHash, receipt);
  }

  const adapter: PaymentChannelFundingAdapter = {
    rail: 'evm-x402',
    chainId,
    stablecoinAddress,
    settlementContractAddress,
    signerAddress: account.address,
    openChannel(input: PaymentChannelOpenInput) {
      return submit('open', 'openChannel', [
        channelKey(input.channel.channelId),
        stablecoinAddress,
        input.channel.escrowMicros,
        getAddress(input.refundAddress),
      ]);
    },
    closeChannel(input: PaymentChannelCloseInput) {
      return submit('close', 'closeChannel', [
        channelKey(input.channel.channelId),
        input.committedMicros,
        getAddress(input.refundAddress),
      ]);
    },
  };
  return { ok: true, adapter };
}
