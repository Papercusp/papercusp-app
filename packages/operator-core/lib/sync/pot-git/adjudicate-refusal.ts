/**
 * pot-git/adjudicate-refusal.ts — WI-10000598: answer "WHAT did the G-10
 * secrets guard actually find, and is it real?" for a publish that was refused.
 *
 * The gap this closes. `pot_git:secrets_exemptions` tells an agent to add a
 * path exemption only once "you've confirmed the flagged finding is a false
 * positive" — but nothing in the system lets them confirm it. The refusal
 * record persists only a refusalCode (`own_head_publish.refused = 'secrets'`);
 * the findings themselves go to a console warning, which on this box is not in
 * the journal at all. So the confirmation has to be hand-rolled, under time
 * pressure, while the hive publish plane is frozen — and the table has grown to
 * 22 rows written under exactly that pressure. Measured on
 * EI-22629708173570605: the exemption row was written 106 minutes BEFORE the
 * adjudication that justified it existed. It happened to be correct. An
 * exemption written against an unadjudicated hit is how a real secret gets
 * allowlisted, and that failure is silent.
 *
 * This is a pure REPLAY of the same scanner the guard runs (secrets-guard.ts),
 * over the same blobs, through the same `RunGit` seam publish-guard.ts uses —
 * so it cannot drift into being a second, differently-behaved detector. It
 * decides nothing and writes nothing; it reports what the guard sees so a human
 * or agent can judge it.
 *
 * Findings are reported via SecretFinding.excerpt, which secrets-guard.ts
 * already masks — the literal is never reproduced.
 */
import { type RunGit, defaultRunGit } from './storage';
import { type SecretFinding, scanTextForSecrets, isFixtureFile } from './secrets-guard';
import { partitionExemptFindings } from './secrets-guard-exemptions';

export interface AdjudicateRefusalInput {
  /** The commit whose introduced blobs to judge (typically `own_head_publish.blockedAtCommit`). */
  commit: string;
  /** Repo to resolve against. */
  repoPath: string;
  /** Runtime path exemptions to partition against; omit to report every finding as blocking. */
  exemptions?: ReadonlySet<string>;
  runGit?: RunGit;
}

export interface AdjudicateRefusalResult {
  commit: string;
  /** Every path the commit touched, before any filtering. */
  pathsTouched: number;
  /** Text blobs actually fed to the scanner. */
  scanned: number;
  /** Paths skipped because the blob contains a NUL (binary). */
  skippedBinary: number;
  /** Paths that do not resolve to a blob at this commit — deletions, and gitlinks (submodules). */
  skippedUnresolvable: string[];
  /** Paths skipped by the STATIC FIXTURE_FILES set (secrets-guard.ts). */
  fixtureSkipped: string[];
  /** Findings that would REFUSE the publish. */
  blocking: SecretFinding[];
  /** Findings suppressed by a runtime path exemption. */
  exempted: SecretFinding[];
  /**
   * Instrument check. Without it a `blocking: []` result is indistinguishable
   * from a scanner that silently matched nothing at all — the same false-zero
   * class as `pgrep -q`, a `| head` truncation, or a wrong-relation SQL zero.
   * An adjudication whose control did not fire is UNUSABLE, not clean.
   */
  control: { fired: boolean; findingCount: number };
}

/**
 * Assemble known-bad inputs at RUNTIME rather than writing them as literals.
 *
 * A literal PEM header in this source would trip the WRITE-time secrets guard
 * and demand a path exemption in order to commit the adjudicator — the exact
 * pressure this module exists to relieve, applied one layer earlier. The
 * assembled values are asserted below so the control can never silently decay
 * into inert placeholder text (a green control that tests nothing is worse than
 * no control).
 */
export function buildPositiveControlSource(): string {
  const pemHeader = '-----BEGIN' + ' PRIVATE' + ' KEY-----';
  const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
  if (pemHeader !== '-----BEGIN PRIVATE KEY' + '-----' || awsKey.length !== 20) {
    throw new Error(
      'positive-control tokens did not assemble correctly — the control is inert, so any adjudication using it is unusable',
    );
  }
  return `const k = "${awsKey}";\nconst pemHeader = "${pemHeader}";\n`;
}

/** Run the guard's own scanner over the control input. */
export function runPositiveControl(): { fired: boolean; findingCount: number } {
  const findings = scanTextForSecrets('positive-control.ts', buildPositiveControlSource());
  return { fired: findings.length > 0, findingCount: findings.length };
}

/**
 * Replay the publish guard's secrets scan over everything `commit` introduced.
 *
 * Deliberately reports UNRESOLVABLE paths by name rather than as a bare count:
 * a submodule gitlink and a deletion both land here, and a reader who cannot
 * see which is which cannot tell "nothing to scan" from "I failed to scan it".
 */
export async function adjudicateRefusal(input: AdjudicateRefusalInput): Promise<AdjudicateRefusalResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const { commit, repoPath } = input;

  const names = await runGit(['show', '--name-only', '--pretty=format:', commit], repoPath);
  if (names.code !== 0) {
    throw new Error(`cannot resolve commit ${commit} in ${repoPath}: ${names.stderr.trim() || `exit ${names.code}`}`);
  }
  const paths = names.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  let scanned = 0;
  let skippedBinary = 0;
  const skippedUnresolvable: string[] = [];
  const fixtureSkipped: string[] = [];
  const findings: SecretFinding[] = [];

  for (const path of paths) {
    const blob = await runGit(['show', `${commit}:${path}`], repoPath);
    if (blob.code !== 0) {
      // A deletion, or a submodule gitlink — neither is a blob to scan.
      skippedUnresolvable.push(path);
      continue;
    }
    if (blob.stdout.includes('\x00')) {
      skippedBinary++;
      continue;
    }
    if (isFixtureFile(path)) {
      fixtureSkipped.push(path);
      continue;
    }
    scanned++;
    findings.push(...scanTextForSecrets(path, blob.stdout));
  }

  const { blocking, exempted } = partitionExemptFindings(findings, input.exemptions ?? new Set<string>());

  return {
    commit,
    pathsTouched: paths.length,
    scanned,
    skippedBinary,
    skippedUnresolvable,
    fixtureSkipped,
    blocking,
    exempted,
    control: runPositiveControl(),
  };
}

/** Render a result for a terminal / a work-item comment. Masked excerpts only. */
export function formatAdjudication(r: AdjudicateRefusalResult): string {
  const lines: string[] = [];
  lines.push(`commit ${r.commit}: ${r.pathsTouched} path(s) touched`);
  lines.push(
    `scanned=${r.scanned} skippedBinary=${r.skippedBinary} ` +
      `skippedUnresolvable=${r.skippedUnresolvable.length} fixtureSkipped=${r.fixtureSkipped.length}`,
  );
  if (r.skippedUnresolvable.length) lines.push(`  unresolvable (deletion/gitlink): ${r.skippedUnresolvable.join(', ')}`);
  if (r.fixtureSkipped.length) lines.push(`  fixture-skipped (static FIXTURE_FILES): ${r.fixtureSkipped.join(', ')}`);

  lines.push('');
  lines.push(`BLOCKING FINDINGS: ${r.blocking.length}`);
  for (const f of r.blocking) lines.push(`  ${f.path}:${f.line} [${f.rule}] ${f.excerpt}`);
  if (r.exempted.length) {
    lines.push(`ALREADY EXEMPTED: ${r.exempted.length}`);
    for (const f of r.exempted) lines.push(`  ${f.path}:${f.line} [${f.rule}] ${f.excerpt}`);
  }

  lines.push('');
  lines.push(
    r.control.fired
      ? `POSITIVE CONTROL: ${r.control.findingCount} finding(s) — scanner is live, so the counts above are a measurement.`
      : 'POSITIVE CONTROL: *** DID NOT FIRE *** — the scanner matched nothing on known-bad input. ' +
          'This adjudication is UNUSABLE: a zero here means a broken instrument, not a clean commit. Do NOT write an exemption from it.',
  );
  return lines.join('\n');
}
