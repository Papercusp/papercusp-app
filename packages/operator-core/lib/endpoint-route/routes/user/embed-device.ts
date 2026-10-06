/**
 * /api/user/embed-device — the "Embedding device" section of the memory
 * settings page (plan memory-reduction-2026-09-24 P-008 / D-003 / D-008;
 * WI-10002872).
 *
 * GET returns the stored choice (Auto / GPU / CPU), WHICH process embeds for
 * this host (the shared embedding sidecar, or this process when none is
 * configured), and what that process reports it is actually running on —
 * requested vs active device, the device each model's pipeline constructed on,
 * and any GPU→CPU demotion. The section renders "In use" from that report, never
 * from the stored choice: a GPU choice can still fall back to the CPU.
 *
 * POST `{ preference: 'auto' | 'gpu' | 'cpu' }` stores the choice, applies it to
 * THIS process, and asks the sidecar (if any) to re-read it via
 * `POST /embed-device/reload` — so a change takes effect without a restart.
 * `applied` says what each process did. A sidecar that 404s that route is an
 * older build: the choice is stored and applies once it restarts.
 *
 * Other processes that embed in-process read the choice before their first
 * embed and pick up later changes when they restart.
 *
 * Auth tier: as the sibling /user/knowledge-pack-settings — GET `public`
 * (single-user install; the desktop webview carries no session cookie), POST
 * `loopback` (a mutating route stays loopback-or-better).
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  embedExecutionHealth,
  parseEmbedDevicePreference,
  resolveEmbedSidecarUrl,
  type EmbedDevicePreference,
  type EmbedExecutionHealth,
} from '@papercusp/memory';
import {
  loadEmbedDeviceSetting,
  readEmbedDeviceSetting,
  writeEmbedDeviceSetting,
  type EmbedDeviceSettingLoad,
} from '../../../memory/embed-device-setting';
import { EMBED_SIDECAR_CAP_DEVICE_RELOAD } from '../../../memory/embed-sidecar-server';
import { embedSidecarEnabled, embedSidecarLocalUrl, probeSidecarHealth } from '../../../memory/embed-sidecar-spawn';

/** Which process embeds for this host. `sidecar-idle` (P-530): this Server
 *  spawns its sidecar on demand and none is running now; the next one reads
 *  the stored setting when it starts. */
export type EmbedDeviceHost = { kind: 'sidecar'; url: string } | { kind: 'sidecar-idle' } | { kind: 'in-process' };

/** What the embedding host reports about its device, or why it could not be read. */
export type EmbedDeviceHostReport = {
  health: EmbedExecutionHealth | null;
  /** `null` = the report was read. Otherwise a sentence for the user. */
  error: string | null;
  /** Sidecar only: whether its build serves `POST /embed-device/reload`. `null` = unknown / in-process. */
  reloadSupported: boolean | null;
};

/** The sidecar's answer to a reload, as the route relays it. */
export type EmbedDeviceSidecarApply =
  | { ok: true; changed: boolean; readError: string | null; rewarm: unknown }
  | { ok: false; restartNeeded: boolean; error: string };

export type EmbedDeviceEnvelope = {
  /** The stored choice; `null` = never set (Auto applies). */
  setting: EmbedDevicePreference | null;
  /** Why the stored choice could not be read, when it could not. */
  settingError: string | null;
  host: EmbedDeviceHost;
  health: EmbedDeviceHostReport['health'];
  healthError: EmbedDeviceHostReport['error'];
  reloadSupported: EmbedDeviceHostReport['reloadSupported'];
};

export type EmbedDeviceRouteDeps = {
  readSetting: () => Promise<EmbedDevicePreference | null>;
  writeSetting: (preference: EmbedDevicePreference, updatedBy: string) => Promise<void>;
  /** Apply the stored choice to THIS process (recycles its worker on a change). */
  applyLocal: () => Promise<EmbedDeviceSettingLoad>;
  resolveHost: () => EmbedDeviceHost;
  /** `/healthz` of the sidecar at `url`, or `null` when nothing healthy answers. */
  probeSidecar: (url: string) => Promise<unknown | null>;
  localHealth: () => EmbedExecutionHealth;
  /** `POST {url}/embed-device/reload`. */
  reloadSidecar: (url: string) => Promise<{ status: number; body: unknown }>;
};

/** Bound on the sidecar reload: its re-warm is bounded at 45s, plus headroom. */
export const EMBED_DEVICE_RELOAD_TIMEOUT_MS = 60_000;

/** An explicit sidecar URL wins over the spawn-locally opt-in — the same order as `resolveProcessSidecarUrl`. */
export function resolveEmbedDeviceHost(): EmbedDeviceHost {
  const explicit = resolveEmbedSidecarUrl();
  if (explicit) return { kind: 'sidecar', url: explicit.replace(/\/$/, '') };
  if (embedSidecarEnabled()) {
    const url = embedSidecarLocalUrl();
    return url ? { kind: 'sidecar', url } : { kind: 'sidecar-idle' };
  }
  return { kind: 'in-process' };
}

async function postSidecarReload(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}/embed-device/reload`, {
    method: 'POST',
    signal: AbortSignal.timeout(EMBED_DEVICE_RELOAD_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // a non-JSON answer (e.g. an old build's plain 404) — the status decides
  }
  return { status: res.status, body };
}

const defaultDeps: EmbedDeviceRouteDeps = {
  readSetting: readEmbedDeviceSetting,
  writeSetting: writeEmbedDeviceSetting,
  applyLocal: () => loadEmbedDeviceSetting(),
  resolveHost: resolveEmbedDeviceHost,
  probeSidecar: (url) => probeSidecarHealth(url),
  localHealth: embedExecutionHealth,
  reloadSidecar: postSidecarReload,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readHostReport(deps: EmbedDeviceRouteDeps, host: EmbedDeviceHost): Promise<EmbedDeviceHostReport> {
  if (host.kind === 'in-process') return { health: deps.localHealth(), error: null, reloadSupported: null };
  if (host.kind === 'sidecar-idle') return { health: null, error: null, reloadSupported: null };
  const body = await deps.probeSidecar(host.url);
  if (!isRecord(body)) {
    return { health: null, error: `The embedding sidecar at ${host.url} did not answer.`, reloadSupported: null };
  }
  const reloadSupported = Array.isArray(body.capabilities)
    ? body.capabilities.includes(EMBED_SIDECAR_CAP_DEVICE_RELOAD)
    : false;
  if (!isRecord(body.embedExecutionHealth)) {
    return {
      health: null,
      error: 'This embedding sidecar build does not report its device. Restart it to pick up the current build.',
      reloadSupported,
    };
  }
  return { health: body.embedExecutionHealth as EmbedExecutionHealth, error: null, reloadSupported };
}

async function buildEnvelope(deps: EmbedDeviceRouteDeps): Promise<EmbedDeviceEnvelope> {
  const host = deps.resolveHost();
  const [stored, report] = await Promise.all([
    deps.readSetting().then(
      (setting) => ({ setting, settingError: null }),
      (e: unknown) => ({ setting: null, settingError: e instanceof Error ? e.message : String(e) }),
    ),
    readHostReport(deps, host),
  ]);
  return {
    ...stored,
    host,
    health: report.health,
    healthError: report.error,
    reloadSupported: report.reloadSupported,
  };
}

async function applyToSidecar(deps: EmbedDeviceRouteDeps, url: string): Promise<EmbedDeviceSidecarApply> {
  let answer: { status: number; body: unknown };
  try {
    answer = await deps.reloadSidecar(url);
  } catch (e) {
    return {
      ok: false,
      restartNeeded: false,
      error: `Could not reach the embedding sidecar at ${url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (answer.status === 404) {
    return {
      ok: false,
      restartNeeded: true,
      error: 'The running embedding sidecar predates this setting. The choice is saved and applies when it restarts.',
    };
  }
  if (answer.status !== 200 || !isRecord(answer.body)) {
    const detail = isRecord(answer.body) && typeof answer.body.error === 'string' ? `: ${answer.body.error}` : '';
    return { ok: false, restartNeeded: false, error: `The embedding sidecar answered ${answer.status}${detail}` };
  }
  return {
    ok: true,
    changed: answer.body.changed === true,
    readError: typeof answer.body.readError === 'string' ? answer.body.readError : null,
    rewarm: answer.body.rewarm ?? null,
  };
}

export function createEmbedDeviceRoutes(deps: EmbedDeviceRouteDeps = defaultDeps) {
  const get = defineTool({
    method: 'GET',
    path: '/user/embed-device',
    auth: 'public',
    async handler() {
      return Response.json(await buildEnvelope(deps));
    },
  });

  const set = defineTool({
    method: 'POST',
    path: '/user/embed-device',
    auth: 'loopback',
    async handler(req) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
      }
      const preference = isRecord(body) ? parseEmbedDevicePreference(body.preference) : null;
      if (!preference) {
        return Response.json(
          { ok: false, error: "preference must be one of 'auto', 'gpu', 'cpu'" },
          { status: 400 },
        );
      }
      await deps.writeSetting(preference, 'settings');
      const thisProcess = await deps.applyLocal();
      const host = deps.resolveHost();
      const sidecar = host.kind === 'sidecar' ? await applyToSidecar(deps, host.url) : null;
      return Response.json({ ok: true, ...(await buildEnvelope(deps)), applied: { thisProcess, sidecar } });
    },
  });

  return [get, set];
}

export default createEmbedDeviceRoutes();
