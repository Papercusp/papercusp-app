/**
 * hive-settings-store — PG access to harness_shared.pot_settings, per-Hive
 * settings that federate as first-class Hive state (shared-hive-federation-2026-06-08
 * P-005; migration 186).
 *
 * A Hive's settings are scoped to its HOME harness slug (the `harness_slug`
 * column = the Hive's home_slug, which carries the Hive identity) so they ride the
 * Hive's peer-log (P-004 topic re-key) via the existing harness_plans-style
 * federation. This module is the LOCAL write/read path; it enforces the logical
 * "settings belong to a Hive" scope (the migration has no hard FK, to keep the
 * read-side projection tolerant of cross-machine join ordering). `value` crosses
 * the boundary as a JSON-serializable value (stored as JSON text).
 *
 * Every fn takes an optional `sql` client so integration tests can pass a per-file
 * test schema.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { resolveFederatedPotScope } from './federated-pot-scope';
import { getHiveBySlug } from './hive-store';
import { traceStageAwait } from './sync/hyperbee/stage-stall-log';

export interface HiveSettingRecord {
  workspaceId: string;
  /** The Hive's home_slug (= the `harness_slug` scope column). */
  potHomeSlug: string;
  settingKey: string;
  /** The JSON-decoded setting value (null when unset). */
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface SetHiveSettingInput {
  workspaceId: string;
  potHomeSlug: string;
  settingKey: string;
  /** Any JSON-serializable value. `undefined` stores SQL NULL. */
  value: unknown;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

const COLS = `workspace_id, harness_slug, setting_key, value, created_at, updated_at`;

interface HiveSettingDbRow {
  workspace_id: string;
  harness_slug: string;
  setting_key: string;
  value: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function rowToRecord(r: HiveSettingDbRow): HiveSettingRecord {
  let value: unknown = null;
  if (r.value != null) {
    try {
      value = JSON.parse(r.value);
    } catch {
      value = r.value; // tolerate a non-JSON legacy value rather than throw
    }
  }
  return {
    workspaceId: r.workspace_id,
    potHomeSlug: r.harness_slug,
    settingKey: r.setting_key,
    value,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/**
 * Set (upsert) a Hive setting. Enforces the logical scope — the Hive must exist
 * (the migration has no hard FK). The value federates over the Hive's peer-log via
 * the capture trigger.
 */
export async function setHiveSetting(input: SetHiveSettingInput, sql?: Sql): Promise<HiveSettingRecord> {
  const s = pg(sql);
  // The Hive identity row is keyed by this machine's LOCAL handle, so validate
  // existence before translating to the owner-authored scope used on the wire.
  const hive = await getHiveBySlug(input.workspaceId, input.potHomeSlug, sql);
  if (!hive) {
    throw new Error(
      `setHiveSetting: no Hive '${input.potHomeSlug}' in workspace '${input.workspaceId}' — settings belong to a Hive`,
    );
  }
  const potScope = await resolveFederatedPotScope(input.workspaceId, input.potHomeSlug, { sql });
  const value = input.value === undefined ? null : JSON.stringify(input.value);
  const now = Date.now();
  const rows = (await s.unsafe(
    `INSERT INTO harness_shared.pot_settings (${COLS})
       VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (workspace_id, harness_slug, setting_key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = $5
     RETURNING ${COLS}`,
    [input.workspaceId, potScope, input.settingKey, value, now],
  )) as unknown as HiveSettingDbRow[];
  return rowToRecord(rows[0]);
}

/** Get one Hive setting by key (null when unset). */
export async function getHiveSetting(
  workspaceId: string,
  potHomeSlug: string,
  settingKey: string,
  sql?: Sql,
): Promise<HiveSettingRecord | null> {
  const s = pg(sql);
  const loadScope = () => resolveFederatedPotScope(workspaceId, potHomeSlug, { sql });
  const potScope = await (settingKey === 'epoch' ? traceStageAwait('scope-query', loadScope) : loadScope());
  const loadSetting = () =>
    s.unsafe(
      `SELECT ${COLS} FROM harness_shared.pot_settings
      WHERE workspace_id = $1 AND harness_slug = $2 AND setting_key = $3 LIMIT 1`,
      [workspaceId, potScope, settingKey],
    );
  const rows = (await (settingKey === 'epoch'
    ? traceStageAwait('epoch-query', loadSetting)
    : loadSetting())) as unknown as HiveSettingDbRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** All settings for a Hive. */
export async function listHiveSettings(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<HiveSettingRecord[]> {
  const s = pg(sql);
  const potScope = await resolveFederatedPotScope(workspaceId, potHomeSlug, { sql });
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.pot_settings
      WHERE workspace_id = $1 AND harness_slug = $2 ORDER BY setting_key`,
    [workspaceId, potScope],
  )) as unknown as HiveSettingDbRow[];
  return rows.map(rowToRecord);
}

/** Delete a Hive setting (idempotent). The delete federates (capture trigger). */
export async function deleteHiveSetting(
  workspaceId: string,
  potHomeSlug: string,
  settingKey: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const potScope = await resolveFederatedPotScope(workspaceId, potHomeSlug, { sql });
  const rows = (await s.unsafe(
    `DELETE FROM harness_shared.pot_settings
      WHERE workspace_id = $1 AND harness_slug = $2 AND setting_key = $3 RETURNING setting_key`,
    [workspaceId, potScope, settingKey],
  )) as unknown as Array<{ setting_key: string }>;
  return rows.length > 0;
}

// ── Hive-INSTANCE agent-prompt overrides ──────────────────────────────────────
// domain-generic-agent-personas-2026-06-17 P-003 / D-003. A Hive INSTANCE (e.g. the
// Papercusp hive) carries its own per-role prompt specialization here — stored as a
// `hive_settings` value under key `promptOverride.<role>`, so it federates over the
// Hive's peer-log like any other setting. This is the INSTANCE layer that sits ON TOP
// of the blueprint -> ancestors -> base FILE chain (prompt-resolve): the reusable
// blueprint persona stays a file + generic; only instance-specifics live here. The
// override SPECIALIZES (is appended after the resolved persona) — it does not replace
// the role; the caller (the prompt assembler) owns that composition.

export const PROMPT_OVERRIDE_SETTING_PREFIX = 'promptOverride.';

/** The `hive_settings` key a role's instance prompt override is stored under. */
export function promptOverrideSettingKey(role: string): string {
  return `${PROMPT_OVERRIDE_SETTING_PREFIX}${role}`;
}

/** Get a Hive instance's prompt override for a role (null when unset). */
export async function getHiveInstancePromptOverride(
  workspaceId: string,
  potHomeSlug: string,
  role: string,
  sql?: Sql,
): Promise<string | null> {
  const rec = await getHiveSetting(workspaceId, potHomeSlug, promptOverrideSettingKey(role), sql);
  if (!rec || rec.value == null) return null;
  return typeof rec.value === 'string' ? rec.value : String(rec.value);
}

/** Set (upsert) a Hive instance's prompt override for a role (markdown). Federates. */
export async function setHiveInstancePromptOverride(
  workspaceId: string,
  potHomeSlug: string,
  role: string,
  promptMd: string,
  sql?: Sql,
): Promise<void> {
  await setHiveSetting({ workspaceId, potHomeSlug, settingKey: promptOverrideSettingKey(role), value: promptMd }, sql);
}

/** Delete a Hive instance's prompt override for a role (idempotent). Federates so a
 *  removed override leaves no stale materialized file on any peer. */
export async function deleteHiveInstancePromptOverride(
  workspaceId: string,
  potHomeSlug: string,
  role: string,
  sql?: Sql,
): Promise<boolean> {
  return deleteHiveSetting(workspaceId, potHomeSlug, promptOverrideSettingKey(role), sql);
}

/** All per-role prompt overrides set on a Hive instance (role -> markdown). */
export async function listHiveInstancePromptOverrides(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<Record<string, string>> {
  const all = await listHiveSettings(workspaceId, potHomeSlug, sql);
  const out: Record<string, string> = {};
  for (const rec of all) {
    if (rec.settingKey.startsWith(PROMPT_OVERRIDE_SETTING_PREFIX) && rec.value != null) {
      const role = rec.settingKey.slice(PROMPT_OVERRIDE_SETTING_PREFIX.length);
      out[role] = typeof rec.value === 'string' ? rec.value : String(rec.value);
    }
  }
  return out;
}

// ── Per-hive release green-command override ───────────────────────────────────────
// per-hive-git-and-release-gate-2026-06-29 P-014 (+ P-007's deferred override layering).
// The green-gate command resolves blueprint-knob `releaseGate.greenCmd` ?? the detected
// `testCommand` ?? build (hive-release-env.ts). An OWNER can override it per-hive from
// /admin/git — stored here as a federated `hive_settings` value so it survives a re-clone
// and rides the Hive peer-log. resolveHiveReleaseEnv reads this as the TOP precedence
// (override > knob > testCommand > build), so the gate runs the edited command.

export const RELEASE_GREEN_CMD_SETTING_KEY = 'release.greenCmd';

/** Get a hive's per-install green-command override (null when unset / blank). */
export async function getReleaseGreenCmdOverride(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<string | null> {
  const rec = await getHiveSetting(workspaceId, potHomeSlug, RELEASE_GREEN_CMD_SETTING_KEY, sql);
  if (!rec || rec.value == null) return null;
  const v = typeof rec.value === 'string' ? rec.value : String(rec.value);
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Set (upsert) a hive's per-install green-command override. Federates. */
export async function setReleaseGreenCmdOverride(
  workspaceId: string,
  potHomeSlug: string,
  greenCmd: string,
  sql?: Sql,
): Promise<void> {
  await setHiveSetting({ workspaceId, potHomeSlug, settingKey: RELEASE_GREEN_CMD_SETTING_KEY, value: greenCmd }, sql);
}

/** Delete a hive's green-command override (idempotent — reverts to the detected default). */
export async function deleteReleaseGreenCmdOverride(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<boolean> {
  return deleteHiveSetting(workspaceId, potHomeSlug, RELEASE_GREEN_CMD_SETTING_KEY, sql);
}

// ── Hive-INSTANCE structured config deltas (the local-tier blueprint config) ──────
// domain-generic-hive-architecture-2026-06-18 P-015 / D-005. A role's PROSE persona
// rides `promptOverride.<role>` above; but the hive's STRUCTURED tuning (e.g. how the
// scout loop ideates/critiques/routes for this domain — a `ScoutConfigOverride`) is
// config, not prose, so prose-only `promptOverride` can't express it (D-005). Each
// config section is stored as a JSON-serializable `hive_settings` value under key
// `localBlueprint.<section>` — the settings-resident, federated local-tier delta. It is
// canonical + syncs over the Hive peer-log like any other setting; the consuming loop
// (e.g. scout) reads/parses it defensively (scout/config.ts parseScoutConfigBlock).

export const LOCAL_BLUEPRINT_CONFIG_PREFIX = 'localBlueprint.';

/** The `hive_settings` key a structured config section is stored under. */
export function localBlueprintConfigKey(section: string): string {
  return `${LOCAL_BLUEPRINT_CONFIG_PREFIX}${section}`;
}

/** Get a Hive instance's structured config delta for a section (null when unset). */
export async function getHiveLocalBlueprintConfig(
  workspaceId: string,
  potHomeSlug: string,
  section: string,
  sql?: Sql,
): Promise<unknown | null> {
  const rec = await getHiveSetting(workspaceId, potHomeSlug, localBlueprintConfigKey(section), sql);
  return rec ? rec.value : null;
}

/**
 * Set (upsert) a Hive instance's structured config delta for a section. The value is
 * any JSON-serializable object (e.g. a `ScoutConfigOverride`). Federates. Pass
 * `value: null`/`undefined` (or call {@link deleteHiveLocalBlueprintConfig}) to clear.
 */
export async function setHiveLocalBlueprintConfig(
  workspaceId: string,
  potHomeSlug: string,
  section: string,
  value: unknown,
  sql?: Sql,
): Promise<void> {
  await setHiveSetting({ workspaceId, potHomeSlug, settingKey: localBlueprintConfigKey(section), value }, sql);
}

/** Delete a Hive instance's structured config delta for a section (idempotent). Federates. */
export async function deleteHiveLocalBlueprintConfig(
  workspaceId: string,
  potHomeSlug: string,
  section: string,
  sql?: Sql,
): Promise<boolean> {
  return deleteHiveSetting(workspaceId, potHomeSlug, localBlueprintConfigKey(section), sql);
}

/** All structured config deltas set on a Hive instance (section -> value). */
export async function listHiveLocalBlueprintConfig(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<Record<string, unknown>> {
  const all = await listHiveSettings(workspaceId, potHomeSlug, sql);
  const out: Record<string, unknown> = {};
  for (const rec of all) {
    if (rec.settingKey.startsWith(LOCAL_BLUEPRINT_CONFIG_PREFIX) && rec.value != null) {
      const section = rec.settingKey.slice(LOCAL_BLUEPRINT_CONFIG_PREFIX.length);
      out[section] = rec.value;
    }
  }
  return out;
}

// ── Queen-home pubkey (the split-brain-Queen guard) ──────────────────────────
// domain-generic-hive-architecture-2026-06-18 P-021 (I2 / closes queen-guard.ts
// D-008). The DEVICE PUBKEY of the Swarm that runs this Hive's Queen — recorded at
// pot:create (the creating node IS the local Queen home) so a steering turn can
// assert HOME-SWARM before steering (queen-guard.evaluateMugTurnGate, consulted by
// steering-lease.checkSteeringLease). It rides `hive_settings` so it federates to
// every Swarm of the Hive like any other setting. Unset ⇒ the steering lease falls
// back to the lock-authority election (today's behaviour — the gate fails open, so a
// convention-only Hive keeps working). SAME identity space as lockAuthorityForHive's
// election key + the announce identity: the raw 32-byte Ed25519 device pubkey, base64
// (resolveUsageActor's `devicePubkey`).

/** The `hive_settings` key the Hive's queen-home device pubkey is stored under. */
export const QUEEN_HOME_PUBKEY_SETTING_KEY = 'queen-home-pubkey';

/** Get the Hive's recorded queen-home device pubkey (null when unset). */
export async function getQueenHomePubkey(workspaceId: string, potHomeSlug: string, sql?: Sql): Promise<string | null> {
  const rec = await getHiveSetting(workspaceId, potHomeSlug, QUEEN_HOME_PUBKEY_SETTING_KEY, sql);
  if (!rec || rec.value == null) return null;
  const v = typeof rec.value === 'string' ? rec.value : String(rec.value);
  return v.length > 0 ? v : null;
}

/** Record (upsert) the Hive's queen-home device pubkey. Federates. */
export async function setQueenHomePubkey(
  workspaceId: string,
  potHomeSlug: string,
  devicePubkey: string,
  sql?: Sql,
): Promise<void> {
  await setHiveSetting(
    { workspaceId, potHomeSlug, settingKey: QUEEN_HOME_PUBKEY_SETTING_KEY, value: devicePubkey },
    sql,
  );
}
