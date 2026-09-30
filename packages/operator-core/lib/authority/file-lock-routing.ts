/**
 * file-lock-routing — the file-claim integration for the lock authority (Phase 2
 * steps 2 + 5 of distributed-coordination-shared-harness-2026-06-04).
 *
 * # Scope guard (D-009)
 *
 * ONLY file-claim / repo-root (`coordination_domain`) locks route to the
 * authority — those guard concurrent edits to the SHARED repo's files, the one
 * thing that genuinely needs cross-machine serialization. The NAMED-RESOURCE
 * locks (`dev-server`, `db-schema`, `shop`, `desktop-sidecar`,
 * `libs-papercusp-submodule`) guard MACHINE-LOCAL resources — each user runs
 * their own dev-server / embedded-pg — so they stay local and never call
 * through here. This module is deliberately import-free of the named-resource
 * lock paths.
 *
 * # Domain → harness is a seam
 *
 * A file lock is keyed by `coordination_domain` = the realpath of the repo root
 * (see ../agent-tools/locks/coordination-domain.ts). To pick the authority we
 * need the HARNESS that checkout belongs to. There is no per-harness id stored
 * alongside a lock today (D-009 notes this), so the domain→harness mapping is an
 * injectable resolver. Its default returns `null` (= "no federated harness for
 * this checkout") which routes the op LOCALLY — the correct, safe behavior on a
 * single box and for unmanaged repos. Wire the real registry mapping at boot via
 * {@link configureFileLockDomainResolver} and cross-machine routing engages.
 *
 * # Wired into the live acquire hot path (fed-reanchor-2026-06-06 P-060, cutover 2)
 *
 * `locks:acquire` / `locks:release` route their file-claim ops through
 * {@link routeFileLockOp} (see ../agent-tools/locks/acquire.ts). The per-edit
 * hot path stays near-zero-cost via the remote-peers cache fast-path below: on a
 * box with no live remote peers the routed call collapses to `op.local()`
 * without a `shared_presence` query. The boot wiring (resolvers + authority-side
 * op handlers + the HTTP wire transport) lives in
 * ../agent-tools/locks/file-lock-authority-wiring.ts; the remaining cross-machine
 * residual is a peer ADDRESSING source (see ./transport-wiring.ts).
 */

import {
  routeToAuthority,
  routeToAuthorityForHive,
  type AuthorityOp,
  type LockAuthorityDeps,
  type RouteResult,
} from './lock-authority';
import { hasRemotePeers, hasRemoteHivePeers, type RemotePeersCacheDeps } from './remote-peers-cache';

/** Resolve a `coordination_domain` (repo realpath) to its harness slug, or null. */
export type DomainToHarnessSlug = (domain: string) => string | null;

/** Resolve a harness slug to its home HIVE slug, or null when the harness is not a
 *  Hive member (P-009). When non-null, the file-lock authority is the HIVE's. */
export type HarnessToPotSlug = (harnessSlug: string) => string | null;

let _domainResolver: DomainToHarnessSlug | null = null;
let _hiveResolver: HarnessToPotSlug | null = null;

/**
 * Register the domain→harness resolver at boot. The operator wires this to its
 * harness registry (which knows each managed harness's checkout realpath). Until
 * registered, the default returns null → file-lock ops run locally.
 */
export function configureFileLockDomainResolver(fn: DomainToHarnessSlug | null): void {
  _domainResolver = fn;
}

/** The default resolver: no harness known for any domain → route locally. */
function defaultDomainToHarnessSlug(_domain: string): string | null {
  return null;
}

/** The currently-registered resolver, or the local-only default. */
export function getDomainToHarnessSlug(): DomainToHarnessSlug {
  return _domainResolver ?? defaultDomainToHarnessSlug;
}

/**
 * Register the harness→Hive resolver at boot (P-009). The operator wires it to its
 * harness registry (ProjectEntry.hive_slug — a member harness's home Hive). Until
 * registered, the default returns null → every harness uses HARNESS-scoped authority
 * (the pre-Hive behavior, unchanged).
 */
export function configureFileLockHiveResolver(fn: HarnessToPotSlug | null): void {
  _hiveResolver = fn;
}

/** The default: no harness is a Hive member → harness-scoped authority. */
function defaultHarnessToPotSlug(_harnessSlug: string): string | null {
  return null;
}

/** The currently-registered harness→Hive resolver, or the non-Hive default. */
export function getHarnessToPotSlug(): HarnessToPotSlug {
  return _hiveResolver ?? defaultHarnessToPotSlug;
}

export interface FileLockRoutingDeps extends LockAuthorityDeps, RemotePeersCacheDeps {
  /** Override the domain→harness mapping (tests). */
  domainToHarnessSlug?: DomainToHarnessSlug;
  /** Override the harness→Hive mapping (tests). */
  harnessToPotSlug?: HarnessToPotSlug;
  /** Skip the cached remote-peers fast-path (tests / force authority routing). */
  skipRemotePeersFastPath?: boolean;
}

/** {@link RouteResult} plus the resolved file-lock scope key (harness or hive
 *  slug), when `domain` belongs to a federated harness. Undefined for an
 *  unmanaged/unmanaged-harness domain (there is no scope to record events
 *  against). Callers that need to emit a P-015 lock-event for a LOCALLY-run op
 *  (`via !== 'remote-authority'` — the remote authority already recorded its
 *  own grant/release) use this instead of re-resolving the domain→scope mapping
 *  themselves (WI-1550). */
export interface FileLockRouteResult<T> extends RouteResult<T> {
  scope?: string;
}

/**
 * Route a FILE-CLAIM lock operation (acquire/release/queue) to the authority for
 * the harness that owns `domain`.
 *
 * - Unknown / unmanaged domain (no federated harness) → run `op.local()`
 *   directly (`via:'local-authority'`).
 * - Otherwise delegate to {@link routeToAuthority}: local when we are the
 *   authority, RPC when a transport + remote envelope exist, else fail open.
 *
 * Named-resource locks MUST NOT call this — they are machine-local (D-009).
 */
export async function routeFileLockOp<T>(
  domain: string,
  op: AuthorityOp<T>,
  deps: FileLockRoutingDeps = {},
): Promise<FileLockRouteResult<T>> {
  const resolve = deps.domainToHarnessSlug ?? getDomainToHarnessSlug();
  const harnessSlug = resolve(domain);
  if (!harnessSlug) {
    // No federated harness for this checkout → there is no remote authority to
    // defer to. Run locally (single box / unmanaged repo).
    return { value: await op.local(), via: 'local-authority' };
  }

  // P-009: when this harness federates within a shared Hive, its file-claim locks
  // serialize at the HIVE's authority (one authority across all the Hive's Swarms),
  // not the harness's. Default resolver returns null → harness scope (unchanged).
  const potSlug = (deps.harnessToPotSlug ?? getHarnessToPotSlug())(harnessSlug);
  const scope: { kind: 'hive' | 'harness'; key: string } = potSlug
    ? { kind: 'hive', key: potSlug }
    : { kind: 'harness', key: harnessSlug };

  // Hot-path guard: when the scope has NO live remote peers (the common case — a
  // single box), skip authority resolution entirely and run locally. The answer is
  // cached (remote-peers-cache) so the per-edit lock hook pays a cached boolean, not
  // a shared_presence query. A stale "no peers" only costs a missed serialization
  // (fail-open, D-004) for up to the cache TTL after a peer appears.
  const hasPeers =
    scope.kind === 'hive' ? hasRemoteHivePeers(scope.key, deps) : hasRemotePeers(scope.key, deps);
  if (!deps.skipRemotePeersFastPath && !(await hasPeers)) {
    return { value: await op.local(), via: 'local-authority', scope: scope.key };
  }

  const result =
    scope.kind === 'hive'
      ? await routeToAuthorityForHive(scope.key, op, deps)
      : await routeToAuthority(scope.key, op, deps);
  return { ...result, scope: scope.key };
}

export const _testing = { defaultDomainToHarnessSlug };
