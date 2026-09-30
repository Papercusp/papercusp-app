/**
 * The file-lock **coordination domain** — the canonical, symlink-resolved root of
 * the repo whose files the locks protect.
 *
 * File locking exists to prevent two actors from editing the same PHYSICAL FILE at
 * once, so the lock namespace is a property of the file on disk — NOT of the
 * logical Papercusp workspace the editor came through (dbos-system-completion
 * D-015). Multiple workspaces can import the same harness (same repo on disk), and
 * SU agents + autonomous workers editing the same physical file must serialize
 * regardless of workspace. Keying the domain by `workspaceId` (the prior design)
 * silently split those into separate namespaces → no serialization → clobber.
 *
 * Every SU agent on this operator edits THIS papercup checkout, so the domain is a
 * single constant: the realpath of the repo root. A worker editing a managed
 * harness uses the realpath of ITS repo (`deps.repoPath`); the papercup-dogfood
 * harness resolves to the same realpath as the operator → it serializes with SU
 * agents on the same files. Two genuinely-different checkouts realpath-differ →
 * different domains → independent (they are different files), which is correct.
 *
 * `PAPERCUSP_LOCK_DOMAIN` overrides (tests / packaged builds with no repo on disk).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { hasValidGitEntry } from './valid-git-entry';
import { activeWorkspaceId } from '../../workspace-registry';
import { declaredResourceDomainKind } from './resource-domain-kinds';

let _domain: string | null = null;
let _fileDomain: string | null = null;

/** Walk up from `start` to the nearest ancestor containing a VALID `.git` entry
 *  (gitlink file OR git dir with HEAD — see valid-git-entry.ts: a stray empty
 *  `.git` dir must not collapse lock domains). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (hasValidGitEntry(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * The lock coordination domain for an arbitrary project dir — the canonical
 * (realpath) repo root containing it. Used by spawn paths that launch agents
 * into a managed harness's checkout (operator-spawn, agent-chat runs), where
 * the domain is a property of the CHILD's repo, not the operator's.
 */
export function lockDomainForProjectDir(projectDir: string): string {
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) return override.trim();
  const root = findRepoRoot(projectDir);
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Resolve a client-supplied physical repo root for a file-lock operation.
 *
 * A client edit hook can be talking to a different operator checkout than the
 * one being edited (for example, :3070's release tree while the edit is in
 * staging). In that case the hook supplies the repo root it resolved from the
 * edit path. Canonicalize and validate it here so the lock authority receives
 * the physical repo domain, never a relative string or a nested directory.
 */
export function resolveExplicitFileLockDomain(requested: string | undefined, fallback: string): string {
  if (requested === undefined) return fallback;
  const value = requested.trim();
  if (!value) throw new Error('coordination_domain must be a non-empty absolute repository root');
  // EI-21104703429792156: the recurring caller mistake here is passing a HARNESS/WORKSPACE
  // SLUG (`'papercusp'`) rather than a filesystem path, and the bare "must be an absolute
  // repository root" neither echoed the offending value nor said what to pass instead — so
  // the reporter's only route forward was to guess (`git rev-parse --show-toplevel`). Name
  // the mistake, echo the input, and quote the concrete alternative. `fallback` is exactly
  // what omitting the argument returns (see the `requested === undefined` branch above), so
  // it is correct per-caller by construction — unlike naming a fixed domain here, which
  // would be wrong for whichever caller passed a different one.
  if (!isAbsolute(value)) {
    throw new Error(
      `coordination_domain must be an absolute repository checkout root (a filesystem path), ` +
        `not a harness/workspace slug — received ${JSON.stringify(value)}. Omit coordination_domain ` +
        `to use this caller's own tree (${fallback}), or pass that absolute path explicitly.`,
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(value);
  } catch {
    throw new Error(`coordination_domain is not a reachable repository root: ${value}`);
  }
  if (!hasValidGitEntry(resolved)) {
    throw new Error(`coordination_domain is not a repository root: ${value}`);
  }
  return resolved;
}

/** The lock coordination domain for the operator (cached). */
export function lockCoordinationDomain(): string {
  if (_domain) return _domain;
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) {
    _domain = override.trim();
    return _domain;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(here);
  try {
    _domain = realpathSync(root);
  } catch {
    _domain = root;
  }
  return _domain;
}

/** Reset the cache — test-only. */
export function __resetLockCoordinationDomain(): void {
  _domain = null;
}

/**
 * The directory name of the canonical staging tree inside the workspace root.
 *
 * PARITY CONTRACT with `apps/operator/scripts/hooks/cc/pretooluse-locks-acquire.sh`
 * (its `_canonical_tree`: `PAPERCUSP_CANONICAL_TREE` or
 * `<workspace_root>/papercusp`). The hook and this module MUST resolve the same
 * tree — that identity is the whole point of {@link fileLockCoordinationDomain}
 * and is pinned by `coordination-domain.file-domain.test.ts`. Keep in sync.
 */
export const CANONICAL_TREE_DIRNAME = 'papercusp';

/**
 * The coordination domain for FILE locks — the tree whose files agents actually
 * EDIT, which is NOT necessarily the tree whose code the operator is RUNNING.
 *
 * WI-38252. {@link lockCoordinationDomain} resolves the domain from
 * `import.meta.url` — the repo root of the executing code — on the premise
 * stated in this file's header: "Every SU agent on this operator edits THIS
 * papercup checkout". That premise is FALSE for the `:3070` operator, which
 * serves every SU agent while running from the RELEASE checkout
 * (`papercup-release`) whose files nobody edits. The result was a silent
 * two-namespace split, measured live 2026-08-12:
 *
 *   .../papercup-release : 18 rows — ALL deliberate agent `locks:acquire`, 0 hook
 *   .../papercusp        :  5 rows — ALL PreToolUse hook acquires, 0 agent
 *
 * 100% disjoint. The PreToolUse hook sends an explicit `coordination_domain`
 * (the physical repo root of the edited file) precisely because it knows the
 * operator may serve a different checkout; an AGENT calling `locks:acquire`
 * sends no such argument and fell back to the operator's own checkout. So every
 * deliberate agent file lock was granted in a namespace the enforcement guard
 * never reads: `locks:acquire` answered `ok:true` + `newly_held` for paths a
 * live peer held, and the holder's own `locks:release` reported `released: []`
 * for the lock the guard was still enforcing against them.
 *
 * Resolution order — first candidate that is a real repo root on disk wins:
 *   1. `PAPERCUSP_LOCK_DOMAIN` — the existing global override (tests, packaged
 *      builds with no repo on disk). Unchanged semantics.
 *   2. `PAPERCUSP_CANONICAL_TREE` — the hook's own notion of the edit tree.
 *   3. `<PAPERCUSP_WORKSPACE_ROOT | ~/papercupai-workspace>/<CANONICAL_TREE_DIRNAME>`.
 *   4. {@link lockCoordinationDomain} — today's behaviour, kept as the terminal
 *      fallback so an environment with no resolvable edit tree (a packaged
 *      build, a foreign harness checkout) degrades to exactly what it did
 *      before rather than to a fabricated path.
 *
 * Deliberately SEPARATE from {@link lockCoordinationDomain} rather than a
 * change to it: that function is also the domain for RESOURCE locks
 * (`resourceLockDomain`), and silently re-keying those would orphan live
 * `git-sync:<slug>` / `release-deploy` holds — the identical cross-domain
 * failure documented in {@link hostGlobalLockDomain}. Resource locks are
 * untouched by this fix.
 */
export function fileLockCoordinationDomain(): string {
  if (_fileDomain) return _fileDomain;
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) {
    _fileDomain = override.trim();
    return _fileDomain;
  }
  for (const candidate of fileLockDomainCandidates()) {
    try {
      const real = realpathSync(candidate);
      if (hasValidGitEntry(real)) {
        _fileDomain = real;
        return _fileDomain;
      }
    } catch {
      // Not present on this box — try the next candidate.
    }
  }
  _fileDomain = lockCoordinationDomain();
  return _fileDomain;
}

/** The edit-tree candidates, in order — see {@link fileLockCoordinationDomain}. */
function fileLockDomainCandidates(): string[] {
  const candidates: string[] = [];
  const canonical = process.env.PAPERCUSP_CANONICAL_TREE?.trim();
  if (canonical) candidates.push(canonical);
  const workspaceRoot = process.env.PAPERCUSP_WORKSPACE_ROOT?.trim()
    || join(homedir(), 'papercupai-workspace');
  candidates.push(join(workspaceRoot, CANONICAL_TREE_DIRNAME));
  return candidates;
}

/** Reset the file-lock domain cache — test-only. */
export function __resetFileLockCoordinationDomain(): void {
  _fileDomain = null;
}

/**
 * EI-18674647773291145 (Defect 2): the FIXED domain for genuinely HOST-GLOBAL
 * resources — ones that name a single shared subsystem on this host (e.g. the
 * one shared release checkout `release-deploy` guards) rather than a physical
 * file tree. `lockCoordinationDomain()` above is deliberately keyed by the
 * CALLER's own repo root (correct for file-locking, D-015) — but that means a
 * host-global resource acquired from two DIFFERENT physical checkouts of the
 * same logical repo (e.g. the release checkout vs the staging/integration
 * tree deploy-cli is often run from manually) silently lands in two different
 * domains: the single-flight guarantee the resource exists for stops holding
 * across trees, and any diagnostic (`locks:list`) run from yet another tree
 * reports "no holders" for a lock that is genuinely held elsewhere (observed
 * live 2026-07-26: `locks:list { resource: 'release-deploy' }` returned
 * `holders: []` while a lock row provably existed). A resource that means
 * "this one host-wide subsystem" must resolve to the SAME domain regardless
 * of which tree loaded the calling code. `PAPERCUSP_LOCK_DOMAIN` still
 * overrides, same as `lockCoordinationDomain()` (tests / no-repo builds).
 */
export function hostGlobalLockDomain(): string {
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) return override.trim();
  return 'papercusp-host-global';
}

/**
 * Resource names whose acquirers use {@link hostGlobalLockDomain} instead of
 * {@link lockCoordinationDomain} — kept as a single source of truth so a
 * diagnostic reader (`locks:list`) can resolve the SAME fixed domain a
 * host-global acquirer used. `release-deploy` is EI-18674647773291145
 * Defect 2's concrete incident; `dev-server` (EI-18676514870990022) has the
 * identical cross-tree defect — it names the one shared `:3070` operator
 * process, not a physical file tree, so a `dev:restart`/`release deploy`/
 * `system-health` call from a DIFFERENT checkout than the one that acquired
 * the lock must still see it as held. All call sites that acquire or read it
 * (deploy-deps.ts's `withDrain`, dev/restart.ts, system-health/compute.ts)
 * have been migrated — see {@link resourceLockDomain}.
 */
export const HOST_GLOBAL_RESOURCES: ReadonlySet<string> = new Set([
  'release-deploy',
  'dev-server',
  // EI-24374781045212391: one physical rig is shared by callers on :3170 and
  // :3070, whose staging and release checkouts must see the same lease.
  'hive-git-physical-rig',
  // EI-21270032782365521: all SO_REUSEPORT operator workers spend from one
  // optional mid-turn memory budget. A caller-tree domain would recreate the
  // exact split-brain this set exists to prevent and make locks:list lie.
  'memory-injection:mid-turn',
]);

/**
 * WI-5960: the same cross-domain defect as {@link HOST_GLOBAL_RESOURCES}, but for
 * resources whose SYSTEM-SIDE acquirer keys itself by **workspace**, not by a fixed
 * host-global constant — the concrete incident is `git-sync:<slug>`: the
 * `system:git-sync` routine action acquires it under `coordinationDomain =
 * ctx.workspaceId || '*'` (git-sync-action.ts's `handleGitSync`), but an agent
 * calling `locks:acquire_resource { resource: 'git-sync:<slug>' }` — the su
 * playbook's documented "pause sync to safely mutate the tree" mechanism — landed
 * under {@link lockCoordinationDomain} (the repo-root) instead: two disjoint
 * domains, so the agent's exclusive hold was INVISIBLE to git-sync's own
 * conflict check and the routine committed straight through it (observed live
 * 2026-07-26 — 6 commits landed during a held, un-expired exclusive hold).
 * Matched by PREFIX (the resource name embeds a dynamic harness slug, unlike the
 * fixed {@link HOST_GLOBAL_RESOURCES} names).
 */
/**
 * WI-222686: the legacy superproject-wide `git-sync` resource is acquired by
 * git-sync-action under the SAME `ctx.workspaceId || '*'` domain as the
 * per-slug family. Leaving the exact name on the caller-tree domain made the
 * routine's hold invisible to restart-side drains loaded from another
 * checkout, so a `dev:restart` barrier could report clear and still kill the
 * commit it was meant to protect.
 */
const WORKSPACE_SCOPED_RESOURCES: ReadonlySet<string> = new Set(['git-sync']);
const WORKSPACE_SCOPED_RESOURCE_PREFIXES: readonly string[] = ['git-sync:'];

/** True when `resource` belongs to a family whose system-side acquirer keys
 *  itself by workspace (see {@link WORKSPACE_SCOPED_RESOURCE_PREFIXES}). */
export function isWorkspaceScopedResource(resource: string): boolean {
  return (
    WORKSPACE_SCOPED_RESOURCES.has(resource) ||
    WORKSPACE_SCOPED_RESOURCE_PREFIXES.some((prefix) => resource.startsWith(prefix))
  );
}

/**
 * The lock coordination domain for a WORKSPACE-scoped resource (WI-5960) —
 * mirrors `git-sync-action.ts`'s OWN `ctx.workspaceId || '*'` computation
 * exactly (same fallback, no `PAPERCUSP_LOCK_DOMAIN` override: the routine
 * side has none either, so adding one here would just reintroduce a different
 * mismatch in whatever environment sets it) so an agent's acquire lands in the
 * SAME domain the routine itself checks.
 */
export function workspaceScopedLockDomain(): string {
  return activeWorkspaceId() || '*';
}

/**
 * The correct lock coordination domain for a NAMED resource — the fixed
 * {@link hostGlobalLockDomain} when `resource` is in
 * {@link HOST_GLOBAL_RESOURCES}, {@link workspaceScopedLockDomain} when it
 * matches a {@link isWorkspaceScopedResource} family, else the caller-tree-scoped
 * {@link lockCoordinationDomain}. Centralizes the branch `locks:list` already
 * applied ad hoc (EI-18674647773291145 Defect 2) so every acquirer/reader of a
 * resource lock picks the same domain by construction — adding a resource to
 * `HOST_GLOBAL_RESOURCES` (or a prefix to `WORKSPACE_SCOPED_RESOURCE_PREFIXES`)
 * fixes every call site in one place instead of requiring each one to remember
 * the branch.
 *
 * WI-562584: the two name-shaped sets above cannot be completed by hand. An
 * install's system-side acquirer holds its whole configured lock set
 * (`trigger_config.extra_lock_resources`) in the WORKSPACE domain, and those
 * names are per-install human configuration that shared operator-core code
 * cannot enumerate — so a name such as `libs-papercusp-submodule` resolved here
 * to the caller tree while git-sync genuinely held it in the workspace domain,
 * and mutual exclusion silently did not hold. The acquirer therefore DECLARES
 * the kind on the registry row (sql/027) and it is consulted here.
 *
 * The declaration is consulted AFTER the hardcoded sets and only when it is
 * non-default, which makes it strictly additive: `tree` is the column default
 * and means UNDECLARED, so a cold cache, a failed refresh, or an unstamped row
 * all degrade to exactly the inference above. A declaration can promote a
 * resource OUT of the caller-tree domain; nothing can demote one INTO it.
 */
export function resourceLockDomain(resource: string): string {
  if (HOST_GLOBAL_RESOURCES.has(resource)) return hostGlobalLockDomain();
  if (isWorkspaceScopedResource(resource)) return workspaceScopedLockDomain();
  const declared = declaredResourceDomainKind(resource);
  if (declared === 'host-global') return hostGlobalLockDomain();
  if (declared === 'workspace') return workspaceScopedLockDomain();
  return lockCoordinationDomain();
}

/**
 * WI-5960: candidate domains to try, IN ORDER, when releasing or heartbeating a
 * named-resource lock by `lock_id` ALONE — the resource name (and therefore its
 * {@link resourceLockDomain}) isn't known at that call site. Most locks are
 * ordinary file-tree-domain resources, so the caller's own domain is tried
 * FIRST (zero extra cost on the common path, byte-identical to before this
 * fix); the special-domain families are tried only as a fallback when the
 * first attempt finds nothing — covering a `git-sync:<slug>` / host-global
 * lock that was (correctly) acquired under a different domain via
 * {@link resourceLockDomain}. Deduped — `workspaceScopedLockDomain()` can
 * coincide with `lockCoordinationDomain()` under `PAPERCUSP_LOCK_DOMAIN`.
 */
export function candidateResourceLockDomains(): string[] {
  return [...new Set([lockCoordinationDomain(), hostGlobalLockDomain(), workspaceScopedLockDomain()])];
}
