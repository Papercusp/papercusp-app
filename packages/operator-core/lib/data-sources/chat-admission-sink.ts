/**
 * Ingest-time chat admission: the rules that turn a chat message into a bug report
 * (slack-messages-to-bug-reports-2026-10-05 P-003, decisions D-008 and D-009).
 *
 * A chat bug rule is an ordinary admission_rules row on the chat data source (no new rule table):
 *   source_kind  'chat-message'  the subject message becomes work
 *                'chat-thread'   the subject's thread becomes work
 *   action       'admit'         create the work through admitWorkItem (attributable, idempotent)
 *                'suggest'       create nothing; the match is only reported (P-007 / P-008)
 *   match        the usual field -> condition map (admission-rules.ts) over the event's canonical
 *                chat payload — channelId, signal, gesture, sender, ... — plus one derived field:
 *                  threadStart   true when the event IS a new top-level post (it opens a thread);
 *                                false for a reply, and for a reaction / mention / shortcut ABOUT
 *                                an existing post
 *   harness_slug / work_kind  where the work goes and what it is (a bug)
 *
 * The SUBJECT of an event is payload.target: the message a report-bug gesture names, or the
 * event's own message (slack.ts gives ordinary events the same shape). No enabled chat rule on
 * the source means nothing happens and nothing is fetched (D-002): an unflagged message in a
 * channel without a rule never becomes work.
 *
 * The chat admission sources read harness_shared.chat_messages, which only the org backfill
 * fills, on its own pace. So before admitting, the subject is made present: a stored row is used
 * as is; otherwise the event's own text is stored when the event says it IS the subject's text
 * (target.text); otherwise — a reaction, an in-thread mention, a shortcut — the one message is
 * fetched through the provider adapter. A failed delivery is recorded on its trigger_deliveries
 * row and is not re-driven, so this sink fails loudly with the step that failed instead of
 * relying on a retry.
 *
 * Thread rules run before message rules. A message admission of a thread's opening post names
 * that thread (ChatMessageRef.threadKey), so "this thread is a bug" and "this message is a bug"
 * fold onto one work item instead of two.
 *
 * Provider-neutral: what is provider-specific (the stored key shape, building a stored message,
 * fetching one) is a ChatAdmissionAdapter. Slack's is createSlackChatAdmissionAdapter in
 * slack-org-connector.ts; the socket manager attaches this sink to every Slack ingest.
 */
import type postgres from 'postgres';
import type { CanonicalExternalEvent, ExternalTriggerSink } from '../external-triggers/ingestion';
import { admitWorkItem, type AdmitDeps, type AdmitResult } from '../work-admission/admit';
import { listAdmissionRules, matchAdmissionRule, type AdmissionRule } from '../work-admission/admission-rules';
import { CHAT_MESSAGE_SOURCE_KIND, CHAT_THREAD_SOURCE_KIND } from './chat-admission-sources';
import { upsertChatMessages, type ChatMessageInput } from './chat-retrieval-units';

export const CHAT_ADMISSION_SINK_KIND = 'data-source-chat-admission';

/** The admission_rules source kinds a chat data source's bug rules use, in evaluation order. */
export const CHAT_RULE_SOURCE_KINDS = [CHAT_THREAD_SOURCE_KIND, CHAT_MESSAGE_SOURCE_KIND] as const;

/** The message an event is about, in the provider's own ids (payload.target). */
export interface ChatSubject {
  channelId: string;
  ts: string;
  /** The thread the event says the subject replies in; null for a top-level post or unknown. */
  threadTs: string | null;
  /** The subject's own text, only when the event carries it (target.text). */
  text: string | null;
}

/** Where the subject is stored (harness_shared.chat_messages keys), per the provider's connector. */
export interface ChatStoredKeys {
  channelId: string;
  providerMessageId: string;
  /** The thread key the event says the message has; null when it says top-level or does not know. */
  threadKey: string | null;
  /** The thread key this message carries when it opens a thread. */
  ownThreadKey: string;
}

export interface ChatAdmissionAdapter {
  keys(subject: ChatSubject): ChatStoredKeys;
  /** The subject as a stored message, built from the event (subject.text is the message's text). */
  fromEvent(subject: ChatSubject & { text: string }, payload: Record<string, unknown>): ChatMessageInput;
  /** Fetches the subject from the provider. Null when the provider no longer has it. */
  fetch(subject: ChatSubject): Promise<ChatMessageInput | null>;
}

export interface ChatAdmissionOutcome {
  subject: ChatStoredKeys | null;
  threadStart: boolean | null;
  /** Rules that matched with action 'admit', and what admitWorkItem answered. */
  admitted: Array<{ ruleId: string; sourceKind: string; result: AdmitResult }>;
  /** Rules that matched with action 'suggest'. Nothing was created for them. */
  suggested: Array<{ ruleId: string; sourceKind: string; harness: string }>;
}

export interface ChatAdmissionDeps extends AdmitDeps {
  adapter: ChatAdmissionAdapter;
  /** Rule lookup seam (tests). Defaults to the source's enabled chat rules. */
  listRules?: (workspaceId: string, dataSourceId: string) => Promise<AdmissionRule[]>;
}

/**
 * The two Slack bug rules people ask for (D-008), per channel:
 *   report-bug  a report-bug gesture (P-002) in the channel files the reported message
 *   new-thread  every new top-level post in the channel files its thread
 * Either with action 'suggest' offers instead of filing.
 */
export const CHAT_RULE_PRESETS = ['report-bug', 'new-thread'] as const;
export type ChatRulePreset = (typeof CHAT_RULE_PRESETS)[number];

export function chatRulePreset(
  preset: ChatRulePreset,
  channelId: string,
): { sourceKind: string; match: Record<string, Record<string, unknown>> } {
  const channel = channelId.trim();
  if (!channel) throw new Error('admission_rule_invalid: a chat preset needs the channel id');
  return preset === 'report-bug'
    ? { sourceKind: CHAT_MESSAGE_SOURCE_KIND, match: { channelId: { eq: channel }, signal: { eq: 'report-bug' } } }
    : { sourceKind: CHAT_THREAD_SOURCE_KIND, match: { channelId: { eq: channel }, threadStart: { eq: true } } };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The subject of a canonical chat payload, or null when the event names none. */
export function chatSubjectOf(payload: Record<string, unknown>): ChatSubject | null {
  const target = payload.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const t = target as Record<string, unknown>;
  const channelId = str(t.channelId);
  const ts = str(t.ts);
  if (!channelId || !ts) return null;
  const threadTs = str(t.threadTs);
  const text = typeof t.text === 'string' && t.text.trim() ? t.text : null;
  return { channelId, ts, threadTs: threadTs && threadTs !== ts ? threadTs : null, text };
}

interface StoredRow {
  thread_key: string | null;
}

async function readStored(
  sql: postgres.Sql,
  workspaceId: string,
  dataSourceId: string,
  keys: ChatStoredKeys,
): Promise<StoredRow | null> {
  const [row] = await sql<StoredRow[]>`
    SELECT thread_key FROM harness_shared.chat_messages
     WHERE workspace_id = ${workspaceId} AND data_source_id = ${dataSourceId}::uuid
       AND channel_id = ${keys.channelId} AND provider_message_id = ${keys.providerMessageId}
     LIMIT 1`;
  return row ?? null;
}

/**
 * Makes the subject present in chat_messages and returns its stored row. A stored row wins over
 * the event: a live event replayed after the backfill stored the post with its replies must not
 * reset the post's thread_key.
 */
async function ensureStored(
  sql: postgres.Sql,
  input: { workspaceId: string; dataSourceId: string; payload: Record<string, unknown> },
  subject: ChatSubject,
  keys: ChatStoredKeys,
  adapter: ChatAdmissionAdapter,
): Promise<StoredRow> {
  const existing = await readStored(sql, input.workspaceId, input.dataSourceId, keys);
  if (existing) return existing;
  let message: ChatMessageInput | null;
  if (subject.text !== null) {
    message = adapter.fromEvent({ ...subject, text: subject.text }, input.payload);
  } else {
    try {
      message = await adapter.fetch(subject);
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`chat_admission_fetch_failed:${keys.channelId}:${keys.providerMessageId}:${why}`);
    }
  }
  if (!message) throw new Error(`chat_admission_subject_unavailable:${keys.channelId}:${keys.providerMessageId}`);
  await upsertChatMessages(sql, input.workspaceId, input.dataSourceId, [message]);
  const stored = await readStored(sql, input.workspaceId, input.dataSourceId, keys);
  if (!stored) throw new Error(`chat_admission_subject_not_stored:${keys.channelId}:${keys.providerMessageId}`);
  return stored;
}

/** Evaluates the source's enabled chat rules against one canonical chat event. */
export async function admitChatEvent(
  sql: postgres.Sql,
  input: { workspaceId: string; dataSourceId: string; payload: Record<string, unknown> },
  deps: ChatAdmissionDeps,
): Promise<ChatAdmissionOutcome> {
  const outcome: ChatAdmissionOutcome = { subject: null, threadStart: null, admitted: [], suggested: [] };
  const subject = chatSubjectOf(input.payload);
  if (!subject) return outcome;
  const rules = await (deps.listRules
    ?? ((ws, ds) => listAdmissionRules(ws, { dataSourceId: ds, sourceKinds: [...CHAT_RULE_SOURCE_KINDS] }, sql)))(
    input.workspaceId,
    input.dataSourceId,
  );
  const chatRules = rules.filter((rule) => rule.enabled && (CHAT_RULE_SOURCE_KINDS as readonly string[]).includes(rule.sourceKind));
  if (chatRules.length === 0) return outcome;

  const keys = deps.adapter.keys(subject);
  const stored = await ensureStored(sql, input, subject, keys, deps.adapter);
  const threadKey = stored.thread_key ?? keys.threadKey;
  const isRoot = threadKey === null || threadKey === keys.ownThreadKey;
  // A thread STARTS with the post itself: a reaction, mention or shortcut about an existing
  // top-level post is not a new thread, so "every new thread is a bug" never fires on one (an
  // event is the post itself exactly when it carries the post's own text).
  const threadStart = isRoot && subject.text !== null;
  outcome.subject = keys;
  outcome.threadStart = threadStart;
  const facts = { ...input.payload, threadStart };
  const thread = threadKey ?? keys.ownThreadKey;

  const ordered = CHAT_RULE_SOURCE_KINDS.flatMap((kind) => chatRules.filter((rule) => rule.sourceKind === kind));
  for (const rule of ordered) {
    if (!matchAdmissionRule(rule.match, facts)) continue;
    if (rule.action === 'suggest') {
      outcome.suggested.push({ ruleId: rule.id, sourceKind: rule.sourceKind, harness: rule.harness });
      continue;
    }
    const source = rule.sourceKind === CHAT_THREAD_SOURCE_KIND
      ? {
          kind: CHAT_THREAD_SOURCE_KIND,
          dataSourceId: input.dataSourceId,
          channelId: keys.channelId,
          threadKey: thread,
          ...(isRoot ? { rootMessageId: keys.providerMessageId } : {}),
        }
      : {
          kind: CHAT_MESSAGE_SOURCE_KIND,
          dataSourceId: input.dataSourceId,
          channelId: keys.channelId,
          providerMessageId: keys.providerMessageId,
          threadKey: thread,
        };
    const result = await admitWorkItem(
      {
        workspaceId: input.workspaceId,
        harness: rule.harness,
        source,
        admitter: { via: 'rule', ruleId: rule.id, dataSourceId: rule.dataSourceId },
        kind: rule.workKind,
      },
      { ...deps, sql: deps.sql ?? sql },
    );
    outcome.admitted.push({ ruleId: rule.id, sourceKind: rule.sourceKind, result });
  }
  return outcome;
}

/**
 * The ingest sink. Attached to every chat ingest of the source (external-triggers/ingestion.ts
 * additionalSinks); replays are deduplicated per sink by the delivery ledger.
 */
export function createChatAdmissionSink(
  sql: postgres.Sql,
  source: { id: string; workspaceId: string },
  deps: ChatAdmissionDeps,
): ExternalTriggerSink {
  return {
    kind: CHAT_ADMISSION_SINK_KIND,
    ref: `${source.id}:chat-message`,
    async deliver(event: CanonicalExternalEvent) {
      const outcome = await admitChatEvent(
        sql,
        { workspaceId: source.workspaceId, dataSourceId: source.id, payload: event.payload },
        deps,
      );
      const refused = outcome.admitted.filter(({ result }) => !result.ok);
      if (refused.length > 0) {
        const codes = refused.map(({ ruleId, result }) => `${ruleId}=${'code' in result ? result.code : 'refused'}`);
        throw new Error(`chat_admission_refused:${codes.join(',')}`);
      }
      return outcome;
    },
  };
}
