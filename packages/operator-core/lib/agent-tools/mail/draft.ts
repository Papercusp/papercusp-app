import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { draftNewMail } from '../../capability-verbs/mail';
import { AddresseeRefused } from '../../capability-verbs/addressing';
import { UndeliverableAddressee } from '../../capability-verbs/deliverability';
import { addresseeArg, toProvenance } from '../_addressee-arg';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'mail:draft',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Draft a NEW email to recipients you name, outside any existing thread. It lands in the owner\'s own mailbox and is NOT sent — they read, edit and press send themselves. Addressees are checked exactly as mail:send checks them: one that appears only inside message content is REFUSED. Returns the draftId and who was addressed.',
  guidance: {
    when: 'Outbound the owner wants to read before it goes — a first approach, a batch they asked to look over, anything where their judgement should sit between you and the recipient. Review then happens in their own mail client, editable in place.',
    notWhen:
      'They asked you to actually send it — that is mail:send. Answering an existing email is mail:reply { mode:"draft" }, which needs no addressee because the server resolves it from the stored message.',
    chaining:
      'personal:search (contacts) → contactExternalId → mail:draft. Echo the returned recipients[] and draftId so a wrong addressee is visible while it is still only a draft.',
  },
  args: z
    .object({
      to: z.array(z.string().trim().min(3).max(320)).min(1).max(25),
      cc: z.array(z.string().trim().min(3).max(320)).max(25).optional(),
      subject: z.string().trim().min(1).max(998),
      text: z.string().trim().min(1).max(100_000),
      addressee: addresseeArg,
      from: z
        .string()
        .trim()
        .min(3)
        .max(320)
        .optional()
        .describe(
          'Which connected account to draft in, by its address. REQUIRED once the owner has connected more than one — a create-shaped draft has no thread to inherit the account from, so with several connected the call is refused rather than guessed, and the refusal names what is connected.',
        ),
      sourceId: z.string().uuid().optional().describe('The connected mail source to draft in; an alternative to from.'),
      attachments: z
        .array(z.object({ path: z.string().trim().min(1).max(4_096) }).strict())
        .max(10)
        .optional()
        .describe(
          'Local files to attach, by absolute path; the filename the recipient sees is the basename. ALL-OR-NOTHING: an unreadable or empty path fails the whole call rather than drafting a message that silently lacks a file you told the owner it carries. Omit for a body-only draft.',
        ),
      draftId: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .optional()
        .describe(
          'REVISE this existing draft in place instead of creating a new one. The draft id, its place in the mailbox, and anything the owner has typed into it since are preserved — the alternative (delete and re-create) destroys all three to perform what the API models as an edit. Subject, text and attachments REPLACE what the draft held, so send the complete intended message, not a patch. Omit to create a new draft.',
        ),
      allowUndeliverable: z
        .boolean()
        .optional()
        .describe(
          'Draft even to a recipient the receiving server has ALREADY named nonexistent (a 5xx on RCPT, or a domain publishing no MX and no address record). Default false: drafting is refused too, because a draft exists to be sent and a provable bounce is better caught now than after the owner sends it. Only an affirmative server statement blocks — a timeout, 4xx, refused probe or catch-all never does.',
        ),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('mail_draft_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:gmail']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await draftNewMail(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        to: args.to,
        cc: args.cc,
        subject: args.subject,
        text: args.text,
        provenance: toProvenance(args.addressee),
        from: args.from,
        sourceId: args.sourceId ?? null,
        attachments: args.attachments,
        draftId: args.draftId,
        allowUndeliverable: args.allowUndeliverable,
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      // Same structured shape as the trust rail beside it: a provable bounce is
      // a refusal the caller can act on, not an exception to surface raw.
      if (error instanceof UndeliverableAddressee) {
        return {
          data: {
            ok: false,
            refused: true,
            code: error.code,
            address: error.address,
            reason: error.reason,
            detail: error.message,
          },
        };
      }
      if (error instanceof AddresseeRefused) {
        return {
          data: { ok: false, refused: true, code: error.code, address: error.address, standing: error.standing, detail: error.message },
        };
      }
      throw error;
    }
  },
});
