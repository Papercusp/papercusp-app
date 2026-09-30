/**
 * platform:enable — opt INTO platform mode ("Papercusp inside Papercusp")
 * (per-hive-learning-loops-2026-06-14 P-071; D-006/D-007/D-008).
 *
 * The one-call enable flow. Flips the `PLATFORM_IMPROVEMENT_LOOPS` knob on for this
 * install, stands Papercusp's OWN public repo up as a self-managed SHARED Hive
 * (kind:'hive') via the existing pot:create_from_repo machinery (fetch-on-enable,
 * D-007a), and arms the layer-3 platform-improvement loops against it (seeded DARK —
 * the owner arms each via the gym/routines UI). The self-hive inherits its own
 * per-hive gym+scout loop for free (P-020).
 *
 * ROOT-ONLY (mirrors pot:create / pot:dissolve) + reason-audited. The composition
 * lives in `../../hive/enable-platform-mode` (seam-injected, unit-tested); this is the
 * guard + arg surface. Standing up the self-hive does NOT relax any confinement guard
 * (P-073) — the platform loop's blast radius stays THIS install; upstream is
 * PR-/moderation-gated (P-072 / platform:contribute).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  enablePlatformMode,
  PAPERCUSP_CANONICAL_REPO_URL,
  PLATFORM_SELF_POT_SLUG,
} from '../../pot/enable-platform-mode';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'platform:enable',
  profile: 'engineer',
  description:
    'Opt INTO platform mode ("Papercusp inside Papercusp"): flip the PLATFORM_IMPROVEMENT_LOOPS knob on for this install, stand Papercusp\'s OWN repo up as a self-managed shared Hive (kind:\'hive\') via fetch-on-enable from the public repo, and arm the layer-3 platform-improvement loops (seeded DARK — arm each via the gym/routines UI). The self-hive inherits its own gym+scout loop. Root-only, reason-audited. Returns {ok, flagEnabled, selfHive, armedLoops, summary}.',
  guidance: {
    when: 'The user explicitly opts into platform mode / "Papercusp inside Papercusp" / wants this install to improve Papercusp-the-platform itself (layer 3). One call stands up the self-hive + arms the loops.',
    notWhen:
      'Onboarding an ARBITRARY repo as a hive — pot:create_from_repo. Just flipping a flag without standing up the self-hive — flags:set. Contributing an improvement UPSTREAM (open a PR / publish a knowledge-pack) — platform:contribute (the separate, gated path).',
    chaining:
      'platform:enable → improvements:learning_loops to see the armed (dark) layer-3 loops → arm the watchdog via the routines admin → platform:contribute to send an improvement upstream.',
    seeAlso: [
      'platform:contribute (send an improvement upstream)',
      'improvements:learning_loops (see the armed layer-3 loops)',
      'pot:create_from_repo (onboard an arbitrary repo instead)',
    ],
  },
  capability: 'harness:write',
  // The flag flip writes the operator-level override store (no workspace_id on
  // that row), like flags:set; the self-hive create is workspace-scoped via the
  // composition's own resolution. Run cross-workspace so the flag write isn't
  // wrapped in an RLS tx.
  crossWorkspace: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    confirm: z
      .boolean()
      .optional()
      .describe('Required true — platform:enable clones the Papercusp repo + arms layer-3 self-improvement loops on this install.'),
    repoUrl: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(`The Papercusp repo to stand up (default: the canonical public repo ${PAPERCUSP_CANONICAL_REPO_URL}). Override only to point at a fork.`),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
      .optional()
      .describe(`Base slug for the self-hive (default ${PLATFORM_SELF_POT_SLUG}; home = <base>-hive).`),
    runTests: z
      .boolean()
      .optional()
      .describe('Run the repo test command at create (default false — never auto-execute repo code on enable; the same hardening default pot:create_from_repo uses).'),
    reason: z
      .string()
      .min(8, 'Provide a short reason (>=8 chars) for the audit log.')
      .describe('Why platform mode is being enabled — recorded for audit (this is a high-tier, app-wide opt-in).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: active workspace).'),
  }),
  async handler(args, ctx) {
    // Root-only enforcement (mirrors pot:create / pot:dissolve): the self-hive is
    // a root peer, never nested; enabling platform mode is an owner-level opt-in.
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'platform_enable_root_only',
        message:
          'platform:enable cannot be called from a bee (a spawned/parented agent). Enabling platform mode is an owner/operator opt-in.',
      });
    }
    if (!args.confirm) {
      return text({
        ok: false,
        error: 'confirm_required',
        message:
          'platform:enable opts this install into "Papercusp inside Papercusp" — pass confirm:true. It clones the Papercusp repo as a self-managed shared hive and arms the layer-3 self-improvement loops (seeded dark).',
      });
    }

    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const res = await enablePlatformMode({
      workspaceId,
      ...(args.repoUrl ? { repoUrl: args.repoUrl } : {}),
      ...(args.slug ? { slug: args.slug } : {}),
      ...(args.runTests !== undefined ? { runTests: args.runTests } : {}),
    });

    // Best-effort audit (mirrors flags:set): record the opt-in with its reason.
    try {
      const { recordFlagAudit } = await import('../../flag-audit');
      const { FLAGS } = await import('@papercusp/flags');
      await recordFlagAudit(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, true, ctx?.principal?.slug ?? 'agent', {
        reason: `platform:enable — ${args.reason}`,
        backend: 'platform-enable',
      });
    } catch {
      /* audit is best-effort; never fail the enable on it */
    }

    return text(res as unknown as Record<string, unknown>);
  },
});
