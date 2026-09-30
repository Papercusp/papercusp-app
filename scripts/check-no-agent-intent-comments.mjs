#!/usr/bin/env node
/**
 * check-no-agent-intent-comments.mjs — a source comment must not attribute a PENDING
 * action to a named agent session id (EI-19324979765038953).
 *
 * WHY THIS EXISTS, in one measured incident: a dead sync-resolver entry held the
 * release gate red for hours (3 consecutive reds, `main` frozen fleet-wide) behind the
 * comment `// su-37bf2 is DELETING this entry under P-025 ...`. True as an intent when
 * written; never done. The named session released the file and stopped responding, but
 * the comment kept asserting the present tense, so every later reader concluded the
 * work was owned and in flight — one agent even updated that comment's work-item
 * reference and still did not do the deletion. Such a comment is strictly worse than
 * silence: silence makes the next reader investigate, the comment redirects them away.
 *
 * THE RULE, and what it deliberately does NOT police: citing an agent session id is
 * fine and common (688 comment lines across 390 files do it, nearly all sound history).
 * Only a LIVE claim — present-tense ownership or a future promise, with the id as its
 * subject — is forbidden, because only that decays into a lie. Past-tense attribution
 * (`added by su-16e4c to green ...`), an as-of frame (`mid-fix at the time this was
 * written`), and a dated observation all lint clean, because all three are the remedy.
 *
 *   node scripts/check-no-agent-intent-comments.mjs            # gate: exit 1 on a finding
 *   node scripts/check-no-agent-intent-comments.mjs --report   # advisory: always exit 0
 *   node scripts/check-no-agent-intent-comments.mjs --census    # measured population
 *
 * BASELINE IS EMPTY and must stay that way. The four instances this rule found when it
 * was written were fixed, not allowlisted. If it fires, rewrite the comment — the fix
 * is always cheaper than the incident, and there is no exception list to grow.
 *
 * SCANS UNTRACKED-BUT-NOT-IGNORED FILES TOO, same as check-no-box-identity.mjs: a
 * brand-new file is exactly when this shape is most likely to be typed, and a plain
 * `git ls-files` cannot see it until the next `git add` — a confident green over zero
 * bytes of the file you just wrote.
 *
 * The matcher lives in scripts/lib/agent-intent-comment-patterns.mjs, not here, so a
 * future edit-time advisory cannot disagree with this gate.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FIX_HINT,
  findAgentIntentComments,
  isSkippedPath,
} from './lib/agent-intent-comment-patterns.mjs';

const REPORT = process.argv.includes('--report');
const CENSUS = process.argv.includes('--census');

/** Source extensions that carry comments in this tree. */
const EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|py|rs|sql|toml|yml|yaml)$/;

/**
 * The repo root, resolved explicitly — NOT the inherited cwd.
 *
 * This guard is registered in REPO_WIDE_INVARIANT_GUARDS under the
 * `@papercusp/operator-core` workspace, so `test:affected` invokes it with cwd set to
 * packages/operator-core. `git ls-files` is cwd-relative, so taking the inherited cwd
 * would silently narrow a WHOLE-TREE guard to one package and still print a confident
 * green — the "scanned zero bytes of the file you actually wrote" failure, one level up.
 */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function enumerateFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter((f) => f && EXT.test(f) && !isSkippedPath(f));
}

const findings = [];
let scanned = 0;

for (const file of enumerateFiles()) {
  let text;
  try {
    text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  } catch {
    continue; // unreadable / vanished mid-scan — not this rule's business
  }
  scanned++;
  for (const f of findAgentIntentComments(text)) findings.push({ file, ...f });
}

if (CENSUS) {
  console.log(`scanned ${scanned} files; ${findings.length} finding(s)`);
  for (const f of findings) console.log(`${f.file}:${f.line}\t${f.id}\t${f.text}`);
  process.exit(0);
}

if (findings.length === 0) {
  console.log(`✓ no-agent-intent-comments: ${scanned} files scanned, 0 findings`);
  process.exit(0);
}

console.error(
  `\n✖ no-agent-intent-comments: ${findings.length} comment(s) attribute a PENDING action to an agent session id\n`,
);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.text}`);
}
console.error(`\n${FIX_HINT}\n`);
process.exit(REPORT ? 0 : 1);
