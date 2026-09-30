import { LiveHealthMonitor, type LiveHealthMonitorOptions } from './live-health-monitor';

export const LIVE_HEALTH_MONITOR_READY_PREFIX = 'PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_READY';

export interface LiveHealthMonitorMainHandle {
  readonly monitor: LiveHealthMonitor;
  stop(): Promise<void>;
}

/** Standalone child entry shared by dev-tsx and packaged bundle re-exec. */
export async function runLiveHealthMonitorMain(
  options: LiveHealthMonitorOptions = {},
): Promise<LiveHealthMonitorMainHandle> {
  const monitor = new LiveHealthMonitor(options);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    monitor.stop();
    process.stdin.pause();
  };
  const shutdown = () => {
    void stop().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  // The managed timer is deliberately unref'd. The parent-owned stdin pipe is
  // the lifetime handle: closing it tears down a dev or packaged child alike.
  process.stdin.resume();
  const first = await monitor.start();
  process.stdout.write(`${LIVE_HEALTH_MONITOR_READY_PREFIX} ${monitor.paths.snapshotPath} ${first.schemaVersion}\n`);
  return { monitor, stop };
}
