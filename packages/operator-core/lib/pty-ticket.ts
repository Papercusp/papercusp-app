/**
 * Short-lived, single-use authorization tickets for the PTY WebSocket.
 *
 * The HTTP control plane authenticates the browser and issues a ticket for one
 * exact PTY handle.  The browser carries that ticket in
 * `Sec-WebSocket-Protocol`; the dedicated WS listener can then authenticate the
 * upgrade without accepting cookies or putting credentials in the URL.
 *
 * This is deliberately process-local.  PTY handles themselves are
 * process-local, so a random per-process HMAC key is a tighter boundary than a
 * durable/shared signing key: a ticket cannot be redeemed by another operator
 * process even when it happens to run on the same machine.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';

export const PTY_WS_PROTOCOL = 'papercusp-pty.v1';
export const PTY_TICKET_PROTOCOL_PREFIX = 'papercusp-pty-ticket.v1.';
export const PTY_TICKET_TTL_MS = 15_000;

export interface PtyAccessScope {
  /** Stage A has one tenant boundary per workspace; Stage B supplies the org tenant id. */
  tenantId: string;
  workspaceId: string;
  harnessSlug: string;
  /** Stable identity for the operator process/host that owns the in-memory PTY. */
  hostId: string;
  /** Authenticated user/device/system id, or the explicit local-loopback principal. */
  principalId: string;
}

export interface PtyTicketClaims extends PtyAccessScope {
  version: 1;
  ticketId: string;
  ptyId: string;
  origin: string;
  protocol: typeof PTY_WS_PROTOCOL;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface IssuePtyTicketInput extends PtyAccessScope {
  ptyId: string;
  origin: string;
  nowMs?: number;
}

export interface ExpectedPtyTicket extends PtyAccessScope {
  ptyId: string;
  origin: string;
  protocol?: typeof PTY_WS_PROTOCOL;
}

export type PtyTicketRejection =
  | 'malformed'
  | 'bad_signature'
  | 'invalid_claims'
  | 'not_yet_valid'
  | 'expired'
  | 'scope_mismatch'
  | 'replayed';

export type RedeemPtyTicketResult =
  | { ok: true; claims: PtyTicketClaims }
  | { ok: false; reason: PtyTicketRejection };

type TicketGlobals = typeof globalThis & {
  __papercuspPtyTicketState?: {
    secret: Buffer;
    consumedUntil: Map<string, number>;
  };
};

const ticketGlobals = globalThis as TicketGlobals;
const ticketState = ticketGlobals.__papercuspPtyTicketState ?? {
  secret: randomBytes(32),
  consumedUntil: new Map<string, number>(),
};
ticketGlobals.__papercuspPtyTicketState = ticketState;

function pruneConsumed(nowMs: number): void {
  for (const [ticketId, expiresAtMs] of ticketState.consumedUntil) {
    if (expiresAtMs <= nowMs) ticketState.consumedUntil.delete(ticketId);
  }
}

function sign(encodedClaims: string): string {
  return createHmac('sha256', ticketState.secret).update(encodedClaims).digest('base64url');
}

function nonEmpty(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validClaims(value: unknown): value is PtyTicketClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Partial<PtyTicketClaims>;
  return (
    claims.version === 1 &&
    nonEmpty(claims.ticketId, 128) &&
    nonEmpty(claims.tenantId) &&
    nonEmpty(claims.workspaceId) &&
    nonEmpty(claims.harnessSlug) &&
    nonEmpty(claims.hostId) &&
    nonEmpty(claims.principalId) &&
    nonEmpty(claims.ptyId, 128) &&
    typeof claims.origin === 'string' && claims.origin.length <= 2048 &&
    claims.protocol === PTY_WS_PROTOCOL &&
    typeof claims.issuedAtMs === 'number' && Number.isSafeInteger(claims.issuedAtMs) &&
    typeof claims.expiresAtMs === 'number' && Number.isSafeInteger(claims.expiresAtMs)
  );
}

function sameExpectedClaims(claims: PtyTicketClaims, expected: ExpectedPtyTicket): boolean {
  return (
    claims.tenantId === expected.tenantId &&
    claims.workspaceId === expected.workspaceId &&
    claims.harnessSlug === expected.harnessSlug &&
    claims.hostId === expected.hostId &&
    claims.principalId === expected.principalId &&
    claims.ptyId === expected.ptyId &&
    claims.origin === expected.origin &&
    claims.protocol === (expected.protocol ?? PTY_WS_PROTOCOL)
  );
}

export function samePtyAccessScope(a: PtyAccessScope, b: PtyAccessScope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.workspaceId === b.workspaceId &&
    a.harnessSlug === b.harnessSlug &&
    a.hostId === b.hostId &&
    a.principalId === b.principalId
  );
}

/** Stable, non-secret key for partitioning the in-process prewarm pool. */
export function ptyAccessScopeKey(scope: PtyAccessScope): string {
  return [
    scope.tenantId,
    scope.workspaceId,
    scope.harnessSlug,
    scope.hostId,
    scope.principalId,
  ].map((part) => `${part.length}:${part}`).join('|');
}

export function localPtyHostId(
  env: NodeJS.ProcessEnv = process.env,
  machineHostname = hostname(),
): string {
  const explicit = env.PAPERCUSP_WORKSPACE_HOST_ID?.trim();
  if (explicit) return explicit;
  const port = (env.PAPERCUSP_HONO_PORT ?? env.PORT ?? 'operator').trim();
  return `${machineHostname}:${port}`;
}

export function issuePtyTicket(input: IssuePtyTicketInput): {
  ticket: string;
  protocol: typeof PTY_WS_PROTOCOL;
  expiresAtMs: number;
} {
  const nowMs = input.nowMs ?? Date.now();
  pruneConsumed(nowMs);
  const claims: PtyTicketClaims = {
    version: 1,
    ticketId: randomUUID(),
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    hostId: input.hostId,
    principalId: input.principalId,
    ptyId: input.ptyId,
    origin: input.origin,
    protocol: PTY_WS_PROTOCOL,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + PTY_TICKET_TTL_MS,
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    ticket: `${PTY_TICKET_PROTOCOL_PREFIX}${encodedClaims}.${sign(encodedClaims)}`,
    protocol: PTY_WS_PROTOCOL,
    expiresAtMs: claims.expiresAtMs,
  };
}

/**
 * Validate and atomically consume one ticket.  No await appears between the
 * replay check and insertion, so two upgrades in the same process cannot both
 * redeem the same id.
 */
export function redeemPtyTicket(
  ticket: string,
  expected: ExpectedPtyTicket,
  nowMs = Date.now(),
): RedeemPtyTicketResult {
  if (!ticket.startsWith(PTY_TICKET_PROTOCOL_PREFIX) || ticket.length > 8192) {
    return { ok: false, reason: 'malformed' };
  }
  const signed = ticket.slice(PTY_TICKET_PROTOCOL_PREFIX.length);
  const separator = signed.lastIndexOf('.');
  if (separator <= 0 || separator === signed.length - 1) return { ok: false, reason: 'malformed' };
  const encodedClaims = signed.slice(0, separator);
  const suppliedSignature = signed.slice(separator + 1);
  const expectedSignature = sign(encodedClaims);
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const actual = Buffer.from(expectedSignature, 'utf8');
  if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!validClaims(decoded)) return { ok: false, reason: 'invalid_claims' };
  const claims = decoded;
  // Bound the issuer window as well as checking the absolute expiry.  This
  // prevents a correctly signed but accidentally long-lived token from
  // weakening the 15-second protocol contract.
  if (claims.issuedAtMs > nowMs + 1_000) return { ok: false, reason: 'not_yet_valid' };
  if (
    claims.expiresAtMs <= nowMs ||
    claims.expiresAtMs - claims.issuedAtMs !== PTY_TICKET_TTL_MS
  ) {
    return { ok: false, reason: 'expired' };
  }
  if (!sameExpectedClaims(claims, expected)) return { ok: false, reason: 'scope_mismatch' };

  pruneConsumed(nowMs);
  if (ticketState.consumedUntil.has(claims.ticketId)) return { ok: false, reason: 'replayed' };
  ticketState.consumedUntil.set(claims.ticketId, claims.expiresAtMs);
  return { ok: true, claims };
}

/** Extract the one ticket token from a Sec-WebSocket-Protocol header. */
export function ptyTicketFromProtocolHeader(header: string | string[] | undefined): string | null {
  const values = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(PTY_WS_PROTOCOL)) return null;
  const tickets = values.filter((value) => value.startsWith(PTY_TICKET_PROTOCOL_PREFIX));
  return tickets.length === 1 ? tickets[0]! : null;
}

/** Test-only: rotate the process key and clear replay state between cases. */
export function _resetPtyTicketStateForTests(): void {
  ticketState.secret = randomBytes(32);
  ticketState.consumedUntil.clear();
}
