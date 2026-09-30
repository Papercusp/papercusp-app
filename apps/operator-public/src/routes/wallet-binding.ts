/**
 * Authenticated Worker production door for signed-nonce EVM wallet binding.
 *
 * No route accepts a principal id and no route looks a principal up by wallet
 * address. GitHub bearer authentication establishes the principal; the only
 * way a wallet enters storage is by signing the exact server-issued challenge.
 */
import { Hono } from 'hono';
import {
  createWalletBindingChallenge,
  normalizeEvmAddress,
  verifyWalletBindingSignature,
} from '@papercusp/operator-core/lib/cupboard/wallet-binding';
import type { Env } from '../env.ts';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import {
  consumeWalletBindingChallenge,
  deleteWalletBinding,
  getWalletBinding,
  getWalletBindingChallenge,
  insertWalletBindingChallenge,
} from '../wallet-binding-store.ts';

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

function bindingJson(binding: {
  walletAddress: string;
  chainId: number;
  challengeId: string;
  verifiedAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}) {
  return {
    walletAddress: binding.walletAddress,
    chainId: binding.chainId,
    challengeId: binding.challengeId,
    verifiedAtMs: binding.verifiedAtMs,
    createdAtMs: binding.createdAtMs,
    updatedAtMs: binding.updatedAtMs,
  };
}

export function walletBindingRoute(): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();

  route.post('/commerce/wallet-bindings/challenges', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const body = await jsonObject(c.req.raw);
    if (!body) return c.json({ error: 'invalid_request', detail: 'body must be a JSON object' }, 400);
    if (typeof body.walletAddress !== 'string') {
      return c.json({ error: 'invalid_request', detail: 'walletAddress must be a 20-byte 0x-prefixed address' }, 400);
    }
    const walletAddress = normalizeEvmAddress(body.walletAddress);
    if (!walletAddress) {
      return c.json({ error: 'invalid_request', detail: 'walletAddress must be a 20-byte 0x-prefixed address' }, 400);
    }
    const chainId = body.chainId === undefined ? 1 : body.chainId;
    if (!Number.isSafeInteger(chainId) || Number(chainId) <= 0) {
      return c.json({ error: 'invalid_request', detail: 'chainId must be a positive safe integer' }, 400);
    }

    const challenge = createWalletBindingChallenge({
      principalId: auth.principalId,
      walletAddress,
      chainId: Number(chainId),
      domain: c.env.CUPBOARD_HOST,
    });
    await insertWalletBindingChallenge(c.env.DB, challenge);
    return c.json(
      {
        challengeId: challenge.challengeId,
        walletAddress: challenge.walletAddress,
        chainId: challenge.chainId,
        message: challenge.message,
        issuedAtMs: challenge.issuedAtMs,
        expiresAtMs: challenge.expiresAtMs,
      },
      201,
    );
  });

  route.post('/commerce/wallet-bindings', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const body = await jsonObject(c.req.raw);
    if (
      !body ||
      typeof body.challengeId !== 'string' ||
      !body.challengeId ||
      typeof body.signature !== 'string'
    ) {
      return c.json(
        { error: 'invalid_request', detail: 'challengeId and a 65-byte 0x-prefixed signature are required' },
        400,
      );
    }

    const nowMs = Date.now();
    const challenge = await getWalletBindingChallenge(c.env.DB, body.challengeId, auth.principalId);
    // Principal-scoped lookup deliberately maps a challenge belonging to
    // another caller to the same 404 as an unknown id.
    if (!challenge) return c.json({ error: 'challenge_not_found' }, 404);
    if (challenge.consumedAtMs !== null) {
      return c.json({ error: 'challenge_already_used' }, 409);
    }
    if (challenge.expiresAtMs <= nowMs) {
      return c.json({ error: 'challenge_expired' }, 410);
    }

    const signature = verifyWalletBindingSignature({
      message: challenge.message,
      signature: body.signature,
      expectedAddress: challenge.walletAddress,
    });
    if (!signature.ok) {
      return c.json({ error: signature.code, detail: signature.detail }, 422);
    }

    const consumed = await consumeWalletBindingChallenge(c.env.DB, {
      challengeId: challenge.challengeId,
      principalId: auth.principalId,
      walletAddress: signature.recoveredAddress,
      nowMs,
      consumeToken: crypto.randomUUID(),
    });
    if (!consumed.ok) {
      const status =
        consumed.code === 'challenge_not_found'
          ? 404
          : consumed.code === 'challenge_expired'
            ? 410
            : 409;
      return c.json({ error: consumed.code }, status);
    }

    return c.json(
      {
        bound: true,
        binding: bindingJson(consumed.binding),
        rotated: consumed.rotatedFromWalletAddress !== null,
        rotatedFromWalletAddress: consumed.rotatedFromWalletAddress,
      },
      consumed.rotatedFromWalletAddress === null && consumed.binding.createdAtMs === consumed.binding.updatedAtMs
        ? 201
        : 200,
    );
  });

  route.get('/commerce/wallet-bindings/me', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const binding = await getWalletBinding(c.env.DB, auth.principalId);
    return binding
      ? c.json({ bound: true, binding: bindingJson(binding) }, 200)
      : c.json({ bound: false, binding: null }, 200);
  });

  route.delete('/commerce/wallet-bindings/me', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const removed = await deleteWalletBinding(c.env.DB, auth.principalId);
    return c.json({
      unbound: removed !== null,
      previousWalletAddress: removed?.walletAddress ?? null,
    });
  });

  return route;
}
