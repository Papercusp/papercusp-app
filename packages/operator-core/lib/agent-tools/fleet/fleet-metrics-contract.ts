/**
 * Canonical wire contract for fleet-scoped work metrics.
 *
 * This module deliberately contains no datastore reads. It is the executable
 * boundary shared by the metric kernel, burn-down, leader brief, orient, and UI
 * consumers. The reader lands in P-002; this contract makes it impossible for a
 * reader to publish an unlabeled count, silently substitute a current claim spec
 * for missing history, or compare unlike populations as though they were one.
 */
import { z } from 'zod';
import type { FleetPopulationLifecycleSnapshot } from './fleet-population';
import { COUNT_EVIDENCE_COMPARISON_RULE } from '../../count-evidence-contract';
import { WORK_ITEM_PRESENTATION_STAGES } from '../../work-item-presentation-contract';

export const FLEET_METRICS_SCHEMA_VERSION = 'fleet-metrics-v1' as const;

export const FLEET_METRIC_REMAINING_BUCKETS = [
  'needsHuman',
  'blocked',
  'claimHeld',
  'inFlight',
  'claimable',
  'otherUnclaimable',
] as const;

/**
 * Stable precedence for the mutually-exclusive remaining-work partition.
 *
 * The underlying scheduler floors overlap. A row may, for example, be assigned,
 * dependency-blocked, and needs-human at once. Publishing those floor counts as
 * a partition is therefore false. The canonical metric assigns each nonterminal
 * row to the FIRST matching disposition below; `otherUnclaimable` is the honest
 * exhaustive catch-all for a scheduler floor not represented by a named bucket.
 */
export const FLEET_METRIC_REMAINING_PRECEDENCE = [
  'needsHuman',
  'blocked',
  'claimHeld',
  'inFlight',
  'claimable',
  'otherUnclaimable',
] as const;

export const FLEET_METRIC_UNITS = {
  workItems: 'distinct canonical issue-family work-item ids',
  canonicalBugs: 'distinct canonical work-item ids whose kind is bug',
  observations: 'observation-lane work-item rows, excluded from canonical bug counts',
  occurrences: 'append-only harness_shared.work_item_occurrences rows',
  duplicateOccurrences: 'occurrence rows that did not create a new canonical work item',
  members: 'distinct coordination owner ids',
} as const;

export const FLEET_METRIC_WRITERS = {
  workItems: 'harness_shared.work_items',
  occurrences: 'harness_shared.work_item_occurrences',
  membership: 'harness_shared.fleet_membership_events',
  claimSpecs: 'harness_shared.cup_claim_specs',
  claimSpecHistory: 'harness_shared.cup_claim_spec_revisions',
} as const;

export const FLEET_METRIC_POPULATIONS = {
  currentRunnableRoster: 'current-runnable-roster',
  relevantRoster: 'relevant-roster',
  everMembers: 'ever-members',
  currentSpecWorkItems: 'current-spec-work-items',
  atEventSpecWorkItemEvents: 'at-event-spec-work-item-events',
  canonicalBugs: 'canonical-bug-work-items',
  observations: 'observation-work-item-rows',
  occurrences: 'work-item-occurrence-rows',
  terminalAuthority: 'lifecycle-terminal-work-items',
} as const;

/** Backward-compatible fleet name for the shared count-contract rule. */
export const FLEET_METRIC_COMPARISON_RULE = COUNT_EVIDENCE_COMPARISON_RULE;

/**
 * The admission identity that every current-spec `claimable` count must satisfy.
 * Rank changes ordering only; it never changes membership in the measured set.
 */
export const FLEET_METRIC_ADMISSION_PARITY = {
  oracle: 'scheduler:get_next',
  filterEvaluator: 'matchesClaimSpecFilter',
  floors: 'aggregateIssueClaimExclusions/ALL_ISSUE_CLAIM_FLOORS_PASS',
  population: 'current-spec rows passing the spec filter and every scheduler hard floor',
  rankAffectsPopulation: false,
} as const;

const nonNegativeInt = z.number().int().nonnegative();
const isoDateTime = z.string().datetime({ offset: true });
const nonEmpty = z.string().min(1);

export const fleetMetricWindowSchema = z
  .object({
    kind: z.literal('fleet-lifetime'),
    startAt: isoDateTime,
    endAt: isoDateTime,
    startInclusive: z.literal(true),
    endExclusive: z.literal(true),
    startSource: z.literal('fleet-created-at'),
    endSource: z.literal('snapshot-generated-at'),
  })
  .superRefine((window, ctx) => {
    if (Date.parse(window.endAt) <= Date.parse(window.startAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endAt'],
        message: 'fleet-lifetime endAt must be after startAt',
      });
    }
  });

export const fleetMetricCurrentSpecScopeSchema = z.object({
  mode: z.literal('current-spec'),
  specId: nonEmpty,
  revision: nonNegativeInt,
  source: z.enum(['cup', 'fleet', 'default']),
  appliedTo: z.literal('all-counted-items'),
});

export const fleetMetricAtEventSpecScopeSchema = z.object({
  mode: z.literal('at-event-spec'),
  specId: nonEmpty,
  currentRevision: nonNegativeInt,
  revision: z.literal('effective-at-event'),
  historyWriter: z.literal(FLEET_METRIC_WRITERS.claimSpecHistory),
  appliedTo: z.literal('each-event-at-its-event-time'),
  missingRevision: z.literal('unavailable-never-current-fallback'),
});

export const fleetMetricScopeSchema = z
  .object({
    fleet: nonEmpty,
    harness: nonEmpty,
    window: fleetMetricWindowSchema,
    /** Remaining stock is always a current-state question. */
    stock: fleetMetricCurrentSpecScopeSchema,
    /** Flow may intentionally be re-read through today's spec or historical revisions. */
    flow: z.discriminatedUnion('mode', [fleetMetricCurrentSpecScopeSchema, fleetMetricAtEventSpecScopeSchema]),
    attribution: z.object({
      membership: z.literal(FLEET_METRIC_POPULATIONS.everMembers),
      writer: z.literal(FLEET_METRIC_WRITERS.membership),
      memberCount: nonNegativeInt,
      rule: z.literal('actor owner id is in the fleet append-only ever-member cohort'),
    }),
    population: z.object({
      currentRunnableRoster: z.literal(FLEET_METRIC_POPULATIONS.currentRunnableRoster),
      relevantRoster: z.literal(FLEET_METRIC_POPULATIONS.relevantRoster),
      attribution: z.literal(FLEET_METRIC_POPULATIONS.everMembers),
      stock: z.literal(FLEET_METRIC_POPULATIONS.currentSpecWorkItems),
      flow: z.enum([FLEET_METRIC_POPULATIONS.currentSpecWorkItems, FLEET_METRIC_POPULATIONS.atEventSpecWorkItemEvents]),
      canonicalBugs: z.literal(FLEET_METRIC_POPULATIONS.canonicalBugs),
      observations: z.literal(FLEET_METRIC_POPULATIONS.observations),
      occurrences: z.literal(FLEET_METRIC_POPULATIONS.occurrences),
      terminalAuthority: z.literal(FLEET_METRIC_POPULATIONS.terminalAuthority),
      comparisonRule: z.literal(FLEET_METRIC_COMPARISON_RULE),
    }),
  })
  .superRefine((scope, ctx) => {
    if (scope.flow.specId !== scope.stock.specId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'specId'],
        message: 'stock and flow must resolve the same claim spec id',
      });
    }

    if (scope.flow.mode === 'current-spec') {
      if (scope.flow.revision !== scope.stock.revision || scope.flow.source !== scope.stock.source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['flow'],
          message: 'current-spec stock and flow must share spec revision and source',
        });
      }
      if (scope.population.flow !== FLEET_METRIC_POPULATIONS.currentSpecWorkItems) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['population', 'flow'],
          message: 'current-spec flow must declare the current-spec work-item population',
        });
      }
      return;
    }

    if (scope.flow.currentRevision !== scope.stock.revision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'currentRevision'],
        message: 'at-event flow currentRevision must match the current stock revision',
      });
    }
    if (scope.population.flow !== FLEET_METRIC_POPULATIONS.atEventSpecWorkItemEvents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['population', 'flow'],
        message: 'at-event flow must declare the at-event-spec work-item-event population',
      });
    }
  });

export const fleetMetricExactnessSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('exact'),
    sourceCap: z.null(),
  }),
  z.object({
    status: z.literal('truncated'),
    sourceCap: z.number().int().positive(),
    fetched: nonNegativeInt,
    reason: nonEmpty,
    recoverVia: nonEmpty,
  }),
]);

export const fleetMetricFreshnessSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('fresh'),
    measuredAt: isoDateTime,
    staleAfterMs: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('stale'),
    measuredAt: isoDateTime,
    staleAfterMs: z.number().int().positive(),
    reason: nonEmpty,
    recoverVia: nonEmpty,
  }),
]);

export const fleetMetricQualitySchema = z.object({
  exactness: fleetMetricExactnessSchema,
  freshness: fleetMetricFreshnessSchema,
});

const attributionPartitionSchema = z.object({
  fleet: nonNegativeInt,
  otherAgents: nonNegativeInt,
  system: nonNegativeInt,
  unattributed: nonNegativeInt,
  partitions: z.literal(true),
  membershipBasis: z.literal('ever-members'),
});

const authorityPartitionSchema = z
  .object({
    lifecycleTerminal: nonNegativeInt,
    counted: nonNegativeInt,
    committed: nonNegativeInt,
    validated: nonNegativeInt,
    proposed: nonNegativeInt,
    pendingHuman: nonNegativeInt,
    invalid: nonNegativeInt,
    legacy: nonNegativeInt,
    partitionsLifecycleTerminal: z.literal(true),
    countedRule: z.literal('committed + validated + legacy'),
  })
  .superRefine((authority, ctx) => {
    const partitioned =
      authority.committed +
      authority.validated +
      authority.proposed +
      authority.pendingHuman +
      authority.invalid +
      authority.legacy;
    if (partitioned !== authority.lifecycleTerminal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['partitionsLifecycleTerminal'],
        message: 'authority buckets must sum to lifecycleTerminal',
      });
    }
    if (authority.counted !== authority.committed + authority.validated + authority.legacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counted'],
        message: 'counted terminal work is committed + validated + legacy',
      });
    }
  });

const remainingSchema = z
  .object({
    total: nonNegativeInt,
    unit: z.literal(FLEET_METRIC_UNITS.workItems),
    buckets: z.object({
      needsHuman: nonNegativeInt,
      blocked: nonNegativeInt,
      claimHeld: nonNegativeInt,
      inFlight: nonNegativeInt,
      claimable: nonNegativeInt,
      otherUnclaimable: nonNegativeInt,
    }),
    mutuallyExclusive: z.literal(true),
    precedence: z.tuple([
      z.literal('needsHuman'),
      z.literal('blocked'),
      z.literal('claimHeld'),
      z.literal('inFlight'),
      z.literal('claimable'),
      z.literal('otherUnclaimable'),
    ]),
  })
  .superRefine((remaining, ctx) => {
    const partitioned = FLEET_METRIC_REMAINING_BUCKETS.reduce((sum, key) => sum + remaining.buckets[key], 0);
    if (partitioned !== remaining.total) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buckets'],
        message: 'remaining buckets must be mutually exclusive and sum to total',
      });
    }
  });

const issueUnitsSchema = z
  .object({
    canonicalBugs: nonNegativeInt,
    observations: nonNegativeInt,
    occurrences: nonNegativeInt,
    duplicateOccurrences: nonNegativeInt,
    separateUnits: z.literal(true),
    units: z.object({
      canonicalBugs: z.literal(FLEET_METRIC_UNITS.canonicalBugs),
      observations: z.literal(FLEET_METRIC_UNITS.observations),
      occurrences: z.literal(FLEET_METRIC_UNITS.occurrences),
      duplicateOccurrences: z.literal(FLEET_METRIC_UNITS.duplicateOccurrences),
    }),
    writers: z.object({
      canonicalBugs: z.literal(FLEET_METRIC_WRITERS.workItems),
      observations: z.literal(FLEET_METRIC_WRITERS.workItems),
      occurrences: z.literal(FLEET_METRIC_WRITERS.occurrences),
    }),
  })
  .superRefine((units, ctx) => {
    if (units.duplicateOccurrences > units.occurrences) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duplicateOccurrences'],
        message: 'duplicate occurrences are a subset of occurrence rows',
      });
    }
  });

/**
 * P-001 (feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01, R-1/R-11..R-14).
 *
 * The flow/authority blocks above count ISSUE-family rows only, so a feature fleet whose
 * claim spec admits only feature rows read `terminal 0` while it was closing features
 * (WI-10004580: four committed + two proposed feature closes were invisible). Feature
 * outcomes are therefore their own population: only feature-family closes count, the
 * supporting tasks/bugs closed in the same window are listed apart and never added in,
 * every close is labelled fleet-done / inherited / unknown, and authority stays partitioned
 * so a proposed close is never a committed outcome.
 */
export const FLEET_METRIC_FEATURE_INHERITED_CLAIM_TO_CLOSE_MAX_MS = 2 * 60 * 60 * 1000;

export const FLEET_METRIC_FEATURE_ORIGIN_RULE =
  'inherited = work history shows a worker outside the fleet ever-member cohort before the closing claim AND closedAt minus that closing claim is at most claimToCloseMaxMs; fleet-done = history present otherwise; unknown = no work history recorded for the row' as const;

export const FLEET_METRIC_PAUSED_TIME_RULE =
  'workingMs = windowMs - pausedMs, where pausedMs is the union of fleet pause/wind-down intervals clipped to the window' as const;

const unknownMeasureSchema = z.object({
  status: z.literal('unknown'),
  reason: nonEmpty,
  recoverVia: nonEmpty,
});

const featureOriginSchema = z.object({
  fleetDone: nonNegativeInt,
  inherited: nonNegativeInt,
  unknown: nonNegativeInt,
  partitionsLifecycleTerminal: z.literal(true),
  claimToCloseMaxMs: z.literal(FLEET_METRIC_FEATURE_INHERITED_CLAIM_TO_CLOSE_MAX_MS),
  rule: z.literal(FLEET_METRIC_FEATURE_ORIGIN_RULE),
  historyWriter: z.literal('harness_shared.work_items.worked_by_history'),
});

const featureSupportingSchema = z
  .object({
    unit: z.literal('distinct canonical issue-family work-item ids'),
    tasks: nonNegativeInt,
    bugs: nonNegativeInt,
    other: nonNegativeInt,
    total: nonNegativeInt,
    countedInFeatureOutcomes: z.literal(false),
  })
  .superRefine((supporting, ctx) => {
    if (supporting.tasks + supporting.bugs + supporting.other !== supporting.total) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['total'], message: 'supporting buckets must sum to total' });
    }
  });

export const fleetFeatureOutcomesSchema = z.discriminatedUnion('status', [
  unknownMeasureSchema,
  z
    .object({
      status: z.literal('measured'),
      unit: z.literal('distinct canonical feature-family work-item ids'),
      population: z.literal('feature-family-lifecycle-terminal-in-window'),
      closes: authorityPartitionSchema,
      origin: featureOriginSchema,
      shipped: z.discriminatedUnion('status', [
        z.object({ status: z.literal('measured'), count: nonNegativeInt }),
        unknownMeasureSchema,
      ]),
      supporting: featureSupportingSchema,
    })
    .superRefine((outcomes, ctx) => {
      const { fleetDone, inherited, unknown } = outcomes.origin;
      if (fleetDone + inherited + unknown !== outcomes.closes.lifecycleTerminal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['origin'],
          message: 'origin buckets must partition closes.lifecycleTerminal',
        });
      }
    }),
]);

export const fleetPausedTimeSchema = z.discriminatedUnion('status', [
  unknownMeasureSchema,
  z
    .object({
      status: z.literal('measured'),
      windowMs: nonNegativeInt,
      pausedMs: nonNegativeInt,
      workingMs: nonNegativeInt,
      intervalCount: nonNegativeInt,
      openAtGeneratedAt: z.boolean(),
      source: z.literal('harness_shared.tool_invocations fleet:pause|fleet:wind-down -> fleet:resume'),
      rule: z.literal(FLEET_METRIC_PAUSED_TIME_RULE),
    })
    .superRefine((paused, ctx) => {
      if (paused.pausedMs + paused.workingMs !== paused.windowMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workingMs'],
          message: 'workingMs must equal windowMs - pausedMs',
        });
      }
    }),
]);

export const fleetMetricsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(FLEET_METRICS_SCHEMA_VERSION),
    generatedAt: isoDateTime,
    scope: fleetMetricScopeSchema,
    quality: fleetMetricQualitySchema,
    flow: z.object({
      opened: nonNegativeInt,
      terminalLifecycle: nonNegativeInt,
      terminalCounted: nonNegativeInt,
      netLifecycle: z.number().int(),
      netCounted: z.number().int(),
      unit: z.literal(FLEET_METRIC_UNITS.workItems),
      openedBy: attributionPartitionSchema,
      terminalBy: attributionPartitionSchema,
    }),
    remaining: remainingSchema,
    authority: authorityPartitionSchema,
    issueUnits: issueUnitsSchema,
    intakeStages: z.object({
      population: nonNegativeInt,
      unit: z.literal('work-item rows'),
      counts: z.record(z.enum(WORK_ITEM_PRESENTATION_STAGES), nonNegativeInt),
      remainingBugs: nonNegativeInt,
      verifiedCompletions: nonNegativeInt,
      mutuallyExclusive: z.literal(true),
      writer: z.literal('deriveWorkItemPresentationStage'),
      scope: z.literal('current-spec issue-family rows including observation evidence'),
      window: z.literal('current stock at generatedAt'),
    }).superRefine((report, ctx) => {
      if (WORK_ITEM_PRESENTATION_STAGES.reduce((sum, stage) => sum + (report.counts[stage] ?? 0), 0) !== report.population
        || WORK_ITEM_PRESENTATION_STAGES.some(stage => report.counts[stage] === undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['counts'], message: 'intake stages must partition the declared population once' });
      }
      if (report.verifiedCompletions !== report.counts['verified-completion']) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verifiedCompletions'], message: 'verified delivery must equal the verified-completion stage' });
      }
    }).optional(),
    // Optional for backwards-compatible parsing of pre-P-004 snapshots; the
    // canonical resolver and burn-down writer always emit it for fleet reads.
    populationLifecycle: z.custom<FleetPopulationLifecycleSnapshot>().optional(),
    // P-001: optional only so pre-P-001 snapshots still parse; buildFleetMetricsResult
    // always emits both, as `unknown` (never zero) when the population was not measured.
    featureOutcomes: fleetFeatureOutcomesSchema.optional(),
    pausedTime: fleetPausedTimeSchema.optional(),
    admissionParity: z.object({
      oracle: z.literal(FLEET_METRIC_ADMISSION_PARITY.oracle),
      filterEvaluator: z.literal(FLEET_METRIC_ADMISSION_PARITY.filterEvaluator),
      floors: z.literal(FLEET_METRIC_ADMISSION_PARITY.floors),
      population: z.literal(FLEET_METRIC_ADMISSION_PARITY.population),
      rankAffectsPopulation: z.literal(false),
    }),
  })
  .superRefine((snapshot, ctx) => {
    const openedBy = snapshot.flow.openedBy;
    const openedPartition = openedBy.fleet + openedBy.otherAgents + openedBy.system + openedBy.unattributed;
    if (openedPartition !== snapshot.flow.opened) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'openedBy'],
        message: 'openedBy buckets must partition flow.opened',
      });
    }

    const terminalBy = snapshot.flow.terminalBy;
    const terminalPartition = terminalBy.fleet + terminalBy.otherAgents + terminalBy.system + terminalBy.unattributed;
    if (terminalPartition !== snapshot.flow.terminalLifecycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'terminalBy'],
        message: 'terminalBy buckets must partition flow.terminalLifecycle',
      });
    }

    if (snapshot.flow.terminalCounted !== snapshot.authority.counted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'terminalCounted'],
        message: 'flow.terminalCounted must equal authority.counted',
      });
    }
    if (snapshot.flow.terminalLifecycle !== snapshot.authority.lifecycleTerminal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'terminalLifecycle'],
        message: 'flow.terminalLifecycle must equal authority.lifecycleTerminal',
      });
    }
    if (snapshot.flow.netLifecycle !== snapshot.flow.opened - snapshot.flow.terminalLifecycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'netLifecycle'],
        message: 'netLifecycle must equal opened - terminalLifecycle',
      });
    }
    if (snapshot.flow.netCounted !== snapshot.flow.opened - snapshot.flow.terminalCounted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'netCounted'],
        message: 'netCounted must equal opened - terminalCounted',
      });
    }
  });

/**
 * A read failure is a first-class result, never an empty/zero snapshot. Historical
 * spec gaps in particular MUST return this branch rather than falling back to the
 * current revision and silently rewriting the fleet's past.
 */
export const fleetMetricsUnavailableSchema = z.object({
  ok: z.literal(false),
  schemaVersion: z.literal(FLEET_METRICS_SCHEMA_VERSION),
  error: z.literal('fleet_metrics_unavailable'),
  reason: nonEmpty,
  recoverVia: nonEmpty,
  requested: z.object({
    fleet: nonEmpty,
    harness: nonEmpty,
    flowMode: z.enum(['current-spec', 'at-event-spec']),
    window: z.literal('fleet-lifetime'),
  }),
});

export const fleetMetricsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: fleetMetricsSnapshotSchema }),
  fleetMetricsUnavailableSchema,
]);

export type FleetMetricWindow = z.infer<typeof fleetMetricWindowSchema>;
export type FleetMetricCurrentSpecScope = z.infer<typeof fleetMetricCurrentSpecScopeSchema>;
export type FleetMetricAtEventSpecScope = z.infer<typeof fleetMetricAtEventSpecScopeSchema>;
export type FleetMetricScope = z.infer<typeof fleetMetricScopeSchema>;
export type FleetMetricQuality = z.infer<typeof fleetMetricQualitySchema>;
export type FleetMetricsSnapshot = z.infer<typeof fleetMetricsSnapshotSchema>;
export type FleetMetricsResult = z.infer<typeof fleetMetricsResultSchema>;
export type FleetFeatureOutcomes = z.infer<typeof fleetFeatureOutcomesSchema>;
export type FleetPausedTime = z.infer<typeof fleetPausedTimeSchema>;

export function parseFleetMetricsResult(value: unknown): FleetMetricsResult {
  return fleetMetricsResultSchema.parse(value);
}
