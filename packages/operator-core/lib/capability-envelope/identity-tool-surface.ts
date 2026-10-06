/**
 * P-012 / D-040(b,c): the tool surface a governed identity wearer SEES is the
 * set the identity kernel ADMITS. Visibility is computed by asking the same
 * per-call gate (`checkIdentityGrantKernel`) about every candidate name, so
 * there is no second decision path to drift from enforcement. Authority never
 * depends on this: the kernel stays exact per call whatever was listed.
 *
 * Only a GOVERNED resolution narrows the listing. An ungoverned session keeps
 * its listing byte-for-byte, and so does an unresolved one (stale artifact,
 * missing launch record, unreadable policy): those states are routinely
 * transient at connect time — a carry-respawn's successor lists its tools 2-5s
 * before its first turn converges the activation (EI-23703586803892464) — and a
 * client that ignores `list_changed` would otherwise keep a one-tool surface
 * for the life of the session.
 */
import type { KernelEnforcementRequest, KernelEnforcementResult, UnifiedToolContext } from '@papercusp/agent-mcp';
import { pinModuleState } from '@papercusp/module-singleton';
import { readControlAnchorKernelState } from '../projected-tool-deps';
import {
  checkIdentityGrantKernel,
  IDENTITY_BREAK_GLASS,
  readIdentityGrantPolicy,
  type IdentityGrantPolicy,
} from './identity-grants-port';

export interface IdentitySurfaceCandidate {
  name: string;
  capabilities: readonly string[];
}

type KernelState = NonNullable<Awaited<ReturnType<typeof readControlAnchorKernelState>>>;
type PolicyReader = Parameters<typeof checkIdentityGrantKernel>[3] & {};

export interface IdentitySurfaceDeps {
  readState: (request: KernelEnforcementRequest) => Promise<KernelState | null>;
  readPolicy: PolicyReader;
  check: typeof checkIdentityGrantKernel;
}

const DEFAULT_DEPS: IdentitySurfaceDeps = {
  readState: readControlAnchorKernelState,
  readPolicy: readIdentityGrantPolicy,
  check: checkIdentityGrantKernel,
};

/**
 * `key` names the identity inputs the surface was computed from: the applied
 * specification revision, the launch row id:xmin and the control generation.
 * An attach changes at least one of them. Null means the state was unreadable.
 */
export type IdentityToolSurface =
  | { kind: 'governed'; key: string; admitted: ReadonlySet<string> }
  | { kind: 'ungoverned' | 'unresolved'; key: string | null };

export function identitySurfaceKey(state: KernelState | null): string {
  if (!state) return JSON.stringify(null);
  const applied = state.activation?.applied ?? state.appliedRevision ?? null;
  const version = state.identityLaunchRecordVersion;
  return JSON.stringify([
    applied?.specificationRevision ?? null,
    version ? `${version.sessionId}:${version.rowVersion}` : null,
    state.controlGeneration ?? null,
  ]);
}

/** What a client was shown: the admitted names, or "not narrowed". */
export function identitySurfaceDigest(surface: IdentityToolSurface): string {
  return surface.kind === 'governed' ? JSON.stringify([...surface.admitted].sort()) : 'unnarrowed';
}

/**
 * A verdict that states the session's identity cannot be established rather
 * than what it may call: the break-glass causes, the recovery-door admission,
 * and an unreadable policy.
 */
function unresolvedVerdict(verdict: KernelEnforcementResult): boolean {
  if (verdict.code === 'identity-recovery') return true;
  if (verdict.decision !== 'deny') return false;
  const cause = (verdict.obligations as { capabilityUnsatisfied?: { cause?: unknown } } | undefined)
    ?.capabilityUnsatisfied?.cause;
  return cause === 'policy-unavailable' ||
    (IDENTITY_BREAK_GLASS.causes as readonly unknown[]).includes(cause);
}

/** One policy read per surface: the policy does not vary by listed tool. */
function memoizedPolicyReader(read: PolicyReader): PolicyReader {
  const reads = new Map<string, Promise<IdentityGrantPolicy>>();
  return (input) => {
    const key = JSON.stringify([input.workspaceId, input.harnessSlug, input.role ?? null, input.classRefs]);
    let pending = reads.get(key);
    if (!pending) {
      pending = read(input);
      reads.set(key, pending);
    }
    return pending;
  };
}

/**
 * Evaluate the identity surface for one session over `candidates` — the
 * listing the role, manifest, principal and app filters already produced.
 *
 * The claim-timing check is admitted: it narrows WHEN an operation worker may
 * cause an effect, not WHAT it may call, so it has no bearing on visibility.
 */
export async function resolveIdentityToolSurface(
  ctx: UnifiedToolContext,
  candidates: readonly IdentitySurfaceCandidate[],
  deps: IdentitySurfaceDeps = DEFAULT_DEPS,
): Promise<IdentityToolSurface> {
  const request = (candidate: IdentitySurfaceCandidate): KernelEnforcementRequest => ({
    phase: 'preflight', boundary: 'dispatch', toolName: candidate.name,
    capabilities: candidate.capabilities, args: {}, ctx,
  });
  let state: KernelState | null;
  try {
    state = await deps.readState(request(candidates[0] ?? { name: '', capabilities: [] }));
  } catch {
    return { kind: 'unresolved', key: null };
  }
  const key = identitySurfaceKey(state);
  if (!state || !Object.prototype.hasOwnProperty.call(state, 'identityLaunchRecord') || candidates.length === 0) {
    return { kind: 'ungoverned', key };
  }
  if (state.authorityUnavailable || state.revoked) return { kind: 'unresolved', key };
  const readPolicy = memoizedPolicyReader(deps.readPolicy);
  const admitted = new Set<string>();
  for (const candidate of candidates) {
    let verdict: KernelEnforcementResult | null;
    try {
      verdict = await deps.check(request(candidate), state, state.identityLaunchRecord, readPolicy, async () => true);
    } catch {
      return { kind: 'unresolved', key };
    }
    if (verdict === null) return { kind: 'ungoverned', key };
    if (unresolvedVerdict(verdict)) return { kind: 'unresolved', key };
    if (verdict.decision === 'allow') admitted.add(candidate.name);
  }
  return { kind: 'governed', key, admitted };
}

/** At most one post-call recheck per listed session in this window. */
export const IDENTITY_SURFACE_RECHECK_MS = 5_000;
const LISTED_SURFACE_TTL_MS = 6 * 60 * 60 * 1000;
const LISTED_SURFACE_MAX = 4096;

interface ListedSurface {
  ctx: UnifiedToolContext;
  candidates: readonly IdentitySurfaceCandidate[];
  key: string | null;
  digest: string;
  checkedAt: number;
}

// Per-connection state, like the seeded tool surface it sits beside
// (tool-allowlist.ts): it dies with the session, so memory is its home.
const listedSurfaces = pinModuleState('@papercusp/operator-core.identity-listed-surfaces', () =>
  new Map<string, ListedSurface>(),
);

/** Test seam. */
export function __resetListedIdentitySurfaces(): void {
  listedSurfaces.clear();
}

function sweepListedSurfaces(nowMs: number): void {
  for (const [sessionKey, entry] of listedSurfaces) {
    if (nowMs - entry.checkedAt > LISTED_SURFACE_TTL_MS) listedSurfaces.delete(sessionKey);
  }
  while (listedSurfaces.size > LISTED_SURFACE_MAX) {
    const oldest = listedSurfaces.keys().next().value;
    if (oldest === undefined) break;
    listedSurfaces.delete(oldest);
  }
}

/** Record what `tools/list` showed this session, so a later attach can be detected. */
export function rememberListedIdentitySurface(
  sessionKey: string,
  entry: { ctx: UnifiedToolContext; candidates: readonly IdentitySurfaceCandidate[]; surface: IdentityToolSurface },
  nowMs: number = Date.now(),
): void {
  listedSurfaces.delete(sessionKey);
  listedSurfaces.set(sessionKey, {
    ctx: entry.ctx, candidates: entry.candidates,
    key: entry.surface.key, digest: identitySurfaceDigest(entry.surface), checkedAt: nowMs,
  });
  sweepListedSurfaces(nowMs);
}

export type IdentitySurfaceRecheck = 'unlisted' | 'throttled' | 'unchanged' | 'notified';

/**
 * D-040(c): after a tools/call, re-read the session's identity inputs (at most
 * once per {@link IDENTITY_SURFACE_RECHECK_MS}). When the key moved — an attach
 * applied a new revision, the launch row changed or the control generation
 * advanced — recompute the surface and call `notify` (the transport's
 * `notifications/tools/list_changed`) only when what the client would now be
 * shown differs from what it was shown.
 */
export async function recheckListedIdentitySurface(
  sessionKey: string,
  notify: () => Promise<void>,
  nowMs: number = Date.now(),
  deps: IdentitySurfaceDeps = DEFAULT_DEPS,
): Promise<IdentitySurfaceRecheck> {
  const entry = listedSurfaces.get(sessionKey);
  if (!entry) return 'unlisted';
  if (nowMs - entry.checkedAt < IDENTITY_SURFACE_RECHECK_MS) return 'throttled';
  entry.checkedAt = nowMs;
  const probe = entry.candidates[0] ?? { name: '', capabilities: [] };
  let state: KernelState | null;
  try {
    state = await deps.readState({
      phase: 'preflight', boundary: 'dispatch', toolName: probe.name,
      capabilities: probe.capabilities, args: {}, ctx: entry.ctx,
    });
  } catch {
    return 'unchanged';
  }
  const key = identitySurfaceKey(state);
  if (key === entry.key) return 'unchanged';
  const surface = await resolveIdentityToolSurface(entry.ctx, entry.candidates, deps);
  // An unreadable state leaves the recorded key alone, so the next window retries.
  if (surface.key === null) return 'unchanged';
  entry.key = surface.key;
  const digest = identitySurfaceDigest(surface);
  if (digest === entry.digest) return 'unchanged';
  entry.digest = digest;
  await notify();
  return 'notified';
}
