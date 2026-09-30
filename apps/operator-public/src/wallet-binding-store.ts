/**
 * D1 persistence for signed-nonce EVM wallet binding (P-029).
 *
 * The authenticated principal comes from the Worker route, never from an
 * address lookup or caller-supplied id. Challenge consumption and binding
 * persistence run in one D1 batch. A unique consume token witnesses which
 * verifier won the one-time compare-and-set, avoiding the same-millisecond
 * replay hole that a timestamp-only witness would leave.
 */
import type { WalletBindingChallenge } from '@papercusp/operator-core/lib/cupboard/wallet-binding';

interface ChallengeRow {
  challenge_id: string;
  principal_id: string;
  wallet_address: string;
  chain_id: number;
  nonce: string;
  domain: string;
  uri: string;
  message: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
  consumed_token: string | null;
}

interface BindingRow {
  principal_id: string;
  wallet_address: string;
  chain_id: number;
  challenge_id: string;
  verified_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface StoredWalletBindingChallenge extends WalletBindingChallenge {
  readonly consumedAtMs: number | null;
  readonly consumedToken: string | null;
}

export interface StoredWalletBinding {
  readonly principalId: string;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly challengeId: string;
  readonly verifiedAtMs: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type ConsumeWalletBindingResult =
  | {
      readonly ok: true;
      readonly binding: StoredWalletBinding;
      readonly rotatedFromWalletAddress: string | null;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'challenge_not_found'
        | 'challenge_expired'
        | 'challenge_already_used'
        | 'wallet_already_bound';
    };

function challengeFromRow(row: ChallengeRow): StoredWalletBindingChallenge {
  return {
    challengeId: row.challenge_id,
    principalId: row.principal_id,
    walletAddress: row.wallet_address,
    chainId: Number(row.chain_id),
    nonce: row.nonce,
    domain: row.domain,
    uri: row.uri,
    message: row.message,
    issuedAtMs: Number(row.issued_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    consumedAtMs: row.consumed_at_ms == null ? null : Number(row.consumed_at_ms),
    consumedToken: row.consumed_token,
  };
}

function bindingFromRow(row: BindingRow): StoredWalletBinding {
  return {
    principalId: row.principal_id,
    walletAddress: row.wallet_address,
    chainId: Number(row.chain_id),
    challengeId: row.challenge_id,
    verifiedAtMs: Number(row.verified_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export async function insertWalletBindingChallenge(
  db: D1Database,
  challenge: WalletBindingChallenge,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wallet_binding_challenges
       (challenge_id, principal_id, wallet_address, chain_id, nonce, domain, uri, message, issued_at_ms, expires_at_ms, consumed_at_ms, consumed_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      challenge.challengeId,
      challenge.principalId,
      challenge.walletAddress,
      challenge.chainId,
      challenge.nonce,
      challenge.domain,
      challenge.uri,
      challenge.message,
      challenge.issuedAtMs,
      challenge.expiresAtMs,
    )
    .run();
}

export async function getWalletBindingChallenge(
  db: D1Database,
  challengeId: string,
  principalId: string,
): Promise<StoredWalletBindingChallenge | null> {
  const row = await db
    .prepare(
      `SELECT challenge_id, principal_id, wallet_address, chain_id, nonce, domain, uri, message,
              issued_at_ms, expires_at_ms, consumed_at_ms, consumed_token
       FROM wallet_binding_challenges
       WHERE challenge_id = ? AND principal_id = ?`,
    )
    .bind(challengeId, principalId)
    .first<ChallengeRow>();
  return row ? challengeFromRow(row) : null;
}

export async function getWalletBinding(
  db: D1Database,
  principalId: string,
): Promise<StoredWalletBinding | null> {
  const row = await db
    .prepare(
      `SELECT principal_id, wallet_address, chain_id, challenge_id,
              verified_at_ms, created_at_ms, updated_at_ms
       FROM wallet_bindings
       WHERE principal_id = ?`,
    )
    .bind(principalId)
    .first<BindingRow>();
  return row ? bindingFromRow(row) : null;
}

async function getWalletBindingByAddress(
  db: D1Database,
  walletAddress: string,
): Promise<StoredWalletBinding | null> {
  const row = await db
    .prepare(
      `SELECT principal_id, wallet_address, chain_id, challenge_id,
              verified_at_ms, created_at_ms, updated_at_ms
       FROM wallet_bindings
       WHERE wallet_address = ?`,
    )
    .bind(walletAddress)
    .first<BindingRow>();
  return row ? bindingFromRow(row) : null;
}

/**
 * Consume the challenge and upsert the principal's binding atomically.
 *
 * Statement two can write only when statement one stamped THIS invocation's
 * unguessable consume token. A replay therefore cannot rotate/rewrite the
 * binding even when two verifications land in the same millisecond.
 */
export async function consumeWalletBindingChallenge(
  db: D1Database,
  input: {
    challengeId: string;
    principalId: string;
    walletAddress: string;
    nowMs: number;
    consumeToken: string;
  },
): Promise<ConsumeWalletBindingResult> {
  const before = await getWalletBinding(db, input.principalId);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE wallet_binding_challenges
           SET consumed_at_ms = ?, consumed_token = ?
           WHERE challenge_id = ?
             AND principal_id = ?
             AND wallet_address = ?
             AND consumed_at_ms IS NULL
             AND expires_at_ms > ?`,
        )
        .bind(
          input.nowMs,
          input.consumeToken,
          input.challengeId,
          input.principalId,
          input.walletAddress,
          input.nowMs,
        ),
      db
        .prepare(
          `INSERT INTO wallet_bindings
           (principal_id, wallet_address, chain_id, challenge_id, verified_at_ms, created_at_ms, updated_at_ms)
           SELECT principal_id, wallet_address, chain_id, challenge_id, ?, ?, ?
           FROM wallet_binding_challenges
           WHERE challenge_id = ? AND principal_id = ? AND consumed_token = ?
           ON CONFLICT(principal_id) DO UPDATE SET
             wallet_address = excluded.wallet_address,
             chain_id = excluded.chain_id,
             challenge_id = excluded.challenge_id,
             verified_at_ms = excluded.verified_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.challengeId,
          input.principalId,
          input.consumeToken,
        ),
    ]);
  } catch (error) {
    // `wallet_address` is UNIQUE: one verified wallet cannot silently become
    // the identity of two principals. Re-read the constraint owner so only
    // that expected conflict is translated; every other storage fault remains
    // loud and reaches the Worker's onError path.
    const owner = await getWalletBindingByAddress(db, input.walletAddress);
    if (owner && owner.principalId !== input.principalId) {
      return { ok: false, code: 'wallet_already_bound' };
    }
    throw error;
  }

  const challenge = await getWalletBindingChallenge(db, input.challengeId, input.principalId);
  if (!challenge) return { ok: false, code: 'challenge_not_found' };
  if (challenge.consumedToken !== input.consumeToken) {
    if (challenge.consumedAtMs !== null) return { ok: false, code: 'challenge_already_used' };
    if (challenge.expiresAtMs <= input.nowMs) return { ok: false, code: 'challenge_expired' };
    return { ok: false, code: 'challenge_not_found' };
  }

  const binding = await getWalletBinding(db, input.principalId);
  if (!binding || binding.challengeId !== input.challengeId) {
    throw new Error('wallet binding transaction consumed a challenge without persisting its binding');
  }
  return {
    ok: true,
    binding,
    rotatedFromWalletAddress:
      before && before.walletAddress !== binding.walletAddress ? before.walletAddress : null,
  };
}

export async function deleteWalletBinding(
  db: D1Database,
  principalId: string,
): Promise<StoredWalletBinding | null> {
  const existing = await getWalletBinding(db, principalId);
  if (!existing) return null;
  await db.prepare('DELETE FROM wallet_bindings WHERE principal_id = ?').bind(principalId).run();
  return existing;
}
