/**
 * Probe whether a TCP port can be bound on a host without retaining the
 * listener. This is shared by the headless `serve` entrypoint and the Hono
 * host's pre-bootstrap guard so they use the same OS-level availability check.
 */
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';

/**
 * Return true when the operating system accepts a temporary bind for `port`.
 *
 * Port 0 is intentionally allowed: Node uses it to request an ephemeral port,
 * and callers that support that mode should retain the existing behavior.
 * Invalid numeric ports resolve false instead of leaving a probe promise
 * unresolved after a synchronous `listen()` validation error.
 */
export function portAvailable(port: number, host: string): Promise<boolean> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;

    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      probe.removeListener('error', onError);
      if (probe.listening) {
        probe.close(() => resolve(available));
      } else {
        resolve(available);
      }
    };

    const onError = (): void => finish(false);

    probe.unref();
    probe.once('error', onError);
    try {
      probe.listen(port, host, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

/**
 * Synchronous companion for entrypoints that must probe before importing a
 * large startup graph. The child owns the asynchronous bind/close lifecycle;
 * the caller blocks only for that tiny probe and receives the same OS-level
 * answer without a top-level await (which `tsx` compiles to CommonJS).
 * A child startup/transport failure is not evidence that a port is occupied.
 * Throw for an unmeasured result so callers cannot mislabel it EADDRINUSE.
 */
export function portAvailableSync(port: number, host: string): boolean {
  if (!Number.isInteger(port) || port < 0 || port > 65535) return false;

  const probe = [
    "const net=require('node:net');",
    'const server=net.createServer();',
    "server.once('error',error=>{process.stdout.write(JSON.stringify({errorCode:error.code??'UNKNOWN'}));process.exitCode=1;});",
    `server.listen(${port}, ${JSON.stringify(host)}, () => server.close(() => {process.stdout.write('available');}));`,
  ].join('');
  const result = spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.status === 0 && result.stdout === 'available') return true;
  let errorCode: string | undefined;
  try {
    const report: unknown = JSON.parse(result.stdout ?? '');
    if (report && typeof report === 'object' && 'errorCode' in report && typeof report.errorCode === 'string') {
      errorCode = report.errorCode;
    }
  } catch {
    // No probe report means the subprocess failed before measuring the bind.
  }
  if (result.status === 1 && errorCode === 'EADDRINUSE') return false;
  const spawnCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  throw new Error(
    `Port availability probe failed for ${host}:${port}: ` +
      `code=${spawnCode ?? errorCode ?? 'unmeasured'} exit=${result.status} signal=${result.signal} ` +
      `stderrPresent=${Boolean(result.stderr)}`,
  );
}
