/**
 * fleet:assignments payload-tier shapers (context-trimming-tiers-2026-07-01
 * P-022). 7d MCP telemetry: avg 6KB × 1,157 calls — the Queen/overwatch
 * placement poll. The fat is per-agent claims[] (16 fields/claim), the
 * queued[] work-list, and the coverage[] links table.
 *
 * Trimmed = the placement decision core: summary + reclaimables (orphaned/
 * stalled ARE the point of the tool — kept, capped) + one compact row per
 * agent (doing/load/intent), coverage collapsed to a count + note. Standard
 * restores a projected coverage table and wider agent rows.
 *
 * Contract (D-004): uniform keys per tier, visible truncation notices,
 * `summary` verbatim (the counts contract; the result-aware seeAlso reads
 * summary.orphaned_claims/stalled_claims).
 */

export const ASSIGNMENTS_TIER_CAPS = {
  trimmed: { agents: 40, intent: 80, reclaim: 20, doing: 70 },
  standard: { agents: 80, intent: 160, reclaim: 40, doing: 110, coverage: 40 },
} as const;

type AssignTier = keyof typeof ASSIGNMENTS_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

/** One compact "id title…" cell from a work-list entry (doing/queued rows). */
function workRef(v: unknown, max: number): string | null {
  if (!v || typeof v !== "object") return null;
  const w = v as { id?: unknown; title?: unknown; status?: unknown };
  const title = typeof w.title === "string" ? w.title : "";
  return clip(`${String(w.id ?? "?")} ${title}`.trim(), max);
}

export function shapeFleetAssignments(data: unknown, tier: AssignTier): unknown {
  const d = data as
    | ({
        agents?: unknown[];
        orphaned?: unknown[];
        stalled?: unknown[];
        abandoned_intents?: unknown[];
        coverage?: unknown[];
        coverage_collisions?: unknown[];
        coverage_duplicates?: unknown[];
      } & Record<string, unknown>)
    | null
    | undefined;
  if (!d || !Array.isArray(d.agents)) return data;
  const c = ASSIGNMENTS_TIER_CAPS[tier];

  const projectAgent = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const claims = Array.isArray(r.claims) ? r.claims : [];
    const base = {
      agentId: r.agentId ?? null,
      alive: r.alive === true,
      // EI-6077: the coordinator-facing session state (live|parked|ended|recorded),
      // derived from wakeability — surfaced alongside `alive` so a caller can tell
      // "really runnable" from "just looks alive" without a second coord:presence
      // call. null when the wakeability read was unavailable (state unknown).
      sessionState: typeof r.sessionState === "string" ? r.sessionState : null,
      // EI-21125380796386851: keep the oracle's delivery axis beside the
      // recoverable `suspect` verdict. null means the wakeability read was
      // unavailable, not that the member is known non-wakeable.
      wakeable: typeof r.wakeable === "boolean" ? r.wakeable : null,
      // WI-4400: before taking over a draining/suspect row, send
      // coord:send { wake:'required' } and inspect woken/recipient_absent.
      confirmLiveness: typeof r.confirmLiveness === "boolean" ? r.confirmLiveness : null,
      // EI-19407725333778711: the FORWARD-LOOKING wake axis — will anything wake
      // this member unprompted (`loop` | `event` | `none`)? Every other field
      // here describes the PRESENT; this is the only one that says whether the
      // present ever ends. `sessionState:'parked'` + `selfWake:'none'` is a dead
      // member in a healthy costume — the state that turned a 10-agent fleet
      // into a 1-agent fleet for 70+ minutes with every surface reporting green.
      // Kept at EVERY tier (one short string) because the trimmed tier is what
      // the leader's monitor loop actually reads.
      // `null` = the leg did not resolve (UNKNOWN) — deliberately NOT `'none'`.
      // The filer also asked for a sibling `loopArmed` boolean; it is exactly
      // `selfWake === 'loop'` by construction, so emitting it too would put a
      // second, independently-staleable spelling of one fact on the wire.
      selfWake: typeof r.selfWake === "string" ? r.selfWake : null,
      // EI-8995: the single derived lifecycle verdict (booted|joined|first-turn-
      // done|speaking|stalled|suspect|dead) + the member's wake mode (a MANUAL member
      // silently stages directed wakes) — the leader's relaunch/re-steer read,
      // kept at EVERY tier (two short strings; the monitor loop runs trimmed).
      verdict: typeof r.verdict === "string" ? r.verdict : null,
      // P-010: explicit loop-owned lifecycle + next scheduled fire. Kept at
      // every tier so a lean monitor never mistakes a legitimate wait for a
      // stalled/unclaimed member and never needs a second loop:status call.
      monitorState: typeof r.monitorState === "string" ? r.monitorState : null,
      nextFireAt: typeof r.nextFireAt === "string" ? r.nextFireAt : null,
      // EI-19381528967421062: present ONLY while the loop is actually backed off from a
      // provider wall (usually absent, like parkedOn/unanswered below) — kept at EVERY
      // tier so a lean monitor can tell "healthy, next tick in 60s" from "silenced for
      // the next 100 minutes" without a second per-owner loop:status call.
      ...(r.lifecycleBackoff && typeof r.lifecycleBackoff === "object"
        ? { lifecycleBackoff: r.lifecycleBackoff }
        : {}),
      wakeMode: typeof r.wakeMode === "string" ? r.wakeMode : null,
      // P-007 (fleet-deltas-leader-primitives-2026-07-10): coarse context-pressure
      // bucket (ok|high|critical) — kept at EVERY tier like verdict/wakeMode (one
      // short string; the monitor loop runs trimmed and needs it for the P-004 delta).
      contextPressure: typeof r.contextPressure === "string" ? r.contextPressure : null,
      contextPressureAgeSec:
        typeof r.contextPressureAgeSec === "number" ? r.contextPressureAgeSec : null,
      intent: clip(r.intent, c.intent),
      plan: r.declaredPlanSlug ?? null,
      fleet: r.fleetSlug ?? null,
      claims: claims.length,
      doing: workRef(r.doing, c.doing),
      load: typeof r.load === "number" ? r.load : 0,
      isSelf: r.isSelf === true,
      // P-001 (fleet-member-dx): active non-inbox-wake events:await keys — a
      // deliberately-benched member. Present only when parked (usually absent),
      // so it is kept at EVERY tier like verdict/wakeMode.
      ...(Array.isArray(r.parkedOn) && r.parkedOn.length > 0
        ? { parkedOn: r.parkedOn.map(String) }
        : {}),
      // P-007 (fleet-reliability-verification-2026-07-10): unanswered directed
      // messages — present only when >=1 (usually absent), kept at EVERY tier
      // like parkedOn/contextPressure. Trimmed keeps just count/oldestAgeMs;
      // the per-message `newest` detail is standard+ only (below).
      ...((r.unanswered as { count?: unknown } | undefined)?.count
        ? {
            unanswered: {
              count: (r.unanswered as { count: number }).count,
              oldestAgeMs: (r.unanswered as { oldestAgeMs?: number }).oldestAgeMs ?? null,
            },
          }
        : {}),
    };
    if (tier === "trimmed") return base;
    return {
      ...base,
      ...(r.unanswered ? { unanswered: r.unanswered } : {}),
      label: r.label ?? null,
      // EI-8995: the raw freshness timestamp behind `verdict` (standard+ only).
      lastToolCallAt: typeof r.lastToolCallAt === "string" ? r.lastToolCallAt : null,
      orphaned: r.orphaned === true,
      stalled: r.stalled === true,
      declaredUnclaimed: r.declaredUnclaimed === true,
      queued: Array.isArray(r.queued) ? r.queued.length : 0,
      claimRefs:
        claims
          .slice(0, 8)
          .map((cl) => {
            const x = (cl ?? {}) as { id?: unknown; planSlug?: unknown };
            return x.planSlug ? `${String(x.planSlug)}#${String(x.id ?? "?")}` : String(x.id ?? "?");
          })
          .join(",") || null,
    };
  };

  const capList = (list: unknown[] | undefined, cap: number) => {
    const arr = Array.isArray(list) ? list : [];
    return {
      rows: arr.slice(0, cap),
      note: arr.length > cap ? `showing ${cap} of ${arr.length}` : null,
    };
  };
  const orphaned = capList(d.orphaned, c.reclaim);
  const stalled = capList(d.stalled, c.reclaim);
  // Claimless dead-intent lanes are reclaimable-grade coordination signals and
  // must survive the trimmed leader-monitor tier.
  const abandonedIntents = capList(d.abandoned_intents, c.reclaim);
  // Coverage collisions (EI-6074) are a reclaimable-grade coordination smell —
  // kept (capped) at every tier like orphaned/stalled, since the whole point is
  // the Queen sees the cross-table duplicate without a full-payload read.
  const collisions = capList(d.coverage_collisions, c.reclaim);
  // Same-principal duplicate coverage (EI-21188799646985672) is the sibling
  // coordination smell: keep it at every tier, capped like collisions, so a
  // trimmed monitor can see it without fetching the full assignment payload.
  const duplicates = capList(d.coverage_duplicates, c.reclaim);

  const agents = d.agents.slice(0, c.agents).map(projectAgent);
  if (d.agents.length > c.agents) {
    agents.push({
      ...projectAgent({}),
      agentId: "(truncated)",
      intent: `showing ${c.agents} of ${d.agents.length} — narrow with agent/plan/harness, or payloadTier:"full"`,
    });
  }

  const coverage = Array.isArray(d.coverage) ? d.coverage : [];
  const coverageOut =
    tier === "standard"
      ? {
          coverage: coverage
            .slice(0, (c as { coverage?: number }).coverage ?? 40)
            .map((entry) => {
              const e = (entry ?? {}) as Record<string, unknown>;
              return {
                plan: e.plan ?? null,
                item: e.item ?? null,
                level: e.level ?? null,
                workers: Array.isArray(e.workers) ? e.workers.map(String).join(",") || null : null,
              };
            }),
        }
      : coverage.length > 0
        ? {
            coverage_note: `coverage table (${coverage.length} rows) omitted at trimmed tier — payloadTier:"standard"/"full", or narrow with {plan}`,
          }
        : {};

  // DAG-filter frontier (includeDag, EI-6949): the caller opted in, so NEVER
  // silently drop it. Standard/full carry the full frontier; trimmed collapses to
  // the counts + a visible note (the item list can be large), mirroring coverage.
  const dag = (d as { dag?: unknown }).dag;
  const dagOut =
    dag && typeof dag === "object"
      ? tier === "standard"
        ? { dag }
        : {
            dag_counts: (dag as { counts?: unknown }).counts ?? null,
            dag_note: `dag frontier items omitted at trimmed tier — payloadTier:"standard"/"full"`,
          }
      : {};

  return {
    ok: d.ok ?? true,
    // A nested fleet-assignment read can be an explicit degraded fallback (for
    // example coord:orient's bounded timeout). Keep its diagnostic fields at
    // every payload tier; dropping them turns an unknown roster into a false
    // empty `agents: []` result.
    ...(typeof d.degraded === "boolean" ? { degraded: d.degraded } : {}),
    ...(Array.isArray(d.degradedLegs) ? { degradedLegs: d.degradedLegs } : {}),
    ...(typeof d.degradedLeg === "string" ? { degradedLeg: d.degradedLeg } : {}),
    ...(typeof d.degradedReason === "string" ? { degradedReason: d.degradedReason } : {}),
    ...(typeof d.retryable === "boolean" ? { retryable: d.retryable } : {}),
    ...(d.self !== undefined ? { self: d.self } : {}),
    // EI-18763132241176410: `scope` QUALIFIES the counts contract below — it names the
    // population the query asked about ({ agent, plan, fleet, harness, selfScoped,
    // filtered }). This reconstruction used to drop it, so `summary` survived verbatim
    // while the caveat scoping it did not: a self-scoped read rendered as a bare
    // `agents:1, claims:0` with nothing marking it NOT MEASURED. Worst at trimmed tier,
    // i.e. exactly when a busy leader/Mug is reading a nested `me` under budget
    // pressure. Measured 2026-08-24: coord:orient reported agents:1/claims:0 while
    // fleet:assignments {harness} reported agents:39/claims:51/stalled:3 — the caller
    // could not tell those apart, and `me.summary.population` cannot close the gap
    // (it reports which resolved rows were KEPT, never which population was ASKED
    // about, so it reads a self-consistent candidates:1/counted:1). Tiny and uniform
    // across tiers, so it is preserved unconditionally rather than tier-gated.
    ...(d.scope !== undefined ? { scope: d.scope } : {}),
    summary: d.summary ?? null,
    orphaned: orphaned.rows,
    ...(orphaned.note ? { orphaned_note: orphaned.note } : {}),
    stalled: stalled.rows,
    ...(stalled.note ? { stalled_note: stalled.note } : {}),
    abandoned_intents: abandonedIntents.rows,
    ...(abandonedIntents.note ? { abandoned_intents_note: abandonedIntents.note } : {}),
    ...(collisions.rows.length ? { coverage_collisions: collisions.rows } : {}),
    ...(collisions.note ? { coverage_collisions_note: collisions.note } : {}),
    ...(duplicates.rows.length ? { coverage_duplicates: duplicates.rows } : {}),
    ...(duplicates.note ? { coverage_duplicates_note: duplicates.note } : {}),
    ...coverageOut,
    ...dagOut,
    agents,
  };
}
