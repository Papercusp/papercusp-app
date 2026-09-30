/**
 * config — runtime-tunable settings for the knowledge-pack loop
 * (knowledge-pack-settings-2026-07-19 P-001/P-004).
 *
 * Before this module every behavior knob was a launch-time env var and the
 * routine cadences were raw cron strings only `routines:set` could touch.
 * This is the PG-backed workspace config the memory settings page edits
 * ("Fleet knowledge packs — workspace-wide" section):
 *
 *   - STORAGE: `harness_shared.knowledge_pack_config` (migration 639) — the
 *     operator-state single-row-per-workspace JSONB idiom, exact sibling of
 *     operator_rate_limit_config (migration 161).
 *   - RESOLUTION (D-002): stored value → env var → baked default, so existing
 *     env tuning keeps working and an empty table changes nothing.
 *   - CADENCE (D-003): the UI writes named PRESETS mapped to vetted cron
 *     strings; raw cron stays an operator/MCP affair (routines:set). 'paused'
 *     flips the routine row inactive — never deletes it.
 *
 * The delivery/hygiene ticks (harness/routines/knowledge-pack-actions.ts),
 * the candidate staging cap, and the auto-adopt sweep all resolve through
 * here. Pure resolution logic is exported separately (resolveKnobsFrom) so
 * unit tests pin the precedence without PG.
 */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { computeNextFireAt } from '../harness/routines/cron';

/* ── settings shape ─────────────────────────────────────────────────────── */

/** Vetted preset → cron maps (D-003). Delivery keeps the :30 offset from triage. */
export const DELIVERY_CADENCE_CRON = {
  hourly: '0 30 * * * *',
  '6h': '0 30 */6 * * *',
  daily: '0 30 8 * * *',
} as const;
export const HYGIENE_CADENCE_CRON = {
  daily: '0 0 5 * * *',
  weekly: '0 0 5 * * 0',
} as const;

export type DeliveryCadence = keyof typeof DELIVERY_CADENCE_CRON | 'paused';
export type HygieneCadence = keyof typeof HYGIENE_CADENCE_CRON | 'paused';

export const knowledgePackSettingsSchema = z
  .object({
    /** How often the fleet-lessons last-mile delivery tick runs. */
    deliveryCadence: z.enum(['hourly', '6h', 'daily', 'paused']).optional(),
    /** How often the three-pass hygiene tick runs. */
    hygieneCadence: z.enum(['daily', 'weekly', 'paused']).optional(),
    /** 'auto' (WI-5414 auto-adopt behind the transferability bar) or
     *  'owner-approval' (candidates stay pending for decide_candidate). */
    adoptionPolicy: z.enum(['auto', 'owner-approval']).optional(),
    /** Hygiene pass (a): lesson age before re-review. */
    minAgeDays: z.number().int().min(0).max(3650).optional(),
    /** Hygiene pass (c): dismissed-candidate retention. */
    pruneDismissedDays: z.number().int().min(1).max(3650).optional(),
    /** Staging backpressure: max pending candidates. */
    pendingCandidateCap: z.number().int().min(1).max(500).optional(),
    /** Hygiene LLM cost bound: re-judgements per tick. */
    maxReviewsPerTick: z.number().int().min(0).max(200).optional(),
    /** Hygiene bound: hives conflict-swept per tick. */
    hygieneMaxHivesPerTick: z.number().int().min(0).max(100).optional(),
    /** Delivery bound: hives visited per tick. */
    deliveryMaxHivesPerTick: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type KnowledgePackSettings = z.infer<typeof knowledgePackSettingsSchema>;

/** The POST patch shape: every field also accepts null = "clear this override
 *  back to env/default resolution" (writeKnowledgePackSettings deletes it). */
export const knowledgePackSettingsPatchSchema = z
  .object({
    deliveryCadence: z.enum(['hourly', '6h', 'daily', 'paused']).nullable().optional(),
    hygieneCadence: z.enum(['daily', 'weekly', 'paused']).nullable().optional(),
    adoptionPolicy: z.enum(['auto', 'owner-approval']).nullable().optional(),
    minAgeDays: z.number().int().min(0).max(3650).nullable().optional(),
    pruneDismissedDays: z.number().int().min(1).max(3650).nullable().optional(),
    pendingCandidateCap: z.number().int().min(1).max(500).nullable().optional(),
    maxReviewsPerTick: z.number().int().min(0).max(200).nullable().optional(),
    hygieneMaxHivesPerTick: z.number().int().min(0).max(100).nullable().optional(),
    deliveryMaxHivesPerTick: z.number().int().min(1).max(100).nullable().optional(),
  })
  .strict();

export type KnowledgePackSettingsPatch = z.infer<typeof knowledgePackSettingsPatchSchema>;

/* ── storage ────────────────────────────────────────────────────────────── */

const TABLE = 'knowledge_pack_config' as const;

/** Read the stored settings; unparseable/absent rows resolve to {} (fail-open to defaults). */
export async function readKnowledgePackSettings(): Promise<KnowledgePackSettings> {
  const raw = await readOperatorState<unknown>(TABLE).catch(() => null);
  const parsed = knowledgePackSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Merge-write a settings patch (a partial edit preserves unspecified fields —
 * the rate_limit_config rule). Passing `null` for a field CLEARS the override
 * back to env/default resolution.
 */
export async function writeKnowledgePackSettings(
  patch: { [K in keyof KnowledgePackSettings]?: KnowledgePackSettings[K] | null },
): Promise<KnowledgePackSettings> {
  const current = await readKnowledgePackSettings();
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else if (v !== undefined) merged[k] = v;
  }
  const next = knowledgePackSettingsSchema.parse(merged);
  await writeOperatorState<KnowledgePackSettings>(TABLE, next);
  return next;
}

/* ── knob resolution: stored → env → default (D-002) ───────────────────── */

export interface KnowledgePackKnobs {
  adoptionPolicy: 'auto' | 'owner-approval';
  minAgeDays: number;
  pruneDismissedDays: number;
  pendingCandidateCap: number;
  maxReviewsPerTick: number;
  hygieneMaxHivesPerTick: number;
  deliveryMaxHivesPerTick: number;
}

/** The baked defaults (the pre-settings hardcoded values — unchanged). */
export const DEFAULT_KNOWLEDGE_PACK_KNOBS: KnowledgePackKnobs = {
  adoptionPolicy: 'auto',
  minAgeDays: 30,
  pruneDismissedDays: 90,
  pendingCandidateCap: 20,
  maxReviewsPerTick: 10,
  hygieneMaxHivesPerTick: 3,
  deliveryMaxHivesPerTick: 10,
};

/** env var per knob — the SAME names the actions used pre-settings, so existing tuning carries. */
const KNOB_ENV: Record<Exclude<keyof KnowledgePackKnobs, 'adoptionPolicy'>, string> = {
  minAgeDays: 'PAPERCUSP_KNOWLEDGE_HYGIENE_MIN_AGE_DAYS',
  pruneDismissedDays: 'PAPERCUSP_KNOWLEDGE_HYGIENE_PRUNE_DAYS',
  pendingCandidateCap: 'PAPERCUSP_LEARNING_CANDIDATE_CAP',
  maxReviewsPerTick: 'PAPERCUSP_KNOWLEDGE_HYGIENE_MAX_REVIEWS',
  hygieneMaxHivesPerTick: 'PAPERCUSP_KNOWLEDGE_HYGIENE_MAX_HIVES',
  deliveryMaxHivesPerTick: 'PAPERCUSP_KNOWLEDGE_DELIVERY_MAX_HIVES',
};

function intFrom(raw: string | undefined, fallback: number, min: number): number {
  if (raw == null || raw.trim() === '') return Math.max(min, fallback);
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? Math.max(min, n) : Math.max(min, fallback);
}

const KNOB_MIN: Record<Exclude<keyof KnowledgePackKnobs, 'adoptionPolicy'>, number> = {
  minAgeDays: 0,
  pruneDismissedDays: 1,
  pendingCandidateCap: 1,
  maxReviewsPerTick: 0,
  hygieneMaxHivesPerTick: 0,
  deliveryMaxHivesPerTick: 1,
};

/** PURE precedence: stored → env → default. Exported for unit tests. */
export function resolveKnobsFrom(
  stored: KnowledgePackSettings,
  env: Record<string, string | undefined>,
): KnowledgePackKnobs {
  const out = { ...DEFAULT_KNOWLEDGE_PACK_KNOBS };
  for (const key of Object.keys(KNOB_ENV) as Array<keyof typeof KNOB_ENV>) {
    const storedV = stored[key];
    out[key] =
      typeof storedV === 'number'
        ? Math.max(KNOB_MIN[key], Math.floor(storedV))
        : intFrom(env[KNOB_ENV[key]], DEFAULT_KNOWLEDGE_PACK_KNOBS[key], KNOB_MIN[key]);
  }
  if (stored.adoptionPolicy) out.adoptionPolicy = stored.adoptionPolicy;
  return out;
}

/** Live resolution: PG-stored settings → process env → baked defaults. */
export async function resolveKnowledgePackKnobs(): Promise<KnowledgePackKnobs> {
  return resolveKnobsFrom(await readKnowledgePackSettings(), process.env);
}

/* ── cadence read/apply (P-004) ─────────────────────────────────────────── */

export const KNOWLEDGE_PACK_ROUTINE_NAMES = {
  delivery: 'knowledge-pack-delivery',
  hygiene: 'knowledge-pack-hygiene',
} as const;

export interface RoutineCadenceView {
  /** The matched preset, or 'custom' when the row's cron isn't a preset (routines:set edit). */
  preset: string;
  cron: string | null;
  active: boolean;
  nextFireAt: string | null;
  /** false when the routine row hasn't been seeded yet. */
  seeded: boolean;
}

function presetOf(cron: string | null, active: boolean, map: Record<string, string>): string {
  if (!active) return 'paused';
  const hit = Object.entries(map).find(([, c]) => c === cron);
  return hit ? hit[0] : 'custom';
}

/** Read the two routine rows' live cadence for the settings UI. */
export async function readKnowledgePackCadence(): Promise<{
  delivery: RoutineCadenceView;
  hygiene: RoutineCadenceView;
}> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = (await sql`
    SELECT name, trigger_config, active, next_fire_at
      FROM harness_shared.routines
     WHERE workspace_id = ${ws}
       AND name IN (${KNOWLEDGE_PACK_ROUTINE_NAMES.delivery}, ${KNOWLEDGE_PACK_ROUTINE_NAMES.hygiene})
  `) as Array<{ name: string; trigger_config: { cron?: string } | null; active: boolean; next_fire_at: string | null }>;
  const view = (name: string, map: Record<string, string>): RoutineCadenceView => {
    const row = rows.find((r) => r.name === name);
    if (!row) return { preset: 'custom', cron: null, active: false, nextFireAt: null, seeded: false };
    const cron = row.trigger_config?.cron ?? null;
    return {
      preset: presetOf(cron, row.active, map),
      cron,
      active: row.active,
      nextFireAt: row.next_fire_at ? new Date(row.next_fire_at).toISOString() : null,
      seeded: true,
    };
  };
  return {
    delivery: view(KNOWLEDGE_PACK_ROUTINE_NAMES.delivery, DELIVERY_CADENCE_CRON),
    hygiene: view(KNOWLEDGE_PACK_ROUTINE_NAMES.hygiene, HYGIENE_CADENCE_CRON),
  };
}

/**
 * Apply cadence presets to the two routine rows — the same columns
 * routines:set mutates (trigger_config.cron + active + recomputed
 * next_fire_at), scoped to exactly these two names in this workspace.
 * A non-paused preset re-activates the row (picking a cadence back up after
 * 'paused' must resume it); 'paused' flips active=false and keeps the cron so
 * resuming restores the prior schedule shape.
 */
export async function applyKnowledgePackCadence(settings: {
  deliveryCadence?: DeliveryCadence;
  hygieneCadence?: HygieneCadence;
}): Promise<void> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const apply = async (name: string, preset: string, map: Record<string, string>): Promise<void> => {
    if (preset === 'paused') {
      await sql`
        UPDATE harness_shared.routines SET active = false, updated_at = now()
         WHERE workspace_id = ${ws} AND name = ${name}
      `;
      return;
    }
    const cron = map[preset];
    if (!cron) throw new Error(`unknown cadence preset "${preset}" for ${name}`);
    const next = computeNextFireAt(cron, new Date());
    if (!next) throw new Error(`preset "${preset}" produced an invalid cron "${cron}" — refusing to apply`);
    await sql`
      UPDATE harness_shared.routines
         SET trigger_config = ${JSON.stringify({ cron })}::text::jsonb,
             active = true,
             next_fire_at = ${next.toISOString()},
             updated_at = now()
       WHERE workspace_id = ${ws} AND name = ${name}
    `;
  };
  if (settings.deliveryCadence) {
    await apply(KNOWLEDGE_PACK_ROUTINE_NAMES.delivery, settings.deliveryCadence, DELIVERY_CADENCE_CRON);
  }
  if (settings.hygieneCadence) {
    await apply(KNOWLEDGE_PACK_ROUTINE_NAMES.hygiene, settings.hygieneCadence, HYGIENE_CADENCE_CRON);
  }
}
