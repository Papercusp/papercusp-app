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
 * Per-sample durations for one V8 CPU profile (WI-10005421).
 *
 * `timeDeltas[i]` is the time from the PREVIOUS sample (or from `startTime`, for
 * i = 0) to sample i. A sample shows the stack at one instant, so sample i is
 * credited with the interval that FOLLOWS it, [t_i, t_{i+1}). Chrome DevTools'
 * CPUProfileDataModel does the same. Two kinds of interval are credited to NO
 * frame, because nothing was sampled during them:
 *   - the lead-in, startTime..t_0 (`timeDeltas[0]`), reported as `leadInUs`;
 *   - any interval longer than max(minGapUs, gapFactor x the median interval).
 *     The sampler recorded nothing for that stretch (a stalled or starved
 *     process). The sample before it is credited one nominal interval, and the
 *     rest is reported as `unsampledGapUs`.
 * Crediting either interval to the adjacent sample's frame invents seconds of
 * "self time" for whatever frame happened to be on top. Sentinel stall profiles
 * open with a 1.6-2.3 s lead-in, so this is the common case for them, not a corner.
 */
export function sampleDurations(profile, { gapFactor = 20, minGapUs = 50_000 } = {}) {
  const samples = profile?.samples ?? [];
  const deltas = profile?.timeDeltas ?? [];
  const n = samples.length;
  const durations = new Float64Array(n);
  const intervals = [];
  for (let i = 1; i < n; i += 1) intervals.push(Math.max(0, deltas[i] ?? 0));
  const sorted = [...intervals].sort((a, b) => a - b);
  const nominalIntervalUs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const gapThresholdUs = Math.max(minGapUs, nominalIntervalUs * gapFactor);
  const leadInUs = n ? Math.max(0, deltas[0] ?? 0) : 0;

  let lastSampleUs = Number(profile?.startTime);
  if (Number.isFinite(lastSampleUs)) for (let i = 0; i < n; i += 1) lastSampleUs += deltas[i] ?? 0;
  const endTime = Number(profile?.endTime);

  let unsampledGapUs = 0;
  const gaps = [];
  for (let i = 0; i < n; i += 1) {
    let us;
    if (i + 1 < n) us = Math.max(0, deltas[i + 1] ?? 0);
    else if (Number.isFinite(endTime) && Number.isFinite(lastSampleUs) && endTime > lastSampleUs) {
      us = endTime - lastSampleUs;
    } else us = nominalIntervalUs;
    if (us > gapThresholdUs) {
      gaps.push({ index: i, us });
      unsampledGapUs += us - nominalIntervalUs;
      us = nominalIntervalUs;
    }
    durations[i] = us;
  }
  return { durations, nominalIntervalUs, gapThresholdUs, leadInUs, unsampledGapUs, gaps };
}

/**
 * Aggregate self-time from one V8 CPU profile. The returned `frames` are sorted
 * descending by self-time so callers can apply their own display limit.
 * `leadInUs` and `unsampledGapUs` are wall time the profile did NOT sample; they
 * are not part of `totalUs` and never credited to a frame (see sampleDurations).
 */
export function aggregateCpuProfile(profile) {
  const nodeById = new Map((profile?.nodes ?? []).map((node) => [node.id, node]));
  const samples = profile?.samples ?? [];
  const { durations, nominalIntervalUs, leadInUs, unsampledGapUs, gaps } = sampleDurations(profile);
  const selfUs = new Map();

  for (let i = 0; i < samples.length; i += 1) {
    const sampleId = samples[i];
    selfUs.set(sampleId, (selfUs.get(sampleId) || 0) + durations[i]);
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
    nominalIntervalUs,
    leadInUs,
    unsampledGapUs,
    gapCount: gaps.length,
    frames: [...byFrame.entries()].sort((a, b) => b[1] - a[1]),
  };
}
