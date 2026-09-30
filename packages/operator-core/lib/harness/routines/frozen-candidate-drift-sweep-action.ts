/**
 * `system:frozen-candidate-drift-sweep` — the ATTESTATION leg of
 * frozen-candidate-compliance-enforcement-2026-08-30 (P-008).
 *
 * WIRING ONLY. The detection and the finding body are pure and unit-tested in
 * `../../release/frozen-candidate-drift-sweep.ts`; this module binds them to git and the
 * improvements store. That split is deliberate — the lambdas-inside-a-closure shape has
 * already cost this repo a load-bearing blind spot (EI-21559794492221235), because a test
 * can only pin the source text of an adapter it cannot execute.
 *
 * WHAT IT ANSWERS. Every other item in that plan PREVENTS the failure; none of them can say
 * whether prevention worked. This reports the residual: commits touching the frozen
 * candidate's failing paths that landed above it while the gate was frozen. The plan
 * succeeded when this finding stops being filed.
 *
 * FAIL-CLOSED AND SILENT. No frozen marker, no git, no failing set ⇒ no finding. It never
 * reports a zero, because a zero from a sweep that could not measure is indistinguishable
 * from a real one — the exact all-clear this plan's own detectors are written to avoid.
 */
import { spawnSync } from 'node:child_process';
import { registerSystemAction } from './system-actions';

registerSystemAction('frozen-candidate-drift-sweep', async () => {
  const [{ readFrozenRepairMarker }, { detectFrozenCandidateDrift, parseDriftCommits }, { integrationRoot }, { integrationBranch }] =
    await Promise.all([
      import('../../release/frozen-repair-edit-marker'),
      import('../../release/frozen-candidate-drift-sweep'),
      import('../../release-deploy-launch'),
      import('../../release/judged-sha-containment'),
    ]);

  const marker = readFrozenRepairMarker();
  if (!marker) return; // nothing frozen — the common case

  const root = integrationRoot();
  const branch = integrationBranch();
  // `%x00` separates commits; `%H` then the trailer then --name-only paths. The
  // `Papercusp-Agent:` trailer is the ONLY trustworthy attribution here — git-sync commits
  // the whole tree under one identity, so blame and the subject both name the wrong agent.
  const log = spawnSync(
    'git',
    [
      '-C',
      root,
      'log',
      `${marker.candidate}..${branch}`,
      '--no-merges',
      '--name-only',
      '--format=%x00%H%n%(trailers:key=Papercusp-Agent)',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (log.status !== 0 || typeof log.stdout !== 'string') return; // cannot measure ⇒ say nothing

  const finding = detectFrozenCandidateDrift({
    marker,
    commitsAboveCandidate: parseDriftCommits(log.stdout),
  });
  if (!finding) return;

  const { captureImprovement } = await import('../improvements/capture-core');
  await captureImprovement({
    kind: 'bug',
    title: finding.title,
    body: finding.body,
    severity: 'minor',
    subTopic: 'release-gate',
    foundDuring: 'system:frozen-candidate-drift-sweep',
    paths: finding.paths.map((p) => p.path),
  }).catch(() => undefined); // report-only: a filing failure must not fail the sweep
});
