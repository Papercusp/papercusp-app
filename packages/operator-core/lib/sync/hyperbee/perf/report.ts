/**
 * report.ts — the shared per-run report renderer for the p2p-perf suite
 * (P-012 artifact parity).
 *
 * Extracted so EVERY tier emits the SAME human-readable `report.md` next to its
 * JSON artifacts — Tier 1/2 (runner.ts) and Tier 3 (the real-frame deploy
 * scenario) render identically, so a Tier-3 run's report drops in beside a
 * Tier-1 run's and reads the same. The JSON shape parity is already guaranteed
 * by `PerfArtifact` (artifact.ts, schema 1); this guarantees the prose parity.
 *
 * Pure: artifacts in → markdown string out. The runner owns artifact
 * persistence + the advisory baseline-comparison text (compare.ts); this only
 * formats. `runner.ts`'s inline renderReport can adopt this verbatim.
 */

import type { PerfArtifact } from './artifact';

export interface RenderReportOpts {
  runId: string;
  profile: string;
  artifacts: PerfArtifact[];
  /** Advisory baseline-comparison block (compare.ts formatCompareReport), if any. */
  compareText?: string | null;
  /** Title suffix, e.g. 'Tier 3 — real frames'. Default derived from tiers present. */
  titleSuffix?: string;
}

/** The first measured (count>0) metric — the scenario's headline number. */
function headlineMetric(a: PerfArtifact): { name: string; p95: number; unit: string } | null {
  const main = Object.entries(a.metrics).find(([, m]) => m.count > 0);
  return main ? { name: main[0], p95: main[1].p95, unit: main[1].unit } : null;
}

/**
 * The "what code produced this" block (D-026).
 *
 * Rendered from the FIRST artifact's run-level provenance, because the stamp
 * is a run-level capture — but the drift line is derived across ALL artifacts,
 * since drift is per-artifact by construction and a run where only the last
 * scenario ran different code is exactly the case a first-artifact-only read
 * would miss.
 *
 * Deliberately loud in three places, each of which is a way a reader could
 * otherwise quote a number that is not attributable: no provenance at all, a
 * submodule diverging from the recorded gitlink (so the sha is incomplete),
 * and a subject tree that moved mid-run (so the run is not one code state).
 */
export function renderProvenanceLines(artifacts: PerfArtifact[]): string[] {
  const p = artifacts.find((a) => a.provenance)?.provenance ?? null;
  if (!p) {
    return [
      '- code: **UNATTRIBUTED** — no run provenance on these artifacts. Do not quote these numbers as' +
        ' a property of any particular code state (D-026).',
    ];
  }
  const lines: string[] = [];
  const unattributed = artifacts.filter((a) => !a.provenance).length;
  if (unattributed) {
    lines.push(
      `- ⚠ provenance coverage: **${unattributed}/${artifacts.length} artifact(s) UNATTRIBUTED** —` +
        ' do not treat the attributed subset as covering the whole run',
    );
  }
  const sha = p.lastCommitSha ? p.lastCommitSha.slice(0, 12) : '(unknown)';
  lines.push(
    `- code: last commit \`${sha}\`${p.lastCommitAt ? ` (${p.lastCommitAt})` : ''}` +
      ` — LAST COMMIT, not tree state; see dirty below`,
  );
  if (p.subjectLastCommitSha && p.subjectLastCommitSha !== p.lastCommitSha) {
    lines.push(
      `- code (subject scope): last commit touching the code under test \`${p.subjectLastCommitSha.slice(0, 12)}\`` +
        `${p.subjectLastCommitAt ? ` (${p.subjectLastCommitAt})` : ''}`,
    );
  }
  if (p.submodulesDivergedFromGitlink === null) {
    lines.push('- submodules: **not probed** — the last-commit sha may be an incomplete description');
  } else if (p.submodulesDivergedFromGitlink.length) {
    lines.push(
      `- submodules: **${p.submodulesDivergedFromGitlink.length} DIVERGE from the recorded gitlink**` +
        ` (${p.submodulesDivergedFromGitlink.slice(0, 6).join(', ')}) —` +
        ' the last-commit sha above does NOT describe all the code that ran',
    );
  }
  if (p.worktree === null) {
    lines.push('- worktree: **not probed** — this is NOT evidence the tree was clean');
  } else {
    const inScope = p.worktree.dirtyPathsInScope;
    lines.push(
      `- worktree: ${p.worktree.dirtyFileCount ?? '?'} dirty path(s) tree-wide, digest \`${p.worktree.dirtyDigest ?? '?'}\`` +
        ` (fingerprint only — unique per run on a shared box, never a comparison key)`,
    );
    lines.push(
      inScope.length
        ? `- worktree (code under test): **${inScope.length} dirty${p.worktree.scopedTruncated ? '+' : ''}** — ${inScope.slice(0, 8).join(', ')}`
        : `- worktree (code under test): none dirty under ${p.worktree.scope.join(', ')}` +
            ' (scoped read — not a whole-tree clean verdict)',
    );
  }
  const drifted = [...new Set(artifacts.flatMap((a) => a.provenance?.subjectDriftSinceCapture ?? []))];
  if (drifted.length) {
    lines.push(
      `- ⚠ **subject tree moved mid-run** (${drifted.join(', ')}) — the run-start snapshot does not` +
        ' describe every artifact here; this run is not one code state',
    );
  }
  if (artifacts.some((a) => a.provenance && a.provenance.subjectDriftSinceCapture == null)) {
    lines.push(
      '- subject drift: **not fully probed** — this is not evidence that the run stayed on one code state',
    );
  }
  lines.push(
    `- host at run start: loadavg ${p.hostAtStart.loadavg1m.toFixed(1)} / ${p.hostAtStart.cpus} cpus` +
      ` (ratio ${p.hostAtStart.ratio1m.toFixed(2)}×), PSI some avg60 mem=` +
      `${p.hostAtStart.psiMemSome60 !== null ? `${p.hostAtStart.psiMemSome60.toFixed(1)}%` : 'n/a'}` +
      ` cpu=${p.hostAtStart.psiCpuSome60 !== null ? `${p.hostAtStart.psiCpuSome60.toFixed(1)}%` : 'n/a'}`,
  );
  const hostLoad = p.hostLoad ?? null;
  if (!hostLoad) {
    lines.push(
      '- host over run: **not finalized** — max load/PSI and swap delta are unavailable on this artifact',
    );
  } else {
    lines.push(
      `- host over run: loadavg(end) ${hostLoad.loadavg1m.toFixed(1)} / ${hostLoad.cpus} cpus` +
        ` (max ratio ${hostLoad.ratio1m.toFixed(2)}×), swap Δ ${hostLoad.swapPagesDelta ?? 'n/a'} pages,` +
        ` PSI some avg60(max) mem=${hostLoad.psiMemSome60 !== null ? `${hostLoad.psiMemSome60.toFixed(1)}%` : 'n/a'}` +
        ` cpu=${hostLoad.psiCpuSome60 !== null ? `${hostLoad.psiCpuSome60.toFixed(1)}%` : 'n/a'}` +
        (hostLoad.oversubscribed
          ? ` — **⚠ OVERSUBSCRIBED (${[
              hostLoad.ratio1m > 1.0 ? 'CPU, EI-8843' : null,
              hostLoad.memoryContendedReason === 'psi-stall'
                ? 'memory stall per PSI, EI-19301664378023382'
                : hostLoad.memoryContendedReason === 'swap-pages-fallback'
                  ? 'swap thrashing per page-delta fallback, EI-9145'
                  : null,
            ]
              .filter(Boolean)
              .join(' + ')}): baseline comparison is UNCERTAIN, auto-filing skipped**`
          : ''),
    );
  }
  if (p.unavailable.length) {
    lines.push(`- provenance gaps: ${p.unavailable.join('; ')}`);
  }
  return lines;
}

export function renderPerfReport(opts: RenderReportOpts): string {
  const { runId, profile, artifacts, compareText } = opts;
  const tiers = [...new Set(artifacts.map((a) => a.tier))].sort();
  const suffix = opts.titleSuffix ?? (tiers.length ? `tier ${tiers.join('/')}` : '');
  const host = artifacts[0]?.host;

  const lines: string[] = [
    `# p2p-perf run \`${runId}\`${suffix ? ` — ${suffix}` : ''}`,
    '',
    `- profile: **${profile}**`,
    host
      ? `- host: ${host.hostname} (${host.platform}, ${host.cpus} cpus, node ${host.node})`
      : '- host: (none)',
    `- artifacts: ${artifacts.length}`,
    ...renderProvenanceLines(artifacts),
    '',
    // Two SEPARATE verdict columns: host responsiveness vs whether replication
    // kept up. They diverge, and merging them hid a collapse (EI-20576392705164447).
    '| scenario | tier | params | key metric (p95) | loop-lag p95 | SLO (host) | converged (readers) | notes |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const a of artifacts) {
    const params = Object.entries(a.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const main = headlineMetric(a);
    const metricCell = main ? `${main.name}: ${main.p95} ${main.unit}` : '—';
    const slo = a.sloPassed === null ? 'n/a' : a.sloPassed ? '✓' : '**✖**';
    const conv =
      a.convergencePassed === null || a.convergencePassed === undefined
        ? 'n/a'
        : `${a.convergencePassed ? '✓' : '**✖'} ${a.convergence?.convergedReaders}/${a.convergence?.expectedReaders}${a.convergencePassed ? '' : '**'}`;
    const notes = a.notes.length ? a.notes.join('; ').slice(0, 200) : '';
    lines.push(
      `| ${a.scenario} | ${a.tier} | ${params} | ${metricCell} | ${a.loopLag?.p95Ms ?? '—'} ms | ${slo} | ${conv} | ${notes} |`,
    );
  }
  if (compareText) {
    lines.push('', '## Baseline comparison (advisory — D-005)', '', '```', compareText, '```');
  }
  lines.push('', `_Generated by perf/report.ts (p2p-performance-suite-2026-06-07)._`);
  return lines.join('\n');
}
