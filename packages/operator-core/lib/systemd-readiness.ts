/**
 * systemd readiness notification for long-starting operator hosts.
 *
 * Type=notify services must not become active until the request listener is
 * bound. The helper is deliberately fire-and-forget: an unavailable notifier
 * must never turn a healthy HTTP host into a crash loop.
 */
import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10_000;
const SYSTEMD_NOTIFY_BIN = 'systemd-notify';

function notifyTimeoutMs(): number {
  const configured = Number(process.env.PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, configured);
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown systemd-notify failure';
  }
}

function logFailure(message: string): void {
  try {
    console.warn('[systemd-readiness] ' + message);
  } catch {
    // Logging is best effort. A notifier failure must not crash the host.
  }
}

/** Notify systemd after the HTTP server has actually bound its listener. */
export function notifySystemdReady(): void {
  if (!process.env.NOTIFY_SOCKET) return;

  try {
    execFile(
      SYSTEMD_NOTIFY_BIN,
      ['--ready'],
      { timeout: notifyTimeoutMs() },
      (error) => {
        if (error) {
          logFailure('systemd-notify --ready failed: ' + errorMessage(error));
        }
      },
    );
  } catch (error) {
    logFailure('unable to invoke systemd-notify --ready: ' + errorMessage(error));
  }
}
