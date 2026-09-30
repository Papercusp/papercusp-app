#!/usr/bin/env node
/**
 * Refuse a BARE `npm install` / `npm ci` in the shared staging tree.
 *
 * WHY THIS IS A RAIL AND NOT ADVICE
 * ---------------------------------
 * `npm-install-safe.mjs` implements a reader/writer mutex over this tree's node_modules. The
 * green-checkpoint's dependency-generation phase takes the READ lock for the entire ~22 minute
 * copy of ~92 dependency trees, so a compliant writer (`npm run install:safe`) simply waits and
 * can never tear that snapshot.
 *
 * A bare `npm install` takes no lock at all. It mutates node_modules underneath the copy, the
 * post-copy source fingerprint no longer matches the pre-copy one, and dependency-generation.sh
 * correctly refuses the torn snapshot with exit 75 — discarding the whole gate run. The gate then
 * reports `green: null`: no verdict, which is NOT the same as a red, and which no amount of fixing
 * tests can clear.
 *
 * Measured 2026-08-30 (WI-871887): four consecutive green-checkpoint attempts produced NO verdict.
 * Two died exactly this way — one with `result=torn-source exit 75` after 22 minutes of copying,
 * one with `@octokit/rest` unresolvable mid-install. main had not fast-forwarded in 11 days.
 * CLAUDE.md already told agents to use `install:safe`; documentation did not hold, because the
 * cost of ignoring it lands on a different agent an hour later.
 *
 * SCOPE — deliberately narrow, so this cannot wedge anyone:
 *  - Only the checkout on `staging`. That is the documented invariant for the shared tree
 *    ("the canonical shared checkout always has `staging` checked out"); the release checkout runs
 *    `main` and worktrees run their own branches, so their installs are untouched.
 *  - Sanctioned installs pass straight through (npm-install-safe sets the marker below).
 *  - CI passes through.
 *  - `PAPERCUSP_ALLOW_UNSAFE_INSTALL=1` is an always-available escape hatch, so no one is ever
 *    hard-stuck at 3am — it just has to be a deliberate act rather than an accident.
 */
import { execFileSync } from 'node:child_process';

const SANCTIONED_ENV = 'PAPERCUSP_INSTALL_SAFE_ACTIVE';
const ESCAPE_ENV = 'PAPERCUSP_ALLOW_UNSAFE_INSTALL';

const allow = (reason) => {
  if (process.env.PAPERCUSP_INSTALL_GUARD_DEBUG === '1') {
    console.error(`[install-guard] allowed: ${reason}`);
  }
  process.exit(0);
};

// The mutex holder is installing through the sanctioned path — that IS the safe path.
if (process.env[SANCTIONED_ENV] === '1') allow('running under npm-install-safe');
if (process.env[ESCAPE_ENV] === '1') {
  console.error(
    `[install-guard] ⚠ ${ESCAPE_ENV}=1 — proceeding with an UNGUARDED install in the shared tree.\n` +
      '[install-guard] If a green-checkpoint run is mid dependency-copy, this can discard it.',
  );
  allow('explicit escape hatch');
}
if (process.env.CI === 'true' || process.env.CI === '1') allow('CI');

let branch = '';
let root = '';
try {
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 5_000 }).trim();
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  root = git(['rev-parse', '--show-toplevel']);
} catch {
  // Not a git checkout, or git is unavailable. This guard only ever recognises ONE tree; if it
  // cannot identify the tree it must not block an install it knows nothing about.
  allow('git unavailable — cannot identify the tree, so not ours to refuse');
}

if (branch !== 'staging') allow(`branch is ${branch || '<unknown>'}, not the shared staging tree`);

console.error(`
┌─ REFUSED: bare install in the shared staging tree ────────────────────────────
│ tree:   ${root}
│
│ Use the serialized path instead — same command, one word longer:
│
│     npm run install:safe                    (plain install)
│     npm run install:safe -- ci              (npm ci)
│     npm run install:safe -- install <pkg>   (add a package)
│
│ WHY: this tree's node_modules is shared with ~100 agents AND with the
│ green-checkpoint gate, which holds a read lock while it copies ~92 dependency
│ trees for ~22 minutes. install:safe waits for that lock. A bare install does
│ not — it tears the snapshot, the gate exits 75, and the whole run is discarded
│ with green:null (no verdict at all, which is not the same as a red).
│
│ install:safe is not slower in the normal case; it only waits when waiting is
│ the difference between a verdict and a wasted hour.
│
│ Genuinely need to bypass?  ${ESCAPE_ENV}=1 npm install
└───────────────────────────────────────────────────────────────────────────────
`);
process.exit(1);
