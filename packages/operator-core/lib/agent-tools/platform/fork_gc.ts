/**
 * platform:fork_gc — collect ABANDONED contribution forks (PLAN
 * pr-system-completion-dogfood, PR-5 item 3; plan D-3).
 *
 * The runnable surface for the fork-GC library (lib/harness/fork-gc.ts). The
 * fork→PR path creates a fork under the operator's account on first contribution
 * and never tears it down; this sweeps the operator's OWN forks of the named
 * upstream(s) and collects only the abandoned ones — KEEP-on-merge, never touch
 * an active fork (open PR) or a recently-pushed one, never another account's repo.
 *
 * SAFE BY DEFAULT: a plain call is a DRY RUN — it only reports what it WOULD
 * collect. The destructive pass (real deletion) fires ONLY with `confirm:true`,
 * mirroring platform:enable / platform:contribute. Deletion needs the gh
 * `delete_repo` scope; a missing scope surfaces as a per-fork error, never a throw.
 *
 * ROOT-ONLY (a fork is the human operator's repo — a bee must not delete it).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { gcForksForUpstreams, DEFAULT_FORK_RETENTION_MS } from '../../harness/fork-gc';
import { PAPERCUSP_CANONICAL_REPO_URL } from '../../pot/enable-platform-mode';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** Parse "https://github.com/Owner/Repo.git" → {owner, repo}. */
function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export default defineTool({
  name: 'platform:fork_gc',
  profile: 'engineer',
  description:
    "Collect ABANDONED contribution forks under the operator's account (the fork→PR path forks the upstream and never tears it down). KEEP-on-merge + stale-fork GC: never deletes an active fork (open PR) or a recently-pushed one, never another account's repo. DRY RUN by default — pass confirm:true to actually delete (needs the gh delete_repo scope). Root-only. Returns {ok, dryRun, evaluations, wouldCollect|collected, errors}.",
  guidance: {
    when: 'The operator wants to clean up dormant forks left behind by the fork→PR contribution path (e.g. after dogfooding, or on a periodic tidy). Default (no confirm) just REPORTS the abandoned forks.',
    notWhen:
      'Opening/merging a PR — that is the fork-PR hook / prs review route. Removing a hive membership — hive tooling. Deleting a repo you actively contribute to — this never collects a fork with an open PR.',
    chaining:
      'platform:fork_gc (dry-run report) → review wouldCollect → platform:fork_gc { confirm:true } to delete the abandoned forks.',
    seeAlso: [
      'platform:contribute (the fork→PR path that leaves forks)',
      'platform:dogfood_verify (confirm a PR merged before GC)',
    ],
  },
  capability: 'harness:write',
  crossWorkspace: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    confirm: z
      .boolean()
      .optional()
      .describe('Required true to actually DELETE abandoned forks. Without it the call is a dry run (report only).'),
    upstreams: z
      .array(
        z.object({
          owner: z.string().min(1).max(100),
          repo: z.string().min(1).max(150),
        }),
      )
      .optional()
      .describe(`Upstreams to evaluate the operator's forks against. Default: the canonical Papercusp repo (${PAPERCUSP_CANONICAL_REPO_URL}).`),
    retentionDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('A fork untouched for this many days with no open PR is collectable. Default 30.'),
    reason: z
      .string()
      .min(8, 'Provide a short reason (>=8 chars) for the audit log.')
      .describe('Why the GC is being run — recorded for audit.'),
  }),
  async handler(args, ctx) {
    // Root-only: a fork is the human operator's own GitHub repo; a spawned bee
    // must never delete it (mirrors platform:enable's root-only gate).
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'fork_gc_root_only',
        message: 'platform:fork_gc cannot be called from a cup — collecting forks is an owner/operator action.',
      });
    }

    let upstreams = args.upstreams;
    if (!upstreams || upstreams.length === 0) {
      const canonical = parseGithubUrl(PAPERCUSP_CANONICAL_REPO_URL);
      if (!canonical) {
        return text({ ok: false, error: 'no_upstreams', message: 'No upstreams supplied and the canonical repo url could not be parsed.' });
      }
      upstreams = [canonical];
    }

    try {
      const report = await gcForksForUpstreams({
        upstreams,
        dryRun: !args.confirm,
        retentionMs: args.retentionDays ? args.retentionDays * 24 * 60 * 60 * 1000 : DEFAULT_FORK_RETENTION_MS,
        log: (msg) => console.log(msg),
      });
      return text({ ok: true, ...report });
    } catch (e) {
      return text({
        ok: false,
        error: 'fork_gc_failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
