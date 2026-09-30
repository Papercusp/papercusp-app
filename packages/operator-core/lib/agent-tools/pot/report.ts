/**
 * pot:report — any admitted MEMBER files a moderation report against content or
 * another member (Brief EN-3 / P-MOD, the report endpoint). The report federates to
 * the owner's moderation queue (pot:moderation_queue).
 *
 * Gated on the owner having ENABLED reporting (policy.moderation.reportable === true) —
 * absent ⇒ reporting off ⇒ today's behavior, unchanged (the brief's default).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveHiveWorkspaceId } from '../../hive-store';
import { getHivePolicy } from '../../hive-policy-store';
import { resolveLocalGithubIdentity } from '../../identity/resolve-local-github-identity';
import { fileReport, countReportsSince } from '../../hive-reports-store';
import { getHiveMember } from '../../hive-membership-store';
import { resolveFederatedPotScope } from '../../federated-pot-scope';
import { softText, clampText, LIMITS } from '../limits';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

// WI-567 (report-spam abuse vector): cap how many reports one reporter can file in a
// Pot within a rolling window. Fixed, generous constants (not policy-configurable —
// no brief calls for owner tuning) so a scripted report-flood can't drown a real
// moderation queue; a legitimate reporter filing a handful of distinct reports never
// hits this.
const REPORT_RATE_LIMIT_MAX = 20;
const REPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export default defineTool({
  name: 'pot:report',
  profile: 'engineer',
  description:
    "File a moderation report against content or a member in a Pot. The report federates to the owner's moderation queue. Requires the owner to have enabled reporting (moderation.reportable in the Pot policy); otherwise reporting is off and this no-ops.",
  guidance: {
    when: 'You are a member of a Pot with reporting enabled and want to flag abusive content or a member to the owner.',
    notWhen:
      'You ARE the owner taking action — use pot:takedown (hide content) / pot:ban_member (ban a member). Reporting is the member→owner signal, not the owner action.',
    chaining: 'pot:report (member flags) → owner reviews pot:moderation_queue → pot:moderation_resolve / pot:takedown / pot:ban_member.',
    seeAlso: [
      'pot:moderation_queue (where the owner reviews your flag)',
      'pot:takedown (owner action: hide the content)',
      'pot:ban_member (owner action: ban the member)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z.string().min(1).max(120).describe("The Pot's home harness slug."),
    targetKind: z.enum(['content', 'member']).describe("What's being reported: 'content' (a feature/work-item ref) or 'member'."),
    targetRef: z
      .string()
      .min(1)
      .max(200)
      .describe("The content ref (feature/work-item id) or the reported member's numeric github id."),
    reason: softText(LIMITS.ANNOTATION).optional().describe('Why — the reporter\'s free-text reason. Auto-truncated to 2000 chars if longer.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const ambientWorkspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    // WI-5334/WI-5321/WI-5061: same ambient-workspace-mismatch family as
    // authorHivePolicy/policy-set.ts — a JOINED member's ambient workspaceId can
    // differ from whatever partition the Hive's own row (and this member's
    // membership row) is actually stamped under. Resolving here means the
    // policy read, the membership check, AND the write below (fileReport /
    // countReportsSince) all agree on the SAME workspace the Hive is minted
    // in, instead of getHivePolicy/getHiveMember silently missing under the
    // wrong partition (reads as reporting-not-enabled or not-a-member even for
    // a genuinely admitted member) and fileReport persisting the row under a
    // workspace no reader ever queries.
    const workspaceId = await resolveHiveWorkspaceId(ambientWorkspaceId, args.pot);

    // WI-6318: the SAME bug the paragraph above fixes on the WORKSPACE axis, on the SLUG
    // axis. `args.pot` is a TOOL ARGUMENT, so on a joiner it is the LOCAL handle — while
    // hive_policy AND pot_members are both `hiveScoped` projections, persisted under the
    // OWNER-authored (federated) slug. Reading either under the local handle returns
    // nothing, which this handler cannot distinguish from "the owner never enabled
    // reporting" / "you are not a member" — so a legitimate joiner was refused twice over.
    // resolveFederatedPotScope is a no-op on an owner and fails open to the local handle.
    const potScope = await resolveFederatedPotScope(workspaceId, args.pot);

    // Gate: reporting must be enabled by the owner-signed policy.
    const resolved = await getHivePolicy(workspaceId, potScope).catch(() => null);
    if (!resolved?.policy.moderation?.reportable) {
      return text({ ok: false, code: 'reporting_not_enabled', detail: 'the Pot owner has not enabled reporting' });
    }

    const identity = await resolveLocalGithubIdentity();
    if (identity.kind !== 'ok') {
      return text({ ok: false, code: 'no_reporter_identity', detail: 'could not resolve the local GitHub identity' });
    }

    // WI-567 (report-after-leave abuse vector): a departed/never-joined member must not
    // be able to file reports — "any admitted MEMBER" is the doc contract, but nothing
    // previously checked it. Fail closed on a lookup error (never let an unresolvable
    // membership check silently admit the report).
    const member = await getHiveMember(workspaceId, potScope, identity.githubUserId).catch(() => null);
    if (!member) {
      return text({
        ok: false,
        code: 'not_a_member',
        detail: 'you are not an admitted member of this Pot (left, banned, or never joined) — only admitted members may file reports',
      });
    }

    // WI-567 (report-spam abuse vector): rate-gate before writing. Fail OPEN on a
    // count-lookup error (never let a transient store fault block a legitimate
    // report — this is an abuse guard, not a correctness gate).
    // WI-6318: hive_reports is hiveScoped too, so the rate-gate must COUNT under the same
    // scope the rows are written to — otherwise the count is always 0 and the guard is inert.
    const recentCount = await countReportsSince(
      workspaceId,
      potScope,
      identity.githubUserId,
      Date.now() - REPORT_RATE_LIMIT_WINDOW_MS,
    ).catch(() => 0);
    if (recentCount >= REPORT_RATE_LIMIT_MAX) {
      return text({
        ok: false,
        code: 'rate_limited',
        detail: `you have filed ${recentCount} reports in this Pot in the last ${REPORT_RATE_LIMIT_WINDOW_MS / 60000} minutes (limit ${REPORT_RATE_LIMIT_MAX}) — wait before filing more`,
      });
    }

    const report = await fileReport({
      workspaceId,
      // WI-6318 — the WORST instance of the class: this is a WRITE. Under a joiner's local
      // handle the row lands in a scope no reader (including the Pot owner's moderation view)
      // ever queries, while the tool still answers ok:true — the report silently vanishes.
      potHomeSlug: potScope,
      reporterGithubUserId: identity.githubUserId,
      reporterGithubUsername: identity.githubLogin,
      targetKind: args.targetKind,
      targetRef: args.targetRef,
      reportReason: clampText(args.reason, LIMITS.ANNOTATION) ?? null,
    });
    return text({ ok: true, report });
  },
});
