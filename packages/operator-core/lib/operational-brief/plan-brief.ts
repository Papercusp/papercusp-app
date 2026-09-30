/**
 * Plan operational brief (plan use-existing-router-for-review-requests-2026-09-08
 * P-007, spec OP-BRIEF-P007-PLAN): current phase, next executable item,
 * blockers, authority, acceptance state and last verified evidence, projected
 * from ONE plans:get result record. Nothing here reads a store or re-defines a
 * verdict — every value comes from a field plans:get already computed, and the
 * next item comes from the canonical `deriveNextPointer` ranking.
 *
 * Consistency with the read it annotates is the falsifier: the brief must never
 * name a next item or phase that differs from the plan state beside it. The
 * pure derivation does not see plans:get's open-issue block overlay, so items
 * that overlay marked `blocked` are fed to the ranking as `blocked` — otherwise
 * the brief could point at an item the same payload reports as blocked.
 */
import { deriveNextPointer, type DerivedNextPointer, type PlanItem } from '@papercusp/plan-parser';
import {
  finalizeOperationalBrief,
  known,
  unknown,
  type BriefField,
  type BriefVerifiedEvidence,
  type OperationalBrief,
} from './brief';

export interface PlanBriefNextItem {
  id: string;
  effectiveStatus: string | null;
  reason: string;
  blockedOn: string[];
  workItemId: string | null;
}

export interface PlanBriefAcceptance {
  source: 'shipReadiness' | 'acceptanceRubric';
  satisfied: boolean | null;
  code: string | null;
  summary: string;
}

export interface PlanBriefAuthority {
  decisionCount: number;
  latestDecisions: Array<{ id: string; title: string; date: string | null }>;
  ownerAuthorityItems: string[];
}

export interface PlanBriefFacts extends Record<string, unknown> {
  phase: BriefField<string>;
  nextItem: BriefField<PlanBriefNextItem | null>;
  counts: BriefField<{ total: number; done: number; dropped: number; nonTerminal: number }>;
  authority: BriefField<PlanBriefAuthority>;
  acceptance: BriefField<PlanBriefAcceptance>;
}

export type PlanOperationalBrief = OperationalBrief<PlanBriefFacts>;

export interface ProjectPlanBriefOptions {
  /** False when the caller narrowed plans:get with an `items` selection: a
   * narrowed item list cannot establish plan-wide blockers or counts. */
  itemsComplete: boolean;
}

type Rec = Record<string, unknown>;

const TERMINAL = new Set(['done', 'dropped']);
const LATEST_DECISIONS = 3;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface ResultItem {
  id: string;
  storedStatus: string;
  effectiveStatus: string;
  blockedBy: string[];
  phase: string | null;
  authority: string | null;
  raw: Rec;
}

function readItems(result: Rec): ResultItem[] | null {
  if (!Array.isArray(result.items)) return null;
  const out: ResultItem[] = [];
  for (const entry of result.items) {
    const item = rec(entry);
    const id = item ? str(item.id) : null;
    if (!item || !id) continue;
    const storedStatus = str(item.storedStatus) ?? str(item.effectiveStatus) ?? 'todo';
    out.push({
      id,
      storedStatus,
      effectiveStatus: str(item.effectiveStatus) ?? storedStatus,
      blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.filter((b): b is string => typeof b === 'string') : [],
      phase: str(item.phase),
      authority: str(item.authority),
      raw: item,
    });
  }
  return out;
}

function deriveFromItems(items: ResultItem[]): DerivedNextPointer {
  const planItems = items.map(
    (item) =>
      ({
        ...item.raw,
        id: item.id,
        // Carry plans:get's issue-block overlay into the pure ranking.
        storedStatus: item.effectiveStatus === 'blocked' ? 'blocked' : item.storedStatus,
        blockedBy: item.blockedBy,
        decisionRefs: Array.isArray(item.raw.decisionRefs) ? item.raw.decisionRefs : [],
        text: typeof item.raw.text === 'string' ? item.raw.text : '',
        phase: item.phase,
        lineNumber: typeof item.raw.lineNumber === 'number' ? item.raw.lineNumber : 0,
        rawLine: typeof item.raw.rawLine === 'string' ? item.raw.rawLine : '',
        importance: item.raw.importance ?? 'normal',
      }) as PlanItem,
  );
  return deriveNextPointer(planItems);
}

function readNowDerivation(result: Rec): DerivedNextPointer | null {
  const derivation = rec(rec(result.now)?.nextDerivation);
  if (!derivation || !('itemId' in derivation)) return null;
  const counts = rec(derivation.counts);
  return {
    itemId: str(derivation.itemId),
    effectiveStatus: (str(derivation.effectiveStatus) as DerivedNextPointer['effectiveStatus']) ?? null,
    reason: (str(derivation.reason) ?? 'blocked') as DerivedNextPointer['reason'],
    text: '',
    candidates: [],
    candidatesTruncated: false,
    blockedOn: Array.isArray(derivation.blockedOn)
      ? derivation.blockedOn.filter((b): b is string => typeof b === 'string')
      : [],
    counts: {
      total: Number(counts?.total ?? 0),
      done: Number(counts?.done ?? 0),
      dropped: Number(counts?.dropped ?? 0),
      nonTerminal: Number(counts?.nonTerminal ?? 0),
    },
  };
}

function workItemFor(result: Rec, itemId: string): string | null {
  const linked = rec(rec(result.linkedFeatures)?.[itemId]);
  return linked ? str(linked.featureId) : null;
}

function readAcceptance(result: Rec): BriefField<PlanBriefAcceptance> {
  const ship = rec(result.shipReadiness);
  if (ship) {
    const unavailable = str(ship.unavailableReason);
    if (unavailable) {
      return unknown(`ship readiness could not be evaluated (${unavailable})`);
    }
    return known(
      {
        source: 'shipReadiness',
        satisfied: typeof ship.satisfied === 'boolean' ? ship.satisfied : null,
        code: str(ship.code),
        summary: str(ship.message) ?? (ship.satisfied === true ? 'ship gate satisfied' : 'ship gate refused'),
      },
      'plans:get.shipReadiness',
    );
  }
  const rubric = rec(result.acceptanceRubric);
  if (rubric) {
    return known(
      {
        source: 'acceptanceRubric',
        satisfied: null,
        code: null,
        summary:
          `acceptance rubric ${str(rubric.rubricId) ?? '(unnamed)'} is ${str(rubric.status) ?? 'unknown'} ` +
          `with ${Number(rubric.criteriaCount ?? 0)} criteria; ship verdict not measured (pass shipReadiness:true)`,
      },
      'plans:get.acceptanceRubric',
    );
  }
  return unknown('no acceptance rubric on this plan and ship readiness was not requested (pass shipReadiness:true)');
}

function readLastVerified(result: Rec): BriefField<BriefVerifiedEvidence> {
  const audit = rec(result.latestAudit);
  if (!audit) return unknown('no plan audit is recorded for this plan');
  const seq = Number(audit.auditSeq);
  const kind = str(audit.auditKind) ?? 'unknown-kind';
  if (kind === 'activation') {
    return unknown(
      `latest audit #${seq} is an activation audit (plan-to-conversation fidelity), not implementation evidence`,
    );
  }
  const itemCount = Array.isArray(audit.items) ? audit.items.length : 0;
  return known(
    {
      ref: `plans:audit#${seq}`,
      at: str(audit.createdAt),
      summary: `${kind} audit covering ${itemCount} item(s) by ${str(audit.createdBy) ?? 'unknown author'}`,
    },
    'plans:get.latestAudit',
  );
}

function readAuthority(result: Rec, items: ResultItem[] | null): BriefField<PlanBriefAuthority> {
  if (!Array.isArray(result.decisions)) {
    return unknown('decisions are not in this read (mode:meta); re-read with mode:sections');
  }
  const decisions = result.decisions
    .map(rec)
    .filter((d): d is Rec => d !== null && str(d.id) !== null)
    .map((d) => ({ id: str(d.id)!, title: str(d.title) ?? '', date: str(d.date) }));
  return known(
    {
      decisionCount: decisions.length,
      latestDecisions: decisions.slice(-LATEST_DECISIONS),
      ownerAuthorityItems: (items ?? [])
        .filter((item) => item.authority === 'owner' && !TERMINAL.has(item.effectiveStatus))
        .map((item) => item.id),
    },
    'plans:get.decisions+items.authority',
  );
}

function nextActionFor(
  next: DerivedNextPointer,
  workItemId: string | null,
  acceptance: BriefField<PlanBriefAcceptance>,
): string {
  const suffix = workItemId ? ` (work-item ${workItemId})` : '';
  switch (next.reason) {
    case 'in-flight':
      return `Continue ${next.itemId}, already in progress${suffix}`;
    case 'actionable':
      return `Start ${next.itemId}${suffix}`;
    case 'needs-human':
      return `Owner action needed on ${next.itemId}${suffix}`;
    case 'blocked':
      return `Unblock ${next.itemId}: waiting on ${next.blockedOn.length > 0 ? next.blockedOn.join(', ') : 'an explicit block'}${suffix}`;
    case 'drained':
      return acceptance.status === 'known' && acceptance.value.satisfied === true
        ? 'All items are terminal and the ship gate is satisfied: plans:set-plan-status shipped'
        : 'All items are terminal: finish the acceptance path (code-truth audit, rubric, independent grade), then ship';
    case 'no-items':
      return 'The plan has no items: add them with plans:add-item';
    default:
      return `Review ${next.itemId ?? 'the plan'} (${String(next.reason)})`;
  }
}

/** Project a plan operational brief from one ok plans:get result record. */
export function projectPlanOperationalBrief(result: Rec, options: ProjectPlanBriefOptions): PlanOperationalBrief {
  const slug = str(result.slug) ?? '(unknown plan)';
  const items = readItems(result);
  const graphComplete = items !== null && options.itemsComplete;

  let next: DerivedNextPointer | null = null;
  let nextSource = '';
  if (graphComplete) {
    next = deriveFromItems(items);
    nextSource = 'plan-parser.deriveNextPointer over plans:get items (issue-block overlay applied)';
  } else {
    next = readNowDerivation(result);
    nextSource = 'plans:get.now.nextDerivation (pure item graph; open-issue blocks not applied)';
  }

  const acceptance = readAcceptance(result);
  const workItemId = next?.itemId ? workItemFor(result, next.itemId) : null;

  const nextItem: BriefField<PlanBriefNextItem | null> = next
    ? known(
        next.itemId
          ? {
              id: next.itemId,
              effectiveStatus: next.effectiveStatus,
              reason: next.reason,
              blockedOn: next.blockedOn,
              workItemId,
            }
          : null,
        nextSource,
      )
    : unknown('the item graph is not in this read and plans:get derived no next pointer (no ## Now block)');

  let phase: BriefField<string>;
  if (!next) {
    phase = unknown('no next item could be derived, so no current phase');
  } else if (!next.itemId) {
    phase = next.reason === 'drained'
      ? known('complete: every item is terminal', nextSource)
      : unknown(`no current phase (${next.reason})`);
  } else {
    const itemPhase = items?.find((item) => item.id === next.itemId)?.phase ?? null;
    phase = itemPhase
      ? known(itemPhase, 'plans:get.items[].phase of the next item')
      : unknown(items ? `next item ${next.itemId} sits under no phase heading` : 'item phases are not in this read');
  }

  const blockers: BriefField<string[]> = graphComplete
    ? known(
        items
          .filter((item) => item.effectiveStatus === 'blocked' || item.effectiveStatus === 'needs-human')
          .map((item) => {
            if (item.effectiveStatus === 'needs-human') return `${item.id} needs a human`;
            const open = item.blockedBy.filter((ref) => {
              const target = items.find((candidate) => candidate.id === ref);
              return !target || !TERMINAL.has(target.effectiveStatus);
            });
            return open.length > 0 ? `${item.id} blocked by ${open.join(', ')}` : `${item.id} explicitly blocked`;
          }),
        'plans:get.items[].effectiveStatus',
      )
    : unknown(items ? 'the items selection was narrowed, so plan-wide blockers are unmeasured' : 'items are not in this read (mode:meta)');

  const status = str(result.status) ?? 'unknown';
  const lifecycle = rec(result.lifecycle);
  const verdict = lifecycle ? str(lifecycle.verdict) : null;
  const frontmatterOwner = str(rec(result.frontmatter)?.owner);

  return finalizeOperationalBrief<PlanBriefFacts>({
    surface: 'plan',
    subject: slug,
    state: known(verdict ? `${status} (derived: ${verdict})` : status, verdict ? 'plans:get.status+lifecycle.verdict' : 'plans:get.status'),
    owner: frontmatterOwner
      ? known(frontmatterOwner, 'plans:get.frontmatter.owner')
      : unknown(
          `plans:get does not project claim holders${workItemId ? `; read work_items:get { id: '${workItemId}' }` : ''}`,
        ),
    nextAction: next ? known(nextActionFor(next, workItemId, acceptance), nextSource) : unknown('no next pointer could be derived'),
    blockers,
    lastVerified: readLastVerified(result),
    deadline: known(null, 'plan state carries no deadline field'),
    facts: {
      phase,
      nextItem,
      counts: next ? known(next.counts, nextSource) : unknown('no item census in this read'),
      authority: readAuthority(result, items),
      acceptance,
    },
  });
}
