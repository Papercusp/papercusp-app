/**
 * FileLockQueueCoordinator — thin adapter that makes the in-process
 * FileLockQueue satisfy `@papercusp/file-claim`'s shared
 * `FileClaimCoordinator` interface (file-locking #11).
 *
 * The adapter:
 *   - Issues a fresh `claimId` per acquire (UUID); maps it to the
 *     underlying `LockHandle` so release/extend/heartbeat target the
 *     right handle.
 *   - Maps `waitMs: 0` to the underlying `timeoutMs: 0` (a try-acquire;
 *     timer fires on the next macrotask if the path is contended; the
 *     sync fast-path returns the handle without scheduling the timer
 *     when the path is free).
 *   - `extend()` returns a NEW claim (per file-locking #10) — internally
 *     it just calls `tryExtend` on the held handle and surfaces the
 *     mutated handle's path set as a fresh `FileClaim`.
 *   - `heartbeat()` is a structural no-op: in-process holds have no
 *     TTL, so any non-released claim is by definition still alive.
 *   - `reap()` delegates to the queue's `reap(owner)` and removes the
 *     reaped claims from the adapter's id→handle map.
 *
 * Per the file-claim interface contract:
 *   - Atomic multi-path, FIFO, no-deadlock — already true of the
 *     underlying queue.
 *   - extend never mutates the input claim — adapter returns a fresh
 *     FileClaim object every time.
 *   - release idempotent — adapter no-ops on already-released claims.
 */

import { randomUUID } from 'node:crypto';
import type {
  AcquireOptions,
  AcquireResult,
  BusyEntry,
  ExtendOptions,
  ExtendResult,
  FileClaim,
  FileClaimCoordinator,
  HeartbeatResult,
} from '@papercusp/file-claim';
import {
  FileLockQueue,
  LockAcquireTimeoutError,
  type LockHandle,
} from './file-lock-queue.js';

interface AdapterEntry {
  claimId: string;
  handle: LockHandle;
}

export class FileLockQueueCoordinator implements FileClaimCoordinator {
  private readonly byId = new Map<string, AdapterEntry>();

  constructor(private readonly queue: FileLockQueue = new FileLockQueue()) {}

  /** The wrapped queue, exposed for adapter-internal tests + the
   *  orchestrator code that still talks to the queue directly. */
  get underlying(): FileLockQueue {
    return this.queue;
  }

  async acquire(
    owner: string,
    paths: readonly string[],
    options: AcquireOptions = {},
  ): Promise<AcquireResult> {
    const waitMs = options.waitMs ?? 0;
    try {
      const handle = await this.queue.acquire(owner, paths, {
        timeoutMs: waitMs,
      });
      const entry = this.track(handle);
      return { ok: true, claim: this.toFileClaim(entry) };
    } catch (e) {
      if (e instanceof LockAcquireTimeoutError) {
        return { ok: false, busy: this.busyForPaths(e.paths) };
      }
      throw e;
    }
  }

  async release(claim: FileClaim): Promise<void> {
    const entry = this.byId.get(claim.claimId);
    if (entry === undefined) return; // idempotent
    this.byId.delete(claim.claimId);
    if (!entry.handle.released) this.queue.release(entry.handle);
  }

  async extend(claim: FileClaim, options: ExtendOptions): Promise<ExtendResult> {
    const entry = this.byId.get(claim.claimId);
    if (entry === undefined) {
      // Caller is trying to extend a release-then-extend or a foreign
      // claim. Surface as busy on the requested adds (most useful
      // shape for callers) rather than throwing.
      return {
        ok: false,
        busy: this.busyForPaths(options.addPaths ?? []),
      };
    }
    const adds = options.addPaths ?? [];
    if (adds.length === 0) {
      return { ok: true, claim: this.toFileClaim(entry) };
    }
    const ok = this.queue.tryExtend(entry.handle, adds);
    if (!ok) return { ok: false, busy: this.busyForPaths(adds) };
    return { ok: true, claim: this.toFileClaim(entry) };
  }

  async heartbeat(claim: FileClaim): Promise<HeartbeatResult> {
    const entry = this.byId.get(claim.claimId);
    if (entry === undefined || entry.handle.released) {
      return { ok: false, expired: true };
    }
    // In-process holds have no TTL; the claim's current state is its
    // live state — return it unchanged.
    return { ok: true, claim: this.toFileClaim(entry) };
  }

  async reap(owner: string): Promise<number> {
    const n = this.queue.reap(owner);
    // Drop adapter-tracked claims for this owner so subsequent releases
    // are no-ops (the underlying handles are already cleared).
    for (const [id, entry] of [...this.byId]) {
      if (entry.handle.owner === owner) this.byId.delete(id);
    }
    return n;
  }

  // ── private helpers ────────────────────────────────────────────────

  private track(handle: LockHandle): AdapterEntry {
    const entry: AdapterEntry = { claimId: randomUUID(), handle };
    this.byId.set(entry.claimId, entry);
    return entry;
  }

  private toFileClaim(entry: AdapterEntry): FileClaim {
    return {
      claimId: entry.claimId,
      owner: entry.handle.owner,
      paths: [...entry.handle.paths],
      expiresAt: null, // in-process queue has no TTL
    };
  }

  private busyForPaths(paths: readonly string[]): BusyEntry[] {
    const holders = this.queue.peekHolders(paths);
    const out: BusyEntry[] = [];
    for (const p of paths) {
      const owner = holders.get(p);
      if (owner !== undefined) {
        out.push({ path: p, owner, expiresAt: null });
      }
    }
    return out;
  }
}
