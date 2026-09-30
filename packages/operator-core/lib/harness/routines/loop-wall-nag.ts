/**
 * loop-wall-nag — the P-006 turn-settle nag
 * (compaction-continuity-hardening-2026-07-07).
 *
 * A loop turn that ENDS with an owner-ask in prose ("awaiting owner OK to …")
 * while holding ZERO wall rows has made a commitment that will dissolve at the
 * next context boundary — exactly the failure walls exist to prevent. The
 * observable settle point for a detached loop turn is its clean subprocess exit
 * (wake-executor captures the `claude --resume … -p` stdout tail = the turn's
 * final text): loop-turn-outcome detects the ask there via {@link detectOwnerAsk}
 * and STASHES a nag; the next fire TAKES it and splices a hard, named mandate
 * (WI-2429 style — the concrete pending action, not a generic conditional) into
 * the wake text.
 *
 * KNOWN GAP: the live-INJECT wake channel has no subprocess exit to observe, so
 * an in-place warm turn's final text is not scanned (deferred — a Stop-hook /
 * lifecycle-marker feed could close it). The cold/detached channel this covers
 * is the one where prose loss is guaranteed, so it carries the value.
 *
 * The stash rides the carry-note substrate (scope `loopnag:<harness>:<ownerId>`,
 * journal OFF — take deletes the row) — no new table. Pinned to the coord
 * workspace like the loop carry-note (carry-note.ts loopCarryWs rationale).
 */
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getCarryNote, setCarryNote } from '../../carry-note';

/** Nag excerpt cap — one line of the ask, enough to name the concrete action. */
export const LOOP_WALL_NAG_EXCERPT_MAX = 200;

/** The stash scope. ownerId is a session uuid ⇒ globally unique across workspaces. */
export function loopWallNagScope(harness: string, ownerId: string): string {
  return `loopnag:${harness}:${ownerId}`;
}

// Precision-first (the P-005 advisory lesson: a noisy nag trains agents to
// ignore it). Every pattern names the OWNER explicitly — generic "waiting for
// approval" prose does not fire.
const OWNER_ASK_PATTERNS: ReadonlyArray<RegExp> = [
  /\bawait(?:ing|s)?\s+(?:the\s+)?owner\b/i,
  /\bowner(?:'s)?\s+(?:ok|okay|approval|sign-?off|go[- ]ahead|confirmation|decision)\b/i,
  /\bpending\s+(?:the\s+)?owner\b/i,
  /\bowner[- ]gated\b/i,
  /\bneeds?\s+(?:the\s+)?owner(?:'s)?\b/i,
  /\bask(?:ing)?\s+the\s+owner\b/i,
  /\bblocked\s+on\s+(?:the\s+)?owner\b/i,
  /\bwaiting\s+(?:for|on)\s+(?:the\s+)?owner\b/i,
];

/**
 * Scan a turn's final text for an owner-ask; return the LAST matching line
 * (capped) — the ask nearest the turn's end names the still-open commitment —
 * or null. Pure.
 */
export function detectOwnerAsk(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const lines = t.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (OWNER_ASK_PATTERNS.some((re) => re.test(line))) {
      return line.length > LOOP_WALL_NAG_EXCERPT_MAX
        ? line.slice(0, LOOP_WALL_NAG_EXCERPT_MAX - 1) + '…'
        : line;
    }
  }
  return null;
}

export interface LoopWallNag {
  atMs: number;
  excerpt: string;
}

export interface LoopWallNagDeps {
  set?: typeof setCarryNote;
  get?: typeof getCarryNote;
}

/** Stash a nag for the loop's next fire. Replace-on-write (one pending nag —
 *  a repeat ask just refreshes it). Fail-soft: a store error drops the nag. */
export async function stashLoopWallNag(
  ref: { harness: string; ownerId: string },
  excerpt: string,
  nowMs: number = Date.now(),
  deps: LoopWallNagDeps = {},
): Promise<boolean> {
  try {
    const set = deps.set ?? setCarryNote;
    await set(
      { scope: loopWallNagScope(ref.harness, ref.ownerId), workspaceId: DEFAULT_COORD_WORKSPACE },
      JSON.stringify({ atMs: nowMs, excerpt } satisfies LoopWallNag),
      { journal: false },
    );
    return true;
  } catch {
    return false;
  }
}

/** Read AND clear the pending nag (delivered exactly once — the next fire
 *  renders it; a re-ask with no row re-triggers the stash). Fail-soft ⇒ null. */
export async function takeLoopWallNag(
  ref: { harness: string; ownerId: string },
  deps: LoopWallNagDeps = {},
): Promise<LoopWallNag | null> {
  try {
    const get = deps.get ?? getCarryNote;
    const set = deps.set ?? setCarryNote;
    const scoped = { scope: loopWallNagScope(ref.harness, ref.ownerId), workspaceId: DEFAULT_COORD_WORKSPACE };
    const raw = await get(scoped);
    if (!raw) return null;
    await set(scoped, null, { journal: false });
    const parsed = JSON.parse(raw) as Partial<LoopWallNag>;
    if (typeof parsed?.excerpt !== 'string' || !parsed.excerpt.trim()) return null;
    return { atMs: typeof parsed.atMs === 'number' ? parsed.atMs : 0, excerpt: parsed.excerpt };
  } catch {
    return null;
  }
}

/** The hard-style nag line the wake splices (WI-2429: name the CONCRETE pending
 *  action, demand the row NOW — a generic "consider recording walls" is ignored). */
export function renderWallNagLine(nag: LoopWallNag): string {
  return (
    `⚠ TURN-SETTLE NAG: your previous turn ended with an owner-ask — "${nag.excerpt}" — but you hold ` +
    'NO wall row, so that commitment dissolves at the next context boundary. Commitments are rows, never ' +
    'prose: park it NOW via loop:checkpoint { walls: [{ claim, recheck }] } (or file a blocked work_item), ' +
    'before anything else this wake.'
  );
}
