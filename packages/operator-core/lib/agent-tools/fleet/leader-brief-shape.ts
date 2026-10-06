/**
 * Payload-tier projection for fleet:leader-brief.
 *
 * The handler computes a deliberately rich diagnostic snapshot. That snapshot
 * is useful to in-process callers, but a default MCP read must leave room for
 * the result-door envelope. Keep the monitor decision core here and make every
 * variable-size field bounded before the framework serializes it.
 */

import { fleetMetricsResultSchema } from './fleet-metrics-contract';

export type LeaderBriefPayloadTier = 'trimmed' | 'standard';

/** Leave margin below the universal ~6KB result door for its JSON envelope. */
export const LEADER_BRIEF_SHAPER_BUDGET_CHARS = 5_000;

type Dict = Record<string, unknown>;

const TIER_CAPS: Record<
  LeaderBriefPayloadTier,
  {
    memberVerdicts: number;
    members: number;
    advisories: number;
    invariants: number;
    announcedGates: number;
    reservationMembers: number;
    /** P-025: never-drop FACT KEYS. Short strings, so the cap is higher than the
     *  verbose row caps above while still bounding a pathological fact set. */
    neverDropFacts: number;
  }
> = {
  trimmed: { memberVerdicts: 6, members: 3, advisories: 2, invariants: 2, announcedGates: 4, reservationMembers: 2, neverDropFacts: 8 },
  standard: { memberVerdicts: 10, members: 6, advisories: 3, invariants: 3, announcedGates: 8, reservationMembers: 3, neverDropFacts: 16 },
};

const clip = (value: unknown, max = 180): string | null => {
  if (typeof value !== 'string') return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;
}

function pick(value: unknown, keys: readonly string[], maxString = 180): Dict | null {
  const source = asDict(value);
  if (!source) return null;
  const out: Dict = {};
  for (const key of keys) {
    if (!(key in source)) continue;
    const v = source[key];
    out[key] = typeof v === 'string' ? clip(v, maxString) : v;
  }
  return out;
}

function compactFalsifier(value: unknown, maxString = 220): unknown {
  return pick(value, ['tool', 'check', 'measurement', 'kills'], maxString) ?? value;
}

function compactEmergencyFalsifier(value: unknown): unknown {
  return pick(value, ['tool'], 120) ?? {};
}

function compactBlockedAt(value: unknown, maxString = 220, includeSubordinate = true): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['layer', 'reason', 'remedy'], maxString) ?? {};
  if (includeSubordinate && Array.isArray(source.subordinate)) {
    out.subordinate = source.subordinate.slice(0, 3).map((entry) => compactFalsifier(entry));
    if (source.subordinate.length > 3) out.subordinateTruncated = source.subordinate.length;
  }
  if ('falsifier' in source) out.falsifier = compactFalsifier(source.falsifier, maxString);
  return out;
}

function compactMonitoringBlindAdvisory(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['line'], 220) ?? {};
  const arm = asDict(source.arm);
  if (arm) {
    const compactArm = pick(arm, ['tool'], 120) ?? {};
    // The default transport needs the executable handle, not its explanatory
    // annotation or the per-key detail already summarized by `line`. Full-tier
    // callers retain both `missingEventKeys` and `note` from the source object.
    const args = pick(arm.args, ['event'], 160);
    if (args) compactArm.args = args;
    out.arm = compactArm;
  }
  return out;
}

/** Keep the shared agenda's action core + delivery receipt together. */
function compactAgentObligations(value: unknown, emergency = false): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out =
    pick(source, ['schemaVersion', 'evaluatedAt', 'sourceGeneration', 'detailRef'], emergency ? 100 : 220) ?? {};
  const primary = Array.isArray(source.primary) ? source.primary : [];
  out.primary = primary.slice(0, emergency ? 1 : 3).map((entry) => {
    const obligation = asDict(entry);
    if (!obligation) return entry;
    const compact =
      pick(
        obligation,
        ['id', 'family', 'status', 'title', 'priority', 'applicableDemand', 'dueAt', 'ageMs', 'ruleRevision', 'sourceGeneration'],
        emergency ? 80 : 160,
      ) ?? {};
    const action = pick(
      obligation.action,
      ['kind', 'summary', 'tool', 'targetRef', 'recoveryRef', 'continuesCurrentWork'],
      emergency ? 80 : 180,
    );
    if (action) compact.action = action;
    return compact;
  });
  const projection = asDict(source.projection);
  if (projection) {
    const rawText = typeof projection.text === 'string' ? projection.text : '';
    const textLimit = emergency ? 120 : 700;
    const lines: string[] = [];
    let chars = 0;
    for (const line of rawText.split('\n').filter(Boolean)) {
      const next = chars + (lines.length ? 1 : 0) + line.length;
      if (next > textLimit) break;
      lines.push(line);
      chars = next;
    }
    let text = lines.join('\n');
    const clipped = rawText.length > textLimit;
    const receipt = pick(
      projection.receipt,
      ['sink', 'mode', 'entriesAvailable', 'entriesDelivered', 'entriesOmitted',
        'bodyDeliveredChars', 'estimatedTokens', 'bodyTruncated', 'refused', 'reason'],
      100,
    );
    // The provider receipt measures the INNER projection, not this final
    // transport cap. Never clip an imperative halfway and keep credit for it.
    if (clipped && receipt) {
      // Full-detail reasons may themselves contain newlines. If line count is
      // not the declared entry count, we cannot infer record boundaries from
      // text. Withhold the body and retain its full-detail recovery pointer.
      if (rawText.split('\n').filter(Boolean).length !== receipt.entriesDelivered) {
        lines.length = 0;
        text = '';
      }
      const delivered = lines.length === 0 ? 0 : typeof receipt.entriesDelivered === 'number'
        ? Math.min(receipt.entriesDelivered, lines.length) : null;
      Object.assign(receipt, {
        entriesDelivered: delivered,
        entriesOmitted: typeof receipt.entriesAvailable === 'number' && delivered !== null
          ? receipt.entriesAvailable - delivered : null,
        bodyDeliveredChars: text.length, estimatedTokens: Math.ceil(text.length / 4),
        bodyTruncated: true, reason: 'character-cap',
      });
    }
    out.projection = {
      text: clipped ? text : projection.text,
      receipt,
    };
  }
  const read = asDict(source.read);
  if (read) {
    out.read = {
      ...(pick(read, ['elapsedMs'], 60) ?? {}),
      ...(Array.isArray(read.degradedSources)
        ? {
            degradedSources: read.degradedSources.slice(0, emergency ? 1 : 3).map((entry) => clip(entry, 160) ?? entry),
          }
        : {}),
    };
  }
  return out;
}

/**
 * P-026 / D-016: owner directives have their own root contract. Do not reuse
 * compactAgentObligations here: its generic action allowlist intentionally
 * keeps diagnostic `targetRef`, while an owner-facing directive must expose
 * only the executable `recoveryRef` (and preserve the existing member
 * `directives` actuation ledger untouched).
 */
function compactOwnerDirectives(value: unknown, emergency = false): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['schemaVersion', 'evaluatedAt', 'sourceGeneration', 'state', 'detailRef'], emergency ? 100 : 220) ?? {};
  const directives = Array.isArray(source.directives) ? source.directives : [];
  out.directives = directives.slice(0, emergency ? 2 : 12).map((entry) => {
    const directive = asDict(entry);
    if (!directive) return entry;
    const compact = pick(
      directive,
      ['id', 'status', 'title', 'priority', 'applicableDemand', 'ageMs'],
      emergency ? 100 : 180,
    ) ?? {};
    const authority = asDict(directive.authority);
    if (authority) compact.authority = pick(authority, ['kind', 'sourceRef', 'turnOrigin', 'revision'], emergency ? 100 : 160) ?? {};
    if (Array.isArray(directive.evidence)) {
      compact.evidence = directive.evidence.slice(0, emergency ? 1 : 3).map((entry) =>
        pick(entry, ['ref', 'observedAt', 'freshness', 'sourceRevision', 'effect', 'note'], emergency ? 100 : 160) ?? entry,
      );
      if (directive.evidence.length > (emergency ? 1 : 3)) {
        compact.evidenceTruncated = { total: directive.evidence.length, shown: emergency ? 1 : 3 };
      }
    }
    const action = asDict(directive.action);
    if (action) {
      compact.action = pick(action, ['kind', 'summary', 'tool', 'args', 'recoveryRef', 'continuesCurrentWork'], emergency ? 100 : 180) ?? {};
      if (asDict(compact.action)?.targetRef !== undefined) delete (compact.action as Dict).targetRef;
    }
    return compact;
  });
  if (directives.length > (emergency ? 2 : 12)) {
    out.directivesTruncated = { total: directives.length, shown: emergency ? 2 : 12 };
  }
  const projection = asDict(source.projection);
  if (projection) {
    out.projection = {
      text: clip(projection.text, emergency ? 160 : 800) ?? projection.text,
      receipt: pick(projection.receipt, [
        'sink', 'mode', 'entriesAvailable', 'entriesDelivered', 'entriesOmitted',
        'bodyDeliveredChars', 'estimatedTokens', 'bodyTruncated', 'refused', 'reason',
      ], 100),
    };
  }
  const read = asDict(source.read);
  if (read) {
    out.read = {
      ...(pick(read, ['elapsedMs'], 60) ?? {}),
      ...(Array.isArray(read.degradedSources)
        ? { degradedSources: read.degradedSources.slice(0, emergency ? 1 : 3).map((entry) => clip(entry, 160) ?? entry) }
        : {}),
    };
  }
  return out;
}

function compactAnnouncedGate(value: unknown): unknown {
  return pick(value, ['event', 'note', 'scope', 'announcedBy', 'fired', 'firedAt', 'awaiters'], 180) ?? value;
}

/** History is optional detail, but its recovery identity must survive every tier. */
function compactPlanHistory(value: unknown, emergency = false): unknown {
  const source = asDict(value);
  if (!source) return value;
  const brief = asDict(source.brief);
  const rows = brief
    ? [
        ...(Array.isArray(brief.authority) ? brief.authority : []),
        ...(Array.isArray(brief.attempts) ? brief.attempts : []),
      ]
    : [];
  const shown = emergency
    ? []
    : rows.slice(0, 2).map((entry) => pick(entry, ['authority', 'rawRef', 'workItemId', 'text'], 160));
  return {
    status: source.status,
    recovery: source.recovery,
    ...(brief
      ? {
          fingerprint: brief.fingerprint,
          fanOut: brief.fanOut,
          records: shown,
          detailOmitted: emergency || rows.length > shown.length || asDict(brief.omission)?.truncated === true,
        }
      : {}),
  };
}

/** P-002 / D-004: compact the claimable aggregate as one atomic unit. The
 * verbose family evidence is full-tier diagnostic material; the bounded
 * monitor tiers retain the value, its exact population contract, and any
 * unknown reason together. */
function compactClaimableNow(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;

  const out: Dict = {};
  if ('value' in source) out.value = source.value;

  const interpretation = asDict(source.interpretation);
  if (interpretation) {
    const compactInterpretation = pick(interpretation, ['state'], 40) ?? {};
    const exactness = pick(interpretation.exactness, ['status', 'reason'], 180);
    if (exactness) compactInterpretation.exactness = exactness;
    const evidence = pick(interpretation.evidence, ['fleetPaused', 'matchedByFilter', 'excluded'], 220);
    if (evidence) compactInterpretation.evidence = evidence;
    out.interpretation = compactInterpretation;
  }

  const population = asDict(source.population);
  if (population) {
    const compactPopulation =
      pick(population, ['kind', 'fleet', 'harness', 'basis', 'matchedByFilter', 'note'], 180) ?? {};
    if ('spec' in population) {
      const spec = asDict(population.spec);
      compactPopulation.spec = spec
        ? (pick(spec, ['ref', 'revision', 'matchedBy', 'assigneeScoped', 'planScoped'], 140) ?? {})
        : population.spec;
    }
    out.population = compactPopulation;
  } else if ('population' in source) {
    out.population = source.population;
  }

  const unknown = pick(source.unknown, ['code', 'detail'], 220);
  if (unknown) out.unknown = unknown;
  return out;
}

/** Keep the productive-headcount provenance beside the six numeric fields while
 * bounding it to the stable, machine-readable fields emitted by the store. */
function compactHeadcountBasis(value: unknown): unknown {
  return (
    pick(
      value,
      // `executingMembers` is the population `current` is actually counted from
      // (WI-2034624); dropping it would leave a leader reading the count with no
      // way to see which population produced it.
      ['kind', 'liveRosterMembers', 'executingMembers', 'transactionWorkerReadyMembers'],
      120,
    ) ?? value
  );
}

/** P-005: validate and keep this bounded aggregate atomically. Its metadata is
 * what makes the counts comparable; dropping scope/window/population would
 * violate D-005 even if the numerals survived. */
function compactFleetMetrics(value: unknown): unknown {
  const parsed = fleetMetricsResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** P-006: keep the ranked dependency answer as one measured|unknown unit. The
 * graph reader already bounds rows, but each row can still carry long titles,
 * many coverage-twin work items, and several holder identities. */
function compactDependencyBottlenecks(value: unknown, rowCap: number): unknown {
  const source = asDict(value);
  if (!source) return value;

  if (source.status !== 'measured') {
    return pick(source, ['status', 'reason', 'planSlug', 'harnessSlug'], 180) ?? source;
  }

  const out: Dict = { status: 'measured' };
  const population = pick(
    source.population,
    [
      'kind',
      'planSlug',
      'harnessSlug',
      'basis',
      'openRoots',
      'candidates',
      'shown',
      'limit',
      'truncated',
      'depthLimited',
      'maxDepth',
      'progressBasis',
      'holderBasis',
    ],
    180,
  );
  if (population) out.population = population;

  if (Array.isArray(source.findings)) {
    out.findings = source.findings.slice(0, rowCap).map((value) => {
      const row = asDict(value);
      if (!row) return value;
      return (
        pick(
          row,
          [
            'code',
            'classification',
            'confidence',
            'nodes',
            'edges',
            'evidence',
            'provenance',
            'suggestedAction',
            'suppressedBy',
          ],
          220,
        ) ?? row
      );
    });
  }

  const rows = Array.isArray(source.rows) ? source.rows : [];
  out.rows = rows.slice(0, rowCap).map((value) => {
    const row = asDict(value);
    if (!row) return value;
    const compact =
      pick(
        row,
        ['rank', 'key', 'kind', 'ref', 'status', 'title', 'openBlockedCount', 'lastProgressAt', 'hoursSinceProgress'],
        160,
      ) ?? {};
    if (Array.isArray(row.workItemRefs)) {
      const refs = row.workItemRefs.filter((ref): ref is string => typeof ref === 'string');
      compact.workItemRefs = refs.slice(0, 4);
      if (refs.length > 4) compact.workItemRefsTruncated = { total: refs.length, shown: 4 };
    }
    const holder = asDict(row.holder);
    if (holder) {
      const compactHolder = pick(holder, ['state', 'count', 'truncated'], 120) ?? {};
      if (Array.isArray(holder.agents)) {
        compactHolder.agents = holder.agents
          .slice(0, 3)
          .map((agent) => pick(agent, ['agentId', 'label', 'alive', 'sessionState', 'verdict'], 120) ?? agent);
      }
      compact.holder = compactHolder;
    }
    return compact;
  });
  if (rows.length > rowCap) {
    out.rowsTruncated = {
      total: rows.length,
      shown: rowCap,
      more: 'fleet:leader-brief { payloadTier:"full" }',
    };
  }
  if (typeof source.mermaid === 'string') {
    // A clipped Mermaid document is syntactically invalid and can misrepresent
    // the graph. Preserve a small requested diagram whole; for a large one,
    // provide an explicit full-tier recovery pointer instead of partial text.
    if (source.mermaid.length <= 2_000) out.mermaid = source.mermaid;
    else {
      out.mermaidOmitted = {
        chars: source.mermaid.length,
        reason: 'bounded monitor projection never clips Mermaid',
        more: 'fleet:leader-brief { include_mermaid:true, payloadTier:"full" }',
      };
    }
  }
  return out;
}

/** P-009: keep the tri-state alarm, its triggering identity, and its falsifier
 * atomic in every monitor tier. This is already a one-row decision object, so
 * compaction clips prose only; it never drops the alarm's evidence. */
function compactLeaderBlockerStall(value: unknown, maxString = 180): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['status', 'alert', 'thresholdHours', 'checkedRows'], maxString) ?? {};
  if ('reason' in source) out.reason = clip(source.reason, maxString) ?? source.reason;
  const row = pick(source.row, ['rank', 'itemRef'], 120);
  if (row) out.row = row;
  const unknown = pick(source.unknown, ['code', 'sourceReason'], 140);
  if (unknown) out.unknown = unknown;
  if ('falsifier' in source) out.falsifier = compactFalsifier(source.falsifier, maxString);
  return out;
}

/** Emergency byte pressure keeps only the alarm decision, triggering identity,
 * unknown discriminator, and the same minimal falsifier handle used by the
 * other fleet-level detectors. Normal tiers retain the full reason/check. */
function compactEmergencyLeaderBlockerStall(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['status', 'alert'], 120) ?? {};
  const row = pick(source.row, ['rank', 'itemRef'], 120);
  if (row) out.row = row;
  const unknown = pick(source.unknown, ['code', 'sourceReason'], 120);
  if (unknown) out.unknown = unknown;
  if ('falsifier' in source) out.falsifier = compactEmergencyFalsifier(source.falsifier);
  return out;
}

function compactSummary(value: unknown, ultra = false): unknown {
  const source = asDict(value);
  if (!source) return value;
  const metricKeys = [
    'fleet',
    'members',
    'speaking',
    'monitoring',
    'waiting',
    'parked_awaiting_capability',
    'stalled',
    'dead',
    'unanswered_directed',
    'high_context',
    'critical_context',
    'parked',
    'intent_attention',
    'coord_deaf',
    'bench_suggested',
    'idle_with_claimable',
    'laneless_idle',
    'dormant',
    'spinning',
    'stalled_item',
    'throttled',
    'repeated_recovery',
    'darkFleetAlert',
    'fleetExecutionCollapseAlert',
    'fleetHeadcountVsExecutableFrontierAlert',
    'fleetUnderStaffedAlert',
    'leaderBlockerStallAlert',
    'customInvariantAlert',
    'unowned_criticals',
    'unowned_criticals_federated',
    'abandoned_unclaimed',
    'fleet_paused',
    'declaredPlanSpecDivergenceAlert',
  ];
  const out = pick(source, metricKeys, 120) ?? {};

  // P-005: cumulative counters are historical, not live gauges. Keep the
  // namespace explicit in every monitor tier and project only the bounded
  // counters currently defined by the leader-brief contract.
  const cumulative = pick(source.cumulative, ['admission_blocked'], 120);
  if (cumulative) out.cumulative = cumulative;

  // EI-21238131879315614: the verbose member rows are live-first and bounded, so
  // `dead` can otherwise be positive while every shown member looks live. Keep a
  // bounded identity list beside the aggregate; one named row is enough to falsify
  // or confirm a relaunch decision, and the total remains in `dead`.
  if (Array.isArray(source.dead_member_ids)) {
    const deadIds = source.dead_member_ids.filter((id): id is string => typeof id === 'string');
    out.dead_member_ids = deadIds.slice(0, 8);
    if (deadIds.length > 8) out.dead_member_ids_truncated = { total: deadIds.length, shown: 8 };
  }

  const population = pick(
    source.population,
    ['population', 'basis', 'candidates', 'counted', 'withheld', 'withheldReason', 'reveal'],
    150,
  );
  if (population) out.population = population;

  // P-004: preserve the canonical population/lifecycle contract as one atomic
  // object. Identity arrays are bounded here; full-tier callers retain the
  // complete snapshot emitted by buildFleetPopulationLifecycle.
  const lifecycle = asDict(source.populationLifecycle);
  if (lifecycle && !ultra) {
    const compactLifecycle: Dict =
      pick(
        lifecycle,
        ['schemaVersion', 'fleet', 'window', 'populationBasis', 'target', 'liveness', 'claimFlow'],
        180,
      ) ?? {};
    const lifecycleTarget = asDict(lifecycle.target);
    if (lifecycleTarget) {
      const compactTarget =
        pick(lifecycleTarget, ['enabled', 'target', 'current', 'shortfall', 'underStrength', 'verdict'], 120) ?? {};
      if ('basis' in lifecycleTarget) compactTarget.basis = compactHeadcountBasis(lifecycleTarget.basis);
      compactLifecycle.target = compactTarget;
    }
    for (const key of ['currentRunnableRoster', 'relevantRoster', 'everMembers'] as const) {
      const population = asDict(lifecycle[key]);
      if (!population) continue;
      const census = pick(
        population.census,
        ['population', 'basis', 'candidates', 'counted', 'withheld', 'withheldReason', 'reveal'],
        150,
      );
      const direct = pick(population, ['population', 'basis', 'writer', 'counted'], 150);
      const ownerIds = Array.isArray(population.ownerIds)
        ? population.ownerIds.filter((id): id is string => typeof id === 'string').slice(0, 8)
        : [];
      compactLifecycle[key] = {
        ...(direct ?? {}),
        ...(census ? { census } : {}),
        ownerIds,
        ...(Array.isArray(population.ownerIds) && population.ownerIds.length > ownerIds.length
          ? { ownerIdsTruncated: population.ownerIds.length }
          : {}),
      };
    }
    // P-019: membersLost must survive shaping, and survive it WHOLE. It is the only
    // population here that reports loss rather than presence, so a leader reading a
    // trimmed brief is exactly the reader who needs it — and it is projected apart
    // from the loop above because its scalars are `count`/`available` (not `counted`)
    // and because dropping `timing` would leave a bare count that invites the reader
    // to date the loss from the reaper's sweep, which is the misreading P-019 and
    // D-003 exist to prevent.
    const membersLost = asDict(lifecycle.membersLost);
    if (membersLost) {
      const lostOwnerIds = Array.isArray(membersLost.ownerIds)
        ? membersLost.ownerIds.filter((id): id is string => typeof id === 'string').slice(0, 4)
        : [];
      const timing = asDict(membersLost.timing);
      compactLifecycle.membersLost = {
        ...(pick(membersLost, ['available', 'count'], 60) ?? {}),
        ownerIds: lostOwnerIds,
        ...(Array.isArray(membersLost.ownerIds) && membersLost.ownerIds.length > lostOwnerIds.length
          ? { ownerIdsTruncated: membersLost.ownerIds.length }
          : {}),
        // Short form only: the marker a leader must see is that departure time is
        // UNMEASURED and which column answers it. The full rationale (D-003) rides
        // on the unshaped snapshot at full tier.
        ...(timing ? { timingStatus: timing.status, timingInsteadRead: 'coord_presence.last_active_at' } : {}),
      };
    }
    out.populationLifecycle = compactLifecycle;
  }

  const headcount = pick(
    source.headcount,
    ['enabled', 'target', 'current', 'shortfall', 'underStrength', 'verdict', 'basis', 'countEvidence'],
    120,
  );
  if (headcount && 'basis' in headcount) headcount.basis = compactHeadcountBasis(headcount.basis);
  if (headcount) out.headcount = headcount;

  // P-007 / R-17: the silent members `headcount.current` left out must survive
  // shaping, or a leader reads an under-strength fleet with no names to act on.
  const silentMembers = source.silentMembers;
  if (silentMembers && typeof silentMembers === 'object' && !Array.isArray(silentMembers)) {
    const sm = silentMembers as Record<string, unknown>;
    if (sm.status === 'measured' && Array.isArray(sm.ownerIds)) {
      const ids = sm.ownerIds.filter((id): id is string => typeof id === 'string');
      out.silentMembers = {
        status: 'measured',
        ownerIds: ids.slice(0, 8),
        ...(ids.length > 8 ? { ownerIdsTruncated: ids.length } : {}),
        thresholdMs: sm.thresholdMs,
        paused: sm.paused,
      };
    } else if (sm.status === 'unknown') {
      out.silentMembers = { status: 'unknown', reason: sm.reason };
    }
  }

  // WI-2034563: policy-parked capacity must survive shaping and sit BESIDE headcount.
  // Shaped away, a leader reads `underStrength` with nothing saying the missing seats
  // are alive and parked by their own directive — which is exactly the reading that
  // makes relaunching look like the fix. `message` carries the whole verdict, so it
  // is kept long enough to stay actionable (it names the gate to fire).
  const policyParked = pick(
    source.policyParked,
    ['members', 'kind', 'by', 'gate', 'expiresAt', 'expired', 'parkedForMs', 'indefinite', 'message'],
    420,
  );
  if (policyParked) out.policyParked = policyParked;

  if ('claimable_now' in source) out.claimable_now = compactClaimableNow(source.claimable_now);

  const pool = pick(
    source.pool_capacity,
    ['poolExhausted', 'degraded', 'factor', 'queueDepth', 'usableAccounts', 'availableAccounts'],
    120,
  );
  if (pool) out.pool_capacity = pool;

  // WI-583276: keep the execution-collapse tri-state and bounded evidence
  // alongside its alert decision in every normal monitor projection.
  const executionCollapse = pick(
    source.fleetExecutionCollapse,
    [
      'status',
      'rosterMembers',
      'agentOriginMembers',
      'heldClaimMembers',
      'heldClaims',
      'silentHeldClaimMembers',
      'windowMs',
    ],
    150,
  );
  if (executionCollapse) out.fleetExecutionCollapse = executionCollapse;

  if (!ultra && Array.isArray(source.degraded_roster_legs)) {
    out.degraded_roster_legs = source.degraded_roster_legs.slice(0, 3).map((entry) => clip(entry, 160) ?? entry);
    if (source.degraded_roster_legs.length > 3) out.degraded_roster_legs_truncated = source.degraded_roster_legs.length;
  }
  return out;
}

function compactMember(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out =
    pick(
      source,
      [
        'agentId',
        'label',
        'alive',
        'sessionState',
        'verdict',
        'wakeMode',
        'monitorState',
        'nextFireAt',
        'lastToolCallAgeMs',
        'intentAgeSec',
        'intentStale',
        'intentDivergent',
        'queuedCount',
        'load',
        'stalled',
        'contextPressure',
        'contextPressureAgeSec',
        'dormant',
        'spinning',
        'isSelf',
      ],
      120,
    ) ?? {};
  if (source.idleVerdict && typeof source.idleVerdict === 'object') {
    out.idleVerdict = pick(source.idleVerdict, ['cause', 'reason'], 160) ?? source.idleVerdict;
  }
  // P-004/R-4: the stalled-item rotation verdict is the actionable fact on this row —
  // keep its identity, age, ready count and required action under shaping.
  if (source.stalledItem && typeof source.stalledItem === 'object') {
    out.stalledItem =
      pick(source.stalledItem, ['item', 'noAdvanceMin', 'advancedAt', 'readyWaiting', 'requiredAction'], 400) ??
      source.stalledItem;
  }
  if (source.doing && typeof source.doing === 'object') {
    out.doing = pick(source.doing, ['id', 'title', 'status', 'activity'], 140) ?? source.doing;
  }
  const progress = asDict(source.checkpointProgress);
  if (progress) {
    const items = Array.isArray(progress.items) ? progress.items : [];
    out.checkpointProgress = {
      ...pick(progress, ['status', 'source', 'snapshotOnly', 'readAtMs', 'rosterItems', 'omitted', 'note'], 260),
      items: items.slice(0, 1).map((entry) => {
        const item = asDict(entry) ?? {};
        const note = typeof item.checkpoint === 'string' ? item.checkpoint : null;
        return {
          ...pick(item, [
            'id', 'harness', 'holderProof', 'status', 'checkpointUpdatedAtMs',
            'lastProgressAtMs', 'checkpointContentHash', 'checkpointChars', 'checks', 'walls', 'recovery',
          ], 140),
          checkpoint: clip(note, 240),
          checkpointTruncated: item.checkpointTruncated === true || (note?.length ?? 0) > 240,
          freshness: pick(item.freshness, [
            'basis', 'verdict', 'declared', 'changed', 'unresolvable', 'stale', 'lagMs', 'reason',
          ], 220),
        };
      }),
      itemsOmittedByProjection: Math.max(0, items.length - 1),
    };
  }
  if (source.unanswered && typeof source.unanswered === 'object') {
    out.unanswered = pick(source.unanswered, ['count', 'oldestAgeMs'], 100) ?? source.unanswered;
  }
  // P-009: the recovery block must be shaped explicitly or it is silently dropped here —
  // the flat allowlist above carries scalars only, so a nested object added upstream reaches
  // this shaper and disappears without any error. `reason` gets a longer budget than the
  // 120-char default because it is the containment cause a leader triages on; truncating it
  // to a prefix is the difference between an actionable row and a suggestive one.
  if (source.recovery && typeof source.recovery === 'object') {
    out.recovery = pick(source.recovery, ['disposition', 'reason', 'taskId', 'strandedAt'], 240) ?? source.recovery;
  }
  if (source.repeatedRecovery && typeof source.repeatedRecovery === 'object') {
    out.repeatedRecovery =
      pick(
        source.repeatedRecovery,
        ['consecutiveRecoveryOnlyCycles', 'action', 'takeoverAuthorized', 'guidance'],
        220,
      ) ?? source.repeatedRecovery;
  }
  if (Array.isArray(source.parkedOn) && source.parkedOn.length > 0) {
    out.parkedOn = source.parkedOn.slice(0, 3).map((entry) => clip(entry, 140) ?? entry);
  }
  if (source.benchSuggestion && typeof source.benchSuggestion === 'object') {
    out.benchSuggestion =
      pick(source.benchSuggestion, ['kind', 'item', 'itemTitle', 'reason'], 160) ?? source.benchSuggestion;
  }
  if (source.intentAttention && typeof source.intentAttention === 'object') {
    out.intentAttention = pick(source.intentAttention, ['kind', 'action', 'reason'], 180) ?? source.intentAttention;
  }
  if (source.throttled && typeof source.throttled === 'object') {
    out.throttled = pick(source.throttled, ['reason', 'until', 'resumesInMs'], 120) ?? source.throttled;
  }
  return out;
}

/**
 * EI-21242929839064139: this is an exceptional identity index, not another
 * verbose member sample. Keep only the target identity and branch so every
 * summary.bench_suggested row remains actionable under transport shaping.
 */
function compactBenchSuggestion(value: unknown): unknown {
  return pick(value, ['agentId', 'kind'], 120) ?? {};
}

/** P-012: complete exceptional identity/action row. Keep it as small as the
 * bench-target index while retaining the resolving action, not just the signal. */
function compactIntentAttention(value: unknown): unknown {
  return pick(value, ['agentId', 'kind', 'action'], 120) ?? {};
}

/** D-007: compact, complete repeated-recovery identity + authority row. */
function compactRepeatedRecovery(value: unknown): unknown {
  return pick(value, ['agentId', 'consecutiveRecoveryOnlyCycles', 'action', 'takeoverAuthorized'], 120) ?? {};
}

function compactVerdict(value: unknown): unknown {
  return pick(value, ['agentId', 'verdict', 'idleCause'], 120) ?? value;
}

/**
 * Emergency byte pressure may not be allowed to hide who is in the complete
 * member index. Keep the identity field in every row, while allowing verdict
 * detail to be omitted only in that explicitly marked emergency projection.
 */
function compactMemberIdentity(value: unknown): unknown {
  return pick(value, ['agentId'], 120) ?? {};
}

function compactAdvisory(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const keys = [
    'id',
    'workItemId',
    'itemId',
    'title',
    'summary',
    'status',
    'priority',
    'assignee',
    'holder',
    'origin',
    'activity',
    'progress',
  ];
  return pick(source, keys, 160) ?? {};
}

/**
 * EI-18680302159738037: a fleet-scope admission block, bounded for the monitor
 * transport. `itemId`/`member`/`specId`/`specRevision` are the ACTIONABLE core
 * (what was refused, to whom, and which spec+revision the leader edits) and are
 * kept whole; `reason` is the one field that can be long, so it clips.
 */
function compactAdmissionBlock(value: unknown): unknown {
  return (
    pick(value, ['itemId', 'member', 'specId', 'specRevision', 'code', 'occurrences', 'action', 'reason'], 160) ?? {}
  );
}

function compactInvariant(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out =
    pick(source, ['name', 'severity', 'status', 'violationCount', 'truncated', 'error', 'elapsedMs'], 160) ?? {};
  if (Array.isArray(source.rows)) {
    out.rows = source.rows.slice(0, 2).map((row) => {
      const record = asDict(row);
      if (!record) return row;
      const clipped: Dict = {};
      for (const [key, item] of Object.entries(record).slice(0, 8)) {
        clipped[key] =
          typeof item === 'string'
            ? clip(item, 120)
            : typeof item === 'number' || typeof item === 'boolean' || item === null
              ? item
              : String(item);
      }
      return clipped;
    });
    if (source.rows.length > 2) out.rowsTruncated = source.rows.length;
  }
  return out;
}

function compactReservation(value: unknown, cap: number): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['scarcity', 'counts', 'reason', 'note'], 160) ?? {};
  if (Array.isArray(source.members)) {
    out.members = source.members.slice(0, cap).map((entry) => compactMember(entry));
    if (source.members.length > cap) out.membersTruncated = { total: source.members.length, shown: cap };
  }
  return out;
}

function compactCampaignValue(value: unknown, recentCap: number, depth = 0): unknown {
  if (typeof value === 'string') return clip(value, depth <= 1 ? 150 : 100) ?? value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value))
    return value.slice(0, recentCap).map((entry) => compactCampaignValue(entry, recentCap, depth + 1));
  const source = asDict(value);
  if (!source) return String(value);
  const out: Dict = {};
  // EI-6803: terminal audit rows deliberately carry twelve small, independently
  // useful fields. The generic deep-object cap used to remove the final two
  // (`countsTowardBurnDown` and `terminalizedAt`) from the leader-facing result.
  // Preserve the whole typed audit row without widening arbitrary deep payloads.
  const fieldCap = depth >= 3 && 'terminalOwner' in source && 'terminalizedAt' in source ? 16 : depth >= 3 ? 10 : 20;
  for (const [key, item] of Object.entries(source).slice(0, fieldCap)) {
    if (key === 'rows' && Array.isArray(item)) {
      out.rows = item.slice(0, recentCap).map((entry) => compactCampaignValue(entry, recentCap, depth + 1));
      continue;
    }
    out[key] = compactCampaignValue(item, recentCap, depth + 1);
  }
  return out;
}

/** P-007: keep every campaign axis' availability/writer/units while bounding only
 * recent evidence rows. Exact aggregate scalars and the boundary always survive. */
export function compactCampaign(value: unknown, recentCap = 2): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out: Dict = {};
  if ('boundary' in source) out.boundary = compactCampaignValue(source.boundary, recentCap);
  if ('everMembers' in source) out.everMembers = compactCampaignValue(source.everMembers, recentCap);
  const axes = asDict(source.axes);
  if (axes) {
    const projected: Dict = {};
    for (const [name, axis] of Object.entries(axes)) {
      projected[name] = compactCampaignValue(axis, recentCap);
    }
    out.axes = projected;
  }
  return out;
}

/** Keep the campaign's boundary and per-axis availability/writer contract when
 * the emergency projection has no room for units and recent evidence rows. */
function compactEmergencyCampaign(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out: Dict = {};
  if ('boundary' in source) out.boundary = pick(source.boundary, ['at', 'source'], 120) ?? source.boundary;
  if ('everMembers' in source)
    out.everMembers = pick(source.everMembers, ['available', 'count'], 120) ?? source.everMembers;
  const axes = asDict(source.axes);
  if (axes) {
    out.axes = Object.fromEntries(
      Object.entries(axes).map(([name, axis]) => [name, pick(axis, ['available', 'writer'], 120) ?? axis]),
    );
  }
  return out;
}

function addCappedArray(out: Dict, source: Dict, key: string, cap: number, project: (value: unknown) => unknown): void {
  const rows = source[key];
  if (!Array.isArray(rows)) return;
  out[key] = rows.slice(0, cap).map(project);
  if (rows.length > cap)
    out[`${key}Truncated`] = {
      total: rows.length,
      shown: cap,
      more: 'fleet:leader-brief { payloadTier:"full" } or a narrow follow-up',
    };
}

/**
 * The compact member-verdict index is the identity recovery surface, not a
 * verbose sample. Keep every row's identity even when the surrounding monitor
 * projection has to shed detail for the result-door budget. The source is
 * already reduced to agentId/verdict/idleCause by leader-brief.ts, so retaining
 * the complete index is materially cheaper than retaining verbose member rows.
 */
function addCompleteMemberVerdictIndex(
  out: Dict,
  source: Dict,
  project: (value: unknown) => unknown = compactVerdict,
): void {
  const rows = source.memberVerdicts;
  if (!Array.isArray(rows)) return;
  out.memberVerdicts = rows.map(project);
}

function addAlertFields(out: Dict, source: Dict, maxString = 220): void {
  for (const [key, value] of Object.entries(source)) {
    // EI-18680302159738037: `*Action` joins the carried set. An advisory's RESOLVING
    // ACTION was being computed and then dropped by this projection, so the default
    // monitor read showed a count and rows with no remedy — and for both advisories
    // that emit one, the intuitive remedy is the WRONG verb (release is a no-op on
    // abandonedUnclaimed; a nudge cannot clear an admission block). Clipped like a
    // reason, so a long note cannot crowd out the decision core.
    if (
      !/(?:AlertReason|AlertFalsifier|Action)$/.test(key) &&
      key !== 'customInvariantAlertReason' &&
      key !== 'fleetPausedReason'
    )
      continue;
    out[key] = key.endsWith('Falsifier') ? compactFalsifier(value, maxString) : (clip(value, maxString) ?? value);
  }
}

function buildProjection(
  data: Dict,
  tier: LeaderBriefPayloadTier,
  caps: typeof TIER_CAPS.trimmed,
  campaignRecentRows: number,
): Dict {
  const out: Dict = { ok: data.ok === true };
  if (data.degraded === true) {
    out.degraded = true;
    if (Array.isArray(data.degradedLegs)) {
      out.degradedLegs = data.degradedLegs.slice(0, 6).map((entry) => clip(entry, 160) ?? entry);
      if (data.degradedLegs.length > 6) out.degradedLegsTruncated = data.degradedLegs.length;
    }
  }
  const tightDecisionCore = caps.memberVerdicts === 0 && caps.members === 0;
  const decisionStringCap = tightDecisionCore ? 100 : 220;
  for (const key of ['self', 'notLeader', 'leadershipClaimed']) {
    if (key in data)
      out[key] =
        pick(
          data[key],
          [
            'ownerId',
            'ownerLabel',
            'registeredLeader',
            'leaderState',
            'reason',
            'note',
            'claimWith',
            'previousLeader',
            'notified',
          ],
          180,
        ) ?? data[key];
  }
  if ('blockedAt' in data) {
    out.blockedAt = compactBlockedAt(data.blockedAt, decisionStringCap, !tightDecisionCore);
  }
  if ('monitoringBlindAdvisory' in data) {
    out.monitoringBlindAdvisory = compactMonitoringBlindAdvisory(data.monitoringBlindAdvisory);
  }
  if ('agentObligations' in data) out.agentObligations = compactAgentObligations(data.agentObligations);
  if ('ownerDirectives' in data) out.ownerDirectives = compactOwnerDirectives(data.ownerDirectives);
  if ('planHistory' in data) out.planHistory = compactPlanHistory(data.planHistory);
  if ('summary' in data) out.summary = compactSummary(data.summary);
  if ('dependencyBottlenecks' in data) {
    out.dependencyBottlenecks = compactDependencyBottlenecks(
      data.dependencyBottlenecks,
      tightDecisionCore ? 2 : tier === 'trimmed' ? 4 : 8,
    );
  }
  if ('leaderBlockerStall' in data) {
    out.leaderBlockerStall = compactLeaderBlockerStall(data.leaderBlockerStall, decisionStringCap);
  }
  if (Array.isArray(data.benchSuggestions)) {
    out.benchSuggestions = data.benchSuggestions.map(compactBenchSuggestion);
  }
  if (Array.isArray(data.intentAttention)) {
    out.intentAttention = data.intentAttention.map(compactIntentAttention);
  }
  if (Array.isArray(data.repeatedRecovery)) {
    out.repeatedRecovery = data.repeatedRecovery.map(compactRepeatedRecovery);
  }
  if ('deltaSummary' in data) out.deltaSummary = clip(data.deltaSummary, 220) ?? data.deltaSummary;
  if ('delta' in data) out.delta = data.delta;
  if ('campaign' in data) out.campaign = compactCampaign(data.campaign, campaignRecentRows);
  if ('fleetMetrics' in data) {
    const fleetMetrics = compactFleetMetrics(data.fleetMetrics);
    if (fleetMetrics !== undefined) out.fleetMetrics = fleetMetrics;
  }
  if ('idleCauses' in data) out.idleCauses = data.idleCauses;
  if ('reservation' in data) out.reservation = compactReservation(data.reservation, caps.reservationMembers);

  addCompleteMemberVerdictIndex(out, data);
  addCappedArray(out, data, 'members', caps.members, compactMember);
  for (const key of ['unownedCriticals', 'unownedCriticalsFederated', 'abandonedUnclaimed', 'orphanedInFlight']) {
    addCappedArray(out, data, key, caps.advisories, compactAdvisory);
  }
  // EI-18680302159738037: admission blocks project through their OWN compactor —
  // compactAdvisory's key set (workItemId/title/status/assignee/…) shares not one
  // field with a block, so routing them through it would emit `{}` per row: a
  // count with rows that say nothing, which is how this signal got ignored the
  // first time.
  addCappedArray(out, data, 'admissionBlocked', caps.advisories, compactAdmissionBlock);
  if (Array.isArray(data.customInvariants)) {
    addCappedArray(out, data, 'customInvariants', caps.invariants, compactInvariant);
  }
  if (Array.isArray(data.announcedGates)) {
    addCappedArray(out, data, 'announcedGates', caps.announcedGates, compactAnnouncedGate);
  }
  // P-025 / D-053 ruling 4: a class added to a STRUCTURED sink must carry its
  // per-tier cap here, or it silently breaks the shaper's budget contract.
  // Fact KEYS are short, so the cap is generous relative to the verbose rows
  // above — but it is still a cap, and truncation stays disclosed via
  // `neverDropFactsTruncated` rather than clipping the JSON.
  if (Array.isArray(data.neverDropFacts)) {
    addCappedArray(out, data, 'neverDropFacts', caps.neverDropFacts, (value) => value);
  }
  addAlertFields(out, data, decisionStringCap);

  for (const key of [
    'specRevision',
    'specUpdatedBy',
    'specUpdatedAt',
    'harnessWidePool',
    'specMatched',
    'fleetPausedReason',
  ]) {
    if (key in data) out[key] = typeof data[key] === 'string' ? clip(data[key], 180) : data[key];
  }
  if (data.specFilter !== undefined) {
    const serialized = (() => {
      try {
        return JSON.stringify(data.specFilter);
      } catch {
        return '';
      }
    })();
    if (serialized.length <= 500) out.specFilter = data.specFilter;
    else
      out.specFilterOmitted = {
        reason: 'bounded for monitor transport',
        chars: serialized.length,
        more: 'scheduler:get_claim_spec { fleet }',
      };
  }

  out.leaderBriefProjection = {
    tier,
    memberVerdicts: Array.isArray(data.memberVerdicts)
      ? { shown: data.memberVerdicts.length, total: data.memberVerdicts.length, complete: true }
      : undefined,
    repeatedRecovery: Array.isArray(data.repeatedRecovery)
      ? { shown: data.repeatedRecovery.length, total: data.repeatedRecovery.length, complete: true }
      : undefined,
    members: Array.isArray(data.members)
      ? { shown: Math.min(caps.members, data.members.length), total: data.members.length }
      : undefined,
    note: 'Default monitor projection keeps the decision core; use payloadTier:"full" or narrow follow-up reads for detail.',
  };
  return out;
}

/**
 * Shape both declared tiers with the same monitor contract. `standard` keeps a
 * few more rows, while the hard-ceiling path invokes `trimmed` so the default
 * full call remains below the result door too.
 */
export function shapeLeaderBrief(data: unknown, tier: LeaderBriefPayloadTier): unknown {
  const source = asDict(data);
  if (!source) return data;
  const initial = TIER_CAPS[tier];
  const attempts = [
    { caps: initial, campaignRecentRows: tier === 'trimmed' ? 1 : 2 },
    {
      caps: {
        ...initial,
        memberVerdicts: 4,
        members: 2,
        advisories: 1,
        invariants: 1,
        announcedGates: 2,
        reservationMembers: 1,
      },
      campaignRecentRows: 1,
    },
    {
      // P-025: never-drop facts are GUARD RAILS and their keys are short, so they
      // are shed LAST — a leader that loses its wall facts to a budget squeeze is
      // exactly the "antidote absent where the poison is strongest" failure this
      // class exists to prevent. They cost a few characters; verbose rows go first.
      caps: { memberVerdicts: 2, members: 1, advisories: 1, invariants: 1, announcedGates: 1, reservationMembers: 1, neverDropFacts: 6 },
      // Preserve every campaign axis and its exact aggregates before sacrificing
      // the pre-existing truthful truncation pointers. Recent rows remain
      // available from a standard/full follow-up and are the only lossy field.
      campaignRecentRows: 0,
    },
    {
      // Last normal projection: retain one actionable member row plus truthful
      // zero-shown pointers for every other high-fanout family. This is still
      // materially richer than the emergency tier and keeps campaign aggregates.
      caps: { memberVerdicts: 1, members: 1, advisories: 0, invariants: 0, announcedGates: 1, reservationMembers: 0, neverDropFacts: 4 },
      campaignRecentRows: 0,
    },
    {
      // D-004 adds a load-bearing nested population contract to claimable_now.
      // If that contract is the difference between the last one-row attempt and
      // the ceiling, keep the complete compact exceptional indexes + campaign
      // aggregates and truthfully report zero verbose rows before falling all
      // the way to the emergency projection (which drops campaign entirely).
      // Last attempt before the emergency projection: every verbose row is gone,
      // but two guard-rail fact keys still fit and are worth more here than
      // anything else on this list.
      caps: { memberVerdicts: 0, members: 0, advisories: 0, invariants: 0, announcedGates: 1, reservationMembers: 0, neverDropFacts: 2 },
      campaignRecentRows: 0,
    },
  ];
  for (const attempt of attempts) {
    const out = buildProjection(source, tier, attempt.caps, attempt.campaignRecentRows);
    if (JSON.stringify(out).length <= LEADER_BRIEF_SHAPER_BUDGET_CHARS) return out;
  }
  // A pathological invariant/reason string must not defeat the safety rail.
  const emergencySummary = compactSummary(source.summary, true);
  const emergencySummaryRecord = asDict(emergencySummary);
  // The top-level emergency alarm below already preserves the verdict and
  // triggering identity. Carrying the same boolean in summary would spend the
  // last bytes twice while crowding out the evidence that makes it actionable.
  if (source.leaderBlockerStall !== undefined && emergencySummaryRecord) {
    delete emergencySummaryRecord.leaderBlockerStallAlert;
  }
  const emergency: Dict = {
    ok: source.ok === true,
    ...(source.degraded === true ? { degraded: true } : {}),
    ...(Array.isArray(source.degradedLegs)
      ? {
          degradedLegs: source.degradedLegs.slice(0, 6).map((entry) => clip(entry, 160) ?? entry),
          ...(source.degradedLegs.length > 6 ? { degradedLegsTruncated: source.degradedLegs.length } : {}),
        }
      : {}),
    ...(source.planHistory !== undefined ? { planHistory: compactPlanHistory(source.planHistory, true) } : {}),
    ...(source.blockedAt !== undefined ? { blockedAt: compactBlockedAt(source.blockedAt, 20, false) } : {}),
    ...(source.monitoringBlindAdvisory !== undefined
      ? { monitoringBlindAdvisory: compactMonitoringBlindAdvisory(source.monitoringBlindAdvisory) }
      : {}),
    ...(source.agentObligations !== undefined
      ? { agentObligations: compactAgentObligations(source.agentObligations, true) }
      : {}),
    ...(source.ownerDirectives !== undefined
      ? { ownerDirectives: compactOwnerDirectives(source.ownerDirectives, true) }
      : {}),
    ...(source.summary !== undefined ? { summary: emergencySummary } : {}),
    ...(source.dependencyBottlenecks !== undefined
      ? { dependencyBottlenecks: compactDependencyBottlenecks(source.dependencyBottlenecks, 1) }
      : {}),
    ...(source.leaderBlockerStall !== undefined
      ? { leaderBlockerStall: compactEmergencyLeaderBlockerStall(source.leaderBlockerStall) }
      : {}),
    ...(source.fleetMetrics !== undefined ? { fleetMetrics: compactFleetMetrics(source.fleetMetrics) } : {}),
    leaderBriefProjection: {
      tier,
      emergency: true,
    },
  };
  // P-010/P-011: keep fleet-level detector evidence at the emergency tier too.
  for (const alert of [
    'darkFleetAlert',
    'fleetExecutionCollapseAlert',
    'fleetHeadcountVsExecutableFrontierAlert',
    'fleetUnderStaffedAlert',
  ]) {
    const reasonKey = `${alert}Reason`;
    const falsifierKey = `${alert}Falsifier`;
    if (source[reasonKey] !== undefined) {
      emergency[reasonKey] = clip(source[reasonKey], 140) ?? source[reasonKey];
    }
    if (source[falsifierKey] !== undefined) {
      emergency[falsifierKey] = compactEmergencyFalsifier(source[falsifierKey]);
    }
  }
  if (Array.isArray(source.benchSuggestions)) {
    emergency.benchSuggestions = source.benchSuggestions.map(compactBenchSuggestion);
  }
  if (Array.isArray(source.intentAttention)) {
    emergency.intentAttention = source.intentAttention.map(compactIntentAttention);
  }
  if (Array.isArray(source.repeatedRecovery)) {
    emergency.repeatedRecovery = source.repeatedRecovery.map(compactRepeatedRecovery);
  }
  // Emergency is a byte-pressure tier, not permission to turn bounded arrays
  // into unexplained omissions. Keep the complete member identity index and
  // retain truthful zero-shown pointers for every dropped family. Verdict detail
  // is the one field allowed to yield to identity when the emergency budget is
  // tight; the projection marker below makes that loss explicit.
  //
  // EI-18680302159738037: an admission block outranks the ordinary member sample.
  // The live 27-member reproduction reached this tier with
  // summary.cumulative.admission_blocked=6 but admissionBlocked shown=0,
  // recreating the exact failure this field fixes:
  // a leader knew *something* was blocked but could not see item/member/spec.
  // Spend the existing verbose-member slot on one compact block instead, and
  // carry its resolving action. The identity index remains complete.
  const hasAdmissionBlocks = Array.isArray(source.admissionBlocked) && source.admissionBlocked.length > 0;
  addCompleteMemberVerdictIndex(emergency, source, compactMemberIdentity);
  const emergencyProjection = emergency.leaderBriefProjection as Dict;
  if (Array.isArray(source.memberVerdicts)) {
    emergencyProjection.memberVerdicts = {
      shown: source.memberVerdicts.length,
      total: source.memberVerdicts.length,
      complete: true,
      identityOnly: true,
    };
  }
  if (Array.isArray(source.repeatedRecovery)) {
    emergencyProjection.repeatedRecovery = {
      shown: source.repeatedRecovery.length,
      total: source.repeatedRecovery.length,
      complete: true,
    };
  }
  addCappedArray(emergency, source, 'members', hasAdmissionBlocks ? 0 : 1, compactMember);
  for (const key of ['unownedCriticals', 'unownedCriticalsFederated', 'abandonedUnclaimed', 'orphanedInFlight']) {
    addCappedArray(emergency, source, key, 0, compactAdvisory);
  }
  addCappedArray(emergency, source, 'admissionBlocked', hasAdmissionBlocks ? 1 : 0, compactAdmissionBlock);
  if (hasAdmissionBlocks && source.admissionBlockedAction !== undefined) {
    emergency.admissionBlockedAction = clip(source.admissionBlockedAction, 220) ?? source.admissionBlockedAction;
  }
  addCappedArray(emergency, source, 'customInvariants', 0, compactInvariant);
  // The emergency tier is already at the byte ceiling before dynamic gates;
  // `leaderBriefProjection.emergency` is the explicit signal that detail was
  // shed. Normal monitor tiers retain 4/8 actionable rows and a recovery pointer.
  if (source.specFilter !== undefined) {
    emergency.specFilterOmitted = {
      reason: 'bounded for monitor transport',
      chars: (() => {
        try {
          return JSON.stringify(source.specFilter).length;
        } catch {
          return null;
        }
      })(),
      more: 'scheduler:get_claim_spec { fleet }',
    };
  }
  if (source.campaign !== undefined) {
    const campaign = compactEmergencyCampaign(source.campaign);
    if (JSON.stringify({ ...emergency, campaign }).length <= LEADER_BRIEF_SHAPER_BUDGET_CHARS) {
      emergency.campaign = campaign;
    }
  }
  return emergency;
}
