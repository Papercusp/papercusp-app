/**
 * config:role-launch — "what will this role actually launch as?"
 *
 * Plan role-model-one-answer-2026-09-03, P-004. Renders `{ role, model, backend,
 * source, why }` straight from the ONE resolver (`fleet/role-launch.ts`), so this
 * readout cannot disagree with what a launch really does — it is the SAME
 * computation, not a second copy that drifts.
 *
 * WHY THIS EXISTS: on 2026-09-03 nine consecutive release-fixers spawned onto a
 * usage-walled codex account while `models['release-fixer']` and
 * `roleBackends['release-fixer']` were both set correctly to Claude. Finding that
 * out required hand-writing a tsx probe against an internal test seam, because
 * nothing in the system would say what a role resolved to. Had the resolved pair
 * been readable it was a 30-second answer, and this tool is that read.
 *
 * ⚠ POPULATION IS BOUNDED AND SAYS SO. With no `roles` argument this reports the
 * CONFIGURED roles — the union of `models`, `roleBackends` and `tierCeilings` keys
 * — not every role the system can launch (launch roles come from each blueprint's
 * `spine.decider` and enumerating them means parsing every installed blueprint).
 * `population` names which set was measured, so a bounded list is never read as a
 * complete one. Ask about any role by name via `roles: [...]`.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readAgentConfig } from '../../agent-config';
import { getOwnerSteering } from '../../owner-steering';
import { resolveRoleLaunch, type RoleLaunch } from '../../fleet/role-launch';

/** The verdict a caller acts on: is every reported role's answer coherent? */
export type RoleLaunchVerdict = 'consistent' | 'conflicted' | 'undetermined';

/** Pure so the tool and its tests agree on the reading. `conflicted` outranks
    `undetermined`: a contradiction is a wrong launch waiting to happen, while an
    undetermined backend merely inherits the host command. */
export function roleLaunchVerdict(rows: readonly RoleLaunch[]): RoleLaunchVerdict {
  if (rows.some((r) => r.conflict)) return 'conflicted';
  if (rows.some((r) => r.backend == null)) return 'undetermined';
  return 'consistent';
}

export default defineTool({
  name: 'config:role-launch',
  profile: 'engineer',
  description:
    'What a role will ACTUALLY launch as: the resolved { model, backend } plus which rule won (per-role model / tier menu / committed default) and why. Reports any roleBackends setting the resolved model overrules. Defaults to the CONFIGURED roles; pass roles:[…] to ask about any role.',
  capability: 'operator:read',
  guidance: {
    when: 'Before or after changing a role’s model/backend in /settings/agent, or when a spawn came up on the wrong model or CLI — this is the answer the launch path itself uses.',
    notWhen:
      'To EDIT the tier menu — config:tiers-set. To read the tier menu itself — config:tiers-get. To see what is currently running — processes:list.',
    seeAlso: ['config:tiers-get (the tier menu)', 'config:tiers-set (edit it)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 60 } },
  args: z.object({
    roles: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe('Resolve these roles specifically. Omit to report the configured roles.'),
  }),
  async handler(args, ctx) {
    const cfg = await readAgentConfig();
    // Only a CONCRETE workspace + harness identifies a steering row; a superuser
    // session's `'*'` scope names no pot, so read the workspace default rather than
    // guessing which pot's session override to apply.
    const ws = ctx?.workspaceId;
    const pot = ctx?.harnessSlug;
    const steering =
      ws && ws !== '*' && pot && pot !== '*' ? await getOwnerSteering(ws, pot).catch(() => null) : null;

    const configured = [
      ...new Set([
        ...Object.keys(cfg.models ?? {}),
        ...Object.keys(cfg.roleBackends ?? {}),
        ...Object.keys(cfg.tierCeilings ?? {}),
      ]),
    ].sort();

    const requested = args.roles?.length ? [...new Set(args.roles)].sort() : null;
    const population = requested ? ('requested' as const) : ('configured' as const);
    const roleNames = requested ?? configured;

    const roles = roleNames.map((role) => resolveRoleLaunch(role, { cfg, steering }));
    const verdict = roleLaunchVerdict(roles);

    return {
      data: {
        ok: true,
        verdict,
        population,
        populationNote:
          population === 'configured'
            ? 'The roles that appear in models / roleBackends / tierCeilings. This is NOT every launchable role — a role with no configuration runs its committed default; ask for it by name with roles:[…].'
            : 'Exactly the roles you asked for.',
        roles: roles.map((r) => ({
          role: r.role,
          model: r.model,
          backend: r.backend,
          source: r.source,
          backendSource: r.backendSource,
          /** Threaded to the spawn as PAPERCUSP_SPAWN_MODEL; null = the committed default stands. */
          spawnModel: r.spawnModel,
          why: r.why,
          conflict: r.conflict,
        })),
        /** Result-level hoists — a caller who reads no per-row field still cannot miss these. */
        conflicts: roles.filter((r) => r.conflict).map((r) => r.role),
        backendUndetermined: roles.filter((r) => r.backend == null).map((r) => r.role),
      },
    };
  },
});
