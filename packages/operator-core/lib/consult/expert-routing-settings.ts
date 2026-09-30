/**
 * expert-routing-settings.ts — the PERSISTED consult expert-routing settings
 * (plan consult-expert-routing-2026-09-22, P-005).
 *
 * Two knobs, one row per workspace in harness_shared.operator_consult_expert_routing
 * (migration 1202), read by the router/dispatcher at route time and written by
 * the P-006 settings panel:
 *
 *   allowlist            — the RANKED list of models allowed to ANSWER a consult
 *                          (D-004). Order IS the policy: rank 1 is tried first and
 *                          each later rank is the fallback for a walled account or
 *                          a failed launch.
 *   recencyHalfLifeDays  — the stage-2 half-life the relevance router compares
 *                          qualified candidates with (D-001 §2).
 *
 * ⚠ RECENCY IS COMPARISON-ONLY [owner 2026-09-22]: "recently should only be
 * considered when comparing... If we have like any expert floor that an agent has
 * to pass, the recency shouldnt be considered for this." So this value feeds
 * STAGE 2 (ranking) only — stage-1 qualification stays recency-free, which is what
 * stops an owner's vacation from stripping an agent of expert status.
 *
 * TOTAL BY DESIGN. Every read degrades to the owner-stated seed rather than
 * throwing: this sits on the dispatch critical path, and an unreadable setting
 * must mean "fewer/default ranks", never "no expert routing at all". That is the
 * same posture normalizeExpertModelAllowlist takes with a malformed row.
 */
import {
  readOperatorState,
  writeOperatorState,
  invalidateOperatorStateCache,
} from '../operator-state-pg';
import {
  DEFAULT_EXPERT_MODEL_ALLOWLIST,
  normalizeExpertModelAllowlist,
  type AllowedExpertModel,
  type ExpertModelAllowlistDeps,
} from './expert-model-allowlist';
import { DEFAULT_RECENCY_HALF_LIFE_DAYS } from './relevance-router';

/** The single-row-per-workspace state table (migration 1202). */
const TABLE = 'operator_consult_expert_routing' as const;

export interface ConsultExpertRoutingSettings {
  /** Ranked best-first; dense ranks starting at 1 (normalization guarantees it). */
  allowlist: AllowedExpertModel[];
  /** Stage-2 comparison half-life, in days. */
  recencyHalfLifeDays: number;
}

/** Bind both route-time consumers to one settings snapshot for a consult. */
export function bindConsultExpertRoutingSettings(settings: ConsultExpertRoutingSettings): {
  recencyHalfLifeDays: number;
  loadRanks: NonNullable<ExpertModelAllowlistDeps['loadRanks']>;
} {
  return {
    recencyHalfLifeDays: settings.recencyHalfLifeDays,
    loadRanks: async () => settings.allowlist,
  };
}

/**
 * Half-life bounds. A zero/negative value would make `Math.pow(2, -age/hl)`
 * non-finite and silently flatten stage-2 ordering, and an absurdly large one is
 * indistinguishable from disabling recency — both are better rejected here than
 * discovered as a mis-ranked expert.
 */
export const MIN_RECENCY_HALF_LIFE_DAYS = 0.5;
export const MAX_RECENCY_HALF_LIFE_DAYS = 365;

/** Clamp a stored/authored half-life into the usable band, or fall back. */
export function normalizeRecencyHalfLifeDays(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RECENCY_HALF_LIFE_DAYS;
  return Math.min(MAX_RECENCY_HALF_LIFE_DAYS, Math.max(MIN_RECENCY_HALF_LIFE_DAYS, value));
}

/** The settings a workspace has before anyone opens the panel. */
export function seedConsultExpertRoutingSettings(): ConsultExpertRoutingSettings {
  return {
    allowlist: normalizeExpertModelAllowlist([...DEFAULT_EXPERT_MODEL_ALLOWLIST]),
    recencyHalfLifeDays: DEFAULT_RECENCY_HALF_LIFE_DAYS,
  };
}

/** Normalize a raw stored payload; an empty allowlist falls back to the seed. */
export function normalizeConsultExpertRoutingSettings(
  raw: unknown,
): ConsultExpertRoutingSettings {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const allowlist = normalizeExpertModelAllowlist(row.allowlist);
  return {
    // An allowlist that normalizes to empty is not a policy of "nobody may
    // answer" — it is an unusable setting, and the seed IS the owner's stated
    // policy. Refusing every consult on a bad write would be the worse failure.
    allowlist: allowlist.length > 0 ? allowlist : seedConsultExpertRoutingSettings().allowlist,
    recencyHalfLifeDays: normalizeRecencyHalfLifeDays(row.recencyHalfLifeDays),
  };
}

/** Read the workspace's settings, always usable. Never throws. */
export async function readConsultExpertRoutingSettings(
  workspaceId?: string,
): Promise<ConsultExpertRoutingSettings> {
  try {
    const stored = await readOperatorState<Partial<ConsultExpertRoutingSettings>>(
      TABLE,
      workspaceId,
    );
    if (!stored) return seedConsultExpertRoutingSettings();
    return normalizeConsultExpertRoutingSettings(stored);
  } catch {
    // Settings unreadable (table absent on a pre-1202 box, PG blip). The seed is
    // the owner-stated policy, so it is the safe answer — see the header.
    return seedConsultExpertRoutingSettings();
  }
}

/**
 * Persist a complete settings document (the P-006 panel's writer). Returns what was actually
 * stored — normalized, so a caller reordering ranks 1/4/7 gets back 1/2/3 and
 * never has to guess how its write was interpreted.
 */
export async function writeConsultExpertRoutingSettings(
  next: ConsultExpertRoutingSettings,
  workspaceId?: string,
): Promise<ConsultExpertRoutingSettings> {
  const candidate = next as ConsultExpertRoutingSettings | null | undefined;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !Array.isArray(candidate.allowlist) ||
    typeof candidate.recencyHalfLifeDays !== 'number'
  ) {
    throw new TypeError('A complete consult expert-routing settings document is required');
  }
  const normalized = normalizeConsultExpertRoutingSettings(candidate);
  await writeOperatorState<ConsultExpertRoutingSettings>(TABLE, normalized, workspaceId);
  if (workspaceId) invalidateOperatorStateCache(TABLE, workspaceId);
  return normalized;
}

/**
 * The `loadRanks` seam ExpertModelAllowlistDeps declares (expert-model-allowlist.ts).
 * Returns null when nothing usable is stored so the resolver falls through to the
 * seed on its own terms rather than being handed a synthesized list.
 */
export async function loadExpertModelRanks(
  workspaceId: string,
): Promise<readonly AllowedExpertModel[] | null> {
  const stored = await readOperatorState<Partial<ConsultExpertRoutingSettings>>(
    TABLE,
    workspaceId,
  );
  if (!stored) return null;
  const allowlist = normalizeExpertModelAllowlist(stored.allowlist);
  return allowlist.length > 0 ? allowlist : null;
}

/** The stage-2 half-life for this workspace. Never throws. */
export async function resolveRecencyHalfLifeDays(workspaceId?: string): Promise<number> {
  const settings = await readConsultExpertRoutingSettings(workspaceId);
  return settings.recencyHalfLifeDays;
}
