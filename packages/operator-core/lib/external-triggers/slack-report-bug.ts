/**
 * Slack report-bug signals — slack-messages-to-bug-reports-2026-10-05 P-002 (R-2, D-002, D-004).
 *
 * Four gestures on the existing Socket Mode connection turn a Slack message into ONE
 * `report-bug` chat signal on the `chat-message` datatype:
 *
 *   reaction     someone reacts with the configured emoji (default `bug`)
 *   shortcut     the "Report a bug" message shortcut opens a form; its submission
 *                (optional note + attachment-consent tick box) is the signal
 *   mention      "@Papercusp bug …" — in a thread it reports the thread's root message
 *   bug-channel  a new top-level post in a channel set up as a bug channel
 *
 * Every gesture is OFF until a channel rule turns it on (source.config.reportBug), because
 * a channel with no rule has no project to file into (P-003). Exactly one gesture
 * produces the signal for one person action: a top-level post in a bug channel arrives
 * from Slack as both `message` and `app_mention`, so the `app_mention` copy is consumed
 * there and only the `message` copy yields the signal.
 *
 * The acting Slack user is recorded as provenance only, never resolved to a local
 * principal (external-triggers D-008), and the message text is carried as untrusted
 * evidence. This module is pure: the network call that opens the form lives in slack.ts.
 */
import type { SlackNormalizedEvent, SlackSocketEnvelope } from './slack';

export const SLACK_REPORT_BUG_SHORTCUT_CALLBACK_ID = 'papercusp_report_bug';
export const SLACK_REPORT_BUG_MODAL_CALLBACK_ID = 'papercusp_report_bug_modal';
export const SLACK_REPORT_BUG_DEFAULT_EMOJI = 'bug';
export const SLACK_REPORT_BUG_ATTACHMENT_CONSENT = 'include-attachments';

export type SlackReportBugGesture = 'reaction' | 'shortcut' | 'mention' | 'bug-channel';

/** Which gestures report bugs in one channel. Every switch defaults OFF. */
export interface SlackReportBugChannelRule {
  reaction: boolean;
  shortcut: boolean;
  mention: boolean;
  bugChannel: boolean;
}

export interface SlackReportBugConfig {
  emoji: string;
  botUserId: string | null;
  /** Keyed by Slack channel id; `*` applies to every channel without its own entry. */
  channels: Record<string, SlackReportBugChannelRule>;
}

/** What the "Report a bug" form needs to open and later point back at the message. */
export interface SlackReportModalRequest {
  triggerId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  reporterUserId: string;
}

export type SlackReportBugClassification =
  | { kind: 'signal'; event: SlackNormalizedEvent }
  | { kind: 'open-modal'; request: SlackReportModalRequest }
  /** Report-bug handling owns this envelope and deliberately emits nothing for it. */
  | { kind: 'consumed'; reason: string }
  | null;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function emojiName(value: unknown): string {
  return text(value).trim().replace(/^:+|:+$/g, '').toLowerCase();
}

function slackTs(value: unknown): string | null {
  const raw = text(value).trim();
  return /^\d+(?:\.\d+)?$/.test(raw) ? raw : null;
}

function occurredAtOf(value: unknown): string | null {
  const ts = slackTs(value);
  return ts ? new Date(Number(ts) * 1_000).toISOString() : null;
}

function mentionsIn(message: string): string[] {
  return [...message.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]!);
}

/** Parse source.config.reportBug. Anything malformed reads as OFF, never as ON. */
export function slackReportBugConfig(sourceConfig: Record<string, unknown>): SlackReportBugConfig {
  const raw = record(sourceConfig.reportBug) ?? {};
  const channels: Record<string, SlackReportBugChannelRule> = {};
  for (const [channelId, value] of Object.entries(record(raw.channels) ?? {})) {
    const rule = record(value);
    if (!rule || !channelId.trim()) continue;
    channels[channelId.trim()] = {
      reaction: rule.reaction === true,
      shortcut: rule.shortcut === true,
      mention: rule.mention === true,
      bugChannel: rule.bugChannel === true,
    };
  }
  const botUserId = text(sourceConfig.botUserId).trim();
  return {
    emoji: emojiName(raw.emoji) || SLACK_REPORT_BUG_DEFAULT_EMOJI,
    botUserId: botUserId || null,
    channels,
  };
}

export function slackReportBugGestureEnabled(
  config: SlackReportBugConfig,
  channelId: string | null,
  gesture: SlackReportBugGesture,
): boolean {
  if (!channelId) return false;
  const rule = config.channels[channelId] ?? config.channels['*'];
  if (!rule) return false;
  return gesture === 'bug-channel' ? rule.bugChannel : rule[gesture];
}

/**
 * True when a mention asks to report a bug: after the leading @-mentions the message
 * starts with `bug`, `:bug:`, 🐛, `report bug` or `report a/this bug`.
 */
export function slackMentionHasBugIntent(message: string): boolean {
  const rest = message.replace(/^(?:\s*<@[A-Z0-9]+(?:\|[^>]*)?>)+/, '').trim().toLowerCase();
  return /^(?::bug:|🐛|bugs?\b|report-bug\b|report\s+(?:a\s+|this\s+)?bug\b)/u.test(rest);
}

function compact(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

interface SignalInput {
  externalId: string;
  gesture: SlackReportBugGesture;
  channelId: string;
  ts: string;
  threadTs: string | null;
  reporterUserId: string;
  text: string;
  occurredAt: string | null;
  note?: string;
  attachmentConsent?: boolean;
  /**
   * The reported message's own text, set only when the gesture event IS that message (a
   * bug-channel post, a top-level mention). An in-thread mention reports the thread's root and a
   * shortcut carries the reporter's note, so their `text` is NOT the subject's and stays out of
   * target.text (the chat admission sink stores target.text as the message body, D-009).
   */
  subjectText?: string;
}

function reportBugSignal(input: SignalInput): SlackNormalizedEvent {
  return {
    event: 'report-bug',
    externalId: input.externalId,
    dedupeKey: `slack:${input.externalId}`,
    occurredAt: input.occurredAt,
    channelId: input.channelId,
    payload: compact({
      id: input.externalId,
      channelId: input.channelId,
      threadId: input.threadTs ?? input.ts,
      sender: input.reporterUserId,
      text: input.text,
      occurredAt: input.occurredAt ?? undefined,
      mentions: mentionsIn(input.text),
      signal: 'report-bug',
      gesture: input.gesture,
      reporter: { kind: 'chat', provider: 'slack', externalUserId: input.reporterUserId },
      target: compact({ channelId: input.channelId, ts: input.ts, threadTs: input.threadTs ?? undefined, text: input.subjectText }),
      note: input.note,
      attachmentConsent: input.attachmentConsent,
    }),
  };
}

function classifyEvent(payload: Record<string, unknown>, config: SlackReportBugConfig): SlackReportBugClassification {
  const event = record(payload.event);
  const eventId = text(payload.event_id);
  if (!event || !eventId) return null;
  const type = text(event.type);

  if (type === 'reaction_added') {
    const item = record(event.item);
    const channelId = text(item?.channel) || null;
    const ts = slackTs(item?.ts);
    const user = text(event.user);
    if (!item || text(item.type) !== 'message' || !channelId || !ts || !user) return null;
    if (emojiName(text(event.reaction).split('::')[0]) !== config.emoji) return null;
    if (user === config.botUserId) return { kind: 'consumed', reason: 'own-reaction' };
    if (!slackReportBugGestureEnabled(config, channelId, 'reaction')) return null;
    return {
      kind: 'signal',
      event: reportBugSignal({
        externalId: eventId, gesture: 'reaction', channelId, ts, threadTs: null, reporterUserId: user,
        text: '', occurredAt: occurredAtOf(event.event_ts ?? payload.event_time),
      }),
    };
  }

  if (event.bot_id || event.subtype) return null;
  const channelId = text(event.channel) || null;
  const ts = slackTs(event.ts);
  const user = text(event.user);
  const message = text(event.text);
  if (!channelId || !ts || !user) return null;
  const threadTs = slackTs(event.thread_ts);
  const topLevel = !threadTs || threadTs === ts;

  if (type === 'app_mention') {
    if (topLevel && slackReportBugGestureEnabled(config, channelId, 'bug-channel')) {
      return { kind: 'consumed', reason: 'bug-channel-post-reported-by-message-event' };
    }
    if (!slackReportBugGestureEnabled(config, channelId, 'mention') || !slackMentionHasBugIntent(message)) return null;
    // In a thread, "@Papercusp bug" reports the message the thread is about.
    const targetTs = topLevel ? ts : threadTs!;
    return {
      kind: 'signal',
      event: reportBugSignal({
        externalId: eventId, gesture: 'mention', channelId, ts: targetTs, threadTs: topLevel ? null : threadTs,
        reporterUserId: user, text: message, occurredAt: occurredAtOf(event.event_ts ?? ts),
        ...(topLevel ? { subjectText: message } : {}),
      }),
    };
  }

  if (type === 'message') {
    const channelType = text(event.channel_type);
    const isIm = channelType === 'im' || channelType === 'mpim' || channelId.startsWith('D');
    if (isIm || !topLevel || !message) return null;
    if (!slackReportBugGestureEnabled(config, channelId, 'bug-channel')) return null;
    return {
      kind: 'signal',
      event: reportBugSignal({
        externalId: eventId, gesture: 'bug-channel', channelId, ts, threadTs: null, reporterUserId: user,
        text: message, occurredAt: occurredAtOf(ts), subjectText: message,
      }),
    };
  }
  return null;
}

function classifyInteractive(payload: Record<string, unknown>, config: SlackReportBugConfig): SlackReportBugClassification {
  const type = text(payload.type);
  const user = text(record(payload.user)?.id);

  if (type === 'message_action' && text(payload.callback_id) === SLACK_REPORT_BUG_SHORTCUT_CALLBACK_ID) {
    const channelId = text(record(payload.channel)?.id) || null;
    const message = record(payload.message);
    const messageTs = slackTs(message?.ts);
    const triggerId = text(payload.trigger_id);
    if (!channelId || !messageTs || !triggerId || !user) return null;
    if (!slackReportBugGestureEnabled(config, channelId, 'shortcut')) {
      return { kind: 'consumed', reason: 'shortcut-off-in-channel' };
    }
    const threadTs = slackTs(message?.thread_ts);
    return {
      kind: 'open-modal',
      request: { triggerId, channelId, messageTs, threadTs: threadTs && threadTs !== messageTs ? threadTs : null, reporterUserId: user },
    };
  }

  if (type === 'view_submission') {
    const view = record(payload.view);
    if (!view || text(view.callback_id) !== SLACK_REPORT_BUG_MODAL_CALLBACK_ID) return null;
    const viewId = text(view.id);
    let meta: Record<string, unknown> | null = null;
    try { meta = record(JSON.parse(text(view.private_metadata))); } catch { meta = null; }
    const channelId = text(meta?.channelId) || null;
    const messageTs = slackTs(meta?.messageTs);
    if (!viewId || !user || !channelId || !messageTs) return null;
    // The rule is re-checked at submit: a channel switched off while the form was open files nothing.
    if (!slackReportBugGestureEnabled(config, channelId, 'shortcut')) {
      return { kind: 'consumed', reason: 'shortcut-off-in-channel' };
    }
    const values = record(record(view.state)?.values) ?? {};
    const note = text(record(record(values.note)?.note)?.value).trim();
    const selected = record(record(values.consent)?.consent)?.selected_options;
    const attachmentConsent = Array.isArray(selected)
      && selected.some((option) => text(record(option)?.value) === SLACK_REPORT_BUG_ATTACHMENT_CONSENT);
    return {
      kind: 'signal',
      event: reportBugSignal({
        externalId: `view:${viewId}`, gesture: 'shortcut', channelId, ts: messageTs, threadTs: slackTs(meta?.threadTs),
        reporterUserId: user, text: note, occurredAt: null, note: note || undefined, attachmentConsent,
      }),
    };
  }
  return null;
}

/**
 * Classify one Socket Mode envelope for bug reporting. `null` means "not a report-bug
 * gesture": the caller falls back to the ordinary trigger normalization.
 */
export function classifySlackReportBugEnvelope(
  envelope: SlackSocketEnvelope,
  config: SlackReportBugConfig,
): SlackReportBugClassification {
  const payload = envelope.payload ?? {};
  if (envelope.type === 'events_api') return classifyEvent(payload, config);
  if (envelope.type === 'interactive') return classifyInteractive(payload, config);
  return null;
}

/** The Block Kit modal the "Report a bug" shortcut opens. */
export function slackReportBugModalView(request: SlackReportModalRequest): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: SLACK_REPORT_BUG_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({
      channelId: request.channelId,
      messageTs: request.messageTs,
      ...(request.threadTs ? { threadTs: request.threadTs } : {}),
    }),
    title: { type: 'plain_text', text: 'Report a bug' },
    submit: { type: 'plain_text', text: 'Report' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'note',
        optional: true,
        label: { type: 'plain_text', text: 'Anything to add?' },
        element: { type: 'plain_text_input', action_id: 'note', multiline: true, max_length: 2000 },
      },
      {
        type: 'input',
        block_id: 'consent',
        optional: true,
        label: { type: 'plain_text', text: 'Attachments' },
        element: {
          type: 'checkboxes',
          action_id: 'consent',
          options: [{
            text: { type: 'plain_text', text: 'Include screenshots and files from this message and its thread' },
            value: SLACK_REPORT_BUG_ATTACHMENT_CONSENT,
          }],
        },
      },
    ],
  };
}
