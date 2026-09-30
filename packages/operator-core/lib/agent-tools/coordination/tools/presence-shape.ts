/**
 * coord:presence payload-tier shapers (context-trimming-tiers-2026-07-01 P-022).
 *
 * The roster row carries three full lanes (identity + state + liveness —
 * presence-payload.ts): host/pid/devicePubkey/awaiting-keys are per-row env
 * detail an LLM coordinator never reads. 7d MCP telemetry: avg 38KB, max
 * 185KB/call. A trimmed/standard session projects each row to the dispatch
 * decision core (who / state / wakeable / intent / lane) and caps rows.
 *
 * Contract (D-004): uniform keys per tier (TOON tabular), a visible
 * `(truncated)` notice row on a cut, `summary` kept verbatim (it is the
 * counts contract readers are told to trust — and the result-aware seeAlso
 * reads summary.byState.ended). A cut also gets an early, machine-readable
 * `activeTruncated` disclosure. The row sentinel is useful to a human reading
 * the table, but it is at the tail of `active[]` and can be lost when the
 * result door clips a large payload; the top-level disclosure must therefore
 * precede the roster in the serialized object.
 */

export const PRESENCE_TIER_CAPS = {
  trimmed: { rows: 40, intent: 80 },
  standard: { rows: 80, intent: 160, note: 60 },
} as const;

/**
 * Keep a tier-shaped presence read below the per-result door. The door's
 * default is ~6,000 characters, but it must also append its own disclosure
 * when a result is over budget. Leaving this headroom means the shaped body
 * remains complete JSON/TOON for ptool and other machine-facing callers.
 */
export const PRESENCE_RESPONSE_BUDGET_CHARS = 4_800;

type PresenceTier = keyof typeof PRESENCE_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

export function shapeCoordPresence(data: unknown, tier: PresenceTier): unknown {
  const d = data as
    | ({ active?: unknown[]; expanded?: unknown[]; agents?: unknown[] } & Record<string, unknown>)
    | null
    | undefined;
  if (!d || !Array.isArray(d.active)) return data;
  const active = d.active;
  const c = PRESENCE_TIER_CAPS[tier];

  const project = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const claimed = Array.isArray(r.claimedItems) ? r.claimedItems : [];
    // `claimedItems` is the plan-item lane only. Tier-1 carries the unified
    // count separately so work-item-only holders remain visibly occupied
    // without leaking WI-/EI- ids into that plan-local array.
    const claimCount = typeof r.claimCount === "number" ? r.claimCount : claimed.length;
    const base = {
      ownerId: r.ownerId ?? null,
      label: r.ownerLabel ?? null,
      role: r.agentRole ?? null,
      state: r.sessionState ?? null,
      wakeable: r.wakeable ?? null,
      // WI-4400: before taking over a draining/suspect row, send
      // coord:send { wake:'required' } and inspect woken/recipient_absent.
      confirmLiveness: r.confirmLiveness ?? null,
      // EI-22805550006169069: kept in `base` — i.e. at EVERY tier, like
      // confirmLiveness/fleetControlState — because it is precisely a
      // routing-decision signal a caller needs BEFORE spending a reclaim or a
      // relaunch on a candidate, and hiding it behind payloadTier:"full" would
      // leave the default read carrying the same ambiguity it exists to remove:
      // an agent merely dormant between loop fires renders identically to a dead
      // one on every other field of this row. `true` + a `nextFireAt` means
      // "back at that time, no relaunch needed"; `true` + null means a turn is in
      // flight right now; `null` means NOT MEASURED, never "nothing will wake it".
      dormantScheduled: r.dormantScheduled ?? null,
      nextFireAt: r.nextFireAt ?? null,
      // P-007: coarse context-pressure bucket (ok|high|critical|null) — cheap
      // enough (one short string) to keep at every tier, like state/wakeable.
      contextPressure: r.contextPressure ?? null,
      contextPressureAgeSec:
        typeof r.contextPressureAgeSec === "number" ? r.contextPressureAgeSec : null,
      // coord-delivery-residual-gaps P-001: deafness flag (stale|missing|null)
      // — "is this live session actually seeing its coord mail right now?".
      // One short string, kept at every tier like contextPressure: a leader
      // deciding whether a coord:send will be SEEN needs this in the core row.
      coordHook: r.coordHook ?? null,
      intent: clip(r.intent, c.intent),
      plan: r.currentPlanSlug ?? null,
      claims: claimCount,
      lastActiveSecAgo: r.lastActiveSecAgo ?? null,
      // P-011: the age is ambiguous without its provenance. Keep the source in
      // every model-facing tier so live reads can distinguish transcript-derived
      // freshness from the coord_presence heartbeat path.
      lastActiveSource: r.lastActiveSource ?? null,
      intentStale: r.intentStale ?? null,
      // EI-8988: fresh activity + old intent text — the "busy but drifted" signal,
      // cheap enough (one bool) to keep even in the trimmed tier.
      intentDivergent: r.intentDivergent ?? null,
      fleet: r.fleetSlug ?? null,
      // EI-22072194984361823: kept at every tier, like contextPressure/coordHook
      // — this is exactly the routing-decision signal a caller needs BEFORE
      // spending a send/dispatch/claim on a candidate, not something worth
      // hiding behind payloadTier:"full".
      fleetControlState: r.fleetControlState ?? null,
      canAcquireWork: r.canAcquireWork ?? null,
      isSelf: r.isSelf === true,
    };
    if (tier === "trimmed") return base;
    return {
      ...base,
      harness: r.harnessSlug ?? null,
      model: r.model ?? null,
      onDesktop: r.onDesktop ?? null,
      viewerAttached: r.viewerAttached ?? null,
      wakeMode: r.wakeMode ?? null,
      awaitingNote: clip(r.awaitingNote, (c as { note?: number }).note ?? 60),
      files: Array.isArray(r.currentFiles) ? r.currentFiles.length : 0,
      claimRefs: claimed.every((x) => typeof x === "string")
        ? claimed.slice(0, 8).map(String).join(",") || null
        : null,
    };
  };

  // P-031 leg (d): the opt-in `expanded[]` coupling block rides at top level, so
  // it survives `{...d}` untouched — but its per-entry `intent` is copied from a
  // base row, and at a trimmed/standard tier those rows had their intent clipped.
  // Clip it here too, or the OPT-IN block ends up carrying longer text than the
  // roster it sits beside. The entries themselves are already capped upstream
  // (COUPLED_EXPANSION_MAX), so only the text needs bounding.
  const expanded = Array.isArray(d.expanded)
    ? d.expanded.map((e) => {
        const r = (e ?? {}) as Record<string, unknown>;
        return typeof r.intent === "string" ? { ...r, intent: clip(r.intent, c.intent) } : r;
      })
    : undefined;

  // Keep the small top-level fields (as_of/scope/summary/self) verbatim. Put
  // this disclosure BEFORE the roster so it survives a result-door clip that
  // cuts through the long `active[]` value. `censusCount` is measured from the
  // complete snapshot presented to this shaper, never from the capped output.
  //
  // The tier row cap alone is not enough: 40 projected rows with long intents
  // can still land just under the 30KB payload-tier ceiling but just over the
  // ~6KB result door. That made the door append its footer to a JSON/TOON body
  // and left ptool with no parseable document. Trim whole rows until the
  // serialized body has deliberate headroom, and disclose that the cut was
  // budget-driven rather than pretending the tier row cap was the only limit.
  const baseData = { ...d };
  delete baseData.active;
  delete baseData.activeTruncated;
  // EI-21845811145701209: `agents` is a raw alias of `active` set by the
  // handlers (presence.ts / roster.ts) BEFORE tiering. Drop the raw
  // (untrimmed, full-size) copy here and rebuild it below from the SAME
  // tier-projected `rows` as `active` — otherwise a trimmed/standard read
  // would leak the full untrimmed roster back in under this second key,
  // defeating the whole point of tiering.
  delete baseData.agents;
  const projectedRows = active.slice(0, c.rows).map(project);
  const serializeLength = (value: unknown): number => {
    try {
      return JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  const maxRows = projectedRows.length;
  const expandedRows = expanded ?? [];
  const build = (shown: number, shownExpanded: number): Record<string, unknown> => {
    const rows = projectedRows.slice(0, shown);
    const truncated = shown < active.length;
    const budgetTruncated = shown < maxRows;
    const expandedBudgetTruncated = expanded !== undefined && shownExpanded < expanded.length;
    if (truncated) {
      rows.push({
        ...project({}),
        ownerId: "(truncated)",
        intent: budgetTruncated
          ? `showing ${shown} of ${active.length} — response budget; narrow with owner/hive/scope, or payloadTier:"full"`
          : `showing ${c.rows} of ${active.length} — narrow with owner/hive/scope, or payloadTier:"full"`,
      });
    }
    const activeTruncated = truncated
      ? {
          shown,
          censusCount: active.length,
          truncatedByLimit: true as const,
          limit: c.rows,
          ...(budgetTruncated ? { reason: "response_budget" as const } : {}),
          more: 'coord:presence { owner } for a targeted liveness lookup; payloadTier:"full" for the complete roster',
        }
      : undefined;
    return {
      ...(activeTruncated ? { activeTruncated } : {}),
      ...baseData,
      active: rows,
      // Alias, same tier-projected rows as `active` (never a second
      // derivation) — see the EI-21845811145701209 note above `delete
      // baseData.agents`.
      agents: rows,
      ...(expanded !== undefined ? { expanded: expandedRows.slice(0, shownExpanded) } : {}),
      ...(expandedBudgetTruncated
        ? {
            expandedTruncated: {
              shown: shownExpanded,
              total: expanded.length,
              reason: "response_budget" as const,
            },
          }
        : {}),
    };
  };

  let shown = maxRows;
  let shownExpanded = expandedRows.length;
  let out = build(shown, shownExpanded);
  // Coupling is useful context, but the live roster is the primary presence
  // contract. Trim the appended expansion first so a large default-on
  // coupling block cannot consume the entire budget and leave active[] empty.
  while (serializeLength(out) > PRESENCE_RESPONSE_BUDGET_CHARS && shownExpanded > 0) {
    shownExpanded -= 1;
    out = build(shown, shownExpanded);
  }
  while (shown > 0 && serializeLength(out) > PRESENCE_RESPONSE_BUDGET_CHARS) {
    shown -= 1;
    out = build(shown, shownExpanded);
  }
  return out;
}
