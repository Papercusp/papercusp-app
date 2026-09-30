/**
 * Work-item operational brief (plan use-existing-router-for-review-requests-2026-09-08
 * P-008, spec OP-BRIEF-P008-WORKITEM): claim/state, blocked-on dependencies, last
 * verified evidence, next action and successor residue, projected from ONE
 * work_items:get result row. Nothing here reads a store: every value comes from a
 * field the work_items:get handler already read for that row, and anything the read
 * did not measure is an explicit `unknown` with a reason — never a silent zero.
 *
 * The falsifier this module exists to satisfy: the brief must never HIDE an active
 * claim, a blocked dependency, a missing checkpoint, or successor residue that the
 * same read exposes. So the claim, the checkpoint status and every blocker source are
 * always projected (as known values or as named gaps), and free-form checkpoint prose
 * is never promoted into a next action — only the carry-note `## Next action`
 * section is, because anything else is a guess about what the holder meant.
 */
import { parseCarryNote, type CarryNoteFields } from '../carry-note';
import { activeExternalBlockers } from '../external-blockers';
import {
  finalizeOperationalBrief,
  known,
  unknown,
  type BriefField,
  type BriefVerifiedEvidence,
  type OperationalBrief,
} from './brief';

type Rec = Record<string, unknown>;

/** Terminal work-item states across the feature and issue families. */
const TERMINAL = new Set(['done', 'dropped', 'closed', 'resolved']);

export interface WorkItemBriefClaim {
  assignee: string | null;
  takenAt: string | null;
  lastProgressAt: string | null;
  /** The holder's declared goal as coord presence reports it, when the read carried one. */
  holderGoal: string | null;
  /** True when coord presence flags the holder's declared intent as not progressing. */
  holderStale: boolean | null;
}

export interface WorkItemBriefCheckpoint {
  status: 'available' | 'absent';
  updatedAt: string | null;
  contentHash: string | null;
  /** Whether the checkpoint uses the structured carry-note sections. */
  structured: boolean;
}

export interface WorkItemBriefResidue {
  left: string | null;
  walls: string[];
}

export interface WorkItemBriefFacts extends Record<string, unknown> {
  kind: string | null;
  plan: { slug: string; itemIds: string[] } | null;
  claim: BriefField<WorkItemBriefClaim>;
  checkpoint: BriefField<WorkItemBriefCheckpoint>;
  successorResidue: BriefField<WorkItemBriefResidue>;
  /** Items THIS item holds up (outgoing `blocks`: src blocks dst); only measured
   * when the read loaded the item's outgoing links (`detail:true`). */
  holdsUp: BriefField<string[]>;
  /** Incoming `blocks` edges (other items that must finish first). work_items:get
   * never reads incoming edges, so this is always an explicit gap with a pointer —
   * never a silent "no dependencies". */
  blockedByLinks: BriefField<string[]>;
}

export type WorkItemOperationalBrief = OperationalBrief<WorkItemBriefFacts>;

export interface ProjectWorkItemBriefOptions {
  /** True when the row was read with `detail:true`, so `workItem.links` is present. */
  linksRead: boolean;
}

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isoFromMs(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function isStructured(fields: CarryNoteFields): boolean {
  return Boolean(
    fields.did || fields.left || fields.insight || fields.next || fields.walls?.length || fields.checks?.length,
  );
}

function readPlan(workItem: Rec): { slug: string; itemIds: string[] } | null {
  const slug = str(workItem.sourcePlanSlug);
  if (!slug) return null;
  const ids = Array.isArray(workItem.sourcePlanItemIds)
    ? workItem.sourcePlanItemIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { slug, itemIds: ids };
}

/** Blocker sources the row carries: the plan-item lane guard and set_blocker records.
 * The payload is required to see set_blocker records, so a row without it is a gap. */
function readBlockers(row: Rec, workItem: Rec, state: string | null): BriefField<string[]> {
  const out: string[] = [];
  const sources: string[] = [];
  const lane = rec(row.planItemBlocked);
  if (lane) {
    const reason = str(lane.reason);
    out.push(
      `plan item ${str(lane.planSlug) ?? '?'}#${str(lane.itemId) ?? '?'} is ${str(lane.effectiveStatus) ?? 'blocked'}` +
        (reason ? ` (${reason})` : ''),
    );
    sources.push('work_items:get.planItemBlocked');
  }
  if (!('payload' in workItem)) {
    return unknown('the work-item payload is not in this read, so set_blocker records are unmeasured');
  }
  for (const blocker of activeExternalBlockers(workItem.payload)) {
    out.push(`${blocker.kind} blocker ${blocker.ref}: ${blocker.summary}${blocker.nextVerb ? ` (next: ${blocker.nextVerb})` : ''}`);
  }
  sources.push('workItem.payload external blockers (active)');
  if (out.length === 0 && state === 'blocked') {
    out.push('state is blocked but no blocker reason is recorded');
  }
  return known(out, sources.join(' + '));
}

/** Outgoing `blocks` links are `{ rel, dst: { kind, ref } }` with src = this item. */
function readHoldsUp(workItem: Rec, options: ProjectWorkItemBriefOptions): BriefField<string[]> {
  if (!options.linksRead || !Array.isArray(workItem.links)) {
    return unknown('outgoing work-item links are read only with detail:true');
  }
  const held = workItem.links
    .map(rec)
    .filter((link): link is Rec => link !== null && str(link.rel) === 'blocks')
    .map((link) => {
      const dst = rec(link.dst);
      return dst ? `${str(dst.kind) ?? 'object'}:${str(dst.ref) ?? '?'}` : '(unreadable link target)';
    });
  return known(held, 'workItem.links (outgoing rel=blocks)');
}

function readLastVerified(row: Rec, id: string): BriefField<BriefVerifiedEvidence> {
  const completion = rec(row.completion);
  if (row.hasCompletionEvidence === true && completion) {
    const summary = str(completion.verifiedHow) ?? str(completion.summary) ?? str(completion.testResult);
    if (summary) {
      const workItem = rec(row.workItem) ?? {};
      return known(
        { ref: `${id}#completion`, at: str(workItem.closedAt) ?? str(workItem.updatedAt), summary },
        'work_items:get.completion',
      );
    }
  }
  return unknown('no completion evidence is recorded; checkpoint prose is a claim, not verification');
}

/** Project one work_items:get result row. The row must be the handler's unshaped
 * result (payload present) for set_blocker records to be measured. */
export function projectWorkItemOperationalBrief(row: Rec, options: ProjectWorkItemBriefOptions): WorkItemOperationalBrief {
  const workItem = rec(row.workItem) ?? {};
  const id = str(row.id) ?? str(workItem.id) ?? '(unknown work-item)';
  const state = str(workItem.state);
  const terminal = state !== null && TERMINAL.has(state);
  const assignee = str(workItem.assignee);
  const holder = rec(row.holder);

  const claim: BriefField<WorkItemBriefClaim> = known(
    {
      assignee,
      takenAt: str(workItem.takenAt),
      lastProgressAt: str(workItem.lastProgressAt),
      holderGoal: holder ? str(holder.goalText) ?? str(holder.goalRef) : null,
      holderStale: holder && typeof holder.stale === 'boolean' ? holder.stale : null,
    },
    'work_items:get.workItem + holder',
  );

  const checkpointText = typeof row.checkpoint === 'string' ? row.checkpoint : null;
  const fields: CarryNoteFields = checkpointText ? parseCarryNote(checkpointText) : {};
  const structured = checkpointText !== null && isStructured(fields);

  let checkpoint: BriefField<WorkItemBriefCheckpoint>;
  if (row.checkpointReadFailed === true) {
    checkpoint = unknown('the checkpoint read failed, so it is not known whether one exists');
  } else if (!('checkpoint' in row)) {
    checkpoint = unknown('the checkpoint is not in this read');
  } else {
    checkpoint = known(
      {
        status: checkpointText ? 'available' : 'absent',
        updatedAt: isoFromMs(row.checkpointUpdatedAtMs),
        contentHash: str(row.checkpointContentHash),
        structured,
      },
      'work_items:get.checkpoint',
    );
  }
  const checkpointAbsent = checkpoint.status === 'known' && checkpoint.value.status === 'absent';

  let successorResidue: BriefField<WorkItemBriefResidue>;
  if (checkpoint.status === 'unknown') {
    successorResidue = unknown(checkpoint.reason);
  } else if (checkpointAbsent) {
    successorResidue = unknown('no checkpoint is recorded, so no successor residue was handed over');
  } else if (!structured) {
    successorResidue = unknown('the checkpoint is free-form prose (no carry-note sections); read it directly');
  } else {
    successorResidue = known(
      { left: fields.left?.trim() || null, walls: (fields.walls ?? []).map((wall) => wall.claim) },
      'checkpoint carry-note ## Left + ## Walls',
    );
  }

  let nextAction: BriefField<string>;
  if (state === null) {
    nextAction = unknown('the work-item state is not in this read');
  } else if (terminal) {
    nextAction = known(`none — the item is terminal (${state})`, 'work_items:get.workItem.state');
  } else if (checkpoint.status === 'unknown') {
    nextAction = unknown(checkpoint.reason);
  } else if (fields.next?.trim()) {
    nextAction = known(fields.next.trim(), 'checkpoint carry-note ## Next action');
  } else if (checkpointAbsent && assignee === null) {
    nextAction = known(`claim it: work_items:claim { id: '${id}' }`, 'derived: open, unclaimed, no checkpoint');
  } else if (checkpointAbsent) {
    nextAction = unknown(`claimed by ${assignee} but no checkpoint records a next action`);
  } else {
    nextAction = unknown('the checkpoint has no "## Next action" section; read it directly');
  }

  return finalizeOperationalBrief<WorkItemBriefFacts>({
    surface: 'work-item',
    subject: id,
    state: state !== null ? known(state, 'work_items:get.workItem.state') : unknown('the work-item state is not in this read'),
    owner: known(assignee, 'work_items:get.workItem.assignee'),
    nextAction,
    blockers: readBlockers(row, workItem, state),
    lastVerified: readLastVerified(row, id),
    deadline: terminal
      ? known(null, 'terminal items carry no deadline')
      : unknown('work_items:get exposes no claim-lease or wake deadline for this item'),
    facts: {
      kind: str(workItem.kind),
      plan: readPlan(workItem),
      claim,
      checkpoint,
      successorResidue,
      holdsUp: readHoldsUp(workItem, options),
      blockedByLinks: unknown(
        'work_items:get does not read incoming blocks edges; the scheduler resolves them at claim time (work_items:claimable)',
      ),
    },
  });
}

/** Text form: the shared core lines plus the work-item facts a waiting reader needs,
 * so the claim, checkpoint and residue are visible in turn text too. */
export function renderWorkItemFactLines(brief: WorkItemOperationalBrief): string[] {
  const { claim, checkpoint, successorResidue, holdsUp } = brief.facts;
  const lines: string[] = [];
  lines.push(
    claim.status === 'known'
      ? `claim: ${claim.value.assignee ?? 'unclaimed'}${claim.value.takenAt ? ` since ${claim.value.takenAt}` : ''}` +
          (claim.value.holderStale === true ? ' (holder intent stale)' : '')
      : `claim: unknown (${claim.reason})`,
  );
  lines.push(
    checkpoint.status === 'known'
      ? `checkpoint: ${checkpoint.value.status}${checkpoint.value.updatedAt ? ` @ ${checkpoint.value.updatedAt}` : ''}` +
          (checkpoint.value.status === 'available' && !checkpoint.value.structured ? ' (free-form)' : '')
      : `checkpoint: unknown (${checkpoint.reason})`,
  );
  if (successorResidue.status === 'known') {
    const { left, walls } = successorResidue.value;
    lines.push(`residue: ${left ?? 'none left'}${walls.length > 0 ? `; walls: ${walls.join('; ')}` : ''}`);
  }
  if (holdsUp.status === 'known' && holdsUp.value.length > 0) lines.push(`holds up: ${holdsUp.value.join(', ')}`);
  return lines;
}
