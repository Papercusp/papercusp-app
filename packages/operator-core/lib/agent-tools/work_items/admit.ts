/**
 * work_items:admit — the ONE tool by which DATA becomes WORK
 * (enterprise-data-sources-2026-10-01 P-020 / D-004 / D-030).
 *
 * A person promotes a source (an ingested ticket record, and from P-021 a chat message or
 * thread) into a work item, or manages the per-data-source admission rules that admit
 * matching records automatically when a connector ingests them. Every path lands in
 * `admitWorkItem` (lib/work-admission/admit.ts), which owns idempotency, the record link,
 * attribution and field authority. This file is only the projection onto the tool surface.
 *
 * Reused, not new: the work-item writer (`createWorkItem`), the record link (`linkWorkItem`
 * rel 'about'), and the source capability for write-back. The only new durable surfaces are
 * the two tables in migration 1337 (work_admissions, admission_rules).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { getSessionUserOrDefault } from '../../auth';
import { ADMITTED_KINDS, admitWorkItem, transitionAdmission, writeBackAdmission } from '../../work-admission/admit';
import { TICKET_STATUS_CATEGORIES } from '../../data-sources/ticket-vocabulary';
import { listAdmissionSourceKinds } from '../../work-admission/admission-sources';
import { CHAT_RULE_PRESETS, chatRulePreset, type ChatRulePreset } from '../../data-sources/chat-admission-sink';
import {
  ADMISSION_BACKFILL_MAX,
  ADMISSION_RULE_ACTIONS,
  ADMISSION_RULE_SOURCE_KINDS,
  applyAdmissionRule,
  disableAdmissionRule,
  listAdmissionRules,
  setAdmissionRule,
} from '../../work-admission/admission-rules';
// Side effect: registers the `record` admission source (ingested ticket records).
import '../../work-admission/record-source';
// P-021: registers the 'chat-message' and 'chat-thread' admission resolvers (D-030).
import '../../data-sources/chat-admission-sources';

const OPS = ['admit', 'write-back', 'transition', 'rules-set', 'rules-list', 'rules-disable', 'rules-apply'] as const;

/** Thrown rule errors carry a `code: detail` prefix; surface them as a typed refusal. */
function ruleRefusal(err: unknown): { ok: false; code: string; message: string } | null {
  const message = err instanceof Error ? err.message : String(err);
  const m = /^(admission_rule_[a-z_]+)[:]?\s*(.*)$/.exec(message);
  return m ? { ok: false, code: m[1]!, message: m[2] || message } : null;
}

export default defineTool({
  name: 'work_items:admit',
  profile: 'engineer',
  description:
    "Admit ingested data into work (D-004). op 'admit' turns a source (e.g. { kind:'record', recordId }) into one linked, attributed work item, idempotent per source. 'write-back' posts a note to the admitted item's source; 'transition' moves it to toCategory. 'rules-*' manage per-data-source rules that admit matching records on ingest.",
  guidance: {
    when: 'A person promotes an ingested ticket, message or thread into work, writes a note back to its source, or sets a rule that admits matching records automatically.',
    notWhen: 'Filing work that has no data source (work_items:create), or editing an admitted item (title/description belong to the source; update it there).',
    chaining:
      "work_items:admit { op:'rules-set', rule:{ dataSourceId, title, match:{ assignee:{ eq:'papercusp-agents' } } }, harness } → op:'rules-apply' { ruleId } backfills existing records.",
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    op: z.enum(OPS).optional().describe("Default 'admit'."),
    harness: z.string().min(1).max(80).optional().describe("Harness that receives the work item (admit, rules-set)."),
    workspace: z.string().min(1).max(120).optional().describe('Workspace override; defaults to the call context.'),
    source: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("admit: { kind, ...ref }, e.g. { kind:'record', recordId }."),
    title: z.string().min(1).max(300).optional().describe("admit: title override; defaults to the source's title."),
    kind: z.enum(ADMITTED_KINDS).optional().describe("admit: work kind, default 'change'."),
    workItemId: z.string().min(1).max(200).optional().describe('write-back / transition: the admitted work item.'),
    text: z.string().min(1).max(4000).optional().describe('write-back: plain-text note.'),
    toCategory: z.enum(TICKET_STATUS_CATEGORIES).optional().describe('transition: target workflow category.'),
    rule: z
      .object({
        id: z.string().min(1).max(200).optional(),
        dataSourceId: z.string().min(1).max(200),
        title: z.string().min(1).max(300),
        match: z.record(z.string(), z.unknown()).optional(),
        sourceKind: z.enum(ADMISSION_RULE_SOURCE_KINDS).optional().describe('Default record; chat-message / chat-thread for chat rules.'),
        action: z.enum(ADMISSION_RULE_ACTIONS).optional().describe("Default admit; 'suggest' (chat) files nothing."),
        preset: z.enum(CHAT_RULE_PRESETS).optional().describe('Chat rule shorthand for channelId: sets sourceKind + match; workKind defaults to bug.'),
        channelId: z.string().min(1).max(200).optional().describe('preset: the chat channel id.'),
        workKind: z.enum(ADMITTED_KINDS).optional(),
        enabled: z.boolean().optional(),
        lifecycle: z
          .object({
            claim: z.boolean().optional(),
            hold: z.boolean().optional(),
            complete: z.boolean().optional(),
            completeCategory: z.enum(TICKET_STATUS_CATEGORIES).optional(),
            externalClose: z.boolean().optional(),
            reopen: z.boolean().optional(),
          })
          .strict()
          .optional()
          .describe('Write-back/reaction switches; all on by default, completion moves the source to done.'),
      })
      .optional()
      .describe("rules-set: match is { field:{ eq|in|contains: value } }, all fields must match."),
    ruleId: z.string().min(1).max(200).optional().describe('rules-disable / rules-apply.'),
    dataSourceId: z.string().min(1).max(200).optional().describe('rules-list filter.'),
    includeDisabled: z.boolean().optional().describe('rules-list: include disabled rules.'),
    limit: z.number().int().min(1).max(ADMISSION_BACKFILL_MAX).optional().describe('rules-apply: records scanned per call.'),
  }),
  async handler(args, ctx) {
    return { data: await runAdmitOp(args, ctx) };
  },
});

type AdmitToolArgs = {
  op?: (typeof OPS)[number];
  harness?: string;
  workspace?: string;
  source?: Record<string, unknown>;
  title?: string;
  kind?: (typeof ADMITTED_KINDS)[number];
  workItemId?: string;
  text?: string;
  toCategory?: (typeof TICKET_STATUS_CATEGORIES)[number];
  rule?: {
    id?: string;
    dataSourceId: string;
    title: string;
    match?: Record<string, unknown>;
    sourceKind?: (typeof ADMISSION_RULE_SOURCE_KINDS)[number];
    action?: (typeof ADMISSION_RULE_ACTIONS)[number];
    preset?: ChatRulePreset;
    channelId?: string;
    workKind?: (typeof ADMITTED_KINDS)[number];
    enabled?: boolean;
    lifecycle?: Record<string, unknown>;
  };
  ruleId?: string;
  dataSourceId?: string;
  includeDisabled?: boolean;
  limit?: number;
};

type AdmitToolCtx = Parameters<typeof resolveAgentIdentity>[0] & {
  workspaceId?: string | null;
  principal?: { workspaceId?: string | null } | null;
};

async function runAdmitOp(args: AdmitToolArgs, ctx: AdmitToolCtx) {
    const workspaceId =
      args.workspace ??
      (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : ctx.principal?.workspaceId) ??
      activeWorkspaceId();
    const op = args.op ?? 'admit';
    const need = (field: string) => ({ ok: false as const, code: 'invalid_args', message: `op '${op}' requires ${field}` });

    switch (op) {
      case 'admit': {
        if (!args.harness) return need('harness');
        if (!args.source) return need('source');
        const ident = resolveAgentIdentity(ctx);
        // The local user behind the call, for resolvers that check the person's visibility of
        // the source (chat channels). Best-effort: without it the person has no personal or
        // organization visibility, so such a resolver refuses rather than over-grants.
        const user = await getSessionUserOrDefault().catch(() => null);
        const result = await admitWorkItem({
          workspaceId,
          harness: args.harness,
          source: args.source,
          admitter: {
            via: 'person',
            actorId: ident.ownerId,
            ...(user?.id ? { principalUserId: user.id } : {}),
          },
          title: args.title,
          kind: args.kind,
        });
        if (!result.ok && result.code === 'admission_source_unknown') {
          return { ...result, registeredKinds: listAdmissionSourceKinds() };
        }
        return result;
      }
      case 'write-back': {
        if (!args.workItemId) return need('workItemId');
        if (!args.text) return need('text');
        return writeBackAdmission(workspaceId, args.workItemId, args.text);
      }
      case 'transition': {
        if (!args.workItemId) return need('workItemId');
        if (!args.toCategory) return need('toCategory');
        return transitionAdmission(workspaceId, args.workItemId, args.toCategory);
      }
      case 'rules-set': {
        if (!args.rule) return need('rule');
        if (!args.harness) return need('harness');
        const ident = resolveAgentIdentity(ctx);
        try {
          const preset = args.rule.preset ? chatRulePreset(args.rule.preset, args.rule.channelId ?? '') : null;
          if (preset && (args.rule.match || args.rule.sourceKind)) {
            throw new Error('admission_rule_invalid: give either preset+channelId or sourceKind+match, not both');
          }
          const match = preset?.match ?? args.rule.match;
          if (!match) return need('rule.match (or rule.preset + rule.channelId)');
          const rule = await setAdmissionRule({
            workspaceId,
            dataSourceId: args.rule.dataSourceId,
            title: args.rule.title,
            match,
            harness: args.harness,
            workKind: args.rule.workKind ?? (preset ? 'bug' : undefined),
            sourceKind: preset?.sourceKind ?? args.rule.sourceKind,
            action: args.rule.action,
            createdBy: ident.ownerId,
            id: args.rule.id,
            enabled: args.rule.enabled,
            lifecycle: args.rule.lifecycle,
          });
          return { ok: true as const, rule };
        } catch (err) {
          const refused = ruleRefusal(err);
          if (refused) return refused;
          throw err;
        }
      }
      case 'rules-list': {
        const rules = await listAdmissionRules(workspaceId, {
          dataSourceId: args.dataSourceId,
          includeDisabled: args.includeDisabled,
        });
        return { ok: true as const, count: rules.length, rules };
      }
      case 'rules-disable': {
        if (!args.ruleId) return need('ruleId');
        try {
          return { ok: true as const, rule: await disableAdmissionRule(workspaceId, args.ruleId) };
        } catch (err) {
          const refused = ruleRefusal(err);
          if (refused) return refused;
          throw err;
        }
      }
      case 'rules-apply': {
        if (!args.ruleId) return need('ruleId');
        try {
          return { ok: true as const, ...(await applyAdmissionRule(workspaceId, args.ruleId, { limit: args.limit })) };
        } catch (err) {
          const refused = ruleRefusal(err);
          if (refused) return refused;
          throw err;
        }
      }
    }
}
