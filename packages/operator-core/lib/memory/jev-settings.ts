/**
 * Jev settings — the user-facing on/off for TypeSafe Jev in memory injection
 * (plan jev-decision-model-integration-2026-09-29, P-013 / D-008).
 *
 * Two pieces of state, both reused stores (no new table):
 *  - MODE: `harness_shared.operator_settings` key `jev_memory_injection:<workspace>`
 *    = off | shadow | on, default OFF. The same key/value store (and the same
 *    short read cache) as the memory-pause switch.
 *      off    — today's system, exactly. Zero Jev calls.
 *      shadow — Jev is called and its verdicts are LOGGED, but injection is
 *               unchanged (the P-007 measurement mode).
 *      on     — Jev's verdicts filter injection (only once the P-006 evaluation
 *               clears the D-007 bar; the UI says so).
 *  - KEY: the Jev API key, encrypted in `operator_integration_credentials` as
 *    TYPESAFE_API_KEY. Storing it IS the recorded consent to send turn and
 *    memory text to TypeSafe (D-003); clearing it withdraws that consent.
 *
 * The one rule every consumer must obey is {@link resolveJevMemoryInjection}:
 * its `effective` mode is `off` unless the user chose shadow/on AND a key is
 * stored. A consumer that sees `off` must make ZERO decision-model calls.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  configureDecisionModel,
  createDecisionClient,
  createJevProvider,
  getDecisionClient,
  JEV_PINNED_MODEL,
  type DecisionClient,
  type DecisionPricing,
} from '@papercusp/decision-model';
import { pinModuleState } from '@papercusp/module-singleton';
import { recordDecisionModelCall } from '../decision-model-ledger';
import { maskIntegrationKey, readIntegrationKey, writeIntegrationCredentials } from '../integration-credentials';
import { activeWorkspaceId } from '../workspace-registry';
import { alertOwnerOnJevAccountRefusal } from './jev-account-alert';
import { jevFetch } from './jev-transport';

export const JEV_MODES = ['off', 'shadow', 'on'] as const;
export type JevMode = (typeof JEV_MODES)[number];

/** Name of the Jev key in operator_integration_credentials. */
export const JEV_API_KEY_NAME = 'TYPESAFE_API_KEY';

/**
 * The most one Jev call on the memory push path may take: an answer or a fallback
 * within this. A port whose turn waits for the answer gets less when its hook's
 * wall is closer (jev-memory-gate: jevMemoryWaitMs).
 *
 * Was 400 ms until WI-10004485 step C. Measured 2026-10-01 from quiet processes
 * (no operator-worker stalls; ~600 answered calls in healthy-provider windows):
 * 2.3% of answers took longer than 400 ms, 1 longer than 600 ms, the slowest 639 ms.
 * So 400 ms alone failed the pre-registered <2% inconclusive bar before any stall;
 * 800 ms clears every healthy-provider answer seen. Live Log-only traffic at 400 ms
 * timed out 10.6% of calls, 4 in 10 of them worker stalls (EI-24748208098755918).
 */
export const JEV_MEMORY_TIMEOUT_MS = 800;

/**
 * Token rates for the pinned Jev model, so every ledger row carries `cost_usd`.
 * Jev's API returns token counts but no price, so the host supplies the rates.
 * Source: the OpenRouter listing for typesafe/jev-1.13 (and its jev-latest alias),
 * checked 2026-09-30: $0.042 per million input tokens, output tokens free.
 * Re-check this when JEV_PINNED_MODEL changes.
 */
export const JEV_PRICING: DecisionPricing = {
  inputUsdPerMillionTokens: 0.042,
  outputUsdPerMillionTokens: 0,
};

/** Keys shorter than this are rejected (they are typos, and would not mask). */
export const JEV_API_KEY_MIN_LENGTH = 8;
export const JEV_API_KEY_MAX_LENGTH = 4096;

const MODE_TTL_MS = 10_000;

export function isJevMode(v: unknown): v is JevMode {
  return typeof v === 'string' && (JEV_MODES as readonly string[]).includes(v);
}

export function jevModeKey(workspaceId: string): string {
  return `jev_memory_injection:${workspaceId}`;
}

/**
 * How long a read of the stored key is reused (WI-10004485). Every memory recall
 * resolves the key once for the effective-mode gate and, in Log only / On, once
 * more inside the decision client, so an uncached read cost two Postgres
 * round-trips per recall (about 60,000 recalls a day). That read sits BEFORE the
 * client arms its 400 ms deadline, so a slow pool acquire inflated the recorded
 * latency (answered calls at 1-3 s on 2026-10-01). A save in this process
 * refreshes the entry at once; a save in another process is seen within the TTL.
 */
const KEY_TTL_MS = 10_000;

const state = pinModuleState('@papercusp/operator-core.jev-settings', () => ({
  modeCache: new Map<string, { value: JevMode; at: number }>(),
  keyCache: null as { value: string | null; at: number } | null,
}));

/**
 * The user's chosen mode for a workspace. A read failure returns `off`: when we
 * cannot tell what the user chose, today's system is the only safe answer.
 */
export async function getJevMode(workspaceId: string = activeWorkspaceId()): Promise<JevMode> {
  const hit = state.modeCache.get(workspaceId);
  if (hit && Date.now() - hit.at < MODE_TTL_MS) return hit.value;
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT value FROM harness_shared.operator_settings
      WHERE key = ${jevModeKey(workspaceId)}
      LIMIT 1
    `;
    const raw = rows.length > 0 ? rows[0].value : null;
    const value: JevMode = isJevMode(raw) ? raw : 'off';
    state.modeCache.set(workspaceId, { value, at: Date.now() });
    return value;
  } catch {
    return 'off';
  }
}

export async function setJevMode(mode: JevMode, workspaceId: string = activeWorkspaceId()): Promise<JevMode> {
  if (!isJevMode(mode)) throw new Error(`invalid Jev mode: ${String(mode)}`);
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (
      ${jevModeKey(workspaceId)},
      ${mode},
      'TypeSafe Jev in memory injection: off | shadow | on (plan jev-decision-model-integration-2026-09-29, D-008)',
      ${Date.now()},
      ${workspaceId}
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
  state.modeCache.set(workspaceId, { value: mode, at: Date.now() });
  return mode;
}

/**
 * The stored Jev key, or null. A read failure is treated as "no key" (fail open to
 * today's system) and is NOT cached, so the next call reads again.
 */
export async function readJevApiKey(): Promise<string | null> {
  const hit = state.keyCache;
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.value;
  try {
    const key = await readIntegrationKey(JEV_API_KEY_NAME);
    const value = key && key.trim().length > 0 ? key.trim() : null;
    state.keyCache = { value, at: Date.now() };
    return value;
  } catch {
    return null;
  }
}

/** Validation message for a candidate key, or null when it is acceptable. */
export function jevApiKeyProblem(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length < JEV_API_KEY_MIN_LENGTH) return `The key is too short (at least ${JEV_API_KEY_MIN_LENGTH} characters).`;
  if (trimmed.length > JEV_API_KEY_MAX_LENGTH) return 'The key is too long.';
  if (/\s/.test(trimmed)) return 'The key must not contain spaces or line breaks.';
  return null;
}

/** Save (string) or clear (null) the Jev key. */
export async function setJevApiKey(key: string | null): Promise<void> {
  if (key !== null) {
    const problem = jevApiKeyProblem(key);
    if (problem) throw new Error(problem);
  }
  await writeIntegrationCredentials({ [JEV_API_KEY_NAME]: key === null ? null : key.trim() });
  state.keyCache = { value: key === null ? null : key.trim(), at: Date.now() };
}

export interface JevMemoryInjectionResolution {
  /** What the user chose. */
  readonly mode: JevMode;
  readonly keyPresent: boolean;
  /** What consumers must act on: `off` unless mode ≠ off AND a key is stored. */
  readonly effective: JevMode;
}

/** THE gate for every memory-injection consumer. `effective === 'off'` ⇒ make zero Jev calls. */
export async function resolveJevMemoryInjection(workspaceId: string = activeWorkspaceId()): Promise<JevMemoryInjectionResolution> {
  const mode = await getJevMode(workspaceId);
  if (mode === 'off') return { mode, keyPresent: (await readJevApiKey()) !== null, effective: 'off' };
  const keyPresent = (await readJevApiKey()) !== null;
  return { mode, keyPresent, effective: keyPresent ? mode : 'off' };
}

export interface JevSettingsView {
  readonly mode: JevMode;
  readonly keyPresent: boolean;
  /** e.g. `ts-...9f2c`; null when there is no key (or it is too short to mask). */
  readonly maskedKey: string | null;
  readonly effective: JevMode;
  /** The pinned model id calls are made with. */
  readonly model: string;
}

export async function getJevSettingsView(workspaceId: string = activeWorkspaceId()): Promise<JevSettingsView> {
  const mode = await getJevMode(workspaceId);
  const key = await readJevApiKey();
  return {
    mode,
    keyPresent: key !== null,
    maskedKey: maskIntegrationKey(key),
    effective: key !== null ? mode : 'off',
    model: JEV_PINNED_MODEL,
  };
}

/**
 * The process-wide decision client, installed on first use. The key is resolved
 * per call, so saving or clearing it in Settings takes effect without a restart.
 */
export function ensureJevDecisionClient(): DecisionClient {
  const existing = getDecisionClient();
  if (existing) return existing;
  const client = createDecisionClient({
    provider: createJevProvider(),
    resolveKey: readJevApiKey,
    timeoutMs: JEV_MEMORY_TIMEOUT_MS,
    // P-006 (jev-memory-timeouts-to-zero-2026-10-01): keep the Jev socket open between
    // calls — the default global fetch reconnected on almost every call.
    fetch: jevFetch,
    // P-003: every call — answered or inconclusive — lands in decision_model_calls.
    // Fire-and-forget; the client never awaits it and swallows its faults.
    // Pricing is passed so cost_usd is filled in; without it every row's cost is null.
    // WI-10005694: a provider refusal only the owner can fix (402 no credits,
    // 401/403 bad key) notifies the owner once a day instead of failing silently.
    onCall: (record) =>
      Promise.all([
        recordDecisionModelCall(record, { pricing: JEV_PRICING }),
        alertOwnerOnJevAccountRefusal(record).catch((err) => {
          console.warn(`[jev-account-alert] owner notification failed: ${err instanceof Error ? err.message : String(err)}`);
        }),
      ]).then(() => undefined),
  });
  configureDecisionModel(client);
  return client;
}

export function __resetJevSettingsCacheForTest(): void {
  state.modeCache.clear();
  state.keyCache = null;
}
