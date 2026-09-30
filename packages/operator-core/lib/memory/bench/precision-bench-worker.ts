/**
 * Child-process entry point for the scheduled memory precision bench.
 *
 * Keep this boundary deliberately tiny: importing the bench core here gives it
 * its own process-global memory host/client, while the parent only receives the
 * final metrics over stdout.
 */
import { benchMemoryPrecision, PRECISION_BENCH_RESULT_MARKER } from './precision-monitor';

try {
  const metrics = await benchMemoryPrecision();
  process.stdout.write(`${PRECISION_BENCH_RESULT_MARKER}${JSON.stringify(metrics)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
