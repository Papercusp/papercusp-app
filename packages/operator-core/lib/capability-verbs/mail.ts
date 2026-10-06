/**
 * Provider-neutral mail capability seam (D-019 Tier 1, plan item P-029).
 *
 * The verbs are `mail:*`, never `gmail:*` — the provider is a property of the
 * connected source. Since P-007 (plan generalized-integrations-google-migration-
 * cupboard-workflows-2026-10-05, D-014) every verb selects its source through
 * `provider-dispatch.ts` and calls the registered provider that owns it, with
 * the `mail.draft` / `mail.send` capabilities. The rails below run first, in the
 * host, identically for every provider. Gmail is one such registered provider
 * (P-008, `libs/papercusp/plugins/gmail`); the host holds no Gmail code of its own.
 *
 * Threading, MIME encoding and header propagation live BELOW this seam, in the
 * adapter. That is deliberate: correct reply threading needs the thread id on
 * the request AND In-Reply-To/References in the body, and getting it wrong
 * sends successfully while silently breaking the thread. No agent should be
 * asked to hold that knowledge, and no agent is given the chance to.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type postgres from 'postgres';
import { assertDisclosurePermits } from '../personal-vault/disclosure-ledger';
import { assertTrustedAddressees, type AddresseeDecision, type AddresseeProvenance } from './addressing';
import {
  assertDeliverableAddressees,
  type DeliverabilityReport,
  type MailboxProbe,
} from './deliverability';
import {
  invokeOutboundProvider,
  OUTBOUND_CAPABILITIES,
  resolveCapabilitySource,
  resultString,
  resultStrings,
  type OutboundDispatchDeps,
  type OutboundTarget,
} from './provider-dispatch';
import { CANONICAL_SOURCE_BY_DATATYPE, resolveCanonicalDocument, string, type CanonicalDocument } from './resolve';

export interface MailReplyCoordinates {
  to: string;
  subject: string;
  threadId: string;
  inReplyTo: string;
  references: string | null;
}

export interface MailReplyResult {
  mode: 'draft' | 'send';
  /** Echoed so the caller can report WHERE it went — it never chose. */
  to: string;
  subject: string;
  threadId: string;
  messageId: string;
  draftId?: string;
}

export interface MailSendResult {
  mode: 'send';
  recipients: AddresseeDecision[];
  subject: string;
  threadId: string;
  messageId: string;
  /**
   * What the recipients' own servers said before we sent. Worth reading even on
   * success: a `catch-all` verdict means the domain accepts every address, so
   * acceptance proved nothing and this send may still bounce.
   */
  deliverability: DeliverabilityReport[];
}

export interface MailDraftResult {
  mode: 'draft';
  recipients: AddresseeDecision[];
  subject: string;
  threadId: string;
  messageId: string;
  draftId: string;
  /** See `MailSendResult.deliverability`. */
  deliverability: DeliverabilityReport[];
}

export interface MailSendDraftResult {
  mode: 'send';
  /** Rail decisions for the addresses the draft ACTUALLY carried at send time. */
  recipients: AddresseeDecision[];
  draftId: string;
  threadId: string;
  messageId: string;
  /**
   * What Gmail held and therefore what SHIPPED — echoed so the caller records
   * the addresses the message went to, never the ones it hoped it would.
   */
  sentTo: string[];
  sentCc: string[];
  subject: string | null;
  /** See `MailSendResult.deliverability`. */
  deliverability: DeliverabilityReport[];
}

/** A declared attachment as read from disk, before it is handed to a provider. */
export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * `Re:`-prefix a subject exactly once. The reply subject is derived here, from
 * the stored document, so it is part of rail 1 rather than a provider choice.
 */
export function replySubjectFor(subject: string): string {
  const normalized = String(subject ?? '').trim();
  return /^re\s*:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

/**
 * Injectable seams. `registry` / `hostFetchFor` / `hostFetchImpl` reach the
 * registered provider that owns the selected source.
 */
export type MailDeps = OutboundDispatchDeps & {
  /** Injected so attachment handling is testable without touching the disk. */
  readAttachment?: (path: string) => Promise<Buffer>;
  /**
   * Injected so the deliverability rail is testable without opening an SMTP
   * connection — and so a caller with a better source of truth (a warmed cache,
   * a provider-side validation API) can supply it instead.
   */
  probeMailbox?: MailboxProbe;
};

/** Extension → MIME. Unknown stays octet-stream rather than guessing wrong. */
const MAIL_ATTACHMENT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Read every declared attachment, or throw naming the one that failed.
 *
 * Deliberately all-or-nothing: a draft that silently drops a file the caller's
 * own record says it carries is worse than no draft, because the omission is
 * invisible in the mail client until the recipient asks where the resume is.
 */
async function readMailAttachments(
  declared: readonly { path: string }[] | undefined,
  deps: MailDeps,
): Promise<MailAttachment[]> {
  if (!declared?.length) return [];
  const read = deps.readAttachment ?? (async (path: string) => readFile(path));
  const out: MailAttachment[] = [];
  for (const entry of declared) {
    const path = String(entry?.path ?? '').trim();
    if (!path) throw new Error('mail_attachment_path_required');
    let content: Buffer;
    try {
      content = await read(path);
    } catch (cause) {
      throw new Error(`mail_attachment_unreadable:${basename(path)}`, { cause });
    }
    if (!content?.length) throw new Error(`mail_attachment_empty:${basename(path)}`);
    const filename = basename(path);
    out.push({
      filename,
      contentType: MAIL_ATTACHMENT_CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream',
      content,
    });
  }
  return out;
}

/** Attachments as a provider receives them: base64 content, no host buffers. */
function providerAttachments(attachments: readonly MailAttachment[]) {
  return attachments.map((entry) => ({
    filename: entry.filename,
    contentType: entry.contentType,
    contentBase64: entry.content.toString('base64'),
  }));
}

/** Recipient lists as cleared by the addressee rail (its canonical address, else the trimmed input). */
function clearedAddresses(values: readonly string[], recipients: readonly AddresseeDecision[]): string[] {
  const cleared = new Map(recipients.map((decision) => [decision.address, decision]));
  return values.map((value) => cleared.get(value.trim().toLowerCase())?.address ?? value.trim());
}

/**
 * D-020 rail 1: derive every reply coordinate from the STORED document.
 *
 * Pure, and exported so the rail is directly testable — the security property
 * is "these values come from the document, never from a caller argument", and
 * a function whose only inputs are the document makes that checkable rather
 * than merely asserted.
 */
export function resolveMailReplyCoordinates(doc: CanonicalDocument): MailReplyCoordinates {
  // A datatype check, never a provider one (D-014.3). Legacy rows predate the
  // datatype stamp; their Vault category is then the only evidence.
  const datatype =
    doc.datatypeId ?? (doc.source === CANONICAL_SOURCE_BY_DATATYPE['email-message'] ? 'email-message' : null);
  if (datatype !== 'email-message') {
    throw new Error(`mail_reply_datatype_unsupported:${doc.datatypeId ?? doc.source}`);
  }
  const payload = doc.payload;
  const direction = string(payload.direction);
  if (direction && direction !== 'inbound') {
    throw new Error('mail_reply_not_inbound: replying to a message you sent would address yourself — reply to the inbound message in this thread instead');
  }
  const to = string(payload.from);
  const threadId = string(payload.threadId);
  const inReplyTo = string(payload.messageId);
  const subject = replySubjectFor(string(payload.subject));
  if (!to || !threadId || !inReplyTo) throw new Error('mail_reply_coordinates_missing');
  return { to, subject, threadId, inReplyTo, references: string(payload.references) || null };
}

/**
 * `mail:reply` — the caller supplies text plus canonical message coordinates
 * minted by the server. Recipient, subject, thread, headers, and credential
 * remain server-resolved.
 *
 * `mode:'send'` is permitted per D-020 (owner-asked sends execute; draft-only
 * is not the posture). It is still safe under rail 1 because the destination
 * was never the caller's to choose.
 */
export async function replyToCanonicalMail(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    messageId: string;
    sourceId?: string | null;
    text: string;
    mode?: 'draft' | 'send';
    /** See `sendNewMail`. Checked only for `mode:'send'`: a draft is not a sink. */
    agentOwnerId: string | null;
  },
  deps: MailDeps = {},
): Promise<MailReplyResult> {
  const text = params.text.trim();
  if (!text || text.length > 100_000) throw new Error('mail_reply_text_invalid');
  const mode = params.mode ?? 'draft';

  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    source: CANONICAL_SOURCE_BY_DATATYPE['email-message'],
    externalId: params.messageId,
    sourceId: params.sourceId,
  });
  const coordinates = resolveMailReplyCoordinates(doc);
  if (mode === 'send') {
    await assertDisclosurePermits(sql, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      agentOwnerId: params.agentOwnerId,
      recipients: [coordinates.to],
      sink: 'mail:reply',
    });
  }
  // The reply goes out through the source that holds the message, so it is
  // sent AS the account the message was received on.
  const capability = mode === 'send' ? OUTBOUND_CAPABILITIES.mailSend : OUTBOUND_CAPABILITIES.mailDraft;
  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: 'email-message',
      capabilities: [capability],
      sourceId: doc.sourceId,
    },
    deps,
  );

  const result = await invokeOutboundProvider(
    sql,
    target,
    capability,
    {
      operation: mode === 'send' ? 'message' : 'create',
      to: [coordinates.to],
      subject: coordinates.subject,
      text,
      threadId: coordinates.threadId,
      inReplyTo: coordinates.inReplyTo,
      references: coordinates.references,
    },
    deps,
  );
  return {
    mode,
    to: coordinates.to,
    subject: coordinates.subject,
    threadId: resultString(result, 'threadId', target, capability, false) || coordinates.threadId,
    messageId: resultString(result, 'messageId', target, capability, mode === 'send'),
    ...(mode === 'draft' ? { draftId: resultString(result, 'draftId', target, capability) } : {}),
  };
}

export interface MailRunReplyResult extends MailReplyResult {
  planRunId: number;
  /** True only when THIS call produced the reply. */
  created: boolean;
  /** The run already replied; the stored result is returned and nothing is re-sent. */
  alreadyCreated: boolean;
}

interface TriggerRunReplyRow {
  id: string;
  args: unknown;
  outcome: unknown;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Whether a TRIGGERED plan run may send mail rather than draft it. A run that
 * an inbound email launched acts with no human in the loop, so its send is
 * automatic sending: owner-authority flag papercusp-gmail-auto-send (default
 * OFF). The retired gmail:create-draft had no send branch at all; this keeps
 * that property for every mail provider now that the reply verb can send.
 */
async function triggeredRunSendEnabled(workspaceId: string): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.GMAIL_AUTO_SEND, `mail-run-reply:${workspaceId}`);
}

/**
 * `mail:reply { planRunId }` — reply to the message that LAUNCHED a triggered
 * plan run (plan generalized-integrations-…-2026-10-05 D-019.1).
 *
 * The run anchors the target: the message coordinates come from the run's
 * stored trigger envelope (`trigger_runs.args.trigger.{externalId, sourceId}`),
 * never from the caller, so a triggered plan can only answer the message that
 * started it. Everything after that is `replyToCanonicalMail`, rails included.
 * The result is recorded on the trigger run under `outcome.mailReply`, so a
 * retried step returns the first reply instead of drafting or sending twice.
 * `mode:'send'` is refused while automatic sending is off (see
 * `triggeredRunSendEnabled`); the refusal happens before any read or write.
 */
export async function replyToTriggerPlanRun(
  sql: postgres.Sql | postgres.TransactionSql,
  params: {
    workspaceId: string;
    userId: string;
    planRunId: number;
    text: string;
    mode?: 'draft' | 'send';
    agentOwnerId: string | null;
  },
  deps: MailDeps & { now?: () => Date; runSendEnabled?: (workspaceId: string) => Promise<boolean> } = {},
): Promise<MailRunReplyResult> {
  const planRunId = params.planRunId;
  if (!Number.isSafeInteger(planRunId) || planRunId <= 0) throw new Error('mail_reply_plan_run_id_invalid');
  if (params.mode === 'send' && !(await (deps.runSendEnabled ?? triggeredRunSendEnabled)(params.workspaceId))) {
    throw new Error(
      'mail_reply_run_send_withheld: a triggered plan run may only draft its reply. Automatic sending is an owner-authority action (flag papercusp-gmail-auto-send, default OFF); omit mode to create a draft for a person to review and send.',
    );
  }
  const replyInTransaction = async (tx: postgres.TransactionSql | postgres.Sql): Promise<MailRunReplyResult> => {
    const rows = await tx<TriggerRunReplyRow[]>`
      SELECT tr.id::text, tr.args, tr.outcome
        FROM harness_shared.trigger_runs tr
       WHERE tr.workspace_id = ${params.workspaceId}
         AND tr.plan_run_ref = ${String(planRunId)}
         AND tr.status = 'succeeded'
       ORDER BY tr.completed_at DESC NULLS LAST, tr.id
       LIMIT 1
       FOR UPDATE OF tr`;
    const row = rows[0];
    if (!row) throw new Error(`mail_reply_trigger_run_not_found:${planRunId}`);
    const outcome = recordOf(row.outcome);
    const prior = recordOf(outcome.mailReply);
    if (string(prior.to)) {
      const priorMode = prior.mode === 'send' ? 'send' : 'draft';
      return {
        planRunId,
        created: false,
        alreadyCreated: true,
        mode: priorMode,
        to: string(prior.to),
        subject: string(prior.subject),
        threadId: string(prior.threadId),
        messageId: string(prior.messageId),
        ...(string(prior.draftId) ? { draftId: string(prior.draftId) } : {}),
      };
    }
    const trigger = recordOf(recordOf(row.args).trigger);
    const datatype = string(trigger.datatypeId);
    if (datatype !== 'email-message') {
      throw new Error(`mail_reply_run_not_email:${datatype || 'unknown'} — this run was not started by an email`);
    }
    const messageId = string(trigger.externalId);
    if (!messageId) throw new Error('mail_reply_trigger_coordinates_missing');
    const reply = await replyToCanonicalMail(
      tx as unknown as postgres.Sql,
      {
        workspaceId: params.workspaceId,
        userId: params.userId,
        messageId,
        sourceId: string(trigger.sourceId) || null,
        text: params.text,
        mode: params.mode,
        agentOwnerId: params.agentOwnerId,
      },
      deps,
    );
    const repliedAt = (deps.now ?? (() => new Date()))().toISOString();
    await tx`
      UPDATE harness_shared.trigger_runs
         SET outcome = ${JSON.stringify({ ...outcome, mailReply: { ...reply, repliedAt } })}::text::jsonb,
             updated_at = now()
       WHERE workspace_id = ${params.workspaceId} AND id = ${row.id}::uuid`;
    return { planRunId, created: true, alreadyCreated: false, ...reply };
  };
  return 'begin' in sql
    ? (sql as postgres.Sql).begin((tx) => replyInTransaction(tx)) as Promise<MailRunReplyResult>
    : replyInTransaction(sql);
}

/**
 * `mail:send` — create-shaped, so the addressee IS caller-supplied and D-020
 * rail 2 applies. Every recipient is classified and refused if it carries the
 * injection signature; the cleared decisions are returned so the caller can
 * echo WHO it actually addressed.
 */
export async function sendNewMail(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    to: readonly string[];
    cc?: readonly string[];
    subject: string;
    text: string;
    provenance: AddresseeProvenance;
    /**
     * Which connected account to send AS; required once more than one is
     * connected. Identical contract to `sendMailDraft`'s `from`, deliberately —
     * and for the same reason the `attachments` note below records.
     *
     * Until this existed, `sendNewMail` called `resolveOutboundContext` with no
     * account selector at all, so the resolver's own ambiguity guard made the
     * verb UNUSABLE the moment a second Google source was connected: every send
     * threw `outbound_source_ambiguous:gmail`, for every caller, with no
     * argument any caller could pass to resolve it. `mail:send-draft` and
     * `mail:reply` were unaffected — the first takes `from`, the second infers
     * the account from the document it replies to — which is what made this
     * look like a Gmail/credential outage rather than one missing parameter.
     */
    from?: string | null;
    /** The connected source to send through; narrows `from` when both are given. */
    sourceId?: string | null;
    /**
     * Local files to attach, by absolute path — read here rather than by the
     * caller, so the message either carries every declared file or fails
     * loudly. Identical contract to `draftNewMail`'s, deliberately: until
     * WI-10001671 this parameter existed ONLY on the draft, so the two verbs
     * disagreed about whether attaching was possible at all even though both
     * funnelled into the same Gmail MIME encoder, which had
     * emitted `multipart/mixed` for either one since it was written.
     *
     * That asymmetry is invisible from the tool description and cost a real
     * mistake: 20 job applications were nearly sent through `mail:send`, which
     * would have silently dropped the resume the whole task was about. A
     * capability the transport already has, withheld by one signature, reads
     * to a caller as a capability the system lacks.
     */
    attachments?: readonly { path: string }[];
    /**
     * Send even to a recipient whose own server has already stated the mailbox
     * does not exist. Off by default: the send would bounce, and our transport
     * cannot report that bounce on this call.
     */
    allowUndeliverable?: boolean;
    /**
     * The calling agent's identity, whose Personal Vault disclosures bound who it
     * may send to (reader-set labels). Required so no caller can forget it; null
     * only for a caller with no attributable identity, from which restricted
     * content is withheld at delivery.
     */
    agentOwnerId: string | null;
  },
  deps: MailDeps = {},
): Promise<MailSendResult> {
  const subject = params.subject.trim();
  const text = params.text.trim();
  if (!subject) throw new Error('mail_send_subject_required');
  if (!text || text.length > 100_000) throw new Error('mail_send_text_invalid');

  // Read BEFORE the addressee rail and before any token work: an unreadable or
  // empty file must fail while the message is still un-sent, never after the
  // recipients have been cleared and a send is one call away.
  const attachments = await readMailAttachments(params.attachments, deps);

  const recipients = await assertTrustedAddressees(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    addresses: [...params.to, ...(params.cc ?? [])],
    provenance: params.provenance,
  });

  // After the trust rail, so an injected addressee is named as THAT; before the
  // deliverability probe, which would otherwise contact a recipient we refuse.
  await assertDisclosurePermits(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    recipients: recipients.map((decision) => decision.address),
    sink: 'mail:send',
  });

  // AFTER the trust rail, deliberately. The probe opens an outbound connection
  // to a host the recipient's domain controls, so probing an unvalidated address
  // would turn an addressee injected by a hostile inbound message into a beacon
  // confirming we process injections. Trust first, then deliverability.
  const deliverability = await assertDeliverableAddressees(
    recipients.map((decision) => decision.address),
    { probe: deps.probeMailbox, allowUndeliverable: params.allowUndeliverable },
  );

  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: 'email-message',
      capabilities: [OUTBOUND_CAPABILITIES.mailSend],
      sourceId: params.sourceId,
      providerAccountId: params.from,
    },
    deps,
  );
  const capability = OUTBOUND_CAPABILITIES.mailSend;
  const result = await invokeOutboundProvider(
    sql,
    target,
    capability,
    {
      operation: 'message',
      to: clearedAddresses(params.to, recipients),
      cc: clearedAddresses(params.cc ?? [], recipients),
      subject,
      text,
      attachments: providerAttachments(attachments),
    },
    deps,
  );
  return {
    mode: 'send',
    recipients,
    subject,
    threadId: resultString(result, 'threadId', target, capability, false),
    messageId: resultString(result, 'messageId', target, capability),
    deliverability,
  };
}

/** Set-compare two address lists, order- and duplicate-insensitive. */
function sameAddressSet(left: readonly string[], right: readonly string[]): boolean {
  const norm = (list: readonly string[]) =>
    new Set(list.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const a = norm(left);
  const b = norm(right);
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * `mail:send-draft` — send a draft that ALREADY EXISTS, by id, without
 * re-encoding it.
 *
 * This is the verb for outbound a human has already read. The draft was
 * composed, reviewed in the owner's own client, and approved; sending it via
 * `drafts/send` ships the exact bytes that were reviewed, where re-composing
 * the same content through `mail:send` would ship a NEW message that merely
 * resembles what was approved. For a reviewed send, "resembles" is not the
 * contract.
 *
 * ── Why this verb re-runs the addressee rail even though `mail:draft` ran it ──
 *
 * `drafts/send` sends WHAT GMAIL HOLDS. A draft is mutable for its whole life:
 * the owner edits it in Gmail, another process with the token can rewrite it,
 * and a draft created hours ago has had all that time to change. So the D-020
 * clearance performed at DRAFT time judged bytes that may no longer exist —
 * it is evidence about the past, and the send is a fact about the present.
 *
 * Hence two distinct checks, on the LIVE recipients, at send time:
 *
 *  1. THE RAIL (safety) — `assertTrustedAddressees` against the addresses the
 *     draft actually carries now. Catches a draft re-addressed to a recipient
 *     carrying the injection signature.
 *  2. THE MATCH (intent) — the live recipients must equal the ones the caller
 *     declared it is sending to. Catches the case the rail cannot: a draft
 *     re-addressed to a perfectly trustworthy address that simply is not the
 *     one the caller approved. A trusted recipient is not automatically the
 *     INTENDED recipient, and a send is irreversible.
 *
 * The rail runs first so that when a draft has been re-addressed to a hostile
 * recipient the caller is told THAT, rather than the blander mismatch that is
 * also true.
 */
export async function sendMailDraft(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    /** The Gmail draft to send. Its bytes are shipped as-is, never re-encoded. */
    draftId: string;
    /**
     * Who the caller believes this draft is addressed to. NOT used to address
     * the message — the draft already carries its own recipients — but checked
     * against them, so a draft that changed under the caller refuses instead of
     * sending somewhere unapproved.
     */
    expectedTo: readonly string[];
    expectedCc?: readonly string[];
    provenance: AddresseeProvenance;
    /** Which connected account holds the draft; required once more than one is. */
    from?: string | null;
    /** The connected source holding the draft; narrows `from` when both are given. */
    sourceId?: string | null;
    /**
     * Send even to a recipient whose own server has already stated the mailbox
     * does not exist. Off by default. See `sendNewMail`.
     */
    allowUndeliverable?: boolean;
    /** See `sendNewMail`. Checked against the LIVE recipients, like the rail. */
    agentOwnerId: string | null;
  },
  deps: MailDeps = {},
): Promise<MailSendDraftResult> {
  const draftId = params.draftId?.trim();
  if (!draftId) throw new Error('mail_send_draft_id_required');
  if (!params.expectedTo?.length) throw new Error('mail_send_draft_expected_to_required');

  // Both capabilities up front: reading the live draft (for the rail) and
  // sending it. A provider that can only do one refuses before either call.
  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: 'email-message',
      capabilities: [OUTBOUND_CAPABILITIES.mailDraft, OUTBOUND_CAPABILITIES.mailSend],
      sourceId: params.sourceId,
      providerAccountId: params.from,
    },
    deps,
  );
  const read = await invokeOutboundProvider(
    sql,
    target,
    OUTBOUND_CAPABILITIES.mailDraft,
    { operation: 'read', draftId },
    deps,
  );
  const live = {
    to: resultStrings(read, 'to'),
    cc: resultStrings(read, 'cc'),
    subject: resultString(read, 'subject', target, OUTBOUND_CAPABILITIES.mailDraft, false) || null,
  };
  // A draft addressed to nobody cannot be sent to the right person by accident,
  // but it can be sent — the provider decides. Refuse here so the failure names the
  // cause instead of arriving as a provider error after the attempt.
  if (!live.to.length) throw new Error('mail_send_draft_no_recipients');

  const recipients = await assertTrustedAddressees(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    addresses: [...live.to, ...live.cc],
    provenance: params.provenance,
  });

  // The draft itself was not a sink; sending it is.
  await assertDisclosurePermits(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    recipients: recipients.map((decision) => decision.address),
    sink: 'mail:send-draft',
  });

  if (
    !sameAddressSet(live.to, params.expectedTo) ||
    !sameAddressSet(live.cc, params.expectedCc ?? [])
  ) {
    // Name both sides: the caller's next move is deciding whether the draft was
    // legitimately edited or tampered with, and it cannot decide that from the
    // fact of a mismatch alone.
    throw new Error(
      `mail_send_draft_recipients_changed:expected=${[...params.expectedTo, ...(params.expectedCc ?? [])]
        .map((value) => value.trim().toLowerCase())
        .sort()
        .join('|')}:actual=${[...live.to, ...live.cc].sort().join('|')}`,
    );
  }

  // Third, and last: deliverability. It runs AFTER the mismatch check by the
  // same reasoning that puts the rail first — when a draft has been re-addressed,
  // the caller must be told THAT, not the blander fact that the address it was
  // re-pointed at happens to be undeliverable. It probes the LIVE recipients,
  // for the same reason the rail does: the draft is what Gmail holds now.
  const deliverability = await assertDeliverableAddressees(
    recipients.map((decision) => decision.address),
    { probe: deps.probeMailbox, allowUndeliverable: params.allowUndeliverable },
  );

  const capability = OUTBOUND_CAPABILITIES.mailSend;
  const result = await invokeOutboundProvider(sql, target, capability, { operation: 'draft', draftId }, deps);
  return {
    mode: 'send',
    recipients,
    draftId,
    threadId: resultString(result, 'threadId', target, capability, false),
    messageId: resultString(result, 'messageId', target, capability),
    sentTo: live.to,
    sentCc: live.cc,
    subject: live.subject,
    deliverability,
  };
}

/**
 * `mail:draft` — the draft twin of `sendNewMail`, create-shaped and outside any
 * existing thread.
 *
 * It runs D-020 rail 2 in full, exactly as the send does. A draft is not a send,
 * but it is still the agent CHOOSING an addressee, and the address is what the
 * rail judges: a draft addressed to an injected recipient is one careless click
 * away from being a send to one, and it arrives wearing the owner's own
 * compose window. Relaxing the rail here because "nothing leaves yet" would
 * put the weakest check on the surface the owner trusts most.
 *
 * What the draft shape genuinely changes is WHO decides to send. The message
 * lands in the owner's mailbox and goes nowhere until they press send, so this
 * is the verb for outbound the owner wants to read first — review happens in
 * their own client, on their own schedule, with the draft editable in place.
 */
export async function draftNewMail(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    to: readonly string[];
    cc?: readonly string[];
    subject: string;
    text: string;
    provenance: AddresseeProvenance;
    /** Which connected account to draft in; required once more than one is. */
    from?: string | null;
    /** The connected source to draft in; narrows `from` when both are given. */
    sourceId?: string | null;
    /**
     * Local files to attach, by absolute path. Read here rather than by the
     * caller so the draft either carries every declared file or fails loudly —
     * a record that DECLARES an attachment the message never carried is the
     * failure this exists to prevent.
     */
    attachments?: readonly { path: string }[];
    /**
     * REVISE an existing draft in place instead of creating a new one (WI-10001658).
     * Same rails, same encoder, one call site apart: everything above — addressee
     * clearance, attachment reading, account resolution, token — is identical for
     * both, so they branch only at the final Gmail call rather than living in two
     * functions whose rails can drift.
     *
     * Without this the only implementation of "revise a draft" is delete the draft
     * and create a replacement, which destroys the draft id and anything the owner
     * has since typed into it — data loss to perform what the API models as an edit.
     */
    draftId?: string | null;
    /**
     * Draft even for a recipient whose own server has already stated the mailbox
     * does not exist. Off by default — catching it here is the point: a draft is
     * composed for review, and putting a known-dead address in front of a
     * reviewer spends their attention on a message that can never arrive.
     */
    allowUndeliverable?: boolean;
  },
  deps: MailDeps = {},
): Promise<MailDraftResult> {
  const subject = params.subject.trim();
  const text = params.text.trim();
  if (!subject) throw new Error('mail_draft_subject_required');
  if (!text || text.length > 100_000) throw new Error('mail_draft_text_invalid');

  const attachments = await readMailAttachments(params.attachments, deps);

  const recipients = await assertTrustedAddressees(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    addresses: [...params.to, ...(params.cc ?? [])],
    provenance: params.provenance,
  });

  // After the trust rail — see the note in `sendNewMail`. Running it at DRAFT
  // time is deliberate: a dead address caught here never reaches the reviewer.
  const deliverability = await assertDeliverableAddressees(
    recipients.map((decision) => decision.address),
    { probe: deps.probeMailbox, allowUndeliverable: params.allowUndeliverable },
  );

  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: 'email-message',
      capabilities: [OUTBOUND_CAPABILITIES.mailDraft],
      sourceId: params.sourceId,
      providerAccountId: params.from,
    },
    deps,
  );
  const reviseId = params.draftId?.trim();
  const capability = OUTBOUND_CAPABILITIES.mailDraft;
  const result = await invokeOutboundProvider(
    sql,
    target,
    capability,
    {
      operation: reviseId ? 'update' : 'create',
      ...(reviseId ? { draftId: reviseId } : {}),
      to: clearedAddresses(params.to, recipients),
      cc: clearedAddresses(params.cc ?? [], recipients),
      subject,
      text,
      attachments: providerAttachments(attachments),
    },
    deps,
  );
  return {
    mode: 'draft',
    recipients,
    subject,
    threadId: resultString(result, 'threadId', target, capability, false),
    messageId: resultString(result, 'messageId', target, capability, false),
    draftId: resultString(result, 'draftId', target, capability),
    deliverability,
  };
}
