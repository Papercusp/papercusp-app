/**
 * coord:send — send a typed message (or coord broadcast) to one or
 * more other agents. agent-coordination-architecture-v2 §6.4 (#6).
 *
 * Persists to the `messages` surface of the CoordEventLog (the operator
 * backs it with Postgres — harness_shared.coord_event_log). Recipients
 * see it via coord:inbox.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): the SINGLE form
 * { to, summary, … } sends ONE message (its `to` is a multi-RECIPIENT list — one
 * message to many addressees, unchanged). The NEW `items:[{ to, summary, … }]`
 * axis sends N DISTINCT messages in one call. Both return the house envelope
 * { ok, results:[{ ok, to, msg_id? … | error }], counts } — each result
 * self-describes its `to` (+ returned msg_id); one failed message never fails the
 * rest. When any message fails, this tool also adds `partial:true` and a
 * `deliveryFailureWarning` so the shared bulk envelope's execution-level `ok:true`
 * cannot be mistaken for successful delivery. All routing/recipient-resolve/wake/
 * endTurn logic runs PER message.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { parseReportBlock, type ReportBlock } from '@papercusp/chat-protocol';
import type { CoordEnvelope } from '@papercusp/coordination';
import {
  resolveAgentIdentity,
  deriveFleetMembership,
  ADMIN_COORD_UI_OWNER,
  type AgentIdentity,
} from '../identity';
import { ownerChatWakePayloadFields } from '../owner-chat-turn';
import {
  classifyUnknownRecipients,
  lookupEndedSessions,
  roleAddressingGuidance,
} from '../dead-session-recipient-guidance';
import { fetchPresenceFleet, resolvePresenceFleet } from '../presence-fleet';
import { scopeBroadcastAudience, ALLHIVE_BROADCAST_FIELD } from '../scope-broadcast';
import { resolveSenderCueAuthority } from '../cue-authority-resolve';
import { getConversation } from '../conversations';
import {
  CUE_AUTHORITY_FIELD,
  readExpectedLifecycleAck,
  type CueAuthorityStamp,
} from '../cue-authority';
import {
  RELAY_PROVENANCE_FIELD,
  UNVERIFIED_CLAIM_TAG,
  unverifiedAuthorityClaim,
  type RelayProvenanceStamp,
} from '../relay-provenance';
import { resolveRelayProvenance } from '../relay-provenance-resolve';
import {
  BODY_REFS_OPT_OUT_FIELD,
  detectEntryBodyRefs,
  GATE_REFS_FIELD,
} from '../ref-hydrate';
import { resolveGateRefStamps } from '../ref-hydrate-resolve';
import {
  resolveCouplingDivergenceStamps,
  COUPLING_DIVERGENCE_FIELD,
} from '../coupling-divergence-stamp';
import { resolveStaleQuoteStamps, STALE_QUOTE_FIELD } from '../stale-quote-stamp';
import { staleBasis, STALE_BASIS_FIELD } from '../stale-basis';
// TYPE ONLY — erased at compile time, so it creates no runtime edge. A VALUE
// import of this module would be a load-time hazard here: `coord/couplings`
// (which `derived-signal-census` imports for DERIVED_COUPLING_RELATIONS) statically
// imports `@papercusp/db-org`, so a static value import would drag a store into the
// send path's module graph — the exact class EI-19281789650149592 records ("one
// static store import here red a 95-test suite") and what coupling-divergence-stamp's
// own import contract forbids. `censusObserverFor` is imported DYNAMICALLY below.
import type { DerivedSignalCensus } from '../../../coord/derived-signal-census';
import { resolvePremiseStamps, PREMISE_STAMPS_FIELD } from '../premise-resolve';
// The FACTORY only — `premise-probes` holds every store import inside the probe
// bodies (dynamic), so this adds nothing to the send path's module graph. See
// EI-19281789650149592: one static store import here red a 95-test suite.
import { premiseProbes } from '../premise-probes';
import {
  sendMessage,
  getMessageById,
  resolveMessageRef,
  getUnresolvedAudienceSelectors,
  getUnreachableAudienceSelectors,
} from '../messages';
import { DIRECTIVE_EFFECT_KINDS, type DirectiveEffectSpec } from '../directive-effect';
import { parseSlotSelector } from '../slot-selector';
// NB `audience-host` is imported LAZILY at the one use site below, never statically:
// it reaches the PG-backed fleet roster, and a static import drags that whole graph
// into every consumer of this module (it broke three unit suites whose `../presence`
// mock is deliberately partial). A diagnostic must not widen anyone else's imports.
import type { FleetAudienceOmission } from '../audience';
import {
  EMPTY_IDLE_REPORT,
  wakeRecipients,
  reportIdleRecipients,
  buildStagedWakeNote,
  type DormantScheduledInfo,
} from '../inbox-wake';
import { describeMissedRecipients, type MissedRecipientLiveness } from '../recipient-liveness';
import { resolveRecipients, isSelectorOrWildcard, remoteSessionsByOwnerId } from '../recipient-resolve';
import { resolveWorkspaceHiveScope, resolveSharedHiveDisambiguation } from '../federation-scope';
import { COORD_REPLY_ROLES } from '../roles';
import { forceEndTurn } from '../../turn/interrupt';
import { runBulk, bulkContent, type BulkEnvelope, type BulkItemResult } from '../../_bulk';
import { cellTranscriptionHintResolvingCommits } from '../../../git-commit-resolver';
import {
  messageBodyArg,
  PREMISES_REF_OBJECT_REENCODING,
  BODY_MUST_BE_ARRAY_MESSAGE,
  blockingArg,
  whyArg,
  assertEnvelopeSectionSplit,
  stampMessageFields,
  toSections,
  sectionsToText,
  SECTION_ONLY_FIELDS,
  type MessageSection,
  type MessageWhy,
} from '../message-fields';
import { deriveBasedOn } from '../based-on';
import { deriveAwaiting, AWAITING_DERIVED_PROVENANCE } from '../derive-awaiting';
import { deriveDraftSuspension } from '../derive-draft-suspension';
import { DRAFT_SUSPENSION_FIELD, DRAFT_SUSPENSION_DERIVED_PROVENANCE } from '../draft-suspension';
import {
  completionClaimMismatch,
  COMPLETION_CLAIM_MISMATCH_FIELD,
} from '../completion-claim-mismatch';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { withBoundedTimeout } from '../../../bounded-timeout';
import {
  COORD_SEND_MAX_CHUNK_PARTS,
  DEFAULT_INBOX_BODY_CAP,
  senderBodyDeliveryDiagnostics,
} from './inbox-content-bounds';
import { chunkOverCapMessage, type ChunkPartMeta } from './send-chunking';
import { withDbCallDeadline, DEFAULT_DB_CALL_DEADLINE_MS } from '@papercusp/db-org';
import {
  GOAL_OWNER_REPORT_FIELD,
  GOAL_OWNER_REPORT_FIELDS,
  GOAL_OWNER_REPORT_HEADING_LIST,
  GOAL_OWNER_REPORT_HEADINGS,
  describeGoalOwnerReportTruthViolations,
  parseGoalOwnerReport,
  stampGoalOwnerReport,
  type GoalOwnerReportField,
  type GoalOwnerReportParseResult,
  type GoalOwnerReportStamp,
} from '../../../goal-owner-report';
import type { GoalOwnerReportTruthVerdict } from '../../../goal-owner-report-truth';

/** Settle window between an endTurn ESC and the following wake (coord-end-turn D-003): lets each recipient's
 *  CLI finish ending the dead turn + re-arm its `coord:inbox-wake:<owner>` watch before the wake fires, so
 *  the wake doesn't race the abort and land woken:0. Env-tunable. */
const ENDTURN_SETTLE_MS = Number(process.env.PAPERCUSP_ENDTURN_SETTLE_MS) || 1500;

/**
 * D-064 keeps authored section fields out of the message envelope. When a
 * caller puts one of them at the top level, the closed schema correctly
 * rejects it; the rejection must also say where the field belongs. Keep this
 * map derived from the authored field list so a newly-added section field
 * cannot regress to the bare "accepts ONLY" dead end.
 */
const sectionOnlyArgRedirects = Object.fromEntries(
  SECTION_ONLY_FIELDS.map((field) => [
    field,
    `body[].${field} — put it inside a section: body: [{ text: "...", ${field}: ... }]`,
  ]),
);

/**
 * The inject-only idle-recipient probe is diagnostic enrichment after the message
 * is durable. Keep it comfortably below the coord:send transport budget: a slow
 * roster/await/oracle read must degrade the optional report, never make a
 * successful send look like a transport timeout. This is intentionally tighter
 * than the direct-wake target budget because no-wake sends do not need to wait for
 * any delivery action.
 */
export const COORD_SEND_IDLE_REPORT_TIMEOUT_MS = 1_500;
/** Keep the post-send work-item routing advisory from coupling send latency to
 * a slow work-item store. The message is already durable when this runs. */
export const COORD_SEND_DISPATCH_ADVISORY_TIMEOUT_MS = 1_500;

/**
 * EI-21860312102671987: `sendMessage()` (the actual coord_event_log persist)
 * previously had NO deadline of its own — a bare `await`. Under client-side DB
 * pool acquire-queue saturation (the measured, documented failure mode in
 * EI-19485014132257783: "Postgres demonstrably healthy... CLIENT-side
 * acquire-queue saturation"), that await can hang far longer than ptool's own
 * 60s client timeout for this tool (PTOOL_FOREGROUND_TOOL_TIMEOUT_MS —
 * apps/operator/scripts/ptool.mjs:1185), and the CALLER gives up first: the
 * agent sees an ambiguous transport timeout while the server-side call is
 * still queued for a connection with no result ever produced — the message
 * never reaches coord_event_log and nothing tells the caller why.
 *
 * Wrapping the whole `sendMessage()` promise in `withDbCallDeadline` bounds it
 * comfortably inside that 60s client budget (45s default, ~15s margin for the
 * clean failure to propagate before ptool's own abandon fires) so a saturated
 * pool produces a FAST, LOUD, diagnosable `DbCallDeadlineError` — which
 * `describeAcquirePressure` enriches with the actual acquire-queue counters —
 * instead of an indefinite silent hang. `sendMessage` itself is a single
 * message-persist; it is not expected to legitimately run long, so racing the
 * entire promise (rather than only its acquire phase) is safe here. */
export const COORD_SEND_DB_DEADLINE_MS = DEFAULT_DB_CALL_DEADLINE_MS;

/**
 * Derive the coord message id for one idempotent coord:send item. MCP
 * idempotency keys are scoped to the caller's stable session, while coord
 * message ids are unique within a workspace, so include both the sender and
 * resolved scope before the bulk index. JSON tuple encoding keeps arbitrary
 * key text unambiguous without exposing the caller's key in the envelope.
 */
function idempotentCoordMsgId(
  identity: AgentIdentity,
  harnessSlug: string | null,
  idempotencyKey: string,
  index: number,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'coord:send',
        identity.workspaceId,
        harnessSlug,
        identity.ownerId,
        idempotencyKey,
        index,
      ]),
      'utf8',
    )
    .digest('hex');
  return `coord-send-${digest}`;
}

/** One distinct message's full arg set (the new `items` axis carries N of these). */
interface SendMsg {
  to: string[];
  summary: string;
  /** Explicit per-message harness scope (or the bulk form's item override). */
  harness?: string;
  /** P-032 / D-064, as amended by **D-104**: an ARRAY of sections carrying the
   *  four AUTHORED per-section fields. A plain string is REFUSED at the tool
   *  boundary (`messageBodyArg`) — D-064's "plain string is the n=1 case" was
   *  overturned once measured: 5,642 messages in 30h, sectioned form used ONCE.
   *  The `string` arm survives in THIS type because internal, non-agent senders
   *  (owner-message.ts's GUI wrapper, inbox-reply.ts) still hand text in and are
   *  upgraded to sections before storage — it is not a shape an agent can send.
   *  Flattened to text for `env.body` (every existing reader keeps working) with
   *  the STRUCTURE stamped alongside it. */
  body?: string | MessageSection[];
  /** ENVELOPE (D-064). Is the SENDER blocked until this is dealt with? */
  blocking?: boolean;
  /** ENVELOPE (D-011). A goal REF, never prose — the receiver queries its LIVE state. */
  why?: MessageWhy;
  /** P-033: which fields a NON-AGENT sender (the operator GUI) DERIVED rather
   *  than authored, so measurement never counts them as sender intent. */
  fieldProvenance?: Record<string, string>;
  files?: string[];
  plan_slug?: string;
  related_msg_id?: string;
  /** D-048: REQUIRED reply-expectation. `expectsReply` is derived from it, never passed. */
  expects: ExpectsKind;
  /** H2 (coord-authority-hardening P-004): relay provenance — the coord msg_id
   *  of the ORIGINAL you are relaying, or the 'owner-turn' sentinel for the
   *  human turn you are currently answering. Platform-verified at send. */
  relayOf?: string;
  /** H2 Tier 3: a verbatim snippet of the owner turn being relayed, verified
   *  against the CALLER's own transcript (hit → owner-verified(transcript-match),
   *  miss → delivered stamped `unverified`). */
  relayQuote?: string;
  /** P-006: announced-gate event keys this message declares/references. Verified
   *  against the announced-gates store at send (declared/fired/undeclared) and
   *  rendered canonically — un-clipped — at delivery; `events:await { fromMsg }`
   *  resolves them hands-free. Kills hand-typed gate-key drift. */
  gateRefs?: string[];
  /** P-008: opt OUT of receiver-side auto-hydration of WI-/EI- ids mentioned in
   *  this message's summary/body (by default the first 3 hydrate at delivery
   *  into a one-line status+title+checkpoint suffix). Stamped on the envelope;
   *  set when inline LIVE status would mislead — historical/illustrative ids,
   *  or deliberately quoted stale state. */
  noBodyRefs?: boolean;
  wake?: boolean | 'required' | 'optimistic';
  wakeOnReply?: boolean;
  /** EI-8986: "nudge if silent" — the dual of wakeOnReply (which wakes you when
   *  a reply ARRIVES). If no reply lands within this many seconds, the
   *  reply-deadline-sweep (dbos/periodic-workflows.ts, every 5m) nudges you
   *  once: a coord message + a fail-soft wake. Independent of wakeOnReply —
   *  set either, both, or neither. Omitted = no deadline tracking (today's
   *  behavior). */
  replyDeadlineSec?: number;
  endTurn?: boolean;
  /** P-001 (cross-machine-coord-parity-and-trust): federation-scope override.
   *  'hive' forces the workspace's shared-Hive scope (loud error naming the
   *  candidates when none/ambiguous); 'local' keeps this message machine-local
   *  even for a harness-scoped sender. Omitted = auto (ctx harness, else the
   *  workspace's single shared Hive, else local). */
  scope?: 'hive' | 'local';
  /** WI-5445: on a workspace with MORE THAN ONE shared Hive, names WHICH shared
   *  Hive `scope:'hive'` means (mirrors resource:offers'/fleet:request_remote_spawn's
   *  own `hive` disambiguator). Without it, scope:'hive' on a multi-hive workspace
   *  refused loudly with no way to comply (ambiguous_hive_scope) — this is the
   *  per-message picker that closes that gap. No effect when the workspace has
   *  zero or exactly one shared Hive (already resolves unambiguously), or when
   *  ctx already carries a harness scope (pipeline roles — unaffected). */
  hive?: string;
  /** FF#1: name the DURABLE BACKSTOP that has been verified to re-dispatch a
   *  wake:'optimistic' miss. Optimistic is silent-on-miss ONLY when a backstop is
   *  declared; WITHOUT one, an optimistic miss is reported as loudly as a required
   *  miss (recipient_absent) — silence must be consciously claimed. */
  backstop?: string;
  /** fleet-scoped-broadcast-default: consciously claim a HIVE-WIDE broadcast. A
   *  fleeted sender's bare `['*']` is auto-scoped to `@fleet:<slug>`; set allHive:true
   *  to keep `'*'` literal and reach every agent (system-wide issue / urgent notice).
   *  No effect for a non-fleeted sender or a directed send. */
  allHive?: boolean;
  /** EI-18791996856052350: RENOUNCE your fleet-control authority for THIS message —
   *  send it as an ordinary agent, unstamped. This is the executable form of the
   *  `fleet_scoped_cue_allhive_contradiction` refusal's own remedy ("send it from a
   *  non-fleet-authority context"), which was otherwise unreachable: fleet leadership
   *  is a property of the sender's identity, not of the call, so a leader had NO way
   *  to issue a hive-wide NOTICE (an outage warning, a shared-tree fault) at all.
   *  Renouncing removes the fleet-members stamp, so the message informs the hive
   *  without carrying control weight over agents outside the fleet — a leader may
   *  INFORM the hive, never COMMAND it. The accidental EI-9501 path (a fleet-control
   *  cue sent with a bare allHive:true) stays refused: leaking it now requires
   *  consciously declaring the cue carries no fleet authority. */
  asAuthority?: 'none';
  /** agent-report-cards-2026-07-17 P-001: a structured `ReportBlock` status card
   *  (shape as parseReportBlock accepts). Validated at send — an invalid payload
   *  is a loud `report_invalid` refusal (nothing sent); the NORMALIZED block is
   *  stamped on the envelope, and a message to ['human'] renders it as a 📋
   *  card in the owner's Inbox (the coord-message attention item's `report`). */
  report?: unknown;
  /** P-013: the side effect this directive requires, verified from the ledger
   *  afterwards rather than from the recipient's reply. Rides the envelope. */
  expectEffect?: DirectiveEffectSpec;
}

/** Whether `to` is a DIRECTED send: at least one recipient, ALL concrete (none a
 *  selector / wildcard / '*' / 'human' — `isSelectorOrWildcard` already covers
 *  those). Used by the wakeOnReply default only when the sender expects a reply. */
function isDirected(to: string[]): boolean {
  return to.length > 0 && to.every((id) => !isSelectorOrWildcard(id));
}

/** WI-41323: read the per-message unverified-claim kind back off a bulk item
 *  result for the envelope hoist. `BulkItemResult`'s index signature types every
 *  extra field `unknown`, so the narrowing lives here ONCE — a cast at each read
 *  site is the thing that goes stale silently when the field's shape moves. */
function readClaimKind(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const claim = (value as { claim?: unknown }).claim;
  return typeof claim === 'string' ? claim : null;
}

/**
 * Whether `address` is the same owner-id alias that the live recipient
 * resolver accepts for `ownerId`. This matters when a reply closes a thread
 * after the original sender has ended, or when the sender's short handle is
 * ambiguous among live owners. The related message proves which owner the alias
 * names;
 * keep this matcher exactly aligned with resolveRecipientsAgainst's
 * exact/prefix/substring rules.
 */
function isOwnerIdAlias(address: string, ownerId: string): boolean {
  return (
    Boolean(address) &&
    Boolean(ownerId) &&
    !isSelectorOrWildcard(address) &&
    (address === ownerId || ownerId.startsWith(address) || ownerId.includes(address))
  );
}

/**
 * Return the flattened body length used by the receiver's inbox projection.
 *
 * This measures strings too because internal GUI callers are upgraded to
 * sections after the schema boundary. For malformed section arrays, return
 * `null` so the body-shape validator reports the problem instead of
 * manufacturing an over-cap error.
 */
function bodyTextLength(body: unknown): number | null {
  if (typeof body === 'string') return body.length;
  if (!Array.isArray(body)) return null;
  const texts: string[] = [];
  for (const section of body) {
    if (!section || typeof section !== 'object') return null;
    const text = (section as { text?: unknown }).text;
    if (typeof text !== 'string') return null;
    texts.push(text);
  }
  return texts.join('\n\n').length;
}

function overCapBodyMessage(bodyChars: number, expects: string): string {
  return (
    `coord:send body is ${bodyChars} characters, exceeding the ${DEFAULT_INBOX_BODY_CAP}-character default inbox cap for expects:'${expects}'. ` +
    'Nothing was sent. This per-message backstop only fires for a caller that bypassed the coord:send handler, ' +
    'which delivers an over-cap body as ordered inbox-sized parts (send-chunking.ts); route the send through it. ' +
    'For content too long to chunk, store it with `work_items:comment { id, body }` or `coord:message-agent { to, body }` and send a short pointer.'
  );
}

interface DispatchAdvisory {
  /** The work-item ids that the action message mentions but does not assign. */
  workItemIds: string[];
  /** Concrete recipients that do not currently hold one of the mentioned items. */
  recipientsNotHolding: string[];
  /** The live assignment observed for each mentioned item. */
  assignments: Array<{ workItemId: string; assignee: string | null }>;
  /** The durable work-transfer primitive that can assign + wake the target. */
  suggestedTool: 'coord:dispatch';
  note: string;
}

// This advisory recommends a NEW claim for a recipient who does not hold the
// item. Keep it aligned with actionable-work-item-dispatch's unassigned
// frontier; terminal/blocked items must not produce a dispatch suggestion.
const DISPATCH_ADVISORY_CLAIMABLE_STATES = new Set(['open', 'failing', 'todo']);

/**
 * Detect the "cheerful acceptance, zero claim" route at the send seam.
 *
 * `coord:send` is intentionally still a message primitive: this is an
 * ADDITIVE advisory, never an implicit claim or a delivery refusal. A directed
 * `expects:'action'` message that names an existing work-item is work-shaped,
 * though, and a recipient who does not hold that item cannot become its worker
 * merely by replying "yes". The sender needs to see that distinction while the
 * original message is still in hand, so it can use `coord:dispatch`.
 *
 * The lookup is dynamic and bounded at the call site. The send has already
 * persisted by the time this helper runs, and every read failure degrades to no
 * advisory rather than changing message delivery.
 */
async function deriveDispatchAdvisory(
  msg: SendMsg,
  bodyText: string | undefined,
  recipients: readonly string[],
  harnessSlug: string | null,
): Promise<DispatchAdvisory | undefined> {
  if (msg.expects !== 'action' || msg.noBodyRefs || !isDirected(msg.to)) return undefined;

  const refs = detectEntryBodyRefs({ summary: msg.summary, body: bodyText }).filter(
    (ref): ref is { kind: 'work-item'; id: string } => ref.kind === 'work-item',
  );
  if (refs.length === 0) return undefined;

  try {
    const { getWorkItem } = await import('../../../work-items');
    const rows = await Promise.all(
      refs.map(async (ref) => {
        try {
          return await getWorkItem(ref.id, harnessSlug ?? undefined);
        } catch {
          return null;
        }
      }),
    );
    const assignments = rows.flatMap((item, index) => {
      if (!item || !DISPATCH_ADVISORY_CLAIMABLE_STATES.has(item.state)) return [];
      return [{ workItemId: refs[index]!.id, assignee: item.assignee?.trim() || null }];
    });
    if (assignments.length === 0) return undefined;

    const mismatches = assignments
      .map((assignment) => ({
        ...assignment,
        recipientsNotHolding: recipients.filter((recipient) => {
          if (!assignment.assignee) return true;
          return (
            recipient !== assignment.assignee &&
            !isOwnerIdAlias(recipient, assignment.assignee) &&
            !isOwnerIdAlias(assignment.assignee, recipient)
          );
        }),
      }))
      // EI-23785816111021036 — COVERAGE, not existence. This filter used to fire on
      // `recipientsNotHolding.length > 0`, i.e. whenever ANY addressee did not hold the
      // item. That is the wrong quantifier for what the advisory means, and it made the
      // alarm fire on the ordinary fan-out shape: one message to [worker, reviewer]
      // naming an item the worker already holds flagged the reviewer, and a message with
      // per-recipient asks (2 recipients, 2 items, each held by its own addressee)
      // flagged BOTH — the union at the `recipientsNotHolding` line below then produced a
      // note that contradicted the `assignments` block in the very same object.
      //
      // The advisory's subject (EI-21824246903447871) is PHANTOM ROUTING: a recipient who
      // replies "yes" cannot become the worker, so the request dies un-actioned. That
      // failure requires NOBODY addressed to be able to act. If even one addressee holds
      // the item, the work has a real owner in the audience and the suggested remedy
      // (coord:dispatch, to "assign the execution lane") is already satisfied — an
      // advisory whose fix is a no-op is noise, and noise trains readers to ignore the
      // alarm that does matter.
      //
      // `recipients.length > 0` is load-bearing: a bare `0 === 0` match would fire a
      // vacuous advisory naming an empty recipient set.
      .filter(
        (assignment) =>
          recipients.length > 0 && assignment.recipientsNotHolding.length === recipients.length,
      );
    if (mismatches.length === 0) return undefined;

    const workItemIds = mismatches.map((entry) => entry.workItemId);
    const recipientsNotHolding = [...new Set(mismatches.flatMap((entry) => entry.recipientsNotHolding))];
    const assignmentText = mismatches
      .map(({ workItemId, assignee }) => `${workItemId} → ${assignee ?? 'unassigned'}`)
      .join('; ');

    return {
      workItemIds,
      recipientsNotHolding,
      assignments,
      suggestedTool: 'coord:dispatch',
      note:
        `This directed expects:'action' message mentions ${workItemIds.join(', ')}, but NONE of ` +
        `the recipient(s) ${recipientsNotHolding.join(', ')} hold that work, so none of them can ` +
        `act on it by replying. Live assignments: ` +
        `${assignmentText}. coord:send only records/delivers the request; it does not assign the ` +
        'work-item. Use coord:dispatch with workItemIds:[…] to assign the execution lane and wake ' +
        'the target, or keep this send as a plain nudge and verify the claim separately.',
    };
  } catch {
    return undefined;
  }
}

// WI-6522 — this union carried NO custom `error`, so zod 4 emitted a bare
// "Invalid input" for every malformed value, naming neither the booleans nor the
// two string modes. That one message was 196 of 578 coord:send arg-shape refusals
// across 80 DISTINCT senders in 14 days — second only to the {to,summary} family
// below. The contrast that proves the text is the cause: `expectsArg` is REQUIRED
// with deliberately no default, yet fails ~11x LESS often, and the only relevant
// difference is that it names its accepted values inline. So: teach here too, and
// call out the string-"true" case explicitly — a quoted "true" is the single most
// likely agent mistake and was previously indistinguishable from any other.
const wakeArg = z
  .union([z.boolean(), z.enum(['required', 'optimistic'])], {
    error:
      "coord:send `wake` accepts: 'required' (the wake MUST land — a clean miss returns " +
      "recipient_absent, a loud miss to handle) | 'optimistic' (best-effort; SAFE only when you also " +
      'name a durable `backstop`) | true (same as \'required\') | false (no wake). OMIT it entirely for ' +
      'a plain inject that never wakes anyone. Note: the STRING "true" is NOT the boolean true — pass ' +
      "true unquoted, or use 'required'.",
  })
  .optional()
  .describe(
    "Wake a SLEEPING addressee NOW, not just inject. 'required' = the wake MUST land: a clean miss (no awake/watching session, none paused) returns recipient_absent:true — a loud miss to handle, not a silent ok. 'optimistic' = best-effort, SAFE ONLY when the caller has verified a durable backstop will re-dispatch a miss — and you must NAME that backstop via the `backstop` arg. WITHOUT a declared backstop an optimistic miss is now reported as loudly as a required miss (recipient_absent + the missed agents' fresh sessionState), so you can't silently hand work to a dead agent. For a one-off transfer to a specific agent, prefer 'required' (verify `queued>0`, then confirm pickup separately) or coord:handoff. The response's `queued` count is durable wake delivery queued, NOT proof that a turn executed; legacy `woken` mirrors that queue count for backward compatibility and also does NOT prove pickup. Read `wakeOutcome` ('queued'/'partial-staged'/'staged-manual-mode'/'missed'/'unknown') and `pickupConfirmed` to distinguish queueing from pickup. Omit = plain inject. Legacy boolean: true → 'required', false → no wake. Targeted to the addressees only — never a broadcast ('*'/'human' are skipped).",
  );

const wakeOnReplyArg = z
  .boolean()
  .optional()
  .describe(
    "When a peer REPLIES to this message (their coord:send sets related_msg_id to this message's msg_id), wake YOU (the sender) so you re-invoke the moment the reply lands — the dual of waking the recipient. Default: ON for DIRECTED sends whose expects is ack/answer/action; OFF for expects:'none' and broadcasts (to '*'/'human'). Set true to opt a fire-and-forget message into reply wakes, or false to opt out.",
  );

const replyDeadlineSecArg = z
  .number()
  .positive()
  .optional()
  .describe(
    'EI-8986: "nudge if silent" — the dual of wakeOnReply (which wakes you when a reply ARRIVES; this wakes you when one does NOT). If no reply lands within this many seconds, a periodic backstop sweep nudges you ONCE: a coord message + a fail-soft wake — never a recurring alarm. Independent of wakeOnReply — set either, both, or neither. Omit for no deadline tracking (today\'s behavior).',
  );

/**
 * D-015 / D-016 / D-048 — the reply-expectation field, REQUIRED with no default.
 *
 * It REPLACES the old optional `expectsReply?: boolean`, which was silently derived:
 *
 *   msg.expectsReply ?? (wakeMode === 'required' && typeof msg.replyDeadlineSec === 'number')
 *
 * That derivation is D-016's "a default is how a field dies" sitting in the live code
 * of the very field D-016 wrote its gate for: everyone took the default, so the field
 * carried almost no sender intent — while `unanswered_directed` (and the delivery
 * ladder) depended on it meaning something.
 *
 * Forcing an explicit choice, INCLUDING the explicit 'none', is what makes the field
 * real. Do NOT reintroduce a default, and do NOT infer it from `wake`/`replyDeadlineSec`
 * — that inference is the defect, not a convenience.
 */
export type ExpectsKind = 'ack' | 'answer' | 'action' | 'none';

const expectsArg = z
  .enum(['ack', 'answer', 'action', 'none'], {
    error:
      "coord:send needs `expects`: what you want back. 'ack' = confirm receipt · 'answer' = reply " +
      "with information · 'action' = do something (a reply is optional) · 'none' = FYI/status, " +
      "nothing expected. There is deliberately NO default — an FYI must say 'none' explicitly.",
  })
  .describe(
    "REQUIRED — what you want back from the recipient: 'ack' (confirm receipt) | 'answer' (reply " +
      "with information) | 'action' (do something; a reply is optional) | 'none' (FYI/status, nothing " +
      "expected). No default and no inference from `wake`: an FYI must say 'none' explicitly. Anything " +
      'other than `none` marks the message unanswered-directed until the recipient threads a reply ' +
      '(related_msg_id), which drives leader-brief / fleet:assignments. A DIRECTED ' +
      "'action'/'answer' ALSO requires `forYouBecause` on at least one body section (state why it " +
      "is THEM); broadcasts and 'ack' are exempt.",
  );

const endTurnArg = z
  .boolean()
  .optional()
  .describe(
    "ESC each addressee's CURRENT turn (mimic pressing Escape) BEFORE delivering — the dual of wake-as-Enter. Use ONLY when a recipient's turn is STUCK (e.g. wedged on an API error so a plain wake reaches nobody / typing+Enter won't start the next turn): the ESC ends the dead turn so the CLI re-arms, then (with wake) this message starts a fresh turn. `endTurn: true` REQUIRES an explicit wake mode: `wake: true`, `wake: 'required'`, or `wake: 'optimistic'`; omitting `wake` or passing `wake: false` is refused because it could leave the recipient idle. Force-ESC is audited + storm-rate-limited; only end a turn you KNOW is stuck. Skips '*'/'human'/self. `ended` excludes any target confirmed dead by the same liveness check the wake leg uses — those land in `missed` instead, even if the ESC channel itself reported success.",
  );

const toArg = z
  .array(z.string().min(1), {
    error:
      'coord:send needs `to`: recipient ids. Accepts the SHORT HANDLE shown in the [coord+N] injection / inbox (e.g. "93a38"), the "su-…" prefix, OR the full ownerId — all resolve against the live roster, so NO coord:presence lookup is needed to reply to a peer. ["*"] broadcasts, ["human"] surfaces to the user. AUDIENCE SELECTORS expand to a group: @fleet:<slug> (live members of a named fleet — the cohort an agent joins, no per-agent subscribe), @fleet-leader:<slug> (escalate to the fleet lead), @topic:<slug>, @plan:<slug>, @object:<kind>:<ref>, @file:<path>. The selector is preserved as the audience key, so members catch up later via coord:catch-up. (To make a peer who is waiting on your reply act NOW rather than on their next turn, set wake:"required" — a plain send only injects.) ⚠ ALL-OR-NOTHING BY DESIGN (EI-19343900550313022): every id here addresses the SAME one message — if even ONE fails to resolve (a typo, a fabricated/padded ownerId, a since-ended session), the WHOLE send refuses (`unknown_recipient`) and NOBODY in the list receives it, including the valid ids. This is deliberate: a multi-recipient message is one atomic delivery (one persisted row, one reply-thread, one wake fan), so a partially-valid list cannot silently leave some addressees informed and others not. If recipients should succeed/fail INDEPENDENTLY, send them as separate messages via the `items:[{ to, summary, … }]` axis instead — each item is resolved and reported per-item, so one bad address never blocks the others.',
  })
  .min(1, 'coord:send needs at least one recipient in `to` — ["*"] broadcasts, ["human"] surfaces to the user.');

const summaryArg = z
  .string({
    error:
      'coord:send needs `summary`: a one-line headline of the message (what the recipient sees in their inbox).',
  })
  .min(1, '`summary` must be a non-empty one-line headline.')
  .describe(
    'REQUIRED for the single-message form (when `items` is omitted); omit only when sending via `items:[…]`. ' +
      'One-line inbox headline — `body` is optional long-form detail and does not replace it.',
  );

const backstopArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "FF#1: name the DURABLE BACKSTOP you verified will re-dispatch a wake:'optimistic' miss. Optimistic stays silent-on-miss ONLY when you declare one; WITHOUT a backstop an optimistic miss is reported as loudly as a required miss (recipient_absent). Do NOT pass a fake or assumed backstop to silence the warning — that re-creates the dead-drop trap. No effect on wake:'required' / inject.",
  );

const scopeArg = z
  .enum(['hive', 'local'])
  .optional()
  .describe(
    "Federation scope of THIS message (cross-machine-coord-parity P-001). Omitted = auto: a harness-scoped sender stamps its harness; an un-scoped (SU/operator) sender in a workspace with EXACTLY ONE shared Hive stamps that Hive's home (the message federates to the Hive's other machines); otherwise the message stays machine-local. 'hive' FORCES the shared-Hive scope — errors loudly (no_hive_scope / ambiguous_hive_scope + candidates) instead of silently staying local. 'local' keeps the message on this machine only. Every result reports `federated:` so a local-only send is never mistaken for cross-machine delivery.",
  );

const messageHarnessArg = z
  .string()
  .min(1)
  .max(120)
  .optional()
  .describe(
    'Per-message harness federation scope. In items:[…], this overrides the top-level `harness` default; in a single send it names the harness directly. A concrete harness-scoped session keeps its own ctx harness authoritative unless `scope:\'local\'` opts out.',
  );

const hiveArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "WI-5445: which shared Hive `scope:'hive'` means, when this workspace hosts MORE THAN ONE shared Hive (mirrors resource:offers'/fleet:request_remote_spawn's own `hive` disambiguator — see the candidates list a bare scope:'hive' returns on ambiguous_hive_scope). Validated against the workspace's actual shared-hive set — an unknown name refuses loudly. No effect on a zero/single-shared-hive workspace or a harness-scoped (ctx) sender.",
  );

const allHiveArg = z
  .boolean()
  .optional()
  .describe(
    "fleet-scoped-broadcast-default: consciously claim a HIVE-WIDE broadcast. If YOU are in a fleet, a bare to:['*'] is auto-scoped to your fleet (@fleet:<slug>, leader included) so routine status doesn't flood every agent — the result reports the rewrite as `scopedBroadcast`. Set allHive:true to keep '*' literal and reach EVERY agent, for system-wide issues / urgent notices only. No effect for a non-fleeted sender or a directed send.",
  );

const asAuthorityArg = z
  .literal('none')
  .optional()
  .describe(
    "Renounce your fleet-control authority for THIS message — it is delivered UNSTAMPED, as an ordinary agent. A fleet LEADER needs this to send a hive-wide NOTICE (to:['*'] + allHive:true), which is otherwise refused as fleet_scoped_cue_allhive_contradiction: a leader may INFORM the hive, never COMMAND it. Do NOT use it to push a fleet-control cue (drain/pause/steer) past that guard. No effect for a sender holding no fleet-leader authority.",
  );

const relayOfArg = z
  .string()
  .optional()
  .describe(
    "Relaying someone else's directive/decision? Pass the ORIGINAL's coord msg_id — or the literal sentinel 'owner-turn' when relaying what the owner told you in your CURRENT turn (a TUI human turn has no msg_id). The platform verifies the reference SERVER-SIDE at send, stamps the provenance tier (coord-origin / owner-verified(turn)) and auto-inlines a bounded VERBATIM quote at delivery — receivers see the original's words, never your paraphrase, and neither side makes an extra call. A dangling msg_id is a loud relay_origin_not_found (nothing sent).",
  );

const relayQuoteArg = z
  .string()
  .optional()
  .describe(
    "Relay-provenance Tier 3 (older turns 'owner-turn' can't reach): a VERBATIM snippet of the owner turn you are relaying. Verified against your own transcript's human turns — hit → stamped owner-verified(transcript-match); miss → still delivered, stamped 'UNVERIFIED relay'.",
  );

const gateRefsArg = z
  .array(z.string().min(1))
  .max(3)
  .optional()
  .describe(
    'Declaring/referencing announced gate(s)? Pass the EXACT event key(s) (≤3 — e.g. the key events:emit { announce:true } RETURNED). The platform verifies each against the announced-gates store at send and stamps its status (declared/fired/undeclared); delivery renders the exact keys UN-CLIPPED, and receivers can skip copying entirely via events:await { fromMsg: <this msg_id> }. Kills hand-typed gate-key drift — a near-miss key never rendezvouses.',
  );

const noBodyRefsArg = z
  .boolean()
  .optional()
  .describe(
    "P-008 body auto-refs OPT-OUT: by default, WI-/EI- ids mentioned in your summary/body auto-hydrate at delivery into a one-line live status+title+checkpoint suffix on the receiver's [coord+N] line (first 3 ids, ~150 chars each — receivers stop re-fetching cited items). Set true when that live status would MISLEAD: the ids are historical/illustrative examples, or you are deliberately quoting stale state.",
  );

/** P-013 (fleet-leadership-continuity): the SIDE EFFECT this directive requires.
 *  `queued:1` proves a durable wake delivery was queued; it does not prove a session
 *  started a turn. `expects`/`expectsReply` proves they answered.
 *  Neither proves the instruction was carried out — and the party who would answer
 *  is the party whose compliance is in question. Naming the effect here lets it be
 *  DERIVED afterwards from the ledger that records it (directive-effect.ts), with
 *  no cooperation from the recipient. Stamped on the envelope; the verdict is
 *  measured against THIS message's timestamp, so a pre-existing effect can never be
 *  miscredited to the directive. */
const expectEffectArg = z
  .object({
    kind: z.enum(DIRECTIVE_EFFECT_KINDS),
    itemId: z.string().min(1),
    harness: z.string().optional(),
  })
  .strict()
  .optional()
  .describe(
    "SAFETY-CRITICAL directives only: name the SIDE EFFECT the instruction requires — { kind:'checkpoint'|'claim-release'|'terminal', itemId } — and it is verified from the ledger afterwards instead of taken on the recipient's word. `queued:1` only proves a durable wake delivery was queued; it does not prove a session woke. Read the verdict on fleet:leader-brief (`directives`).",
  );

/** agent-report-cards-2026-07-17 P-001 / D-004: a DELIBERATELY loose shape —
 *  `parseReportBlock` (@papercusp/chat-protocol) is the single canonical
 *  validator (loud `report_invalid` refusal in sendOne), so this zod shape is
 *  introspection/documentation only and cannot drift from it. */
const reportArg = z
  .object({
    title: z.string().optional(),
    goalReport: z.object({ schemaVersion: z.literal(1), goalId: z.string(), reportId: z.string(), bodySha256: z.string() }).optional(),
    plans: z.array(
      z.object({
        slug: z.string().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
        summary: z.string().optional(),
        items: z
          .array(
            z.object({
              id: z.string().optional(),
              text: z.string().optional(),
              status: z.string().optional(),
            }),
          )
          .optional(),
      }),
    ),
  })
  .optional()
  .describe(
    'Structured status card (ReportBlock): { title?, plans:[{ title, status?, summary?, items?:[{ id?, text, status? }] }] }. Sent to ["human"] it renders as a 📋 card in the owner\'s Inbox (fleet updates, status digests) instead of plain text. Statuses like blocked/failing surface it as an Alert; a genuine decision still goes through coord:escalate. Invalid shape → loud report_invalid refusal (nothing sent).',
  );

/** P-033. Which fields a NON-AGENT sender (the operator GUI) derived rather than
 *  authored — so the D-070 measurement can exclude them instead of counting a
 *  derived value as sender intent. Agents never pass this: they author. */
const fieldProvenanceArg = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    'Non-agent senders only (the operator GUI wrapper). Marks which fields were DERIVED rather ' +
      'than authored, so adoption measurement never counts them as sender intent.',
  );

/**
 * D-084 / D-002: `basedOn` is an envelope output, never caller input.
 *
 * Keep the field declared in both generated input schemas so a deferred caller
 * gets the contract (and a useful refusal) instead of the generic unknown-key
 * error. `deriveBasedOn` remains the only writer; accepting authored provenance
 * here would let a sender claim reads the invocation log cannot support.
 */
const basedOnArg = z
  .never({
    error:
      '`basedOn` is OUTPUT-ONLY: the send seam auto-derives it from this session\'s recent reads. ' +
      'Do not author or pass it; omit `basedOn` from the request. If you need to explain a claim, ' +
      'use the authored `body[].premises` field instead.',
  })
  .optional()
  .describe(
    'OUTPUT-ONLY — `basedOn` is auto-derived from this session\'s recent reads and stamped on the ' +
      'envelope after validation. Never author or pass it; omit this field. Use `body[].premises` ' +
      'for authored claim references.',
  );

// EI-19295149246007753 guard (b): exported so send-arg-shape.test.ts can assert
// FIELD-NAME PARITY between this (the items[] axis's canonical field set) and the
// top-level single-form object schema below — the residual risk after fix (a): a
// field added here but never mirrored onto the top-level object still validates
// fine on itemSpec, but a caller using the single form has it silently stripped
// by zod's default "unknown keys" behavior BEFORE the handler ever runs. Test-only
// export; nothing outside this file's own tests should import it.
export const itemSpec = z.object({
  to: toArg,
  summary: summaryArg,
  harness: messageHarnessArg,
  body: messageBodyArg,
  // P-032 / D-064, reopened by D-070: the ENVELOPE half of the split. These
  // cannot vary per section — `blocking` because a scheduler acts on a message
  // as a UNIT, `why` because one message serves one goal (D-011). The SECTION
  // half (premises / forYouBecause / youMayNotKnow / couldNotDetermine) lives on
  // `body[]`, and message-fields.ts REFUSES either half on the wrong side.
  blocking: blockingArg,
  why: whyArg,
  basedOn: basedOnArg,
  files: z.array(z.string()).optional(),
  // P-005/D-097: normally supplied by the send seam from the sender's declared
  // plan lane, so the arg exists only to OVERRIDE. Said here because tier 1's
  // whole claim is that the agent never has to remember it.
  plan_slug: z
    .string()
    .optional()
    .describe(
      'Usually AUTO-DERIVED — omit it. The seam stamps your declared plan (coord:orient ' +
        '{ planSlug }); pass this only to attribute the message to a DIFFERENT plan.',
    ),
  related_msg_id: z
    .string()
    .optional()
    .describe(
      "Replying? The full msg_id you are answering (or a UNIQUE leading prefix copied from coord:inbox) — this fires the asker's wake-on-reply. The server persists the canonical full id; dangling or ambiguous refs refuse the send (related_msg_not_found / related_msg_ambiguous). Never hand-type or use a placeholder.",
    ),
  // D-048: REQUIRED here — not `.optional()`. The items[] axis enforces the gate
  // STRUCTURALLY: because itemSpec is what the generated tool schema advertises for
  // `items`, a caller SEES that `expects` is required rather than reading it in prose
  // (the work_items:set_state terminal-evidence precedent, P-005/D-006).
  expects: expectsArg,
  relayOf: relayOfArg,
  relayQuote: relayQuoteArg,
  gateRefs: gateRefsArg,
  noBodyRefs: noBodyRefsArg,
  wake: wakeArg,
  wakeOnReply: wakeOnReplyArg,
  replyDeadlineSec: replyDeadlineSecArg,
  endTurn: endTurnArg,
  backstop: backstopArg,
  scope: scopeArg,
  hive: hiveArg,
  allHive: allHiveArg,
  asAuthority: asAuthorityArg,
  report: reportArg,
  expectEffect: expectEffectArg,
  fieldProvenance: fieldProvenanceArg,
});

/**
 * Send ONE distinct message — the full per-message pipeline (recipient resolve →
 * endTurn → persist → wake / idle-report). Returns the self-describing result for
 * the bulk envelope: it embeds the message's `to` (its key) + the minted msg_id.
 * A recipient-resolve miss is this message's { ok:false } (it does NOT throw), so
 * one bad address never fails the other messages in the batch.
 */
/**
 * The GOAL owner-report verdict for ONE logical message (P-006 / A-05).
 *
 * `skip` marks a chunk CONTINUATION: the report was judged (and stamped) on the
 * whole message, and the stamp rides the final part only.
 */
export type GoalOwnerReportVerdict =
  | { kind: 'none' }
  | { kind: 'skip' }
  | { kind: 'warning'; warning: string }
  | {
      kind: 'not-stamped';
      diagnostic: {
        status: 'not-stamped';
        goalId: string;
        reason: 'not-attempted';
        missing: GoalOwnerReportField[];
        bodyAuthoredChars?: number;
        bodyDeliveryCap: number;
        message: string;
      };
    }
  | { kind: 'stamped'; stamp: GoalOwnerReportStamp }
  | { kind: 'reference'; stamp: GoalOwnerReportStamp; body: string; summary: string;
      persistEnvelope: (envelope: CoordEnvelope) => Promise<CoordEnvelope> }
  | { kind: 'refused'; result: BulkItemResult };

function hasAllGoalOwnerReportLabels(body: SendMsg['body']): boolean {
  const text = sectionsToText(toSections(body));
  return GOAL_OWNER_REPORT_FIELDS.every((field) => {
    const label = GOAL_OWNER_REPORT_HEADINGS[field].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${label}\\b`, 'i').test(text);
  });
}

/**
 * Judge a message against the GOAL owner-report contract.
 *
 * EI-23793424529287793: must be called with the WHOLE authored message. It used
 * to run only inside sendOne, i.e. AFTER send-chunking had split an over-cap
 * report into inbox-sized parts, so each part was judged alone: a part carrying
 * only MOVED was refused for missing COST / OWNER-WALLED / KILLED while its
 * siblings were delivered, and the owner received orphan fragments of a report
 * that was complete as authored (and an incomplete one was half-delivered
 * instead of refused). The handler now calls this once per original message and
 * threads the verdict to every part, so a report is delivered whole or not at all.
 */
export async function evaluateGoalOwnerReport(
  msg: Pick<SendMsg, 'to' | 'body' | 'report'>,
  identity: Pick<AgentIdentity, 'workspaceId' | 'ownerId'>,
): Promise<GoalOwnerReportVerdict> {
  if (msg.report && typeof msg.report === 'object' && 'goalReport' in msg.report) {
    const block = parseReportBlock(msg.report);
    if (!block?.goalReport) return { kind: 'refused', result: { ok: false, to: msg.to, error: 'report_invalid', oracle: 'goal-reference-shape' } };
    if (msg.to.length !== 1 || msg.to[0] !== 'human') return { kind: 'refused', result: { ok: false, to: msg.to, error: 'report_reference_unavailable', oracle: 'owner-recipient' } };
    try {
      const { getModeSubject } = await import('../../../modes/store');
      const goalId = await getModeSubject(identity.workspaceId!, identity.ownerId, 'goal');
      if (!goalId || !identity.workspaceId || identity.workspaceId === '*') return { kind: 'refused', result: { ok: false, to: msg.to, error: 'goal-owner-report-untruthful', oracle: 'current-goal-subject' } };
      const { coordSql } = await import('../log');
      const bridge = await import('../../../goal-owner-report-reference');
      const sql = coordSql();
      const context = { workspaceId: identity.workspaceId, goalId, ref: block.goalReport, viewer: { ownerId: identity.ownerId } };
      const report = await bridge.resolveGoalReportReference(sql, context.workspaceId, goalId, context.ref, context.viewer);
      await bridge.validateGoalReportReferenceSnapshot(report.goalOwnerReport!, bridge.makeGoalReportReferenceReads(sql, context.workspaceId, goalId), Date.now());
      const body = bridge.deriveGoalReportNotification(report.goalOwnerReport!);
      return { kind: 'reference', body, summary: report.title, stamp: stampGoalOwnerReport(goalId, parseGoalOwnerReport(body)),
        persistEnvelope: (envelope) => bridge.persistGoalReportReference(sql, envelope, context) };
    } catch (error) {
      const failure = error as { code?: string; oracle?: string; message?: string };
      return { kind: 'refused', result: { ok: false, to: msg.to, error: failure.code ?? 'goal-owner-report-untruthful', oracle: failure.oracle ?? 'current-source-read', message: failure.message } };
    }
  }
  if (!msg.to.includes('human')) return { kind: 'none' };
  const parsed = parseGoalOwnerReport(msg.body);
  // A complete set of labels in the body that is not parseable as headings is
  // still report-like. Resolve the active goal for this narrow case so the
  // sender gets an explicit not-stamped result instead of a silent kind:none.
  // Ordinary owner-facing prose stays on the cheap path without a mode-store read.
  const unrecognizedReportShape = !parsed.attempted && hasAllGoalOwnerReportLabels(msg.body);
  if (!parsed.attempted && !unrecognizedReportShape) return { kind: 'none' };
  let goalId: string | null = null;
  if (!identity.workspaceId || identity.workspaceId === '*') {
    return {
      kind: 'warning',
      warning:
        'GOAL owner-report validation was unavailable because this sender has no concrete workspace; the message was delivered but does not carry canonical report evidence.',
    };
  }
  try {
    const { getModeSubject } = await import('../../../modes/store');
    goalId = await getModeSubject(identity.workspaceId, identity.ownerId, 'goal');
  } catch (error) {
    return {
      kind: 'warning',
      warning:
        'GOAL owner-report validation was unavailable at send time; the message was delivered without canonical report evidence. ' +
        `Retry after the active GOAL subject is readable (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  // No active GOAL row means this is ordinary owner-facing prose, even if
  // its headings resemble the GOAL contract. Do not manufacture authority.
  if (!goalId) return { kind: 'none' };
  const authoredBodyChars = bodyTextLength(msg.body);
  const overCap = authoredBodyChars !== null && authoredBodyChars > DEFAULT_INBOX_BODY_CAP;
  if (unrecognizedReportShape) {
    const multipartNote = overCap && authoredBodyChars !== null
      ? ` The ${authoredBodyChars}-character body exceeded the ${DEFAULT_INBOX_BODY_CAP}-character cap and was delivered in parts; multipart sends cannot reset the report cadence.`
      : '';
    return {
      kind: 'not-stamped',
      diagnostic: {
        status: 'not-stamped',
        goalId,
        reason: 'not-attempted',
        missing: [...GOAL_OWNER_REPORT_FIELDS],
        ...(authoredBodyChars !== null ? { bodyAuthoredChars: authoredBodyChars } : {}),
        bodyDeliveryCap: DEFAULT_INBOX_BODY_CAP,
        message:
          `GOAL owner report for ${goalId} was delivered but not stamped: no report headings were recognized at the start of a body line or section. Use exactly one non-empty section headed ${GOAL_OWNER_REPORT_FIELDS.map((field) => GOAL_OWNER_REPORT_HEADINGS[field]).join(', ')}; this send will not reset the report cadence.` +
          multipartNote,
      },
    };
  }
  const overCapNote = overCap
    ? ` The body has ${authoredBodyChars} characters, above the ${DEFAULT_INBOX_BODY_CAP}-character inbox cap. ` +
      'A GOAL owner report must fit in one message so the whole report is delivered as a unit. Nothing was sent; shorten it and retry.'
    : '';
  if (!parsed.complete) {
    return {
      kind: 'refused',
      result: {
        ok: false,
        to: msg.to,
        error: 'goal-owner-report-incomplete',
        goalId,
        missing: parsed.missing,
        empty: parsed.empty,
        duplicate: parsed.duplicate,
        ...(overCap && authoredBodyChars !== null
          ? { bodyAuthoredChars: authoredBodyChars, bodyDeliveryCap: DEFAULT_INBOX_BODY_CAP }
          : {}),
        message:
          `GOAL owner report for ${goalId} is incomplete; nothing was sent. ` +
          `Provide exactly one non-empty body section headed each of ${GOAL_OWNER_REPORT_HEADING_LIST}. ` +
          'Use explicit `none` or `unknown (<source/provenance>)` when that is the factual value. ' +
          'NEXT WAKE names what will wake you next and roughly when (loop interval, awaited event, or owner reply). ' +
          `Missing: ${parsed.missing.join(', ') || 'none'}; empty: ${parsed.empty.join(', ') || 'none'}; ` +
          `duplicate: ${parsed.duplicate.join(', ') || 'none'}.` +
          overCapNote,
      },
    };
  }
  if (overCap && authoredBodyChars !== null) {
    return {
      kind: 'refused',
      result: {
        ok: false,
        to: msg.to,
        error: 'goal-owner-report-over-cap',
        goalId,
        bodyAuthoredChars: authoredBodyChars,
        bodyDeliveryCap: DEFAULT_INBOX_BODY_CAP,
        message:
          `GOAL owner report for ${goalId} is ${authoredBodyChars} characters; its sections must fit ` +
          `one ${DEFAULT_INBOX_BODY_CAP}-character inbox message to update the reporting rail as a unit. ` +
          'Nothing was sent. Shorten the report and retry; put long supporting detail on its work-item.',
      },
    };
  }
  // P-005 (goal-holder-plans-ideation-truthful-reports-2026-10-03): a complete
  // report is judged against MEASURED goal state before it reaches the owner.
  // An unreadable measurement skips its check; only a readable contradiction refuses.
  const truth = await readGoalOwnerReportTruth(identity.workspaceId, goalId, parsed.fields);
  if (truth && truth.violations.length) {
    return {
      kind: 'refused',
      result: {
        ok: false,
        to: msg.to,
        error: 'goal-owner-report-untruthful',
        goalId,
        violations: truth.violations,
        message: describeGoalOwnerReportTruthViolations(goalId, truth.violations),
      },
    };
  }
  return {
    kind: 'stamped',
    stamp: stampGoalOwnerReport(goalId, parsed, truth ? { citedRefStates: truth.citedRefStates, summary: truth.summary } : undefined),
  };
}

/** Lazy so the truth module's DB reads stay off the cheap path of ordinary sends. */
async function readGoalOwnerReportTruth(
  workspaceId: string,
  goalId: string,
  fields: GoalOwnerReportParseResult['fields'],
): Promise<GoalOwnerReportTruthVerdict | null> {
  try {
    const { readGoalOwnerReportTruth: read } = await import('../../../goal-owner-report-truth');
    return await read(workspaceId, goalId, fields);
  } catch {
    return null;
  }
}

async function sendOne(
  msg: SendMsg,
  identity: AgentIdentity,
  harnessSlug: string | null,
  bcast?: {
    scoped?: { from: '*'; to: string; reason: string };
    allHive?: boolean;
    /** EI-18791996856052350: the sender held fleet-leader authority and RENOUNCED it
     *  for this message (asAuthority:'none'), so it ships unstamped. Reported back so
     *  the downgrade is never silent — the sender must see that its cue carried no
     *  fleet-control weight. */
    renouncedFleetAuthority?: boolean;
  },
  cueAuthority?: CueAuthorityStamp | null,
  /**
   * P-009 — the dead-signal census sink, built ONCE from the handler's ctx
   * (`censusObserverFor(ctx)`) and threaded down because this function is where
   * the only volume coupling derivation happens. Optional, so every other caller
   * and every test wires no instrument.
   *
   * ⚠ Fires once PER MESSAGE, and `ctx.metadata` is last-write-wins, so a bulk
   * send records the LAST message's census. Deliberate: the sender's roster and
   * legs are identical across a bulk's messages, so the surviving record is
   * representative — but it is a sample, never a message count.
   */
  observeCensus?: (census: DerivedSignalCensus) => void,
  idempotencyKey?: string,
  itemIndex?: number,
  /**
   * EI-23793424529287793: the GOAL owner-report verdict for the WHOLE message
   * this part belongs to, computed by the handler before chunking. Absent for an
   * unchunked message, which is judged here as before.
   */
  goalReportPreVerdict?: GoalOwnerReportVerdict,
  /** The dispatcher aborts this signal when the caller stops waiting. */
  requestSignal?: AbortSignal,
): Promise<BulkItemResult> {
  // Reference prose is server-derived before cap/chunk/inline truth checks.
  // A caller's short body cannot substitute for the pinned snapshot.
  if (msg.report && typeof msg.report === 'object' && 'goalReport' in msg.report) {
    goalReportPreVerdict = await evaluateGoalOwnerReport(msg, identity);
    if (goalReportPreVerdict.kind === 'refused') return goalReportPreVerdict.result;
    if (goalReportPreVerdict.kind === 'reference') {
      msg = { ...msg, summary: goalReportPreVerdict.summary, body: [{ text: goalReportPreVerdict.body }] };
    }
  }
  // EI-21826596284846555: a normal inbox read exposes at most the first
  // 600 characters of one message body (and less on a crowded page). For a
  // load-bearing message, persisting a longer body and warning only after the
  // send is too late: the conclusion can be the part the recipient cannot see.
  // Keep this runtime guard for internal callers that bypass the Zod boundary;
  // the schema below enforces the same refusal before an agent request reaches
  // this handler.
  const authoredBodyChars = bodyTextLength(msg.body);
  if (msg.expects !== 'none' && authoredBodyChars !== null && authoredBodyChars > DEFAULT_INBOX_BODY_CAP) {
    return {
      ok: false,
      to: msg.to,
      error: 'body_exceeds_inbox_cap',
      message: overCapBodyMessage(authoredBodyChars, msg.expects),
    };
  }

  // agent-report-cards-2026-07-17 P-001 / D-004: validate a structured report
  // card payload FIRST (pure, cheap) through the ONE canonical validator. A
  // payload that yields no valid block is a LOUD refusal — a silently-dropped
  // card would be indistinguishable from a delivered one to the sender.
  let reportBlock: ReportBlock | null = null;
  if (msg.report !== undefined && msg.report !== null) {
    reportBlock = parseReportBlock(msg.report);
    if (!reportBlock) {
      return {
        ok: false,
        to: msg.to,
        error: 'report_invalid',
        message:
          'report did not validate as a ReportBlock — nothing was sent. Shape: { title?, plans:[{ ' +
          'title, status?, summary?, items?:[{ id?, text, status? }] }] } with at least one plan ' +
          'carrying a title (or slug). Fix the payload, or drop `report` and send plain text.',
      };
    }
  }

  // P-006 / A-05: a GOAL owner report is a mechanically complete operation,
  // not any message that happens to reach the human. Parse only the body and
  // only on the owner-facing rail: ordinary human notes, peer messages, and
  // diagnostic/remediation traffic remain unchanged unless they deliberately
  // use one of the four report headings.
  //
  // The subject is NEVER caller-authored. Resolve the sender's active GOAL row
  // at this write boundary so a stale prompt, wrong goal id, or copied report
  // cannot stamp evidence for another subject. The mode import stays lazy: the
  // dominant ordinary-send path must not acquire a DB/module dependency merely
  // because this optional evidence class exists.
  //
  // EI-23793424529287793: a CHUNKED message arrives with its verdict already
  // computed over the whole authored body (see evaluateGoalOwnerReport); only an
  // unchunked message is judged here.
  const goalReportVerdict = goalReportPreVerdict ?? (await evaluateGoalOwnerReport(msg, identity));
  if (goalReportVerdict.kind === 'refused') return goalReportVerdict.result;
  const goalOwnerReport: GoalOwnerReportStamp | null =
    goalReportVerdict.kind === 'stamped' || goalReportVerdict.kind === 'reference' ? goalReportVerdict.stamp : null;
  const goalOwnerReportWarning: string | null =
    goalReportVerdict.kind === 'warning' ? goalReportVerdict.warning : null;
  const goalOwnerReportDiagnostic =
    goalReportVerdict.kind === 'not-stamped' ? goalReportVerdict.diagnostic : null;

  // Wake INTENT (directed-wake-honesty D-002): 'required' = the wake must land
  // (a clean miss → recipient_absent); 'optimistic' = best-effort over a durable
  // backstop (silent miss). Legacy boolean coerces: true → 'required' (the safe
  // loud default), false/omit → no wake.
  const wakeMode: 'required' | 'optimistic' | null =
    msg.wake === true ? 'required' : msg.wake === false || msg.wake == null ? null : msg.wake;

  // wake-on-reply (coord-wake-on-reply): when a peer REPLIES to this message
  // (their coord:send sets related_msg_id to this msg_id and addresses the
  // original sender), that sender should be re-invoked — the dual of
  // deliver-and-wake. A threaded message sent to a different owner is not a
  // reply-wake for the original sender. Default ON for a DIRECTED send
  // (concrete recipients) that actually expects ack/answer/action, OFF for
  // expects:'none' and broadcasts ('*'/'human'); explicit
  // `wakeOnReply:false` always wins, `true` forces on. EI-21542997259558722:
  // defaulting an expects:none cancellation ACK on created a fresh reply-wake
  // chain, resurrecting a reviewer after it had explicitly stood down. Flag-gated:
  // when OFF, neither the opt-in is persisted nor a reply fires the wake
  // (today's behavior). Fail-safe to ON on a flag-read error (the new default).
  const wakeOnReplyFlag = await getFlag(FLAGS.COORD_WAKE_ON_REPLY, 'system').catch(() => true);
  const effectiveWakeOnReply = wakeOnReplyFlag && (msg.wakeOnReply ?? (msg.expects !== 'none' && isDirected(msg.to)));

  // Reply-threading honesty (WI-5072): related_msg_id is the edge the ENTIRE
  // reply-wake contract fires on — the asker's wakeOnReply can only match a
  // reply whose related_msg_id resolves to their message. A dangling or
  // ambiguous ref
  // (hand-typed, placeholder, stale) silently voided that contract for BOTH
  // sides: the replier's send returned ok, the asker slept until a human
  // prodded them (live incident 2026-07-16: a reply threaded to the literal id
  // 'mrnyt8k4-0000-placeholder'; 62 of 870 replies in the prior 7 days dangled
  // the same way, across many senders). Mirror the relayOf contract directly
  // below: a CLEAN lookup miss refuses the message loudly; an infra error
  // stays fail-soft (never refuse a genuine reply on a transient read hiccup).
  // The fetched original is reused by the reply-wake block below (one lookup),
  // AND by the recipient-resolution block right after (EI-18145: see
  // recipient block can use the authenticated sender for only that alias).
  let relatedOriginal: Awaited<ReturnType<typeof getMessageById>> = null;
  // Keep the caller's ref for diagnostics, but persist and reuse the canonical
  // full id when resolveMessageRef accepted a unique leading prefix.
  let relatedMsgIdForSend = msg.related_msg_id;
  if (msg.related_msg_id) {
    let lookupErrored = false;
    let relatedLookup: Awaited<ReturnType<typeof resolveMessageRef>> | null = null;
    try {
      relatedLookup = await resolveMessageRef(msg.related_msg_id);
      if (relatedLookup.status === 'found') {
        relatedOriginal = relatedLookup.message;
        relatedMsgIdForSend = relatedLookup.msgId;
      } else if (relatedLookup.status === 'ambiguous') {
        return {
          ok: false,
          to: msg.to,
          error: 'related_msg_ambiguous',
          message:
            `related_msg_id '${msg.related_msg_id}' matches multiple coord messages ` +
            `(${relatedLookup.candidates.join(', ')}) — nothing was sent. ` +
            'Use the full msg_id or a longer unique leading prefix.',
        };
      }
    } catch {
      lookupErrored = true; // infra hiccup — deliver anyway (fail-soft)
    }
    if (!lookupErrored && relatedOriginal == null) {
      // EI-21919726429448449: a conversation id (coord:ask / discussion / consult)
      // and a coord msg_id are two DIFFERENT id spaces, but a caller who copied a
      // conversation id from a summary/render can reasonably expect it to thread
      // here too — the generic miss gives them no route forward. Best-effort,
      // never blocking: if the ref resolves as a conversation, name that instead
      // of leaving the caller to guess.
      let conversationHint = '';
      try {
        const maybeConversation = await getConversation(msg.related_msg_id);
        if (maybeConversation) {
          conversationHint =
            ` '${msg.related_msg_id}' IS a valid conversation id (kind:${maybeConversation.conversation.kind}, ` +
            `state:${maybeConversation.conversation.state}) — but related_msg_id threads coord MESSAGES, a ` +
            'separate id space conversations do not share. Reply IN the conversation with ' +
            `conversations:answer / conversations:post { conversation_id: '${msg.related_msg_id}' } instead; ` +
            'if you meant to thread a coord message, find its msg_id in coord:inbox.';
        }
      } catch {
        // best-effort probe — never let it block or alter the primary refusal
      }
      return {
        ok: false,
        to: msg.to,
        error: 'related_msg_not_found',
        message:
          `related_msg_id '${msg.related_msg_id}' matches no coord message — nothing was sent.` +
          conversationHint +
          ` A dangling threading id silently voids the asker's wake-on-reply (they sleep while ` +
          `you believe you replied). Copy the full msg_id from coord:inbox / the message you ` +
          `are answering, or use a unique leading prefix — never hand-type or use a ` +
          `placeholder. If the original is genuinely old/pruned, resend without related_msg_id.` +
          (relatedLookup?.status === 'not-found' && relatedLookup.looksTruncated
            ? ' A shortened ref is accepted only when it uniquely matches one stored message.'
            : ''),
      };
    }
  }

  // owner-2026-06-17: validate + resolve recipients against the live roster
  // BEFORE sending. A short ownerId PREFIX resolves to the full id (so the exact
  // `coord:inbox-wake:<ownerId>` wake key matches and the wake lands); a concrete
  // recipient that matches NO known agent is a LOUD error — the send does NOT
  // happen — instead of the old silent ok:true. Fail-soft: a roster-read hiccup
  // degrades to the raw ids (never blocks coord). Local-roster scoped.
  //
  // EI-18145 / EI-24838286424095637: the related message authenticates its
  // original sender for that exact alias. This permits an unknown alias when
  // that sender has left the roster, or an ambiguous alias when that sender is
  // one of the live candidates. Any OTHER unknown or ambiguous recipient still
  // hard-refuses. A directed obligation (unanswered-directed / the delivery-ladder
  // alarm) is satisfied by
  // recording a reply authored by the recipient with `related_msg_id` set — it
  // does NOT require the original sender to still exist. Before this fix, once
  // a correspondent's session ended (reaped from the roster), NOTHING could ever
  // satisfy that check: the only tool that writes the satisfying reply row
  // (coord:send) hard-refused with `unknown_recipient` the moment its `to`
  // named the now-gone sender — a structurally unresolvable dead end (observed
  // live: EI-18145123522199011, a directed ping from a since-ended sender kept
  // re-surfacing as "unanswered" with no way to ever clear it). Scoped tight:
  // only an unknown or ambiguous alias matching `relatedOriginal.from` is
  // canonicalized; unrelated recipients still go through normal validation.
  let toSend = msg.to;
  let goneRepliedTo: string[] = [];
  if (msg.to.some((id) => !isSelectorOrWildcard(id))) {
    try {
      const r = await resolveRecipients(msg.to, identity.workspaceId);
      const closingReplySender = relatedOriginal?.from ?? null;
      const goneReplyAliases = closingReplySender
        ? r.unknown.filter((id) => isOwnerIdAlias(id, closingReplySender))
        : [];
      const ambiguousReplyAliases = closingReplySender
        ? r.ambiguous.filter(
            ({ id, matches }) => matches.includes(closingReplySender) && isOwnerIdAlias(id, closingReplySender),
          )
        : [];
      // Canonicalize an unknown alias to the full ownerId in the durable reply
      // when the original sender has left the roster. For a live sender, the
      // matching entry in `r.ambiguous` proves the alias was shared by multiple
      // owners and lets this related message disambiguate only that sender.
      if (goneReplyAliases.length && closingReplySender !== null && !r.resolved.includes(closingReplySender)) {
        goneRepliedTo = [closingReplySender];
      }
      // A related message authenticates its exact sender, so it can disambiguate
      // that sender's own short handle even when other live respawn IDs share it.
      // The candidate check above keeps unrelated ambiguous addresses refused.
      const resolvedAmbiguousReplySender =
        ambiguousReplyAliases.length &&
        closingReplySender !== null &&
        !r.resolved.includes(closingReplySender)
          ? [closingReplySender]
          : [];
      const trulyUnknown = r.unknown.filter((id) => !goneReplyAliases.includes(id));
      const trulyAmbiguous = r.ambiguous.filter(
        ({ id }) => !ambiguousReplyAliases.some((alias) => alias.id === id),
      );
      if (trulyUnknown.length || trulyAmbiguous.length) {
        // EI-19343900550313022: this is ALL-OR-NOTHING BY DESIGN (see toArg's
        // own description), but that is easy to miss in the moment — a sender
        // with 2 valid + 1 fabricated/typo'd recipient reads "nothing was sent"
        // and can reasonably assume the valid two are unaffected. They are not:
        // say so explicitly whenever the list carried >1 addressee, so the
        // sender knows to re-notify the valid ones (or re-split via items[]).
        const otherValidCount = new Set([
          ...r.resolved,
          ...resolvedAmbiguousReplySender,
          ...goneRepliedTo,
        ]).size;
        // knowledge-at-symptom-time-2026-08-09 P-005: when the bad address is
        // session-SHAPED, the existing advice ("use the handle / look it up in
        // coord:presence") answers the wrong question — no live session will
        // ever hold that id again, so there is nothing to look up. Route the
        // caller to `@role:<slot>`, which cannot hard-refuse. Fail-soft: any
        // error inside leaves the refusal exactly as it was.
        let roleHint = '';
        try {
          const classified = await classifyUnknownRecipients(trulyUnknown, (ids) =>
            lookupEndedSessions(ids, identity.workspaceId),
          );
          const senderFleetMembership = await resolvePresenceFleet(identity.ownerId, deriveFleetMembership());
          roleHint = roleAddressingGuidance(classified, senderFleetMembership.fleetSlug) ?? '';
        } catch {
          roleHint = '';
        }
        return {
          ok: false,
          to: msg.to,
          error: 'unknown_recipient',
          message:
            'coord:send addressed agent(s) not in the roster — nothing was sent. ' +
            'Use the short handle from [coord+N]/inbox, the su- prefix, or the full ownerId ' +
            '(coord:presence lists them); a substring of a live ownerId also resolves.' +
            (msg.related_msg_id
              ? ' Just closing the loop on a message from someone whose session has ended? ' +
                'coord:ack { msg_id } never requires the original sender to still be in the ' +
                'roster — use it instead of a manual related_msg_id reply.'
              : '') +
            (otherValidCount > 0
              ? ` ⚠ This send named ${otherValidCount} OTHER, VALID recipient(s) alongside the bad ` +
                'address(es) below — they received NOTHING either (all-or-nothing by design: one ' +
                'message, one atomic delivery). If they need this now, resend to just the valid ' +
                'ids, or use `items:[{ to, summary, … }]` to address recipients independently so ' +
                "one bad id can't block the rest."
              : '') +
            roleHint,
          ...(trulyUnknown.length ? { unknown_recipients: trulyUnknown } : {}),
          ...(trulyAmbiguous.length ? { ambiguous_recipients: trulyAmbiguous } : {}),
        };
      }
      toSend = [...r.resolved, ...resolvedAmbiguousReplySender, ...goneRepliedTo];
    } catch (e) {
      console.warn(`[coord:send] recipient resolve failed, sending unresolved: ${e instanceof Error ? e.message : e}`);
    }
  }

  // H2 (coord-authority-hardening P-004): resolve the sender's relay reference
  // into a platform-verified provenance stamp — server-side, zero extra sender
  // calls (the reference rides the send itself). A dangling tier-1 msg_id
  // REFUSES the message (loud beats laundering a reference nobody can verify);
  // everything else fail-softs to a stamped-but-unverified delivery.
  let relayStamp: RelayProvenanceStamp | null = null;
  if (msg.relayOf || msg.relayQuote) {
    const r = await resolveRelayProvenance(identity, {
      relayOf: msg.relayOf,
      relayQuote: msg.relayQuote,
    });
    if (r.error) {
      return {
        ok: false,
        to: msg.to,
        error: r.error,
        message:
          `relayOf '${msg.relayOf}' matches no coord message — nothing was sent. Pass the ` +
          `ORIGINAL's msg_id (from your inbox/feed line), the 'owner-turn' sentinel for the ` +
          `human turn you are answering, or relayQuote with a verbatim snippet of it.`,
      };
    }
    relayStamp = r.stamp;
  }

  // EI-279: persist the wake intent ON the envelope so it federates — a recipient
  // homed on a REMOTE instance is woken by the coord-message projection's fan when
  // the row arrives there (the local fan below only covers THIS instance's await
  // store). coord-wake-on-reply: ALSO persist `wakeOnReply:true` when this directed
  // send opted in, so a FUTURE reply (which looks the original up by msg_id) can see
  // the opt-in and wake us back. Both keys merge onto the persisted envelope.
  const extra: Record<string, unknown> = {};
  if (relayStamp) extra[RELAY_PROVENANCE_FIELD] = relayStamp;
  // P-006: verify + stamp announced-gate refs at send (fail-soft — a store
  // hiccup stamps 'unknown', never blocks; the EXACT key always travels).
  if (msg.gateRefs?.length) {
    try {
      const gateStamps = await resolveGateRefStamps(msg.gateRefs);
      if (gateStamps.length) extra[GATE_REFS_FIELD] = gateStamps;
    } catch {
      /* fail-soft: gate stamping never blocks a send */
    }
  }
  // P-008: the sender's body-auto-ref opt-out rides the envelope so DELIVERY
  // (the receiver's inbox seam + renderer) honors it — no receiver-side config.
  if (msg.noBodyRefs) extra[BODY_REFS_OPT_OUT_FIELD] = true;
  // agent-report-cards P-001: the NORMALIZED report block rides the envelope
  // (non-reserved key — survives the merge + readInbox). The plans:attention
  // coord-message source stamps it onto the inbox item, which renders it as a
  // 📋 ReportBlockCard in the owner's Inbox detail pane.
  if (reportBlock) extra.report = reportBlock;
  // P-006: server-authored proof that this exact delivered envelope contains
  // all four normalized fields for the sender's CURRENT GOAL subject. Readers
  // trust this stamp (or their explicitly bounded legacy compatibility arm),
  // never the mere fact that a message reached the human.
  if (goalOwnerReport) extra[GOAL_OWNER_REPORT_FIELD] = goalOwnerReport;
  if (goalOwnerReportDiagnostic) {
    extra.goalOwnerReportValidation = goalOwnerReportDiagnostic;
  } else if (goalOwnerReportWarning) {
    extra.goalOwnerReportValidation = { status: 'unknown', reason: goalOwnerReportWarning };
  }
  // P-013: the declared side effect rides the envelope so the ACTUATION probe
  // (directive-effect.ts, read by fleet:leader-brief) can find it later without a
  // side table. Deliberately NOT normalized against live state at send time: the
  // whole point is that the verdict is measured LATER, against this message's ts.
  if (msg.expectEffect) {
    extra.expectEffect = {
      kind: msg.expectEffect.kind,
      itemId: msg.expectEffect.itemId,
      ...(msg.expectEffect.harness ? { harness: msg.expectEffect.harness } : {}),
    };
  }
  // P-010 (H5b): persist the CONSCIOUS hive-wide claim on the envelope — the
  // durable trace the allhive-broadcast-sweep detector keys on. A plain
  // non-fleeted sender's bare '*' is NOT stamped (routine traffic, live data:
  // hundreds/day) — only the explicit allHive:true override is.
  if (bcast?.allHive) extra[ALLHIVE_BROADCAST_FIELD] = true;
  if (wakeMode) extra.wake = true;
  if (effectiveWakeOnReply) extra.wakeOnReply = true;
  // WI-4553: unanswered-directed must use sender INTENT, not the absence of a reply,
  // to infer an obligation. D-048 keeps that principle and removes the derivation that
  // undermined it: `expectsReply` is now computed from the REQUIRED `expects`, never
  // taken from the caller and never inferred from wake/replyDeadlineSec.
  //
  // Both keys ride the persisted envelope on purpose:
  //   • `expectsReply` — because unanswered-directed.ts (`body->>'expectsReply' = 'true'`)
  //     and the delivery ladder already read it. D-048 is an INPUT-surface change, not a
  //     consumer migration; every existing reader keeps working untouched.
  //   • `expects` — the 4-valued intent those consumers can graduate to (an 'ack' that
  //     never arrives is a different obligation from an unanswered 'answer').
  const expectsReply = msg.expects !== 'none';
  extra.expects = msg.expects;
  // P-032 / D-064 (reopened by D-070). The envelope/section boundary is checked
  // BEFORE anything is persisted: `.strict()` on the section schema already
  // rejects unknown keys, but an ENVELOPE field on a section gets the typed
  // refusal that teaches the split instead of a generic "unrecognized key".
  if (Array.isArray(msg.body)) assertEnvelopeSectionSplit(msg.body);
  const sections = toSections(msg.body);
  // P-008 last leg / D-084: `basedOn` — the sender's information provenance,
  // DERIVED from what it actually read (the invocation log), never authored
  // (D-002's never-author economics; it is not a caller argument at all).
  //
  // ⚠ THE `.catch` IS LOAD-BEARING, not belt-and-braces. `deriveBasedOn` already
  // swallows its own failures, so this only fires if the derivation throws in a
  // way it did not anticipate — and the consequence of letting that propagate is
  // that the MESSAGE IS NOT SENT. A decorative trace must never be able to fail
  // the delivery it decorates: the availability coupling that turns one PG blip
  // into fleet-wide silence is the same one D-079's `unresolved` condition exists
  // to prevent on the completion gate. A send with no provenance is fine; a
  // provenance failure that eats a message is not. (Caught live by the wiring
  // test below, which the first cut of this failed.)
  const basedOn = await deriveBasedOn({
    ownerId: identity.ownerId,
    workspaceId: identity.workspaceId ?? '',
    harness: harnessSlug,
  }).catch(() => []);
  const fieldStamp = stampMessageFields({
    body: msg.body,
    why: msg.why,
    blocking: msg.blocking,
    basedOn,
  });
  // Only the fields that CARRY something ride the envelope — a plain-string send
  // stays byte-identical on the wire, so the n=1 case costs nothing.
  if (fieldStamp.sections) extra.sections = fieldStamp.sections;
  if (fieldStamp.premisesClassified) extra.premisesClassified = fieldStamp.premisesClassified;
  // P-011 / WI-6731: RESOLVE the cited premises — the falsifiable half of the
  // field. `premisesClassified` above only says what SHAPE each ref is; nothing
  // has ever answered "does it resolve, and is the claim still true?".
  //
  // It runs AT SEND for the same reason the coupling diff does: `broken` means
  // the sender was wrong AT SEND TIME (a `#completion` on an open item), and a
  // later pass cannot recover that — the item may since have completed, turning
  // a real error into a clean record. Only this moment can tell `stale` (ground
  // moved, re-read) from `broken` (ground was never there, correct the sender),
  // and that distinction is the whole recipient affordance (D-090: justify the
  // field by what a RECIPIENT can DO with it).
  //
  // Refs are flattened across sections and resolved in ONE pass, which is also
  // what de-dupes a ref cited in two sections down to a single probe; the
  // resolver caps at PREMISE_STAMPS_MAX and skips every non-invalidatable ref
  // before any IO. NO extra cost gate: measured 30h load is ~13 probes total
  // (WI-6731), so a second gate would guard a load that does not exist.
  const classifiedPremises = fieldStamp.premisesClassified;
  if (classifiedPremises?.some((s) => s.length > 0)) {
    try {
      const stamps = await resolvePremiseStamps(
        classifiedPremises.flat().map((c) => c.ref),
        premiseProbes({ harnessSlug, workspaceId: identity.workspaceId }),
      );
      // ALL stamps ride, not just the failures. `failingPremises()` is the
      // READER's filter and stays exported for that; baking it in here would
      // discard the denominator, and "2 broken" cannot be read without "out of
      // how many" — the aggregate read D-090 R3 mandates needs both.
      if (stamps.length) extra[PREMISE_STAMPS_FIELD] = stamps;
    } catch {
      /* fail-soft: premise stamping never blocks a send */
    }
  }
  // D-089 / WI-6685: score each `forYouBecause` against the coupling graph AS IT
  // STANDS NOW. This is the only moment the comparison is meaningful — the graph
  // is live state (locks release, awaits fire), so a later pass over the message
  // log could only ever answer 'not-comparable'. Gated on the divergence rule
  // table before any IO, so a message whose relations are all `owns`/`other`
  // (the majority) costs nothing; fail-soft, like every other stamp here.
  if (fieldStamp.sections) {
    const divergence = await resolveCouplingDivergenceStamps({
      selfOwnerId: identity.ownerId,
      to: toSend,
      sections: fieldStamp.sections,
      workspaceId: identity.workspaceId,
      harnessSlug,
      // P-009: the census rides the derivation that ALREADY happens here — no
      // extra IO, no second coupling path.
      //
      // ⚠ THIS SAMPLES ~1.5% OF SENDS — it is NOT a census OF sends, and the
      // earlier claim here that it is "the only coupling read that runs at
      // volume" was wrong in the way that matters. `observe` is reached only
      // PAST resolveCouplingDivergenceStamps' cost gate, which returns before
      // any IO unless the message carries a COMPARABLE `forYouBecause` (never
      // `owns`/`other`) addressed to a NON-SELF peer. Measured 2026-08-10 over
      // 7d of coord_event_log (13,633 messages): 628 carry forYouBecause at all
      // (4.6%), and of 737 asserted relations 525 (71%) are owns/other —
      // leaving ~212, i.e. ~1.5% of sends, that can ever reach this sink.
      //
      // That is still ~30 FULL censuses/day (each observation covers all four
      // legs, whichever relation opened the gate), which is enough to answer
      // "has this leg EVER fired in production". But the sample is deliberately
      // biased toward senders who assert checkable relations, so: never read a
      // census count as a send count, and never read leg silence HERE as proof
      // that leg is dead fleet-wide — absence in a 1.5% biased sample is not
      // absence. Verified the hard way: a probe send with no forYouBecause,
      // addressed to self, produced a tool_invocations row with no census and
      // looked exactly like a broken sink.
      ...(observeCensus ? { observe: observeCensus } : {}),
    });
    if (divergence.length) extra[COUPLING_DIVERGENCE_FIELD] = divergence;
  }
  // P-011 (state-plane-adoption-2026-08-02): stamp stale-value QUOTING — a
  // section that cites a registered cell's identity while the sender's
  // invocation log holds no fresh read of that cell's door this turn. Same
  // seam contracts as the stamps above: pure gate before IO, fail-soft, ALL
  // detections ride (the aggregate read needs the denominator), and per D-090
  // this is data about the fleet's habits, never a per-sender nag.
  // The scan must see ALL section texts — including the single plain-text
  // section stampMessageFields deliberately leaves off the envelope (its
  // `authored || length > 1` guard is persistence weight, not scan
  // eligibility). A one-section text body is the dominant message shape;
  // gating the scan on fieldStamp.sections silently exempted it (caught by
  // the send.test.ts wiring pin, state-plane-adoption-2026-08-02 C5).
  const staleQuoteSections = fieldStamp.sections ?? (Array.isArray(msg.body) ? msg.body : undefined);
  if (staleQuoteSections) {
    try {
      const staleQuoteStamps = await resolveStaleQuoteStamps({
        selfOwnerId: identity.ownerId,
        sections: staleQuoteSections,
        workspaceId: identity.workspaceId,
      });
      if (staleQuoteStamps.length) extra[STALE_QUOTE_FIELD] = staleQuoteStamps;
    } catch {
      /* fail-soft: stale-quote stamping never blocks a send */
    }
  }
  if (fieldStamp.why) extra.why = fieldStamp.why;
  if (fieldStamp.blocking !== undefined) extra.blocking = fieldStamp.blocking;
  if (fieldStamp.basedOn) extra.basedOn = fieldStamp.basedOn;
  const staleBasisStamps = staleBasis(basedOn);
  if (staleBasisStamps.length) extra[STALE_BASIS_FIELD] = staleBasisStamps;
  // coord-derived-fields-2026-08-31 P-004 (D-003's derived half): the sender's
  // REGISTERED waits — active events:await registrations + set_blocker records
  // on held items — stamped like basedOn: session property, envelope-level,
  // fail-soft (the .catch is load-bearing for the same reason deriveBasedOn's
  // is: a decorative stamp must never fail the delivery it decorates). Named
  // `awaiting`, NOT blockedOn: the authored per-section field is the sender's
  // claim about a statement; this is a machine observation about the session.
  const awaiting = await deriveAwaiting({
    ownerId: identity.ownerId,
    workspaceId: identity.workspaceId ?? '',
  }).catch(() => []);
  if (awaiting.length) extra.awaiting = awaiting;
  // EI-19395608899173941: a wake-pump can interleave a turn between the moment a claim
  // was measured and the moment it is sent — the filed case measured `git status`
  // truthfully at 00:55Z and sent it at 01:40Z, telling five agents a peer's landed work
  // was unlanded. `cellHint` could not catch it (working-tree status is not cell-backed)
  // and neither could an age check over `basedOn` (30m window; the measurement was 45m
  // old). Stamped like `awaiting`: a machine OBSERVATION about the session, envelope
  // level, fail-soft. It reports a measured gap and never guesses which sentence is
  // stale — an inference about the prose is the EI-10949 hazard `cellHint` avoids.
  const draftSuspension = await deriveDraftSuspension({
    ownerId: identity.ownerId,
    workspaceId: identity.workspaceId ?? '',
  }).catch(() => null);
  if (draftSuspension) extra[DRAFT_SUSPENSION_FIELD] = draftSuspension;
  // Completion claims are additive evidence, never a refusal. If the message
  // names a plan/work-item/rubric as completed but the sender's recent read
  // trace contains no corresponding artifact, preserve that contradiction on
  // the envelope so recipients can challenge the claim without re-running the
  // sender's session history.
  const completionMismatch = completionClaimMismatch({
    summary: msg.summary,
    body: msg.body,
    planSlug: msg.plan_slug,
    basedOn,
  });
  if (completionMismatch) extra[COMPLETION_CLAIM_MISMATCH_FIELD] = completionMismatch;
  // P-033: ride the envelope so a reader (and the D-070 adoption measurement)
  // can tell an owner-GUI-derived value from an agent-authored one. Without
  // this stamp the derived defaults would silently inflate every adoption
  // number this plan is judged on — the P-029 failure, mechanised.
  // D-084 R5: `basedOn` is 100% DERIVED, so it is stamped as such for the same
  // reason the GUI's defaults are — an adoption measurement that counted a
  // machine-derived field as sender intent would inflate exactly the numbers
  // this plan is judged on (the P-029 failure, mechanised).
  const provenance: Record<string, string> = {
    ...(msg.fieldProvenance ?? {}),
    ...(fieldStamp.basedOn ? { basedOn: 'session-derived' } : {}),
    ...(awaiting.length ? { awaiting: AWAITING_DERIVED_PROVENANCE } : {}),
    ...(draftSuspension ? { [DRAFT_SUSPENSION_FIELD]: DRAFT_SUSPENSION_DERIVED_PROVENANCE } : {}),
  };
  if (Object.keys(provenance).length) {
    extra.fieldProvenance = provenance;
  }
  // EI-8986: stamp an absolute deadline (epoch ms) so the reply-deadline-sweep
  // (dbos/periodic-workflows.ts) can select it with a simple `<= now` compare —
  // no need to re-derive "elapsed since send" from `ts` at sweep time. Positive
  // finite seconds only; a bad value is silently dropped rather than failing
  // the send (this is a best-effort nudge, never a hard requirement).
  if (typeof msg.replyDeadlineSec === 'number' && Number.isFinite(msg.replyDeadlineSec) && msg.replyDeadlineSec > 0) {
    // Math.round: the zod arg allows FRACTIONAL seconds, but the sweep (and the
    // 536 partial index) cast this field `::bigint` — a fractional stamp like
    // 1752119999999.1 would fail that cast at sweep time. Integer ms always.
    extra.replyDeadlineAt = Math.round(Date.now() + msg.replyDeadlineSec * 1000);
  }
  // P-008 (cross-machine-coord-parity): a FEDERATED, DIRECTED, required-wake
  // send requests a DELIVERY RECEIPT — the receiving machine's projection sends
  // back a fed-event `coord:receipt:<msg_id>` when it applies the row (payload:
  // woken count + machine). The result carries `receiptEvent`; await it
  // (events:await) to close the cross-machine wake-honesty loop.
  const wantReceipt = wakeMode === 'required' && isDirected(msg.to) && Boolean(harnessSlug);
  if (wantReceipt) extra.receipt = true;
  // P-003 (queen-fleet-authority-boundary): a fleet leader's / Queen's BROADCAST
  // (a "status send") carries the sender's structured authority + scope, so a
  // recipient reads a leader's fleet-scoped blast as fleet-leader→fleet-members and
  // never mistakes it for a hive-wide Queen directive. Resolved by the caller only
  // for broadcasts; a directed 1:1 send is left unstamped (no noise).
  if (cueAuthority) extra[CUE_AUTHORITY_FIELD] = cueAuthority;
  const bodyText = sections.length ? sectionsToText(sections) : undefined;
  const bodyDelivery = senderBodyDeliveryDiagnostics(bodyText);
  // EI-21860312102671987: bound the persist so a saturated/wedged DB call
  // THROWS a decisive DbCallDeadlineError instead of hanging past the
  // caller's own ~60s client timeout with no result ever produced. The throw
  // is handled by the EXISTING, tested exception path one level up (`runBulk`
  // in _bulk.ts, exercised by the "a delivery exception is surfaced at the
  // envelope level" test below) — it already turns a thrown send exception
  // into { ok:false, to, error: message } plus a loud `deliveryFailureWarning`
  // on the envelope. Deliberately NOT re-caught/reshaped here: that would
  // diverge from the one established, tested shape every other sendMessage
  // failure (e.g. a PG lock-timeout) already reports through.
  // A client disconnect or request deadline can fire while the per-message
  // enrichment above is still running. Check at the durable-write boundary so
  // that work cannot append a message after its caller has stopped waiting.
  if (requestSignal?.aborted) {
    return {
      ok: false,
      to: msg.to,
      error: 'request_aborted',
      message: 'coord:send was aborted before persistence; the message was not appended.',
    };
  }
  let env: Awaited<ReturnType<typeof sendMessage>>;
  try {
    env = await withDbCallDeadline(
    sendMessage(identity, {
      to: toSend,
      ...(goalReportVerdict.kind === 'reference' ? { persistEnvelope: goalReportVerdict.persistEnvelope } : {}),
      ...(idempotencyKey !== undefined && itemIndex !== undefined
        ? { msgId: idempotentCoordMsgId(identity, harnessSlug, idempotencyKey, itemIndex) }
        : {}),
      summary: msg.summary,
      // The TEXT projection of the sections. `env.body` stays a plain string so
      // coord:inbox / coord:read / the [coord+N] injection / coord:thread / the
      // pui pane are unchanged; the structure rides `extra.sections` beside it.
      body: bodyText,
      files: msg.files,
      plan_slug: msg.plan_slug,
      related_msg_id: relatedMsgIdForSend,
      ...(expectsReply ? { expectsReply: true } : {}),
      // WI-3653: pass the resolved scope THROUGH, including the explicit-local
      // null — omitting it would re-trigger sendMessage's AUTO default and defeat
      // scope:'local'.
      harnessSlug,
      // H5a (P-002): tell the seam invariant the stamp is ALREADY resolved (null =
      // "resolved, none") so sendMessage doesn't re-pay the presence/fleet reads
      // this tool just did for its own down-scope/stamp pass.
      cueAuthorityResolved: cueAuthority ?? null,
      ...(Object.keys(extra).length ? { extra } : {}),
    }),
    { ms: COORD_SEND_DB_DEADLINE_MS, label: 'coord:send.sendMessage' },
    );
  } catch (error) {
    // The transaction can invalidate a successful preflight. Keep the failed
    // oracle visible on reference refusals, just as on preflight refusals.
    if (goalReportVerdict.kind === 'reference') {
      const failure = error as { code?: string; oracle?: string; message?: string };
      return { ok: false, to: msg.to, error: failure.code ?? 'goal-owner-report-untruthful',
        oracle: failure.oracle ?? 'delivery-transaction', message: failure.message };
    }
    throw error;
  }

  // EI-6874 (zero-recipient audience send is a refusal-class event, not a silent
  // ok): a LIVE-audience selector (@fleet:/@fleet-leader:/@topic:/@plan:/@object:/
  // @file:) resolves to a set of live recipients at send time; sendMessage's
  // `env.to` IS that expanded set (empty ⇒ nobody). A SLOT selector
  // (@role:/@wave:/@feature:/@user:) legitimately parks for a future agent, so a
  // zero there is expected and NOT a miss — those are excluded here.
  //
  // The incident: fleet p2p-dist's leader sent a drain order to @fleet:p2p-dist,
  // but all 4 members were launched without fleet registration (fleetSlug:null),
  // so the audience resolved to ZERO live members and coord:send returned a SILENT
  // ok:true — the leader then sat ~3h "awaiting compliance acks" nobody could send.
  // We now report recipients_resolved for every audience-selector send and surface
  // a LOUD zero_recipients warning when it reached nobody. An EXPLICIT audience
  // selector reaching nobody is a hard refusal (ok:false); an AUTO-scoped
  // '*'→@fleet broadcast (bcast.scoped — e.g. a solo/quiet fleet) is a soft warning
  // that keeps ok:true. The row still persisted above (audience history /
  // coord:catch-up), so env.msg_id is returned either way.
  const audienceSelectors = msg.to.filter((t) => t.startsWith('@') && parseSlotSelector(t) === null);
  // `expandAudience` deliberately preserves only concrete recipients on the
  // envelope. Keep the selectors that resolved to no one alongside that
  // envelope out-of-band so a valid recipient cannot hide a partial audience
  // miss (especially an unregistered @fleet-leader).
  const unresolvedSelectors = [...getUnresolvedAudienceSelectors(env)].filter((selector) =>
    audienceSelectors.includes(selector),
  );
  let unresolvedAudience: { selectors: string[]; note: string } | undefined;
  if (unresolvedSelectors.length > 0) {
    const leaderSelector = unresolvedSelectors.some((s) => s.startsWith('@fleet-leader:'));
    const note = leaderSelector
      ? `coord:send audience ${unresolvedSelectors.join(', ')} resolved to ZERO live recipients. ` +
        'No current registered fleet leader matched the selector — the named fleet may be absent, or ' +
        'an active member may be acting as leader without registered leadership. Verify fleet:status ' +
        'and register the leader with fleet:take-leadership before relying on this route.'
      : `coord:send audience ${unresolvedSelectors.join(', ')} resolved to ZERO live recipients while ` +
        'other recipients were addressed. The selector was not expanded through a fallback audience; ' +
        'verify its subscribers or live presence before assuming the whole audience received the message.';
    unresolvedAudience = { selectors: unresolvedSelectors, note };
  }
  let unreachableAudienceWarning: { selectors: string[]; ownerIds: string[]; note: string } | undefined;
  let zeroRecipients: { selectors: string[]; note: string } | undefined;
  if (audienceSelectors.length > 0 && env.to.length === 0) {
    const isFleet = audienceSelectors.some((s) => s.startsWith('@fleet:') || s.startsWith('@fleet-leader:'));
    // EI-18772330418885814: a `@file:` zero is the one that gets MISREAD as a
    // clearance to edit ("nobody is on this file"). Say what was actually checked —
    // and name the lock plane as the authority — so a reader never treats a coord
    // audience miss as proof the file is free.
    const isFile = audienceSelectors.some((s) => s.startsWith('@file:'));
    const hint = isFleet
      ? ' A fleet selector with no live members usually means the members were launched WITHOUT fleet registration (the EI-5835 --fleet trap: fleetSlug:null) — verify via coord:roster that each member row carries the fleetSlug, or address the members by ownerId directly.'
      : isFile
        ? ' No live agent has declared this file (coord:declare-intent { current_files }) NOR holds/awaits a file-lock on it. This is an AUDIENCE miss, not a clearance to edit: the lock plane is the authority on who is on a file — confirm with locks:queue { paths } before editing, and rely on your acquire being refused rather than on this answer.'
        : ' Nobody currently subscribes to / is present on this audience; the row persisted to audience history, so a later joiner can still catch up via coord:catch-up.';
    const note =
      `coord:send audience ${audienceSelectors.join(', ')} resolved to ZERO live recipients — ` +
      `the message reached NOBODY live.` +
      hint;
    // Hard refusal for an EXPLICIT audience selector; an auto-scoped '*'→@fleet
    // broadcast to an empty/solo fleet is a soft warning (the sender intended a
    // broadcast, not a targeted directive), so keep ok:true and fall through.
    if (!bcast?.scoped) {
      return {
        ok: false,
        to: env.to,
        msg_id: env.msg_id,
        ts: env.ts,
        error: 'zero_recipients',
        recipients_resolved: 0,
        zero_recipients: { selectors: audienceSelectors, note },
        message: note,
      };
    }
    zeroRecipients = { selectors: audienceSelectors, note };
  }

  // EI-22180848452883121 — the REAPED-recipient miss, which every check above is
  // structurally blind to because they all key off cardinality ZERO.
  //
  // `@fleet-leader:` resolves through the durable fleet registry, deliberately NOT
  // liveness-gated so an escalation still lands in an offline lead's inbox. But the
  // registry pointer is not invalidated when that session is REAPED, so the selector
  // resolved to one id, `env.to.length` was 1, and every miss-signal was bypassed:
  // the caller got ok:true / recipients_resolved:1 for a message nobody will ever
  // read. Worse than silence — an agent checking the result (the RIGHT habit) reads a
  // positive integer as delivery.
  //
  // The line drawn here is REAPED ≡ ZERO, and merely-offline ≠ zero. An ended-but-
  // recorded session still owns a durable inbox to come back to, which is exactly what
  // the liveness-independent resolution is FOR; a reaped id owns nothing. So this
  // changes no delivery — it reclassifies an outcome that was already a non-delivery.
  const unreachableAudience = getUnreachableAudienceSelectors(env).filter((u) =>
    audienceSelectors.includes(u.selector),
  );
  if (unreachableAudience.length > 0) {
    const reapedIds = [...new Set(unreachableAudience.flatMap((u) => u.ownerIds))];
    const reachedAnyone = env.to.some((id) => !reapedIds.includes(id));
    const selectors = unreachableAudience.map((u) => u.selector);
    const leader = selectors.some((s) => s.startsWith('@fleet-leader:'));
    // The repair leads, then the evidence (P-002 preserve-the-imperative): an agent
    // reading only the first sentence still learns the message did not land.
    const note =
      `coord:send audience ${selectors.join(', ')} resolved ONLY to REAPED session(s) ` +
      `(${reapedIds.join(', ')}) — the message reached NOBODY and no inbox will ever be read. ` +
      'This is NOT the same as an offline recipient: a reaped id has no session row at all, so ' +
      'the durable-inbox guarantee that makes this selector liveness-independent does not apply. ' +
      (leader
        ? "The fleet registry's leader pointer is stale — it still names a session that has been " +
          'reaped. Re-read the CURRENT leader with fleet:status / coord:presence (read fleetRole + ' +
          'sessionState), address that ownerId directly, and have the live leader register with ' +
          'fleet:take-leadership so the pointer stops naming a dead session.'
        : 'Re-resolve the audience against coord:presence and address the live ownerIds directly.');
    if (!reachedAnyone) {
      // Same disposition as an explicit selector reaching zero live recipients: a hard
      // refusal, so the caller's existing miss-handling ladder engages instead of being
      // handed a success receipt. The row still persisted (audience history /
      // coord:catch-up), so msg_id is returned exactly as the zero_recipients path does.
      return {
        ok: false,
        to: env.to,
        msg_id: env.msg_id,
        ts: env.ts,
        error: 'recipients_unreachable',
        recipients_resolved: 0,
        recipients_unreachable: { selectors, ownerIds: reapedIds, note },
        message: note,
      };
    }
    // Some live recipient WAS addressed, so the send stands — but a valid recipient
    // must never hide a reaped one (the same reasoning as unresolvedAudience above).
    unreachableAudienceWarning = { selectors, ownerIds: reapedIds, note };
  }

  // P-003 (fleet-lead-instrumentation-audit-2026-08-09): a PARTIAL fleet delivery used
  // to be indistinguishable from a total one — measured live, a `['*']` fleet broadcast
  // returned counts:{ok:1,failed:0} with recipients_resolved:6 against an 11-row roster
  // and nothing said the other 5 were dropped. `recipients_resolved` alone cannot carry
  // this: it is a count of who WAS reached, and no count can express who was not.
  //
  // Fail-soft and diagnostic-only — it never changes delivery. NB an EMPTY/absent list
  // means "no omissions known", NOT "nobody was dropped": a host without the resolver,
  // or a roster read that threw, both land here. Saying so is the point of the whole item.
  let fleetOmitted: FleetAudienceOmission[] | undefined;
  const fleetSelectors = audienceSelectors.filter((s) => s.startsWith('@fleet:'));
  if (fleetSelectors.length > 0) {
    try {
      const { hostAudienceResolvers } = await import('../audience-host');
      const explain = hostAudienceResolvers.explainFleetAudience;
      if (explain) {
        const seen = new Set<string>();
        const collected: FleetAudienceOmission[] = [];
        for (const sel of fleetSelectors) {
          const slug = sel.slice('@fleet:'.length).trim();
          if (!slug) continue;
          for (const o of await explain(slug)) {
            // A member dropped from two fleet selectors in one send is ONE omission.
            if (seen.has(o.ownerId)) continue;
            seen.add(o.ownerId);
            collected.push(o);
          }
        }
        if (collected.length > 0) fleetOmitted = collected;
      }
    } catch {
      /* diagnostics must never fail a send that already delivered */
    }
  }

  // Reply-wake (coord-wake-on-reply): if THIS send is a REPLY (it carries a
  // related_msg_id), look the ORIGINAL message up by that id and — when the
  // original opted into wake-on-reply — fire an OPTIMISTIC wake back to its
  // sender so they re-invoke the moment our reply lands. Fully fail-soft: ANY
  // error (lookup miss, sql hiccup, wake failure) is swallowed and NEVER fails
  // or blocks this send (the reply already persisted above). Never self-wakes and
  // never wakes '*'/'human'. Skipped entirely when the flag is OFF.
  let replyWake:
    | {
        target: string;
        /** Durable wake deliveries matched/queued; not execution-confirmed. */
        queued: number;
        /** Legacy queue-count alias retained for callers that predate `queued`; not pickup-confirmed. */
        woken: number;
        /** False until a later checkpoint/activity observation proves pickup. */
        pickupConfirmed?: boolean;
        foldedIntoDirectedWake?: boolean;
        suppressed?: boolean;
        suppressionReason?: string;
      }
    | undefined;
  if (wakeOnReplyFlag && relatedMsgIdForSend) {
    try {
      // WI-5072: the send-time validation above already fetched the original;
      // re-fetch only in the rare fail-soft path where that lookup errored.
      const original = relatedOriginal ?? (await getMessageById(relatedMsgIdForSend));
      const originalFrom = original?.from;
      const optedIn = original != null && (original as { wakeOnReply?: unknown }).wakeOnReply === true;
      const expectedLifecycleAck = readExpectedLifecycleAck(original as Record<string, unknown> | null);
      if (
        optedIn &&
        typeof originalFrom === 'string' &&
        originalFrom &&
        originalFrom !== identity.ownerId &&
        !isSelectorOrWildcard(originalFrom)
      ) {
        // EI-22793047903392160: `related_msg_id` proves the thread edge, but it
        // does not change this send's explicit audience. A caller can carry a
        // prior message id while addressing a different owner (for example, a
        // status update in the same work thread); waking the prior sender in
        // that shape is a misrouted inbox-wake. The reply-wake target must be
        // one of this message's resolved recipients. Report the suppression so
        // the sender can see why no second wake was emitted.
        if (!env.to.includes(originalFrom)) {
          replyWake = {
            target: originalFrom,
            queued: 0,
            woken: 0,
            pickupConfirmed: false,
            suppressed: true,
            suppressionReason: 'original_sender_not_recipient',
          };
        } else if (expectedLifecycleAck) {
          // A wind-down cue deliberately asks members to leave a durable ack.
          // Preserve that ack row/thread, but do not re-invoke the leader whose
          // loop was just ended. The marker is validated and narrowly scoped;
          // malformed/unknown markers follow the ordinary reply-wake path.
          replyWake = {
            target: originalFrom,
            queued: 0,
            woken: 0,
            pickupConfirmed: false,
            suppressed: true,
            suppressionReason: 'expected_lifecycle_ack',
          };
        } else {
          // EI-14760: the deliver-and-wake fan below (env.to, when wake:true) is the
          // AUTHORITATIVE wake for a directed recipient. When the wake-on-reply target is
          // ALSO a directed-wake recipient — the common A→B, then B replies-to-A-with-wake
          // back-and-forth — firing HERE too fans the SAME recipient's inbox-wake key a
          // second time, queuing a duplicate wake delivery for ONE message and burning a
          // redundant wake-pump turn on content already delivered (EI-14760: two
          // deliveries #22831/#22832 on the same await, ~31ms apart, for one send). Skip
          // the redundant fire when originalFrom is already in env.to (still reported,
          // folded, so the dedup stays observable); fire normally otherwise — an
          // inject-only send (wakeMode null), or a reply whose original sender is NOT a
          // recipient of this message, still needs the reply-wake.
          if (wakeMode != null && env.to.includes(originalFrom)) {
            replyWake = {
              target: originalFrom,
              queued: 0,
              woken: 0,
              pickupConfirmed: false,
              foldedIntoDirectedWake: true,
            };
          } else {
            const fan = await wakeRecipients([originalFrom], {
              summary: msg.summary,
              source: identity.ownerId,
              workspaceId: identity.workspaceId ?? undefined,
              // EI-18663224517726594: carry THIS message's own msg_id in the wake
              // payload so a woken agent can thread a further reply
              // (related_msg_id) without a separate coord:inbox round-trip just to
              // recover an id they were already delivered the content of.
              payload: { msg_id: env.msg_id },
            });
            const queued = fan.queued ?? fan.woken;
            replyWake = { target: originalFrom, queued, woken: queued, pickupConfirmed: false };
          }
        }
      }
    } catch {
      /* fail-soft: a reply-wake miss/error never blocks the (already-persisted) send */
    }
  }

  // endTurn (coord-end-turn P-002): ESC each addressed recipient's CURRENT turn BEFORE the wake. A turn
  // STUCK on an API error is NOT sleeping on its inbox-wake key, so a plain wake reaches nobody (woken:0);
  // the ESC ends the dead turn → the CLI returns to idle + re-arms its watch → the wake below starts a
  // fresh turn with this message. Force-ESC reuses turn:interrupt's audit + storm rate-limit; skips
  // '*'/'human'/self. Then SETTLE so the wake doesn't race the abort (D-003).
  let endTurn: { ended: string[]; missed: string[] } | undefined;
  if (msg.endTurn) {
    const targets = env.to.filter((id) => id !== '*' && id !== 'human' && id !== identity.ownerId);
    const ended: string[] = [];
    const missed: string[] = [];
    for (const owner of targets) {
      try {
        const r = await forceEndTurn({
          actor: identity.ownerId,
          workspaceId: identity.workspaceId ?? '*',
          owner,
          reason: msg.summary,
        });
        (r.ok ? ended : missed).push(owner);
      } catch {
        missed.push(owner);
      }
    }
    // EI-19412221266350408: a pty-force ESC can report ok:true against a control socket whose
    // underlying agent SESSION has already reached a terminal state (e.g. the launcher process
    // outlived its session — a zombie launcher) — the keystroke channel itself works, but nothing
    // is listening on the other end. That reads as "I force-ESC'd it, it should recover now" while
    // the recipient never received anything, and directly contradicts the wake leg's own
    // recipient_dead verdict for the SAME owner in the SAME call. Cross-check `ended` against the
    // identical liveness oracle the wake leg's recipient_dead uses (reportIdleRecipients — genuinely
    // no live session watching the inbox-wake key), and reclassify any confirmed-dead target as
    // `missed` instead of `ended` — endTurn now shares the wake leg's liveness verdict rather than
    // trusting the ESC channel's own success report alone.
    if (ended.length > 0) {
      try {
        const { idle: deadDespiteEsc } = await reportIdleRecipients(ended, {
          workspaceId: identity.workspaceId ?? undefined,
        });
        for (const owner of deadDespiteEsc) {
          const i = ended.indexOf(owner);
          if (i !== -1) {
            ended.splice(i, 1);
            missed.push(owner);
          }
        }
      } catch {
        /* fail-soft: the liveness cross-check is an enrichment — a probe hiccup keeps the raw
         * pty-force verdict rather than failing the whole endTurn leg. */
      }
    }
    endTurn = { ended, missed };
    // Give each CLI a moment to finish ending its turn + re-arm its inbox-wake watch before we wake it.
    if (wakeMode && ended.length > 0) await new Promise((r) => setTimeout(r, ENDTURN_SETTLE_MS));
  }

  // Deliver-and-wake (P-040): the message already persisted to the inbox above
  // (the durable default). When the sender opted in, ALSO fire each addressed
  // recipient's OWN inbox-wake key so a SLEEPING addressee is re-invoked — one
  // targeted emit per ownerId, NEVER a broadcast key (P-042). We wake the
  // POST-expansion recipients (`env.to` — audience selectors already resolved),
  // so a `@plan:`/`@topic:` send wakes exactly the resolved set, not '*'.
  let wake:
    | {
        mode: 'required' | 'optimistic';
        targets: string[];
        /** Durable wake deliveries matched/queued; not execution-confirmed. */
        queued: number;
        /** Legacy queue-count alias retained for callers that predate `queued`; not pickup-confirmed. */
        woken: number;
        /** False until a later checkpoint/activity observation proves pickup. */
        pickupConfirmed: boolean;
        staged?: number;
        /** EI-19965318428068990: an explicit, non-numeric discriminant so a caller reading
         *  ONLY `queued` (the durable delivery count) cannot conflate a STAGED
         *  wake (manual wake-mode — the target is alive and wakeable, but the wake was queued
         *  for owner review instead of firing) with a genuine miss (`queued:0` is the SAME
         *  scalar for both). 'queued' = every target has a durable wake queued (staged===0);
         *  'partial-staged' = a mixed multi-target send, some queued and some staged;
         *  'staged-manual-mode' = nothing queued, everything staged (the case the finding calls out — do NOT read
         *  this as "target unreachable": release the staged wake or flip the target to auto,
         *  per `note`); 'missed' = staged===0 AND queued===0 — the pre-existing miss path
         *  (`recipient_absent`/`recipient_dead`/`recipient_alive_not_wakeable`/
         *  `recipient_remote`/`recipient_dormant_scheduled`
         *  already disambiguate further within this case); 'queued' means the durable wake
         *  delivery was queued but turn pickup is not confirmed; 'unknown' means the local wake
         *  deadline elapsed before the fire result arrived, so the underlying wake may still
         *  complete and the sender MUST verify pickup rather than treating it as absent. */
        wakeOutcome?: 'queued' | 'partial-staged' | 'staged-manual-mode' | 'missed' | 'unknown';
        /** EI-5957: the ownerIds whose wake STAGED (manual wake-mode) — named so a
         *  leader-steering send surfaces WHO didn't get the directive, alongside `note`. */
        stagedTargets?: string[];
        /** EI-202273: targets whose wake completion exceeded the local deadline. The durable
         *  inbox row exists, but the wake result is unknown because the emit may finish late. */
        timedOutTargets?: string[];
        recipient_absent?: boolean;
        /** WI-574: the subset of missed targets with NO live session watching their inbox-wake key —
         *  genuinely dead (not merely paused), so the inject has no "next turn" to be seen on and the
         *  dispatch black-holes until they are re-spawned. A LOUD miss the sender must handle. */
        recipient_dead?: string[];
        /** EI-19937974676482462: missed targets with no inbox-wake watcher that the shared
         *  liveness oracle nevertheless confirms are alive (`live`/`recorded`). They are
         *  not dead and must not be treated as relaunchable. */
        recipient_alive_not_wakeable?: string[];
        /** WI-5994: the subset of missed targets that are NOT dead — each has an
         *  ARMED engine loop with a known next fire (or a turn in flight right
         *  now), so the message is DEFERRED to that fire, never lost, and never
         *  grounds for reassignment/respawn. Disjoint from `recipient_dead`. */
        recipient_dormant_scheduled?: DormantScheduledInfo[];
        /** P-007 (cross-machine-coord-parity): missed targets homed on a REMOTE
         *  machine of this hive — not dead, elsewhere. Delivery + wake continue
         *  via federation when the send is hive-scoped (federated:true). */
        recipient_remote?: string[];
        /** P-010: the subset of recipient_remote whose presence beat is STALE —
         *  probably gone; treat like dead unless the receipt arrives. */
        recipient_remote_stale?: string[];
        /** FF#3: each missed addressee's FRESH session state (ended/parked/…) at the
         *  transfer moment — the un-ignorable "this agent ended" fact in the result. */
        recipient_liveness?: MissedRecipientLiveness[];
        note?: string;
      }
    | undefined;
  if (wakeMode) {
    const fan = await wakeRecipients(env.to, {
      summary: msg.summary,
      source: identity.ownerId,
      workspaceId: identity.workspaceId ?? undefined,
      requiredWake: wakeMode === 'required',
      // EI-21420024752195459: the platform-resolved stamp (never caller-authored
      // prose) lets an authenticated owner relay cross a target's manual pause
      // gate. Omit for ordinary/unverified sends so their wake behavior stays
      // byte-for-byte unchanged.
      ...(relayStamp ? { relayProvenance: relayStamp } : {}),
      // EI-18663224517726594 (fix option 1, preferred): a wake-pump payload
      // previously carried the message's summary/body but NOT its msg_id, so
      // answering straight from the wake — the natural, intended path — could
      // only ever produce an UNTHREADED reply (no related_msg_id available),
      // silently defeating wakeOnReply and the unanswered_directed tracking,
      // and later tripping a spurious delivery-ladder alarm at the replier.
      // Carrying msg_id here makes the correct action (thread the reply)
      // available at the moment of action instead of requiring a separate
      // coord:inbox call purely to recover an id already delivered in-body.
      // EI-20130618357432548: when the sender IS the owner's chat pane, carry the
      // owner's message verbatim so the wake can be delivered AS the turn instead
      // of wrapped in the pump's `[await-event] …` envelope (owner-chat-turn.ts
      // explains why that envelope broke both the pane's echo-absorption and the
      // recipient's reply routing). Gated on the AUTHENTICATED sender identity —
      // `identity.ownerId` is resolved server-side, never caller-supplied — so an
      // agent's own coord:send can never take this path. `msg.body` rather than
      // `msg.summary`: the composer truncates the summary to 80 chars.
      payload: {
        msg_id: env.msg_id,
        // Pass the RAW body: the GUI wrapper has already rewritten the owner's
        // string into a section array by the time it reaches here, so the helper
        // normalises both shapes rather than this call site guessing one.
        ...(identity.ownerId === ADMIN_COORD_UI_OWNER ? ownerChatWakePayloadFields(msg.body) : {}),
      },
    });
    const queued = fan.queued ?? fan.woken;
    wake = { mode: wakeMode, targets: fan.targets, queued, woken: queued, pickupConfirmed: false };
    if (fan.staged > 0) wake.staged = fan.staged;
    if (fan.timedOutTargets?.length) wake.timedOutTargets = fan.timedOutTargets;
    // EI-19965318428068990: compute the explicit discriminant BEFORE the staged-note /
    // missed-classification branches below — it depends only on the queued/staged/targets
    // counts already known here, and every branch after this point only adds detail, never
    // changes which of these buckets applies. `fan.targets.length === 0` (every addressee
    // was non-wakeable, e.g. '*'/'human' only) is left unset — there was nothing to wake,
    // which is not the "missed" case (a genuinely-addressed target that got no wake).
    if (fan.targets.length > 0) {
      wake.wakeOutcome = fan.timedOutTargets?.length
        ? 'unknown'
        : queued > 0 && fan.staged === 0
          ? 'queued'
          : queued > 0 && fan.staged > 0
            ? 'partial-staged'
            : queued === 0 && fan.staged > 0
              ? 'staged-manual-mode'
              : 'missed';
    }
    // EI-5957: a wake that STAGED (target in manual wake-mode) is NOT delivered —
    // the leader-steering failure was a quiet `staged:1` read as success while the
    // member never got the directive. Surface it LOUDLY: name the staged target(s)
    // and how to make it land (release the staged wake, or flip to auto). This does
    // NOT run when `missed` fires below (missed requires staged === 0), so the two
    // notes never collide.
    if (fan.stagedTargets.length > 0) {
      wake.stagedTargets = fan.stagedTargets;
      wake.note = buildStagedWakeNote(fan.stagedTargets);
    }
    if (fan.timedOutTargets?.length) {
      const targets = fan.timedOutTargets.join(', ');
      const timeoutNote =
        `Wake completion timed out for ${targets}; delivery is UNKNOWN because the underlying wake ` +
        'may still finish after this response. Verify pickup via coord:inbox/coord:read or the ' +
        'recipient work-item checkpoint; if a receiptEvent also times out, check coord:watermark ' +
        '({ agent, sent_ts }) for messages_shown_ts/read_through_ts before claiming the holder was nudged.';
      wake.note = wake.note ? `${wake.note} ${timeoutNote}` : timeoutNote;
    }
    const missed = fan.targets.length > 0 && queued === 0 && fan.staged === 0 && !fan.timedOutTargets?.length;
    if (missed) {
      // FF#1 — the forcing function: a 'required' miss is ALWAYS loud; an 'optimistic'
      // miss is loud UNLESS the caller consciously declared a durable backstop
      // (`backstop:'<what re-dispatches>'`). Silent-on-miss must be CLAIMED, never the
      // default — the incident was an optimistic transfer to a dead agent whose woken:0
      // was read as "fine, the backstop will get it" when there was no backstop.
      const loud = wakeMode === 'required' || !msg.backstop;
      // FF#3: force each missed addressee's FRESH session state into the result so a
      // transfer to a long-dead agent reads `ended`, not a silent woken:0. Miss-path only.
      let liveness: MissedRecipientLiveness[] = [];
      try {
        liveness = await describeMissedRecipients(fan.targets, {
          workspaceId: identity.workspaceId,
        });
        if (liveness.length > 0) wake.recipient_liveness = liveness;
      } catch {
        /* fail-soft: liveness enrichment is best-effort */
      }
      if (loud) {
        wake.recipient_absent = true;
        // WI-574 (dispatch-black-hole fix): a miss is NOT necessarily "seen on their next
        // turn" — if the recipient has NO live session watching its inbox-wake key it is
        // genuinely dead and the inject black-holes. Classify the dead ones (same non-firing
        // probe the no-wake path uses) and report them LOUDLY + truthfully.
        let dead: string[] = [];
        let aliveNotWakeable: string[] = [];
        // WI-5994: recipients reportIdleRecipients ALREADY excluded from `idle`
        // because they have an armed loop with a known next fire (or a turn in
        // flight right now) — dormant BETWEEN loop fires, not dead. Never fold
        // these into `dead` / the "not running… re-dispatch" note.
        let dormantScheduled: DormantScheduledInfo[] = [];
        // P-007 (cross-machine-coord-parity): a REMOTE-homed recipient has no
        // local watcher by definition — it is not dead, it is elsewhere. Split
        // it out of the dead set and report it truthfully (below).
        let remoteHomed: string[] = [];
        let staleRemote: string[] = [];
        try {
          const report = await reportIdleRecipients(fan.targets, {
            workspaceId: identity.workspaceId ?? undefined,
          });
          dead = report.idle;
          aliveNotWakeable = report.aliveNotWakeable ?? [];
          dormantScheduled = report.dormantScheduled ?? [];
          // EI-21458455211655064: the miss-path liveness enrichment and the
          // report-only idle probe both consult the shared oracle, but the
          // latter is deliberately fail-soft and can degrade independently.
          // If it misses the recorded/live classification, do not leave a
          // recipient looking dead merely because `recipient_liveness` already
          // proved it alive-but-not-wakeable. Keep the explicit absent signal
          // (the wake really missed), while projecting the controlling
          // alive/not-wakeable reason so callers do not announce a takeover the
          // claim guard will refuse.
          const dormantIds = new Set(dormantScheduled.map((entry) => entry.ownerId));
          const aliveFromLiveness = new Set(
            liveness
              .filter(
                (entry) =>
                  !entry.wakeable &&
                  (entry.sessionState === 'live' || entry.sessionState === 'recorded') &&
                  !dormantIds.has(entry.ownerId),
              )
              .map((entry) => entry.ownerId),
          );
          if (aliveFromLiveness.size > 0) {
            aliveNotWakeable = [...new Set([...aliveNotWakeable, ...aliveFromLiveness])];
            dead = dead.filter((ownerId) => !aliveFromLiveness.has(ownerId));
          }
          const remote = await remoteSessionsByOwnerId(identity.workspaceId);
          remoteHomed = fan.targets.filter((t) => remote.has(t));
          dead = dead.filter((d) => !remote.has(d));
          // P-010: classify freshness — a remote beat older than the staleness
          // window means the session is probably gone; say so instead of
          // implying the wake will land on arrival.
          const nowMs = Date.now();
          staleRemote = remoteHomed.filter((t) => {
            const seen = remote.get(t);
            return typeof seen === 'number' && nowMs - seen > 10 * 60 * 1000;
          });
        } catch {
          /* fail-soft: keep the generic miss note below */
        }
        const optimisticNoBackstop = wakeMode === 'optimistic';
        if (remoteHomed.length > 0 && dead.length === 0) {
          wake.recipient_remote = remoteHomed;
          if (staleRemote.length > 0) wake.recipient_remote_stale = staleRemote;
          const freshRemote = remoteHomed.filter((t) => !staleRemote.includes(t));
          wake.note = !harnessSlug
            ? `recipient(s) ${remoteHomed.join(', ')} are homed on a REMOTE machine, but this send did NOT ` +
              "federate (federated:false — no hive scope). It will NEVER reach them: re-send with scope:'hive' " +
              'so the message rides the hive topic.'
            : freshRemote.length > 0
              ? `recipient(s) ${freshRemote.join(', ')} are homed on a REMOTE machine of this hive (fresh beat) — ` +
                'the message FEDERATES and the remote machine fires the wake fan on arrival. CONFIRM pickup: ' +
                `events:await the receiptEvent key returned on this result (coord:receipt:<msg_id> — the remote ` +
                'machine acks with delivered+woken), or rely on wakeOnReply.' +
                (staleRemote.length > 0 ? ` STALE remote beat (probably gone): ${staleRemote.join(', ')}.` : '')
              : `recipient(s) ${staleRemote.join(', ')} are remote-homed but their presence beat is STALE — the ` +
                'session is probably gone. The message still federates (seen if it resumes), but do NOT assume ' +
                'pickup: treat this like recipient_dead and re-dispatch to a live agent unless the receipt arrives.';
        } else if (dead.length > 0 || dormantScheduled.length > 0 || aliveNotWakeable.length > 0) {
          // WI-5994: `dead` and `dormantScheduled` are disjoint outcomes of the SAME
          // miss — report each truthfully instead of collapsing both into one
          // "not running" verdict. Only `dead` justifies redispatch/reassignment.
          if (dead.length > 0) wake.recipient_dead = dead;
          if (aliveNotWakeable.length > 0) wake.recipient_alive_not_wakeable = aliveNotWakeable;
          if (dormantScheduled.length > 0) wake.recipient_dormant_scheduled = dormantScheduled;
          const parts: string[] = [];
          if (dead.length > 0) {
            parts.push(
              `NO live session is watching the inbox of: ${dead.join(', ')}, and no scheduled loop fire will ` +
                'pick it up either — these agents are genuinely not running, so the message will NOT be seen on ' +
                'any "next turn": the dispatch black-holes until they are re-spawned/resumed. Do NOT assume it ' +
                'landed: re-dispatch to a LIVE agent (coord:presence → wakeable:true), use coord:handoff, or — ' +
                "only if something truly re-dispatches — pass backstop:'<what re-dispatches>'.",
            );
          }
          if (dormantScheduled.length > 0) {
            const etaText = dormantScheduled
              .map((d) => (d.parked ? `${d.ownerId} (mid-turn right now)` : `${d.ownerId} (next fire ${d.nextFireAt})`))
              .join(', ');
            parts.push(
              `${dormantScheduled.length} recipient(s) are DORMANT BETWEEN LOOP FIRES, not dead: ${etaText}. ` +
                'Delivery is DEFERRED to their next scheduled fire, not lost — do NOT reassign their work or ' +
                'treat this as evidence of death; redirect only if you genuinely cannot wait that long.',
            );
          }
          if (aliveNotWakeable.length > 0) {
            parts.push(
              `NO live inbox-wake watcher is present for: ${aliveNotWakeable.join(', ')}, but the shared ` +
                'liveness oracle confirms these recipients are ALIVE (NOT dead). They are mid-turn or have ' +
                'not registered an inbox-wake await yet — do NOT relaunch or reassign on this alone; retry the ' +
                'wake shortly or hand off via a durable surface (work_items:checkpoint).',
            );
          }
          wake.note =
            (optimisticNoBackstop ? `optimistic wake with NO declared backstop MISSED — ` : `required wake MISSED — `) +
            parts.join(' ');
        } else {
          wake.note =
            (optimisticNoBackstop
              ? `optimistic wake with NO declared backstop reached no awake/watching session for: `
              : `required wake reached no awake/watching session for: `) +
            `${fan.targets.join(', ')} — the message was injected; a live-but-paused recipient sees it ` +
            'next turn, but none was re-invoked now. Confirm the recipient is actually running ' +
            '(coord:presence) before assuming pickup.';
        }
      } else {
        // OPTIMISTIC + a declared backstop → silence is consciously claimed. Soft note that
        // NAMES the backstop (no recipient_absent), so it's auditable but not a loud miss.
        wake.note =
          `optimistic wake reached no live session (queued:0) — relying on the declared backstop: ` +
          `"${msg.backstop}". If that backstop will NOT actually re-dispatch, this was NOT picked up — ` +
          "use wake:'required' or coord:handoff instead.";
      }
    }
  }

  // Default (no-wake / inject-only) path — REPORT idle recipients
  // (coord-dispatch-reliability-2026-06-21 P-001). A plain send lands in the
  // inbox but does NOT re-invoke a sleeping agent, so a hand-off injected to an
  // idle agent silently stalls. We NON-FIRINGLY probe each concrete addressee's
  // inbox-wake key (report-only — NEVER a wake on this path, invariant a) and
  // surface the ones no live session is watching, so the sender can re-send with
  // wake:'required' instead of assuming pickup. Fully fail-soft: a roster /
  // await-store hiccup degrades to no report — the send already succeeded
  // (invariant c), so this never blocks or fails it. We probe the SAME
  // post-expansion set the wake fan would (`env.to`), so a `@plan:`/`@topic:`
  // send reports exactly the resolved recipients, never '*'.
  let notWoken: { idleRecipients: string[]; note: string } | undefined;
  if (!wakeMode) {
    // The message is already persisted, so this report is optional enrichment.
    // Start the probe inside the bounded wrapper so even a stalled invocation is
    // covered by the sub-transport deadline. A timeout/error returns the complete
    // empty report and therefore cannot manufacture an idle/dead finding.
    const { value: report } = await withBoundedTimeout(
      () => reportIdleRecipients(env.to, { workspaceId: identity.workspaceId ?? undefined }),
      {
        fallback: EMPTY_IDLE_REPORT,
        timeoutMs: COORD_SEND_IDLE_REPORT_TIMEOUT_MS,
        label: 'coord:send:idle-report',
      },
    );
    if (report.idle.length > 0) {
      notWoken = {
        idleRecipients: report.idle,
        note:
          `injected to ${report.idle.join(', ')} — no live session is watching their inbox, so this send does NOT ` +
          'wake them (seen on their next natural turn, if any). To hand off live work that must be picked up now, ' +
          "re-send with wake:'required' and verify pickup (queued / pickupConfirmed / recipient_absent).",
      };
    }
  }

  // `bodyText`, not `msg.body`: the body is ALWAYS an array of sections (a plain
  // string is refused by `messageBodyArg`), so the previous
  // `[msg.summary, msg.body].join('\n')` handed this detector the literal
  // "[object Object]" and it could only ever see the summary. Same class as the
  // claim bug below — a detector reading the wrong text reports a confident
  // clean.
  const sentText = [msg.summary, bodyText].filter(Boolean).join('\n');
  // EI-24684014950807803: resolve each sha-shaped token against the integration tree
  // before flagging it — an agent short id like `c0b38c83` is hex-shaped but names no
  // commit. Async + parallel (never a sync spawn on the send hot path), never throws.
  const cellHint = await cellTranscriptionHintResolvingCommits(sentText);

  // WI-41323 — the SENDER-side half of EI-21333824056510800. That item fixed what
  // the RECEIVER sees: an unbacked "OWNER-VERIFIED DIRECTIVE" now renders prefixed
  // `[UNVERIFIED authority claim]`. But nothing told the SENDER, so the one agent
  // who could stop writing unbacked claims is the one party who never learns it
  // happened — and a `ok:true` read as "delivered as written" invites the next one.
  //
  // FLAG AND SEND, NEVER REFUSE: the message is persisted and woken well above
  // this line; a hit adds a string to the result and changes nothing else. Same
  // placement contract as `cellHint` for the same reason — a detector must not be
  // able to affect delivery.
  //
  // Computed on the SAME text the renderer flags on (`e.summary || e.body`) with
  // the SAME predicate, so this PREDICTS the delivered flag instead of offering a
  // second opinion about it.
  const claimText = msg.summary || bodyText || '';
  const authorityClaim = claimText ? unverifiedAuthorityClaim(claimText, relayStamp, cueAuthority) : null;
  const { value: dispatchAdvisory } = await withBoundedTimeout(
    () => deriveDispatchAdvisory(msg, bodyText, env.to, harnessSlug),
    {
      fallback: undefined,
      timeoutMs: COORD_SEND_DISPATCH_ADVISORY_TIMEOUT_MS,
      label: 'coord:send:dispatch-advisory',
    },
  );

  return {
    ok: true,
    to: env.to,
    msg_id: env.msg_id,
    ts: env.ts,
    // P-001: whether this message rides a federation scope (harness-stamped ⇒ the
    // mig-150 capture gate federates it to the Hive's other machines). `false` =
    // machine-local only — never mistake it for cross-machine delivery.
    federated: Boolean(harnessSlug),
    ...(harnessSlug ? { federationScope: harnessSlug } : {}),
    // fleet-scoped-broadcast-default: report a '*'→@fleet auto-scope so the rewrite
    // is transparent + teaches the allHive override; flag a conscious hive-wide blast.
    ...(bcast?.scoped ? { scopedBroadcast: bcast.scoped } : {}),
    ...(bcast?.allHive ? { allHiveBroadcast: true } : {}),
    // EI-18791996856052350: surface the renunciation so it is never silent — this
    // message informed the hive WITHOUT your fleet-control authority; agents outside
    // your fleet received a notice, not a cue they are meant to act on.
    ...(bcast?.renouncedFleetAuthority ? { sentWithoutFleetAuthority: true } : {}),
    // P-008: await this key to confirm cross-machine delivery+wake (the
    // receiving machine emits it back as a fed event when the row applies).
    ...(wantReceipt ? { receiptEvent: `coord:receipt:${env.msg_id}` } : {}),
    // P-013: echo the declared effect + the baseline it will be judged against, so
    // the sender never mistakes `woken:1` for compliance. The verdict is NOT
    // available now (the effect has not had time to happen) — this names where to
    // read it, which is the honest answer at send time.
    ...(msg.expectEffect
      ? {
          expectEffect: {
            ...msg.expectEffect,
            verifiedFrom: env.ts,
            verdict: 'pending' as const,
            note: 'queued:1 is DELIVERY QUEUEING, not compliance. Read the derived verdict on fleet:leader-brief → members[].directiveActuation.',
          },
        }
      : {}),
    ...(endTurn ? { endTurn } : {}),
    ...(wake ? { wake } : {}),
    ...(replyWake ? { replyWake } : {}),
    ...(notWoken ? { notWoken } : {}),
    // EI-6874: report how many live recipients an audience-selector send resolved
    // to (for EVERY audience send, not just the zero case), plus the loud
    // zero_recipients warning when an auto-scoped '*'→@fleet broadcast reached
    // nobody (an explicit selector reaching nobody already returned above).
    ...(audienceSelectors.length > 0 ? { recipients_resolved: env.to.length } : {}),
    ...(zeroRecipients ? { zero_recipients: zeroRecipients } : {}),
    // P-003: who the `@fleet:` audience did NOT reach, and why — so a partial delivery
    // is legible rather than reading as a complete one.
    ...(fleetOmitted ? { fleet_omitted: fleetOmitted } : {}),
    // Partial selector resolution is distinct from fleet-member omissions: the
    // selector itself matched nobody, while another addressee did receive this
    // message. Keep the direct list machine-readable and the note actionable.
    ...(unresolvedAudience
      ? {
          unresolvedSelectors: unresolvedAudience.selectors,
          unresolved_audience: unresolvedAudience,
        }
      : {}),
    // EI-22180848452883121: a selector that resolved ONLY to reaped session(s) while a
    // DIFFERENT addressee did receive this message. Distinct from unresolved_audience
    // (that selector matched nobody; this one matched a corpse) and invisible to
    // recipients_resolved, which counts the reaped id as a resolved recipient.
    ...(unreachableAudienceWarning ? { recipients_unreachable: unreachableAudienceWarning } : {}),
    // WI-37972: the durable coord row keeps the full body, but a normal
    // recipient `coord:inbox` read may clip it before the recipient can act.
    // Surface the same authored-vs-visible accounting on the SENDER result so
    // `ok:true`/`wakeOutcome:'queued'` cannot be mistaken for "the whole
    // decision text was readable". The one-entry cap is the documented maximum
    // for a default full-tier inbox read; a crowded page can use the smaller
    // `bodyCrowdedPageCap`. The full text remains addressable via coord:read.
    ...(bodyDelivery
      ? {
          bodyTruncated: bodyDelivery.bodyTruncated,
          bodyMayBeTruncated: bodyDelivery.bodyMayBeTruncated,
          bodyAuthoredChars: bodyDelivery.bodyAuthoredChars,
          bodyFullChars: bodyDelivery.bodyFullChars,
          bodyDeliveredChars: bodyDelivery.bodyDeliveredChars,
          bodyDeliveryCap: bodyDelivery.bodyDeliveryCap,
          bodyCrowdedPageCap: bodyDelivery.bodyCrowdedPageCap,
          ...(bodyDelivery.bodyMayBeTruncated ? { bodyReadRef: { tool: 'coord:read', msg_id: env.msg_id } } : {}),
        }
      : {}),
    // EI-18145: the reply was recorded (satisfying unanswered-directed /
    // delivery-ladder for `related_msg_id`) even though this addressee no
    // longer resolves in the roster — their session ended, so no wake was
    // attempted for them. Never an error: this IS how you close a loop with a
    // departed correspondent.
    ...(goneRepliedTo.length ? { recipients_gone: goneRepliedTo } : {}),
    // P-017 (c) / D-016 / D-047 row 4: "this value has a cell, read it". Computed on
    // the SENT text (summary + body) and reported on THIS message's result.
    //
    // Placed here — after the send has already succeeded — on purpose. It is a
    // DETECTOR, so it must be impossible for it to affect delivery: the message is
    // persisted and woken before this line runs, the helper is pure and total (never
    // throws, returns null on anything unparseable), and a hit changes nothing except
    // adding a string the sender can read. A transcribed value is worth flagging
    // precisely because a message OUTLIVES the value it quotes.
    ...(cellHint ? { cellHint } : {}),
    // WI-41323: what every recipient will actually read at the head of this
    // message's inbox line. `sent:true` is stated first because the natural
    // misread of a warning on a result is that something was withheld.
    ...(authorityClaim
      ? {
          unverifiedAuthorityClaim: {
            claim: authorityClaim,
            sent: true as const,
            renderedTag: UNVERIFIED_CLAIM_TAG,
            note:
              `This message asserts ${authorityClaim.toUpperCase()} authority that the platform could not ` +
              `verify, so every recipient's inbox line renders it prefixed ${UNVERIFIED_CLAIM_TAG}. ` +
              `It WAS sent — nothing was withheld or rewritten. ` +
              (relayStamp
                ? `You passed a relay reference, but it resolved to tier:'unverified' — that is a check ` +
                  `that RAN AND FAILED, not a weak pass, so it grounds nothing. Re-send with a relayOf ` +
                  `the platform can resolve.`
                : `You passed neither relayOf nor relayQuote, so there was nothing to verify it against. ` +
                  `To send it backed: relayOf:<the original's msg_id> (copy it from your inbox/feed line), ` +
                  `relayOf:'owner-turn' when you are relaying the human turn you are currently answering, ` +
                  `or relayQuote:<a verbatim snippet of those words>.`) +
              ` If you are stating your OWN judgement rather than relaying someone's directive, say so in ` +
              `your own voice instead — the flag fires on the claim, not on the decision.`,
          },
        }
      : {}),
    ...(dispatchAdvisory ? { dispatchAdvisory } : {}),
    ...(staleBasisStamps.length ? { staleBasis: staleBasisStamps } : {}),
    ...(goalOwnerReport
      ? {
          goalOwnerReport: {
            status: 'stamped' as const,
            goalId: goalOwnerReport.goalId,
            // The watchdog reads this persisted message row's ts as lastReportAt.
            lastReportAt: env.ts,
          },
        }
      : {}),
    ...(goalOwnerReportDiagnostic ? { goalOwnerReport: goalOwnerReportDiagnostic } : {}),
    ...(goalOwnerReportWarning ? { goalOwnerReportWarning } : {}),
  };
}

/**
 * P-001 (cross-machine-coord-parity-and-trust-2026-07-01): the EFFECTIVE
 * federation scope for one message. Precedence:
 *   scope:'local'  → none (explicit machine-local, wins over everything);
 *   ctx harness    → the sender's own harness (pipeline roles — unchanged);
 *   message harness → the explicit per-message/bulk-item harness when the
 *                    sender is unscoped;
 *   scope:'hive'   → the workspace's shared Hive — `hive` picks WHICH one on a
 *                    multi-hive workspace (WI-5445; mirrors resource:offers' /
 *                    fleet:request_remote_spawn's own disambiguator), else the
 *                    single shared Hive; LOUD error when none, or ambiguous
 *                    with no `hive` given (never a silent local fallback);
 *   omitted        → auto: the single shared Hive when exactly one, else none
 *                    (an explicit `hive` with no scope:'hive' has no effect —
 *                    auto never guesses).
 * Returns either the slug to stamp (undefined = stay local) or the per-message
 * error result.
 */
async function effectiveFederationScope(
  msgScope: 'hive' | 'local' | undefined,
  msgHarness: string | undefined,
  ctxHarness: string | undefined,
  workspaceId: string | null | undefined,
  to: string[],
  explicitHive?: string,
): Promise<{ harnessSlug: string | null } | { error: BulkItemResult }> {
  // WI-3653: every "stay local" DECISION returns null (sendMessage's explicit
  // machine-local opt-out) — this layer has already resolved the scope, so the
  // write seam's own AUTO default (undefined → resolve) must not re-decide it.
  if (msgScope === 'local') return { harnessSlug: null };
  if (ctxHarness) return { harnessSlug: ctxHarness };
  // An explicit per-message/item harness is available to unscoped senders,
  // while the concrete ctx harness above remains authoritative for scoped
  // pipeline roles. This prevents a nested bulk field from widening a scoped
  // sender's harness boundary.
  if (msgHarness) return { harnessSlug: msgHarness };
  if (!workspaceId || workspaceId === '*') {
    if (msgScope === 'hive') {
      return {
        error: {
          ok: false,
          to,
          error: 'no_hive_scope',
          message:
            "scope:'hive' needs a concrete workspace to resolve the shared Hive from, and this session has none — nothing was sent.",
        },
      };
    }
    return { harnessSlug: null };
  }
  const resolved = await resolveWorkspaceHiveScope(workspaceId);
  if (msgScope !== 'hive') {
    // auto: the single shared Hive when exactly one, else stay local — an
    // explicit `hive` with no scope:'hive' is a no-op here by design (auto
    // never guesses which hive the caller meant).
    return { harnessSlug: resolved.kind === 'one' ? resolved.homeSlug : null };
  }
  // WI-5445: scope:'hive' — `hive` (when given) picks which shared Hive on a
  // multi-hive workspace; the same pure disambiguator resource:offers and
  // fleet:request_remote_spawn already use, so the three surfaces can't drift.
  const picked = resolveSharedHiveDisambiguation(resolved, explicitHive, null);
  if (picked.ok) return { harnessSlug: picked.homeSlug };
  return {
    error: {
      ok: false,
      to,
      error:
        resolved.kind === 'none'
          ? 'no_hive_scope'
          : explicitHive
            ? 'unknown_hive'
            : 'ambiguous_hive_scope',
      message: `scope:'hive': ${picked.error}`,
      ...(picked.candidates.length ? { candidates: picked.candidates } : {}),
    },
  };
}

export default defineTool({
  name: 'coord:send',
  // P-011 prompt-weight: this tool was 69 over the HARD CAP. The obvious trim — deduping
  // `description` against `when` — is WRONG here, and send-arg-shape.test.ts enforces that:
  // three facts (summary-is-the-required-inbox-headline, `why` = { goalRef, note? }, and
  // `basedOn` OUTPUT-ONLY/auto-derived/omit) are asserted against EACH surface separately,
  // because a caller may see only one of them. That redundancy is deliberate — keep it.
  // Budget is recovered by tightening prose instead; response/refusal detail lives in the
  // free `returns` below (EI-22083648545226771 / EI-18742337097445085).
  description:
    'Send coordination messages. Single: {to, summary, expects, body?}; `summary` is the required inbox headline; `body` optional detail. Distinct messages: items:[…]. `to` takes ownerIds, ["*"], or ["human"]. `expects` required: ack|answer|action|none. `why` is { goalRef, note? } — a goal REF, never prose. `basedOn` is OUTPUT-ONLY, auto-derived — omit it; `body[].premises` are ref strings; `body[].youMayNotKnow` uses {ref, provenance} objects. `wake` re-invokes sleeping recipients; `optimistic` needs `backstop`.',
  guidance: {
    when:
      'Share context or ask. `summary` is the required inbox headline; `body` is detail. A complete active-GOAL owner report (MOVED/COST/OWNER-WALLED/KILLED) must fit in one body of at most ' +
      DEFAULT_INBOX_BODY_CAP +
      ' characters; longer ones are refused unsent (see returns). Directed action/answer needs `forYouBecause: { relation, ref?, note? }` on a body section; broadcasts, human, ack and none are exempt. `why` is { goalRef, note? } — a goal REF, never prose. `basedOn` is OUTPUT-ONLY, auto-derived — omit it. Waiting? `blockedOn: { kind, ref }` on a section gives a live cleared/pending verdict. SHAPES: `premises` is an array of ref STRINGS; `youMayNotKnow` is [{ ref, provenance }]; `couldNotDetermine` is [{ what, note? }] — objects, never bare strings. ',
    argRedirects: sectionOnlyArgRedirects,
    returns:
      'Per-message {ok, to, msg_id|error} counts. Envelope `ok` is DERIVED from results[].ok, so ANY failed delivery makes it false; `partial:true` and `deliveryFailureWarning` then name which messages failed and why. A complete active-GOAL owner report above ' +
      DEFAULT_INBOX_BODY_CAP +
      ' characters is refused before persistence (`goal-owner-report-over-cap`); generic over-cap bodies are delivered in full as ordered parts (`chunked[]`; only the final part, `askMsgId`, carries expects/wake/reply-threading). A generic body needing more than ' +
      COORD_SEND_MAX_CHUNK_PARTS +
      ' parts is refused. A directed action that mentions an existing WI-/EI- item but does not assign it may include `dispatchAdvisory` naming the live assignment and `coord:dispatch` remedy. `draftSuspension` appears when the sender\'s own tool activity shows a gap (default >10m) before the send — a wake-pump can interleave a turn between measuring a claim and sending it, so any measurement taken before `gapStartedAt` may have aged; it reports the measured gap only and never guesses which claim is stale.',
    notWhen: 'Human reply: speak. File lock: locks:acquire. Ambient note: omit wake. One message to many: to:[…]; distinct messages: items:[…]. Named work-item transfer: coord:dispatch with workItemIds:[…]; plan-lane transfer: coord:handoff.',
    seeAlso: [
      'EI-21927749510698309: relaying an owner or fleet-leader directive? Pass relayOf/relayQuote on THIS send, not after — a text claim ("owner said/directive/approved") with neither ships anyway but renders [UNVERIFIED authority claim] to every recipient; re-sending backed does not un-flag the first copy, so a fleet-wide broadcast lands twice.',
      'coord:handoff (transfer WORK, not just a message)',
      'coord:dispatch (assign a named work-item and wake its execution owner)',
      'coord:inbox (read replies to what you sent)',
      'coord:roster { view:"live" } (confirm a recipient is awake before wake:required)',
      'EI-9940: self-resolved a failure you already reported? reply via related_msg_id, not a fresh send',
      'WI-5341: replying to a message whose `expects` was not `none`? set related_msg_id to it — a broadcast or unthreaded reply keeps you reading as "unanswered" in leader-brief/fleet:assignments even though you replied.',
    ],
  },
  // P-016 / D-107 — auto-correct-and-RUN `premises: [{ref}] -> ["ref"]`, the single largest
  // rejection class on this verb (1,211/7d across 555 agents, 68% of all coord:send
  // refusals, 99.8% one shape). Declared here, authored beside `premisesArg` in
  // message-fields.ts. Bare-string and no-`ref` premises keep the taught refusal.
  argReencodings: [PREMISES_REF_OBJECT_REENCODING],
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  // EI-20186059075216845: coord:send persists through the coordination/admin
  // seams and never reads ctx.tx. Do not hold an org-app transaction open while
  // roster, federation, and wake delivery work runs; under fleet concurrency
  // that pins every app-pool slot until the 45s acquisition deadline expires.
  skipWorkspaceTx: true,
  // EI-7838: this cross-field "need {to,summary} (or items)" check used to live in
  // a trailing `.refine()` on the object below. Zod only RUNS a `.refine()` /
  // `.superRefine()` after the base object schema parses EVERY field successfully —
  // when a SIBLING field (e.g. `wake`) ALSO fails its own type check (a stray
  // string "true" instead of boolean/enum, or any other bad value), zod short-
  // circuits and returns ONLY that field's issue; the refine never runs, so a
  // genuinely-missing `summary` goes unreported and the caller is misdirected
  // toward an unrelated field ("wake: Invalid input") instead of the real,
  // actionable problem. A `z.preprocess` wrapping the object runs BEFORE the
  // object's own per-field validation, so its `ctx.addIssue` fires independently
  // of whether `wake`/etc. later fail their own checks — this makes the
  // fundamental "you forgot to/summary" message win over a secondary field-shape
  // issue (confirmed via z.toJSONSchema: preprocess is transparent to schema
  // introspection, so the advertised tool schema is byte-identical either way).
  args: z.preprocess((data, pctx) => {
    const a = data as
      | {
          items?: unknown[];
          to?: unknown[];
          summary?: unknown;
          expects?: unknown;
          body?: unknown;
          wake?: unknown;
          endTurn?: unknown;
          harness?: unknown;
          harness_slug?: unknown;
        }
      | null
      | undefined;
    // EI-21883551367092231: `harness_slug` is the field name on many other
    // papercusp tools (harness_docs:*, plans:*, ...); coord:send's own field
    // is `harness` (messageHarnessArg). Accept `harness_slug` as a synonym so
    // a caller who reaches for the more common name is not rejected outright
    // — normalized here, before the strict object schema below sees it, so it
    // never surfaces as an "Unrecognized key" refusal. Applies to both the
    // top-level shorthand and each items[] entry, since itemSpec carries the
    // identical `harness` field (EI-19295149246007753 parity).
    const applyHarnessSlugAlias = (
      m: { harness?: unknown; harness_slug?: unknown } | null | undefined,
    ) => {
      if (!m || typeof m !== 'object') return;
      if (m.harness === undefined && m.harness_slug !== undefined) {
        m.harness = m.harness_slug;
      }
      if ('harness_slug' in m) delete m.harness_slug;
    };
    applyHarnessSlugAlias(a);
    // WI-10005668 (measured 2026-10-02, 24h of tool_invocations): a caller who passes
    // `to` as a BARE recipient string — `to: "su-…"` — was refused 13x/6 owners and
    // re-failed 11 of those 13 times. The cause was this file, not the caller:
    // `toPresent` below is `Array.isArray(a.to) && …`, so a scalar string read as
    // MISSING and the refusal said "needs `to`: at least one recipient id" to a
    // caller who HAD supplied one — no retry could get closer to the contract from
    // that message. A single recipient string is unambiguous (ids, `*`, `human` and
    // @selectors are all strings), so normalize it to the one-element array the
    // schema declares, here — before the strict object schema sees it — exactly as
    // `harness_slug` is. The published JSON Schema is unchanged (preprocess is
    // transparent to it): `to` still advertises an array. An EMPTY string is left
    // alone so it keeps falling through to the specific refusal below.
    const applyScalarToNormalization = (m: { to?: unknown } | null | undefined) => {
      if (!m || typeof m !== 'object') return;
      if (typeof m.to === 'string' && m.to.length > 0) m.to = [m.to];
    };
    applyScalarToNormalization(a);
    if (Array.isArray(a?.items)) {
      for (const it of a.items) {
        if (it && typeof it === 'object') {
          applyHarnessSlugAlias(it as { harness?: unknown; harness_slug?: unknown });
          applyScalarToNormalization(it as { to?: unknown });
        }
      }
    }
    const hasItems = Array.isArray(a?.items) && a.items.length > 0;
    // Keep `Boolean(a?.summary)` (not a string check) so a WRONG-TYPED summary
    // (e.g. a number) stays "present" here and falls through to summaryArg's own
    // type error, which is already specific. This branch is only for MISSING.
    const toPresent = Array.isArray(a?.to) && a.to.length > 0;
    const summaryPresent = Boolean(a?.summary);
    const hasSingle = toPresent && summaryPresent;
    // EI-19407756530556168: `messageBodyArg`'s own superRefine (message-fields.ts) refuses a
    // plain-string `body` — but it lives on the WRAPPED object schema, one pipe stage AFTER
    // this preprocess. zod v4's `z.preprocess` is implemented as a two-stage PIPE
    // (transform -> object schema) that ABORTS the second stage entirely the instant this
    // transform calls `ctx.addIssue` (handlePipeResult: "prevent further checks") — so
    // whenever THIS function ALSO reports some other issue below (missing `expects`, missing
    // `summary`, a structured-body/forYouBecause gate), messageBodyArg's own check never runs
    // and its issue is silently dropped, not merely deprioritized. A caller who submitted a
    // malformed body alongside any other violation would only discover the shape problem on a
    // LATER round-trip, after fixing the other one first — the exact one-issue-at-a-time
    // sequencing this whole preprocess exists to avoid for `to`/`summary`/`expects`. Duplicate
    // the same check (same message — see BODY_MUST_BE_ARRAY_MESSAGE) here, unconditionally, so
    // it always survives alongside whatever else this preprocess reports. When nothing else
    // fires, this function adds no issues and the pipe proceeds to messageBodyArg's own check
    // as before — so the two never both fire for the same body.
    const flagMalformedBody = (body: unknown, path: (string | number)[]) => {
      if (typeof body === 'string') {
        pctx.addIssue({ code: 'custom', path: [...path, 'body'], message: BODY_MUST_BE_ARRAY_MESSAGE });
      }
    };
    // EI-21826596284846555 + RSR-P-008-B: a body over the largest normal inbox
    // projection is no longer refused — the handler delivers it in full as ordered
    // inbox-sized parts (send-chunking.ts). What stays a schema-time refusal is a
    // body too long to chunk, so the sender learns before any persistence runs.
    // Applies to every `expects`: an over-cap FYI used to persist and then report a
    // lossy send; now it is chunked like any other message.
    const flagOverlongBody = (
      message: { body?: unknown; expects?: unknown; summary?: unknown },
      path: (string | number)[],
    ) => {
      const bodyChars = bodyTextLength(message.body);
      if (bodyChars === null || bodyChars <= DEFAULT_INBOX_BODY_CAP) return;
      const plan = chunkOverCapMessage({
        to: [],
        summary: typeof message.summary === 'string' ? message.summary : '',
        body: message.body as string | MessageSection[],
        expects: typeof message.expects === 'string' ? message.expects : 'none',
      });
      if (plan.kind !== 'refused') return;
      pctx.addIssue({ code: 'custom', path: [...path, 'body'], message: plan.message });
    };
    // EI-20271510434650928: endTurn is an ESC-before-wake recovery operation. Without
    // an explicit wake mode it can end a recipient's current turn and then leave them
    // idle, which is strictly worse than a plain inject. Enforce the coupling before
    // object validation so the same gate applies to both the shorthand and items[].
    const flagUnsafeEndTurn = (message: { endTurn?: unknown; wake?: unknown }, path: (string | number)[]) => {
      if (
        message.endTurn === true &&
        message.wake !== true &&
        message.wake !== 'required' &&
        message.wake !== 'optimistic'
      ) {
        pctx.addIssue({
          code: 'custom',
          path: [...path, 'wake'],
          message:
            '`endTurn: true` requires an explicit wake mode: `wake: true`, `wake: \'required\'`, or ' +
            '`wake: \'optimistic\'`. Ending a turn without waking it can leave the recipient idle.',
        });
      }
    };
    if (hasItems) {
      (a?.items ?? []).forEach((it, i) => {
        if (it && typeof it === 'object') flagUnsafeEndTurn(it as { endTurn?: unknown; wake?: unknown }, ['items', i]);
      });
    } else {
      flagUnsafeEndTurn(a ?? {}, []);
    }
    if (hasItems) {
      (a?.items ?? []).forEach((it, i) => {
        if (it && typeof it === 'object') flagMalformedBody((it as { body?: unknown }).body, ['items', i]);
      });
    } else {
      flagMalformedBody(a?.body, []);
    }
    if (hasItems) {
      (a?.items ?? []).forEach((it, i) => {
        if (it && typeof it === 'object') {
          flagOverlongBody(it as { body?: unknown; expects?: unknown }, ['items', i]);
        }
      });
    } else {
      flagOverlongBody(a ?? {}, []);
    }
    if (!hasItems && !hasSingle) {
      // WI-6522 — this used to emit ONE generic bulk-vs-single menu for every
      // distinct single-send mistake: 334 refusals across 135 DISTINCT senders in
      // 14 days, the largest arg-shape family on this tool. The good per-field
      // messages ALREADY EXIST on toArg/summaryArg — they were simply unreachable,
      // because a preprocess issue is raised before per-field validation runs. So
      // the bug was never a missing message, it was MASKING: a caller who forgot
      // exactly one field got told about bulk-vs-single and never learned which
      // field they missed. Branch it, and keep the menu for the genuinely
      // ambiguous case only.
      //
      // Do NOT "fix" this by moving the check back to a trailing .refine(): the
      // preprocess placement is load-bearing (see the EI-7838 note above) — a
      // refine is short-circuited whenever a SIBLING field also fails, which is
      // the older defect where a missing `summary` went unreported and the caller
      // was misdirected to "wake: Invalid input". Precedence must survive; only
      // the message becomes specific.
      const bodyHint = a?.body
        ? ' You passed `body` — that is the OPTIONAL long-form text and does NOT satisfy `summary`.'
        : '';
      if (Array.isArray(a?.items) && a.items.length === 0) {
        pctx.addIssue({
          code: 'custom',
          path: ['items'],
          message:
            '`items` is an EMPTY array — it needs at least one { to, summary, expects }. For a single ' +
            'message, omit `items` and pass { to, summary, expects } at the top level instead.',
        });
      } else if (toPresent && !summaryPresent) {
        pctx.addIssue({
          code: 'custom',
          path: ['summary'],
          message:
            'coord:send needs `summary`: a one-line headline of the message (what the recipient sees ' +
            'in their inbox).' +
            bodyHint,
        });
      } else if (!toPresent && summaryPresent) {
        pctx.addIssue({
          code: 'custom',
          path: ['to'],
          message:
            'coord:send needs `to`: at least one recipient id. ["*"] broadcasts, ["human"] surfaces to ' +
            'the user; audience selectors like @fleet:<slug> / @topic:<slug> expand to a group.',
        });
      } else {
        pctx.addIssue({
          code: 'custom',
          message:
            'pass { to, summary, expects } for one message, or items:[{ to, summary, expects }] for ' +
            'many distinct messages.' +
            bodyHint,
        });
      }
    }
    // D-016 / D-048 — `expects` is required-with-explicit-'none', never defaulted.
    //
    // itemSpec enforces it structurally for the items[] axis, but the SHORTHAND cannot
    // use the same mechanism: `expects` must stay `.optional()` on the top-level object
    // so an items[]-only call need not carry one. So the identical requirement is closed
    // HERE — exactly as work_items:set_state closes its terminal-evidence rule for its
    // own shorthand with a second check (P-005/D-006). Without this the gate would not be
    // enforced, it would merely MOVE to the shorthand, which is the cheaper call and
    // therefore the one that would carry all the traffic.
    //
    // EI-18887930700345699 — this gate deliberately keys on `toPresent`, NOT `hasSingle`.
    // Whether `expects` is missing does not depend on whether `summary` landed; it only
    // depends on this being a single-send (a `to`, no `items[]`). Requiring the FULL
    // hasSingle made the two independent omissions strictly sequential: a caller who
    // forgot both was told about `summary`, and only learned about `expects` on the NEXT
    // round-trip — re-paying the whole (often multi-KB) body each time. coord:send is a
    // DEFERRED tool here, so a first-time caller has no schema in context and discovers
    // the envelope one error at a time. Reporting both at once costs nothing: the
    // `summary` issue is still raised by the branch above, so its precedence (EI-7838,
    // the fundamental omission must win over a secondary field-shape complaint) is
    // untouched — this only ADDS the second, equally-fundamental omission alongside it.
    if (!hasItems && toPresent && a?.expects === undefined) {
      pctx.addIssue({
        code: 'custom',
        path: ['expects'],
        message:
          "coord:send needs `expects`: 'ack' (confirm receipt) | 'answer' (reply with information) | " +
          "'action' (do something) | 'none' (FYI/status, nothing expected). There is deliberately no " +
          "default — an FYI must say 'none' explicitly. This replaces the old optional `expectsReply`, " +
          'which was silently derived from wake+replyDeadlineSec and so carried no sender intent.',
      });
    }
    // STRUCTURED-BODY GATE (owner directive 2026-07-28) — the companion to the string
    // refusal in messageBodyArg. Refusing the string alone does not force the structure;
    // it just moves the free text one field left, into the REQUIRED `summary`. That is the
    // same escape the `expects` gate had to close for its own shorthand above, and the same
    // shape as D-016's "a default is how a field dies" — a rule that can be satisfied by
    // not participating is not a gate. So a message that ASKS SOMETHING of its recipient
    // must carry a body; a genuine FYI (`expects: 'none'`) still may not.
    const checkStructured = (m: { to?: unknown; expects?: unknown; body?: unknown }, path: (string | number)[]) => {
      const expects = typeof m.expects === 'string' ? m.expects : undefined;
      // Scoped to the two expectations that ask the recipient to DO something with content.
      // 'none' is an FYI and 'ack' asks only for a receipt — for both, `summary` genuinely can
      // be the whole message, and requiring sections there would manufacture the empty ceremony
      // this gate is supposed to prevent. Deliberately narrower than "everything but none": the
      // failure mode of an over-tight gate is filler, which leaves the field carrying LESS than
      // the prose it replaced — the same way a defaulted field dies, one level up.
      if (expects !== 'action' && expects !== 'answer') return;
      if (m.body === undefined) {
        pctx.addIssue({
          code: 'custom',
          path: [...path, 'body'],
          message:
            `\`body\` is REQUIRED when expects is '${expects}' — you are asking the recipient to act ` +
            'on or answer something, so put the substance in sections rather than compressing it into ' +
            "`summary`. Minimum: body: [{ text: \"...\" }] — this ADDS to `summary`, it does not " +
            'replace it: `summary` stays required as the one-line inbox headline (it is what survives ' +
            "inbox truncation; `body` is clipped). An FYI (expects:'none') and a receipt " +
            "request (expects:'ack') may still omit it. A section also carries `premises`, " +
            '`forYouBecause`, `youMayNotKnow` and — the one most worth filling — `couldNotDetermine`, ' +
            'which is how you hand over a gap instead of letting silence read as certainty.',
        });
        return;
      }
      // A DIRECTED ask must say why THIS recipient. Excluded for broadcasts, where
      // "why you specifically" is not a well-formed question, and for ack (a receipt
      // confirmation needs no rationale). Kept to ONE required authored field on ONE
      // section: requiring all four would manufacture filler, which is how a structured
      // field ends up carrying less information than the prose it replaced.
      // Audience selectors fan out to a group during delivery, so they have the
      // same "why you specifically" semantics as a broadcast, not a directed
      // one-to-one message. Keep this validator aligned with the canonical
      // recipient classifier used by the send path; checking only literal '*'
      // and 'human' misclassified @fleet:/@topic:/@plan:/@object:/@file: here.
      const directed =
        Array.isArray(m.to) &&
        m.to.length > 0 &&
        m.to.every((id): id is string => typeof id === 'string' && !isSelectorOrWildcard(id));
      if (!directed || (expects !== 'action' && expects !== 'answer')) return;
      const isArrayBody = Array.isArray(m.body);
      const sections = isArrayBody ? (m.body as Array<Record<string, unknown>>) : [];
      const hasForYouBecause = sections.some((s) => s && s.forYouBecause !== undefined);
      // EI-19407756530556168: a MALFORMED (non-array, e.g. a plain string) `body` is refused
      // separately by messageBodyArg's own field-level check, below, IN THE SAME RESPONSE —
      // but this function can't enumerate "sections" of a malformed body, so without this
      // branch it always reads as zero sections and SILENTLY skips the forYouBecause
      // requirement. That deferred the requirement to the caller's NEXT round-trip, after
      // they'd separately fixed the body's shape — the exact one-issue-at-a-time sequencing
      // this gate exists to prevent. A malformed body can never itself satisfy
      // forYouBecause, so it is always correct to flag this now rather than wait for a
      // shape fix to reveal it.
      const bodyMalformed = m.body !== undefined && !isArrayBody;
      if ((sections.length && !hasForYouBecause) || bodyMalformed) {
        pctx.addIssue({
          code: 'custom',
          path: [...path, 'body'],
          message:
            `A DIRECTED message with expects:'${expects}' needs \`forYouBecause\` on at least one ` +
            'section — you are asking a specific agent to act or answer, so state why it is THEM. ' +
            'Shape: forYouBecause: { relation: <how they relate to this>, note: "..." }. Use ' +
            "relation:'other' with a note when no structural relation fits. Broadcasts and " +
            "expects:'ack' are exempt.",
        });
      }
    };
    if (hasItems) {
      (a?.items ?? []).forEach((it, i) => {
        if (it && typeof it === 'object') checkStructured(it as Record<string, unknown>, ['items', i]);
      });
    } else if (hasSingle) {
      checkStructured(a as Record<string, unknown>, []);
    }
    return data;
  }, z.object({
    // Caller-DX (watchdog P-006): actionable validation messages — agents
    // repeatedly bounced off the bare "Required" / "Array must contain at least
    // 1 element(s)" zod default on these two required fields.
    to: toArg.optional(),
    summary: summaryArg.optional(),
    harness: messageHarnessArg,
    body: messageBodyArg,
    // P-032 / D-064 envelope half — see itemSpec for why these two cannot be
    // per-section.
    blocking: blockingArg,
    why: whyArg,
    basedOn: basedOnArg,
    fieldProvenance: fieldProvenanceArg,
    files: z.array(z.string()).optional(),
    plan_slug: z.string().optional(),
    related_msg_id: z
      .string()
      .optional()
      .describe(
        "Replying? The full msg_id you are answering (or a UNIQUE leading prefix copied from coord:inbox) — this fires the asker's wake-on-reply. The server persists the canonical full id; dangling or ambiguous refs refuse the send (related_msg_not_found / related_msg_ambiguous). Never hand-type or use a placeholder.",
      ),
    // D-048: `.optional()` ONLY so an items[]-only call need not carry one. The
    // requirement for the single form is enforced in the preprocess above — see the
    // comment there for why it cannot live on this field.
    expects: expectsArg.optional(),
    relayOf: relayOfArg,
    relayQuote: relayQuoteArg,
    gateRefs: gateRefsArg,
    noBodyRefs: noBodyRefsArg,
    wake: wakeArg,
    wakeOnReply: wakeOnReplyArg,
    replyDeadlineSec: replyDeadlineSecArg,
    endTurn: endTurnArg,
    backstop: backstopArg,
    scope: scopeArg,
    hive: hiveArg,
    allHive: allHiveArg,
    asAuthority: asAuthorityArg,
    report: reportArg,
    expectEffect: expectEffectArg,
    items: z
      .array(itemSpec)
      .min(1)
      .max(100)
      .optional()
      .describe(
        'send many DISTINCT messages at once — each { to, summary, expects, harness?, body?, files?, plan_slug?, related_msg_id?, wake?, wakeOnReply?, endTurn? }; a top-level `harness` is the default for items that omit it — `expects` is required on EVERY item',
      ),
  }).meta({
    'x-papercusp-call-constraint':
      'When `items` is omitted, top-level `to`, `summary`, and `expects` are required; when `items` is used, each item must include its own `to`, `summary`, and `expects`.',
  })),
  result: z
    .object({
      ok: z.boolean().optional(),
      to: z.unknown().optional(),
      msg_id: z.string().optional(),
      error: z.string().optional(),
      partial: z.boolean().optional(),
      deliveryFailureWarning: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const idempotencyKey =
      typeof ctx.idempotencyKey === 'string' && ctx.idempotencyKey.trim().length > 0
        ? ctx.idempotencyKey.trim()
        : undefined;
    // P-009: build the dead-signal census sink ONCE per invocation, here, because
    // the handler is the only scope holding the `ctx.metadata` channel it writes
    // through. Threaded into sendOne rather than resolved deeper: `sendOne` has no
    // ctx, and giving a per-message function its own ambient sink would hide a
    // per-invocation fact in module state. Undefined when the ctx carries no
    // metadata channel, so non-tool callers degrade to today's behaviour.
    //
    // DYNAMIC import, deliberately — see the type-only import at the top of this
    // file: a static value import would put `@papercusp/db-org` in the send path's
    // load-time graph. Fail-soft: the census is an instrument, so a resolution
    // failure must cost a measurement, never a send.
    let observeCensus: ((census: DerivedSignalCensus) => void) | undefined;
    try {
      const { censusObserverFor } = await import('../../../coord/derived-signal-census');
      observeCensus = censusObserverFor(ctx);
    } catch {
      observeCensus = undefined;
    }
    // The sender's own harness when it's a real, harness-scoped agent (pipeline
    // roles carry ctx.harnessSlug); '*'/empty = SU/operator/oracle wildcard.
    // P-001: an un-scoped sender no longer silently stays local — in a workspace
    // with exactly one SHARED Hive its sends default to that Hive's home scope
    // (so they federate), resolved per message by effectiveFederationScope.
    const rawCtxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const ctxHarness =
      typeof rawCtxHarness === 'string' && rawCtxHarness && rawCtxHarness !== '*'
        ? rawCtxHarness
        : undefined;

    // EI-19295149246007753: the single-form message used to be built from a HAND-LISTED
    // ~30-field object literal, independent of `itemSpec` (the items[] axis's own field
    // list). The two lists could silently DIVERGE: a field added to itemSpec (and mirrored
    // onto the top-level object schema, so it validates fine) rode automatically into the
    // items[] axis via `{ ...it }` but was never copied here unless someone remembered to
    // also add it to this literal — and there was no error, just a field that validated,
    // was accepted (ok:true), and then silently vanished before sendOne ever saw it.
    //
    // Fixed structurally rather than by re-auditing the list: `itemSpec.shape` IS the
    // canonical field set for one message (it's what the generated tool schema advertises
    // for `items`), so the single form is derived by copying each of those same-named keys
    // off `args` instead of re-declaring them. A new field added to itemSpec (and therefore
    // to the top-level schema, which mirrors it field-for-field — see the object literal a
    // few lines up) now reaches sendOne on BOTH axes from one declaration; there is no
    // second list left to forget.
    const list: SendMsg[] = args.items?.length
      ? args.items.map((it) => ({
          ...it,
          // A top-level harness is the batch default; an item-level harness
          // remains authoritative for that distinct message.
          ...(args.harness !== undefined && it.harness === undefined
            ? { harness: args.harness }
            : {}),
          // Keep the envelope-level wake as the default for each distinct
          // message, while an item-level wake remains authoritative. Without
          // this, a valid top-level `wake` is accepted and then silently
          // disappears on the items[] axis.
          ...(args.wake !== undefined && it.wake === undefined ? { wake: args.wake } : {}),
        }))
      : [
          Object.fromEntries(
            Object.keys(itemSpec.shape).map((key) => [key, (args as Record<string, unknown>)[key]]),
          ) as unknown as SendMsg,
        ];
    // fleet-scoped-broadcast-default: resolve the sender's fleet ONCE (only when a
    // message actually broadcasts) so a fleeted agent's bare ['*'] is scoped to
    // @fleet:<slug> rather than every agent in the hive. Fail-soft: a presence-read
    // hiccup degrades to "no fleet" → today's literal '*' behavior.
    const anyWildcard = list.some((m) => m.to.includes('*'));
    let senderFleet: string | null = null;
    // P-003: a broadcast is a fleet-leader / Queen "status send" — resolve the
    // sender's structured authority+scope ONCE (only when something actually
    // broadcasts) so each `*`-broadcast cue is stamped with its provenance. null
    // for a caller with no recognized control authority (an ordinary bee/su).
    let senderCueAuthority: CueAuthorityStamp | null = null;
    if (anyWildcard) {
      try {
        // P-004 FIX: fleetSlug lives on the fleet-membership JOIN (coord_presence
        // via fetchPresenceFleet), NOT on PresenceRecord — the old
        // `getPresence(...).fleetSlug` read `undefined` every time, so a fleeted
        // sender's `['*']` was NEVER down-scoped and the whole scope-broadcast
        // default was a production no-op (a leader could broadcast a drain/pause
        // cue to every agent, incl. peer leaders outside its fleet). Resolve it
        // from the correct source so the down-scope to @fleet:<slug> actually fires.
        senderFleet = (await fetchPresenceFleet([identity.ownerId])).get(identity.ownerId)?.fleetSlug ?? null;
      } catch {
        senderFleet = null;
      }
      senderCueAuthority = await resolveSenderCueAuthority(identity);
    }

    // review-system-rework-reduction P-008 / RSR-P-008-B: an over-cap body is
    // delivered IN FULL as ordered inbox-sized parts instead of being refused or
    // clipped (send-chunking.ts owns the contract). Expanded BEFORE runBulk so each
    // part is an ordinary message through the one per-message pipeline below, in
    // order (runBulk's default concurrency is 1), and the final part — the one that
    // carries the ask and the wake — persists last.
    const expanded: Array<{
      msg: SendMsg;
      chunk?: ChunkPartMeta;
      refusal?: { error: string; message: string } & Record<string, unknown>;
      goalReportPreVerdict?: GoalOwnerReportVerdict;
    }> = [];
    for (const original of list) {
      if (original.report && typeof original.report === 'object' && 'goalReport' in original.report) {
        expanded.push({ msg: original });
        continue;
      }
      const plan = chunkOverCapMessage(original);
      if (plan.kind === 'single') expanded.push({ msg: original });
      else if (plan.kind === 'refused') {
        expanded.push({ msg: original, refusal: { error: plan.error, message: plan.message } });
      } else {
        // EI-23793424529287793: judge a GOAL owner report on the WHOLE authored
        // body, never per part. An incomplete report is refused as one message
        // (no part persists); a complete one is stamped once, on the final part,
        // and its continuations skip the check they would each fail alone.
        const verdict = await evaluateGoalOwnerReport(original, identity);
        if (verdict.kind === 'refused') {
          const { ok: _ok, to: _to, ...refusal } = verdict.result;
          expanded.push({ msg: original, refusal: refusal as { error: string; message: string } });
          continue;
        }
        for (const part of plan.parts) {
          const isFinal = part.meta.part === part.meta.of;
          expanded.push({
            msg: part.message,
            chunk: part.meta,
            goalReportPreVerdict: isFinal ? verdict : { kind: 'skip' },
          });
        }
      }
    }

    const env = await runBulk(
      expanded,
      async ({ msg, refusal, goalReportPreVerdict }, itemIndex) => {
        if (refusal) return { ok: false, to: msg.to, ...refusal };
        // Capture the ORIGINAL broadcast intent BEFORE scopeBroadcastAudience
        // rewrites `*` → @fleet:<slug>: only a broadcast is stamped (P-003).
        const wasBroadcast = msg.to.includes('*');
        // Auto-scope the broadcast BEFORE resolve/persist, then thread the report
        // through so the rewrite (or conscious all-hive claim) shows on the result.
        const bcast = scopeBroadcastAudience({ to: msg.to, senderFleet, allHive: msg.allHive });
        // EI-9501: a fleet leader's cue is stamped fleet-members-scoped (from the
        // SAME senderFleet read scopeBroadcastAudience just used to decide the
        // audience) — so if allHive kept the audience literally '*' while the
        // stamp says "only my fleet's members should act on this", the message
        // just told every agent in the hive to act on a cue that isn't theirs.
        // That contradiction is never intentional (a genuinely hive-wide cue has
        // no fleet-scoped stamp to begin with — see hiveWideCueAuthority) so
        // refuse it with a teaching error instead of shipping the mismatch.
        // EI-18791996856052350: the refusal's remedy — "send it from a
        // non-fleet-authority context" — was UNREACHABLE. Fleet leadership is a
        // property of the sender's IDENTITY, not of the call, so a leader had no
        // context to send from and could not issue a hive-wide NOTICE at all
        // (observed holding a fleet-wide outage item it could not warn the hive
        // about). `asAuthority:'none'` makes that remedy executable: the message
        // is delivered UNSTAMPED, so it informs the hive without carrying control
        // weight over agents outside the fleet — a leader may INFORM the hive,
        // never COMMAND it. The EI-9501 accident stays refused: leaking a
        // fleet-control cue now requires consciously declaring it carries no
        // fleet authority, which is not something a pause/drain directive can
        // truthfully say. The conscious claim is still stamped allHiveBroadcast
        // on the envelope (P-010/H5b), so the sweep detector still sees it.
        const renouncedFleetAuthority =
          msg.asAuthority === 'none' && senderCueAuthority?.scope === 'fleet-members';
        if (
          wasBroadcast &&
          bcast.allHive &&
          senderCueAuthority?.scope === 'fleet-members' &&
          !renouncedFleetAuthority
        ) {
          return {
            ok: false,
            to: msg.to,
            error: 'fleet_scoped_cue_allhive_contradiction',
            message:
              `allHive:true would broadcast to every agent in the hive, but as fleet leader of ` +
              `'${senderCueAuthority.scopeRef}' your cue is stamped fleet-members(${senderCueAuthority.scopeRef}) — ` +
              `only YOUR fleet's members are meant to act on it. Drop allHive (a bare '*' auto-scopes ` +
              `to @fleet:${senderCueAuthority.scopeRef}, which already includes your leader). If this is a ` +
              `genuinely hive-wide NOTICE unrelated to fleet control (an outage, a shared-tree fault), ` +
              `re-send it with asAuthority:'none' — that renounces your fleet-control authority for this ` +
              `one message, so it is delivered UNSTAMPED: you INFORM the hive without commanding agents ` +
              `outside your fleet. Do NOT use it to push a fleet-control cue (drain/pause/steer) through.`,
          };
        }
        msg.to = bcast.to;
        const scoped = await effectiveFederationScope(
          msg.scope,
          msg.harness,
          ctxHarness,
          identity.workspaceId,
          msg.to,
          msg.hive,
        );
        if ('error' in scoped) return scoped.error;
        return sendOne(
          msg,
          identity,
          scoped.harnessSlug,
          { scoped: bcast.scoped, allHive: bcast.allHive, renouncedFleetAuthority },
          wasBroadcast && !renouncedFleetAuthority ? senderCueAuthority : null,
          observeCensus,
          idempotencyKey,
          itemIndex,
          goalReportPreVerdict,
          ctx.signal,
        );
      },
      {
        keyOf: ({ msg }) => ({ to: msg.to }),
      },
    );
    // RSR-P-008-B: stamp each delivered part with its place in the chunked message,
    // and summarise every chunked message on the envelope, so the sender can see
    // that one logical message became N rows (and which msg_id carries the ask).
    const chunkedMessages = new Map<string, { group: string; of: number; msgIds: Array<string | null> }>();
    env.results.forEach((result, index) => {
      const chunk = expanded[index]?.chunk;
      if (!chunk) return;
      (result as Record<string, unknown>).chunk = chunk;
      const entry = chunkedMessages.get(chunk.group) ?? { group: chunk.group, of: chunk.of, msgIds: [] };
      entry.msgIds[chunk.part - 1] = typeof result.msg_id === 'string' ? result.msg_id : null;
      chunkedMessages.set(chunk.group, entry);
    });
    const chunked = chunkedMessages.size
      ? {
          chunked: [...chunkedMessages.values()].map((entry) => ({
            group: entry.group,
            parts: entry.of,
            msgIds: entry.msgIds,
            askMsgId: entry.msgIds[entry.of - 1] ?? null,
          })),
          chunkedNote:
            'A body over the inbox cap was delivered in full as ordered parts, each fully visible in a ' +
            'normal inbox read. Only the final part (askMsgId) carries expects, the wake and reply ' +
            'threading; earlier parts are expects:none continuations.',
        }
      : {};
    // The shared bulk contract DERIVES the envelope's `ok` from `results[].ok`
    // (EI-23737206446729041), so a thrown persistence error — for example a transient
    // PG lock timeout that becomes a nested `{ ok:false }` — already makes this call
    // falsy rather than looking like a clean send. That is the load-bearing rail; the
    // delivery-specific `partial` + `deliveryFailureWarning` below stay because they
    // name WHICH messages failed and why, which a boolean cannot carry.
    const bodyTruncated = env.results.filter(
      (result) =>
        result.ok &&
        typeof result.bodyAuthoredChars === 'number' &&
        typeof result.bodyDeliveredChars === 'number' &&
        result.bodyDeliveredChars < result.bodyAuthoredChars,
    );
    const bodyDeliveryWarning =
      bodyTruncated.length > 0
        ? (() => {
            const details = bodyTruncated
              .map((result) => {
                const msgId = typeof result.msg_id === 'string' ? result.msg_id : 'unknown message';
                return `${msgId} (${result.bodyDeliveredChars}/${result.bodyAuthoredChars} chars visible)`;
              })
              .slice(0, 3)
              .join(', ');
            return (
              `coord:send FAILED the full-body contract for ${bodyTruncated.length} ` +
              `message${bodyTruncated.length === 1 ? '' : 's'} (${details}): bodyDeliveredChars < ` +
              `bodyAuthoredChars, so the default inbox body is incomplete. This is why the envelope ` +
              `reports ok:false — the rows WERE persisted and the FULL text is durable, but a lossy ` +
              `send never reports ok:true, because the recipient acting on the clipped text is ` +
              `indistinguishable from one acting on all of it. Either shorten the load-bearing ask ` +
              `below the cap so every character is delivered, or point the recipient at ` +
              `results[].bodyReadRef with coord:read and re-send deliberately.`
            );
          })()
        : undefined;
    // WI-41323: hoist the unverified-authority-claim flag to the ENVELOPE for the
    // same reason bodyDeliveryWarning is hoisted — a sender reads the top level,
    // and a single send still comes back as results[0], one level down. The
    // per-message object stays where it is; this is the line that gets READ.
    const claimed = env.results.filter(
      (result) => result.ok && readClaimKind(result.unverifiedAuthorityClaim) !== null,
    );
    const authorityClaimWarning =
      claimed.length > 0
        ? (() => {
            const kinds = [
              ...new Set(
                claimed
                  .map((result) => readClaimKind(result.unverifiedAuthorityClaim))
                  .filter((kind): kind is string => kind !== null),
              ),
            ].join('/');
            return (
              `coord:send delivered ${claimed.length} message${claimed.length === 1 ? '' : 's'} ` +
              `asserting ${kinds} authority with no verified relay provenance — each renders to its ` +
              `recipients prefixed ${UNVERIFIED_CLAIM_TAG}. They WERE sent; nothing was withheld. ` +
              `Read results[].unverifiedAuthorityClaim.note for how to send the claim backed ` +
              `(relayOf / relayQuote), or restate it in your own voice if it is your judgement ` +
              `rather than someone else's directive.`
            );
          })()
        : undefined;
    // P-001 / spec-coord-send-no-silent-body-truncation@3: a lossy body is a HARD
    // verdict, not a note printed beside ok:true. The predicate above ALREADY detects
    // the condition and both counts are already in hand at send time, so this
    // escalates the existing signal rather than adding a second measurement.
    //
    // Why ok:false even though the rows persisted: the durable coord row keeps the
    // full text, but the SENDER's contract is about what the recipient will read, and
    // a recipient acting on a clipped ask is indistinguishable from one acting on all
    // of it. A caller that checks only top-level `ok` must therefore never see `true`
    // for a shortened body. `bodyDeliveryLossy` is the machine-readable flag; the
    // warning names both counts, and results[].bodyReadRef still addresses the full text.
    //
    // Note the predicate is `bodyTruncated` (definitely over bodyDeliveryCap), NOT
    // `bodyMayBeTruncated` (the smaller crowded-page cap, which is conditional on how
    // busy the reader's page happens to be). Only a certain loss fails the send.
    const warnedEnv = {
      ...env,
      ...chunked,
      ...(bodyDeliveryWarning
        ? { ok: false, bodyDeliveryLossy: true, bodyDeliveryWarning }
        : {}),
      ...(authorityClaimWarning ? { authorityClaimWarning } : {}),
    };
    const failed = env.results.filter((result) => !result.ok);
    if (failed.length > 0) {
      const errors = failed
        .map((result) => (typeof result.error === 'string' ? result.error : 'unknown delivery error'))
        .filter((error, index, all) => all.indexOf(error) === index)
        .slice(0, 3)
        .join('; ');
      const warning =
        `coord:send completed the batch, but ${failed.length} message${failed.length === 1 ? '' : 's'} ` +
        `failed delivery (counts.failed:${env.counts.failed}). Top-level ok is therefore FALSE — ` +
        `do not assume every message was delivered; inspect results[].ok and retry or re-dispatch the failed ` +
        `message${failed.length === 1 ? '' : 's'} as appropriate.` +
        (errors ? ` Failure detail: ${errors}` : '');
      return bulkContent({
        ...warnedEnv,
        partial: true,
        deliveryFailureWarning: warning,
      });
    }
    return bulkContent(warnedEnv);
  },
});
