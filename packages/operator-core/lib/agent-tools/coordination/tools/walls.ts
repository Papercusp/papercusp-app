/**
 * coord:walls — "what is blocked on the OWNER right now?"
 *
 * EI-10890. The system already MANDATES that an agent register anything it is
 * blocked on the owner for:
 *   - `loop:checkpoint { walls }` writes owner-gated commitments as rows into the
 *     loop carry-note, where they re-render into every wake until cleared;
 *   - a work-item parked in `needs-human` is, by definition, waiting on a human.
 *
 * Both are WRITTEN faithfully. Neither was READABLE. There was no query that
 * answered "what is waiting on me", so the walls piled up where only the blocked
 * agent could see them — in its own carry-note.
 *
 * The cost of that gap, observed 2026-07-13: the auto-loop-reliability lane
 * (su-39f079d3) sat parked for ~5 HOURS on a single 4-way capacity decision it had
 * correctly registered as a wall and correctly messaged the owner about. The owner
 * did not know. It surfaced only because he happened to ask an unrelated question
 * about that session and an agent grepped its carry-note by hand. Every mechanism
 * worked exactly as designed; the only missing part was a read.
 *
 * This is that read. It is deliberately a UNION over the two write surfaces rather
 * than a new store — the data is already there, correctly maintained, and a third
 * parallel "walls table" would just be a fourth thing to keep in sync (reuse-first).
 *
 * The liveness join is the non-obvious half: a wall whose agent is DEAD is worse
 * than a wall whose agent is alive. Answering a dead agent's question unblocks
 * nothing — nobody is waiting to act on the answer — so those are reported as
 * `stranded` and need a respawn, not a reply. Without that distinction an owner
 * clears a wall, feels productive, and the work still does not move.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../roles';
import { splitCarryNoteWalls } from '../../../carry-note';
import { WALL_KEY_PREFIX, type FactScope } from '../../../agent-facts/store';
import {
  classifyReadActionability,
  resolveSessionStates,
  type LivenessSubject,
  type LivenessVerdict,
  type ReadActionability,
} from '../liveness-oracle';
import type { SessionState } from '../presence-wakeability';

/** A loop carry-note scope is `loop:<harness>:<ownerId>` (carry-note.ts loopScope). */
function parseLoopScope(scope: string): { harness: string; ownerId: string } | null {
  if (!scope.startsWith('loop:')) return null;
  const rest = scope.slice('loop:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { harness: rest.slice(0, sep), ownerId: rest.slice(sep + 1) };
}

/** Whole hours a wall has stood. Drives the ordering: oldest first, because the
 *  wall nobody has looked at in 5h is the one costing the most. */
function hoursSince(ms: number | null, now: number): number | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(((now - ms) / 3_600_000) * 10) / 10);
}

export interface WallRow {
  source: 'loop-carry-note' | 'work-item' | 'standing-fact';
  ownerId: string | null;
  harness: string | null;
  claim: string;
  recheck?: string;
  ref?: string;
  /** Present only for the `wall:` standing-fact leg. These are the exact
   *  facts:retract coordinates; never reconstruct them from the card id. */
  factScope?: FactScope;
  factScopeRef?: string | null;
  factKey?: string;
  sinceIso: string | null;
  waitingHours: number | null;
  /** waiting = actionable; stale = draining; stranded = ended/suspect; unknown
   *  = no liveness verdict, so none is counted as owner work. */
  status: 'waiting' | 'stale' | 'stranded' | 'unknown';
  actionability?: ReadActionability;
  livenessState?: SessionState | null;
}

/**
 * Owner-facing ranking. A wall the owner can ACT on outranks one that needs a
 * respawn or has no live waiter, however much older the latter is; within a
 * rank, oldest-first still wins.
 *
 * WI-2141328: ordering by age ALONE let a backlog of ancient rows crowd every
 * live ask out of the `limit` window. Measured on 2026-09-02 this workspace held
 * 765 carry-note rows carrying walls; the default read returned the 50 oldest —
 * all dead July sessions — and reported `waiting: 0` while a live 12h wall stood
 * unanswered. The owner's whole "what's blocked on me" view showed only corpses.
 */
const WALL_STATUS_RANK: Record<WallRow['status'], number> = {
  waiting: 0,
  stale: 1,
  unknown: 2,
  stranded: 3,
};

export interface ListOwnerWallsOpts {
  workspaceId?: string;
  harness?: string;
  ownerId?: string;
  minHours?: number;
  includeStranded?: boolean;
  limit?: number;
}

/**
 * The reusable core of `coord:walls` (owner-inbox-single-pane-2026-07-17 P-005b
 * reuse-first extraction): unions loop-carry-note walls + needs-human work-items
 * with the liveness join, ranked actionable-first and then oldest-wait-first.
 * Exported so the unified `plans:attention` reader can fold the SAME rows into
 * the owner's inbox (`ownerWallToAttention`) without duplicating this
 * SQL/liveness logic — the tool handler below is now a thin wrapper over this
 * function.
 *
 * `waiting`/`stranded`/`oldestWaitHours`/`total` are a CENSUS over the whole
 * eligible population, deliberately NOT over the returned window: `limit` bounds
 * the row list only. Counting after the slice (WI-2141328) turned a truncated
 * page into a confident "nothing is waiting on you".
 */
export async function listOwnerWalls(opts: ListOwnerWallsOpts = {}): Promise<{
  walls: WallRow[];
  waiting: number;
  stranded: number;
  oldestWaitHours: number | null;
  /** Size of the eligible population, independent of `limit`. */
  total: number;
  /** Size of the returned window (`walls.length`). */
  returned: number;
  /** True when the window omits eligible rows — so a count is never read as a total. */
  truncatedByLimit: boolean;
}> {
  const sql = getOrgPg().sql;
  const ws = opts.workspaceId ?? 'default';
  const now = Date.now();
  const limit = opts.limit ?? 50;
  const includeStranded = opts.includeStranded ?? true;

  // ── Liveness inputs: the shared oracle decides whether an answer has a live
  // waiter. Keep the full presence row rather than rebuilding a heartbeat-only
  // rule here.
  const presence = await sql<
    Array<{
      owner_id: string;
      workspace_id: string;
      heartbeat_at: string | null;
      host: string | null;
      pid: number | null;
      source: string | null;
      agent_role: string | null;
    }>
  >`
    SELECT owner_id, workspace_id, heartbeat_at::text AS heartbeat_at,
           host, pid, source, agent_role
      FROM harness_shared.coord_presence
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
  `;
  const presenceByOwner = new Map<string, (typeof presence)[number]>();
  for (const p of presence) {
    const current = presenceByOwner.get(p.owner_id);
    if (!current || (p.workspace_id === ws && current.workspace_id !== ws)) {
      presenceByOwner.set(p.owner_id, p);
    }
  }

  const walls: WallRow[] = [];

  // ── Source 1: loop carry-note walls (the P-006 owner-gated commitment rows) ──
  const notes = await sql<Array<{ scope: string; note: string | null; updated_ts: Date | null }>>`
    SELECT scope, note, updated_ts
      FROM harness_shared.carry_notes
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       AND scope LIKE 'loop:%'
       AND note IS NOT NULL
  `;
  for (const row of notes) {
    const parsed = parseLoopScope(row.scope);
    if (!parsed) continue;
    if (opts.harness && parsed.harness !== opts.harness) continue;
    if (opts.ownerId && parsed.ownerId !== opts.ownerId) continue;
    const { walls: entries } = splitCarryNoteWalls(row.note);
    for (const w of entries) {
      const sinceMs = w.sinceMs ?? (row.updated_ts ? new Date(row.updated_ts).getTime() : null);
      walls.push({
        source: 'loop-carry-note',
        ownerId: parsed.ownerId,
        harness: parsed.harness,
        claim: w.claim,
        ...(w.recheck ? { recheck: w.recheck } : {}),
        sinceIso: sinceMs != null ? new Date(sinceMs).toISOString() : null,
        waitingHours: hoursSince(sinceMs, now),
        status: 'unknown',
      });
    }
  }

  // ── Source 2: work-items parked in needs-human ───────────────────────────
  const items = await sql<
    Array<{
      feature_id: string;
      title: string | null;
      harness_slug: string | null;
      taken_by: string | null;
      last_progress_at: Date | null;
    }>
  >`
    SELECT feature_id, title, harness_slug, taken_by, last_progress_at
      FROM harness_shared.work_items
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       AND status = 'needs-human'
       AND (${opts.harness ?? null}::text IS NULL OR harness_slug = ${opts.harness ?? null})
       AND (${opts.ownerId ?? null}::text IS NULL OR taken_by = ${opts.ownerId ?? null})
  `;
  for (const it of items) {
    const sinceMs = it.last_progress_at ? new Date(it.last_progress_at).getTime() : null;
    walls.push({
      source: 'work-item',
      ownerId: it.taken_by,
      harness: it.harness_slug,
      claim: it.title ?? it.feature_id,
      ref: it.feature_id,
      sinceIso: sinceMs != null ? new Date(sinceMs).toISOString() : null,
      waitingHours: hoursSince(sinceMs, now),
      status: 'unknown',
    });
  }

  // ── Source 3: live standing facts in the explicit `wall:` slot ───────────
  //
  // A wall fact is already the durable, owner-gated source of truth. Project it
  // into this existing union rather than inventing a parallel queue. Scope is
  // preserved verbatim because it is the address facts:retract needs; harness
  // scope is resolved for filtering/display, and a work_item-scoped fact joins
  // the existing work-items view only to recover that item's harness.
  const factHarness = opts.harness ?? null;
  const facts = await sql<
    Array<{
      scope: FactScope;
      scope_ref: string | null;
      key: string;
      body: string;
      created_by: string;
      updated_at: Date | null;
      harness_slug: string | null;
      recheck: unknown;
    }>
  >`
    SELECT f.scope, f.scope_ref, f.key, f.body, f.created_by,
           f.updated_at, CASE
             WHEN f.scope = 'harness' THEN f.scope_ref
             WHEN f.scope = 'work_item' THEN wi.harness_slug
             ELSE NULL
           END AS harness_slug,
           f.recheck
      FROM harness_shared.agent_facts f
      LEFT JOIN harness_shared.work_items wi
        ON f.scope = 'work_item'
       AND wi.workspace_id = f.workspace_id
       AND wi.feature_id = f.scope_ref
     WHERE (f.workspace_id = ${ws} OR f.workspace_id = 'default')
       AND f.key LIKE ${WALL_KEY_PREFIX + '%'}
       AND f.superseded_at IS NULL
       AND f.retracted_at IS NULL
       AND f.expires_at > now()
       AND (${opts.ownerId ?? null}::text IS NULL OR f.created_by = ${opts.ownerId ?? null})
       AND (
         ${factHarness}::text IS NULL
         OR f.scope IN ('workspace', 'owner', 'role')
         OR (f.scope = 'harness' AND f.scope_ref = ${factHarness})
         OR (f.scope = 'work_item' AND wi.harness_slug = ${factHarness})
       )
  `;
  for (const fact of facts) {
    const sinceMs = fact.updated_at ? new Date(fact.updated_at).getTime() : null;
    const recheck =
      fact.recheck &&
      typeof fact.recheck === 'object' &&
      !Array.isArray(fact.recheck) &&
      typeof (fact.recheck as { probe?: unknown }).probe === 'string'
        ? (fact.recheck as { probe: string }).probe.trim()
        : '';
    walls.push({
      source: 'standing-fact',
      ownerId: fact.created_by || null,
      harness: fact.harness_slug,
      claim: fact.body,
      ...(recheck ? { recheck } : {}),
      ref: fact.key,
      factScope: fact.scope,
      factScopeRef: fact.scope_ref,
      factKey: fact.key,
      sinceIso: sinceMs != null ? new Date(sinceMs).toISOString() : null,
      waitingHours: hoursSince(sinceMs, now),
      status: 'unknown',
    });
  }

  const ownerIds = [...new Set(walls.map((w) => w.ownerId).filter((id): id is string => Boolean(id)))];
  const subjects: LivenessSubject[] = ownerIds.map((ownerId) => {
    const p = presenceByOwner.get(ownerId);
    return {
      ownerId,
      heartbeatAt: p?.heartbeat_at,
      host: p?.host,
      pid: p?.pid,
      source: p?.source,
      agentRole: p?.agent_role,
      claimsHeld: walls.some((w) => w.ownerId === ownerId && w.source === 'work-item'),
    };
  });
  let verdicts = new Map<string, LivenessVerdict>();
  if (subjects.length > 0) {
    try {
      verdicts = await resolveSessionStates(subjects);
    } catch {
      // Preserve rows as unknown rather than fabricating an actionable wall
      // when the liveness store is temporarily unavailable.
    }
  }
  for (const wall of walls) {
    const verdict = wall.ownerId ? verdicts.get(wall.ownerId) : undefined;
    const actionability = classifyReadActionability(verdict?.sessionState);
    wall.actionability = actionability;
    wall.livenessState = verdict?.sessionState ?? null;
    if (actionability === 'actionable') wall.status = 'waiting';
    else if (verdict?.sessionState === 'draining') wall.status = 'stale';
    else if (actionability === 'non-actionable') wall.status = 'stranded';
    else wall.status = 'unknown';
  }

  // The eligible POPULATION — every filter applied, nothing truncated. The
  // census below is taken here, before `limit` bounds the row list.
  const eligible = walls
    .filter((w) => (includeStranded ? true : w.status !== 'stranded'))
    .filter((w) => (opts.minHours == null ? true : (w.waitingHours ?? 0) >= opts.minHours))
    .sort((a, b) => {
      const rank = WALL_STATUS_RANK[a.status] - WALL_STATUS_RANK[b.status];
      if (rank !== 0) return rank;
      return (b.waitingHours ?? -1) - (a.waitingHours ?? -1);
    });

  const filtered = eligible.slice(0, limit);
  const waitingRows = eligible.filter((w) => w.status === 'waiting');

  return {
    walls: filtered,
    waiting: waitingRows.length,
    stranded: eligible.filter((w) => w.status === 'stranded').length,
    // The oldest ACTIONABLE wall when there is one — that is the number an owner
    // acts on. Falling back to the oldest row overall keeps a stranded-only read
    // informative instead of reporting null.
    oldestWaitHours: waitingRows[0]?.waitingHours ?? eligible[0]?.waitingHours ?? null,
    total: eligible.length,
    returned: filtered.length,
    truncatedByLimit: eligible.length > filtered.length,
  };
}

export default defineTool({
  name: 'coord:walls',
  description:
    'What is BLOCKED ON THE OWNER right now — every agent parked on a decision, credential, or approval only a human can give. ' +
    'Unions the two surfaces where agents are already required to register owner-gated blockers: loop carry-note walls ' +
    '(loop:checkpoint { walls }), work-items in needs-human, and live `wall:` standing facts. Each row carries the ask VERBATIM, how long it has been ' +
    'waiting, the re-check command, and — critically — whether the blocked agent is still ALIVE (waiting) or its session ' +
    'has died (stranded: answering will not resume it; it must be respawned). Live asks rank first, then oldest-wait.',
  guidance: {
    when:
      'The owner asks "what needs me / what is waiting on me / am I blocking anything", at the top of an owner session, ' +
      'and in any fleet-leader or monitor sweep. Also before you report "all green" — a fleet with a 5h-old owner wall ' +
      'is NOT green, it is stalled on the owner and nobody has told them.',
    notWhen:
      'Who is working on what (coord:presence / fleet:assignments). Blockers between AGENTS — those are peer coordination ' +
      '(coord:send), not owner walls; only a blocker a HUMAN must clear belongs here.',
    chaining:
      'coord:walls → answer the claim (coord:send to the ownerId), then the agent clears it via loop:checkpoint { walls: [...] } ' +
      '(pass the remaining set; [] clears all). A `stranded` row needs a respawn as well as an answer — the waiter is gone.',
    returns:
      '{ ok, count, returned, truncatedByLimit, waiting, stranded, oldestWaitHours, walls: [{ source, ownerId, harness, claim, recheck?, ref?, factScope?, factScopeRef?, factKey?, sinceIso, waitingHours, status }] }. ' +
      '`count`/`waiting`/`stranded` are a census over the whole population; `returned` is the row-list size and `truncatedByLimit` says rows were omitted. ' +
      'status: waiting = agent alive and parked on you; stranded = its session died (answer AND respawn); unknown = no presence row.',
    seeAlso: ['coord:presence', 'coord:send', 'loop:checkpoint', 'work_items:list'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  // EI-20226779878046151: walls reads its own loop/work-item stores and never
  // reads ctx.tx. The orient leader fold must not retain an ambient pool slot.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(120).optional().describe('Only walls under this harness (default: every harness).'),
    ownerId: z.string().max(120).optional().describe('Only walls raised by this agent.'),
    minHours: z
      .number()
      .min(0)
      .max(720)
      .optional()
      .describe('Only walls standing at least this long — e.g. 1 to skip walls raised moments ago.'),
    includeStranded: z
      .boolean()
      .optional()
      .describe('Include walls whose agent is dead (default true). These need a respawn, not just an answer.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
  }),
  result: z
    .object({
      ok: z.boolean(),
      count: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      truncatedByLimit: z.boolean(),
      waiting: z.number().int().nonnegative(),
      stranded: z.number().int().nonnegative(),
      oldestWaitHours: z.number().nullable(),
      walls: z.array(z.unknown()),
      note: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    // owner-inbox-single-pane P-005b: the union/liveness-join logic now lives in
    // the exported `listOwnerWalls` (reuse-first — `plans:attention` folds the
    // SAME rows into the unified inbox without duplicating this SQL).
    const {
      walls: filtered,
      waiting,
      stranded,
      oldestWaitHours,
      total,
      returned,
      truncatedByLimit,
    } = await listOwnerWalls({
      workspaceId: ctx.workspaceId ?? 'default',
      harness: args.harness,
      ownerId: args.ownerId,
      minHours: args.minHours,
      includeStranded: args.includeStranded,
      limit: args.limit,
    });

    // Return a { data } envelope (NOT hand-rolled inline JSON): the framework then
    // compact-encodes the walls array for the agent transport for free, and the
    // tool-data-shape ratchet holds. A new tool has no legacy byte-contract to keep.
    return {
      data: {
        ok: true,
        // `count` is the POPULATION, not the page — a truncated window must never
        // read as a total (WI-2141328). `returned` is the row-list size.
        count: total,
        returned,
        truncatedByLimit,
        waiting,
        stranded,
        oldestWaitHours,
        note:
          total === 0
            ? 'Nothing is blocked on the owner.'
            : `${total} owner-gated blocker(s): ${waiting} agent(s) alive and parked on an answer, ` +
              `${stranded} STRANDED (session died — answering alone will not resume them; respawn as well). ` +
              (truncatedByLimit
                ? `Showing the ${returned} highest-priority (live asks first, then oldest); raise \`limit\` for the rest. `
                : '') +
              'Answer via coord:send to the ownerId; the agent clears its wall with loop:checkpoint { walls }.',
        walls: filtered,
      },
    };
  },
});
