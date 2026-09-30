/**
 * Durable funding seam for the P-021 payment-channel state machine.
 *
 * The adapter owns chain I/O only. Authentication, wallet binding, prepaid
 * credit reservation, and persistence remain at the Worker door so tests can
 * exercise the complete flow with a deterministic fake rail.
 */
import type { PaymentChannelState } from './payment-channel';

export type PaymentChannelFundingSource =
  | {
      readonly kind: 'bound-wallet';
      readonly walletAddress: string;
    }
  | {
      readonly kind: 'prepaid-credit';
      readonly reservationId: string;
    };

export interface PaymentChannelOpenInput {
  readonly principalId: string;
  readonly channel: PaymentChannelState;
  readonly fundingSource: PaymentChannelFundingSource;
  /** Address that receives unused escrow when the channel closes. */
  readonly refundAddress: string;
}

export interface PaymentChannelCloseInput {
  readonly principalId: string;
  readonly channel: PaymentChannelState;
  readonly fundingSource: PaymentChannelFundingSource;
  readonly committedMicros: bigint;
  readonly refundAddress: string;
}

export interface PaymentChannelRailReceipt {
  readonly transactionHash: string;
  readonly blockNumber: bigint;
}

/**
 * Chain adapter contract.
 *
 * Both methods MUST be idempotent by `channel.channelId`. A Worker can crash
 * after the chain accepts a transaction but before D1 records the receipt; the
 * retry must converge on the existing on-chain channel instead of double
 * funding or double closing it.
 */
export interface PaymentChannelFundingAdapter {
  readonly rail: 'evm-x402';
  readonly chainId: number;
  readonly stablecoinAddress: string;
  readonly settlementContractAddress: string;
  readonly signerAddress: string;
  openChannel(input: PaymentChannelOpenInput): Promise<PaymentChannelRailReceipt>;
  closeChannel(input: PaymentChannelCloseInput): Promise<PaymentChannelRailReceipt>;
}
