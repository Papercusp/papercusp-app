/**
 * Transport capability — what a host can actually do for bulk traffic.
 *
 * P-021 separates browser PTY/desktop streaming and large upload/download
 * traffic from portal CONTROL traffic.  The scheduler (P-018) already reserves
 * an interactive-control lane and can hold a bulk stream outside the finite
 * budget, but both still share ONE origin, and a browser's per-origin
 * connection limit is enforced by the browser, not by us.  A saturated bulk
 * plane on the control origin therefore still competes for sockets no matter
 * how the in-process scheduler orders its own queue.
 *
 * The fix is structural rather than polite: bulk work is issued against a
 * DIFFERENT origin, so it draws from a different connection pool.  This module
 * is the declaration half of that contract — what a host supports, and where
 * its transfer plane lives.  `transfer-origin.ts` enforces the separation and
 * `scoped-ticket.ts` authorizes a single transfer across it.
 *
 * Capability is DECLARED by the host and VALIDATED here.  We never infer it
 * from a URL shape: a host that cannot resume must not be handed a resumable
 * upload that silently restarts from zero on the first network blip.
 */

/** How bulk bytes reach the host. */
export const TRANSFER_MODES = ['direct', 'reverse-connector'] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];

/**
 * `direct` — the browser reaches the transfer origin itself (a CDN-style or
 * separately-hosted bulk endpoint).
 *
 * `reverse-connector` — the workspace host has no inbound listener and dials
 * OUT to the control plane, which relays bulk frames.  This is the BYOC
 * posture: a customer VPC host we cannot address directly.  It is still a
 * distinct origin from the browser's point of view, which is the property
 * this whole contract depends on.
 */

export interface TransportCapability {
  /** Bulk delivery mode this host supports. */
  mode: TransferMode;
  /**
   * Absolute origin bulk traffic is issued against. MUST differ from the
   * control origin — see `assertDistinctTransferOrigin`.
   */
  transferOrigin: string;
  /** Host supports ranged resume of an interrupted transfer. */
  resumable: boolean;
  /**
   * Preferred chunk size in bytes. A host may cap this well below the
   * client's ideal (a reverse connector relays through a frame budget).
   */
  chunkBytes: number;
  /**
   * Concurrent chunk streams the host will accept. This bounds the TRANSFER
   * plane only; it never widens the control plane.
   */
  maxConcurrentChunks: number;
  /** Seconds a scoped ticket stays redeemable. Short by design. */
  ticketTtlSec: number;
}

/** The floor a host must clear to be usable at all. */
const MIN_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_TICKET_TTL_SEC = 900;

export class TransportCapabilityError extends Error {
  readonly code:
    | 'mode_unsupported'
    | 'transfer_origin_missing'
    | 'transfer_origin_invalid'
    | 'chunk_bytes_out_of_range'
    | 'concurrency_invalid'
    | 'ticket_ttl_invalid';

  constructor(code: TransportCapabilityError['code'], message: string) {
    super(message);
    this.name = 'TransportCapabilityError';
    this.code = code;
  }
}

function isAbsoluteOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.protocol && url.host);
  } catch {
    return false;
  }
}

/**
 * Parse and validate a host-declared capability.
 *
 * Deliberately strict: every refusal here is a misconfiguration that would
 * otherwise surface as a corrupted or stalled transfer much later, on a
 * customer's host, where it is far more expensive to diagnose.
 */
export function parseTransportCapability(input: unknown): TransportCapability {
  const raw = (input ?? {}) as Partial<TransportCapability>;

  const mode = raw.mode as TransferMode;
  if (!TRANSFER_MODES.includes(mode)) {
    throw new TransportCapabilityError(
      'mode_unsupported',
      `transport capability mode must be one of ${TRANSFER_MODES.join(', ')}; received ${String(raw.mode)}`,
    );
  }

  const transferOrigin = typeof raw.transferOrigin === 'string' ? raw.transferOrigin.trim() : '';
  if (!transferOrigin) {
    throw new TransportCapabilityError(
      'transfer_origin_missing',
      'transport capability requires an explicit transferOrigin; bulk traffic must never default to the control origin',
    );
  }
  if (!isAbsoluteOrigin(transferOrigin)) {
    throw new TransportCapabilityError(
      'transfer_origin_invalid',
      `transferOrigin must be an absolute origin (scheme + host); received ${transferOrigin}`,
    );
  }

  const chunkBytes = Number(raw.chunkBytes);
  if (!Number.isFinite(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES || chunkBytes > MAX_CHUNK_BYTES) {
    throw new TransportCapabilityError(
      'chunk_bytes_out_of_range',
      `chunkBytes must be between ${MIN_CHUNK_BYTES} and ${MAX_CHUNK_BYTES}; received ${String(raw.chunkBytes)}`,
    );
  }

  const maxConcurrentChunks = Number(raw.maxConcurrentChunks);
  if (!Number.isInteger(maxConcurrentChunks) || maxConcurrentChunks < 1) {
    throw new TransportCapabilityError(
      'concurrency_invalid',
      `maxConcurrentChunks must be a positive integer; received ${String(raw.maxConcurrentChunks)}`,
    );
  }

  const ticketTtlSec = Number(raw.ticketTtlSec);
  if (!Number.isInteger(ticketTtlSec) || ticketTtlSec < 1 || ticketTtlSec > MAX_TICKET_TTL_SEC) {
    throw new TransportCapabilityError(
      'ticket_ttl_invalid',
      `ticketTtlSec must be an integer in 1..${MAX_TICKET_TTL_SEC}; received ${String(raw.ticketTtlSec)}`,
    );
  }

  return {
    mode,
    transferOrigin,
    resumable: raw.resumable === true,
    chunkBytes: Math.floor(chunkBytes),
    maxConcurrentChunks,
    ticketTtlSec,
  };
}
