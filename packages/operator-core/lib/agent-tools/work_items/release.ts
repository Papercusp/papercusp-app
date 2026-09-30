/**
 * work_items:release — Claimable (D-003). Unassigns the work-item.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): release ONE inline
 * ({ id }), or MANY (ids:[…] / items:[{ id, harness? }]) → { ok, results:[{ ok, id,
 * workItem? | error }], counts }. Each result self-describes its id; one not-found
 * item never fails the rest. The plan-item reflect rules (flip the converted plan
 * item back to todo + drop the lease) fire per released item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { WORK_ITEM_LIFECYCLE_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { releaseWorkItem, setWorkItemClaimHold, getWorkItem, commentWorkItem } from '../../work-items';
import { runBulk, bulkContent, bulkEnvelopeSchema } from '../_bulk';
import {
  assessForceRelease,
  forceRefusalHint,
  notifyForceRelease,
  recordForceReleaseAudit,
  type ForceReleaseBasis,
} from './release-force-guard';
import { readWorkItemReleaseRequest, resolveWorkItemReleaseRequest } from '../../work-items-release-request';
import { getWorkItemCheckpointWithMeta, setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { detectBgJobCheckpointClaim } from '../../checkpoint-bg-job-claim';
import { readOutbox } from '../coordination/messages';
import { listEscalations, type EscalationRecord } from '../coordination/escalations';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { CLAIM_STATES_ALLOWLIST } from '../../scheduler/claim-states';
import { STALE_CLAIM_GRACE_MS } from '../../work-items-stale-claims';
import { clampText, softText } from '../limits';
import { buildDurableParkReleaseContract } from '../../durable-park-release-contract';
import type { DurableParkReleaseContract } from '../../work-items-durable-park-audit';
import { PREMISE_STAMPS_FIELD } from '../coordination/premise-resolve';

const RELEASE_REASON_MAX_CHARS = 500;
const releaseReasonSchema = () =>
  softText(RELEASE_REASON_MAX_CHARS)
    .optional()
    .describe(
      'Optional audit/park reason — auto-truncated to 500 chars if longer. On a voluntary release of an item that ' +
        'has NO checkpoint, it is also stored AS that item\'s checkpoint, so one line here becomes the next ' +
        'claimant\'s starting context instead of stopping at the audit row.',
    );

const claimHoldReleaseSchema = z
  .object({
    condition: z
      .string()
      .min(1)
      .max(1000)
      .describe('the concrete condition that permits this durable park to be reconsidered'),
    trigger: z
      .string()
      .min(1)
      .max(300)
      .describe('the exact events:await key that signals the condition may have changed'),
    owner: z.string().min(1).max(200).optional().describe('accountable condition owner/source; defaults to the parker'),
  })
  .strict();

type ClaimHoldReleaseInput = z.infer<typeof claimHoldReleaseSchema>;

const CLAIM_HOLD_RELEASE_CONSTRAINT =
  'claimHold:true requires claimHoldRelease { condition, trigger, owner? }; durable parks must declare a typed re-evaluation contract (including per-item overrides and batch defaults)';

/** Resolve, rather than trust, the release condition's live event status — one shared
 * contract writer (also used by the P-030 plan supersede cascade). */
async function buildClaimHoldReleaseContract(
  input: ClaimHoldReleaseInput,
  defaultOwner: string,
): Promise<DurableParkReleaseContract> {
  return buildDurableParkReleaseContract(input, defaultOwner);
}

/**
 * A completion assertion is intentionally a narrow, advisory signal. It is not
 * a substitute for the item's terminal state: it catches the dangerous shape
 * where a holder says the work is finished over coord and then releases an open
 * item without calling work_items:complete.
 *
 * Keep the prose matcher affirmative and local to the item reference. A broad
 * "message contains complete" check would turn questions, negated findings, and
 * completion claims about a different item into false alarms.
 */
const COMPLETION_ASSERTION_PATTERNS = [
  /\b(?:is|was|has been|already|now)\s+(?:fully\s+)?(?:complete|completed|done|finished|resolved|closed)\b/i,
  /\b(?:completed|finished|implemented|landed|shipped)\s+(?:it|the work|this item|everything|the fix)\b/i,
  /\b(?:nothing|no work)\s+(?:is|was|remains|left)\b/i,
  /\b(?:do not|don't|never)\s+(?:take|redo|rebuild|pick up|reclaim)\b/i,
  /\b(?:work|fix|item|task)\s+(?:is|was)\s+(?:all\s+)?(?:done|complete|finished)\b/i,
] as const;

const NON_COMPLETION_PATTERNS = [
  /\b(?:not|isn't|isnt|wasn't|wasnt)\s+(?:yet\s+)?(?:complete|completed|done|finished|resolved|closed)\b/i,
  /\b(?:still|currently|actively)\s+(?:working|running|investigating|in progress)\b/i,
  /\b(?:will|would|should|might|may|could)\s+(?:be\s+)?(?:complete|completed|done|finished|resolved|closed)\b/i,
] as const;

function escapedRegExp(value: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9])${value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?:$|[^A-Za-z0-9])`, 'i');
}

function sectionText(section: unknown): string {
  if (!section || typeof section !== 'object') return '';
  const record = section as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.text === 'string') parts.push(record.text);
  if (typeof record.premises === 'string') parts.push(record.premises);
  if (Array.isArray(record.premises)) parts.push(...record.premises.filter((v): v is string => typeof v === 'string'));
  const relation = record.forYouBecause;
  if (relation && typeof relation === 'object') {
    const relationRecord = relation as Record<string, unknown>;
    for (const key of ['ref', 'note', 'relation']) {
      if (typeof relationRecord[key] === 'string') parts.push(relationRecord[key] as string);
    }
  }
  return parts.join('\n');
}

/**
 * Flatten a coord envelope (message OR escalation) to its readable text segments.
 * Shared by BOTH release-time detectors — the completion-assertion read below and
 * the open-escalation read (EI-14883) — so they cannot drift on which fields count
 * as "what the sender actually said".
 */
function coordMessageText(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['summary', 'body']) {
    if (typeof record[key] === 'string') parts.push(record[key] as string);
  }
  if (Array.isArray(record.sections)) parts.push(...record.sections.map(sectionText).filter(Boolean));
  return parts;
}

/**
 * EI-22067370681761514: `premisesClassified` (and the raw `premises` a sender
 * typed) carry only the SYNTACTIC shape of a cited ref — stamped unconditionally,
 * before anything checks whether the claim is true. `premiseStamps` (send.ts,
 * P-011/WI-6731) is the SEPARATE, later-resolved verdict: `status:'broken'` means
 * the ref was checked at send time and found FALSE — here, that `<itemId>#completion`
 * had NOT happened. A sender citing a broken `#completion` premise is not asserting
 * the item is done; they are recording that it explicitly is not (e.g. "premise:
 * EI-X#completion — broken, item is open" attached to a "claimed for the next wake,
 * no edits started" message). Read the resolved verdict when one was stamped; only
 * fall back to the bare syntactic match when no stamp exists for that ref (older
 * messages, or a stamp the resolver could not produce — fail toward the existing,
 * more conservative behavior rather than a new false negative).
 */
function resolvedCompletionPremiseStatus(message: unknown, ref: string): unknown {
  if (!message || typeof message !== 'object') return undefined;
  const stamps = (message as Record<string, unknown>)[PREMISE_STAMPS_FIELD];
  if (!Array.isArray(stamps)) return undefined;
  const normalized = ref.trim().toLowerCase();
  const stamp = stamps.find(
    (s) =>
      s &&
      typeof s === 'object' &&
      typeof (s as Record<string, unknown>).ref === 'string' &&
      ((s as Record<string, unknown>).ref as string).trim().toLowerCase() === normalized,
  ) as Record<string, unknown> | undefined;
  return stamp?.status;
}

function hasStructuredCompletionPremise(message: unknown, itemId: string): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as Record<string, unknown>;
  const refs: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') refs.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      if (typeof nested.ref === 'string') refs.push(nested.ref);
      if (nested.premises !== undefined) collect(nested.premises);
      if (nested.premisesClassified !== undefined) collect(nested.premisesClassified);
    }
  };
  collect(record.premises);
  collect(record.premisesClassified);
  if (Array.isArray(record.sections)) {
    for (const section of record.sections) {
      if (!section || typeof section !== 'object') continue;
      const sectionRecord = section as Record<string, unknown>;
      collect(sectionRecord.premises);
      collect(sectionRecord.premisesClassified);
    }
  }
  const ref = new RegExp(`^(?:wi:)?${itemId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}#completion$`, 'i');
  const matches = refs.map((candidate) => candidate.trim()).filter((candidate) => ref.test(candidate));
  if (!matches.length) return false;
  // A resolved `broken` verdict on EVERY matching ref means every cited
  // #completion premise was checked and found false — not an assertion.
  // A ref with no stamp, or a stamp whose status is not `broken` (holds /
  // stale / unresolvable / unknown / not-checkable), keeps the existing
  // conservative (fires) behavior.
  return !matches.every((candidate) => resolvedCompletionPremiseStatus(record, candidate) === 'broken');
}

/**
 * Keep an affirmative completion phrase attached to the clause that names the
 * item. A message can legitimately contain both "consolidation is complete"
 * and a still-open item that is being released; treating the whole message as
 * one segment makes the former look like a claim about the latter.
 */
function completionClauses(segment: string): string[] {
  return segment
    .split(/(?:\r?\n|[.!?;]+|:\s+|,\s+(?=[A-Z0-9])|\s+(?:—|–|--)+\s+)/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function assertsCompletionForItem(message: unknown, itemId: string): boolean {
  if (hasStructuredCompletionPremise(message, itemId)) return true;
  const itemRef = escapedRegExp(itemId);
  return coordMessageText(message).some((segment) => {
    return completionClauses(segment).some((clause) => {
      if (!itemRef.test(clause)) return false;
      if (!COMPLETION_ASSERTION_PATTERNS.some((pattern) => pattern.test(clause))) return false;
      return !NON_COMPLETION_PATTERNS.some((pattern) => pattern.test(clause));
    });
  });
}

async function readPriorCompletionAssertion(
  holder: string,
  itemId: string,
): Promise<{ msgId: string; ts: string } | null> {
  try {
    // EI-22501782402425140: this release-time advisory used to scan the holder's
    // entire outbox. Use the bounded newest-first window and stop as soon as an
    // assertion is visible; if none is found, readOutboxWindow still caps the
    // search at its page budget and reports the shortfall through its warning.
    const isMatch = (message: CoordEnvelope): boolean =>
      message.from === holder && assertsCompletionForItem(message, itemId);
    const messages = await readOutbox(holder, {}, { enough: (entries) => entries.some(isMatch) });
    const match = messages.find(isMatch);
    return match ? { msgId: match.msg_id, ts: match.ts } : null;
  } catch {
    // A coord read outage must never turn a voluntary release into a failed release.
    return null;
  }
}

/** An open escalation reduced to what the release disclosure needs to cite. */
type OpenEscalationRef = { msgId: string; ts: string; from: string; severity: string };

/**
 * Widened alias of the claim allowlist. `CLAIM_STATES_ALLOWLIST` is `as const`, so a
 * membership test against an arbitrary status string needs the readonly-string[] view
 * rather than an inline cast at the call site. Deliberately the SAME constant the
 * scheduler enforces, so "will this row be re-offered?" cannot drift from what
 * scheduler:get_next / claim_next actually select.
 */
const CLAIMABLE_AFTER_RELEASE: readonly string[] = CLAIM_STATES_ALLOWLIST;

/**
 * EI-14883 (observed live on WI-3627, 2026-07-17): an item whose escalation is still
 * OPEN is not "someone else can just pick this up as-is" — the only thing a fresh
 * claimant can do is re-derive "already escalated, awaiting a decision" from the
 * comment thread. There, the holder did the owner-gated steps correctly (enumerate +
 * coord:escalate) and then plain-released; scheduler:get_next handed the row to the
 * next drive-by fleet member ~2.5h later, who had no new information.
 *
 * Match ANY open escalation naming the item, not only the RELEASING holder's. The
 * ping-pong is precisely the case where the escalator and the current holder DIFFER:
 * hop 1 escalates and releases, hop 2 claims, re-discovers the same wall, releases.
 * Scoping this to the prior holder — as the completion-assertion read above does,
 * where the assertion is inherently that holder's own claim — would catch only hop 1
 * and stay silent for every repeat, which is the part that actually burns turns.
 */
function escalationNamesItem(record: unknown, itemId: string): boolean {
  const itemRef = escapedRegExp(itemId);
  return coordMessageText(record).some((segment) => itemRef.test(segment));
}

/**
 * One open-escalation read per TOOL CALL, not per item: release is bulk (up to 200
 * items) and listEscalations({status:'open'}) folds the workspace's whole open set,
 * so a per-item read would multiply it by 200. Lazy, so a release that never reaches
 * the disclosure path pays nothing. Fail-soft for the same reason as its sibling: a
 * coord read outage resolves to an empty set (no warning), never a failed release.
 */
function openEscalationReader(): (itemId: string) => Promise<OpenEscalationRef | null> {
  let pending: Promise<EscalationRecord[]> | null = null;
  return async (itemId: string) => {
    pending ??= listEscalations({ status: 'open' }).catch(() => [] as EscalationRecord[]);
    const open = await pending;
    const match = open.find((record) => escalationNamesItem(record, itemId));
    if (!match) return null;
    return {
      msgId: match.msg_id,
      ts: match.ts,
      from: typeof match.from === 'string' && match.from.trim() ? match.from : 'unknown',
      severity: typeof match.severity === 'string' ? match.severity : 'advisory',
    };
  };
}

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  claimHold: z.boolean().optional().describe('per-item claim-hold override (else the batch `claimHold` default)'),
  claimHoldRelease: claimHoldReleaseSchema
    .optional()
    .describe('typed release condition required when the effective claimHold is true'),
  force: z.boolean().optional().describe('per-item override of the batch `force` default'),
  reason: releaseReasonSchema().describe(
    "per-item override of the batch `reason` (required when force clears a peer's claim)",
  ),
});

export default defineTool({
  name: 'work_items:release',
  profile: 'engineer',
  // P-011 prompt-weight: the result shape and the whole not_holder / force_unauthorized
  // refusal contract lived in the counted `description`. `returns` is free, so they moved
  // there verbatim — same words, same place a caller looks after a refusal, zero budget
  // (EI-22083648545226771).
  description:
    'Release one OR many work-items (clear assignee / taken_by) so another agent can pick them up. Single: { id }. Many: { ids:[…] } or items:[{ id, harness? }]. `claimHold:true` (both families) ALSO durably parks the item out of claim_next/scheduler:get_next self-select (WI-2797) and requires `claimHoldRelease:{condition,trigger,owner?}`; the writer resolves reachability/evidence from the event ledger. The park survives your session ending, remains claimable by id, and `claimHold:false` clears it.',
  guidance: {
    returns:
      'Returns { ok, results:[{ ok, id, workItem? | error, holder? }], counts } — correlate by id; a not-found item never fails the rest. Refuses to clear ANOTHER agent\'s live claim (`{ ok:false, error:"not_holder", holder }` per item); `force:true` is a CHECKED override (WI-4198), not a bypass — non-live holder / queen / the holder\'s fleet leader only, requires `reason`, audited + notifies holder and owner (full rules on the `force` arg); anything else refuses with `force_unauthorized`. A voluntary release records a short re-claim cooldown. A plain release that puts the row back into a CLAIMABLE state while an escalation naming it is still open also returns advisory `openEscalation { msgId, ts, from, severity }` + `openEscalationWarning` (EI-14883): the row will be re-offered to a claimant who inherits no new information, so make the disposition durable with state:"needs-human" or claimHold:true. Advisory only — it never blocks the release, and an already-parked (needs-human/blocked) row is not flagged.',
    when: 'You claimed work-item(s) but are no longer working them. Add claimHold:true plus claimHoldRelease when the item must NOT be opportunistically re-claimed until a named event condition changes — plain release lets it re-surface immediately.',
    notWhen:
      "A per-item `not_holder` means a LIVE peer currently holds it — coordinate with the `holder` (coord:send), do not blind-force: force is for reclaiming a dead/stuck agent's item, never for clearing a peer's in-flight claim.",
    chaining: 'work_items:claim → … → work_items:release.',
    // EI-21829130743047093: a caller handing the item back tried to leave its note in the
    // SAME call (`release { id, checkpoint }`) — the natural shape, because releasing and
    // recording why are one intention. They are two verbs here, and the unrecognized-key
    // rejection could only list what release accepts, never name the writer. This is a
    // CAPABILITY boundary, not a rename, so it redirects to the verb rather than adding a
    // key. Zero prompt weight (argRedirects is excluded from describeFromGuidance), paid
    // only on that rejection.
    argRedirects: {
      checkpoint: {
        tool: 'work_items:checkpoint',
        args: { id: '<work-item-id>', checkpoint: '<the carry note>' },
        note: 'release ends your hold and persists no note — work_items:checkpoint is the writer. Call it BEFORE releasing: the note survives either way, but a plain release re-surfaces the item immediately, so a checkpoint written afterwards can land after the next claimant has already started without it.',
      },
    },
    seeAlso: [
      'work_items:set_state { state:"blocked" } (standalone feature-family park; plan-linked feature items must use plans:set-status because the plan item is the source of truth; issue-family aliases blocked back to open — release { claimHold:true } is the durable self-select exclusion)',
      'work_items:hold_open (hold the item open — stamps held_open_by + blocks non-holder terminal transitions — WITHOUT releasing your claim)',
      'work_items:claim (re-take it later, or claim a held item directly by id — a hold only excludes self-select)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...WORK_ITEM_LIFECYCLE_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-release shorthand: the work-item id'),
      ids: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .optional()
        .describe('release many work-items at once (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('release many, each { id, harness?, claimHold? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      claimHold: z
        .boolean()
        .optional()
        .describe(
          'default claim-hold for the inline id / every id in `ids` (both families): true excludes the item from claim_next/scheduler:get_next self-select until cleared; false clears a prior hold.',
        ),
      claimHoldRelease: claimHoldReleaseSchema
        .optional()
        .describe(
          'default typed release condition for claimHold:true; reachability/evidence are resolved by the writer',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'default force for the inline id / every id in `ids`: release even if held by ANOTHER agent. CHECKED override (WI-4198): allowed only when the holder is not live, or you are queen, or you lead the HOLDER\'s fleet — and a cross-holder force requires `reason` and is audited + notifies holder/owner. Default false: refuses with { error:"not_holder", holder } when the caller is not the current holder.',
        ),
      reason: releaseReasonSchema().describe(
        "default reason for the inline id / every id in `ids` — REQUIRED when force clears another agent's claim; auto-truncated to 500 chars if longer, then recorded in the audit row/notifications and any durable park.",
      ),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    })
    .superRefine((a, ctx) => {
      const effective = a.items?.length
        ? a.items.map((item, index) => ({
            hold: item.claimHold ?? a.claimHold,
            release: item.claimHoldRelease ?? a.claimHoldRelease,
            path: ['items', index, 'claimHoldRelease'] as (string | number)[],
          }))
        : [{ hold: a.claimHold, release: a.claimHoldRelease, path: ['claimHoldRelease'] as (string | number)[] }];
      for (const entry of effective) {
        if (entry.hold === true && !entry.release) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: entry.path,
            message: CLAIM_HOLD_RELEASE_CONSTRAINT,
          });
        }
      }
    })
    .meta({ 'x-papercusp-call-constraint': CLAIM_HOLD_RELEASE_CONSTRAINT }),
  // The `returns` prose above INTERPRETS this result; the structural shape comes
  // from here (guidance-output-schema-live-guard). Shared, not hand-rolled: the
  // handler returns `bulkContent(env)` straight from `runBulk`, so the envelope
  // is `_bulk`'s to describe — see bulkEnvelopeSchema. Per-item stays open
  // because this tool spreads delta / stranding / completion / claimHoldFailure /
  // reasonDisclosure onto each result.
  result: bulkEnvelopeSchema(),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // EI-14883: memoized per tool call, shared across every item in the bulk.
    const readOpenEscalationForItem = openEscalationReader();
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({
            id,
            harness: args.harness,
            claimHold: args.claimHold,
            claimHoldRelease: args.claimHoldRelease,
            force: args.force,
            reason: args.reason,
          }))
        : [
            {
              id: args.id as string,
              harness: args.harness,
              claimHold: args.claimHold,
              claimHoldRelease: args.claimHoldRelease,
              force: args.force,
              reason: args.reason,
            },
          ];
    const env = await runBulk(
      list,
      async (it) => {
        const harness = it.harness ?? args.harness;
        const force = it.force ?? args.force ?? false;
        const rawReason = it.reason ?? args.reason;
        const reason = clampText(rawReason, RELEASE_REASON_MAX_CHARS);
        const reasonTruncated = typeof rawReason === 'string' && rawReason.length > RELEASE_REASON_MAX_CHARS;
        const reasonDisclosure = reasonTruncated ? { reasonTruncated: true as const } : {};
        const claimHold = it.claimHold ?? args.claimHold;
        const claimHoldReleaseInput = it.claimHoldRelease ?? args.claimHoldRelease;
        const releaseContract =
          claimHold === true && claimHoldReleaseInput
            ? await buildClaimHoldReleaseContract(claimHoldReleaseInput, ident.ownerId)
            : undefined;
        // WI-4198: force is a CHECKED override, not a bypass. Before releasing,
        // identify the holder; a cross-holder force must pass the authority/liveness
        // guard, carry a reason, and leave an audit + notification trail.
        let forced:
          | {
              holder: string;
              basis: ForceReleaseBasis;
              reason: string;
              reasonTruncated?: true;
              releaseRequest?: ReturnType<typeof readWorkItemReleaseRequest>;
            }
          | undefined;
        // WI-6678: the force path already reads the row — reuse that read for the
        // released/previousAssignee delta below instead of paying a second round-trip.
        let forcedPrior: string | null | undefined;
        if (force) {
          const current = await getWorkItem(it.id, harness);
          if (!current) return { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
          forcedPrior = current.assignee ?? null;
          const holder = current.assignee?.trim();
          if (holder && holder !== ident.ownerId) {
            const forceReason = (reason ?? '').trim();
            if (!forceReason) {
              return {
                ok: false as const,
                id: it.id,
                error: 'force_requires_reason',
                holder,
                hint: `force would clear ${holder}'s claim — pass a \`reason\` the holder and owner can audit (WI-4198).`,
              };
            }
            const releaseRequest = readWorkItemReleaseRequest(current.payload);
            const verdict = await assessForceRelease({
              callerOwnerId: ident.ownerId,
              holderOwnerId: holder,
              workspaceId: ident.workspaceId ?? '',
              itemLastProgressAt: (current as { lastProgressAt?: string | Date | null }).lastProgressAt ?? null,
              releaseRequest,
            });
            if (!verdict.allowed) {
              return {
                ok: false as const,
                id: it.id,
                error: 'force_unauthorized',
                holder,
                holderLiveness: verdict.holderLiveness,
                hint: forceRefusalHint(holder),
              };
            }
            forced = {
              holder,
              basis: verdict.basis as ForceReleaseBasis,
              reason: forceReason,
              ...(verdict.basis === 'announced-release-request-expired' && releaseRequest ? { releaseRequest } : {}),
              ...(reasonTruncated ? { reasonTruncated: true as const } : {}),
            };
          }
        }
        // WI-6678: capture the PRE-state so the caller can tell a real release from a
        // semantic NO-OP. Releasing an ALREADY-UNASSIGNED item is not an error, but it is
        // also not a release — and it used to return a result byte-identical to a real one.
        // That is unverifiable by any caller discipline: reading the post-state back shows
        // `assignee: null`, which is exactly what the pre-state was. Observed live on
        // 2026-08-01 — a fleet leader "reclaimed" two orphaned_in_flight items (a condition
        // that requires assignee IS NULL, so release CANNOT clear it), saw ok:true, verified
        // the post-state, and reported "orphans reclaimed" to the owner having changed
        // nothing. A mutation that reports success without reporting its DELTA cannot be
        // checked.
        //
        // The pre-state comes from releaseWorkItem's OWN row-read (onPriorState), never a
        // second read here. A call-site pre-read was the first cut of this fix and it was
        // wrong twice over: it paid a redundant round-trip on every release, and it was
        // RACY — between the call site's read and the library's, the assignee can change,
        // so `previousAssignee` could describe a state the release never acted on. A fix
        // for silent wrong answers must not itself be able to report one.
        const prior: { assignee: string | null; wasClaimed: boolean } = { assignee: null, wasClaimed: false };

        // EI-7588: compare-and-release — the UPDATE itself only touches an unclaimed row
        // or one already held by `ident.ownerId` (unless `force`), so a peer's live claim
        // can never be silently cleared. A null return here is either "not found" or "held
        // by someone else" — re-read to tell them apart and report an honest error.
        const workItem = await releaseWorkItem(it.id, {
          harness,
          // Every cross-holder force is authorized against one exact pre-read holder.
          // Preserve that holder as the mutation CAS so a successor claim that races
          // the authorization can never be cleared.
          expectedAssignee: forced ? forced.holder : force ? undefined : ident.ownerId,
          releasingOwnerId: ident.ownerId,
          onPriorState: (p) => {
            prior.assignee = p.assignee;
            prior.wasClaimed = p.wasClaimed;
          },
        });
        // The force path read the row a moment earlier for the authority guard; prefer the
        // library's read (it is the one the UPDATE acted on) and fall back to that read only
        // if the row vanished before it.
        const priorAssignee = prior.wasClaimed ? prior.assignee : (forcedPrior ?? prior.assignee);
        const wasHeld = prior.wasClaimed;
        if (!workItem) {
          const current = await getWorkItem(it.id, harness);
          if (!current) return { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
          const holder = current.assignee?.trim();
          if (holder && holder !== ident.ownerId) {
            return {
              ok: false as const,
              id: it.id,
              error: 'not_holder',
              holder,
              workItem: current,
              hint: `Held by ${holder}, not you (${ident.ownerId}) — release refused so a live peer's claim isn't silently cleared. Coordinate with the holder (coord:send), or pass force:true (leader/reaper override only) to release it anyway.`,
            };
          }
          // WI-6031: a federated (origin='remote') issue-family row's UPDATE is intentionally
          // no-op'd by the harness_shared.engineer_issues_view_dml INSTEAD-OF trigger (EI-7833)
          // — the row is owned by its authoring peer's core (the hyperbee->PG projector writes
          // the base table directly under LWW) and this operator's local view writes must never
          // clobber it. That guard is correct; what was undiagnosable was the caller-facing
          // signal: every OTHER visible predicate here looks fully eligible (ids match, no live
          // holder), so a bare `release_failed` gave no hint that origin was the actual cause.
          if (current.family === 'issue' && current.origin === 'remote') {
            return {
              ok: false as const,
              id: it.id,
              error: 'release_blocked_remote_origin',
              workItem: current,
              hint: `'${it.id}' is a federated (origin='remote') issue — it is owned by its authoring peer's core and cannot be released/parked from this operator. It resolves locally when its author node resolves it upstream.`,
            };
          }
          return { ok: false as const, id: it.id, error: 'release_failed', workItem: current };
        }
        if (forced) {
          // Audit + notify AFTER the release landed — both are never-throw helpers.
          await recordForceReleaseAudit(ident.ownerId, it.id, {
            holder: forced.holder,
            basis: forced.basis,
            reason: forced.reason,
            ...(forced.reasonTruncated ? { reasonTruncated: true } : {}),
            harness: workItem.harness ?? null,
          });
          await notifyForceRelease(ident, {
            itemId: it.id,
            holder: forced.holder,
            basis: forced.basis,
            reason: forced.reason,
            harness: workItem.harness ?? null,
          });
        }
        // WI-5974: a release RESOLVES any pending work_items:request_release against
        // this item early — no need to wait out the announced deadline. `forced` means
        // this release happened via the EXISTING WI-4198 authority basis (holder-not-live
        // / queen / leads-holder-fleet), not the holder responding, so it resolves as
        // "superseded" rather than "holder-released". `workItem.payload` is the row AS
        // RETURNED by the release UPDATE — release never touches `payload`, so any
        // `release_request_*` keys are still current. Best-effort: never fail the
        // release itself over this.
        try {
          const pendingReq = readWorkItemReleaseRequest(workItem.payload);
          if (pendingReq && !pendingReq.resolved) {
            const consequenceFired = forced?.basis === 'announced-release-request-expired';
            const resolution = consequenceFired ? 'consequence-reclaim' : forced ? 'superseded' : 'holder-released';
            const resolved = await resolveWorkItemReleaseRequest(it.id, {
              harness: workItem.harness ?? harness,
              resolution,
              ...(consequenceFired && forced?.releaseRequest
                ? {
                    expectedBy: forced.releaseRequest.by,
                    expectedHolder: forced.releaseRequest.holder,
                    expectedDeadlineAt: forced.releaseRequest.deadlineAt,
                  }
                : {}),
            });
            if (resolved) {
              const { sendMessage: notifyRequester } = await import('../coordination/messages');
              await notifyRequester(ident, {
                to: [resolved.by],
                summary:
                  resolution === 'holder-released'
                    ? `✅ ${it.id}: ${ident.ownerId} released the item you requested (reason: ${resolved.reason.slice(0, 140)}) — no reclaim needed.`
                    : resolution === 'consequence-reclaim'
                      ? `⏰ ${it.id}: release request expired unanswered — RECLAIMED via work_items:release per the announced consequence.`
                      : `✅ ${it.id}: released via a different authorized path before your request's deadline — no reclaim needed.`,
                harnessSlug: workItem.harness ?? undefined,
                extra: { auto: true, lifecycle: 'release_request_resolved', work_item: it.id, resolution },
              }).catch(() => {});
              await commentWorkItem(
                it.id,
                resolution === 'consequence-reclaim'
                  ? `⏰ Release request from ${resolved.by} → ${resolved.holder} EXPIRED unanswered — announced onSilence:"reclaim" fired via work_items:release.`
                  : `✅ Release request from ${resolved.by} resolved early (${resolution}) by ${ident.ownerId}'s release — no consequence needed.`,
                ident.ownerId,
                { harness: workItem.harness ?? harness },
              ).catch(() => {});
            }
          }
        } catch {
          /* best-effort — never fail the release itself over release-request bookkeeping */
        }
        // WI-6678: the DELTA this call actually produced. `released:false` means the item
        // was already unassigned — the call succeeded and changed nothing. Gate on THIS,
        // not on `ok`, whenever you are trying to establish that a claim was cleared.
        const delta = {
          released: wasHeld,
          previousAssignee: wasHeld ? priorAssignee : null,
          ...(wasHeld
            ? {}
            : {
                noop:
                  `'${it.id}' was ALREADY unassigned — nothing was released. ok:true here means "the call succeeded", ` +
                  `not "a claim was cleared". If you are clearing a fleet:leader-brief orphaned_in_flight item, note that ` +
                  `condition REQUIRES assignee IS NULL, so release can never clear it — only a member CLAIMING and finishing ` +
                  `the item does (WI-6678).`,
              }),
        };
        // WI-38297: the STRANDING warning. The bg-job checkpoint classifier
        // (EI-18654296679612119) already fires on every PICKUP path — work_items:get,
        // work_items:claim, scheduler:get_next — i.e. it warns whoever inherits the item.
        // It did NOT fire here, on the way OUT, which is the moment the strand is actually
        // created: a holder writes "verification running in bg job <id>, will report+complete
        // once it finishes", releases, and their session dies taking that job's bookkeeping
        // with it (EI-16611). Nobody is ever told the item was finished, so it sits `open`
        // looking like unstarted work. Measured 2026-08-12: WI-5895 sat open 17 days that way
        // with its fix already committed, and it is not a one-off — 47 of the ~449 open,
        // unheld items holding a checkpoint cite a background job.
        //
        // WARN, never refuse. detectBgJobCheckpointClaim is deliberately BROAD ("a false
        // positive only prompts a verification the reader should do anyway"), so gating a
        // release on it would block legitimate ones on a low-precision signal. The releasing
        // agent is also the ONE reader who can cheaply settle it — they still have the pid and
        // the shell. Fail-soft: a checkpoint-read hiccup must never fail the release itself.
        const checkpointMeta =
          wasHeld || claimHold === true
            ? await getWorkItemCheckpointWithMeta({
                harness: workItem.harness ?? it.harness ?? null,
                workItemId: it.id,
                workspaceId: ident.workspaceId ?? undefined,
              }).catch(() => ({ checkpoint: null, updatedAtMs: null }))
            : { checkpoint: null, updatedAtMs: null };
        const releaseCheckpoint = wasHeld ? checkpointMeta.checkpoint : null;
        // WI-5860 gap (2): claimHold:true can be applied as a SECOND call after a
        // plain release, when the item is already unassigned. That is normally a
        // deliberate durable park, but a checkpoint written inside the same liveness
        // window is contradictory evidence: the claim may have vanished while its
        // session is still finishing the work. The hold remains allowed (this is an
        // advisory safety signal, not a new lifecycle gate), but the placer must see
        // the checkpointed-but-unowned state instead of reading ok:true + claimHold:true
        // as proof that the row was idle. Reuse the claim reaper's canonical 10-minute
        // grace rather than inventing a second notion of "fresh".
        const freshUnclaimedCheckpointAgeMs =
          !wasHeld && claimHold === true && checkpointMeta.checkpoint && checkpointMeta.updatedAtMs != null
            ? Math.max(0, Date.now() - checkpointMeta.updatedAtMs)
            : null;
        const freshUnclaimedCheckpoint =
          freshUnclaimedCheckpointAgeMs != null && freshUnclaimedCheckpointAgeMs <= STALE_CLAIM_GRACE_MS
            ? {
                freshUnclaimedCheckpoint: {
                  status: 'checkpointed-but-unowned' as const,
                  checkpointAgeMs: freshUnclaimedCheckpointAgeMs,
                  freshnessWindowMs: STALE_CLAIM_GRACE_MS,
                },
                freshUnclaimedCheckpointWarning:
                  `You requested claimHold:true for '${it.id}' while it was ALREADY unassigned, but it carries a ` +
                  `checkpoint written ${freshUnclaimedCheckpointAgeMs}ms ago (inside the ${STALE_CLAIM_GRACE_MS}ms ` +
                  `claim-liveness window). This is CHECKPOINTED-BUT-UNOWNED: a live session may still be finishing ` +
                  `work after losing its claim. The hold request still proceeds, but do NOT infer idleness from ` +
                  `assignee/takenAt alone — read work_items:get's checkpoint + priorWork, reconcile the prior ` +
                  `worker, then claim/finish it or deliberately confirm the park.`,
              }
            : {};
        const stranding =
          releaseCheckpoint && detectBgJobCheckpointClaim(releaseCheckpoint).detected
            ? {
                strandedCheckpointWarning:
                  `You are releasing '${it.id}' while its checkpoint cites a BACKGROUND JOB as the evidence it is waiting on. ` +
                  `That job's bookkeeping lives in YOUR process/shell and does not survive your session (EI-16611) — the next ` +
                  `reader gets a checkpoint promising a result that can never arrive, and the item sits open as if unstarted ` +
                  `(WI-5895 sat 17 days that way with its fix already committed). You are the last reader who can settle this ` +
                  `cheaply, while you still have the pid and the log. Before walking away, do ONE of: (a) verify the job now ` +
                  `(check the referenced pid is alive AND the log reached the runner's OWN completion marker — a log that just ` +
                  `stopped growing is ambiguous, not proof) and work_items:complete it; (b) re-checkpoint replacing the bg-job ` +
                  `reference with a re-runnable command a successor can execute from scratch; or (c) work_items:set_state ` +
                  `{ state:'blocked' } with the reason, so it lands somewhere that gets re-read instead of looking claimable.`,
              }
            : {};
        // EI-20744001855099113: a completion assertion from the holder is a second,
        // independent release-time signal for the same strand. Only inspect the
        // holder that actually owned this claim, and only while the returned item is
        // still non-terminal; a correctly completed item may legitimately retain an
        // old "done" message. The read is advisory and fail-soft by design.
        const priorHolder = wasHeld ? priorAssignee?.trim() : undefined;
        const completionAssertion =
          priorHolder && !ANY_FAMILY_TERMINAL_STATES.includes(workItem.state)
            ? await readPriorCompletionAssertion(priorHolder, it.id)
            : null;
        const completion = completionAssertion
          ? {
              completionAssertionWarning:
                `The prior holder '${priorHolder}' asserted '${it.id}' was complete in coord message ` +
                `${completionAssertion.msgId} at ${completionAssertion.ts}, but the item is still non-terminal ` +
                `after release. Before walking away, call work_items:complete (or set a deliberate blocked/needs-human ` +
                `state) so this finished work is not re-dispatched.`,
            }
          : {};
        // EI-14883: a plain release re-pools the row for the next drive-by claimant.
        // When an escalation naming this item is still OPEN, that claimant inherits no
        // new information — they can only re-derive "already escalated, awaiting a
        // decision" from the comment thread, which is the ping-pong observed on WI-3627.
        //
        // Gate on the POST-RELEASE state being CLAIMABLE rather than on a parked-state
        // denylist: `open`/`failing` is what the scheduler actually offers, so a holder
        // who already flipped the row to needs-human/blocked — the correct fix — is not
        // nagged for having done it right. WARN, never refuse: the open escalation may be
        // incidental to this release, and a false positive only prompts a check the
        // releasing agent is uniquely placed to make cheaply.
        const openEscalation =
          !force && claimHold === undefined && wasHeld && CLAIMABLE_AFTER_RELEASE.includes(workItem.state)
            ? await readOpenEscalationForItem(it.id)
            : null;
        const escalationPark = openEscalation
          ? {
              openEscalation,
              openEscalationWarning:
                `'${it.id}' went back into the claimable pool (state '${workItem.state}') while escalation ` +
                `${openEscalation.msgId}, raised by '${openEscalation.from}' at ${openEscalation.ts}, is still OPEN. ` +
                `A plain release means "someone else can just pick this up as-is", which an item awaiting a decision ` +
                `is not: the next claimant gets no new information and can only re-derive "already escalated, ` +
                `awaiting a decision" from the thread (WI-3627 was re-dispatched that way ~2.5h after its ` +
                `escalation, and every later hop repeats it). Make the disposition durable now — either ` +
                `work_items:set_state { id:'${it.id}', state:'needs-human' } when only the owner can progress it, or ` +
                `work_items:release { id:'${it.id}', claimHold:true, reason:'awaiting escalation ${openEscalation.msgId}', ` +
                `claimHoldRelease:{ condition:'escalation ${openEscalation.msgId} is resolved', trigger:'<exact event key>' } }; ` +
                `both work while the item is unassigned. If this escalation is unrelated to why you released, no action ` +
                `is needed.`,
            }
          : {};
        // EI-21352358541526229: a voluntary release's `reason` was COLLECTED but never
        // reached the next claimant. Measured on this row's own substrate: work_items carries
        // only last_released_by/at + worked_by_history (whose entries are {at, owner} — no
        // reason field), and PriorWorkRow reads exactly those columns, so a disposition typed
        // into `reason` landed in the audit row and the notifications and STOPPED there. The
        // claimant got priorWorkWarning with hasCheckpoint:false — "someone worked this and
        // left nothing" — and had to re-derive what happened: 6–10 tool calls of Postgres
        // forensics and repo greps per item, measured across three items in one 2026-08-24
        // drain pass whose deliverables were ALREADY BUILT AND LANDED.
        //
        // Route it into the CHECKPOINT rather than inventing a second store: that is the
        // surface every pickup path (work_items:get, work_items:claim, scheduler:get_next)
        // already reads, and it flips hasCheckpoint true so priorWorkWarning stops escalating
        // about an item that does now carry information. This is why the fix is not the
        // originally-proposed "make `reason` required": a required arg would have collected
        // text that no claimant could ever see.
        //
        // Only when NO checkpoint exists — a real worked checkpoint is richer than a one-line
        // disposition and must never be clobbered by one. Forced reclaims are excluded: their
        // mandatory `reason` is the FORCER's audit justification, not the holder's, so storing
        // it as the holder's resume context would attribute one agent's words to another.
        // Durable parks (claimHold:true) already persist `parkedReason` and are not
        // self-selectable, so they need no second copy. Fail-soft: this bookkeeping must never
        // fail the release itself. The row is already unassigned here, so the checkpoint
        // write's progress-anchor bump is a deliberate no-op (it credits held rows only).
        let releaseDisposition: { releaseDispositionRecorded?: true } = {};
        if (!force && claimHold !== true && wasHeld && reason && !releaseCheckpoint) {
          // try/catch, NOT `.catch()`: a `.catch()` only attaches to the promise the call
          // RETURNS, so it cannot catch a synchronous throw from the call itself. That is not
          // theoretical — it is how this landed: a hand-listed vi.mock factory that omits this
          // member yields `undefined`, and `undefined(...)` throws before any promise exists,
          // taking the whole release down. Production always exports it, but "fail-soft" has
          // to mean fail-soft, and a release must never fail on its own bookkeeping.
          try {
            const stored = await setWorkItemCheckpoint(
              {
                harness: workItem.harness ?? it.harness ?? null,
                workItemId: it.id,
                workspaceId: ident.workspaceId ?? undefined,
              },
              `## Release disposition — recorded by work_items:release (NOT a worked checkpoint)\n\n` +
                `${reason}\n\n` +
                `— released by ${ident.ownerId ?? 'an unrecorded owner'} at ${new Date().toISOString()} without a ` +
                `checkpoint. This is the releaser's one-line disposition, not a verified resume brief: treat it as a ` +
                `POINTER to what they were doing and verify it against the repo/ledger before building on it.`,
            );
            if (stored) releaseDisposition = { releaseDispositionRecorded: true as const };
          } catch {
            /* best-effort — never fail the release on this */
          }
        }
        // EI-16289: a checkpoint/reason records WHY a holder put work down, but a plain
        // release does not make that disposition sticky — it applies only the short
        // same-agent cooldown and leaves the row immediately self-selectable by every
        // OTHER agent. That distinction was repeatedly missed in real drain loops: four+
        // sessions re-claimed WI-5335 and re-derived the same "not now" conclusion even
        // though the checkpoint already said to route it outside the fast drain.
        //
        // Do NOT infer that every checkpoint means deferral: work_items:park deliberately
        // writes a checkpoint for a NORMAL resumable handoff. Surface the semantic delta at
        // the decision point instead. A second release on the now-unassigned row can still
        // apply claimHold:true, so this is actionable after the plain release rather than a
        // dead-end warning. Explicit claimHold:false is the caller's deliberate "re-pool"
        // signal and therefore suppresses the nudge. Forced reclaims carry mandatory audit
        // reasons with unrelated semantics, so they are excluded too.
        const claimHoldNudge =
          !force && claimHold === undefined && wasHeld && (releaseCheckpoint || reason)
            ? {
                claimHoldNudge:
                  `Plain release left '${it.id}' self-selectable by other agents immediately (only your own short ` +
                  `re-claim cooldown was applied). ${releaseCheckpoint ? 'Its checkpoint remains resume context, not a queue disposition.' : 'Its release reason was recorded, but does not change selectability.'} ` +
                  `If this means "defer / not now / do not self-select", apply the durable disposition now with ` +
                  `work_items:release { id:'${it.id}', claimHold:true, reason:'<unpark condition>', ` +
                  `claimHoldRelease:{ condition:'<what changes>', trigger:'<exact event key>' } }; that follow-up ` +
                  `works while the item is unassigned. If this is an ordinary handoff, no action is needed.`,
              }
            : {};
        // EI-21352358541526229: the fully-blind release — no checkpoint AND no reason — was
        // the one shape that returned NOTHING. claimHoldNudge above requires
        // (releaseCheckpoint || reason) and strandedCheckpointWarning requires a checkpoint,
        // so the releaser who left the LEAST behind got the LEAST feedback, exactly inverting
        // the signal. Measured 2026-09-05 on papercusp: 192 of 1,088 released-and-claimable
        // non-observation items (17.6%) reach their next claimant in this state.
        //
        // Advisory, never a refusal, and deliberately NOT a required `reason` arg: release is
        // also driven by paths with no disposition to give (stale-claim reaping, handoffs,
        // a release of work genuinely never started), and refusing those would block the queue
        // to buy a field that is often honestly empty. Nudge the human-ish path instead, and
        // make the remedy a call that still works after the fact.
        const blindReleaseNudge =
          !force && claimHold === undefined && wasHeld && !releaseCheckpoint && !reason
            ? {
                blindReleaseNudge:
                  `You released '${it.id}' with neither a checkpoint nor a reason, so it returns to the queue looking ` +
                  `UNSTARTED. The next claimant is told only that somebody held it and left nothing behind ` +
                  `(priorWork hasCheckpoint:false) and has to re-derive whatever you already know — measured at 6–10 ` +
                  `tool calls of Postgres forensics and repo greps per item. If you built, landed, or SETTLED ` +
                  `anything — a migration, a commit, a conclusion, even "this turned out to be already done" — record ` +
                  `it now with work_items:release { id:'${it.id}', reason:'<one line: what exists, what is left>' }; ` +
                  `that follow-up works while the item is unassigned and is stored as the next claimant's starting ` +
                  `context. If you genuinely did nothing to this item, no action is needed.`,
              }
            : {};
        if (claimHold === undefined) {
          return {
            ok: true as const,
            id: it.id,
            workItem,
            forced,
            ...delta,
            ...stranding,
            ...completion,
            ...escalationPark,
            ...claimHoldNudge,
            ...blindReleaseNudge,
            ...releaseDisposition,
            ...reasonDisclosure,
          };
        }
        // WI-321 boomerang fix: a release-park is a DURABLE park (claim_hold_* provenance),
        // NOT a held_open_* lease — a lease dies ~2h after the parker's session ends
        // (WI-4531 reaper), so every park placed by an ephemeral agent boomeranged back
        // into scheduler:get_next. Parks never gate terminal transitions, so durability
        // costs nothing WI-4531 was defending against.
        const held = await setWorkItemClaimHold(it.id, claimHold, {
          harness,
          parkedBy: ident.ownerId,
          parkedReason: reason,
          ...(releaseContract ? { releaseContract } : {}),
        });
        // EI-21966077123218777: `setWorkItemClaimHold` returns null from TWO different
        // places — it located no row (the `feature_id` + `harness` filter matched nothing)
        // or its UPDATE matched nothing — and in BOTH the durable park/unpark was NEVER
        // persisted. Omitting `claimHold` on null is right as far as it goes (never report a
        // hold that was not written), but it left the caller choosing between a false
        // positive and SILENCE, and silence here is indistinguishable from success: the
        // reply still says ok:true, so the natural reading of a missing field is "applied".
        //
        // That is not hypothetical. EI-15345/WI-5261 is the same silent no-op already on the
        // record — a `claimHold:true` release "reported success but `_claimHold` was NEVER
        // persisted, so scheduler:get_next kept re-serving the item" (work-items.ts:6373).
        // The CAUSE was fixed there; this failure SHAPE was not. And the direction it fails
        // in is the expensive one: an unwritten park reads as parked, so the item stays
        // self-selectable and a peer picks up work someone deliberately set down — while an
        // unwritten UNpark reads as cleared, leaving the row invisible to
        // claim_next/scheduler:get_next with nothing in the reply saying so.
        //
        // So report the FAILURE explicitly rather than choosing between a lie and silence.
        // `claimHold` stays absent (that guarantee, and its test, are unchanged) — this is
        // purely additive.
        const claimHoldFailure =
          held === null
            ? {
                claimHoldFailed:
                  `'${it.id}' was released, but the claimHold:${claimHold} write did NOT persist — no work_items ` +
                  `row matched feature_id='${it.id}'${harness ? ` AND harness_slug='${harness}'` : ''}, so the durable ` +
                  `park is UNCHANGED. The ok:true above describes the RELEASE only, never this hold. Re-read the item ` +
                  `(work_items:get) and retry with the harness the row actually carries; do NOT treat this call as ` +
                  `having parked or unparked it.`,
              }
            : {};
        // EI-23083530583845382: `workItem` was captured by releaseWorkItem BEFORE the
        // separate claim-hold write above. Returning it unchanged made a successful
        // claimHold:false response contradict itself: `claimHold:false` sat beside a
        // workItem.payload that still contained `_claimHold` and `claim_hold_release`.
        // Refresh only after a successful hold write so the response describes the
        // post-write row. A null means the write missed and claimHoldFailure above is
        // authoritative; keep the released snapshot in that failure case.
        const postClaimHoldWorkItem =
          held === null ? workItem : ((await getWorkItem(it.id, workItem.harness ?? harness)) ?? workItem);
        return {
          ok: true as const,
          id: it.id,
          workItem: postClaimHoldWorkItem,
          forced,
          ...delta,
          ...stranding,
          ...completion,
          claimHold: held?.applicable ? held.hold : undefined,
          claimHoldRelease: held?.applicable && claimHold ? releaseContract : undefined,
          ...claimHoldFailure,
          ...freshUnclaimedCheckpoint,
          ...releaseDisposition,
          ...reasonDisclosure,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
