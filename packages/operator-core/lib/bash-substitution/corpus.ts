/**
 * Corpus loading + deterministic sampling for the equivalence harness
 * (plan `bash-to-tool-substitution-2026-07-26`, P-004).
 *
 * The raw corpus is a JSONL extract of every `Bash` tool_use block from the su
 * session transcripts (`{sid, ts, cmd, desc, bg}` per line). It is large
 * (~24k calls / 11MB) and lives outside the repo, so the TEST never reads it:
 * `buildFixture` freezes a small, deterministic, human-auditable sample into
 * `fixtures/*.sample.json`, and that committed file is the evidence a verdict
 * cites.
 *
 * WHY FREEZE RATHER THAN RE-EXTRACT: transcripts roll off, so re-extracting at
 * test time would make a verdict silently change meaning as history ages —
 * and would make the test depend on a 9M-line scan. A frozen sample is
 * reviewable in a diff, which is what makes "cite your sample" real.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomize } from './atomize';
import { LAUNCH_SITE_ADVISORY_INTENTS } from './match';
import type { SampledCommand, SubstitutionPair } from './types';

/** One line of the audit extract. */
interface RawCall {
  sid: string;
  ts: string;
  cmd: string;
}

/** Where the committed samples live. */
export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Read one pair's frozen sample. Throws if the fixture is missing — a pair
 *  without evidence must never silently audit as `unaudited`. */
export function loadFixture(pairId: string): CorpusFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${pairId}.sample.json`), 'utf8')) as CorpusFixture;
}

/**
 * Pair every given pair with its committed sample.
 *
 * Generic in the pair type so a caller that narrowed to one corpus (the shell
 * gate's `BASH_GATE_PAIRS`) keeps that narrowing through the load — otherwise
 * every downstream consumer would have to re-prove a fact the caller already
 * established, or, worse, widen back to the union and reach for a matcher the
 * pair may not carry.
 */
export function loadPairFixtures<T extends SubstitutionPair>(
  pairs: T[],
): Array<{ pair: T; fixture: CorpusFixture }> {
  return pairs.map((pair) => ({ pair, fixture: loadFixture(pair.id) }));
}

/**
 * The fixtures a hook's pre-filter guard must replay.
 *
 * BOTH hook suites run this same selection — the OMP guard in-process, the cc
 * guard by spawning the real hook once per atom. D-005 duplicates the
 * PRE-FILTER itself, once per hook path, because each hook must run it with no
 * imports; that duplication is deliberate and confined to the HOOKS. Their
 * TESTS may share code, and until EI-18699117901393768 they did not: this
 * selection sat inline and byte-identical in both files, so adding a pair whose
 * verdict changed what the guard covers required the same edit twice with
 * nothing pointing at the second site. The failure mode was silent — fix one,
 * ship a red gate you believe is green, and it surfaces later in someone else's
 * run with no obvious link to the pair that caused it.
 *
 * `not-a-substitute` pairs are excluded because `matchCommandToSubstitutions`
 * drops them per D-007, so their atoms can never produce an advisory however the
 * pre-filter behaves. The verdict is read off the pair, never inferred from a
 * filename, so this cannot drift from what the matcher actually enforces.
 *
 * ── WI-2145718 / WI-2145714: the one exception, and why the REASON moved ────
 * That sentence used to say "drops them UNCONDITIONALLY", and the word was doing
 * real work: it made "verdict is not-a-substitute" a sufficient reason to skip
 * the fixture. It is no longer true. A {@link LAUNCH_SITE_ADVISORY_INTENTS} row
 * keeps that verdict but IS delivered, so its atoms can now clear the pre-filter
 * and reach an agent — which means the hook-parity guards must replay them like
 * any other enforceable pair, or the one class of row whose delivery path was
 * just changed is the only one nothing exercises end to end.
 *
 * Note what this is NOT: it does not make these pairs enforceable, and it does
 * not touch the equivalence audit, whose sample answers "does the tool cover the
 * atom?" — genuinely N/A here and still answered `not-a-substitute`. The
 * selection is about which fixtures the PRE-FILTER guards replay, which is a
 * delivery question, and delivery is exactly what changed.
 *
 * `expected` comes back alongside `files` so the caller asserts EXACT coverage
 * rather than `> 0`. A selection that silently dropped fixtures would make both
 * guards vacuously green — precisely the "passes while testing nothing" failure
 * the scoping exists to prevent — so the count is part of the contract, not a
 * convenience.
 */
export function selectEnforceableFixtures<T extends SubstitutionPair>(
  pairs: readonly T[],
): { files: string[]; expected: number } {
  const enforceable = new Set(
    pairs
      .filter(
        (p) =>
          p.expectedVerdict !== 'not-a-substitute' ||
          LAUNCH_SITE_ADVISORY_INTENTS.has(p.intentLabel),
      )
      .map((p) => `${p.id}.sample.json`),
  );
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.sample.json') && enforceable.has(f))
    .sort();
  return { files, expected: enforceable.size };
}

/** A frozen fixture file: the sample plus the population it was drawn from. */
export interface CorpusFixture {
  /** What this sample is for — the plan item that produced it. */
  evidenceRef: string;
  /** When the corpus was extracted (the 7d audit window end). */
  extractedAt: string;
  /** Total atoms in the full corpus, for baseline math. */
  totalAtoms: number;
  /** Total distinct sessions in the full corpus. */
  totalSessions: number;
  sample: SampledCommand[];
}

/**
 * Read the raw JSONL extract and flatten it to normalised atoms.
 * Malformed lines are skipped rather than throwing — the extract is machine
 * generated but transcripts contain arbitrary user text.
 */
export function loadCorpusAtoms(jsonlPath: string): SampledCommand[] {
  const out: SampledCommand[] = [];
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let call: RawCall;
    try {
      call = JSON.parse(line) as RawCall;
    } catch {
      continue;
    }
    if (typeof call?.cmd !== 'string') continue;
    for (const atom of atomize(call.cmd)) {
      out.push({ sid: call.sid, ts: call.ts, atom });
    }
  }
  return out;
}

/**
 * Deterministically sample up to `size` atoms, preferring DISTINCT commands and
 * spreading across the population.
 *
 * Distinctness matters more than proportionality here: the harness is probing a
 * tool's capability envelope, and fifty identical `git status` atoms test it
 * exactly as well as one. Deduplicating first means a 20-command sample probes
 * 20 genuinely different shapes — which is what actually finds the gap.
 *
 * Deterministic (an even stride over a sorted list, no RNG) so regenerating the
 * fixture from the same corpus reproduces it byte-for-byte, and a fixture diff
 * therefore means the CORPUS changed, not the sampler.
 */
export function sampleDistinct(atoms: SampledCommand[], size: number): SampledCommand[] {
  const byAtom = new Map<string, SampledCommand>();
  for (const entry of atoms) {
    if (!byAtom.has(entry.atom)) byAtom.set(entry.atom, entry);
  }
  const distinct = [...byAtom.values()].sort((a, b) => (a.atom < b.atom ? -1 : a.atom > b.atom ? 1 : 0));
  if (distinct.length <= size) return distinct;

  const stride = distinct.length / size;
  const picked: SampledCommand[] = [];
  for (let i = 0; i < size; i += 1) {
    picked.push(distinct[Math.floor(i * stride)]);
  }
  return picked;
}

/** Home dirs that name a ROLE or a shared install rather than a PERSON. Mirrors
 *  the non-personal entries of `GENERIC_USERS` in
 *  `scripts/check-no-box-identity.mjs` — these are already anonymous, so
 *  rewriting them would churn fixtures without removing any identity. */
const GENERIC_HOME_USERS = new Set([
  'dev', 'linuxbrew', 'runner', 'user', 'ubuntu', 'root', 'node', 'builder',
  'vscode', 'codespace', 'shared', 'ci', 'agent', 'pcusp', 'papercusp', 'test',
]);

/** What a personal home path is rewritten to. `dev` names nobody, is in the
 *  box-identity lint's own generic set, and is already the placeholder the
 *  sibling fixtures use — so scrubbed output matches the existing convention. */
const PLACEHOLDER_HOME_USER = 'dev';

/**
 * Strip this box's identity out of a sampled command (WI-4776 class).
 *
 * WHY THIS IS HERE AND NOT LEFT TO THE AUTHOR: the corpus is a verbatim extract
 * of real commands, so it is FULL of the extracting box's own home paths — and
 * `buildFixture` commits its output to tracked source, which ships to users
 * inside the release bundle. Scrubbing by hand after each regeneration is a step
 * that WILL eventually be skipped: it already was. `git-read.passthrough`
 * shipped `/home/<owner>/.papercusp/pot-git/…` while its three siblings had been
 * hand-sanitised, which held `main` red on the green-checkpoint gate until it was
 * caught by `lint:no-box-identity` — the most expensive place to learn it.
 * Scrubbing at BUILD time makes every future fixture clean by construction.
 *
 * Rewrites BOTH forms this class appears in:
 *
 *  1. `/home/<user>/…` and `/Users/<user>/…` — any personal user, since the
 *     slashes delimit the name unambiguously.
 *  2. The dash-munged `-home-<user>-…` / `-Users-<user>-…` (how Claude names a
 *     session/project dir, e.g. inside a `/tmp/claude-1000/…` task-output path)
 *     — but ONLY for `selfUser`, this box's own username.
 *
 * WHY (2) IS LIMITED TO THIS BOX (EI-18802228732541554). The original code declined
 * the munged form entirely, on the sound ground that a username may span several
 * dash segments so a general parser could only guess where it ends and would
 * silently mangle the evidence a verdict cites. That objection holds for a general
 * parser but not for the machine doing the extraction: it knows its own username
 * exactly, so this is a literal replace with nothing to guess. Any OTHER user's
 * munged path still falls through untouched to the loud fixture guard in
 * `corpus.test.ts` — the safety property is unchanged, and what goes away is only
 * the manual scrub step that recurred on every fixture regeneration and had already
 * been skipped once (see above).
 *
 * Residual, pinned by a test rather than left to be rediscovered: a SECOND account
 * whose name strictly dash-extends `selfUser` would be rewritten mid-name. Ruling
 * that out needs the very guess this refuses to make, and it requires that account's
 * home path to appear in the extractor's own command history.
 *
 * @param selfUser this box's username; injectable so the behaviour is testable
 *   without writing the real username into a test file — which would itself be the
 *   leak `lint:no-box-identity` exists to catch.
 */
export function scrubIdentity(text: string, selfUser: string = userInfo().username): string {
  const slashScrubbed = text.replace(
    /\/(home|Users)\/([A-Za-z0-9._-]+)/g,
    (whole, root: string, user: string) => {
      // A home dir never ENDS in a dot, so trailing dots are sentence punctuation
      // that the greedy class swallowed — preserve them (same reasoning as the
      // lint's own `stripTrailingDots`).
      const trailingDots = /\.+$/.exec(user)?.[0] ?? '';
      const name = trailingDots ? user.slice(0, -trailingDots.length) : user;
      if (!name || GENERIC_HOME_USERS.has(name)) return whole;
      return `/${root}/${PLACEHOLDER_HOME_USER}${trailingDots}`;
    },
  );

  if (!selfUser || GENERIC_HOME_USERS.has(selfUser)) return slashScrubbed;
  // Anchored exactly like the lint's own `MUNGED_HOME` (a quote / slash / whitespace
  // boundary, and a following dash) so ordinary kebab-case — "some-home-page-header" —
  // cannot be rewritten. The two must agree: a scrub the detector disagrees with is a
  // false green, not a fix.
  const munged = new RegExp(
    `(^|["'\`/\\s])-(home|Users)-${escapeRegExp(selfUser)}(?=-)`,
    'g',
  );
  return slashScrubbed.replace(munged, (_whole, pre: string, root: string) =>
    `${pre}-${root}-${PLACEHOLDER_HOME_USER}`,
  );
}

/** A username is user-supplied data reaching a RegExp — escape it rather than
 *  trusting that no account name ever holds a metacharacter. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Build a fixture for one pattern from the raw corpus.
 *
 * Regenerate with (from the repo root, corpus present):
 *   npx tsx -e "import('./packages/operator-core/lib/bash-substitution/corpus').then(m => …)"
 * The exact invocation lives in the fixture's own `evidenceRef`.
 */
export function buildFixture(opts: {
  jsonlPath: string;
  pattern: RegExp;
  size: number;
  evidenceRef: string;
  extractedAt: string;
}): CorpusFixture {
  const all = loadCorpusAtoms(opts.jsonlPath);
  const pattern = new RegExp(opts.pattern.source, opts.pattern.flags.replace(/g/g, ''));
  const matching = all.filter((entry) => pattern.test(entry.atom));
  return {
    evidenceRef: opts.evidenceRef,
    extractedAt: opts.extractedAt,
    totalAtoms: matching.length,
    totalSessions: new Set(matching.map((entry) => entry.sid)).size,
    // Scrub AFTER sampling: selection stays a pure function of the raw corpus, so
    // the documented "a fixture diff means the CORPUS changed, not the sampler"
    // property survives — the scrub only rewrites the bytes that get committed.
    sample: sampleDistinct(matching, opts.size).map((entry) => ({
      ...entry,
      atom: scrubIdentity(entry.atom),
    })),
  };
}
