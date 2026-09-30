/**
 * Authenticated Worker door for Stripe-funded prepaid BYOC credits.
 *
 * Principal identity always comes from the GitHub bearer. Callers can reserve
 * their balance into a microcharge channel, then settle or release that exact
 * reservation; no route accepts a caller-supplied principal id.
 */
import { Hono } from 'hono';
import {
  microchargeChannelForCreditReservation,
  type PrepaidCreditBalance,
  type PrepaidCreditRejectionCode,
  type PrepaidCreditReservation,
} from '@papercusp/operator-core/lib/cupboard/prepaid-credits.ts';
import type { Env } from '../env.ts';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import {
  appendPrepaidCreditEvent,
  loadPrepaidCreditState,
} from '../prepaid-credit-store.ts';

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

function balanceJson(
  principal: string,
  balance: PrepaidCreditBalance | undefined,
) {
  return (
    balance ?? {
      principalId: principal,
      availableMicros: 0,
      reservedMicros: 0,
      spentMicros: 0,
      debtMicros: 0,
      grantedMicros: 0,
      reversedMicros: 0,
      updatedAtMs: 0,
    }
  );
}

function reservationJson(reservation: PrepaidCreditReservation) {
  return {
    reservationId: reservation.reservationId,
    channelId: reservation.channelId,
    reservedMicros: reservation.reservedMicros,
    committedMicros: reservation.committedMicros,
    state: reservation.state,
    createdAtMs: reservation.createdAtMs,
    updatedAtMs: reservation.updatedAtMs,
  };
}

function rejectionStatus(
  code: PrepaidCreditRejectionCode,
): 404 | 409 | 422 {
  if (code === 'unknown-reservation') return 404;
  if (
    code === 'negative-balance' ||
    code === 'duplicate-conflict' ||
    code === 'reservation-conflict' ||
    code === 'invalid-transition'
  ) {
    return 409;
  }
  return 422;
}

export function prepaidCreditsRoute(): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();

  route.get('/commerce/prepaid-credits/balance', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const state = await loadPrepaidCreditState(c.env.DB);
    return c.json({
      principalId: auth.principalId,
      balance: balanceJson(auth.principalId, state.balances.get(auth.principalId)),
    });
  });

  route.post('/commerce/prepaid-credits/reservations', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const body = await jsonObject(c.req.raw);
    if (
      !body ||
      !validId(body.reservationId) ||
      !validId(body.channelId) ||
      !Number.isSafeInteger(body.amountMicros) ||
      Number(body.amountMicros) <= 0
    ) {
      return c.json(
        {
          error: 'invalid_request',
          detail:
            'reservationId, channelId and a positive safe-integer amountMicros are required',
        },
        400,
      );
    }

    const result = await appendPrepaidCreditEvent(c.env.DB, {
      creditEventId: `credit:reserve:${body.reservationId}`,
      kind: 'credit.reserved',
      principalId: auth.principalId,
      payload: {
        reservationId: body.reservationId,
        channelId: body.channelId,
        amountMicros: Number(body.amountMicros),
      },
    });
    if (!result.ok) {
      return c.json(
        { error: result.code, detail: result.detail },
        rejectionStatus(result.code),
      );
    }

    const reservation = result.state.reservations.get(body.reservationId);
    if (!reservation) {
      throw new Error(
        `accepted prepaid credit event did not project reservation ${body.reservationId}`,
      );
    }
    const channel = microchargeChannelForCreditReservation(
      result.state,
      reservation.reservationId,
    );
    if (!channel.ok) {
      throw new Error(channel.detail);
    }
    return c.json(
      {
        replayed: result.replayed,
        balance: balanceJson(
          auth.principalId,
          result.state.balances.get(auth.principalId),
        ),
        reservation: reservationJson(reservation),
        channel: {
          channelId: channel.channel.channelId,
          escrowMicros: channel.channel.escrowMicros.toString(),
          committedMicros: channel.channel.committedMicros.toString(),
          lastCumulativeMicros: channel.channel.lastCumulativeMicros.toString(),
        },
      },
      result.replayed ? 200 : 201,
    );
  });

  route.post('/commerce/prepaid-credits/reservations/:reservationId/settle', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const reservationId = c.req.param('reservationId');
    const body = await jsonObject(c.req.raw);
    if (
      !validId(reservationId) ||
      !body ||
      !Number.isSafeInteger(body.committedMicros) ||
      Number(body.committedMicros) < 0
    ) {
      return c.json(
        {
          error: 'invalid_request',
          detail:
            'reservationId and a non-negative safe-integer committedMicros are required',
        },
        400,
      );
    }

    const result = await appendPrepaidCreditEvent(c.env.DB, {
      creditEventId: `credit:settle:${reservationId}`,
      kind: 'credit.settled',
      principalId: auth.principalId,
      payload: {
        reservationId,
        committedMicros: Number(body.committedMicros),
      },
    });
    if (!result.ok) {
      return c.json(
        { error: result.code, detail: result.detail },
        rejectionStatus(result.code),
      );
    }
    const reservation = result.state.reservations.get(reservationId);
    if (!reservation) {
      throw new Error(
        `accepted prepaid credit event did not project reservation ${reservationId}`,
      );
    }
    return c.json(
      {
        replayed: result.replayed,
        balance: balanceJson(
          auth.principalId,
          result.state.balances.get(auth.principalId),
        ),
        reservation: reservationJson(reservation),
      },
      result.replayed ? 200 : 201,
    );
  });

  route.post('/commerce/prepaid-credits/reservations/:reservationId/release', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const reservationId = c.req.param('reservationId');
    if (!validId(reservationId)) {
      return c.json(
        { error: 'invalid_request', detail: 'reservationId is invalid' },
        400,
      );
    }

    const result = await appendPrepaidCreditEvent(c.env.DB, {
      creditEventId: `credit:release:${reservationId}`,
      kind: 'credit.released',
      principalId: auth.principalId,
      payload: { reservationId },
    });
    if (!result.ok) {
      return c.json(
        { error: result.code, detail: result.detail },
        rejectionStatus(result.code),
      );
    }
    const reservation = result.state.reservations.get(reservationId);
    if (!reservation) {
      throw new Error(
        `accepted prepaid credit event did not project reservation ${reservationId}`,
      );
    }
    return c.json(
      {
        replayed: result.replayed,
        balance: balanceJson(
          auth.principalId,
          result.state.balances.get(auth.principalId),
        ),
        reservation: reservationJson(reservation),
      },
      result.replayed ? 200 : 201,
    );
  });

  return route;
}
