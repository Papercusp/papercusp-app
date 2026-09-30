/**
 * effort-thread — capture at the LEVEL THE AGENT IS WORKING AT
 * (effort-scoped-continuity-2026-09-02 P-017, D-007/D-009/D-010).
 *
 * D-007: "WRITE attaches to the most specific object the agent is actually working
 * at — goal, plan, or work-item. THE LEVEL OF THE NOTE MATCHES THE LEVEL OF THE
 * INSIGHT. A leader reconciling lanes writes at the plan; an implementer writes at
 * the item."
 *
 * D-009 deleted the PROMOTION step this used to need. Promotion existed only because
 * an earlier design let an agent write at exactly ONE level, so a lesson whose true
 * scope was broader needed a mechanism to move. Once writes attach at the right level
 * in the first place, the lesson is simply written where it belongs and a plan read
 * includes it because a plan's history contains its own posts. NOTHING MOVES. Do not
 * reintroduce a lift/copy/promote verb here: it was also self-contradictory against
 * D-004 ("any mechanism ending in 'and the agent should remember to call X' fails").
 *
 * WHY A THREAD AND NOT A CARRY-NOTE (D-002 corrected, D-005): `carry_notes` is
 * PRIMARY KEY (workspace_id, scope) — one row per scope, replace-on-write — which is
 * a lost-update machine for N agents working one effort, and it is deliberately never
 * federated. `coord_thread_posts` is append-only, carries per-post `author_id`, and
 * federates. The thread is the WRITE surface; the derived claim-time briefing
 * (prior-attempt-context) is the READ surface. They are halves of one mechanism.
 *
 * ZERO SCHEMA: `coord_threads_parent_uq` is UNIQUE (workspace_id, parent_kind,
 * parent_ref), so a thread is already 1:1 with ANY parent object.
 */
import { PgThreadStore, type ThreadPostRow, type ObjectRef } from '@papercusp/coordination/capabilities';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from './workspace-registry';
import { commentWorkItem } from './work-items';
import {
  goalThreadRef,
  planThreadRef,
  type ContainmentKind,
  type ContainmentRef,
} from './containment-tree';
// NOT from prior-attempt-context: that module imports readEffortThread from HERE, so
// routing the extractor through it would close an import cycle. prior-attempt-rungs
// exists precisely to be the shared, dependency-free bottom of that pair.
import { extractPriorAttemptRungs } from './prior-attempt-rungs';

/** Deterministic thread id for a level's own thread. `getOrCreateThread` is keyed on
 *  the PARENT, so this only has to be stable and collision-free. */
function effortThreadId(kind: ContainmentKind, parentRef: string): string {
  return `${kind}:${parentRef}`;
}

function storeFor(workspaceId?: string): PgThreadStore {
  const pinned = workspaceId?.trim() && workspaceId.trim() !== '*' ? workspaceId.trim() : undefined;
  return new PgThreadStore({
    getSql: () => getOrgPg().sql,
    ensureSchema: async () => {},
    getWorkspaceId: () => pinned ?? activeWorkspaceId(),
  });
}

/** The coord ObjectRef for a plan's or goal's own thread. Throws for `work_item`,
 *  whose parent kind is family-dependent and belongs to `workItemObjectRef`. */
export function effortObjectRef(target: ContainmentRef): ObjectRef {
  if (target.kind === 'plan') return { kind: 'plan', ref: planThreadRef(target.harness, target.ref) };
  if (target.kind === 'goal') return { kind: 'goal', ref: goalThreadRef(target.ref) };
  throw new Error(
    `effortObjectRef: work_item refs are family-dependent (issue vs feature) — use workItemObjectRef ` +
      `from work-items.ts, or postEffortNote/readEffortThread which dispatch for you.`,
  );
}

export interface EffortNoteInput {
  /** The level the note attaches to — the most specific object the writer holds. */
  target: ContainmentRef;
  text: string;
  authorId?: string | null;
  workspaceId?: string;
}

export interface EffortNoteResult {
  posted: boolean;
  level: ContainmentKind;
  ref: string;
  post?: ThreadPostRow | null;
  /** Why nothing was written, when `posted` is false. */
  skipped?: 'blank' | 'unknown-target' | 'write-failed';
  /** D-010's write-time advisory — see {@link describeCaptureGaps}. */
  advisory?: CaptureAdvisory | null;
}

/**
 * Post a durable note to the level's own thread.
 *
 * Fails SOFT and says so. This rides ALONG a checkpoint write (see the
 * `work_items:checkpoint` / `loop:checkpoint` tools), and a failed capture must never
 * fail the checkpoint it accompanied — the checkpoint is the thing the successor
 * cannot do without.
 */
export async function postEffortNote(input: EffortNoteInput): Promise<EffortNoteResult> {
  const text = (input.text ?? '').trim();
  const level = input.target.kind;
  const base = { posted: false as const, level, ref: input.target.ref };
  if (!text) return { ...base, skipped: 'blank' };
  const advisory = describeCaptureGaps(text);
  if (!input.target.ref?.trim()) return { ...base, skipped: 'unknown-target', advisory };

  try {
    if (level === 'work_item') {
      // Both families, via the one path that already dispatches issue vs feature and
      // fans out to the item's subscribers. Reusing it is what makes capture-at-item
      // free: no new write path, no second fan-out, no divergence.
      const post = await commentWorkItem(input.target.ref, text, input.authorId ?? undefined, {
        workspaceId: input.workspaceId,
        harness: input.target.harness ?? undefined,
      });
      if (!post) return { ...base, skipped: 'unknown-target', advisory };
      return { posted: true, level, ref: input.target.ref, post, advisory };
    }
    const parent = effortObjectRef(input.target);
    const store = storeFor(input.workspaceId);
    const createdTs = new Date().toISOString();
    const thread = await store.getOrCreateThread(parent, {
      thread_id: effortThreadId(level, parent.ref),
      title: level === 'plan' ? `plan ${input.target.ref}` : `goal ${input.target.ref}`,
      created_by: input.authorId ?? undefined,
      created_ts: createdTs,
      // harness_slug drives federation. A plan is harness-scoped, so its thread
      // federates with the harness; a goal is workspace-scoped and stays local.
      harness_slug: level === 'plan' ? (input.target.harness ?? undefined) : undefined,
    });
    const post = await store.addPost({
      thread_id: thread.thread_id,
      author_id: input.authorId ?? undefined,
      body: text,
      created_ts: createdTs,
    });
    return { posted: true, level, ref: input.target.ref, post, advisory };
  } catch {
    return { ...base, skipped: 'write-failed', advisory };
  }
}

/** Read a plan's or goal's own thread, newest LAST (matching work-item thread windows).
 * Store failures must reject: rollup callers turn them into scoped unknowns and
 * recovery actions. Returning [] here would make an unreadable lesson look absent.
 */
export async function readEffortThread(
  target: ContainmentRef,
  limit = 25,
  workspaceId?: string,
): Promise<ThreadPostRow[]> {
  if (target.kind === 'work_item') {
    throw new Error('readEffortThread: use getWorkItemThreadWindow for work-item threads (family dispatch).');
  }
  const ws = resolveConcreteWorkspaceId(workspaceId);
  if (!ws || !target.ref) return [];
  const store = storeFor(ws);
  const thread = await store.getThreadByParent(effortObjectRef(target));
  if (!thread) return [];
  const window = await store.listRecentPosts(thread.thread_id, Math.max(1, limit));
  return window.posts;
}

/**
 * P-017's tool-facing entry point: post a lesson at the level the agent is working at,
 * resolving that level from the work-item it is checkpointing.
 *
 * `level` DEFAULTS to `work_item` — "the most specific object the caller holds, which
 * for 94% of items is the item itself" (measured 2026-09-02: 15,791 of 16,792 open
 * items carry neither a plan nor a goal). Asking for `plan` or `goal` resolves the
 * item's ancestors through the containment tree; a level the item does not HAVE falls
 * back to the most specific level it does, rather than silently dropping the note.
 *
 * ⚠ NOT a promotion (D-009). Nothing is copied or lifted between levels. The caller
 * names the level its insight belongs to and the note is written there once.
 */
export async function postLearnedAtLevel(input: {
  workItemId: string;
  level?: ContainmentKind;
  text: string;
  harness?: string | null;
  authorId?: string | null;
  workspaceId?: string;
}): Promise<EffortNoteResult & { requestedLevel: ContainmentKind; fellBack: boolean }> {
  const requested: ContainmentKind = input.level ?? 'work_item';
  let target: ContainmentRef = { kind: 'work_item', ref: input.workItemId, harness: input.harness ?? null };
  let fellBack = false;
  if (requested !== 'work_item') {
    const { resolveContainmentTree } = await import('./containment-tree');
    const tree = await resolveContainmentTree(target, {
      workspaceId: input.workspaceId,
      harness: input.harness ?? null,
      direction: 'up',
    }).catch(() => null);
    const node = tree?.ancestors.find((a) => a.kind === requested) ?? null;
    if (node) target = { kind: node.kind, ref: node.ref, harness: node.harness ?? input.harness ?? null };
    else fellBack = true;
  }
  const result = await postEffortNote({
    target,
    text: input.text,
    authorId: input.authorId,
    workspaceId: input.workspaceId,
  });
  return { ...result, requestedLevel: requested, fellBack };
}

/**
 * D-010's WRITE-SIDE FIX, and the reason it is feedback rather than instruction.
 *
 * The compression ladder the READER depends on is keyword-matched prose, not data the
 * writer supplies: `rootCauses` exists only when the author happened to write "root
 * cause" or "originates at". Measured 2026-09-02 across the live corpora, 95.6% of
 * work-item checkpoints yield NO rootCause and 97.5% no falsePremise — so the reader
 * cannot compress structure the write side never produced.
 *
 * The fix deliberately is NOT required structured arguments: that would violate D-004
 * (a surface agents must remember to feed is one they will not feed) on a surface
 * already written for only ~10% of items open past 21 days. Instead we run the
 * READER'S OWN EXTRACTOR at write time and hand back what it found — no gate, no
 * rejection, no new required args — because the writer's inability to SEE the gap is
 * the actual mechanism.
 *
 * WHY THE WRITER CANNOT SELF-CORRECT: an agent re-reading its own note finds it clear,
 * because it still holds the context the note depends on. The reader is weeks later,
 * in a different session, possibly a different model. That shared prior is absent by
 * construction and the writer has no signal that it is.
 *
 * FALSIFIER (D-010): rootCause incidence on NEW checkpoints should rise from the 4.4%
 * baseline. If it does not, the diagnosis was wrong — agents do not KNOW the root
 * causes rather than not knowing the words — and the problem is the capture MOMENT,
 * which is a different plan.
 */
export interface CaptureAdvisory {
  /** Rungs this note WILL yield to a future briefing. */
  found: string[];
  /** Rungs it will not, each with the vocabulary that would populate it. */
  missing: Array<{ rung: 'rootCauses' | 'falsePremises' | 'residue'; hint: string }>;
  /** One line safe to surface verbatim in a tool result; null when nothing is missing. */
  note: string | null;
}

const RUNG_HINTS: Record<'rootCauses' | 'falsePremises' | 'residue', string> = {
  rootCauses: 'name it with "root cause:" or "originates at" so a later claimant inherits the WHY, not just the what',
  falsePremises: 'mark a corrected belief with "false premise", "was wrong" or "retracted" so it cannot be re-derived',
  residue: 'mark what is left with "still open", "follow-up" or "deferred" — residue is lifted out of truncated briefs',
};

export function describeCaptureGaps(text: string): CaptureAdvisory {
  const rungs = extractPriorAttemptRungs(text ?? '');
  const found: string[] = [];
  const missing: CaptureAdvisory['missing'] = [];
  for (const rung of ['rootCauses', 'falsePremises', 'residue'] as const) {
    if (rungs[rung].length > 0) found.push(rung);
    else missing.push({ rung, hint: RUNG_HINTS[rung] });
  }
  if (rungs.touchedFiles.length) found.push('touchedFiles');
  if (rungs.tests.length) found.push('tests');
  // Silence when the note already carries the rungs that matter. An advisory that
  // fires on every write is one nobody reads — the failure D-004 names.
  const note =
    missing.length === 0
      ? null
      : `this note yields ${found.length ? found.join(', ') : 'no structured rungs'} to a future claim-time brief; ` +
        `${missing.map((m) => `${m.rung} — ${m.hint}`).join('; ')}`;
  return { found, missing, note };
}
