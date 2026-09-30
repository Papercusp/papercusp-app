/**
 * embed-device-setting.ts — the Settings choice of embedding device
 * (Auto / GPU / CPU), stored in Postgres and applied to THIS process
 * (plan memory-reduction-2026-09-24, P-008 / D-003 / D-008; WI-10002872).
 *
 * `@papercusp/memory` owns the device DECISION and stays storage-free: it takes
 * the choice through `setEmbedDeviceSetting`. This module is the host half —
 * the one `harness_shared.operator_embed_device` row per workspace, and the
 * three moments a process applies it:
 *
 *  1. at the embed sidecar's boot, BEFORE it warms its models
 *     (`embed-sidecar-server.ts`), so they load on the chosen device;
 *  2. lazily, before the first in-process embedder is built
 *     (`ensureEmbedDeviceSettingLoaded`, from `embed-sidecar-wiring.ts`), which
 *     covers every host that embeds in-process (the desktop app) without a
 *     per-host boot hook;
 *  3. when the setting is saved (`POST /api/user/embed-device`), in the writing
 *     process and — via `POST /embed-device/reload` — in a configured sidecar.
 *
 * A concrete `PAPERCUSP_EMBED_DEVICE` (cpu|gpu) on a host outranks the row
 * (D-008); `@papercusp/memory` applies that precedence, not this module.
 *
 * Failure policy: reading the row can fail (PG down, table not migrated yet).
 * That must never cost embeddings, so every read failure degrades to "no
 * setting" (env/auto) and is reported, never thrown into the embed path.
 */
import {
  embedDeviceSetting,
  parseEmbedDevicePreference,
  recycleEmbedWorker,
  setEmbedDeviceSetting,
  type EmbedDevicePreference,
} from '@papercusp/memory';
import { pinModuleState } from '@papercusp/module-singleton';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';

/** The stored row. `preference` is validated on every read — a bad row reads as "no setting". */
export type EmbedDeviceSettingRow = {
  preference?: unknown;
  /** Who last saved it (display only). */
  updatedBy?: unknown;
};

export type EmbedDeviceSettingLoad = {
  /** The choice now held by this process (`null` = none, so env/auto applies). */
  setting: EmbedDevicePreference | null;
  /** Whether the effective preference changed (and the worker was recycled). */
  changed: boolean;
  /** Why the row could not be read, when it could not. `null` = read fine. */
  readError: string | null;
};

/** Seams for tests: the row read, and the worker recycle a change triggers. */
export type EmbedDeviceSettingDeps = {
  read: () => Promise<EmbedDevicePreference | null>;
  recycle: () => Promise<void>;
};

/** Bound on a boot/first-embed read: embeddings must not wait long on a slow PG. */
export const EMBED_DEVICE_SETTING_READ_TIMEOUT_MS = 5_000;

/** Read the stored choice. Throws on a read failure — callers decide how to degrade. */
export async function readEmbedDeviceSetting(): Promise<EmbedDevicePreference | null> {
  const row = await readOperatorState<EmbedDeviceSettingRow>('operator_embed_device');
  return parseEmbedDevicePreference(row?.preference);
}

/** Persist the choice. The caller applies it (see `loadEmbedDeviceSetting`). */
export async function writeEmbedDeviceSetting(preference: EmbedDevicePreference, updatedBy: string): Promise<void> {
  await writeOperatorState<EmbedDeviceSettingRow>('operator_embed_device', { preference, updatedBy });
}

const defaultDeps: EmbedDeviceSettingDeps = {
  read: readEmbedDeviceSetting,
  recycle: recycleEmbedWorker,
};

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Read the stored choice and apply it to this process. A change of effective
 * device recycles the embed worker gracefully (in-flight embeds finish first).
 *
 * Never throws. When the row cannot be read the process KEEPS the choice it
 * already holds (a transient PG blip must not flip a running GPU host to auto)
 * and `readError` says why.
 */
export async function loadEmbedDeviceSetting(
  deps: EmbedDeviceSettingDeps = defaultDeps,
  timeoutMs: number = EMBED_DEVICE_SETTING_READ_TIMEOUT_MS,
): Promise<EmbedDeviceSettingLoad> {
  let setting: EmbedDevicePreference | null;
  try {
    setting = await withTimeout(deps.read(), timeoutMs, 'reading the embedding-device setting');
  } catch (e) {
    const readError = e instanceof Error ? e.message : String(e);
    // Infrastructure state, not a code fault: under a test runner it goes to the
    // log channel so fail-on-console does not red whichever test happened to build
    // the first embedder (the same reasoning as embed-sidecar-wiring's
    // reportSidecarTransition). Production keeps warn.
    const line = `[embed-device] could not read the Settings choice (${readError}); keeping the current device choice`;
    if (process.env.VITEST || process.env.NODE_ENV === 'test') console.log(line);
    else console.warn(line);
    return { setting: embedDeviceSetting(), changed: false, readError };
  }
  const { changed } = setEmbedDeviceSetting(setting);
  if (changed) await deps.recycle();
  return { setting, changed, readError: null };
}

const loaded = pinModuleState<{ first: Promise<EmbedDeviceSettingLoad> | null }>(
  '@papercusp/operator-core.embed-device-setting',
  () => ({ first: null }),
);

/**
 * Load the setting ONCE per process, before the first in-process embedder is
 * built. Later changes arrive through `loadEmbedDeviceSetting` (the save route
 * and the sidecar's reload), not through this memo. A failed first read is
 * memoized too: it already degraded to env/auto, and retrying on every embedder
 * build would put a PG round-trip on the embed path.
 */
export function ensureEmbedDeviceSettingLoaded(deps: EmbedDeviceSettingDeps = defaultDeps): Promise<EmbedDeviceSettingLoad> {
  if (!loaded.first) loaded.first = loadEmbedDeviceSetting(deps);
  return loaded.first;
}

/** Test-only: forget the once-per-process load. */
export function _resetEmbedDeviceSettingLoadForTests(): void {
  loaded.first = null;
}
