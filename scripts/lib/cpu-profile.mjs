/**
 * Classify V8 CPU-profile frames shared by the live sampler and the saved-profile
 * analyzer. V8's `(idle)` and `(program)` frames describe profiler/non-work time,
 * so they must not dilute the real-workload denominator. `(garbage collector)` is
 * intentionally retained as real workload: GC consumes process CPU and the saved
 * profile analyzer reports it in its own bucket.
 */
export function classifyCpuFrame(functionName, url = '') {
  if (url.includes('inspector')) return 'profiler';
  if (functionName === '(idle)' || functionName === '(program)') return 'non-work';
  return null;
}

function shortUrl(url) {
  if (!url) return '(native)';
  let value = url.replace(/^file:\/\//, '');
  for (const marker of ['/papercup/', '/papercup-release/', '/papercusp/']) {
    const index = value.indexOf(marker);
    if (index >= 0) return value.slice(index + 1);
  }
  if (value.includes('/node_modules/')) return 'node_modules/' + value.split('/node_modules/').pop();
  return value;
}

/**
 * Aggregate self-time from one V8 CPU profile. The returned `frames` are sorted
 * descending by self-time so callers can apply their own display limit.
 */
export function aggregateCpuProfile(profile) {
  const nodeById = new Map((profile?.nodes ?? []).map((node) => [node.id, node]));
  const samples = profile?.samples ?? [];
  const timeDeltas = profile?.timeDeltas ?? [];
  const selfUs = new Map();

  for (let i = 0; i < samples.length; i += 1) {
    const delta = Math.max(0, timeDeltas[i] ?? 0);
    const sampleId = samples[i];
    selfUs.set(sampleId, (selfUs.get(sampleId) || 0) + delta);
  }

  let totalUs = 0;
  let excludedUs = 0;
  const excludedByKind = { profiler: 0, 'non-work': 0 };
  const byFrame = new Map();

  for (const [nodeId, us] of selfUs) {
    const callFrame = nodeById.get(nodeId)?.callFrame ?? {};
    const url = callFrame.url || '';
    const functionName = callFrame.functionName || '(anonymous)';
    const excludedKind = classifyCpuFrame(functionName, url);

    totalUs += us;
    if (excludedKind) {
      excludedUs += us;
      excludedByKind[excludedKind] += us;
      continue;
    }

    const key = `${functionName} @ ${shortUrl(url)}:${callFrame.lineNumber ?? '?'}`;
    byFrame.set(key, (byFrame.get(key) || 0) + us);
  }

  return {
    totalUs,
    excludedUs,
    excludedByKind,
    realUs: totalUs - excludedUs,
    frames: [...byFrame.entries()].sort((a, b) => b[1] - a[1]),
  };
}
