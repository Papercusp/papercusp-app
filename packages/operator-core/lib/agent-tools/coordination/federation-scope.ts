/**
 * federation-scope — resolve the DEFAULT federation scope for coord sends from
 * an un-scoped (SU / operator / oracle) session
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-001).
 *
 * A coord_event_log row federates only when it is harness-scoped (the mig-150
 * WHEN gate), and the coord:send handler deliberately leaves SU/operator sends
 * un-scoped — so an SU's messages silently never left the machine even in a
 * shared-hive workspace. The parity rule (plan D-001): a session in a workspace
 * with EXACTLY ONE shared Hive stamps that Hive's HOME slug by default —
 * hive-grained rows ride `harness_slug = <home slug>` (the hive_settings /
 * hive_members convention), and the home harness's booted drain handle puts
 * them on the Hive topic. Zero or several shared Hives → no default (unchanged
 * local behavior): ambiguity is never guessed. The tool-level `scope` arg
 * overrides both ways ('hive' forces + reports candidates on failure; 'local'
 * opts out).
 *
 * "Shared" reuses resolveHiveSwarmBinding's gate exactly: a joined
 * `remote_hive` registry view, or an owned Hive whose directory meta is
 * public/invite. A private / un-published hive never becomes a default scope,
 * so this can never leak a local-only hive's coord onto the DHT.
 *
 * Fail-soft by contract: any resolution error degrades to { kind: 'none' }
 * (today's local-only behavior) — a scope lookup must never break a send.
 * TTL-cached per workspace (the send path is hot; registry/PG reads are not).
 */

import { listHives } from '../../hive-store';
import { getOwnedHiveMeta } from '../../hive-directory-meta';
import { loadHarnessRegistry } from '../../harness-registry';

export type WorkspaceHiveScope =
  | { kind: 'one'; homeSlug: string }
  | { kind: 'none' }
  | { kind: 'many'; candidates: string[] };

export interface FederationScopeDeps {
  listHives: (workspaceId: string) => Promise<Array<{ homeSlug: string }>>;
  loadHarnessRegistry: (
    workspaceId: string,
  ) => Promise<{
    projects: Array<{ slug: string; remote_hive?: boolean; joined_via_link?: boolean }>;
  }>;
  getOwnedHiveMeta: (
    potHomeSlug: string,
    workspaceId: string,
  ) => Promise<{ visibility?: string } | null | undefined>;
}

const defaultDeps: FederationScopeDeps = {
  listHives: (ws) => listHives(ws),
  loadHarnessRegistry: (ws) => loadHarnessRegistry(ws),
  getOwnedHiveMeta: (home, ws) => getOwnedHiveMeta(home, ws),
};

const CACHE_TTL_MS = Number(process.env.PAPERCUSP_FED_SCOPE_CACHE_MS) || 30_000;
const cache = new Map<string, { at: number; scope: WorkspaceHiveScope }>();

/**
 * The workspace's default coord federation scope: exactly-one shared Hive →
 * its home slug; else none/many (caller keeps the send local). Cached
 * CACHE_TTL_MS per workspace; pass { fresh: true } to bypass (tests, or a
 * just-published hive).
 */
export async function resolveWorkspaceHiveScope(
  workspaceId: string,
  opts?: { fresh?: boolean; deps?: FederationScopeDeps },
): Promise<WorkspaceHiveScope> {
  const deps = opts?.deps ?? defaultDeps;
  if (!opts?.fresh) {
    const hit = cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scope;
  }
  let scope: WorkspaceHiveScope;
  try {
    scope = await resolveUncached(workspaceId, deps);
  } catch (e) {
     
    console.warn(
      `[federation-scope] resolve failed for ws=${workspaceId} (send stays local):`,
      e instanceof Error ? e.message : String(e),
    );
    scope = { kind: 'none' };
  }
  cache.set(workspaceId, { at: Date.now(), scope });
  return scope;
}

async function resolveUncached(
  workspaceId: string,
  deps: FederationScopeDeps,
): Promise<WorkspaceHiveScope> {
  const hives = await deps.listHives(workspaceId);
  if (hives.length === 0) return { kind: 'none' };
  const reg = await deps.loadHarnessRegistry(workspaceId);
  const shared: string[] = [];
  for (const h of hives) {
    const entry = reg.projects.find((p) => p.slug === h.homeSlug);
    // A pot join writes a `remote_hive` view; the canonical invite-LINK join writes
    // the cloned harness with `joined_via_link` and no view. Both are joiner-side
    // (git-sync-reconcile treats them the same), so both federate by definition.
    if (entry?.remote_hive === true || entry?.joined_via_link === true) {
      shared.push(h.homeSlug); // joined view — federates by definition
      continue;
    }
    const meta = await deps.getOwnedHiveMeta(h.homeSlug, workspaceId);
    if (meta && meta.visibility !== 'private') shared.push(h.homeSlug);
  }
  if (shared.length === 0) return { kind: 'none' };
  if (shared.length === 1) return { kind: 'one', homeSlug: shared[0] };
  return { kind: 'many', candidates: shared.sort() };
}

/** Test seam: drop all cached scopes. */
export function resetFederationScopeCache(): void {
  cache.clear();
}

/**
 * Pure (WI-5211, generalized EI-16673, WI-5445): pick the ONE shared hive a
 * multi-hive-ambiguous caller means — placement:'remote' launches (which hive's
 * seat-offers to consume), resource:offers (which hive's offers to list),
 * coord:send's `scope:'hive'` (which hive a message federates over), and any
 * future multi-hive-ambiguous surface share this exact disambiguation shape.
 * Exactly-one-shared-hive workspaces resolve alone; on a multi-hive workspace an
 * explicit `hive` wins (validated against the shared set), else an optional
 * `fallback` (e.g. the calling plan's `harness`) disambiguates when it names a
 * shared hive — the same disambiguator resource:delegate's own `hive` param
 * uses on the offer-PUBLISHING side (see offer-store-publish.ts).
 *
 * Error messages are deliberately domain-NEUTRAL (no "seat-offers" wording) —
 * this helper now also backs coord:send, which has nothing to do with
 * seat-offers, so a caller-specific reason belongs in the caller, not here.
 */
export function resolveSharedHiveDisambiguation(
  scope: WorkspaceHiveScope,
  explicitHive: string | undefined,
  fallback: string | null,
): { ok: true; homeSlug: string; candidates: string[] } | { ok: false; error: string; candidates: string[] } {
  if (scope.kind === 'none') {
    return {
      ok: false,
      candidates: [],
      error:
        'this workspace has NO shared hive to disambiguate — it federates only when published public/invite or joined (publish or join a hive first)',
    };
  }
  const candidates = scope.kind === 'one' ? [scope.homeSlug] : scope.candidates;
  const hive = explicitHive?.trim();
  if (hive) {
    if (candidates.includes(hive)) return { ok: true, homeSlug: hive, candidates };
    return {
      ok: false,
      candidates,
      error: `hive \`${hive}\` is not one of this workspace's shared hives (${candidates.join(', ')})`,
    };
  }
  if (scope.kind === 'one') return { ok: true, homeSlug: scope.homeSlug, candidates };
  if (fallback && candidates.includes(fallback)) return { ok: true, homeSlug: fallback, candidates };
  return {
    ok: false,
    candidates,
    error: `this workspace has ${candidates.length} shared hives (${candidates.join(', ')}) — pass \`hive\` to pick the one you mean`,
  };
}
