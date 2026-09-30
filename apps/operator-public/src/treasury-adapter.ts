/**
 * Fail-closed viem adapter for P-034 DAO treasury routing through Safe + Zodiac
 * Roles v2.
 *
 * The automation NEVER signs as a Safe owner. It calls
 * `execTransactionFromModule` on the Roles MODIFIER, which is what makes the
 * on-chain bounds real: the modifier enforces the role's target, selector and
 * parameter scopes, so the allowlists `treasury-controls.ts` checks off chain
 * are checked again by a contract the automation key cannot reconfigure. Owner
 * threshold control sits above that and is untouched by this file — which is
 * the point of `validateTreasuryConfig` refusing an automation signer that is
 * also an owner.
 *
 * Every configuration read is fail-closed, matching `settlement-facilitator.ts`:
 * a deployment missing a secret gets a 503 from the door rather than a transfer
 * attempt that cannot be signed. Installing `TREASURY_AUTOMATION_PRIVATE_KEY`
 * is an OWNER credential action, deliberately outside any agent's scope.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { RevenueShare } from '@papercusp/operator-core/lib/p2p/revenue-settlement.ts';
import type { Env } from './env.ts';

/** The ERC-20 leg: what the Safe is asked to execute. */
const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * Zodiac Roles v2 module entrypoint.
 *
 * `operation` is 0 (CALL); DELEGATECALL is deliberately never used — a
 * delegatecall from the Safe executes foreign code in the Safe's own storage
 * context, which would put every bound this module enforces inside the reach of
 * the transaction it is supposed to be bounding.
 */
const ROLES_ABI = [
  {
    type: 'function',
    name: 'execTransactionFromModule',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

export interface TreasuryTransferSubmission {
  readonly share: RevenueShare;
  readonly token: string;
  readonly recipient: string;
  readonly amountMicros: bigint;
  /** The deterministic authorization digest the transfer is bound to. */
  readonly safeTxHash: string;
}

export interface TreasuryTransactionReceipt {
  readonly transactionHash: string;
  readonly blockNumber: bigint;
}

/** The injected chain edge. Tests supply a deterministic fake. */
export interface SafeTreasuryAdapter {
  readonly chainId: number;
  readonly safeAddress: string;
  readonly rolesModuleAddress: string;
  readonly automationSigner: string;
  submitTransfer(submission: TreasuryTransferSubmission): Promise<TreasuryTransactionReceipt>;
  signTreasuryProof(bytes: Uint8Array): Promise<string>;
}

export type TreasuryAdapterAvailability =
  | { readonly ok: true; readonly adapter: SafeTreasuryAdapter }
  | { readonly ok: false; readonly code: 'not-configured' | 'invalid-config'; readonly detail: string };

function required(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function address(value: string | null): Address | null {
  return value && isAddress(value) ? getAddress(value) : null;
}

export function createViemSafeTreasuryAdapter(env: Env): TreasuryAdapterAvailability {
  // The treasury rides the same RPC and chain as the settlement rail: a
  // settlement's proceeds are on the chain that settled them, so a treasury on
  // a different chain could not receive them without a bridge this item does
  // not build.
  const rpcUrl = required(env.PAYMENT_CHANNEL_RPC_URL);
  const privateKey = required(env.TREASURY_AUTOMATION_PRIVATE_KEY);
  const safeRaw = required(env.TREASURY_SAFE_ADDRESS);
  const rolesRaw = required(env.TREASURY_ROLES_MODULE_ADDRESS);
  const chainId = Number(env.PAYMENT_CHANNEL_CHAIN_ID);

  const missing = [
    rpcUrl ? null : 'PAYMENT_CHANNEL_RPC_URL',
    privateKey ? null : 'TREASURY_AUTOMATION_PRIVATE_KEY',
    safeRaw ? null : 'TREASURY_SAFE_ADDRESS',
    rolesRaw ? null : 'TREASURY_ROLES_MODULE_ADDRESS',
    required(env.PAYMENT_CHANNEL_CHAIN_ID) ? null : 'PAYMENT_CHANNEL_CHAIN_ID',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    return { ok: false, code: 'not-configured', detail: `treasury rail is unavailable; missing ${missing.join(', ')}` };
  }

  const safeAddress = address(safeRaw);
  const rolesModuleAddress = address(rolesRaw);
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '') ||
    !safeAddress ||
    !rolesModuleAddress ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    return { ok: false, code: 'invalid-config', detail: 'treasury rail configuration is invalid' };
  }

  const account = privateKeyToAccount(privateKey as Hex);
  const chain = defineChain({
    id: chainId,
    name: `Papercusp treasury chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl as string] } },
  });
  const transport = http(rpcUrl as string);
  const wallet = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  const adapter: SafeTreasuryAdapter = {
    chainId,
    safeAddress,
    rolesModuleAddress,
    automationSigner: account.address,
    async submitTransfer(submission: TreasuryTransferSubmission): Promise<TreasuryTransactionReceipt> {
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [getAddress(submission.recipient), submission.amountMicros],
      });
      const transactionHash = await wallet.writeContract({
        account,
        address: rolesModuleAddress,
        abi: ROLES_ABI,
        functionName: 'execTransactionFromModule',
        args: [getAddress(submission.token), 0n, data, 0],
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
      // A Roles v2 module REVERTS when the call is outside the role's scope, so
      // a reverted receipt here means the on-chain bounds refused a transfer the
      // off-chain policy allowed. That disagreement is a fault, never a
      // recoverable outcome to swallow.
      if (receipt.status !== 'success') {
        throw new Error('treasury transfer reverted; the Zodiac role refused the call');
      }
      return { transactionHash, blockNumber: receipt.blockNumber };
    },
    signTreasuryProof(bytes: Uint8Array) {
      // Signed as raw bytes so a verifier recovers the same signer address that
      // appears as the transaction sender on chain.
      return account.signMessage({ message: { raw: bytes } });
    },
  };
  return { ok: true, adapter };
}
