import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { openSealedContent } from '../../personal-vault/sealed-contents';
import { SHARED_SEAL_STORES } from '../../personal-vault/shared-store-seal';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle'] as const;

/**
 * Open a sealed shared row (plan personal-data-reader-set-labels-2026-10-01
 * P-012, D-006). A work-item comment or checkpoint, fact or harness/hive memory
 * written by an agent holding a restricted disclosure keeps a 🔒 stub naming
 * this call. Opening returns the text and, in the same transaction, puts the
 * writer's label snapshot on the caller, so it inherits the same send limit.
 * Sealed coord messages open with coord:read { unseal: true }.
 */
export default defineTool({
  name: 'personal:open-sealed',
  capability: 'memory:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  description:
    'Open a 🔒 sealed work-item comment/checkpoint, fact or shared memory (the stub names the exact call). Returns the text the restricted writer stored; opening limits YOUR outbound sends to the same readers until the owner releases it.',
  guidance: {
    when: 'A shared row reads "🔒 Sealed: … personal:open-sealed { store, ref }" and you need its text for your task.',
    notWhen: 'You can do the task without the text: opening labels you, and the label limits who you may send to. Sealed coord messages — coord:read { msg_id, unseal: true }.',
  },
  args: z.object({
    store: z.enum(SHARED_SEAL_STORES),
    ref: z.string().min(1).max(200),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') {
      return { data: { ok: false, refused: true, code: 'disclosure_workspace_required', detail: 'opening sealed content needs a concrete workspace' } };
    }
    const opened = await withWorkspace(workspaceId, (tx) =>
      openSealedContent(tx, {
        workspaceId,
        store: args.store,
        ref: args.ref,
        opener: { kind: 'agent', ownerId: disclosureSubject(ctx), via: 'personal:open-sealed' },
      }),
    );
    if (!opened.found) {
      return {
        data: { ok: false, refused: true, code: 'sealed_content_not_found', detail: 'no sealed content with that store/ref in this workspace (sealed content never federates)' },
      };
    }
    if (opened.withheld) {
      return {
        data: { ok: false, refused: true, code: 'disclosure_identity_required', detail: 'restricted content is withheld from a caller with no attributable agent identity' },
      };
    }
    return {
      data: {
        ok: true,
        store: args.store,
        ref: args.ref,
        writerOwnerId: opened.writerOwnerId,
        text: typeof opened.content.text === 'string' ? opened.content.text : null,
        context: opened.content.context ?? null,
        // A fact's other authored fields (settledBy, recheck, claim, sourceRef), sealed with its body.
        fields: opened.content.fields ?? null,
        labelled: opened.labelled,
      },
    };
  },
});
