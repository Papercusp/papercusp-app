import type { ControllerMsg } from './recorder-channel';

export interface RecorderStartParams {
  runId: string;
  durationMs: number;
  blocklist: string[];
  dryRun: boolean;
}

export function appendRecorderStartParams(url: URL, params: RecorderStartParams): void {
  url.searchParams.set('perf-recorder', '1');
  url.searchParams.set('perf-run-id', params.runId);
  url.searchParams.set('perf-duration-ms', String(params.durationMs));
  url.searchParams.set('perf-dry-run', params.dryRun ? '1' : '0');
  url.searchParams.delete('perf-block');
  params.blocklist.forEach((item) => url.searchParams.append('perf-block', item));
}

export function readRecorderStartParams(params: URLSearchParams): Extract<ControllerMsg, { type: 'start' }> | null {
  const runId = params.get('perf-run-id');
  const durationMs = Number(params.get('perf-duration-ms') || '0');
  if (!runId || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return {
    type: 'start',
    runId,
    durationMs,
    blocklist: params.getAll('perf-block'),
    dryRun: params.get('perf-dry-run') === '1',
  };
}
