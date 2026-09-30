/**
 * file-lock-authority-ops — the AUTHORITY-side execution of file-claim lock ops
 * (Phase 2 of distributed-coordination-shared-harness-2026-06-04).
 *
 * When a peer resolves a REMOTE authority for a harness and routes a file-lock
 * acquire/release/queue there (routeFileLockOp → routeToAuthority →
 * PeerRpcTransport → POST /api/authority/rpc → handleAuthorityRpc), the authority
 * must RUN that op against ITS local lock store, on the requesting peer's behalf
 * (owner = the remote peer's owner id, carried in the payload). This module
 * registers the handlers for the `lock.acquire` / `lock.release` / `lock.queue`
 * op kinds.
 *
 * It binds to a minimal `FileLockCoordinator` SEAM rather than the concrete
 * su-lock-store, for two reasons: (1) it decouples from the locks package's exact
 * surface (which is mid-extraction to @papercusp/locks-core), and (2) it makes
 * the handlers fully testable with a fake coordinator. The operator adapts the
 * real su-lock-store (@papercusp/locks SuLocksCoordinator) to this seam at boot:
 *
 *   registerFileLockAuthorityOps(adaptSuLockStore());  // boot wiring
 *
 * The cross-machine model: peer A (non-authority) wants lock X → RPCs authority B
 * → B's store records X held by A → A's later release RPCs B again. B's single
 * store is the serialization point (proven by two-instance-authority.integration).
 */

import { registerAuthorityOp } from './authority-op-registry';
import { recordLockEvent, type LockEvent } from './lock-event-stream';
import {
  noteShaTokenGrant,
  noteShaTokenRelease,
  shaTokenForGrant,
  type ShaTokenGrant,
} from './sha-token-registry';

/** Acquire a file-claim lock on behalf of `owner` (the requesting peer). */
export interface FileLockAcquireParams {
  owner: string;
  ownerLabel?: string;
  paths: string[];
  intent: string;
  ttlSec: number;
  /** Durable work-item/plan goal associated with this lock, when known. */
  goalRef?: string | null;
  /** Internal automatic-guard acquire; never refresh an overlapping
   * deliberate same-owner claim. */
  automatic?: boolean;
  /** Optional bounded wait, mirroring locks:acquire. */
  waitMaxSec?: number;
  /**
   * The requester's coordination domain (repo realpath). Threaded on the wire so the
   * AUTHORITY runs the op against the lock store for the SAME physical repo — the lock
   * namespace is a property of the file on disk, and the authority + requester edit the
   * same shared checkout (different machines, same realpath). Required on the remote leg;
   * the authority builds its store binding from it.
   */
  coordinationDomain: string;
}
export interface FileLockReleaseParams {
  owner: string;
  lockId?: string;
  paths?: string[];
  allMine?: boolean;
  /** See FileLockAcquireParams.coordinationDomain. */
  coordinationDomain: string;
  /** G-0 (P-033) publish-then-release: the head sha the holder published to its
   *  hive-git namespace before releasing — stamped on the NEXT grant of these
   *  paths as `requiredSha`. Null/absent = released without publishing. */
  publishedSha?: string | null;
  /** Positive proof that a recognized native edit completed before release. */
  nativeEditProof?: NativeEditProof;
}

/** Evidence supplied by a native edit-result hook, never by lock acquisition. */
export interface NativeEditProof {
  success: true;
  source: 'claude' | 'codex' | 'omp';
  /** A single native tool (the common PostToolUse/OMP case). */
  tool?: string;
  /** Native tools covered by one successful Claude PostToolBatch. */
  tools?: string[];
  paths: string[];
}

const NATIVE_EDIT_TOOLS: Record<NativeEditProof['source'], ReadonlySet<string>> = {
  claude: new Set(['Edit', 'Write', 'MultiEdit']),
  codex: new Set(['apply_patch', 'write_file', 'edit_file', 'Edit', 'Write', 'MultiEdit']),
  omp: new Set(['write', 'edit', 'ast_edit', 'multi_edit']),
};

/**
 * Validate the positive edit proof at the release boundary. Lock ownership is
 * intent only; attribution requires a successful recognized native tool and the
 * exact paths the release actually freed. Compare paths as sets because a lock
 * store may return rows in a different order, while rejecting duplicates/extras.
 */
export function isNativeEditProofForPaths(
  value: unknown,
  released: readonly string[],
): value is NativeEditProof {
  if (!value || typeof value !== 'object') return false;
  const proof = value as Partial<NativeEditProof>;
  if (proof.success !== true) return false;
  const source = proof.source;
  if (source !== 'claude' && source !== 'codex' && source !== 'omp') return false;
  const tools = [
    ...(typeof proof.tool === 'string' ? [proof.tool] : []),
    ...(Array.isArray(proof.tools) ? proof.tools : []),
  ];
  if (tools.length === 0 || tools.some((tool) => typeof tool !== 'string' || !NATIVE_EDIT_TOOLS[source].has(tool))) {
    return false;
  }
  if (!Array.isArray(proof.paths) || proof.paths.length === 0) return false;
  if (!proof.paths.every((path) => typeof path === 'string' && path.length > 0)) return false;
  if (new Set(proof.paths).size !== proof.paths.length || new Set(released).size !== released.length) return false;
  if (proof.paths.length !== released.length) return false;
  const releasedSet = new Set(released);
  return proof.paths.every((path) => releasedSet.has(path));
}
export interface FileLockQueueParams {
  owner: string;
  paths?: string[];
  /** See FileLockAcquireParams.coordinationDomain. */
  coordinationDomain: string;
}

/** A final-write race is not holder contention. The requester should retry
 * the acquire from scratch; the busy snapshot can be empty by the time it is
 * read. */
export type FileLockAcquireRetryReason = 'upsert_race';

export interface FileLockAcquireResult {
  ok: boolean;
  lockId?: string;
  expiresTs?: string;
  /** paths that were busy when ok=false. */
  busy?: Array<{ path: string; owner: string }>;
  /** Present when the authority could not establish a stable holder snapshot. */
  reason?: FileLockAcquireRetryReason | 'queued_waiter';
  retryable?: boolean;
  /** Paths newly acquired by this call. Same-owner refreshes can return a
   * subset (or an empty list), so automatic guards never release a
   * deliberate lock that merely overlaps their edit. */
  newlyHeld?: string[];
  /** G-0 (P-033) sha-token stamp on a grant: the prior holder's published head
   *  (`requiredSha`) + the expiry-reclaim warning (`unsyncedRisk`). The acquirer
   *  checks requiredSha against its local staging / parked heads via
   *  sync/hive-git/handoff-token.ts (classifyRequiredSha / gradeShaTokenGrant). */
  shaToken?: ShaTokenGrant;
}

/** The minimal lock-store surface the authority ops drive. The operator adapts
 *  the real su-lock-store to this at boot; tests inject a fake. */
export interface FileLockCoordinator {
  acquire(p: FileLockAcquireParams): Promise<FileLockAcquireResult>;
  /** `released` is the list of paths actually released — carried (not a count) so the
   *  requester's routed-release response matches the local-release shape exactly.
   *
   *  `heldBefore` (EI-20405390083792304) is how many live locks the owner held in
   *  this domain at release time. It disambiguates an empty `released`: 0 means the
   *  owner genuinely held nothing (a correct no-op), >0 means the owner held locks
   *  the selector did not match (a release that silently did nothing). OPTIONAL on
   *  purpose — an older peer authority, or an injected fake, may not supply it, and
   *  the requester must render that as UNKNOWN rather than defaulting it to 0, which
   *  would fabricate the very "you held nothing" answer this field exists to stop. */
  release(p: FileLockReleaseParams): Promise<{ ok: boolean; released?: string[]; heldBefore?: number }>;
  queue(p: FileLockQueueParams): Promise<unknown>;
}

/** The op kinds this module registers — exported so callers/tests can reference
 *  them without string literals (and the claim layer can avoid collisions). */
export const FILE_LOCK_OP_KINDS = {
  acquire: 'lock.acquire',
  release: 'lock.release',
  queue: 'lock.queue',
} as const;

/** Options for {@link buildFileLockAuthorityHandlers} — the lock-event capture
 *  seam (P-015) + an injectable clock, both defaulted for production. */
export interface FileLockAuthorityHandlerOpts {
  /** Injectable clock for the emitted lock-event `ts`. Default `Date.now`. */
  now?: () => number;
  /**
   * Emit a lock-event when the authority grants/releases on a peer's behalf
   * (P-015 instant-handover stream). Default: fire-and-forget {@link recordLockEvent}
   * into the installed sink (no-op single box). Tests inject a capture to assert.
   */
  emit?: (event: LockEvent) => void;
}

/** Best-effort: derive the absolute expiry ms from the store's ISO `expiresTs`,
 *  falling back to `now + ttlSec*1000` when the store didn't return one. */
function expiryMs(expiresTs: string | undefined, nowMs: number, ttlSec: number): number {
  if (expiresTs) {
    const parsed = Date.parse(expiresTs);
    if (Number.isFinite(parsed)) return parsed;
  }
  return nowMs + ttlSec * 1000;
}

/**
 * Emit one P-015 `acquire` lock-event per held path. Shared by the authority-side
 * RPC handler below (a remote peer's grant) AND the verb-local acquire path
 * (`locks:acquire`'s `op.local()`, run when THIS peer is itself the authority or
 * is fail-opening — WI-1550: that path used to never call `emit` at all, so the
 * instant-handover stream was missing every locally-granted lock).
 */
export function emitAcquireLockEvents(
  emit: (event: LockEvent) => void,
  params: { scope: string; owner: string; paths: string[]; expiresAtMs: number; ts: number },
): void {
  for (const path of params.paths) {
    emit({ kind: 'acquire', scope: params.scope, path, owner: params.owner, expiresAtMs: params.expiresAtMs, ts: params.ts });
  }
}

/** The release-side twin of {@link emitAcquireLockEvents} — see there for why both
 *  the authority handler and the verb-local release path share this. */
export function emitReleaseLockEvents(
  emit: (event: LockEvent) => void,
  params: { scope: string; owner: string; released: string[]; ts: number; publishedSha?: string | null },
): void {
  for (const path of params.released) {
    emit({
      kind: 'release',
      scope: params.scope,
      path,
      owner: params.owner,
      ts: params.ts,
      ...(params.publishedSha ? { publishedSha: params.publishedSha } : {}),
    });
  }
}

/**
 * Build the file-lock authority op handlers bound to `coordinator` — the same
 * validation + dispatch {@link registerFileLockAuthorityOps} installs globally,
 * as a plain map. Lets a multi-instance rig (e.g. the cross-machine failover
 * E2E) run the REAL handlers against per-instance stores, where the process-
 * global registry can only model one machine.
 *
 * P-015: on a SUCCESSFUL acquire/release the handler emits a lock-event into the
 * federated stream (`opts.emit`, default {@link recordLockEvent}). This is the
 * authority-side capture point — every cross-machine grant routes through here
 * (`routeToAuthority` → this handler on the elected authority), so the stream is
 * the authority's record of what it has granted, which a NEW authority reads to
 * reconstruct instantly on failover. Emission is fire-and-forget and never
 * affects the op result (capture failure → heartbeat fallback).
 */
export function buildFileLockAuthorityHandlers(
  coordinator: FileLockCoordinator,
  opts: FileLockAuthorityHandlerOpts = {},
): Record<string, (payload: unknown, harnessSlug: string) => Promise<unknown>> {
  const now = opts.now ?? Date.now;
  const emit = opts.emit ?? ((event: LockEvent) => void recordLockEvent(event));

  return {
    [FILE_LOCK_OP_KINDS.acquire]: async (payload, scope) => {
      const p = payload as Partial<FileLockAcquireParams>;
      if (
        !p ||
        typeof p.owner !== 'string' ||
        !Array.isArray(p.paths) ||
        typeof p.intent !== 'string' ||
        typeof p.coordinationDomain !== 'string'
      ) {
        throw new Error('lock.acquire: invalid payload (owner, paths[], intent, coordinationDomain required)');
      }
      const ttlSec = typeof p.ttlSec === 'number' ? p.ttlSec : 1200;
      const result = await coordinator.acquire({
        owner: p.owner,
        ownerLabel: p.ownerLabel,
        paths: p.paths,
        intent: p.intent,
        ttlSec,
        goalRef: p.goalRef,
        automatic: p.automatic,
        waitMaxSec: p.waitMaxSec,
        coordinationDomain: p.coordinationDomain,
      });
      if (result.ok) {
        const ts = now();
        const expiresAtMs = expiryMs(result.expiresTs, ts, ttlSec);
        // G-0 (P-033): stamp the grant with the prior holder's published sha /
        // the expiry-reclaim warning, THEN record this grant. `p.owner` is
        // passed as the acquiring identity so a holder re-acquiring its OWN
        // expired-but-unreleased grant isn't misreported as unsynced risk
        // (WI-1549).
        const shaToken = shaTokenForGrant(p.coordinationDomain, p.paths, ts, p.owner);
        noteShaTokenGrant(p.coordinationDomain, p.paths, p.owner, expiresAtMs);
        emitAcquireLockEvents(emit, { scope, owner: p.owner, paths: p.paths, expiresAtMs, ts });
        return { ...result, shaToken };
      }
      return result;
    },

    [FILE_LOCK_OP_KINDS.release]: async (payload, scope) => {
      const p = payload as Partial<FileLockReleaseParams>;
      if (!p || typeof p.owner !== 'string' || typeof p.coordinationDomain !== 'string') {
        throw new Error('lock.release: invalid payload (owner, coordinationDomain required)');
      }
      const owner = p.owner;
      const result = await coordinator.release({
        owner,
        lockId: p.lockId,
        paths: p.paths,
        allMine: p.allMine,
        coordinationDomain: p.coordinationDomain,
        ...(p.nativeEditProof ? { nativeEditProof: p.nativeEditProof } : {}),
      });
      if (result.ok && result.released) {
        const ts = now();
        // G-0 (P-033) publish-then-release: remember the published sha for the
        // next grant; the release event carries it so a failover authority can
        // rebuild sha-token state from the P-015 stream.
        const publishedSha = typeof p.publishedSha === 'string' ? p.publishedSha : null;
        noteShaTokenRelease(p.coordinationDomain, result.released, publishedSha, ts);
        emitReleaseLockEvents(emit, { scope, owner, released: result.released, ts, publishedSha });
      }
      return result;
    },

    [FILE_LOCK_OP_KINDS.queue]: async (payload) => {
      const p = payload as Partial<FileLockQueueParams>;
      if (!p || typeof p.owner !== 'string' || typeof p.coordinationDomain !== 'string') {
        throw new Error('lock.queue: invalid payload (owner, coordinationDomain required)');
      }
      return coordinator.queue({ owner: p.owner, paths: p.paths, coordinationDomain: p.coordinationDomain });
    },
  };
}

/**
 * Register the file-lock authority op handlers against `coordinator`. Call ONCE
 * at boot. Each handler validates the payload shape, then runs the op locally.
 * `opts` threads the P-015 lock-event capture (default: the installed sink).
 */
export function registerFileLockAuthorityOps(
  coordinator: FileLockCoordinator,
  opts: FileLockAuthorityHandlerOpts = {},
): void {
  for (const [kind, handler] of Object.entries(buildFileLockAuthorityHandlers(coordinator, opts))) {
    registerAuthorityOp(kind, handler);
  }
}
