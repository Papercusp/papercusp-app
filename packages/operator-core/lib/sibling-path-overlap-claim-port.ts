/**
 * sibling-path-overlap-claim-port — the claim-time "A SIBLING ALREADY TOUCHED YOUR
 * FILES" guard (EI-19329513980117751).
 *
 * THE CLASS THIS SURFACES: one root cause gets filed as several work-items, minutes
 * apart, by different agents who each described it differently. The 2026-08-02
 * identity-lint red produced three (WI-6878 mitigation, WI-6992 durable fix — already
 * landed, WI-6994 the SAME durable fix). An agent claimed WI-6994, implemented a
 * 159-line module, and only then read far enough to hit WI-6992's already-shipped
 * `redactProseCorpusFixture()`. git-sync had COMMITTED the duplicate before it was
 * caught, so the revert had to be a hand revert of a committed change.
 *
 * ⚠ WHY NOT SIMILARITY. The obvious build reads `harness_shared.dedup_edges`
 * (migration 944), which ALREADY persists create-time cosine sibling edges at cos>=0.85
 * and which nothing reads at claim time. Measured 2026-08-31 on this workspace, it
 * fails in both directions at once: EI-19343733961745670 and EI-19454211066351073 are
 * one real duplicate (~90% of the first was already built by the second) and have NO
 * edge between them at all — absence verified against a passing positive control —
 * while that same item carries 20+ edges at cos 0.88–0.94 to merely-topical neighbours.
 * Duplicate FRAMINGS are exactly where prose diverges; the filer put it best: "What
 * they did NOT diverge on is paths."
 *
 * ⚠⚠ BUT BARE PATH OVERLAP IS NOT EVIDENCE EITHER — RARITY IS. This is the whole
 * design, and it was measured rather than assumed. Settled work-items sharing each path:
 *
 *     scripts/lint-tsc.mjs .............................. 98
 *     .../bench/fixtures/prose-corpus.v1.json ...........  3
 *     .../bench/prose-corpus-snapshot.ts ................  2
 *     scripts/lib/identity-leak-patterns.mjs ............  2
 *
 * The real duplicate (WI-6992/WI-6994) meets on paths touched by 2–3 settled items. A
 * hub file like `scripts/lint-tsc.mjs` is shared by 98 — announcing those as "siblings"
 * would render a 5-of-97 sample as a finding, which is the exact noise failure that
 * gets a guard switched off. So a shared path only counts as evidence when FEW settled
 * items touch it (`RARE_PATH_MAX_SHARERS`), and the rarest shared path ranks first.
 *
 * ⚠ HONEST LIMIT, stated because the alternative is overselling: this guard would NOT
 * have caught the EI-19343733961745670 pair above. Their only shared path is the
 * 98-sharer hub file, so nothing distinguishes that pair from 97 unrelated items —
 * and cosine missed it too. On a hub file, overlap genuinely is not evidence, and
 * saying so is better than emitting a list that looks like one.
 *
 * ⚠ THE LOOKBACK MUST INCLUDE SETTLED ITEMS, NOT JUST LIVE CLAIMS. In every measured
 * instance the wasted work duplicated a sibling that was ALREADY DONE, so a live-claims
 * check would have missed all of them. Settled siblings rank ahead of in-flight ones:
 * an in-flight peer is a coordination problem, but a settled sibling means the code may
 * already be in the tree.
 *
 * ⚠ IMPLEMENTED, NOT MERELY SETTLED. `SETTLED_WORK_ITEM_STATES` includes the DISCARD
 * states (dropped/closed/deprecated), which mean the work was explicitly NOT done —
 * announcing one as "already implemented" would send an agent to read a decision to
 * skip the work as though it were the work. The implemented set is derived by
 * SUBTRACTION from that shared list rather than hand-listed, so a settled state added
 * upstream lands in the warned set by default: over-warning is recoverable (this is
 * advisory), silence is the defect this module exists to stop.
 *
 * ⚠ `lane='observation'` IS EXCLUDED. `harness_shared.work_items` also stores agents'
 * end-of-turn notes; they are ~92% of the naive population here and are not work
 * anybody could duplicate.
 *
 * Fail-soft by design, mirroring every sibling port: a claim must never fail because an
 * advisory lookup did, and a swallowed read must never render as "the guard passed"
 * (the WI-6737 lesson).
 */
import { getOrgPg } from '@papercusp/db-org';
import { pathsOfPayload } from './stale-path-hints-claim-port';

/** How many siblings the warning NAMES. The true total is reported separately. */
export const MAX_SIBLINGS = 5;

/**
 * A shared path counts as evidence only when at most this many settled work-items
 * touch it. Set from the measurement in the module note: the real duplicate pair meets
 * at 2–3 sharers, the hub file that generates pure noise sits at 98. Anything in that
 * gap is a judgement call; this end of it keeps the guard quiet rather than chatty,
 * because a noisy advisory is one that gets ignored.
 */
export const RARE_PATH_MAX_SHARERS = 12;

/**
 * Terminal states that mean the work was DISCARDED rather than performed. Subtracted
 * from `SETTLED_WORK_ITEM_STATES` to derive the implemented set — see the module note
 * on why this is a subtraction and not a second hand-maintained list.
 */
export const DISCARDED_WORK_ITEM_STATES: readonly string[] = ['dropped', 'closed', 'deprecated'];

/** The settled states that mean the work actually LANDED. */
export function implementedWorkItemStates(settled: readonly string[]): string[] {
  return settled.filter((s) => !DISCARDED_WORK_ITEM_STATES.includes(s));
}

export interface PathOverlapSibling {
  workItemId: string;
  title: string;
  state: string;
  /** Held by an agent right now (a coordination collision rather than a done-already). */
  inFlight: boolean;
  /**
   * The peer holding this sibling RIGHT NOW — null unless `inFlight`. Carried through
   * so the warning can NAME them: the detection already knew a peer held the item (it
   * is what `inFlight` is derived from) and threw the identity away, which left
   * "coordinate before editing" as advice the reader could not act on without a second
   * lookup. See `siblingCoordinationOffers`.
   */
  holder: string | null;
  /** The RARE shared paths — the evidence, not a similarity score. */
  sharedPaths: string[];
  /** Settled items touching this sibling's rarest shared path. Lower is stronger. */
  rarestSharedPathSharers: number;
}

/**
 * A ready-to-send coordination message to the peer holding an overlapping item
 * (lateral-fleet-coordination-2026-09-02 P-003 / D-005).
 *
 * ⚠ AN OFFER, NEVER A SEND. Nothing here dispatches anything: the claiming agent still
 * decides whether the overlap is real. That distinction is the whole reason this clears
 * D-001, which ruled that low fleet-wide message volume is DELIBERATE — member context
 * budget is the constraint — and that new lateral traffic is defensible only where a
 * specific message prevents more context cost than it creates. An automatic send would
 * spend that budget without judgement; a prepared handle costs only the bytes of a
 * warning that already renders.
 *
 * Shape follows the repo's established "copy the handle, not the number" pattern
 * (`dev:pipeline_position`'s `plane` block): the structured call travels as DATA on the
 * result, and the rendered warning carries only the holder's id plus a pointer to it, so
 * naming the peer does not cost a paragraph of JSON in every claim.
 */
export interface SiblingCoordinationOffer {
  /** The peer to message — the agent holding the overlapping item. */
  holder: string;
  /** The in-flight sibling they hold. */
  workItemId: string;
  /** The rare shared paths that triggered the offer — the reason to send. */
  sharedPaths: string[];
  /** A ready-to-paste `coord:send` call. */
  send: {
    tool: 'coord:send';
    args: Record<string, unknown>;
  };
}

export interface ClaimTimeSiblingPathOverlapHint {
  /** The claimed item's own stored paths, as filed. */
  claimedPaths: string[];
  /** The subset of those that are rare enough to carry evidence. */
  ratedPaths: string[];
  /** Named siblings, strongest first. Capped at MAX_SIBLINGS. */
  siblings: PathOverlapSibling[];
  /**
   * Prepared (never sent) coordination messages, one per named in-flight sibling whose
   * holder is known. Empty when nothing is in flight — which is the common case, and is
   * why this cannot become a source of ambient traffic.
   */
  coordinationOffers: SiblingCoordinationOffer[];
  /**
   * How many siblings MATCHED in total, before the cap. Reported separately from
   * `siblings.length` so a capped list can never be read as the whole population —
   * the repo's bounded-measurement rule (a count computed over a capped fetch must
   * say so ON the aggregate).
   */
  totalMatched: number;
  implementedCount: number;
  inFlightCount: number;
}

interface SiblingRow {
  feature_id: string | null;
  title: string | null;
  status: string | null;
  in_flight: boolean | null;
  taken_by: string | null;
  shared_paths: string[] | null;
  rarest: number | string | null;
  total_matched: number | string | null;
}

/**
 * Work-items sharing at least one RARE `payload.paths` entry with the claimed item,
 * that either already landed or are held by a peer right now. Null when the subject
 * carries no usable paths, when no shared path is rare enough to be evidence, or when
 * the read failed — all three are silence, because saying nothing asserts nothing.
 */
export async function getClaimTimeSiblingPathOverlap(ref: {
  workItemId: string;
  workItem?: { payload?: unknown } | null;
  payload?: unknown;
  harness?: string | null;
  workspaceId?: string | null;
}): Promise<ClaimTimeSiblingPathOverlapHint | null> {
  if (!ref.workItemId) return null;
  const payload = ref.payload ?? ref.workItem?.payload ?? null;
  const claimedPaths = pathsOfPayload(payload);
  if (!claimedPaths) return null;

  try {
    const { sql } = getOrgPg();
    // Loaded here rather than at module scope so the pure helpers above stay
    // dependency-free and cheap to unit-test, while the settled-state vocabulary stays
    // DERIVED from work-items.ts instead of copied (the repo's derived-truth rule).
    const { SETTLED_WORK_ITEM_STATES } = await import('./work-items');
    const settled = SETTLED_WORK_ITEM_STATES as string[];
    const implemented = implementedWorkItemStates(settled);

    const rows = await sql<SiblingRow[]>`
      WITH scoped AS (
        SELECT feature_id, title, status, taken_by, closed_ts, updated_ts, payload
          FROM harness_shared.work_items
         WHERE lane IS DISTINCT FROM 'observation'
           -- jsonb_array_elements_text errors on a non-array, so gate before unnesting.
           AND jsonb_typeof(payload->'paths') = 'array'
           ${ref.workspaceId ? sql`AND workspace_id = ${ref.workspaceId}` : sql``}
           ${ref.harness ? sql`AND harness_slug = ${ref.harness}` : sql``}
      ),
      -- How many SETTLED items touch each of the claimed item's paths. This is the
      -- rarity measure the whole guard turns on; see the module note's table.
      path_pop AS (
        SELECT p.path, count(*) AS sharers
          FROM scoped s, jsonb_array_elements_text(s.payload->'paths') AS p(path)
         WHERE s.status = ANY(${implemented})
           AND p.path = ANY(${claimedPaths})
         GROUP BY p.path
      ),
      rare AS (
        SELECT path, sharers FROM path_pop WHERE sharers <= ${RARE_PATH_MAX_SHARERS}
      ),
      cand AS (
        SELECT s.feature_id,
               s.title,
               s.status,
               (s.taken_by IS NOT NULL AND s.status <> ALL(${settled})) AS in_flight,
               -- The HOLDER, returned rather than only tested. The in_flight flag above
               -- is derived from this exact column, so the identity was already read and
               -- then discarded; carrying it out is what lets the warning name a peer
               -- instead of telling the reader to go find one (P-003).
               s.taken_by,
               s.closed_ts,
               s.updated_ts,
               ARRAY(
                 SELECT p.path
                   FROM jsonb_array_elements_text(s.payload->'paths') AS p(path)
                   JOIN rare r ON r.path = p.path
               ) AS shared_paths,
               (
                 SELECT min(r.sharers)
                   FROM jsonb_array_elements_text(s.payload->'paths') AS p(path)
                   JOIN rare r ON r.path = p.path
               ) AS rarest
          FROM scoped s
         WHERE s.feature_id IS DISTINCT FROM ${ref.workItemId}
           AND (s.status = ANY(${implemented})
                OR (s.taken_by IS NOT NULL AND s.status <> ALL(${settled})))
           AND EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements_text(s.payload->'paths') AS p(path)
                   JOIN rare r ON r.path = p.path
               )
      )
      SELECT feature_id, title, status, in_flight, taken_by, shared_paths, rarest,
             count(*) OVER () AS total_matched
        FROM cand
       -- Settled first (the code may already BE in the tree), then rarest shared path,
       -- then breadth of overlap, then recency.
       ORDER BY in_flight ASC,
                rarest ASC,
                cardinality(shared_paths) DESC,
                closed_ts DESC NULLS LAST,
                updated_ts DESC NULLS LAST
       LIMIT ${MAX_SIBLINGS}`;

    const siblings: PathOverlapSibling[] = rows
      .filter((r) => r.feature_id && (r.shared_paths?.length ?? 0) > 0)
      .map((r) => ({
        workItemId: String(r.feature_id),
        title: String(r.title ?? ''),
        state: String(r.status ?? '').trim().toLowerCase(),
        inFlight: r.in_flight === true,
        // Only meaningful for an in-flight sibling: a settled item's taken_by is a
        // historical assignee, not a peer to coordinate with.
        holder: r.in_flight === true && r.taken_by ? String(r.taken_by) : null,
        sharedPaths: (r.shared_paths ?? []).map(String),
        rarestSharedPathSharers: Number(r.rarest ?? 0),
      }));
    if (siblings.length === 0) return null;

    const ratedPaths = [...new Set(siblings.flatMap((s) => s.sharedPaths))];
    return {
      claimedPaths,
      ratedPaths,
      siblings,
      coordinationOffers: siblingCoordinationOffers(siblings, ref.workItemId),
      totalMatched: Number(rows[0]?.total_matched ?? siblings.length),
      implementedCount: siblings.filter((s) => !s.inFlight).length,
      inFlightCount: siblings.filter((s) => s.inFlight).length,
    };
  } catch {
    return null;
  }
}

/**
 * Build the prepared coordination sends for the in-flight siblings that name a holder
 * (P-003). Pure + exported so the offer's ADDRESSING is directly testable: the one way
 * this mechanism can be wrong independently of how often it fires is by naming the wrong
 * peer, and a rendered string cannot be asserted on precisely enough to catch that.
 *
 * Silence when nothing is in flight, and silence for an in-flight sibling with no known
 * holder — an offer addressed to nobody is worse than no offer, because it reads as a
 * coordination step already taken.
 *
 * `expects:'answer'` rather than 'action': the claiming agent is asking what the holder
 * has already covered, not assigning them work. `forYouBecause` is REQUIRED on a
 * directed send expecting an answer, and `owns` is the honest relation — they own the
 * overlapping item. `couldNotDetermine` states the gap the sender genuinely cannot close
 * from their side, which is the entire reason the message is worth its cost.
 */
export function siblingCoordinationOffers(
  siblings: readonly PathOverlapSibling[],
  workItemId: string,
): SiblingCoordinationOffer[] {
  if (!workItemId) return [];
  const offers: SiblingCoordinationOffer[] = [];
  for (const s of siblings) {
    if (!s.inFlight || !s.holder) continue;
    const paths = s.sharedPaths.join(', ');
    offers.push({
      holder: s.holder,
      workItemId: s.workItemId,
      sharedPaths: [...s.sharedPaths],
      send: {
        tool: 'coord:send',
        args: {
          to: [s.holder],
          expects: 'answer',
          summary:
            `Path overlap: you hold ${s.workItemId}, I just claimed ${workItemId} — ` +
            `we share ${paths}`,
          body: [
            {
              text:
                `I claimed ${workItemId} and the claim-time rare-path check named ${s.workItemId} ` +
                `(yours, in flight) as sharing ${paths}. Only seldom-touched paths are counted, so ` +
                `this is a filter rather than a verdict — but before I edit those file(s) I would ` +
                `rather ask than duplicate you. Have you already covered that ground, and how do ` +
                `you want to split it?`,
              forYouBecause: {
                relation: 'owns',
                ref: s.workItemId,
                note: `you hold ${s.workItemId}, which shares the rare path(s) ${paths}`,
              },
              couldNotDetermine: [
                {
                  what: `whether your in-flight work on ${s.workItemId} already covers ${paths}`,
                  note: 'path overlap shows the collision, not who has done what',
                },
              ],
            },
          ],
        },
      },
    });
  }
  return offers;
}

/**
 * Render the hint as the line an agent reads at claim time. Pure + exported so the
 * guarantee is directly testable and a future edit cannot silently weaken it — the
 * shape `planItemLandedWarning` and `priorWorkWarning` chose, for the same reason.
 *
 * Names the SHARED PATHS and how rare each is, because that pair is both the evidence
 * and the next action: the rare shared file is exactly what to open before the first
 * edit. States the true total whenever the list is capped — a capped list rendered as
 * a complete one is the failure mode this repo names explicitly.
 */
export function siblingPathOverlapWarning(
  hint: ClaimTimeSiblingPathOverlapHint | null,
  workItemId: string,
): string | null {
  if (!hint || hint.siblings.length === 0) return null;
  const list = hint.siblings
    .map(
      (s) =>
        `${s.workItemId} (${s.inFlight ? 'IN FLIGHT' : s.state}, shares ${s.sharedPaths.join(', ')}` +
        ` — touched by only ${s.rarestSharedPathSharers} settled item(s))`,
    )
    .join('; ');
  const capped =
    hint.totalMatched > hint.siblings.length
      ? ` (${hint.siblings.length} of ${hint.totalMatched} shown, strongest first)`
      : '';
  const landed =
    hint.implementedCount > 0
      ? `${hint.implementedCount} of them ALREADY LANDED, so the code may already be in the tree. `
      : '';
  // P-003 / D-005: name the holder inline, and keep the prepared call itself on the
  // structured result rather than inlining its JSON here — the warning is read on every
  // qualifying claim, so it pays for the id and a pointer, not for a payload.
  // Array-checked rather than assumed: the hint crosses an `unknown`-typed enrichment
  // boundary, so an older serialized shape must degrade to the pre-P-003 sentence
  // instead of throwing inside a warning renderer.
  const offers = Array.isArray(hint.coordinationOffers) ? hint.coordinationOffers : [];
  const inFlight =
    hint.inFlightCount > 0
      ? `${hint.inFlightCount} is held by a peer RIGHT NOW — coordinate before editing` +
        (offers.length > 0
          ? `: ${offers.map((o) => `${o.holder} holds ${o.workItemId}`).join('; ')}. ` +
            `A ready coord:send to each is already built on ` +
            `siblingPathOverlap.coordinationOffers[].send — copy the handle instead of ` +
            `looking the holder up. NOTHING WAS SENT; asking is your call. `
          : '. ')
      : '';
  return (
    `⚠ SIBLING ITEMS TOUCH YOUR RARE PATHS: ${hint.totalMatched} other work-item(s) share ` +
    `a seldom-touched stored path with ${workItemId}${capped}: ${list}. ${landed}${inFlight}` +
    `One root cause is routinely filed several times in minutes by different agents, and those ` +
    `framings diverge in PROSE while agreeing on PATHS — which is why this is a path check and ` +
    `not a similarity score (EI-19329513980117751: a 159-line duplicate was written and ` +
    `COMMITTED before the already-shipped original was noticed). Only rarely-touched paths are ` +
    `counted, so this is evidence rather than a hub-file coincidence — but it is a FILTER, not ` +
    `a verdict. Before writing ANYTHING: open the shared file(s) and read the settled sibling's ` +
    `completion evidence. If the work already landed, close ${workItemId} as a duplicate with ` +
    `that evidence instead of re-implementing; if it genuinely did not, say so in a comment and ` +
    `proceed. [EI-19329513980117751]`
  );
}
