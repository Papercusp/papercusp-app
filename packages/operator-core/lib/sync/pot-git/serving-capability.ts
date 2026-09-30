import { deriveSwarmTopic } from '../hyperbee/derive-swarm-topic';
import { isSignedProtocolContext, signedProtocolContextMatches, type SignedProtocolContext, type SignedProtocolScope } from './signed-context';

/** Owner-issued leases travel over the existing handle/RPC/status advertisement.
 * A status snapshot is discovery evidence, never permission to invent an actor. */
export const GIT_SERVING_LEASE_MS = 30_000;

export interface GitServingRequest {
  workspaceId: string;
  installSlug: string;
  potHomeSlug: string;
  scope: SignedProtocolScope;
}

export interface GitServingIdentity {
  devicePubkeyBase64: string;
  githubUserId: number;
  keychainId: string;
}

export interface GitServingCapability extends GitServingRequest {
  v: 1;
  /** Replaced on every owner boot or swarm join/rekey. */
  runtimeId: string;
  identity: GitServingIdentity;
  context: SignedProtocolContext;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type GitServingUnavailableStatus = 'unknown' | 'absent' | 'stopped' | 'never-created';
export type GitServingState =
  | { status: 'ready'; capability: GitServingCapability }
  | { status: GitServingUnavailableStatus; retryable: true; reason: string };

export function gitServingUnavailable(status: GitServingUnavailableStatus, reason: string): GitServingState {
  return { status, retryable: true, reason };
}

export class GitServingUnavailableError extends Error {
  readonly retryable = true;
  readonly code = 'GIT_SERVING_UNAVAILABLE';
  constructor(readonly state: GitServingState) {
    super(`pot-git serving unavailable: ${state.status}${state.status === 'ready' ? '' : ` (${state.reason})`}; retry next tick`);
  }
}

export interface LiveGitServingOwner {
  runtimeId: string;
  workspaceId: string;
  potHomeSlug: string;
  topicHex: string;
  identity: GitServingIdentity;
}

/** Runs in the process that owns the live serve plane. Recheck after I/O so a
 * close/rekey during generation allocation cannot mint a usable old lease. */
export async function issueGitServingCapability(request: GitServingRequest, deps: {
  current(): LiveGitServingOwner | null;
  resolveContext(request: GitServingRequest, device: string): Promise<SignedProtocolContext | null>;
  now?: () => number;
}): Promise<GitServingState> {
  const owner = deps.current();
  if (!owner) return gitServingUnavailable('stopped', 'no live Git serve plane');
  if (owner.workspaceId !== request.workspaceId || owner.potHomeSlug !== request.potHomeSlug ||
      owner.topicHex !== deriveSwarmTopic({ kind: 'hive', hive_pubkey: request.scope.hive_id }).toString('hex')) {
    return gitServingUnavailable('absent', 'serving owner does not own the requested hive');
  }
  try {
    const context = await deps.resolveContext(request, owner.identity.devicePubkeyBase64);
    if (!context) return gitServingUnavailable('never-created', 'no physical Git repository exists');
    const current = deps.current();
    if (!current || current.runtimeId !== owner.runtimeId || current.topicHex !== owner.topicHex ||
        current.identity.devicePubkeyBase64 !== owner.identity.devicePubkeyBase64) {
      return gitServingUnavailable('stopped', 'serving owner changed during capability issuance');
    }
    const issuedAtMs = (deps.now ?? Date.now)();
    return validateGitServingState({ status: 'ready', capability: {
      ...request, v: 1, runtimeId: owner.runtimeId, identity: {
        devicePubkeyBase64: owner.identity.devicePubkeyBase64,
        githubUserId: owner.identity.githubUserId, keychainId: owner.identity.keychainId,
      }, context,
      issuedAtMs, expiresAtMs: issuedAtMs + GIT_SERVING_LEASE_MS,
    } }, request, issuedAtMs);
  } catch (error) {
    return gitServingUnavailable('unknown', error instanceof Error ? error.message : String(error));
  }
}

/** Treat every RPC/PG payload as untrusted shape, including old owner versions. */
export function validateGitServingState(value: unknown, request: GitServingRequest, now = Date.now()): GitServingState {
  if (!value || typeof value !== 'object') return gitServingUnavailable('unknown', 'owner supplied no capability');
  const state = value as Partial<GitServingState>;
  if (state.status !== 'ready') {
    if (['unknown', 'absent', 'stopped', 'never-created'].includes(state.status ?? '') &&
        'reason' in state && typeof state.reason === 'string') {
      return gitServingUnavailable(state.status as GitServingUnavailableStatus, state.reason);
    }
    return gitServingUnavailable('unknown', 'unrecognized serving state');
  }
  const cap = state.capability;
  if (!cap || cap.v !== 1 || !cap.runtimeId || !isSignedProtocolContext(cap.context) ||
      !signedProtocolContextMatches(cap.context, request.scope) ||
      cap.workspaceId !== request.workspaceId || cap.installSlug !== request.installSlug ||
      cap.potHomeSlug !== request.potHomeSlug || !signedProtocolContextMatches(cap.scope, request.scope) ||
      !cap.identity?.devicePubkeyBase64 || !cap.identity.keychainId ||
      !Number.isSafeInteger(cap.identity.githubUserId) || cap.identity.githubUserId <= 0 ||
      !Number.isFinite(cap.issuedAtMs) || !Number.isFinite(cap.expiresAtMs) ||
      cap.issuedAtMs > now || cap.expiresAtMs <= now || cap.expiresAtMs <= cap.issuedAtMs ||
      cap.expiresAtMs - cap.issuedAtMs > GIT_SERVING_LEASE_MS) {
    return gitServingUnavailable('unknown', 'expired, malformed or mismatched serving capability');
  }
  return { status: 'ready', capability: cap };
}

/** Never release a signature if discovery changed while signing (keychain I/O
 * can outlive a lease). A renewed lease must retain the exact runtime/context. */
export async function assertGitServingCapability(capability: GitServingCapability, request: GitServingRequest,
  resolve: () => Promise<GitServingState>,
): Promise<void> {
    // A long Git operation may outlive the original lease. Fresh reissuance
    // below can renew it, but only for this exact runtime and store context.
    const initial = validateGitServingState({ status: 'ready', capability }, request, capability.issuedAtMs);
    if (initial.status !== 'ready') throw new GitServingUnavailableError(initial);
    const state = validateGitServingState(await resolve(), request);
    if (state.status !== 'ready') throw new GitServingUnavailableError(state);
    const current = state.capability;
    if (current.runtimeId !== capability.runtimeId ||
        !signedProtocolContextMatches(current.context, capability.context) ||
        current.identity.devicePubkeyBase64 !== capability.identity.devicePubkeyBase64 ||
        current.identity.keychainId !== capability.identity.keychainId ||
        current.identity.githubUserId !== capability.identity.githubUserId) {
      throw new GitServingUnavailableError(gitServingUnavailable('unknown', 'serving authority changed before publication'));
    }
}

export function guardGitServingSigner(capability: GitServingCapability, request: GitServingRequest,
  resolve: () => Promise<GitServingState>, sign: (bytes: Buffer) => Promise<Buffer>,
): (bytes: Buffer) => Promise<Buffer> {
  return async (bytes) => {
    await assertGitServingCapability(capability, request, resolve);
    const signature = await sign(bytes);
    await assertGitServingCapability(capability, request, resolve);
    return signature;
  };
}
