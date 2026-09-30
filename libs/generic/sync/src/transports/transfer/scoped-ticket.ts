/**
 * Scoped ticket — single-use, short-lived authorization for ONE transfer.
 *
 * The transfer origin is a different origin, which is the point (see
 * `transfer-origin.ts`), but it also means the control plane's session cookie
 * does not travel there.  That is a feature: a long-lived ambient credential
 * on a bulk endpoint is exactly the thing you do not want reachable from a
 * relayed customer-VPC connector.  Instead the CONTROL plane mints a narrow
 * ticket and the browser redeems it once, at the transfer origin.
 *
 * The scope is deliberately narrow on four axes at once — subject, operation,
 * lifetime, and use count — because a ticket that is broad on any ONE of them
 * stops being meaningfully different from a session token.
 *
 * This module is the client-side custodian: it tracks redemption locally so a
 * retry cannot silently replay a spent ticket. It is NOT the security boundary
 * — the transfer origin re-validates every ticket server-side and is the only
 * authority that may accept one. A client-side check that a server does not
 * repeat is a UX affordance, and treating it as enforcement is how single-use
 * quietly becomes multi-use.
 *
 * RELATIONSHIP TO THE EXISTING SERVER SUBSTRATE — read before extending.
 * `packages/operator-core/lib/endpoint-route/hosted-workspace-connector.ts`
 * already owns the AUTHORITATIVE half: `HostedWorkspaceConnectorGateway`
 * mints (`issueSessionTicket`) and burns (`consumeSessionTicket`) tickets
 * against a Postgres store, holding only their digests. This module does NOT
 * reimplement, replace, or wrap that; `ScopedTicket.token` is intended to
 * carry exactly the opaque value that gateway issues, and the gateway remains
 * the only thing that may decide a ticket is good.
 *
 * The two exist at different layers because the browser cannot reach the
 * server store before deciding whether a retry is safe to send. What is
 * deliberately NOT done here is a second minting path: if you find yourself
 * generating a token in this file, the correct change is to call the gateway,
 * not to grow a parallel issuer.
 */

export type TransferOperation = 'upload' | 'download' | 'stream';

export interface ScopedTicket {
  /** Opaque token minted by the control plane. */
  token: string;
  /** The one resource this ticket authorizes. */
  subject: string;
  /** The one operation it authorizes. */
  operation: TransferOperation;
  /** Origin this ticket may be redeemed against. */
  transferOrigin: string;
  /** Epoch ms after which the ticket is dead. */
  expiresAtMs: number;
}

export class ScopedTicketError extends Error {
  readonly code: 'expired' | 'already_redeemed' | 'wrong_origin' | 'wrong_subject' | 'wrong_operation' | 'malformed';

  constructor(code: ScopedTicketError['code'], message: string) {
    super(message);
    this.name = 'ScopedTicketError';
    this.code = code;
  }
}

export interface TicketRedemption {
  subject: string;
  operation: TransferOperation;
  transferOrigin: string;
}

export interface ScopedTicketStore {
  /** Assert the ticket is valid for this redemption and mark it spent. */
  redeem(ticket: ScopedTicket, against: TicketRedemption): ScopedTicket;
  /** Has this token already been redeemed by this client? */
  isSpent(token: string): boolean;
  /** Drop bookkeeping for tokens that are past expiry anyway. */
  prune(): number;
  readonly size: number;
}

export function parseScopedTicket(input: unknown): ScopedTicket {
  const raw = (input ?? {}) as Partial<ScopedTicket>;
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  const transferOrigin = typeof raw.transferOrigin === 'string' ? raw.transferOrigin.trim() : '';
  const operation = raw.operation as TransferOperation;
  const expiresAtMs = Number(raw.expiresAtMs);

  if (!token || !subject || !transferOrigin) {
    throw new ScopedTicketError('malformed', 'scoped ticket requires token, subject and transferOrigin');
  }
  if (operation !== 'upload' && operation !== 'download' && operation !== 'stream') {
    throw new ScopedTicketError('malformed', `scoped ticket operation must be upload|download|stream; received ${String(raw.operation)}`);
  }
  if (!Number.isFinite(expiresAtMs)) {
    throw new ScopedTicketError('malformed', 'scoped ticket requires a numeric expiresAtMs');
  }

  return { token, subject, operation, transferOrigin, expiresAtMs };
}

/**
 * Create a client-side ticket custodian.
 *
 * Spent tokens are retained until their own expiry rather than forgotten on
 * redemption. Forgetting immediately would make a replayed token look BRAND
 * NEW to this client, turning the clearest possible error ("already redeemed")
 * into an opaque server-side rejection much further down the call.
 */
export function createScopedTicketStore(options: { now?: () => number } = {}): ScopedTicketStore {
  const now = options.now ?? (() => Date.now());
  const spent = new Map<string, number>();

  return {
    get size() {
      return spent.size;
    },

    isSpent(token: string): boolean {
      return spent.has(token);
    },

    prune(): number {
      const cutoff = now();
      let removed = 0;
      for (const [token, expiresAtMs] of spent) {
        if (expiresAtMs <= cutoff) {
          spent.delete(token);
          removed += 1;
        }
      }
      return removed;
    },

    redeem(ticket: ScopedTicket, against: TicketRedemption): ScopedTicket {
      if (spent.has(ticket.token)) {
        throw new ScopedTicketError(
          'already_redeemed',
          `scoped ticket for ${ticket.subject} was already redeemed; mint a new ticket rather than replaying one`,
        );
      }
      if (ticket.expiresAtMs <= now()) {
        throw new ScopedTicketError('expired', `scoped ticket for ${ticket.subject} expired at ${new Date(ticket.expiresAtMs).toISOString()}`);
      }
      if (ticket.transferOrigin !== against.transferOrigin) {
        throw new ScopedTicketError(
          'wrong_origin',
          `scoped ticket is bound to ${ticket.transferOrigin} and cannot be redeemed against ${against.transferOrigin}`,
        );
      }
      if (ticket.subject !== against.subject) {
        throw new ScopedTicketError(
          'wrong_subject',
          `scoped ticket authorizes ${ticket.subject}, not ${against.subject}`,
        );
      }
      if (ticket.operation !== against.operation) {
        throw new ScopedTicketError(
          'wrong_operation',
          `scoped ticket authorizes ${ticket.operation}, not ${against.operation}`,
        );
      }

      spent.set(ticket.token, ticket.expiresAtMs);
      return ticket;
    },
  };
}
