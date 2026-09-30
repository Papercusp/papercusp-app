import { runLiveHealthMonitorMain } from './live-health-monitor-main';

runLiveHealthMonitorMain().catch((error) => {
  console.error('[resource-governor-health] fatal:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
