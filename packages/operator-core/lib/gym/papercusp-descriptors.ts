/**
 * Turns discrimination-probe results into task descriptors.
 * Plan gym-real-fitness-signal-2026-07-27, P-001. Rulings D-006, D-007, D-008.
 *
 * ── WHERE THE SPEC COMES FROM, AND WHY NOT THE COMMIT MESSAGE ────────────────
 * The obvious source for "what was this change for" is the commit that made it.
 * On THIS repo that source does not exist: git-sync squashes the whole shared
 * tree every few minutes under one auto-generated subject, so every candidate's
 * joint commit reads `chore(git-sync): auto-commit papercusp [skip ci]`. This is
 * the same property D-006 found fatal to `real-anchor.ts`'s `baseCommit` model —
 * commits here are not semantic units.
 *
 * The next temptation is for the corpus author to WRITE a spec per task. That is
 * D-003's extraction smell wearing a new hat: the moment a human (or an agent)
 * paraphrases the requirement, the task measures how well that paraphrase was
 * written, and the corpus stops being real.
 *
 * So the spec is taken VERBATIM from the oracle's own `describe`/`it` names —
 * the requirement as the engineer who shipped it stated it, in their words, not
 * ours. Nothing is invented, summarised, or reworded.
 *
 * This leaks nothing: the oracle test FILE is present in the clone at the pin, so
 * the agent can read it regardless. The task was never "guess the requirement" —
 * it is "make the real test pass", which is exactly the intended shape.
 */
import type { GymTaskPool } from './task-generator';
import type { PapercuspTaskDescriptor } from './papercusp-substrate';

/** One row of the probe's results.jsonl. */
export interface ProbeResultRow {
  implPath: string;
  testPath: string;
  /** Commit where impl + test changed together. */
  joint: string;
  /** That commit's parent — the rewind point. */
  parent: string;
  verdict: 'admitted' | 'rejected';
  reason?: string;
}

/** The oracle's own words, extracted from its describe/it names. */
export interface TestOutline {
  /** `describe(...)` titles, outermost first. */
  describes: string[];
  /** `it(...)` titles — each one a requirement the oracle enforces. */
  its: string[];
}

/**
 * Pull `describe`/`it` titles out of a test file's SOURCE.
 *
 * Deliberately a regex over source text rather than a parse: this runs against
 * arbitrary historical revisions of files that may not even typecheck at the
 * pin, and a parser that throws on one odd file would drop a valid task. A
 * missed title costs a slightly thinner spec; a thrown parser costs the task.
 */
export function extractTestOutline(source: string): TestOutline {
  const describes: string[] = [];
  const its: string[] = [];
  // Matches describe('…' / it("…" / it(`…` — the title is everything up to the
  // closing quote of the SAME kind, so an apostrophe inside a double-quoted
  // title (or vice versa) survives.
  const re = /\b(describe|it|test)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of source.matchAll(re)) {
    const kind = m[1];
    const title = m[3].replace(/\\(['"`\\])/g, '$1').trim();
    if (!title) continue;
    if (kind === 'describe') describes.push(title);
    else its.push(title);
  }
  return { describes, its };
}

/** A stable, filesystem-safe task id derived from the impl path. */
export function taskIdForImpl(implPath: string): string {
  const stem = implPath
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/^(packages|libs|apps)\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `real-${stem}`;
}

export interface BuildDescriptorsInput {
  rows: readonly ProbeResultRow[];
  /** The commit the substrate — and every oracle — is pinned at. */
  pinCommit: string;
  /** Reads a test file's source AT THE PIN. Returns null if unreadable. */
  readTestSource: (testPath: string) => string | null;
  /**
   * The requirement titles the REWIND ACTUALLY BREAKS, keyed by implPath —
   * measured by re-running each reverted candidate's oracle.
   *
   * Required, and this is the point: taking every `it()` title in the oracle
   * file is wrong for large test files, and measurably so. The worst admitted
   * candidate's oracle has 232 titles while its rewind breaks a handful; the
   * verified sample broke 6 of 26. A spec of 226 already-passing requirements
   * plus 6 real ones is not a specification, it is a haystack — it measures
   * needle-finding rather than implementation, and at ~19.5KB it crowds out the
   * agent's context before it has read any code.
   */
  failingIts: ReadonlyMap<string, readonly string[]>;
  /** Pool assignment; defaults to round-robin (see below). */
  pools?: readonly GymTaskPool[];
}

/**
 * Round-robin, NOT sequential blocks.
 *
 * `real-anchor` is the falsifiability check — it is scored every cycle and never
 * optimized. If pools were filled in order it would receive whatever sorted last,
 * which on a shortest-rewind-first ranking means systematically the hardest or
 * most obscure tasks. A pool that differs systematically from the training pool
 * cannot tell you whether an improvement generalised; it can only tell you the
 * two pools differ, which you already knew.
 */
const DEFAULT_POOLS: readonly GymTaskPool[] = ['train', 'dev-anchor', 'real-anchor'];

export function buildDescriptorsFromProbe(input: BuildDescriptorsInput): PapercuspTaskDescriptor[] {
  const pools = input.pools?.length ? input.pools : DEFAULT_POOLS;
  const out: PapercuspTaskDescriptor[] = [];
  let i = 0;

  for (const row of input.rows) {
    // The discrimination gate is the ONLY admission path (D-006). A rejected row
    // is skipped here rather than filtered by the caller, so a caller that
    // forgets to filter cannot mint a task that was proven not to discriminate.
    if (row.verdict !== 'admitted') continue;

    const source = input.readTestSource(row.testPath);
    if (source === null) continue;
    const outline = extractTestOutline(source);

    // The requirements this task must actually satisfy. An ADMITTED candidate
    // failed when reverted, so an empty set here means the measurement did not
    // reach us — a tooling gap, not a property of the candidate. Drop it rather
    // than fall back to every title: the fallback is the haystack described
    // above, and it degrades SILENTLY, whereas a drop shows up as a smaller
    // corpus and gets investigated.
    const failing = input.failingIts.get(row.implPath) ?? [];
    if (failing.length === 0) continue;

    out.push({
      taskId: taskIdForImpl(row.implPath),
      pool: pools[i % pools.length]!,
      pinCommit: input.pinCommit,
      implPath: row.implPath,
      testPath: row.testPath,
      revertToCommit: row.parent,
      spec:
        `Restore \`${row.implPath}\` so its real test passes.\n\n` +
        `The oracle is \`${row.testPath}\` — run it with \`npm run test:file -- ${row.testPath}\`. ` +
        `These are the requirements it currently FAILS, in the words of the engineer who shipped them:\n` +
        failing.map((t) => `  - ${t}`).join('\n'),
      intent:
        outline.describes.length > 0
          ? `Real shipped work on ${outline.describes.join(' / ')}.`
          : `Real shipped work on ${row.implPath}.`,
      sourceRef: `papercusp commit ${row.joint.slice(0, 12)} (impl + oracle changed together)`,
    });
    i += 1;
  }

  return out;
}
