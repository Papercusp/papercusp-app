/**
 * The prediction-capture seam (P-041 / FB-13) — what the natural-moment hosts
 * (improvements:resolve, plans:start, capture-core flake filings) call. The
 * brief's contract: bets are CHEAP recorded claims with no blocking UX, so
 * this NEVER throws into a host call path, gates itself on the
 * papercusp-calibration-markets flag (default OFF — frontier D-001), and
 * lazy-imports the PG pool only past the flag check (the
 * default-on-flag-glue-vs-hermetic-unit-tests rule: a host's unit test must
 * never touch the live pool through this seam).
 */
import type { Sql } from 'postgres';
import { DEFAULT_SIGNAL_ORIGIN, type SignalOrigin } from '../harness/improvements/provenance';
import { insertPrediction, type InsertPredictionInput } from './store';
import { DOMAIN_DEFAULTS, type PredictionDomain, type PredictionSubjectKind } from './types';

export interface RecordPredictionInput {
  /** Who is betting — ownerId / persona / 'system'. */
  predictor: string;
  domain: PredictionDomain;
  subjectKind: PredictionSubjectKind;
  subjectId: string;
  claim: string;
  /** Explicit stated probability (a real bet). Omitted → the domain's implicit prior, stated:false. */
  probability?: number;
  horizonDays?: number;
  origin?: SignalOrigin;
  /** The filed signal's stable identity (flake-recurrence probes re-captures on it). */
  watchdogKey?: string;
  workspaceId?: string;
  /** The pot the predictor works under (P-002 pot-scope-all-learnings) — wins outright when set. */
  potSlug?: string | null;
  /** The harness the bet was made under; resolved to its owning pot when no explicit potSlug. */
  harnessSlug?: string | null;
}

export interface RecordPredictionOutcome {
  recorded: boolean;
  reason?: 'flag-off' | 'duplicate-open-bet' | 'invalid-probability' | 'error';
}

/** Injectable IO seam (tests run flag-off/flag-on paths with no PG). */
export interface CalibrationCaptureDeps {
  isEnabled?: () => Promise<boolean>;
  getSql?: () => Promise<Sql>;
  insert?: (sql: Sql, q: InsertPredictionInput) => Promise<{ created: boolean; id: string | null }>;
  workspaceId?: () => Promise<string>;
  nowMs?: () => number;
  log?: (msg: string) => void;
}

const defaultDeps: Required<CalibrationCaptureDeps> = {
  isEnabled: async () => {
    try {
      const [{ FLAGS }, { getFlag }] = await Promise.all([
        import('@papercusp/flags'),
        import('@papercusp/flags/server'),
      ]);
      return await getFlag(FLAGS.CALIBRATION_MARKETS, 'calibration');
    } catch {
      return false; // fail-DARK: a flag-IO hiccup must not arm the seam
    }
  },
  getSql: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  },
  insert: insertPrediction,
  workspaceId: async () => {
    const { activeWorkspaceId } = await import('../workspace-registry');
    return activeWorkspaceId();
  },
  nowMs: () => Date.now(),
  log: (m) => console.log(`[calibration] ${m}`),
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Record one bet, cheaply. Resolves the implicit prior/horizon from
 * DOMAIN_DEFAULTS when not stated; idempotent per open predictor × domain ×
 * subject lane. Fire-and-forget friendly: every failure path returns instead
 * of throwing.
 */
export async function recordPrediction(
  input: RecordPredictionInput,
  deps?: CalibrationCaptureDeps,
): Promise<RecordPredictionOutcome> {
  const d = { ...defaultDeps, ...deps };
  try {
    if (!(await d.isEnabled())) return { recorded: false, reason: 'flag-off' };
    const defaults = DOMAIN_DEFAULTS[input.domain];
    const stated = input.probability !== undefined;
    const probability = input.probability ?? defaults.prior;
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { recorded: false, reason: 'invalid-probability' };
    }
    const horizonTs = new Date(
      d.nowMs() + (input.horizonDays ?? defaults.horizonDays) * DAY_MS,
    ).toISOString();
    const sql = await d.getSql();
    const workspaceId = input.workspaceId ?? (await d.workspaceId());
    // P-002 (pot-scope-all-learnings): stamp the predictor's pot at write time.
    // Lazy import mirrors the flag/PG imports above — a flag-off unit test never
    // touches the resolver; failures degrade to null (a bet must never be lost
    // to a scope lookup).
    const potSlug = await import('../learning/pot-scope')
      .then((m) =>
        m.resolveLearningPotSlug({
          workspaceId,
          potSlug: input.potSlug ?? null,
          harnessSlug: input.harnessSlug ?? null,
        }),
      )
      .catch(() => null);
    const res = await d.insert(sql, {
      workspaceId,
      predictor: input.predictor,
      domain: input.domain,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      claim: input.claim,
      probability,
      stated,
      origin: input.origin ?? DEFAULT_SIGNAL_ORIGIN,
      watchdogKey: input.watchdogKey ?? null,
      horizonTs,
      potSlug,
    });
    return res.created ? { recorded: true } : { recorded: false, reason: 'duplicate-open-bet' };
  } catch (e) {
    d.log(`bet not recorded (host call unaffected): ${e instanceof Error ? e.message : e}`);
    return { recorded: false, reason: 'error' };
  }
}
