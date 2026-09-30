#!/usr/bin/env node
/**
 * Executable entry for the supervised hive inference gateway (hive-inference-gateway P-013).
 *
 * Thin wrapper: the whole main lives in ./sidecar-main (runGatewaySidecarMain) so the
 * SAME gateway process can also be entered from the packaged desktop bundle via the
 * serve.ts `PAPERCUSP_GATEWAY_SIDECAR_MODE=1` re-exec divert (P-006,
 * cross-platform-hardening-and-agent-ergonomics-2026-07-05). This entry is what the
 * `papercup-inference-gateway` systemd --user unit runs (Restart=always = fail-closed)
 * — systemd remains the Linux-dev-box supervisor; the desktop app supervises via
 * gateway-sidecar-spawn.ts instead.
 *
 * Env: see ./sidecar-main.ts.
 */
import { runGatewaySidecarMain, gatewayLogLine } from './sidecar-main';

runGatewaySidecarMain().catch((e) => {
  try {
    gatewayLogLine(`fatal: ${(e as Error)?.stack || String(e)}`);
  } catch {
    console.error('[inference-gateway] fatal:', e);
  }
  process.exit(1);
});
