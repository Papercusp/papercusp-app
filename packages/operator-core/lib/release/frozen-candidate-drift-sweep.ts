/**
 * P-008 (frozen-candidate-compliance-enforcement-2026-08-30): the ATTESTATION leg.
 *
 * Every other item in this plan is a PREVENTION: the converge verb (P-002) makes the right
 * move available, the edit hook (P-004) names the consequence at the edit, the completion
 * and carry lints (P-006/P-007) stop the false claim entering the record. None of them can
 * tell us whether any of it WORKED. This sweep is what does.
 *
 * THE SIGNATURE IT DETECTS. While the queue is frozen, a commit lands ABOVE the frozen
 * candidate touching a path in that candidate's failing set. That is the exact shape of the
 * failure this plan exists to stop — the agent's fix is real and the gate cannot see it. The
 * finding names the paths and the agent, so the question "did the plan hold?" is answered by
 * a count that goes to zero rather than by an owner catching it a third time.
 *
 * WHY IT IS NOT A GATE. It runs after the fact by construction, so it can only ever report.
 * A commit matching this signature is not misconduct — it is frequently the correct fix,
 * filed in the one place the gate cannot read it. The finding's job is to route it to the
 * converge verb, and to make the residual rate visible.
 *
 * ATTRIBUTION, CAREFULLY. `git blame` and a commit SUBJECT are both worthless here: git-sync
 * sweeps the whole tree on a schedule under ONE identity and labels the commit with whatever
 * agent context happened to be current. The only trustworthy attribution is the
 * `Papercusp-Agent:` trailer the sweep writes, so that is what this reads — and when it is
 * absent the finding says "unattributed" rather than naming the sweeping identity.
 */
import { normalizeRepoPath } from './frozen-candidate-repair-queue';
import type { FrozenRepairEditMarker } from './frozen-repair-edit-marker';

/** One commit sitting above the frozen candidate. */
export interface DriftCommit {
  sha: string;
  /** From the `Papercusp-Agent:` trailer ONLY. null ⇒ unattributed, never guessed. */
  agent: string | null;
  /** Repo-relative paths the commit touched. */
  paths: string[];
}

export interface DriftFindingPath {
  path: string;
  commits: Array<{ sha: string; agent: string | null }>;
}

export interface FrozenCandidateDriftFinding {
  candidate: string;
  judgedSha: string;
  /** One entry per failing path that drifted, sorted for a stable finding body. */
  paths: DriftFindingPath[];
  /** Distinct attributed agents, sorted. Excludes unattributed commits. */
  agents: string[];
  /** Commits that touched a failing path but carried no agent trailer. */
  unattributedCommits: number;
  title: string;
  body: string;
}

/**
 * Pure: given the frozen marker and the commits above the candidate, produce the finding —
 * or `undefined` when the signature is absent, which is the outcome this plan is trying to
 * make permanent.
 */
export function detectFrozenCandidateDrift(input: {
  marker: FrozenRepairEditMarker | null;
  commitsAboveCandidate: readonly DriftCommit[];
}): FrozenCandidateDriftFinding | undefined {
  const { marker, commitsAboveCandidate } = input;
  // No frozen queue ⇒ the candidate is cut at tip ⇒ there is no "above the candidate" to
  // drift into. Silence, not a zero-finding report that would read as a measurement.
  if (!marker) return undefined;

  const failing = new Set(marker.failingPaths.map(normalizeRepoPath).filter((p) => p.length > 0));
  if (failing.size === 0) return undefined;

  const byPath = new Map<string, Array<{ sha: string; agent: string | null }>>();
  for (const commit of commitsAboveCandidate) {
    for (const raw of commit.paths) {
      const path = normalizeRepoPath(raw);
      if (!failing.has(path)) continue;
      const rows = byPath.get(path) ?? [];
      // A commit can list a path once; guard anyway so a duplicated entry cannot inflate
      // the count that answers "did this plan work".
      if (!rows.some((r) => r.sha === commit.sha)) rows.push({ sha: commit.sha, agent: commit.agent });
      byPath.set(path, rows);
    }
  }
  if (byPath.size === 0) return undefined;

  const paths: DriftFindingPath[] = [...byPath.entries()]
    .map(([path, commits]) => ({ path, commits: [...commits].sort((a, b) => a.sha.localeCompare(b.sha)) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const matched = new Set<string>();
  let unattributedCommits = 0;
  for (const { commits } of paths) {
    for (const c of commits) {
      if (c.agent) matched.add(c.agent);
      else unattributedCommits += 1;
    }
  }
  const agents = [...matched].sort();

  const title =
    `frozen-candidate drift: ${paths.length} failing path(s) changed above candidate ` +
    `${marker.candidate.slice(0, 12)} while the gate was frozen`;

  const body = [
    `The green-checkpoint repair queue is frozen on candidate ${marker.candidate.slice(0, 12)} ` +
      `(judging ${marker.repairHead}).`,
    '',
    `${paths.length} path(s) in that candidate's FAILING set were changed by commits landing ABOVE it. ` +
      `Those changes are not visible to the gate: it re-tests the judged sha, so these paths will keep ` +
      `reporting red however correct the fixes are.`,
    '',
    ...paths.map(
      ({ path, commits }) =>
        `  - ${path} — ${commits
          .map((c) => `${c.sha.slice(0, 12)} (${c.agent ?? 'unattributed'})`)
          .join(', ')}`,
    ),
    '',
    agents.length
      ? `Attributed agents: ${agents.join(', ')}.`
      : 'No commit carried a Papercusp-Agent trailer, so none of this is attributable.',
    unattributedCommits > 0
      ? `${unattributedCommits} commit(s) carried no agent trailer and are deliberately NOT attributed — ` +
        `git-sync commits the whole tree under one identity, so blame and the commit subject would both ` +
        `name the wrong agent.`
      : '',
    '',
    `REMEDY (not a reprimand — these fixes are usually correct, just unreachable): route each one onto ` +
      `the judged lineage with release:repair-queue { op:'admit', paths:[...] }, which reports whether ` +
      `the judged sha now carries them. Do NOT re-cut a fresh candidate (D-002) and do NOT retire the ` +
      `queue to make the gate move.`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    candidate: marker.candidate,
    judgedSha: marker.repairHead,
    paths,
    agents,
    unattributedCommits,
    title,
    body,
  };
}

/**
 * Parse `git log <candidate>..<branch> --format=... --name-only` output into commits.
 *
 * Exported so the parser is testable without a repository — the shape it consumes is the
 * one the sweep action produces, and a parser that silently mis-splits would report a
 * confident zero.
 */
export function parseDriftCommits(raw: string): DriftCommit[] {
  const out: DriftCommit[] = [];
  for (const block of raw.split('\x00').map((b) => b.trim())) {
    if (!block) continue;
    const lines = block.split('\n');
    const sha = (lines.shift() ?? '').trim();
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    let agent: string | null = null;
    const paths: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const trailer = /^Papercusp-Agent:\s*(\S+)/.exec(trimmed);
      if (trailer) {
        agent = trailer[1];
        continue;
      }
      paths.push(trimmed);
    }
    out.push({ sha, agent, paths });
  }
  return out;
}
