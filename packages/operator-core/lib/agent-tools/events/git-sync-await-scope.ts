/**
 * git-sync await scoping — ONE rule for both await doors: the raw `events:await` and the
 * `git-sync:await` sugar (EI-24719187042784648).
 *
 * `git-sync:committed` and `git-sync:egressed` are GLOBAL keys. git-sync-action emits them
 * once per git-sync INSTALL that commits (see harness/git-sync/git-sync-events.ts), and every
 * harness in the workspace is its own install — so is every separately-installed submodule,
 * e.g. `papercusp/libs/generic/search`. An unscoped one-shot await on a bare key is therefore
 * consumed by whichever install commits first. Measured 2026-09-30 20:14Z: an su awaiting
 * "the papercusp superproject committed" via `events:await { event: 'git-sync:committed' }`
 * was woken by a `papercusp/libs/generic/search` submodule commit while the superproject
 * HEAD had not moved. The sugar already refused a scope-less wait; the raw door accepted it.
 *
 * The sha-suffixed keys carry only the FULL head sha the emitter read from git
 * (`git-sync:committed:<sha>`, `git-sync:egressed:<sha>`). There is no per-install key, so a
 * suffix that is not a full lowercase object id (`:papercusp`, a 7-char short sha) names a key
 * that can never fire: a silent hang until the await's timeout.
 */
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import type { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';

export type GitSyncAwaitKind = 'committed' | 'egressed';

/** The payload fields git-sync-action stamps on every global commit/egress event. */
export interface GitSyncAwaitScope {
  installSlug: string;
  workspaceId: string;
}

type ScopeContext = Parameters<typeof resolveAgentIdentity>[0];

const INSTALL_GLOBAL_KEY = /^git-sync:(committed|egressed)(?::\*)?$/;
const SHA_SUFFIXED_KEY = /^git-sync:(committed|egressed):([^:*]+)$/;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** True for a full lowercase git object id (SHA-1 or SHA-256), the only form git-sync emits. */
export function isFullGitObjectId(value: string): boolean {
  return FULL_OBJECT_ID.test(value);
}

/**
 * Resolve the install/workspace a git-sync wait must be bound to: the concrete harness whose
 * checkout the caller edited, and its workspace. `null` when no concrete harness resolves
 * (operator-scope callers carry the `'*'` sentinel), in which case the caller must refuse.
 */
export function gitSyncAwaitScope(harness: string | null | undefined, ctx: ScopeContext): GitSyncAwaitScope | null {
  const installSlug = resolveConcreteHarnessSlug(harness, ctx);
  if (!installSlug) return null;

  const contextWorkspace =
    typeof ctx.workspaceId === 'string' && ctx.workspaceId.trim() && ctx.workspaceId !== '*'
      ? ctx.workspaceId.trim()
      : typeof ctx.principal?.workspaceId === 'string' &&
          ctx.principal.workspaceId.trim() &&
          ctx.principal.workspaceId !== '*'
        ? ctx.principal.workspaceId.trim()
        : activeWorkspaceId();
  return contextWorkspace && contextWorkspace !== '*' ? { installSlug, workspaceId: contextWorkspace } : null;
}

/**
 * The kind of an INSTALL-GLOBAL git-sync key — the bare key, or a glob over its sha segment —
 * or `null` for any other key. Both forms fire for every install.
 */
export function gitSyncInstallGlobalKind(eventKey: string): GitSyncAwaitKind | null {
  const m = INSTALL_GLOBAL_KEY.exec(eventKey);
  return m ? (m[1] as GitSyncAwaitKind) : null;
}

export interface GitSyncShaSuffixProblem {
  kind: GitSyncAwaitKind;
  suffix: string;
  reason: 'short-sha' | 'not-a-sha';
}

/** For a sha-suffixed git-sync key whose suffix can never be emitted, the problem; else null. */
export function gitSyncShaSuffixProblem(eventKey: string): GitSyncShaSuffixProblem | null {
  const m = SHA_SUFFIXED_KEY.exec(eventKey);
  if (!m) return null;
  const suffix = m[2];
  if (isFullGitObjectId(suffix)) return null;
  return {
    kind: m[1] as GitSyncAwaitKind,
    suffix,
    reason: /^[0-9a-fA-F]{4,}$/.test(suffix) ? 'short-sha' : 'not-a-sha',
  };
}

/**
 * The payload_filter that binds a global git-sync wait to one install. `committedAtMs` exists
 * only on COMMIT payloads; putting it on an egress filter would match nothing (a silent hang),
 * so the freshness boundary is applied to `committed` alone.
 */
export function gitSyncScopePayloadFilter(
  scope: GitSyncAwaitScope,
  kind: GitSyncAwaitKind,
  registrationBoundaryMs?: number,
): Record<string, unknown> {
  return {
    ...scope,
    ...(kind === 'committed' && registrationBoundaryMs != null ? { committedAtMs: { gt: registrationBoundaryMs } } : {}),
  };
}

function refusal(body: Record<string, unknown>) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...body }) }],
  };
}

/** Refusal for a global git-sync wait with no resolvable install scope. */
export function gitSyncScopeRequiredResult(eventKey: string, tool: string) {
  return refusal({
    error: 'harness_required',
    tool,
    event: eventKey,
    detail:
      `"${eventKey}" fires once per git-sync INSTALL: every harness in the workspace, and every ` +
      'separately-synced submodule install (e.g. papercusp/libs/generic/search). An unscoped one-shot ' +
      'await is consumed by whichever install commits first, not by your tree (EI-24719187042784648). ' +
      'No concrete harness resolved for this call, so nothing was registered.',
    remedy: [
      'git-sync:await { harness: "<the harness whose checkout you edited>" }',
      `events:await { event: "${eventKey}", payload_filter: { installSlug: "<harness>" } }`,
      'a known commit: events:await { event: "git-sync:committed:<full 40-hex sha>" }',
    ],
  });
}

/** Refusal for a sha-suffixed git-sync key that git-sync can never emit. */
export function gitSyncShaSuffixRefusal(eventKey: string, problem: GitSyncShaSuffixProblem, tool: string) {
  const why =
    problem.reason === 'short-sha'
      ? `"${problem.suffix}" is not a full lowercase object id; git-sync emits the full sha only, so a short sha never matches`
      : `"${problem.suffix}" is not a commit sha, and git-sync has no per-install or per-harness key`;
  return refusal({
    error: 'git_sync_key_never_fires',
    tool,
    event: eventKey,
    detail: `${why}. This key would never fire, so nothing was registered (EI-24719187042784648).`,
    remedy: [
      `git-sync:${problem.kind}:<full sha> — resolve it with git rev-parse <ref>`,
      'next commit of one harness: git-sync:await { harness: "<harness>" }',
    ],
  });
}
