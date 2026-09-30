/**
 * The single definition of WHAT the doc-claims guards judge.
 *
 * ── Why this is not `CLAUDE.md` ──────────────────────────────────────────────
 * CLAUDE.md is being turned into a PROJECTION of `harness_shared.harness_doc_parts`
 * (plan claude-md-projection-from-pg-2026-08-10). The projection carries the invariant
 * / pointer / recipe parts — a deliberate minority — and leaves the long-form prose in
 * the corpus. But the prose is where most of the judged claims live: measured on the
 * pre-cutover file, projecting CLAUDE.md takes the fenced grep recipes from 5 to 0 and
 * the retired-surface claims from 26 to 0.
 *
 * So after the cutover, a guard still pointed at CLAUDE.md would judge a fraction of
 * what it judges today. It would do so LOUDLY — every one of these guards already has
 * a non-vacuity floor, and all three fire on the projected file (D-016 corrects an
 * earlier claim that they would pass silently) — but red-for-the-wrong-reason is not
 * the goal either. The guards follow their subject to the corpus.
 *
 * ── Why a FILE, when Postgres is canonical ───────────────────────────────────
 * D-004 says a filesystem projection exists iff a reader we do not control needs a file
 * on disk. Here that reader is the UNIT test tier: the green gate runs
 * `npm run test:affected` with no `--integration`, so a guard that reached for Postgres
 * would silently stop gating the fleet on every change — which is precisely the
 * "migration that greens by weakening a guard" the plan item forbids. The corpus is
 * therefore composed from the canonical rows into a generated, committed file by
 * `scripts/project-doc-parts.mjs`, and read from there.
 *
 * ── The override ─────────────────────────────────────────────────────────────
 * `PAPERCUSP_DOC_CORPUS` re-points the subject at another file. That exists so a
 * falsifiability probe can mutate a COPY outside the tree rather than the tracked
 * artifact (CLAUDE.md's mutation-probe rule, tier 2 — the shared working tree is swept
 * into a commit every few minutes, so an in-tree mutation can be committed by a sweep
 * even when nothing goes wrong). P-011 uses it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The generated corpus, relative to the repo root. Mirrors `CORPUS_FILE` in the projector. */
export const CORPUS_RELPATH = 'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md';

export const CORPUS_PATH = process.env.PAPERCUSP_DOC_CORPUS
  ? resolve(process.env.PAPERCUSP_DOC_CORPUS)
  : resolve(ROOT, CORPUS_RELPATH);

/**
 * How a violation names its subject. Line numbers are the CORPUS's, not CLAUDE.md's,
 * and saying so is the difference between a red that points at the offending text and
 * one that sends the reader to the wrong file.
 */
export const SUBJECT_LABEL = process.env.PAPERCUSP_DOC_CORPUS ? CORPUS_PATH : CORPUS_RELPATH;

/**
 * Read the corpus. A missing file yields '' rather than throwing, deliberately: every
 * guard here already asserts a non-empty denominator, so an absent corpus fails as a
 * loud "this suite measured nothing" instead of an import-time crash that reads like
 * infrastructure trouble.
 */
export function readCorpus(): string {
  return existsSync(CORPUS_PATH) ? readFileSync(CORPUS_PATH, 'utf8') : '';
}

/**
 * Floors for the denominators, measured 2026-08-10 against the corpus composed from
 * 288 rows / 253 blocks (plan D-016):
 *
 *   npmRun 40 · prescribed 13 · checkedLines 5 · retired-surface claims judged 26
 *
 * They are set BELOW the measured values with a little headroom, because the corpus is
 * edited continuously and a floor pinned to the exact count would red on any honest
 * removal. They are not decoration: `checkedLines` and `judged` both go to ZERO on the
 * projected file, so these are the assertions that catch a subject swapped out from
 * under the guards. If one legitimately drops below its floor, say why in the commit —
 * do not just lower the number.
 */
export const CORPUS_FLOORS = Object.freeze({
  npmRun: 30,
  prescribed: 8,
  checkedLines: 4,
  retiredSurfacesJudged: 18,
});
