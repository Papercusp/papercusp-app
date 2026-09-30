import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifyConfig, VerifyResult } from './types.js';

export interface ResolvedBridge {
  port: number;
  token: string;
  pid: number | null;
}

export async function resolveBridge(config: VerifyConfig): Promise<VerifyResult<ResolvedBridge>> {
  if (config.bridgePort && config.bridgeToken) {
    return {
      ok: true,
      value: { port: config.bridgePort, token: config.bridgeToken, pid: config.tauriPID ?? null },
    };
  }
  if (config.bridgePort || config.bridgeToken) {
    return {
      ok: false,
      code: 'incomplete_bridge_target',
      error: 'Pass bridgePort and bridgeToken together, or pass tauriPID.',
    };
  }
  if (!config.tauriPID || config.tauriPID <= 0) {
    return {
      ok: false,
      code: 'target_required',
      error:
        'Tauri target required: pass tauriPID (recommended), or bridgePort + bridgeToken. ' +
        'Run `tauri-agent-tools probe --json` to list exact targets.',
    };
  }

  const tokenPath = join(tmpdir(), `tauri-dev-bridge-${config.tauriPID}.token`);
  try {
    const parsed = JSON.parse(await readFile(tokenPath, 'utf8')) as {
      port?: unknown;
      token?: unknown;
      pid?: unknown;
    };
    const port = Number(parsed.port);
    const pid = Number(parsed.pid);
    if (!Number.isInteger(port) || port <= 0 || typeof parsed.token !== 'string' || !parsed.token) {
      throw new Error('token file is missing a valid port/token');
    }
    if (Number.isInteger(pid) && pid > 0 && pid !== config.tauriPID) {
      throw new Error(`token belongs to PID ${pid}, not ${config.tauriPID}`);
    }
    return { ok: true, value: { port, token: parsed.token, pid: config.tauriPID } };
  } catch (error) {
    return {
      ok: false,
      code: 'bridge_token_unavailable',
      error: `Cannot resolve Tauri PID ${config.tauriPID}: ${error instanceof Error ? error.message : String(error)}`,
      evidence: { tokenPath },
    };
  }
}

export async function bridgeEval<T = unknown>(
  config: VerifyConfig,
  js: string,
): Promise<VerifyResult<T>> {
  const bridge = await resolveBridge(config);
  if (!bridge.ok) return bridge;
  const timeout = config.timeout ?? 10_000;
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.value.port}/eval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        js,
        token: bridge.value.token,
        ...(config.windowLabel ? { window: config.windowLabel } : {}),
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        code: response.status === 401 || response.status === 403 ? 'bridge_auth_failed' : 'bridge_http_error',
        error: `Tauri bridge eval failed (${response.status})${body ? `: ${body}` : ''}`,
        evidence: { port: bridge.value.port, pid: bridge.value.pid },
      };
    }
    const payload = (await response.json()) as { result?: T; error?: unknown };
    if (payload.error != null) {
      return {
        ok: false,
        code: 'webview_eval_failed',
        error: `Webview eval failed: ${String(payload.error)}`,
        evidence: { port: bridge.value.port, pid: bridge.value.pid },
      };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
      return { ok: false, code: 'invalid_bridge_response', error: 'Tauri bridge response omitted result.' };
    }
    return { ok: true, value: payload.result as T };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error && error.name === 'TimeoutError' ? 'bridge_timeout' : 'bridge_unreachable',
      error: `Tauri bridge eval failed: ${error instanceof Error ? error.message : String(error)}`,
      evidence: { port: bridge.value.port, pid: bridge.value.pid },
    };
  }
}
