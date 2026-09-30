/** Flagship Gmail inbound message → plan run → anchored draft reply binding (P-011). */
import type postgres from 'postgres';
import { ensureFlagshipPlan, type FlagshipPlanEnsureResult } from './flagship-plan';
import { ensureExternalTriggerBinding, type CreatedExternalTriggerBinding } from './admin';
import { createGoogleGmailDraft, replySubjectFor, type GoogleGmailDraftResult } from './google-gmail';
import { resolveGoogleWorkspaceAccessToken } from './google-workspace';
import type { ExternalTriggerSourceRow } from './source-store';

type Db = postgres.Sql | postgres.TransactionSql;

export const GMAIL_RESPOND_DRAFT_HARNESS = 'email';
/** Google Workspace credentials remain installed in the papercusp host. */
export const GMAIL_RESPOND_DRAFT_CREDENTIAL_HARNESS = 'papercusp';
export const GMAIL_RESPOND_DRAFT_PLAN = 'gmail-respond-with-draft-2026-08-22';
export const GMAIL_RESPOND_DRAFT_EVENT = 'ext:gmail:message.received';

export const GMAIL_RESPOND_DRAFT_PLAN_CONTENT = `---
title: Gmail message — respond with a draft
slug: ${GMAIL_RESPOND_DRAFT_PLAN}
status: ready
created: 2026-08-22
updated: 2026-09-04
---

# Gmail message — respond with a draft

## Now

**State:** Ready built-in template. Each inbound Gmail message creates one isolated event run.

**Next:** Read the triggering message, draft a useful response, and save it to the originating Gmail thread.

## Background

\`plan_run.inputs.trigger\` carries only the routing envelope — the message itself is
deliberately NOT embedded there. Read it with \`triggers:read-payload\`, passing this
run's numeric id. The draft tool accepts only that same id; it resolves the recipient,
thread, reply headers, and OAuth credential server-side. It creates a Gmail DRAFT and
never sends.

## Phase 1 — Draft

- **P-001** \`todo\` Call \`triggers:read-payload\` with \`planRunId=payload.plan_run.runId\` to read the inbound message, compose a concise response, then call \`gmail:create-draft\` with that same \`planRunId\` and the response text. Complete only after the tool reports \`created:true\` or \`alreadyCreated:true\`.

## Decisions

### D-001 — Draft creation is anchored to a trigger plan run; auto-send stays outside this tool
Date: 2026-08-22
The tool resolves every Gmail coordinate and credential from the durable trigger run. Its public input is only planRunId plus text. It has no send branch; automatic sending is a separate owner-authority dark-flag surface.

### D-002 — The message is referenced, not embedded
Date: 2026-09-04
A plan run's inputs land in a federated work-item payload, so embedding the inbound email there would replicate the owner's private inbox to admitted hive members. The engine now passes the routing envelope only, and the agent pulls the message server-side by planRunId. Read and write both resolve from the owner-local trigger run.
`;

export const GMAIL_RESPOND_DRAFT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger'],
  properties: {
    trigger: {
      type: 'object',
      additionalProperties: true,
      // `payload` is deliberately absent: the engine projects it out of plan-run
      // inputs (WI-2143575) because those inputs federate. Requiring it here
      // would refuse every launch. The agent reads it via `triggers:read-payload`.
      required: ['key', 'source', 'event', 'sourceId', 'externalId', 'dedupeKey'],
      properties: {
        key: { const: GMAIL_RESPOND_DRAFT_EVENT },
        source: { const: 'gmail' },
        event: { const: 'message.received' },
        sourceId: { type: 'string', minLength: 1 },
        externalId: { type: 'string', minLength: 1 },
        dedupeKey: { type: 'string', minLength: 1 },
      },
    },
  },
} as const;

export const GMAIL_RESPOND_DRAFT_EVENT_FILTER = {
  all: [
    { direction: 'inbound' },
    { threadId: { exists: true } },
    { from: { exists: true } },
    { subject: { exists: true } },
    { messageId: { exists: true } },
  ],
} as const;

export type GmailFlagshipPlanEnsureResult = FlagshipPlanEnsureResult;

export async function ensureGmailRespondDraftPlan(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<GmailFlagshipPlanEnsureResult> {
  return ensureFlagshipPlan(sql, workspaceId, {
    harnessSlug: GMAIL_RESPOND_DRAFT_HARNESS,
    planSlug: GMAIL_RESPOND_DRAFT_PLAN,
    content: GMAIL_RESPOND_DRAFT_PLAN_CONTENT,
    inputSchema: GMAIL_RESPOND_DRAFT_INPUT_SCHEMA,
  });
}

export interface GmailFlagshipBindingResult {
  plan: GmailFlagshipPlanEnsureResult;
  binding: CreatedExternalTriggerBinding;
}

/**
 * Re-home the legacy built-in binding from the papercusp queue to Email and
 * normalize every surviving binding to durable manual-review execution.
 * Preserve its armed state and id; detach any redundant legacy copies so a
 * reconnect cannot leave both paths firing the same inbound message.
 */
export async function migrateLegacyGmailRespondDraftBinding(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
): Promise<{ migrated: number; detached: number }> {
  const action = JSON.stringify({ type: 'launch-plan' });
  const eventFilter = JSON.stringify(GMAIL_RESPOND_DRAFT_EVENT_FILTER);
  return sql.begin(async (tx) => {
    const lockKey = ['gmail-respond-draft-binding', workspaceId, sourceId].join(':');
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const current = await tx<Array<{ id: string }>>`
      SELECT id::text FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${workspaceId} AND source_id = ${sourceId}::uuid
         AND plan_harness_slug = ${GMAIL_RESPOND_DRAFT_HARNESS}
         AND plan_slug = ${GMAIL_RESPOND_DRAFT_PLAN}
         AND event_pattern = ${GMAIL_RESPOND_DRAFT_EVENT}
         AND detached_at IS NULL
       ORDER BY created_at, id LIMIT 1`;
    const legacy = await tx<Array<{ id: string }>>`
      SELECT id::text FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${workspaceId} AND source_id = ${sourceId}::uuid
         AND plan_harness_slug = ${GMAIL_RESPOND_DRAFT_CREDENTIAL_HARNESS}
         AND plan_slug = ${GMAIL_RESPOND_DRAFT_PLAN}
         AND event_pattern = ${GMAIL_RESPOND_DRAFT_EVENT}
         AND detached_at IS NULL
       ORDER BY created_at, id`;
    let migrated = 0;
    let keepLegacyId: string | null = null;
    if (!current[0] && legacy[0]) {
      keepLegacyId = legacy[0].id;
      await tx`
        UPDATE harness_shared.trigger_bindings
           SET plan_harness_slug = ${GMAIL_RESPOND_DRAFT_HARNESS},
               event_filter = ${eventFilter}::text::jsonb,
               action = ${action}::text::jsonb,
               updated_at = now()
         WHERE workspace_id = ${workspaceId} AND id = ${keepLegacyId}::uuid`;
      migrated = 1;
    }
    if (current[0]) {
      // A provider event must remain durable when no named agent session is
      // resident. The ordinary plan-run queue is the review surface; a future
      // always-on executor can opt in without changing the provider contract.
      await tx`
        UPDATE harness_shared.trigger_bindings
           SET event_filter = ${eventFilter}::text::jsonb,
               action = ${action}::text::jsonb,
               updated_at = now()
         WHERE workspace_id = ${workspaceId} AND id = ${current[0].id}::uuid
           AND (event_filter IS DISTINCT FROM ${eventFilter}::text::jsonb
             OR action IS DISTINCT FROM ${action}::text::jsonb)`;
    }
    let detached = 0;
    for (const row of legacy) {
      if (row.id === keepLegacyId) continue;
      await tx`
        UPDATE harness_shared.trigger_bindings
           SET armed = FALSE, detached_at = COALESCE(detached_at, now()), updated_at = now()
         WHERE workspace_id = ${workspaceId} AND id = ${row.id}::uuid`;
      detached += 1;
    }
    return { migrated, detached };
  });
}

/** Install the built-in template and one reconnect-idempotent, disarmed inbound binding. */
export async function ensureGmailRespondDraftBinding(
  sql: postgres.Sql,
  workspaceId: string,
  source: ExternalTriggerSourceRow,
  createdBy?: string | null,
  deps: {
    ensurePlan?: typeof ensureGmailRespondDraftPlan;
    ensureBinding?: typeof ensureExternalTriggerBinding;
    migrateLegacyBinding?: typeof migrateLegacyGmailRespondDraftBinding;
  } = {},
): Promise<GmailFlagshipBindingResult> {
  if (source.workspaceId !== workspaceId || source.kind !== 'gmail') {
    throw new Error('gmail_flagship_source_invalid');
  }
  const plan = await (deps.ensurePlan ?? ensureGmailRespondDraftPlan)(sql, workspaceId);
  await (deps.migrateLegacyBinding ?? migrateLegacyGmailRespondDraftBinding)(sql, workspaceId, source.id);
  const binding = await (deps.ensureBinding ?? ensureExternalTriggerBinding)(sql, workspaceId, {
    sourceId: source.id,
    planHarnessSlug: GMAIL_RESPOND_DRAFT_HARNESS,
    planSlug: GMAIL_RESPOND_DRAFT_PLAN,
    eventPattern: GMAIL_RESPOND_DRAFT_EVENT,
    eventFilter: GMAIL_RESPOND_DRAFT_EVENT_FILTER,
    createdBy,
  });
  return { plan, binding };
}

interface GmailDraftTriggerRow {
  id: string;
  args: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  sourceId: string;
  ownerUserId: string | null;
  credentialRef: string | null;
  providerAccountId: string | null;
  sourceStatus: string;
  sourceConfig: Record<string, unknown>;
  sourceCursor: Record<string, unknown>;
}

export interface GmailPlanDraftResponseResult extends GoogleGmailDraftResult {
  created: boolean;
  alreadyCreated: boolean;
  to: string;
  subject: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Re-exported from the adapter so `Re:` handling exists in exactly one place. */
const replySubject = replySubjectFor;

/** Resolve the originating email from a durable run and create exactly one draft reply. */
export async function draftResponseToGmailTriggerPlanRun(
  sql: Db,
  workspaceId: string,
  planRunId: number,
  responseText: string,
  deps: {
    resolveAccessToken?: typeof resolveGoogleWorkspaceAccessToken;
    createDraft?: typeof createGoogleGmailDraft;
    fetch?: typeof fetch;
    apiOrigin?: string;
    now?: () => Date;
  } = {},
): Promise<GmailPlanDraftResponseResult> {
  if (!Number.isSafeInteger(planRunId) || planRunId <= 0) throw new Error('gmail_draft_plan_run_id_invalid');
  const text = responseText.trim();
  if (!text || text.length > 100_000) throw new Error('gmail_draft_text_invalid');
  const draftInTransaction = async (tx: Db): Promise<GmailPlanDraftResponseResult> => {
    const rows = await tx<GmailDraftTriggerRow[]>`
      SELECT tr.id::text,
             tr.args,
             tr.outcome,
             s.id::text AS "sourceId",
             s.owner_user_id::text AS "ownerUserId",
             s.credential_ref AS "credentialRef",
             s.provider_account_id::text AS "providerAccountId",
             s.status AS "sourceStatus",
             s.config AS "sourceConfig",
             s.cursor AS "sourceCursor"
        FROM harness_shared.trigger_runs tr
        JOIN harness_shared.trigger_bindings b
          ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
        JOIN harness_shared.trigger_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
       WHERE tr.workspace_id = ${workspaceId}
         AND tr.plan_run_ref = ${String(planRunId)}
         AND tr.status = 'succeeded'
         AND s.kind = 'gmail'
       ORDER BY tr.completed_at DESC NULLS LAST, tr.id
       LIMIT 1
       FOR UPDATE OF tr`;
    const row = rows[0];
    if (!row) throw new Error(`gmail_draft_trigger_run_not_found:${planRunId}`);
    const priorDraft = object(object(row.outcome).gmailDraft);
    const priorDraftId = string(priorDraft.draftId);
    if (priorDraftId) {
      return {
        created: false,
        alreadyCreated: true,
        draftId: priorDraftId,
        messageId: string(priorDraft.messageId),
        threadId: string(priorDraft.threadId),
        to: string(priorDraft.to),
        subject: string(priorDraft.subject),
      };
    }
    const payload = object(object(row.args.trigger).payload);
    if (string(payload.direction) !== 'inbound') throw new Error('gmail_draft_trigger_not_inbound');
    const to = string(payload.from);
    const subject = replySubject(string(payload.subject));
    const threadId = string(payload.threadId);
    const inReplyTo = string(payload.messageId);
    if (!to || !subject || !threadId || !inReplyTo) throw new Error('gmail_draft_trigger_coordinates_missing');
    const source: ExternalTriggerSourceRow = {
      id: row.sourceId,
      workspaceId,
      kind: 'gmail',
      ownerUserId: row.ownerUserId,
      credentialRef: row.credentialRef,
      providerAccountId: row.providerAccountId,
      status: row.sourceStatus,
      config: row.sourceConfig,
      cursor: row.sourceCursor,
    };
    const installSlug = string(source.config.installSlug) || GMAIL_RESPOND_DRAFT_CREDENTIAL_HARNESS;
    const token = await (deps.resolveAccessToken ?? resolveGoogleWorkspaceAccessToken)(source, installSlug);
    const created = await (deps.createDraft ?? createGoogleGmailDraft)(
      token,
      {
        to,
        subject,
        text,
        threadId,
        inReplyTo,
        references: string(payload.references) || null,
      },
      { fetch: deps.fetch, apiOrigin: deps.apiOrigin },
    );
    const outcome = {
      ...object(row.outcome),
      gmailDraft: {
        ...created,
        to,
        subject,
        draftedAt: (deps.now ?? (() => new Date()))().toISOString(),
      },
    };
    await tx`
      UPDATE harness_shared.trigger_runs
         SET outcome = ${JSON.stringify(outcome)}::text::jsonb, updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${row.id}::uuid`;
    return { created: true, alreadyCreated: false, ...created, to, subject };
  };
  return 'begin' in sql ? sql.begin(draftInTransaction) : draftInTransaction(sql);
}
