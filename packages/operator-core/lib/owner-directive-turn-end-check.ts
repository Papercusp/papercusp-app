/**
 * owner-directive-turn-end-check — P-007 of plan
 * `owner-directive-delivery-redesign-2026-09-22`: the question an agent is
 * asked at the moment it tries to END a turn (the Stop hook).
 *
 * Two checks, both limited to directives ADDRESSED to this session (the capture
 * hook records a turn under the session the owner typed into, so `recordedBy`
 * is the addressee — the same predicate the obligation reader uses):
 *
 *  1. SUMMARY OWED (D-004). An over-cap directive with no summary renders to
 *     every other agent as "summary not written yet". Only the addressed agent
 *     has the context to summarize it, so its turn is blocked until it writes
 *     one with orders:summarize. Re-checked every turn until the summary exists.
 *  2. DONE OR STILL OPEN (D-005). The agent replied to a turn whose directive is
 *     still open. It is asked ONCE per directive whether it is done, declined,
 *     or still in progress. Asked once, not every turn: a directive that is
 *     legitimately still in progress would otherwise bounce every turn end, and
 *     the P-006 reminder already carries it from there.
 *
 * Bounded by the client: Claude sets `stop_hook_active` on the continuation a
 * block causes and the hook exits on it, so a turn is bounced at most once.
 * Fail-silent: any error answers "no check" (null), never a blocked agent.
 *
 * The asked set lives on a server-side read cursor. It is marked when the ask
 * is STAGED, so a hook killed after staging loses that one question; the
 * directive still reaches the agent through the P-006 reminder and orientation.
 */
import {
  directiveNeedsSummary,
  OWNER_DIRECTIVE_SUMMARY_MAX,
  OWNER_DIRECTIVE_VERBATIM_CAP,
} from './owner-directive-display';
import type { OwnerDirectiveRow } from './owner-directives';

export const TURN_END_DIRECTIVE_CHECK_SURFACE = 'turn-end-directive-check';
/** How many asked ids the cursor keeps. A session's open directives stay far below this. */
export const TURN_END_ASKED_MEMORY = 100;
/** Most directive ids one block reason names; the rest collapse to a count. */
const MAX_IDS_NAMED = 6;

export type TurnEndDirectiveRow = Pick<
  OwnerDirectiveRow,
  'id' | 'recordedBy' | 'verbatimText' | 'summaryText' | 'createdAtMs' | 'capturedByHook'
>;

export interface TurnEndDirectiveCheck {
  /** The block reason the agent reads. */
  reason: string;
  /** Directive ids this check asks done-or-open about — record them as asked. */
  asking: number[];
}

function idList(ids: number[]): string {
  const named = ids.slice(0, MAX_IDS_NAMED).map((id) => `#${id}`);
  const rest = ids.length - named.length;
  return named.join(', ') + (rest > 0 ? ` (+${rest} more: orders:list { open: true })` : '');
}

/**
 * PURE: what, if anything, to ask this session before its turn ends. `open` is
 * the workspace's open directives (any session); `asked` is the set this session
 * was already asked about.
 */
export function planTurnEndDirectiveCheck(input: {
  ownerId: string;
  open: ReadonlyArray<TurnEndDirectiveRow>;
  asked: ReadonlySet<number>;
}): TurnEndDirectiveCheck | null {
  const own = input.open.filter((row) => row.recordedBy === input.ownerId);
  const unsummarized = own.filter((row) => directiveNeedsSummary(row) && !row.summaryText).map((row) => row.id);
  // Only hook-captured turns: those are the turns this session actually replied
  // to. An orders:record row is an agent's assertion, handled by its recorder.
  const asking = own
    .filter((row) => row.capturedByHook && !input.asked.has(row.id))
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((row) => row.id);
  if (unsummarized.length === 0 && asking.length === 0) return null;

  const parts: string[] = [];
  if (unsummarized.length > 0) {
    const noun = unsummarized.length === 1 ? 'directive' : 'directives';
    parts.push(
      `Owner ${noun} ${idList(unsummarized)} addressed to you ${unsummarized.length === 1 ? 'is' : 'are'} over ` +
        `${OWNER_DIRECTIVE_VERBATIM_CAP} chars with no summary, so every other agent sees only "summary not written ` +
        `yet". Write it now: orders:summarize { id, summary } (at most ${OWNER_DIRECTIVE_SUMMARY_MAX} chars, faithful ` +
        `to the owner's words).`,
    );
  }
  if (asking.length > 0) {
    const one = asking.length === 1;
    parts.push(
      `You replied to owner ${one ? 'directive' : 'directives'} ${idList(asking)}, still open. ` +
        `${one ? 'Is it' : 'Is each one'} done? Done: orders:disposition { id, status: 'done', note }. ` +
        `Not going to happen: status 'declined' with the reason. Still in progress: say so and end the turn; ` +
        `it stays open. You are asked this once per directive.`,
    );
  }
  return { reason: parts.join('\n'), asking };
}

export interface TurnEndDirectiveCheckDeps {
  listOpen(workspaceId: string, ownerId: string): Promise<TurnEndDirectiveRow[]>;
  readAsked(ownerId: string): Promise<number[]>;
  stageAsked(ownerId: string, asked: number[]): Promise<void>;
}

export function defaultTurnEndDirectiveCheckDeps(): TurnEndDirectiveCheckDeps {
  return {
    async listOpen(workspaceId, ownerId) {
      const { listOwnerDirectives } = await import('./owner-directives');
      // viewerOwnerId: a row this session cleared off its own agenda is not asked about.
      return listOwnerDirectives({ workspaceId, state: ['open'], viewerOwnerId: ownerId, limit: 200 });
    },
    async readAsked(ownerId) {
      const { ackAndRead } = await import('./agent-tools/coordination/read-cursors');
      const { committed } = await ackAndRead(ownerId, TURN_END_DIRECTIVE_CHECK_SURFACE);
      const raw = committed?.asked;
      return Array.isArray(raw) ? raw.filter((id): id is number => typeof id === 'number') : [];
    },
    async stageAsked(ownerId, asked) {
      const { stage } = await import('./agent-tools/coordination/read-cursors');
      await stage(ownerId, TURN_END_DIRECTIVE_CHECK_SURFACE, { asked });
    },
  };
}

/**
 * IO wrapper for the Stop hook's endpoint: the block reason, or null to let the
 * turn end. Fail-silent by contract.
 */
export async function runTurnEndDirectiveCheck(
  input: { ownerId: string; workspaceId: string },
  deps: TurnEndDirectiveCheckDeps = defaultTurnEndDirectiveCheckDeps(),
): Promise<string | null> {
  try {
    const [open, asked] = await Promise.all([deps.listOpen(input.workspaceId, input.ownerId), deps.readAsked(input.ownerId)]);
    const check = planTurnEndDirectiveCheck({ ownerId: input.ownerId, open, asked: new Set(asked) });
    if (!check) return null;
    if (check.asking.length > 0) {
      // Keep only ids still open, so the set cannot grow without bound.
      const stillOpen = new Set(open.map((row) => row.id));
      const next = [...new Set([...asked.filter((id) => stillOpen.has(id)), ...check.asking])].slice(-TURN_END_ASKED_MEMORY);
      await deps.stageAsked(input.ownerId, next);
    }
    return check.reason;
  } catch {
    return null;
  }
}
