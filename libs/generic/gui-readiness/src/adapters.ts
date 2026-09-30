/**
 * Small, generic OS-level adapters that satisfy `ReadinessProbe`/`LivenessProbe`
 * without pulling in anything app-specific. These are optional convenience —
 * `waitUntilReady`/`measureGuiColdStart` only need the two interfaces in
 * `types.ts`, so a caller with a richer readiness signal (an authenticated HTTP
 * health check, a DOM/webview eval, a debug-bridge round-trip) should write its
 * own tiny probe instead of forcing it through these.
 */
import net from 'node:net';
import type { LivenessProbe, ReadinessProbe } from './types.js';

/**
 * `LivenessProbe` for a plain OS pid. `process.kill(pid, 0)` sends no signal —
 * it only asks the kernel "does this pid exist and can I signal it" — so this
 * is a cheap, synchronous liveness check with no side effects. `EPERM` means the
 * process exists but is owned by someone else (still alive); any other error
 * (typically `ESRCH`) means it's gone.
 */
export function pidLivenessProbe(pid: number): LivenessProbe {
  return {
    async isAlive(): Promise<boolean> {
      if (!pid || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
      }
    },
  };
}

/**
 * `ReadinessProbe` that succeeds once a TCP connect to `host:port` succeeds —
 * "is something listening yet". A LEVEL check by construction: each call opens
 * and closes its own fresh socket, so it always reflects the CURRENT bind state,
 * never a cached "it was listening once" result. Give it a short `connectTimeoutMs`
 * well under the wait's `probeTimeoutMs` so a single slow/filtered connect can't
 * eat a whole poll round.
 */
export function tcpPortProbe(port: number, host = '127.0.0.1', connectTimeoutMs = 2000): ReadinessProbe {
  return {
    checkReady(): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const socket = net.connect({ port, host });
        let settled = false;
        const done = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(value);
        };
        const timer = setTimeout(() => done(false), connectTimeoutMs);
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
      });
    },
  };
}
