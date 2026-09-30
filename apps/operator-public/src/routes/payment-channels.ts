/**
 * Authenticated production door for buyer-side P-032 payment-channel funding.
 *
 * The route binds the existing P-021 channel state machine to a real EVM rail.
 * GitHub bearer identity selects the wallet binding / prepaid balance; callers
 * cannot provide a principal, signer, contract, chain, or token address.
 */
import { Hono } from 'hono';
import { createPaymentChannel } from '@papercusp/operator-core/lib/p2p/payment-channel.ts';
import type {
  PaymentChannelFundingAdapter,
  PaymentChannelFundingSource,
} from '@papercusp/operator-core/lib/p2p/channel-funding.ts';
import type { Env } from '../env.ts';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import { getWalletBinding } from '../wallet-binding-store.ts';
import {
  appendPrepaidCreditEvent,
  loadPrepaidCreditState,
} from '../prepaid-credit-store.ts';
import { createViemPaymentChannelAdapter } from '../payment-channel-adapter.ts';
import {
  beginPaymentChannelClose,
  createPaymentChannelOpening,
  getPaymentChannel,
  markPaymentChannelClosed,
  markPaymentChannelCloseRetryable,
  markPaymentChannelFailed,
  markPaymentChannelOpen,
  recordPaymentChannelCloseReceipt,
  type StoredPaymentChannel,
} from '../payment-channel-store.ts';

function principalId(user: { id: number }): string {
  return `gh:${user.id}`;
}

async function authenticate(request: Request): Promise<
  | { ok: true; principalId: string }
  | { ok: false; reason: AuthError['reason'] }
> {
  try {
    return { ok: true, principalId: principalId(await resolveGithubBearer(request)) };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, reason: error.reason };
    throw error;
  }
}

async function jsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
  );
}

function channelJson(channel: StoredPaymentChannel) {
  return {
    channelId: channel.channelId,
    rail: channel.rail,
    chainId: channel.chainId,
    stablecoinAddress: channel.stablecoinAddress,
    settlementContractAddress: channel.settlementContractAddress,
    fundingSource: channel.fundingSource,
    escrowMicros: channel.escrowMicros,
    committedMicros: channel.committedMicros,
    refundedMicros: channel.refundedMicros,
    state: channel.state,
    openReceipt: channel.openReceipt
      ? {
          transactionHash: channel.openReceipt.transactionHash,
          blockNumber: channel.openReceipt.blockNumber.toString(),
        }
      : null,
    closeReceipt: channel.closeReceipt
      ? {
          transactionHash: channel.closeReceipt.transactionHash,
          blockNumber: channel.closeReceipt.blockNumber.toString(),
        }
      : null,
    failureCode: channel.failureCode,
    createdAtMs: channel.createdAtMs,
    updatedAtMs: channel.updatedAtMs,
    closedAtMs: channel.closedAtMs,
  };
}

function adapterFor(
  env: Env,
  injected: PaymentChannelFundingAdapter | undefined,
) {
  return injected
    ? { ok: true as const, adapter: injected }
    : createViemPaymentChannelAdapter(env);
}

async function releasePrepaidReservation(
  db: D1Database,
  principal: string,
  reservationId: string,
): Promise<void> {
  const result = await appendPrepaidCreditEvent(db, {
    creditEventId: `credit:release:${reservationId}`,
    kind: 'credit.released',
    principalId: principal,
    payload: { reservationId },
  });
  if (!result.ok && result.code !== 'invalid-transition') {
    throw new Error(`prepaid reservation compensation failed: ${result.code}`);
  }
}

export function paymentChannelsRoute(
  options: { adapter?: PaymentChannelFundingAdapter } = {},
): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();

  route.post('/commerce/payment-channels', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const body = await jsonObject(c.req.raw);
    if (
      !body ||
      !validId(body.channelId) ||
      !Number.isSafeInteger(body.escrowMicros) ||
      Number(body.escrowMicros) <= 0 ||
      (body.fundingSource !== 'bound-wallet' &&
        body.fundingSource !== 'prepaid-credit')
    ) {
      return c.json(
        {
          error: 'invalid_request',
          detail:
            'channelId, a positive safe-integer escrowMicros, and fundingSource bound-wallet|prepaid-credit are required',
        },
        400,
      );
    }

    const availability = adapterFor(c.env, options.adapter);
    if (!availability.ok) {
      return c.json(
        { error: availability.code, detail: availability.detail },
        503,
      );
    }
    const adapter = availability.adapter;
    const channelId = body.channelId;
    const escrowMicros = Number(body.escrowMicros);
    let fundingSource: PaymentChannelFundingSource;
    let refundAddress = adapter.signerAddress;

    if (body.fundingSource === 'bound-wallet') {
      const binding = await getWalletBinding(c.env.DB, auth.principalId);
      if (!binding) return c.json({ error: 'wallet_not_bound' }, 409);
      if (binding.chainId !== adapter.chainId) {
        return c.json(
          {
            error: 'wallet_chain_mismatch',
            expectedChainId: adapter.chainId,
            boundChainId: binding.chainId,
          },
          409,
        );
      }
      if (
        binding.walletAddress.toLowerCase() !==
        adapter.signerAddress.toLowerCase()
      ) {
        return c.json(
          {
            error: 'wallet_signer_mismatch',
            detail:
              'the configured rail signer is not the authenticated principal’s bound wallet',
          },
          503,
        );
      }
      refundAddress = binding.walletAddress;
      fundingSource = {
        kind: 'bound-wallet',
        walletAddress: binding.walletAddress,
      };
    } else {
      fundingSource = {
        kind: 'prepaid-credit',
        reservationId: `payment-channel:${channelId}`,
      };
    }

    const opening = await createPaymentChannelOpening(c.env.DB, {
      channelId,
      principalId: auth.principalId,
      adapter,
      fundingSource,
      escrowMicros,
      nowMs: Date.now(),
    });
    if (!opening.ok) return c.json({ error: opening.code }, 409);
    if (
      opening.channel.state === 'open' ||
      opening.channel.state === 'closing' ||
      opening.channel.state === 'closed'
    ) {
      return c.json({ replayed: true, channel: channelJson(opening.channel) }, 200);
    }
    if (opening.channel.state === 'failed') {
      return c.json(
        {
          error: 'channel_open_failed',
          failureCode: opening.channel.failureCode,
        },
        409,
      );
    }

    if (fundingSource.kind === 'prepaid-credit') {
      const reserve = await appendPrepaidCreditEvent(c.env.DB, {
        creditEventId: `credit:reserve:${fundingSource.reservationId}`,
        kind: 'credit.reserved',
        principalId: auth.principalId,
        payload: {
          reservationId: fundingSource.reservationId,
          channelId,
          amountMicros: escrowMicros,
        },
      });
      if (!reserve.ok) {
        await markPaymentChannelFailed(
          c.env.DB,
          channelId,
          `prepaid-${reserve.code}`,
        );
        const status = reserve.code === 'negative-balance' ? 409 : 422;
        return c.json({ error: reserve.code, detail: reserve.detail }, status);
      }
    }

    const channel = createPaymentChannel(
      channelId,
      adapter.rail,
      BigInt(escrowMicros),
    );
    try {
      const receipt = await adapter.openChannel({
        principalId: auth.principalId,
        channel,
        fundingSource,
        refundAddress,
      });
      const opened = await markPaymentChannelOpen(c.env.DB, channelId, receipt);
      return c.json(
        { replayed: !opening.created, channel: channelJson(opened) },
        opening.created ? 201 : 200,
      );
    } catch {
      if (fundingSource.kind === 'prepaid-credit') {
        await releasePrepaidReservation(
          c.env.DB,
          auth.principalId,
          fundingSource.reservationId,
        );
      }
      await markPaymentChannelFailed(c.env.DB, channelId, 'rail-open-failed');
      return c.json({ error: 'rail_open_failed' }, 502);
    }
  });

  route.get('/commerce/payment-channels/:channelId', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const channelId = c.req.param('channelId');
    if (!validId(channelId)) return c.json({ error: 'invalid_request' }, 400);
    const channel = await getPaymentChannel(c.env.DB, channelId);
    if (!channel || channel.principalId !== auth.principalId) {
      return c.json({ error: 'channel_not_found' }, 404);
    }
    return c.json({ channel: channelJson(channel) });
  });

  route.post('/commerce/payment-channels/:channelId/close', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const channelId = c.req.param('channelId');
    const body = await jsonObject(c.req.raw);
    if (
      !validId(channelId) ||
      !body ||
      !Number.isSafeInteger(body.committedMicros) ||
      Number(body.committedMicros) < 0
    ) {
      return c.json(
        {
          error: 'invalid_request',
          detail: 'a non-negative safe-integer committedMicros is required',
        },
        400,
      );
    }

    const availability = adapterFor(c.env, options.adapter);
    if (!availability.ok) {
      return c.json(
        { error: availability.code, detail: availability.detail },
        503,
      );
    }
    const adapter = availability.adapter;
    let stored = await getPaymentChannel(c.env.DB, channelId);
    if (!stored || stored.principalId !== auth.principalId) {
      return c.json({ error: 'channel_not_found' }, 404);
    }
    const committedMicros = Number(body.committedMicros);
    if (committedMicros > stored.escrowMicros) {
      return c.json({ error: 'committed_exceeds_escrow' }, 422);
    }
    if (stored.state === 'closed') {
      return stored.committedMicros === committedMicros
        ? c.json({ replayed: true, channel: channelJson(stored) }, 200)
        : c.json({ error: 'close_terms_conflict' }, 409);
    }
    if (stored.state !== 'open' && stored.state !== 'closing') {
      return c.json({ error: `channel_${stored.state}` }, 409);
    }
    if (
      stored.state === 'closing' &&
      stored.committedMicros !== committedMicros
    ) {
      return c.json({ error: 'close_terms_conflict' }, 409);
    }

    const refundedMicros = stored.escrowMicros - committedMicros;
    if (stored.state === 'open') {
      stored = await beginPaymentChannelClose(
        c.env.DB,
        channelId,
        committedMicros,
        refundedMicros,
      );
    }
    const channel = createPaymentChannel(
      stored.channelId,
      stored.rail,
      BigInt(stored.escrowMicros),
    );

    if (!stored.closeReceipt) {
      try {
        const closeReceipt = await adapter.closeChannel({
          principalId: auth.principalId,
          channel,
          fundingSource: stored.fundingSource,
          committedMicros: BigInt(committedMicros),
          refundAddress:
            stored.fundingSource.kind === 'bound-wallet'
              ? stored.fundingSource.walletAddress
              : adapter.signerAddress,
        });
        stored = await recordPaymentChannelCloseReceipt(c.env.DB, channelId, {
          committedMicros,
          refundedMicros,
          receipt: closeReceipt,
        });
      } catch {
        await markPaymentChannelCloseRetryable(
          c.env.DB,
          channelId,
          'rail-close-failed',
        );
        return c.json({ error: 'rail_close_failed' }, 502);
      }
    }

    if (stored.fundingSource.kind === 'prepaid-credit') {
      const settle = await appendPrepaidCreditEvent(c.env.DB, {
        creditEventId: `credit:settle:${stored.fundingSource.reservationId}`,
        kind: 'credit.settled',
        principalId: auth.principalId,
        payload: {
          reservationId: stored.fundingSource.reservationId,
          committedMicros,
        },
      });
      if (!settle.ok) {
        return c.json(
          {
            error: 'prepaid_settlement_pending',
            detail: settle.detail,
          },
          500,
        );
      }
    }

    const closed = await markPaymentChannelClosed(c.env.DB, channelId);
    return c.json({ replayed: false, channel: channelJson(closed) }, 200);
  });

  return route;
}
