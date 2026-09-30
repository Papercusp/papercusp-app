/**
 * Short-lived, generation-bound admission credit for latency-sensitive callers.
 *
 * The central governor remains authoritative. A local pool may spend only the
 * immutable credit it was explicitly issued, while the issuing generation is
 * current and its authority heartbeat is live. Credit is ephemeral feedback
 * state, never a configured capacity limit or input to future issuance.
 */

import type { AdmissionClass } from './admission';
import type { HealthResource } from './health-analysis';

export const LOCAL_ADMISSION_LEASE_SCHEMA_VERSION = 1 as const;

export interface LocalAdmissionLease {
  readonly schemaVersion: typeof LOCAL_ADMISSION_LEASE_SCHEMA_VERSION;
  readonly leaseId: string;
  readonly generation: number;
  readonly admissionClass: AdmissionClass;
  /** Empty means class-wide; otherwise every requested resource must be present. */
  readonly resourceScope: readonly HealthResource[];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  /** The authority must refresh or replace the lease before this instant. */
  readonly authorityExpiresAtMs: number;
  readonly remainingCredit: number;
}

export type LocalAdmissionTraffic = 'ordinary-start' | 'running' | 'control';

export type LocalAdmissionDecision =
  | {
      readonly admitted: true;
      readonly via: 'lease' | 'protected';
      readonly generation: number;
      readonly leaseId?: string;
      readonly remainingCredit?: number;
    }
  | {
      readonly admitted: false;
      readonly reason:
        | 'governor-unavailable'
        | 'no-matching-lease'
        | 'stale-generation'
        | 'expired'
        | 'credit-exhausted';
      readonly generation: number;
    };

export interface LocalAdmissionLeasePoolOptions {
  readonly now?: () => number;
  readonly protectedClasses?: ReadonlySet<AdmissionClass>;
}

interface LeaseEntry {
  readonly lease: LocalAdmissionLease;
  remainingCredit: number;
  revoked: boolean;
}

function finiteTimestamp(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative timestamp`);
  return Math.floor(value);
}

function normalizeLease(input: LocalAdmissionLease): LocalAdmissionLease {
  const leaseId = input.leaseId.trim();
  const admissionClass = input.admissionClass.trim();
  if (!leaseId) throw new Error('local admission leaseId must be non-empty');
  if (!admissionClass) throw new Error('local admission admissionClass must be non-empty');
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('local admission generation must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(input.remainingCredit) || input.remainingCredit < 0) {
    throw new Error('local admission remainingCredit must be a non-negative safe integer');
  }
  const issuedAtMs = finiteTimestamp(input.issuedAtMs, 'issuedAtMs');
  const expiresAtMs = finiteTimestamp(input.expiresAtMs, 'expiresAtMs');
  const authorityExpiresAtMs = finiteTimestamp(input.authorityExpiresAtMs, 'authorityExpiresAtMs');
  if (expiresAtMs <= issuedAtMs) throw new Error('local admission lease must expire after it is issued');
  if (authorityExpiresAtMs < issuedAtMs || authorityExpiresAtMs > expiresAtMs) {
    throw new Error('authorityExpiresAtMs must be within the lease lifetime');
  }
  const resourceScope = [...new Set(input.resourceScope)].sort();
  return Object.freeze({
    schemaVersion: LOCAL_ADMISSION_LEASE_SCHEMA_VERSION,
    leaseId,
    generation: input.generation,
    admissionClass,
    resourceScope: Object.freeze(resourceScope),
    issuedAtMs,
    expiresAtMs,
    authorityExpiresAtMs,
    remainingCredit: input.remainingCredit,
  });
}

/**
 * Process-local lease consumer. `tryAdmit` is deliberately synchronous: the
 * credit check and decrement form one JavaScript turn and cannot interleave.
 */
export class LocalAdmissionLeasePool {
  readonly #now: () => number;
  readonly #protectedClasses: ReadonlySet<AdmissionClass>;
  readonly #leases = new Map<string, LeaseEntry>();
  #generation = 0;
  #authorityAvailable = false;

  constructor(options: LocalAdmissionLeasePoolOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#protectedClasses = new Set(options.protectedClasses ?? ['control']);
  }

  get generation(): number {
    return this.#generation;
  }

  /** Publish central state. Moving generation forward revokes every older lease. */
  publish(input: LocalAdmissionLease): LocalAdmissionLease {
    const lease = normalizeLease(input);
    if (lease.generation < this.#generation) throw new Error('cannot publish a stale local admission generation');
    if (lease.generation > this.#generation) {
      this.#generation = lease.generation;
      for (const entry of this.#leases.values()) {
        if (entry.lease.generation < lease.generation) entry.revoked = true;
      }
    }
    const existing = this.#leases.get(lease.leaseId);
    if (existing) {
      const same = JSON.stringify(existing.lease) === JSON.stringify(lease);
      if (!same) throw new Error(`local admission lease '${lease.leaseId}' was republished with different content`);
      this.#authorityAvailable = true;
      return existing.lease;
    }
    this.#leases.set(lease.leaseId, { lease, remainingCredit: lease.remainingCredit, revoked: false });
    this.#authorityAvailable = true;
    return lease;
  }

  /** Observe a central generation even when it issues no credit. */
  observeAuthority(input: { readonly generation: number; readonly available: boolean }): void {
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new Error('local admission generation must be a non-negative safe integer');
    }
    if (input.generation < this.#generation) return;
    if (input.generation > this.#generation) {
      this.#generation = input.generation;
      for (const entry of this.#leases.values()) {
        if (entry.lease.generation < input.generation) entry.revoked = true;
      }
    }
    this.#authorityAvailable = input.available;
  }

  revoke(leaseId: string): boolean {
    const entry = this.#leases.get(leaseId);
    if (!entry || entry.revoked) return false;
    entry.revoked = true;
    return true;
  }

  tryAdmit(input: {
    readonly admissionClass: AdmissionClass;
    readonly resources?: readonly HealthResource[];
    readonly traffic?: LocalAdmissionTraffic;
    readonly atMs?: number;
  }): LocalAdmissionDecision {
    const admissionClass = input.admissionClass.trim();
    if (!admissionClass) throw new Error('local admission admissionClass must be non-empty');
    const traffic = input.traffic ?? 'ordinary-start';
    if (traffic === 'running' || traffic === 'control' || this.#protectedClasses.has(admissionClass)) {
      return Object.freeze({ admitted: true, via: 'protected', generation: this.#generation });
    }
    if (!this.#authorityAvailable) {
      return Object.freeze({ admitted: false, reason: 'governor-unavailable', generation: this.#generation });
    }

    const atMs = finiteTimestamp(input.atMs ?? this.#now(), 'atMs');
    const resources = [...new Set(input.resources ?? [])];
    let sawStale = false;
    let sawExpired = false;
    let sawExhausted = false;
    const candidates = [...this.#leases.values()]
      .filter((entry) => entry.lease.admissionClass === admissionClass)
      .sort((a, b) => a.lease.expiresAtMs - b.lease.expiresAtMs || a.lease.leaseId.localeCompare(b.lease.leaseId));
    for (const entry of candidates) {
      const lease = entry.lease;
      if (entry.revoked || lease.generation !== this.#generation) {
        sawStale = true;
        continue;
      }
      if (atMs >= lease.expiresAtMs || atMs >= lease.authorityExpiresAtMs) {
        sawExpired = true;
        continue;
      }
      if (lease.resourceScope.length > 0 && resources.some((resource) => !lease.resourceScope.includes(resource))) {
        continue;
      }
      if (entry.remainingCredit <= 0) {
        sawExhausted = true;
        continue;
      }
      entry.remainingCredit -= 1;
      return Object.freeze({
        admitted: true,
        via: 'lease',
        generation: lease.generation,
        leaseId: lease.leaseId,
        remainingCredit: entry.remainingCredit,
      });
    }
    return Object.freeze({
      admitted: false,
      reason: sawExhausted
        ? 'credit-exhausted'
        : sawExpired
          ? 'expired'
          : sawStale
            ? 'stale-generation'
            : 'no-matching-lease',
      generation: this.#generation,
    });
  }
}
