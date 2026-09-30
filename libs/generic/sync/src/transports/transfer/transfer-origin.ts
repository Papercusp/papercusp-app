/**
 * Transfer origin — the structural half of the P-021 separation.
 *
 * `transport-capability.ts` declares WHERE bulk traffic goes.  This module
 * enforces that it actually goes somewhere else, and hands callers a scheduler
 * bound to that other origin.
 *
 * WHY A SEPARATE ORIGIN AND NOT JUST A SEPARATE LANE.  The origin scheduler
 * already has a `bulk` class, a `maxBulk` ceiling, and `reservedInteractive`
 * slots.  Within one process that is enough to order our own queue.  It is NOT
 * enough to protect control traffic, because the binding constraint under
 * D-002 is the BROWSER's per-origin connection limit — six on HTTP/1.1 — and
 * the browser applies that limit to sockets, not to our intentions.  A bulk
 * upload holding a socket is holding it whether or not our scheduler thinks it
 * is in the `bulk` class.
 *
 * Issuing bulk work against a different origin gives it a different connection
 * pool.  That is a property of the browser rather than of our code, which is
 * exactly what makes it hold under load, and it is why this module REFUSES to
 * proceed when the two origins coincide instead of degrading quietly: a
 * misconfiguration that collapses the transfer plane back onto the control
 * origin would reintroduce the whole problem while every in-process metric
 * still looked healthy.
 */

import {
  getOriginScheduler,
  normalizeOrigin,
  type OriginScheduler,
} from '../polling/origin-scheduler';
import type { TransportCapability } from './transport-capability';

export class TransferOriginError extends Error {
  readonly code: 'not_distinct' | 'control_origin_missing';
  readonly controlOrigin: string;
  readonly transferOrigin: string;

  constructor(
    code: TransferOriginError['code'],
    message: string,
    controlOrigin: string,
    transferOrigin: string,
  ) {
    super(message);
    this.name = 'TransferOriginError';
    this.code = code;
    this.controlOrigin = controlOrigin;
    this.transferOrigin = transferOrigin;
  }
}

/**
 * Throw unless the transfer origin is genuinely a different origin from the
 * control origin.
 *
 * Comparison is on the NORMALIZED origin, so `https://x.test` and
 * `https://x.test/bulk/` are correctly recognized as the same origin — the
 * near-miss a hand-written config is most likely to produce, and the one a
 * naive string compare would wave through.
 */
export function assertDistinctTransferOrigin(
  controlOrigin: string,
  transferOrigin: string,
): { controlOrigin: string; transferOrigin: string } {
  const control = typeof controlOrigin === 'string' ? controlOrigin.trim() : '';
  if (!control) {
    throw new TransferOriginError(
      'control_origin_missing',
      'a control origin is required to prove the transfer origin differs from it',
      controlOrigin,
      transferOrigin,
    );
  }

  const normalizedControl = normalizeOrigin(control);
  const normalizedTransfer = normalizeOrigin(transferOrigin, normalizedControl);

  if (normalizedControl === normalizedTransfer) {
    throw new TransferOriginError(
      'not_distinct',
      `transfer origin ${normalizedTransfer} is the control origin; bulk traffic would compete for the control origin's connection pool and the P-021 reservation would be void`,
      normalizedControl,
      normalizedTransfer,
    );
  }

  return { controlOrigin: normalizedControl, transferOrigin: normalizedTransfer };
}

export interface TransferPlane {
  /** Normalized control origin this plane was separated from. */
  readonly controlOrigin: string;
  /** Normalized origin bulk work is issued against. */
  readonly transferOrigin: string;
  /** Scheduler for the TRANSFER origin. Never the control scheduler. */
  readonly scheduler: OriginScheduler;
  /** The validated capability this plane was built from. */
  readonly capability: TransportCapability;
}

/**
 * Resolve the transfer plane for a capability, given the control origin.
 *
 * The returned scheduler is the registry's scheduler for the TRANSFER origin.
 * Because the registry is keyed by normalized origin, and we have just proven
 * the two origins differ, this can never be the control origin's scheduler —
 * the separation is enforced by construction rather than by a caller
 * remembering to pass the right key.
 *
 * The transfer scheduler's finite cap is the host's declared chunk
 * concurrency. It is deliberately NOT derived from the control profile: the
 * two planes are sized by different constraints (control by interaction
 * latency, transfer by host relay throughput), and coupling them would let a
 * generous host quietly widen the control budget.
 */
export function resolveTransferPlane(
  capability: TransportCapability,
  controlOrigin: string,
): TransferPlane {
  const { controlOrigin: control, transferOrigin: transfer } = assertDistinctTransferOrigin(
    controlOrigin,
    capability.transferOrigin,
  );

  const scheduler = getOriginScheduler(transfer, {
    limit: capability.maxConcurrentChunks,
    // The transfer plane carries no interactive work, so it reserves nothing.
    // Reserving here would strand a chunk slot for traffic that never arrives.
    reservedInteractive: 0,
    maxBulk: capability.maxConcurrentChunks,
    profile: capability.mode === 'reverse-connector' ? 'reverse-connector' : 'transfer',
  });

  return { controlOrigin: control, transferOrigin: transfer, scheduler, capability };
}
