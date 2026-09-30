/**
 * leader-brief-alerts — turn a `fleet:leader-brief` payload into what the
 * conversation popup's peers rail renders
 * (popup-agent-state-coverage-2026-08-18 P-003 + P-004).
 *
 * PURE: no React, no fetch, no clock read. Everything derived here is a
 * restatement of what the brief already decided — this file must never invent a
 * verdict of its own. That is the same rule `fleet-peers.ts` states for the
 * board's column vocabulary, and it matters more here: the brief IS what the
 * leader is handed, so a second derivation would put the rail and the leader's
 * own tool in disagreement about a fleet in trouble.
 *
 * ── Two design constraints inherited from the plan ──────────────────────────
 * D-003: per-member alerts render as GLYPHS on peer rows that already exist —
 * never new rows. The rail is a fixed height by construction, a constraint paid
 * for after one agent's 32 locks made it ~2,000px tall, and this plan must not
 * spend it. The one new block is the fleet-level section, which is bounded.
 *
 * D-007 (owner, 2026-08-18): the fleet-level block is ALWAYS VISIBLE when it
 * applies, as drawn in the approved mockups — not folded behind the right-edge
 * `⚠ N locks ›` pattern. It collapses to nothing on a clean fleet, so its
 * ABSENCE is the all-clear.
 *
 * ── Why an absence is never rendered as an all-clear ────────────────────────
 * Three of the readings below are tri-state on the wire and only two of the
 * states are good news:
 *  - `skipped: 'read-failed'` is NOT `'no-fleet'`. "This agent leads nothing"
 *    and "we could not read its fleet" look identical on screen unless the pane
 *    is told which, and the second is the case where a leader is flying blind.
 *  - `claimable_now.value: null` means the lane read FAILED, not that the lane
 *    is drained. Its `population` and in-band `unknown` reason travel with the
 *    value; it is never rendered as 0.
 *  - a custom invariant with `status:'error'` is a check that could not run. It
 *    protects the leader from nothing, so it fires as an alert rather than
 *    counting toward "all satisfied".
 */
import type {
  AgentLeaderBrief,
  LeaderBriefCustomInvariant,
  LeaderBriefFleetMetrics,
  LeaderBriefMemberRow,
} from '../../adv/sessions/use-agent-leader-brief';

/** `bad` = act now; `warn` = look at it. There is deliberately no `info`
 *  severity for member glyphs: a glyph that does not need a human is noise on a
 *  248px row. */
export type AlertSeverity = 'bad' | 'warn';

export interface MemberAlert {
  /** Stable react key + test handle, e.g. `dormant`, `coord-deaf`. */
  key: string;
  /** The single mark drawn on the row. Single-character on purpose — the rail
   *  is ~248px and the row is scanned, not read. */
  glyph: string;
  severity: AlertSeverity;
  /** The full sentence, one hover away. Carries the REASON and, where the brief
   *  supplies one, the item — never just a restatement of the glyph. */
  title: string;
}

export interface FleetAlert {
  key: string;
  severity: AlertSeverity;
  /** The one-line headline, ~40 chars — this block is bounded (D-003). */
  text: string;
  /** The brief's own reason sentence, on hover. Null when it supplied none. */
  detail: string | null;
}

export interface FleetAlertsModel {
  fleetSlug: string | null;
  /** Ordered most-severe first. Never empty — an empty block is not rendered. */
  alerts: FleetAlert[];
  /** "degraded · q 7", or null when the pool is healthy or unread. */
  capacity: string | null;
  /** "4 invariants · all satisfied", or null when none are registered.
   *  Rendered ONLY when the block is already open for another reason: a clean
   *  fleet must stay silent (D-003), but once a leader is reading this block
   *  they need to know whether their checks are actually running. */
  invariantsNote: string | null;
}

/**
 * A renderable canonical work-stock tuple. `remaining` is present only when
 * every label needed to interpret it survived transport. The popup never
 * substitutes a legacy top-level count or turns an unavailable read into zero.
 */
export interface FleetMetricsModel {
  status: 'measured' | 'unavailable';
  remaining: string;
  scope: string;
  quality: string;
  /** Full unit/window/failure evidence for the row tooltip + accessible name. */
  detail: string;
}

export interface LeaderBriefAlertsModel {
  /** ownerId → its alerts, most-severe first. Absent key ⇒ no glyphs. */
  byMember: Record<string, MemberAlert[]>;
  /** Canonical work scope, independent of whether any fleet alert fired. */
  metrics: FleetMetricsModel | null;
  /** null ⇒ render no fleet block at all (the all-clear). */
  fleet: FleetAlertsModel | null;
  /** True when the brief was fetched and genuinely returned member rows — the
   *  rail uses it to decide whether "no glyphs" means "healthy" or "unknown". */
  briefed: boolean;
}

function finiteNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Preserve the canonical snapshot atomically. A partial measured payload is an
 * unavailable reading, not permission to render the surviving numeral.
 */
export function deriveFleetMetrics(fleetMetrics: LeaderBriefFleetMetrics | null | undefined): FleetMetricsModel | null {
  if (!fleetMetrics) return null;

  const requested = fleetMetrics.requested;
  if (fleetMetrics.ok !== true) {
    const requestedScope = [requested?.fleet, requested?.harness, requested?.flowMode, requested?.window].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    const reason = fleetMetrics.reason ?? fleetMetrics.error ?? 'canonical fleet metrics were not measured';
    const recover = fleetMetrics.recoverVia ? ` · recover via ${fleetMetrics.recoverVia}` : '';
    return {
      status: 'unavailable',
      remaining: 'unavailable',
      scope: requestedScope.length > 0 ? requestedScope.join(' · ') : 'scope unavailable',
      quality: 'not measured',
      detail: `${reason}${recover}`,
    };
  }

  const snapshot = fleetMetrics.snapshot;
  const scope = snapshot?.scope;
  const window = scope?.window;
  const stock = scope?.stock;
  const population = scope?.population?.stock;
  const remaining = finiteNonNegativeInt(snapshot?.remaining?.total);
  const unit = snapshot?.remaining?.unit;
  const revision = finiteNonNegativeInt(stock?.revision);
  const exactness = snapshot?.quality?.exactness;
  const freshness = snapshot?.quality?.freshness;

  const complete =
    snapshot?.schemaVersion === 'fleet-metrics-v1' &&
    typeof scope?.fleet === 'string' &&
    typeof scope.harness === 'string' &&
    window?.kind === 'fleet-lifetime' &&
    typeof window.startAt === 'string' &&
    typeof window.endAt === 'string' &&
    stock?.mode === 'current-spec' &&
    typeof stock.specId === 'string' &&
    revision != null &&
    population === 'current-spec-work-items' &&
    remaining != null &&
    unit === 'distinct canonical issue-family work-item ids' &&
    (exactness?.status === 'exact' || exactness?.status === 'truncated') &&
    (freshness?.status === 'fresh' || freshness?.status === 'stale');

  if (!complete) {
    return {
      status: 'unavailable',
      remaining: 'unavailable',
      scope: 'canonical scope incomplete',
      quality: 'not measured',
      detail:
        'The leader brief carried a partial fleetMetrics snapshot. The remaining count is withheld ' +
        'until population, spec revision, fleet-lifetime window, unit, exactness, and freshness all arrive.',
    };
  }

  const exactnessDetail =
    exactness.status === 'truncated'
      ? `truncated${exactness.sourceCap != null ? ` at source cap ${exactness.sourceCap}` : ''}` +
        `${exactness.reason ? ` (${exactness.reason})` : ''}` +
        `${exactness.recoverVia ? `; recover via ${exactness.recoverVia}` : ''}`
      : 'exact';
  const freshnessDetail =
    freshness.status === 'stale'
      ? `stale${freshness.reason ? ` (${freshness.reason})` : ''}` +
        `${freshness.recoverVia ? `; recover via ${freshness.recoverVia}` : ''}`
      : 'fresh';

  return {
    status: 'measured',
    remaining: `${remaining} remaining`,
    scope: `${population} · ${stock.specId}@r${revision} · ${window.kind}`,
    quality: `${exactness.status} · ${freshness.status}`,
    detail:
      `${scope.fleet}/${scope.harness} · unit: ${unit} · ` +
      `window: ${window.startAt} ≤ t < ${window.endAt} · ` +
      `exactness: ${exactnessDetail} · freshness: ${freshnessDetail}`,
  };
}

/** Render order = the order a leader should act in. Dormant first because
 *  nothing will wake that member at all; a takeover next because it is an
 *  authoritative "this needs a human now"; the rest are look-at-it signals. */
const MEMBER_ALERT_RANK: Record<string, number> = {
  dormant: 0,
  takeover: 1,
  spinning: 2,
  'coord-deaf': 3,
  throttled: 4,
  bench: 5,
  unanswered: 6,
  'directive-actuation': 7,
};

function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** `2026-08-19T04:41:00Z` → `04:41Z`, matching the mockup's throttle line.
 *  Falls back to the raw string rather than dropping it — a timestamp we cannot
 *  parse is still more use to a leader than "until (unknown)". */
function fmtUntil(iso: string | null | undefined): string {
  if (!iso) return 'an unknown time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}

/**
 * The per-member glyphs for one brief row.
 *
 * Exported for the unit tests and for a caller that already holds a single row;
 * `deriveLeaderBriefAlerts` is what the rail uses.
 */
export function deriveMemberAlerts(m: LeaderBriefMemberRow): MemberAlert[] {
  const out: MemberAlert[] = [];

  if (m.dormant === true) {
    out.push({
      key: 'dormant',
      glyph: 'D',
      severity: 'bad',
      title:
        'Dormant — no self-wake at all: no active loop, not parked on any event, holding no ' +
        'claim. Nothing will bring this member back; wake it explicitly.',
    });
  }

  // Authoritative "a verified wait failed and needs a human" — the brief has
  // already checked the producer, so this is a finding, not a suspicion.
  const takeovers = m.verifiedWaitTakeovers ?? [];
  if (takeovers.length > 0) {
    const first = takeovers[0];
    const more = takeovers.length > 1 ? ` (+${takeovers.length - 1} more)` : '';
    out.push({
      key: 'takeover',
      glyph: 'V',
      severity: 'bad',
      title:
        `Verified-wait takeover${more}: waiting on \`${first?.eventKey ?? 'an event'}\` whose ` +
        `producer is ${first?.classification ?? 'not progressing'}. ` +
        (first?.remedy ?? 'Wake the producer’s owner or take the work over.'),
    });
  }

  if (m.spinning === true) {
    out.push({
      key: 'spinning',
      glyph: 'S',
      severity: 'warn',
      title:
        `Spinning — taking turns, but its last PRODUCTIVE call was ` +
        `${fmtAge(m.productiveToolCallAgeMs)} ago; the rest is per-turn housekeeping. ` +
        'Every other liveness surface reads this member as healthy.',
    });
  }

  if (m.coordHook) {
    out.push({
      key: 'coord-deaf',
      glyph: '✉',
      severity: 'warn',
      title:
        m.coordHook === 'missing'
          ? 'Coord-deaf — no inbox read on record at all. A coord:send to this member will not ' +
            'be seen until it settles or is woken.'
          : 'Coord-deaf — has not read its coord mail for a whole budget window despite fresh ' +
            'activity. A coord:send to this member will not be seen until it settles.',
    });
  }

  if (m.throttled) {
    out.push({
      key: 'throttled',
      glyph: 'T',
      severity: 'warn',
      title:
        `Throttled — silenced by a provider wall (${m.throttled.reason ?? 'unclassified'}) until ` +
        `${fmtUntil(m.throttled.until)}. Its next fire is that wait, NOT a normal cadence tick; ` +
        'its claims are stranded until then, not lost.',
    });
  }

  if (m.benchSuggestion) {
    const b = m.benchSuggestion;
    const item = b.item ? ` — ${b.item}${b.itemTitle ? `: ${b.itemTitle}` : ''}` : '';
    // EI-18681259560385029: `idle-with-claimable` counts a STARVATION symptom,
    // and benching it is the one action that cannot help. The glyph is the same
    // (D-007: as drawn), but the sentence must not read as a bench nudge.
    out.push({
      key: 'bench',
      glyph: 'B',
      severity: 'warn',
      title:
        b.kind === 'idle-with-claimable'
          ? `Idle beside a NONEMPTY queue${item}. Do NOT bench this — it is starvation, not a ` +
            `member that should park. ${b.reason ?? ''}`.trim()
          : `Bench suggested (${b.kind ?? 'unclassified'})${item}. ${b.reason ?? ''}`.trim(),
    });
  }

  const unansweredCount = m.unanswered?.count ?? 0;
  if (unansweredCount > 0) {
    const newest = m.unanswered?.newest?.[0];
    out.push({
      key: 'unanswered',
      glyph: '?',
      severity: 'warn',
      title:
        `${unansweredCount} directed message${unansweredCount === 1 ? '' : 's'} unanswered, ` +
        `oldest ${fmtAge(m.unanswered?.oldestAgeMs)} ago` +
        (newest?.summary ? ` — newest: “${newest.summary}”` : '') +
        '. This is what they were ASKED.',
    });
  }

  const notYet = m.directiveActuation?.notYet ?? 0;
  if (notYet > 0) {
    const outstanding = m.directiveActuation?.outstanding ?? [];
    out.push({
      key: 'directive-actuation',
      glyph: '!',
      severity: 'warn',
      title:
        `${notYet} of your ${m.directiveActuation?.total ?? notYet} directive(s) to this member name a ` +
        'required side effect the ledger does NOT yet show. This is what HAPPENED, not what ' +
        'they said' +
        (outstanding.length > 0 ? `: ${outstanding.join('; ')}` : '') +
        '.',
    });
  }

  return out.sort((a, b) => (MEMBER_ALERT_RANK[a.key] ?? 99) - (MEMBER_ALERT_RANK[b.key] ?? 99));
}

/** A registered invariant that is VIOLATED or could not RUN. Both need a human;
 *  only the second is easy to miss, which is why `error` is not filtered out. */
function firingInvariants(inv: LeaderBriefCustomInvariant[]): LeaderBriefCustomInvariant[] {
  return inv.filter((i) => i.status === 'violated' || i.status === 'error');
}

function capacityLine(pool: {
  poolExhausted?: boolean;
  degraded?: boolean;
  factor?: number;
  queueDepth?: number | null;
} | null | undefined): string | null {
  // null is UNREAD, never "healthy" — but an unread pool is also not something
  // to alarm a leader with on every popup, so it renders as nothing here and the
  // fleet-level alerts carry the real findings.
  if (!pool) return null;
  if (!pool.poolExhausted && !pool.degraded) return null;
  const word = pool.poolExhausted ? 'exhausted' : 'degraded';
  const q = pool.queueDepth != null ? ` · q ${pool.queueDepth}` : '';
  const f = typeof pool.factor === 'number' ? ` · factor ${pool.factor}` : '';
  return `${word}${q}${f}`;
}

/**
 * The whole rail model: per-member glyphs plus the bounded fleet-level block.
 *
 * Returns `null` when there is nothing to render — the agent leads nothing, the
 * rail is closed, or the brief has not arrived. A caller must treat that as "no
 * additions to the rail", NOT as "the fleet is healthy".
 */
export function deriveLeaderBriefAlerts(
  leaderBrief: AgentLeaderBrief | null | undefined,
): LeaderBriefAlertsModel | null {
  if (!leaderBrief) return null;

  // A failed read is the one skip reason that is itself news. Every other skip
  // ('no-fleet', 'not-leader', 'no-workspace') is a correct, quiet no-op.
  if (leaderBrief.skipped === 'read-failed') {
    return {
      byMember: {},
      metrics: null,
      briefed: false,
      fleet: {
        fleetSlug: leaderBrief.fleetSlug,
        alerts: [
          {
            key: 'read-failed',
            severity: 'bad',
            text: 'fleet state unreadable',
            detail:
              'The leader-brief read FAILED for this agent. This is not “no alerts” — nothing ' +
              'below was checked, so treat the rest of this rail as unverified.',
          },
        ],
        capacity: null,
        invariantsNote: null,
      },
    };
  }

  // ── Leadership drift (P-013) ───────────────────────────────────────────────
  // A MEASURED disagreement between the two leadership sources. It qualifies
  // every other alert in this rail — under `registry-disowned` the member rows
  // below may belong to a fleet this agent no longer leads — so it is derived
  // BEFORE the brief and unshifted to the top of the fleet alerts.
  //
  // Absent means no drift was measured, never "the sources agree": a read that
  // threw took the `read-failed` skip above and reported no drift at all.
  const drift = leaderBrief.presenceDrift;
  const driftAlert: FleetAlert | null = drift
    ? {
        key: 'presence-drift',
        // `registry-disowned` is the dangerous half: the brief is built from a
        // presence row the registry does not back, so acting on its member rows
        // may be acting on somebody else's fleet. `presence-behind` is real and
        // already recovered — worth saying, not worth alarming over.
        severity: drift.kind === 'registry-disowned' ? 'bad' : 'warn',
        text:
          drift.kind === 'registry-disowned'
            ? 'leadership drift — presence claims a fleet the registry does not'
            : 'leadership drift — presence behind the registry',
        detail: drift.note,
      }
    : null;

  const brief = leaderBrief.brief;
  if (!brief) {
    // A drift with no brief is a race between the two reads, not a normal
    // shape — but dropping it here would silently discard the one finding this
    // pane exists to surface, so it renders on its own.
    if (!driftAlert) return null;
    return {
      byMember: {},
      metrics: null,
      briefed: false,
      fleet: {
        fleetSlug: leaderBrief.fleetSlug,
        alerts: [driftAlert],
        capacity: null,
        invariantsNote: null,
      },
    };
  }

  if (brief.ok === false) {
    return {
      byMember: {},
      metrics: null,
      briefed: false,
      fleet: {
        fleetSlug: leaderBrief.fleetSlug,
        alerts: [
          ...(driftAlert ? [driftAlert] : []),
          {
            key: 'brief-error',
            severity: 'bad',
            text: brief.error ? `brief: ${brief.error}` : 'brief unavailable',
            detail: brief.hint ?? null,
          },
        ],
        capacity: null,
        invariantsNote: null,
      },
    };
  }

  const byMember: Record<string, MemberAlert[]> = {};
  for (const m of brief.members ?? []) {
    if (!m?.agentId) continue;
    const alerts = deriveMemberAlerts(m);
    if (alerts.length > 0) byMember[m.agentId] = alerts;
  }

  const s = brief.summary ?? {};
  const metrics = deriveFleetMetrics(brief.fleetMetrics);
  // Drift leads: it qualifies how much of everything below can be trusted.
  const alerts: FleetAlert[] = driftAlert ? [driftAlert] : [];

  // ── The five flat *Alert booleans. Each ships a reason sibling; the flag says
  //    IF and the reason says WHY, and a flag rendered without its reason is the
  //    bare-complaint shape the brief's own comments warn about. ──────────────
  if (s.strandedFleetAlert) {
    alerts.push({
      key: 'stranded',
      severity: 'bad',
      text: 'fleet stranded — zero WIP with supply',
      detail: brief.strandedFleetAlertReason ?? null,
    });
  }
  if (s.specStarvedAlert) {
    alerts.push({
      key: 'spec-starved',
      severity: 'bad',
      text: 'spec starved',
      detail: brief.specStarvedAlertReason ?? null,
    });
  }
  if (s.floorStarvedAlert) {
    alerts.push({
      key: 'floor-starved',
      severity: 'bad',
      text: 'lane gated — members idle on an empty queue',
      detail: brief.floorStarvedAlertReason ?? null,
    });
  }
  if (s.idleWithClaimableAlert) {
    const n = s.idle_with_claimable ?? 0;
    alerts.push({
      key: 'idle-with-claimable',
      severity: 'warn',
      text: n > 0 ? `${n} idle with claimable` : 'idle members beside a nonempty queue',
      detail: brief.idleWithClaimableAlertReason ?? null,
    });
  }
  if (s.specAuthorshipAlert) {
    alerts.push({
      key: 'spec-authorship',
      severity: 'warn',
      // Not a supply problem like its siblings: the lane you are reading was
      // authored by someone else, so every other spec figure here describes a
      // scope this leader has not ratified.
      text: 'claim spec authored elsewhere',
      detail: brief.specAuthorshipAlertReason ?? null,
    });
  }

  // ── Custom invariants: a VIOLATED one, and equally an ERRORED one. ─────────
  const invariants = brief.customInvariants ?? [];
  const firing = firingInvariants(invariants);
  if (firing.length > 0) {
    const errored = firing.filter((i) => i.status === 'error').length;
    const violated = firing.length - errored;
    const parts: string[] = [];
    if (violated > 0) parts.push(`${violated} violated`);
    if (errored > 0) parts.push(`${errored} could not run`);
    alerts.push({
      key: 'invariants',
      severity: 'bad',
      text: `invariant: ${parts.join(', ')}`,
      detail:
        brief.customInvariantAlertReason ??
        firing
          .map((i) => `${i.key ?? i.title ?? 'invariant'}: ${i.status}${i.error ? ` — ${i.error}` : ''}`)
          .join(' · '),
    });
  }

  // ── Fleet paused. Emitted EXPLICITLY, and deliberately as a `warn` rather
  //    than an error: it is the REASON the idle alerts above read clean, so a
  //    leader seeing "no idle alerts" here learns "no action needed" instead of
  //    mistaking an unchecked state for a healthy one. ────────────────────────
  if (s.fleet_paused) {
    alerts.push({
      key: 'paused',
      severity: 'warn',
      text: 'fleet paused',
      detail:
        (brief.fleetPausedReason ? `${brief.fleetPausedReason} — ` : '') +
        'idle members are COMPLYING with the pause, not failing. Lift with fleet:resume.',
    });
  }

  // ── Unowned criticals: filing is not fixing. ───────────────────────────────
  const unowned = s.unowned_criticals ?? 0;
  if (unowned > 0) {
    alerts.push({
      key: 'unowned-criticals',
      severity: 'bad',
      text: `${unowned} unowned critical${unowned === 1 ? '' : 's'}`,
      detail:
        'Critical items this fleet’s own claim spec would admit that nobody holds. An escalation ' +
        'to act on (reclaim/reassign/nudge), not weather to wait out.',
    });
  }

  // ── Laneless idle: members idle against an empty or unread queue. Distinct
  //    from idle_with_claimable above, which by construction only counts them
  //    when claimable > 0 — in a fully-gated lane that field reads 0 and these
  //    members land here instead. Suppressed when floorStarved already said it. ─
  const laneless = s.laneless_idle ?? 0;
  if (laneless > 0 && !s.floorStarvedAlert) {
    alerts.push({
      key: 'laneless-idle',
      severity: 'warn',
      text: `${laneless} laneless idle`,
      detail:
        'Idle against an empty or unread queue. Check the claim spec admits work before reading ' +
        'this as members declining it.',
    });
  }

  const capacity = capacityLine(s.pool_capacity);
  if (capacity && alerts.length === 0) {
    // A degraded pool with nothing else firing still needs to be said — the
    // per-member `throttled` count can legitimately read 0 for every member at
    // once while the pool itself is congested.
    alerts.push({
      key: 'capacity',
      severity: 'warn',
      text: `inference pool ${capacity}`,
      detail:
        'The shared pool is scarce. Members can be queued for inference while none has ' +
        'individually backed off — `throttled: 0` does not disprove this.',
    });
  }

  if (alerts.length === 0) return { byMember, metrics, fleet: null, briefed: true };

  return {
    byMember,
    metrics,
    briefed: true,
    fleet: {
      fleetSlug: leaderBrief.fleetSlug,
      alerts,
      capacity,
      invariantsNote:
        invariants.length > 0 && firing.length === 0
          ? `${invariants.length} invariant${invariants.length === 1 ? '' : 's'} · all satisfied`
          : null,
    },
  };
}
