import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { replyToCanonicalMail, replyToTriggerPlanRun } from '../../capability-verbs/mail';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export function mailPersonalAccessRefusal(reason: unknown) {
  return {
    allowed: false,
    refusal: reason,
    requiredScope: 'personal:gmail',
    autoAuthoritySufficient: false,
    draftAvailable: false,
    guidance:
      'Owner-directed AUTO authorizes execution posture but is not a personal-vault grant. ' +
      'Establish a live principal-bound personal:gmail grant first; both draft and send modes require it.',
  } as const;
}

export default defineTool({
  name: 'mail:reply',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Reply to one email the owner already has: its canonical messageId (+ optional sourceId), or the planRunId of a plan run that email triggered. You supply no addressee: the server resolves recipient, thread, subject, reply headers, and the exact connected account from the stored message. Drafts by default; mode:"send" sends.',
  guidance: {
    when: 'The owner asks you to answer a specific email — locate it with personal:search { scopes:["personal:gmail"] }, pass externalId as messageId and sourceId. Or an email-triggered plan step asks you to answer it — pass payload.plan_run.runId as planRunId.',
    notWhen:
      'Writing to a NEW recipient or starting a fresh thread — that is mail:send, which checks the addressee. Not for Slack (chat:reply). You cannot choose who this reaches.',
    chaining:
      'personal:search → { externalId, sourceId } → mail:reply. Report the echoed to/subject/threadId back to the owner as evidence of where it actually went. With planRunId a run replies once; a retry returns alreadyCreated:true.',
  },
  args: z
    .object({
      messageId: z.string().trim().min(1).max(512).optional(),
      sourceId: z.string().uuid().optional(),
      planRunId: z.number().int().positive().optional(),
      text: z.string().trim().min(1).max(100_000),
      mode: z.enum(['draft', 'send']).optional(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('mail_reply_workspace_required');
    if ((args.messageId === undefined) === (args.planRunId === undefined)) {
      throw new Error('mail_reply_target_required: pass exactly one of messageId or planRunId');
    }
    if (args.planRunId !== undefined && args.sourceId !== undefined) {
      throw new Error('mail_reply_source_with_plan_run: the run already names its source; omit sourceId');
    }
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:gmail']);
    if (!auth.allowed) {
      return { data: mailPersonalAccessRefusal(auth.reason) };
    }
    try {
      const sql = ctx.tx as unknown as postgres.Sql;
      const common = { workspaceId, userId: user.id, text: args.text, mode: args.mode ?? 'draft', agentOwnerId: disclosureSubject(ctx) } as const;
      const result =
        args.planRunId !== undefined
          ? await replyToTriggerPlanRun(sql, { ...common, planRunId: args.planRunId })
          : await replyToCanonicalMail(sql, { ...common, messageId: args.messageId!, sourceId: args.sourceId });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof DisclosureRefused) return { data: disclosureRefusalData(error) };
      throw error;
    }
  },
});
