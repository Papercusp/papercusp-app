/**
 * state-plane-adoption.ts — the RE-SCOPED adoption metric for the unified agent
 * state plane (plan state-plane-adoption-2026-08-02, P-006).
 *
 * WHY THE OLD METRIC HAD TO GO. Phase 1 measured "plane share of pipeline reads" —
 * `state:read + state:subscribe` over `state:* + the doors`. That ratio **cannot reach
 * 100% by construction**, which makes it useless as a target and actively misleading as
 * a verdict. CLAUDE.md prescribes the DOOR (`dev:pipeline_position`) as the FIRST read
 * and the PLANE as (a) the re-read before you ACT ON or QUOTE a value and (b)
 * subscribe-instead-of-poll. An agent following that guidance PERFECTLY still emits door
 * calls, so correct behaviour scores as a miss and the metric asymptotes below 100% no
 * matter how good adoption gets. A target nobody can hit does not measure adoption; it
 * measures the shape of the ratio.
 *
 * WHAT REPLACES IT — two OPPORTUNITY ratios, both of which CAN reach 100%:
 *
 *   A. ACT/QUOTE — of the moments where an agent held a pipeline value and then wrote it
 *      somewhere durable, how many re-read the plane first?
 *   B. WAIT      — of the moments where an agent POLLED a door in a loop, how many used
 *      `state:subscribe` instead?
 *
 * The denominator is the set of moments where the behaviour was CALLED FOR, not the set
 * of all reads. This is the `code-run-adoption.ts` shape (opportunity-spawns ÷
 * spawns-that-adopted), chosen deliberately because it is the one adoption metric in this
 * repo that has already survived contact with a real audit — and its thresholds are
 * IMPORTED from the mechanism they describe rather than restated, so metric and mechanism
 * cannot drift. Same discipline here: {@link clusterTurns}/{@link TURN_GAP_MS} come from
 * code-run-batch-nudge, so "what counts as a separate round-trip" has ONE definition in
 * this repo.
 *
 * ⚠ WHY THIS IS NOT FOLDED INTO `enforcement-tier-census.ts`. That census is a CALL-COUNT
 * read over `coord:%` verbs (`{ calls, callers }` per behaviour) and answers "did anyone
 * reach for this verb at all". This is an OPPORTUNITY-RATIO read and answers "of the
 * moments that called for it, how many took it". Bolting an opportunity denominator onto
 * a call-count census would give one type two incompatible meanings of "adoption", which
 * is the exact confusion D-003 exists to prevent. They are siblings, not one thing.
 *
 * D-003 — EVERY ratio here names its denominator, and a ratio with a ZERO denominator is
 * `null`, NEVER 0. This is not pedantry: measured 2026-08-08, the fleet went from 12,842
 * agent tool calls/day (08-03) to 12/day (08-05), so every post-08-04 window has a
 * near-empty denominator. Reporting those as "0% adoption" would have read as a
 * regression when the real finding is "no fleet ran". `rate === null` forces that
 * distinction into the type instead of leaving it to a careful reader.
 *
 * ⚠⚠ GROUPING IS BY AGENT + TIME PROXIMITY, **NEVER BY `spawn_id`** — and this cost a
 * near-shipped wrong number. The obvious way to scope "the agent held a value and then
 * wrote it" is to partition by `spawn_id`, the way `code-run-adoption.ts` legitimately
 * does. On THIS table that silently returns almost nothing. Measured 2026-08-08 over 7d,
 * workspace papercusp-workspace: **579,425 calls across 550,546 distinct `spawn_id`s —
 * 543,974 of 550,683 (98.8%) are SINGLETONS, mean 1.1 calls per spawn.** So a
 * spawn-partitioned window almost never contains two calls, and every cross-call metric
 * built on it reports ~0 while looking perfectly well-formed. The first run of exactly
 * that query returned **4 opportunities against 496 door calls and 133 agents**, which
 * reads as damning adoption evidence and is in fact a grouping bug.
 *
 * `code-run-adoption` is not wrong to use spawns — it measures nursery-cup spawns, which
 * really are sessions. Interactive/su sessions take a fresh `spawn_id` per call. The
 * transferable rule: a grouping key is only a session boundary if you have MEASURED its
 * cardinality on the table you are querying. `PlaneCallRow` therefore carries NO spawn
 * field, so re-introducing that grouping requires deliberately adding one back.
 *
 * D-008 — the FOUR exclusions are baked into the SQL, not left to the caller (P-001's
 * lesson from EI-19300252001829260: a denominator a caller has to remember to filter is a
 * denominator that will eventually be wrong). Excluded: NULL principals, `system:%`
 * principals, loopback, and specifically the plane's OWN machinery
 * (`system:predicate-watch:`, `system:cell-read:`) — one `state:subscribe` replacing a
 * poll loop emits N door calls under a system principal, i.e. the plane's OUTPUT would
 * otherwise be scored as evidence AGAINST it.
 */
import { TURN_GAP_MS, clusterTurns } from '../code-run-batch-nudge';

/** The DOORS: tools that return a pipeline value an agent may then act on or quote. */
export const DOOR_TOOLS: readonly string[] = Object.freeze([
  'dev:pipeline_position',
  'release:checkpoint-run',
]);

/** The PLANE: the re-read surface. */
export const PLANE_READ_TOOLS: readonly string[] = Object.freeze(['state:read']);

/** The PLANE's push surface — the subscribe-instead-of-poll half. */
export const PLANE_SUBSCRIBE_TOOLS: readonly string[] = Object.freeze(['state:subscribe']);

/**
 * The QUOTE SINKS: durable writes where a stale pipeline value becomes a confidently
 * wrong report an hour later. This list is the operative content of CLAUDE.md's "About to
 * ACT on one of these values — or quote it into a message, a plan, or a work-item?
 * RE-READ it, don't copy it", enumerated so the metric measures exactly what the guidance
 * asks for.
 */
export const QUOTE_SINK_TOOLS: readonly string[] = Object.freeze([
  'coord:send',
  'coord:escalate',
  'plans:set-now',
  'plans:add-decision',
  'work_items:comment',
  'work_items:checkpoint',
  'work_items:complete',
  'facts:assert',
]);

/**
 * How long a door value stays "in hand". Past this the agent is plausibly writing about
 * something else entirely, and counting it would inflate the denominator with moments
 * that never called for a re-read.
 */
export const ACT_WINDOW_MS = 10 * 60_000;

/**
 * A door call repeated at least this many times, across at least this many separate
 * inference TURNS, is a poll loop. Turns (not raw calls) for the code-run-adoption
 * reason: several calls dispatched from ONE inference turn cost a single round-trip and
 * are not a poll loop — they are one batched read.
 */
export const POLL_TURN_THRESHOLD = 3;

/** Window over which repeated door calls are read as ONE poll loop rather than separate steps. */
export const POLL_WINDOW_MS = 30 * 60_000;

/** One `tool_invocations` row, narrowed to what the metric needs. */
export interface PlaneCallRow {
  /** The GROUPING KEY. Deliberately the agent, not a spawn — see the header measurement. */
  readonly ownerId: string;
  readonly toolName: string;
  readonly atMs: number;
}

export type PlaneMomentKind = 'act-quote' | 'wait';

export interface MomentRollup {
  readonly kind: PlaneMomentKind;
  /** Moments where the behaviour was CALLED FOR. The denominator, named. */
  readonly opportunities: number;
  /** Of those, the moments that took it. */
  readonly adopted: number;
  /**
   * adopted ÷ opportunities, or **null when there were no opportunities**. Never 0 for an
   * empty denominator — see the D-003 note in the file header.
   */
  readonly rate: number | null;
  /** Plain-language denominator, carried WITH the number so it cannot be quoted alone. */
  readonly denominator: string;
  /** Distinct agents that had at least one opportunity of this kind. */
  readonly agentsWithOpportunity: number;
  /** Distinct agents that adopted at least once. The BREADTH axis, which Phase 1 found weak. */
  readonly agentsAdopting: number;
}

export interface StatePlaneAdoption {
  readonly windowDays: number;
  readonly actQuote: MomentRollup;
  readonly wait: MomentRollup;
  /**
   * TRUE when BOTH denominators are empty — i.e. this window cannot support any adoption
   * verdict at all. Hoisted to the result (D-039's discipline) so a caller who never reads
   * a per-rollup `rate: null` still cannot report an idle window as a regression.
   */
  readonly unmeasurable: boolean;
}

function rollup(
  kind: PlaneMomentKind,
  denominator: string,
  moments: readonly { readonly ownerId: string; readonly adopted: boolean }[],
): MomentRollup {
  const withOpportunity = new Set<string>();
  const adopting = new Set<string>();
  let adopted = 0;
  for (const m of moments) {
    withOpportunity.add(m.ownerId);
    if (m.adopted) {
      adopted++;
      adopting.add(m.ownerId);
    }
  }
  return {
    kind,
    opportunities: moments.length,
    adopted,
    rate: moments.length === 0 ? null : adopted / moments.length,
    denominator,
    agentsWithOpportunity: withOpportunity.size,
    agentsAdopting: adopting.size,
  };
}

/**
 * Partition by AGENT, then let the time windows do the scoping. See the header: the
 * session-shaped key (`spawn_id`) is per-CALL on this table and produces a silent ~0.
 */
function byAgent(rows: readonly PlaneCallRow[]): Map<string, PlaneCallRow[]> {
  const out = new Map<string, PlaneCallRow[]>();
  for (const r of rows) {
    const list = out.get(r.ownerId);
    if (list) list.push(r);
    else out.set(r.ownerId, [r]);
  }
  for (const list of out.values()) list.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/**
 * METRIC A. An OPPORTUNITY is a durable write that follows a door read within
 * {@link ACT_WINDOW_MS} in the same spawn — the agent held a pipeline value and then
 * committed something. It is ADOPTED when a plane read falls between that door read and
 * the write.
 *
 * Note the ordering requirement is real, not decorative: a `state:read` BEFORE the door
 * call does not re-read anything, and counting it would let a metric that is supposed to
 * measure "re-read before you quote" be satisfied by reading in the wrong order.
 */
export function computeActQuoteMoments(
  rows: readonly PlaneCallRow[],
): { ownerId: string; adopted: boolean }[] {
  const moments: { ownerId: string; adopted: boolean }[] = [];
  for (const calls of byAgent(rows).values()) {
    for (let i = 0; i < calls.length; i++) {
      const write = calls[i];
      if (!QUOTE_SINK_TOOLS.includes(write.toolName)) continue;

      // The most recent door read still in hand.
      let doorAt: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (write.atMs - calls[j].atMs > ACT_WINDOW_MS) break;
        if (DOOR_TOOLS.includes(calls[j].toolName)) {
          doorAt = calls[j].atMs;
          break;
        }
      }
      if (doorAt === null) continue; // No value in hand — this write never called for a re-read.

      let adopted = false;
      for (let j = i - 1; j >= 0; j--) {
        if (calls[j].atMs < doorAt) break;
        if (PLANE_READ_TOOLS.includes(calls[j].toolName)) {
          adopted = true;
          break;
        }
      }
      moments.push({ ownerId: write.ownerId, adopted });
    }
  }
  return moments;
}

/**
 * METRIC B. An OPPORTUNITY is a spawn that polled a door across at least
 * {@link POLL_TURN_THRESHOLD} distinct inference turns inside {@link POLL_WINDOW_MS}. It
 * is ADOPTED when that spawn also used `state:subscribe`.
 *
 * One opportunity per POLL LOOP, not per call: an agent that polled 40 times in one loop
 * made ONE wrong choice, and counting each call would let a single badly-behaved session
 * dominate a fleet-wide ratio. Loops are non-overlapping — after one is counted the scan
 * resumes past its window — so a long-lived agent with two genuinely separate waits is
 * charged twice, which is correct.
 */
export function computeWaitMoments(
  rows: readonly PlaneCallRow[],
): { ownerId: string; adopted: boolean }[] {
  const moments: { ownerId: string; adopted: boolean }[] = [];
  for (const calls of byAgent(rows).values()) {
    const doors = calls.filter((c) => DOOR_TOOLS.includes(c.toolName));
    if (doors.length < POLL_TURN_THRESHOLD) continue;

    const turnOf = clusterTurns(doors.map((d) => ({ at: d.atMs })));
    let i = 0;
    while (i < doors.length) {
      const turnsInWindow = new Set<number>();
      let end = i;
      for (let j = i; j < doors.length; j++) {
        if (doors[j].atMs - doors[i].atMs > POLL_WINDOW_MS) break;
        turnsInWindow.add(turnOf[j]);
        end = j;
      }
      if (turnsInWindow.size < POLL_TURN_THRESHOLD) {
        i++;
        continue;
      }
      const from = doors[i].atMs;
      const until = doors[end].atMs + POLL_WINDOW_MS;
      moments.push({
        ownerId: doors[i].ownerId,
        adopted: calls.some(
          (c) =>
            PLANE_SUBSCRIBE_TOOLS.includes(c.toolName) && c.atMs >= from && c.atMs <= until,
        ),
      });
      i = end + 1; // Non-overlapping: resume past this loop.
    }
  }
  return moments;
}

/** Pure roll-up over already-fetched rows. No IO, so this is unit-testable without PG. */
export function computeStatePlaneAdoption(
  rows: readonly PlaneCallRow[],
  windowDays: number,
): StatePlaneAdoption {
  const actQuote = rollup(
    'act-quote',
    `durable writes (${QUOTE_SINK_TOOLS.length} quote sinks) that followed a door read within ${ACT_WINDOW_MS / 60_000}min in the same spawn`,
    computeActQuoteMoments(rows),
  );
  const wait = rollup(
    'wait',
    `spawns that polled a door across >=${POLL_TURN_THRESHOLD} inference turns within ${POLL_WINDOW_MS / 60_000}min (turn-clustered at ${TURN_GAP_MS}ms)`,
    computeWaitMoments(rows),
  );
  return {
    windowDays,
    actQuote,
    wait,
    unmeasurable: actQuote.opportunities === 0 && wait.opportunities === 0,
  };
}

/** All tools the metric needs to see. */
export const MEASURED_TOOLS: readonly string[] = Object.freeze([
  ...DOOR_TOOLS,
  ...PLANE_READ_TOOLS,
  ...PLANE_SUBSCRIBE_TOOLS,
  ...QUOTE_SINK_TOOLS,
]);

/**
 * The canonical query. The four D-008 exclusions are IN HERE, deliberately, so no caller
 * can produce a number with the wrong denominator.
 *
 * Bounded by construction: the `tool_name = ANY(...)` filter is highly selective (a
 * handful of verbs), so this never streams the whole table. It is a deliberate NON-goal to
 * wire this into a health tick — `code-run-adoption`'s full-scan pegged the operator CPU
 * and starved the pool twice (EI-6889, EI-18754139434413158). This is an on-demand read.
 */
export const STATE_PLANE_ADOPTION_SQL = `
  SELECT coord_owner_id AS owner_id,
         tool_name,
         (extract(epoch from invoked_at) * 1000)::bigint AS at_ms
    FROM harness_shared.tool_invocations
   WHERE workspace_id = $1
     AND invoked_at >= now() - make_interval(days => $2)
     AND tool_name = ANY($3)
     AND coord_owner_id IS NOT NULL
     AND coord_owner_id NOT LIKE 'system:%'
     AND coord_owner_id NOT LIKE 'loopback%'
   ORDER BY coord_owner_id, invoked_at
`;

/** Injectable query runner (the load-token-rollups.ts / code-run-adoption.ts precedent). */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/** IO seam. Kept separate from the pure builder so the metric stays testable without PG. */
export async function readStatePlaneAdoption(
  runQuery: RunQuery,
  opts: { readonly workspaceId: string; readonly windowDays: number },
): Promise<StatePlaneAdoption> {
  const raw = await runQuery<{
    owner_id: string;
    tool_name: string;
    at_ms: string | number;
  }>(STATE_PLANE_ADOPTION_SQL, [opts.workspaceId, opts.windowDays, [...MEASURED_TOOLS]]);

  const rows: PlaneCallRow[] = raw.map((r) => ({
    ownerId: r.owner_id,
    toolName: r.tool_name,
    atMs: Number(r.at_ms),
  }));
  return computeStatePlaneAdoption(rows, opts.windowDays);
}
