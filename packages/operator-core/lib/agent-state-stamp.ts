/**
 * agent-state-stamp.ts — the per-owner in-process cache behind P-009's
 * `tool_invocations` stamp (unified-agent-state-plane-2026-07-27).
 *
 * WHAT THIS IS. A `Map<ownerId, AgentStateStamp>` holding a POINTER to each of
 * the three declarations D-011 unified: the agent's current intent, its
 * assumption watermark, and its goal ref. `readAgentStateStamp` is one Map.get
 * on the dispatcher's hot path; everything else is written a few times per task
 * by acts the agent already performs.
 *
 * WHY A CACHE AND NOT A QUERY (D-014). `tool_invocations` takes ~238,866 rows a
 * day. D-014 is explicit that nothing here is calculated, inferred or
 * recomputed: "the agent writes each declaration ONCE, via an act it already
 * performs; the dispatcher COPIES A POINTER to the most recent one." So the
 * read must be a hashmap get with no I/O, and **a miss writes NULL rather than
 * blocking the call** — telemetry is best-effort and must never be able to fail
 * a tool call.
 *
 * WHY `assumptionSetId` IS A WATERMARK, NOT A SET. There is no assumption-set
 * table, and one bigint cannot enumerate a set — but it can BOUND one. P-008(a)
 * made `agent_facts` append-versioned: every version is its own immutable row
 * with a monotonic `id`, and a correction appends rather than mutating. That is
 * exactly what makes a single id a valid set identifier: the set is
 *
 *     every non-retracted, non-superseded kind='assumption' fact of this owner
 *     whose id <= assumption_set_id
 *
 * i.e. "the assumption state as of this point". Resolving it is P-024's job and
 * happens only on a filtered read (never eagerly per row — that would be an N+1
 * over `agent_facts`). Against the pre-P-008 in-place-mutated table this pointer
 * would have silently named different content than it did when stamped, which is
 * the D-003 violation P-008(a) existed to fix.
 *
 * ⚠ `assumptionSetId`'s PRODUCER IS MEASURED EMPTY. On 2026-07-27, 0 of 2,088
 * `agent_facts` rows carried kind='assumption', so this field is expected to be
 * null on every call until assumptions are actually written (P-012 is the item
 * that starts writing them). `intentEventId`'s producer is live by contrast
 * (12,331 events / 2,363 writers / 529 in 24h). This is disclosed rather than
 * hidden because a column that is structurally always-NULL and a column that is
 * NULL because nobody declared anything are different facts, and only the
 * measurement tells them apart — see P-015.
 *
 * ⚠ THIS IS A RETROSPECTIVE STAMP, NOT A CURRENT-STATE SURFACE (D-051). Nothing
 * that wants to know what an agent is assuming RIGHT NOW may read this or the
 * columns it feeds — that is re-derivation from the wrong datum. Live readers
 * project P-016's goal cell. This exists to answer "what was true when this call
 * was made", which only a per-call stamp can answer.
 *
 * ⚠ ONE REF VOCABULARY, SHARED WITH THE CELL. `goalRef` is guarded by P-016's
 * `asGoalRef`, the same rule the `agent.goal` cell applies, so the stamp can
 * never hold a ref shape a live reader would reject. Without that the two could
 * disagree about what a usable goal ref even IS — and the stamped one is the copy
 * nobody re-checks, so it is the one that would rot unnoticed. This is a shared
 * RULE, not a shared source: the stamp records a claim as it happens, while the
 * cell resolves precedence across every leg at read time.
 *
 * ── ⚠ THE MAP IS PER-PROCESS, AND THE OPERATOR IS A CLUSTER (WI-6594) ────────
 *
 * This module's `Map` is module-scoped, so it holds ONE PROCESS'S view. The
 * operator runs `node:cluster` with `PAPERCUSP_CLUSTER=16` (17 processes,
 * SO_REUSEPORT), and the three producers are separate tool calls: an agent's
 * `coord:declare-intent` and its `work_items:claim` land on whichever workers the
 * kernel picked. So worker A learns the intent, worker B learns the goal, and
 * NEITHER can stamp both — the call is stamped with half the agent's declared
 * state and a NULL that is simply false.
 *
 * That is not hypothetical. Measured live on 2026-07-28: calls carrying BOTH
 * stamps fell 1217 -> 39 while each stamp ALONE stayed healthy, five different
 * "most recent intent" values were live simultaneously for one owner, and two
 * calls by that owner 11ms apart carried (intent, no goal) and (no intent, goal)
 * respectively while it demonstrably held WI-6502. It red the fleet gate via
 * `lint:plane-ratchet`, which correctly judged the stamped divergence leg
 * `regressed`.
 *
 * It appeared to work for weeks only because SO_REUSEPORT balances per
 * CONNECTION: an agent on one long-lived MCP connection got accidental worker
 * affinity, so both its declarations happened to land in the same process. The
 * fleet's shift toward ephemeral one-shot connections removed that accident. The
 * stamp was never cluster-correct — it was coincidentally coherent.
 *
 * THE FIX (see `agent-state-stamp-cluster.ts`): every LOCAL declaration is
 * published to a replicator, relayed by the primary, and applied into every other
 * worker's map. The hot-path READ is untouched — still one `Map.get`, no I/O, per
 * D-014 — because only the rare WRITES fan out. With no replicator installed
 * (single-process host, tests) behaviour is byte-identical to before.
 *
 * ── ⚠ REPLICATION DOES NOT SURVIVE A RESTART, AND `goalRef` DID NOT (WI-6595) ──
 *
 * Replication makes the ring COHERENT; it does not make it DURABLE. A deploy
 * restarts every worker at once, so the whole ring's map is empty simultaneously
 * and there is no peer left holding the value to relay. The two stamps then
 * recover ASYMMETRICALLY:
 *   · `intentEventId` HAD no durable source and was NOT re-hydrated — WI-6637 gave
 *     it one; the measurement below is what that fix was built from. An
 *     earlier revision of this note claimed it "self-heals within minutes —
 *     every `coord:orient` / `coord:declare-intent` rewrites it, and agents wake
 *     constantly", and used that to justify fixing only the goal half. ⚠ THAT IS
 *     FALSE — do not restore it. Measured across the 2026-07-28T09:41:42Z restart:
 *     361 calls by 5 owners in the following 4.5 minutes carried `intentEventId`
 *     on EXACTLY ZERO of them, while re-hydrated `goalRef` reached ~78%. The
 *     premise fails because the traffic that dominates a post-restart window is
 *     monitor-loop work — `activity:report` (199), `coord:glance` (106),
 *     `locks:*` (69) — and NOT ONE `coord:orient` / `declare-intent` / claim call
 *     occurred in it. A long-running loop session re-declares on bootstrap, not on
 *     every wake, so "agents wake constantly" does not imply they re-declare.
 *     CONSEQUENCE: re-hydrating `goalRef` alone does NOT restore `both stamps on
 *     one row` for an owner that has not re-declared, because the OTHER column is
 *     null. `scheduleIntentRehydration` closes that half by pointing at the same
 *     append-only `coord_event_log` line the live declare path stamps — NOT at
 *     `coord_presence`, which is mutated in place (see `agent-intent-sources.ts`).
 *     ⚠ It does NOT follow that the ratchet was ever starved by this: `comparable`
 *     is computed over WINDOWS, and a window containing any declaring owner is
 *     judgeable. Measured 09:56Z after a restart, `both_stamps` was 66-68 (not 0)
 *     and `lint:plane-ratchet` exited 0 with the leg `holding`. The defect is real
 *     — the gate-red framing this item was filed under was not.
 *   · `goalRef` did NOT recover either, before this fix. `noteGoalClaimed` fires only when work is CLAIMED or
 *     RELEASED, so an agent that claimed WI-X an hour before the deploy and is
 *     still working it never writes the goal again — it stays null for the whole
 *     rest of that claim.
 *
 * Measured live on 2026-07-28: rows carrying BOTH stamps went 587/hr -> 0/hr
 * across the 02:00Z deploy while each stamp ALONE stayed healthy (265 intent-only
 * + 237 goal-only in the 07:00Z hour). The divergence metric needs both columns on
 * ONE row, so `comparable` fell to zero every window and `lint:plane-ratchet`
 * correctly judged the leg `regressed`, redding the fleet gate. Deploys run every
 * ~15min-1h here, so this destroyed goal attribution routinely and then stayed
 * destroyed.
 *
 * ⚠ AN EARLIER REVISION OF THIS NOTE CLAIMED THE PER-OWNER EVIDENCE "rules out a
 * cluster split (those were the same processes)". THAT INFERENCE WAS WRONG — do not
 * restore it. Re-measured at 08:50Z under `PAPERCUSP_CLUSTER=16`, the steady state
 * between restarts is positive evidence FOR a split: one owner logged 153
 * intent-stamped and 82 goal-stamped calls out of 1,559, with an overlap of exactly
 * ZERO, the two classes fully interleaved in time and spread across both transports.
 * Independent stamps present on ~6% of calls each (≈1/16, the round-robin share)
 * that NEVER coincide is what a per-worker map looks like; a restart-wipe alone
 * would have shown `goalRef` absent, not present-but-disjoint. Exactly one owner
 * co-stamped at all — the case where both writes happened to land on the same
 * worker. "Same session" was never "same process": a session's calls are sprayed
 * across all 16.
 *
 * So there are TWO defects, and this module fixes one of them:
 *   · DURABILITY (this file, WI-6595) — a restart empties the ring.
 *   · COHERENCE (WI-6594, still open) — the ring diverges between restarts.
 * The re-hydration below happens to address BOTH for `goalRef`, because every
 * worker independently re-derives the same durable value instead of waiting to be
 * told: the ring converges even when replication is not delivering. WI-6637 gives
 * `intentEventId` the same property for the same reason — each worker resolves the
 * pointer itself rather than waiting for a relay — so the fix below addresses BOTH
 * defects for BOTH columns.
 *
 * THE FIX: on a read that finds NO goal, schedule a fire-and-forget re-hydration
 * from the DURABLE source — `resolveOwnerGoal`, the same four-leg resolver behind
 * P-016's goal cell, which derives the goal from claims that live in Postgres and
 * therefore outlive any process. The hot-path read is still one `Map.get` that
 * never blocks and never does I/O (D-014): the fill lands in the map for the NEXT
 * call, and this call still stamps the null it honestly had.
 *
 * Two properties worth stating because they are what make it safe:
 *   · IT CANNOT RESURRECT A RELEASED GOAL. The durable resolver reads what the
 *     agent HOLDS, so an agent that put the work down hydrates to null as well.
 *     The read-vs-release RACE is handled by stamping the fill with the timestamp
 *     the read STARTED, so `upsert`'s existing drop-if-older rule discards a fill
 *     that a release overtook.
 *   · IT ALSO FIXES A GAP NOBODY HAD FILED. `noteGoalClaimed` is only ever called
 *     from the work-item claim/release path, so an agent whose goal comes from a
 *     PLAN-ITEM claim, a fleet mission, or an author override never stamped one at
 *     all. The durable resolver covers all four legs, so those agents now stamp a
 *     goal for the first time.
 */

import { asGoalRef } from './agent-goal-ref';

/** The three declaration pointers stamped onto one tool call. */
export interface AgentStateStamp {
  /** `coord_event_log.id` of the owner's most recent intent declaration. */
  intentEventId: number | null;
  /** Watermark over `agent_facts.id` — see the module note. */
  assumptionSetId: number | null;
  /** Resolved goal ref, e.g. `WI-6393` or `plan:some-slug#P-009`. */
  goalRef: string | null;
}

const EMPTY_STAMP: AgentStateStamp = Object.freeze({
  intentEventId: null,
  assumptionSetId: null,
  goalRef: null,
});

/**
 * Bound on distinct owners held in memory. The live fleet is ~2,363 distinct
 * intent writers over 8 weeks but only a few dozen are ever concurrent, so this
 * is generous; it exists so a long-lived operator process cannot accumulate one
 * entry per agent that has ever run. Eviction is oldest-touched-first.
 */
const MAX_OWNERS = 512;

/**
 * Values are the EXACT `AgentStateStamp` handed to readers — no internal
 * bookkeeping field rides along. Recency is carried by the Map's own insertion
 * order (every write below deletes and re-inserts), so no touch counter is
 * needed; adding one would only leak into the public read.
 */
const stamps = new Map<string, AgentStateStamp>();

/**
 * When each owner's `goalRef` was last written, by the ORIGIN process's clock.
 *
 * Kept in a side map rather than on the stamp because `stamps`' values are the
 * exact object handed to readers — see that Map's note. Only `goalRef` needs it:
 * `intentEventId` and `assumptionSetId` are PG sequence ids and therefore carry
 * their own order, but a goal legitimately goes ref -> null -> ref, so nothing in
 * the VALUE says which of two writes is newer. Every process on this host shares
 * a clock, so comparing origin timestamps across workers is sound.
 */
const goalWrittenAt = new Map<string, number>();

/**
 * Owner -> the earliest ms at which another durable goal re-hydration may start
 * (WI-6595).
 *
 * ONE map serving two jobs, which is why it is a deadline and not a boolean:
 *   · IN-FLIGHT GUARD. The deadline is written BEFORE the async read begins, so a
 *     burst of calls for the same owner schedules exactly one query set, not one
 *     per call. `tool_invocations` takes ~238,866 rows a day; anything weaker here
 *     turns a cache miss into a stampede.
 *   · RETRY BACKOFF. A miss right after a restart is EXPECTED to fail sometimes —
 *     `resolveOwnerGoal` returns null when the PG fast path is not up yet, which
 *     on a fresh boot is precisely when the first calls arrive. A permanent
 *     "already asked" mark would make that transient null stick for the life of
 *     the process, so the attempt lapses instead and the next call retries.
 */
const goalHydrateAfter = new Map<string, number>();

/**
 * Backoff between re-hydration attempts for one owner. Sized against the failure
 * it exists to absorb: a boot-time PG gap is seconds, and an agent that genuinely
 * holds nothing should not re-query more than once a minute however hot it is.
 */
const GOAL_HYDRATE_COOLDOWN_MS = 60_000;

/** Resolves an owner's goal ref from DURABLE state. Returns null for "holds nothing". */
export type AgentGoalRehydrator = (ownerId: string) => Promise<string | null>;

/**
 * The durable read, loaded lazily.
 *
 * ⚠ DYNAMIC `import()` ON PURPOSE, AND IT IS LOAD-BEARING TWICE OVER.
 *   · CYCLE. This is a leaf module on the dispatcher's hot path;
 *     `agent-goal-sources` reaches into the coordination tree, which imports back
 *     here via `work-items.ts`. A static edge would close that loop.
 *   · INSTALLATION. WI-6594 shipped `setAgentStampPublisher` as an injectable seam
 *     and it read as dead code for a day because the wiring that installs it lives
 *     two files away. A DEFAULT that works with no wiring at all cannot be left
 *     uninstalled — the setter below is a test seam, not a prerequisite.
 * The import cost is paid once per process, off the hot path, inside the
 * fire-and-forget fill.
 */
async function defaultGoalRehydrator(ownerId: string): Promise<string | null> {
  const { resolveOwnerGoal } = await import('./agent-tools/coordination/agent-goal-sources');
  // SELF: this stamps the goal onto the calling agent's OWN tool invocation, so a
  // lapsed plan-item lease must not erase what it is working on (the stamp would
  // read `null` — "declared nothing" — for an agent 20 minutes into one item).
  return (await resolveOwnerGoal(ownerId, 'self'))?.ref ?? null;
}

let rehydrateGoal: AgentGoalRehydrator = defaultGoalRehydrator;

/**
 * Test seam — swap the durable read (pass `null` to restore the real one). Unlike
 * the replicator this is NOT an installation point: the default above is the live
 * production path.
 */
export function setAgentGoalRehydrator(fn: AgentGoalRehydrator | null): void {
  rehydrateGoal = fn ?? defaultGoalRehydrator;
}

/**
 * Owner -> the earliest ms at which another durable INTENT re-hydration may start
 * (WI-6637). Same deadline-not-boolean design as `goalHydrateAfter`, for the same
 * two jobs (in-flight guard + retry backoff) — see that map's note.
 */
const intentHydrateAfter = new Map<string, number>();

/** Resolves an owner's intent-declaration event id from DURABLE state. */
export type AgentIntentRehydrator = (ownerId: string) => Promise<number | null>;

/**
 * The durable read, loaded lazily — dynamic `import()` for both reasons the goal
 * rehydrator states above: it breaks the cycle back through the coordination tree,
 * and a default that works with no wiring cannot be left uninstalled.
 */
async function defaultIntentRehydrator(ownerId: string): Promise<number | null> {
  const { resolveOwnerIntentEventId } = await import('./agent-tools/coordination/agent-intent-sources');
  return resolveOwnerIntentEventId(ownerId);
}

let rehydrateIntent: AgentIntentRehydrator = defaultIntentRehydrator;

/** Test seam — swap the durable intent read (pass `null` to restore the real one). */
export function setAgentIntentRehydrator(fn: AgentIntentRehydrator | null): void {
  rehydrateIntent = fn ?? defaultIntentRehydrator;
}

/**
 * Fire-and-forget refill of a missing `intentEventId` from durable state (WI-6637).
 *
 * ⚠ THE MONOTONIC GUARD LIVES HERE, NOT IN `upsert` — and that placement is the
 * load-bearing part. WI-6637 was filed asserting a late fill is "safe by
 * construction because `intentEventId` is already MONOTONIC in applyPatch". It is
 * not, in EITHER direction:
 *   · `upsert` carries no monotonic rule at all — only `applyReplicatedStamp` does;
 *   · the LOCAL path is deliberately LAST-WRITE-WINS, and tested as such
 *     ("takes the LATEST intent, including a lower id (unlike the watermark)"),
 *     because an agent genuinely moves from one intent to another and the local
 *     process's call order IS the truth.
 * So monotonicity is the rule for writes whose order is NOT known — replication,
 * and this fill — never a global one. Guarding at the choke point would have red
 * that test and broken an intentional contract. This fill is stale-by-nature (an
 * async read a fresh declaration can overtake), so it applies only when it is
 * strictly newer than what the map already holds.
 */
function scheduleIntentRehydration(ownerId: string): void {
  const now = Date.now();
  if (now < (intentHydrateAfter.get(ownerId) ?? 0)) return;
  // Claimed BEFORE the await — this IS the in-flight guard, as for the goal.
  intentHydrateAfter.delete(ownerId);
  intentHydrateAfter.set(ownerId, now + GOAL_HYDRATE_COOLDOWN_MS);
  if (intentHydrateAfter.size > MAX_OWNERS) {
    const oldest = intentHydrateAfter.keys().next();
    if (!oldest.done) intentHydrateAfter.delete(oldest.value);
  }

  void (async () => {
    try {
      const id = await rehydrateIntent(ownerId);
      if (id == null || !Number.isFinite(id)) return;
      // Re-read AFTER the await: a real declaration may have landed while this
      // query was in flight, and that one is authoritative over this stale read.
      const prev = stamps.get(ownerId)?.intentEventId ?? null;
      if (prev != null && id <= prev) return;
      // `replicated: true` for the goal fill's reason: every worker reads the same
      // durable source and refills itself, so fanning this out would relay a value
      // the receiver can derive — and would put a stale read into peers' maps.
      upsert(ownerId, { intentEventId: id }, { replicated: true });
    } catch {
      /* best-effort, exactly like the telemetry it feeds */
    }
  })();
}

/**
 * Fire-and-forget refill of a missing `goalRef` from durable state (WI-6595).
 *
 * Returns immediately — the caller is the dispatcher's hot path and D-014 forbids
 * it blocking or doing I/O. The value lands for the NEXT call; this call still
 * stamps the null it honestly had, which is the correct retrospective answer.
 */
function scheduleGoalRehydration(ownerId: string): void {
  const now = Date.now();
  if (now < (goalHydrateAfter.get(ownerId) ?? 0)) return;
  // Claimed BEFORE the await — see the map's note; this IS the in-flight guard.
  goalHydrateAfter.delete(ownerId);
  goalHydrateAfter.set(ownerId, now + GOAL_HYDRATE_COOLDOWN_MS);
  if (goalHydrateAfter.size > MAX_OWNERS) {
    // Insertion order tracks recency (delete-then-set above), same as `stamps`.
    const oldest = goalHydrateAfter.keys().next();
    if (!oldest.done) goalHydrateAfter.delete(oldest.value);
  }

  void (async () => {
    try {
      const ref = await rehydrateGoal(ownerId);
      // A null is an honest "holds nothing" — writing it would be a no-op against
      // the null already there, and would pointlessly stamp `goalWrittenAt` and so
      // start losing legitimate older-but-real writes to the drop-if-older rule.
      if (ref == null) return;
      upsert(
        ownerId,
        { goalRef: asGoalRef(ref) },
        {
          // `now` is the read's START, not its completion. If the agent released
          // the work WHILE this query was in flight, that release wrote a LATER
          // timestamp and `upsert` drops this fill instead of resurrecting a goal
          // the agent has put down.
          at: now,
          // Not a local declaration: every worker reads the same durable source and
          // refills itself, so fanning this out would relay a value the receiver can
          // derive — and would put a stale read into peers' maps.
          replicated: true,
        },
      );
    } catch {
      /* best-effort, exactly like the telemetry it feeds */
    }
  })();
}

/** What a replicator is handed for each LOCAL declaration (WI-6594). */
export interface AgentStampPatchEvent {
  ownerId: string;
  patch: Partial<AgentStateStamp>;
  /** Origin-process wall clock, so a receiver can order concurrent goal writes. */
  at: number;
}

/**
 * Installed by the cluster wiring; `null` on a single-process host, where this
 * module behaves exactly as it did before WI-6594.
 *
 * Never called for a REPLICATED apply — only local declarations publish, which is
 * what stops the primary's relay from echoing a patch back around the ring.
 */
let publish: ((event: AgentStampPatchEvent) => void) | null = null;

/**
 * Install (or clear, with `null`) the cross-worker replicator. Injectable rather
 * than imported so this module keeps no dependency on `node:cluster` and stays
 * unit-testable with a plain function.
 */
export function setAgentStampPublisher(fn: ((event: AgentStampPatchEvent) => void) | null): void {
  publish = fn;
}

function upsert(
  ownerId: string,
  patch: Partial<AgentStateStamp>,
  opts: { at?: number; replicated?: boolean } = {},
): void {
  if (!ownerId) return;
  const at = opts.at ?? Date.now();

  // A goal write that is OLDER than the one already applied is dropped. Only
  // reachable via replication (a local process's own writes arrive in order), and
  // it is what keeps a slow relay from resurrecting a goal the agent has since
  // put down.
  if ('goalRef' in patch) {
    const seen = goalWrittenAt.get(ownerId);
    if (seen != null && at < seen) return;
    goalWrittenAt.set(ownerId, at);
  }

  const prev = stamps.get(ownerId);
  const next: AgentStateStamp = {
    intentEventId: prev?.intentEventId ?? null,
    assumptionSetId: prev?.assumptionSetId ?? null,
    goalRef: prev?.goalRef ?? null,
    ...patch,
  };
  // Re-insert so Map iteration order tracks recency for the eviction below.
  stamps.delete(ownerId);
  stamps.set(ownerId, next);
  if (stamps.size > MAX_OWNERS) {
    // Map preserves insertion order and we re-insert on every write, so the
    // first key is the least-recently-written owner.
    const oldest = stamps.keys().next();
    if (!oldest.done) {
      stamps.delete(oldest.value);
      goalWrittenAt.delete(oldest.value);
      goalHydrateAfter.delete(oldest.value);
      intentHydrateAfter.delete(oldest.value);
    }
  }

  if (!opts.replicated && publish) {
    // Best-effort, exactly like the telemetry it feeds: a replication channel that
    // throws must never be able to fail the tool call that declared the goal.
    try {
      publish({ ownerId, patch, at });
    } catch {
      /* a dead/draining IPC channel is not this caller's problem */
    }
  }
}

/**
 * Apply a declaration another process made (WI-6594). Does NOT re-publish, so the
 * primary's relay cannot loop.
 *
 * Per-field ordering rules, applied here rather than at the sender because only
 * the receiver knows what it already holds:
 *   · `intentEventId` / `assumptionSetId` — MONOTONIC. Both are PG sequence ids,
 *     so a lower arrival is a reordered message, never a newer declaration, and
 *     applying it would silently rewind the set every later call claims to have
 *     been made under. (`noteAssumptionAsserted` already reasons this way for the
 *     local path; replication needs the same guard for the same reason.)
 *   · `goalRef` — LAST WRITE WINS by origin timestamp, enforced in `upsert`.
 */
export function applyReplicatedStamp(event: AgentStampPatchEvent): void {
  const { ownerId, patch, at } = event;
  if (!ownerId || !patch) return;
  const prev = stamps.get(ownerId);
  const next: Partial<AgentStateStamp> = {};

  if ('intentEventId' in patch) {
    const incoming = patch.intentEventId;
    if (incoming != null && Number.isFinite(incoming) && (prev?.intentEventId == null || incoming > prev.intentEventId)) {
      next.intentEventId = incoming;
    }
  }
  if ('assumptionSetId' in patch) {
    const incoming = patch.assumptionSetId;
    if (incoming != null && Number.isFinite(incoming) && (prev?.assumptionSetId == null || incoming > prev.assumptionSetId)) {
      next.assumptionSetId = incoming;
    }
  }
  // `goalRef: null` is a REAL value (the agent put the work down), so membership —
  // not truthiness — decides whether the goal is being written.
  if ('goalRef' in patch) next.goalRef = asGoalRef(patch.goalRef ?? null);

  if (Object.keys(next).length === 0) return;
  upsert(ownerId, next, { at, replicated: true });
}

/**
 * `coord:declare-intent` landed an append-only intent row — point at it.
 * Declaring a new intent does NOT clear the goal or the assumptions: they have
 * independent lifetimes (D-011's table), and an agent re-declares intent on
 * every wake via coord:orient while holding the same claim throughout.
 */
export function noteIntentDeclared(ownerId: string, intentEventId: number | null): void {
  if (intentEventId == null || !Number.isFinite(intentEventId)) return;
  upsert(ownerId, { intentEventId });
}

/**
 * `facts:assert` wrote an assumption fact version — advance the watermark.
 *
 * MONOTONIC ONLY. The watermark must never move backwards: a lower id would
 * silently narrow the set every later call claims to have been made under. Ids
 * are assigned by a sequence, so out-of-order arrival is possible when two
 * asserts race, and the later-arriving-but-lower id is the one to drop.
 */
export function noteAssumptionAsserted(ownerId: string, factVersionId: number | null): void {
  if (factVersionId == null || !Number.isFinite(factVersionId)) return;
  const prev = stamps.get(ownerId)?.assumptionSetId ?? null;
  if (prev != null && factVersionId <= prev) return;
  upsert(ownerId, { assumptionSetId: factVersionId });
}

/**
 * The agent took (or released) work — its goal ref. Pass null on release, so a
 * call made after the agent puts work down is not attributed to a goal it no
 * longer holds. That is a real distinction for a forensic read, which is why
 * this is an explicit clear rather than a leave-untouched.
 */
export function noteGoalClaimed(ownerId: string, goalRef: string | null): void {
  upsert(ownerId, { goalRef: asGoalRef(goalRef) });
}

/**
 * Clear a goal only when it is still the goal that a release just completed.
 *
 * Lifecycle cleanup can race with a newer claim by the same owner. An
 * unconditional `noteGoalClaimed(ownerId, null)` in an old release path would
 * erase that newer claim's attribution, so compare the normalized ref against
 * the cached value before clearing. Reading the map directly is intentional:
 * this is a write-side guard and must not schedule durable re-hydration for a
 * missing cache entry.
 */
export function clearGoalClaimedIfMatches(ownerId: string, goalRef: string | null): boolean {
  if (!ownerId) return false;
  const expected = asGoalRef(goalRef);
  if (expected == null || stamps.get(ownerId)?.goalRef !== expected) return false;
  noteGoalClaimed(ownerId, null);
  return true;
}

/**
 * The dispatcher's hot-path read: ONE Map.get, no I/O, never throws. An unknown
 * owner yields the all-null stamp, which is written as three NULLs.
 *
 * A MISSING GOAL ALSO SCHEDULES A DURABLE REFILL (WI-6595) — see
 * `scheduleGoalRehydration`. That stays inside D-014's rule: this function still
 * returns synchronously off a `Map.get` and still stamps whatever it actually had,
 * so the refill can only help the NEXT call and can never delay or fail this one.
 * A MISSING INTENT schedules the symmetric refill (WI-6637), under the same rule.
 */
export function readAgentStateStamp(ownerId: string | null | undefined): AgentStateStamp {
  if (!ownerId) return EMPTY_STAMP;
  const stamp = stamps.get(ownerId) ?? EMPTY_STAMP;
  if (stamp.goalRef == null) scheduleGoalRehydration(ownerId);
  if (stamp.intentEventId == null) scheduleIntentRehydration(ownerId);
  return stamp;
}

/** Test seam — the module holds process-global state. Clears the installed
 *  replicator AND both durable re-hydrators, so one test's fake publisher or fake
 *  durable read cannot leak into the next. */
export function resetAgentStateStamps(): void {
  stamps.clear();
  goalWrittenAt.clear();
  goalHydrateAfter.clear();
  intentHydrateAfter.clear();
  publish = null;
  rehydrateGoal = defaultGoalRehydrator;
  rehydrateIntent = defaultIntentRehydrator;
}

/** Test/diagnostic seam: how many owners are currently held. */
export function agentStateStampSize(): number {
  return stamps.size;
}
