#!/usr/bin/env node
/**
 * check-pipefail-sigpipe.mjs — durable recurrence guard for EI-22176104184812266.
 *
 * WHAT HAPPENS. Under `set -o pipefail`, a pipeline's status is the status of the
 * LAST stage to fail — including a stage killed by a signal. An early-exiting
 * consumer (`grep -q`, `grep -m N`, `head`) closes the read end of the pipe as soon
 * as it has what it needs; if the producer is still writing, it takes SIGPIPE and
 * exits 141, and pipefail reports that as the PIPELINE's failure:
 *
 *     git show "$SHA:$F" | grep -q 'NEEDLE'   # exit 1 *because the needle WAS found*
 *
 * The failure direction is the expensive one. The pipeline reports "the thing is NOT
 * there" precisely when it IS there and the producer is big enough to still be
 * writing — so a guard built out of this shape refuses valid input, and refuses it
 * INTERMITTENTLY, because whether the producer has finished writing depends on how
 * much fits in the pipe buffer.
 *
 * The buffer is not a constant. `fs.pipe-user-pages-soft` caps the pages one uid may
 * hold in pipes; past it the kernel hands out 4KB pipes instead of the default 64KB.
 * On a box running a large agent fleet that cap is reachable, so the SAME code flips
 * between working and not as unrelated load moves the threshold. The reported
 * incident (2026-09-02) was a re-pin guard refusing a commit that was present at the
 * exact sha it was checking; the byte-identical check passed minutes later.
 * `/etc/sysctl.d/90-papercusp-pipe-pages.conf` raised the cap afterwards, which
 * mitigates the acute trigger and changes NOTHING about the code shape: at a 64KB
 * buffer this still fires for `git show` of a >64KB blob, `strings` on a binary, or
 * a recursive `grep`.
 *
 * WHY A LINT AND NOT A THIRD COMMENT. This class has now been discovered
 * independently three times and fixed LOCALLY each time, leaving the next author
 * nothing to trip over:
 *   • papercusp-desktop/bin/release-local.sh (capture-then-match, with a comment)
 *   • papercusp-desktop/bin/build-windows-cross.sh (grep -a on the binary directly,
 *     with a comment)
 * Both comments describe the trap accurately. Neither PREVENTS it — and the second
 * file carried the raw shape a few hundred lines above its own warning.
 *
 * ── WHAT THIS FLAGS (and, deliberately, what it does not) ────────────────────
 * A site must satisfy ALL of:
 *   1. its file enables pipefail (`set -o pipefail` in any -eo/-euo spelling);
 *   2. some stage of a pipeline is an early-exiting consumer (`grep -q`, `grep -m`,
 *      `head`);
 *   3. an UPSTREAM stage is a producer whose output is genuinely unbounded (the
 *      `UNBOUNDED_PRODUCERS` table below — `git show`, `strings`, `find`, `curl`,
 *      `journalctl`, a recursive `grep`, …);
 *   4. the pipeline's status is CONSUMED — no `|| true` / `|| :` neutralising it.
 *
 * Condition 3 is what keeps this blocking rather than advisory. The shape alone is
 * far too common to gate on: a measuring run over this tree found ~109 lines
 * matching conditions 1+2+4, of which the large majority are `printf`/`echo`/small
 * `sed` producers that can never fill a pipe buffer and so can never SIGPIPE. That
 * count is a CANDIDATE count, not a defect count, and a guard that failed on all of
 * it would be turned off within the day. `--list` prints the whole census, bounded
 * producers included, so the allowlist below is re-seeded from a MEASURING run
 * rather than a hand-run grep (the derived-truth ladder in CLAUDE.md).
 *
 * The bounded/unbounded split is a judgement about THIS repo's usage and is the
 * thing to revisit when a false negative shows up — not the detection shape.
 * `printf "$x" | head -1` is unflagged because `x` is a shell variable in practice
 * holding a few lines; a caller that stuffs a 100KB blob into one is a real hit this
 * guard will miss.
 *
 *   node scripts/check-pipefail-sigpipe.mjs           # gate: fail on unbounded sites
 *   node scripts/check-pipefail-sigpipe.mjs --list    # the full census, classified
 *   node scripts/check-pipefail-sigpipe.mjs --json    # machine-readable
 *
 * THE SAFE SHAPES (all three are already used in this tree):
 *   • capture, then match:  v="$(producer || true)"; case "$v" in *needle*) ;; esac
 *   • a consumer that reads to EOF: `grep -c`, `grep` without -q/-m
 *   • no pipe at all: `grep -aqF needle "$file"` reads the file directly
 *   • `|| true` when the status genuinely does not matter
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { presentOnDisk } from './lib/tracked-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { stripShellTrailingComment } from './lib/strip-comments-and-strings.mjs';

/**
 * The tree to scan. Overridable ONLY so `scripts/mutation-probe.sh` can prove this
 * guard is falsifiable at TIER 2 — mutating a COPY of this file outside the tree and
 * pointing it back at the real repo. Without the seam the copy resolves ROOT relative
 * to itself, scans nothing, and reports a vacuous "clean"; the alternative is an
 * in-tree mutation, which the git-sync sweep can commit (CLAUDE.md, "Proving a guard
 * is falsifiable"). Unset in every normal invocation.
 */
const ROOT = process.env.PIPEFAIL_SIGPIPE_LINT_ROOT
  ? path.resolve(process.env.PIPEFAIL_SIGPIPE_LINT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Producers whose output routinely exceeds a pipe buffer, so an early-exiting
 * consumer can realistically SIGPIPE them. `git` is subcommand-aware because
 * `git rev-parse` is a one-liner while `git show` can be megabytes.
 */
const UNBOUNDED_PRODUCERS = new Map([
  ['strings', 'reads a whole binary'],
  ['objdump', 'disassembly is unbounded'],
  ['nm', 'symbol tables are unbounded'],
  ['readelf', 'ELF dumps are unbounded'],
  ['xxd', 'hex dump of a whole file'],
  ['hexdump', 'hex dump of a whole file'],
  ['od', 'octal dump of a whole file'],
  ['base64', 'encodes a whole file'],
  ['cat', 'reads a whole file'],
  ['tac', 'reads a whole file'],
  ['zcat', 'decompresses a whole file'],
  ['gunzip', 'decompresses a whole file'],
  ['zstdcat', 'decompresses a whole file'],
  ['curl', 'response body is unbounded'],
  ['wget', 'response body is unbounded'],
  ['find', 'walks a tree'],
  ['journalctl', 'log output is unbounded'],
  ['dmesg', 'kernel ring buffer is unbounded'],
  ['ps', 'process listing is unbounded (this box runs a large agent fleet)'],
  ['docker', 'docker logs/ps output is unbounded'],
  ['tar', 'archive listing is unbounded'],
  ['unzip', 'archive listing is unbounded'],
]);

/**
 * Stages that read their input to EOF before writing anything. One of these between
 * a producer and an early-exiting consumer makes the producer SAFE: `sort` cannot
 * hand `head` a line until it has drained `find`, so `find | sort -rn | head -1`
 * never SIGPIPEs the find. Only stages AFTER the last such barrier are at risk.
 */
const DRAINING_STAGES = new Set([
  'sort',
  'wc',
  'tac',
  'tail',
  'shuf',
  'sponge',
  'column',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
]);

/**
 * Commands from `UNBOUNDED_PRODUCERS` that also work as pass-through FILTERS. With a
 * file operand they read that file (unbounded); with none they are bounded by
 * whatever upstream already produced, so `head -c 24 /dev/urandom | base64` is 32
 * bytes, not "encodes a whole file".
 */
const FILTER_CAPABLE = new Set([
  'cat',
  'tac',
  'strings',
  'base64',
  'xxd',
  'od',
  'hexdump',
  'zcat',
  'gunzip',
  'zstdcat',
]);

/** `git <sub>` subcommands whose output is unbounded. */
const UNBOUNDED_GIT_SUBCOMMANDS = new Set([
  'show',
  'log',
  'diff',
  'cat-file',
  'ls-files',
  'ls-tree',
  'rev-list',
  'blame',
  'for-each-ref',
  'status',
  'grep',
]);

/**
 * Sites that match the unbounded shape but are provably fine. Each needs a REASON —
 * "it looked ok" is how an allowlist becomes a baseline. `match` is a substring of
 * the offending code, so an entry survives the line moving.
 */
const ALLOWLIST = [
  // (empty — the two sites this guard was written for were fixed rather than allowed)
];

/** Does this script turn pipefail on at all? */
export function enablesPipefail(text) {
  return /^\s*set\s+-[a-zA-Z]*o\s+pipefail\b/m.test(text) || /^\s*set\s+-o\s+pipefail\b/m.test(text);
}

/**
 * Strip a trailing `#` comment, respecting quotes. A `#` inside a string is data —
 * `grep -q '#define'` must not be truncated into a different pipeline.
 *
 * Delegates to the shared shell arm. This file shipped its own copy for one day
 * (2026-09-02) with a NARROWER `/\s/` predecessor class that missed a `#` opening a
 * comment after `;`, `&`, `|` or `(` — the drift that always follows a copy-paste, and
 * what `guard-string-literal-blindness` caught. The shared version keeps the wider class.
 */
export const stripTrailingComment = (line) => stripShellTrailingComment(line);

/**
 * Split a command line into pipeline stages on a single `|`, respecting quotes and
 * leaving `||` (a control operator, not a pipe) alone.
 */
export function splitPipeline(line) {
  const stages = [];
  let cur = '';
  let sq = false;
  let dq = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && dq) {
      cur += c + (line[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    if (c === '|' && !sq && !dq) {
      if (line[i + 1] === '|') {
        cur += '||';
        i++;
        continue;
      }
      if (line[i - 1] === '|') {
        cur += c;
        continue;
      }
      stages.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  stages.push(cur);
  return stages;
}

/** Is this stage a consumer that can exit before reading its input to EOF? */
export function earlyExitingConsumer(stage) {
  const s = stage.trim();
  // `grep -q`, `grep -rq`, `grep --quiet`, `grep -m 1`, `grep -m1`
  if (/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo\s+(?:-\S+\s+)*)?(?:e?grep|rg)\b/.test(s)) {
    if (/--quiet\b|--silent\b|--max-count\b/.test(s)) return 'grep --quiet/--max-count';
    if (hasShortFlag(s, 'qm')) return 'grep -q/-m';
    return null;
  }
  if (/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*head\b/.test(s)) return 'head';
  return null;
}

/**
 * The command word of a pipeline stage, skipping leading env assignments, `sudo`,
 * subshell parens and shell keywords. Returns { word, args } or null.
 */
export function producerCommand(stage) {
  let s = stage.trim();
  s = s.replace(/^[({]\s*/, '');
  s = s.replace(/^(?:if|while|until|elif|then|do|!)\s+/, '');
  // `VAR=$(...)`, `local VAR=$(...)`, `export VAR=$(...)` — step into the substitution
  s = s.replace(/^(?:local\s+|declare\s+(?:-\S+\s+)*|export\s+|readonly\s+)?[A-Za-z_][A-Za-z0-9_]*\+?=\s*"?\$\(\s*/, '');
  s = s.replace(/^"?\$\(\s*/, '');
  // leading env assignments: FOO=bar BAZ=qux cmd
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  s = s.replace(/^(?:sudo|command|env)\s+(?:-\S+\s+)*/, '');
  const m = s.match(/^([A-Za-z_][A-Za-z0-9_.-]*|\.?\/[^\s]+)/);
  if (!m) return null;
  const word = path.basename(m[1]);
  return { word, args: s.slice(m[1].length).trim() };
}

/**
 * A `cat`/`grep` reading a /proc or /sys pseudo-file is bounded in practice — those
 * are page-sized. Without this the guard fires on every `cat /proc/<pid>/cmdline |
 * head -c 160`, which is a false positive it must not produce.
 */
function boundedByPseudoFs(args) {
  return /(^|\s)["']?\/(proc|sys)\//.test(args);
}

/**
 * Is any of `letters` present among the short flags in `args`? Tokenised rather than
 * matched with a `-[a-z]*[rR]` style regex, because short flags COMBINE: `grep -rn`
 * packs `-r` and `-n` into one token, and a character-class regex anchored with `\b`
 * silently misses it — reporting a recursive tree walk as a bounded producer.
 */
function hasShortFlag(args, letters) {
  return args
    .split(/\s+/)
    // The trailing `\d*` keeps `grep -m1` (an attached argument) in the population.
    .map((t) => /^-([A-Za-z]+)\d*$/.exec(t)?.[1])
    .filter(Boolean)
    .some((cluster) => [...cluster].some((c) => letters.includes(c)));
}

/** Does this stage carry a non-flag operand (a file/URL to read), as opposed to filtering stdin? */
function hasOperand(args) {
  return args
    .split(/\s+/)
    .filter(Boolean)
    .some((tok) => !tok.startsWith('-') && !/^\d+$/.test(tok));
}

/** Does this stage drain its input to EOF, shielding everything upstream from SIGPIPE? */
export function drainsInput(cmd) {
  return !!cmd && DRAINING_STAGES.has(cmd.word);
}

/**
 * Classify one producer stage: null if bounded, else the reason it is unbounded.
 * `isFirstStage` matters because a filter-capable command with no file operand is
 * bounded by its upstream rather than by a file.
 */
export function unboundedProducerReason(cmd, isFirstStage = true) {
  if (!cmd) return null;
  const { word, args } = cmd;
  if (word === 'git') {
    const sub = args.replace(/^(?:-\S+\s+|--\S+=\S+\s+|-C\s+\S+\s+)*/, '').split(/\s+/)[0];
    return UNBOUNDED_GIT_SUBCOMMANDS.has(sub) ? `git ${sub} output is unbounded` : null;
  }
  if (
    (word === 'grep' || word === 'egrep' || word === 'rg') &&
    (hasShortFlag(args, 'rR') || /--recursive\b|--dereference-recursive\b/.test(args))
  ) {
    return 'a recursive grep walks a tree';
  }
  const reason = UNBOUNDED_PRODUCERS.get(word);
  if (!reason) return null;
  if ((word === 'cat' || word === 'tac') && boundedByPseudoFs(args)) return null;
  // `find <path> -maxdepth 0` names one path — it walks nothing.
  if (word === 'find' && /\s-maxdepth\s+0\b/.test(args)) return null;
  // A filter with nothing to open is bounded by whatever fed it.
  if (!isFirstStage && FILTER_CAPABLE.has(word) && !hasOperand(args)) return null;
  return reason;
}

/**
 * Is the pipeline's non-zero status neutralised on this line? The closing bracket is
 * part of the pattern on purpose: `v=$(producer | head -1 || true)` is the commonest
 * spelling of a deliberately-discarded status, and omitting `)` here reported it as
 * unfixed after it had been fixed.
 */
export function neutralised(line) {
  return /\|\|\s*(?:true|:)\s*(?:[\s;)}&|]|$)/.test(line);
}

/**
 * Find every pipefail/SIGPIPE site in one script's text.
 * Returns rows for BOTH classifications so `--list` can print the census.
 */
export function findSites(text, file) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*#/.test(raw)) continue;
    const line = stripTrailingComment(raw);
    const stages = splitPipeline(line);
    if (stages.length < 2) continue;

    let consumerIdx = -1;
    let consumerKind = null;
    for (let k = 1; k < stages.length; k++) {
      const kind = earlyExitingConsumer(stages[k]);
      if (kind) {
        consumerIdx = k;
        consumerKind = kind;
        break;
      }
    }
    if (consumerIdx < 0) continue;

    // Any stage BEFORE the early-exiting consumer can take SIGPIPE — but only back as
    // far as the last DRAINING stage, which shields everything upstream of it.
    const cmds = [];
    for (let k = 0; k < consumerIdx; k++) cmds.push(producerCommand(stages[k]));
    let firstAtRisk = 0;
    for (let k = cmds.length - 1; k >= 0; k--) {
      if (drainsInput(cmds[k])) {
        firstAtRisk = k + 1;
        break;
      }
    }

    let unbounded = null;
    let producerWord = null;
    for (let k = firstAtRisk; k < cmds.length; k++) {
      const cmd = cmds[k];
      const reason = unboundedProducerReason(cmd, k === 0);
      if (cmd && !producerWord) producerWord = cmd.word;
      if (reason) {
        unbounded = reason;
        producerWord = cmd.word;
        break;
      }
    }
    if (!producerWord) producerWord = cmds[0]?.word ?? '?';

    rows.push({
      file,
      line: i + 1,
      code: raw.trim(),
      producer: producerWord ?? '?',
      consumer: consumerKind,
      unbounded,
      neutralised: neutralised(line),
    });
  }
  return rows;
}

function allowlistedReason(row) {
  const hit = ALLOWLIST.find((a) => a.file === row.file && row.code.includes(a.match));
  return hit ? hit.why : null;
}

function listTrackedShellScripts() {
  const out = execFileSync('git', ['ls-files', '-z', '*.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  // WI-10004176: drop index entries a peer's plain `rm` left until git-sync commits it.
  return presentOnDisk(out.split('\0').filter(Boolean), ROOT);
}

function main() {
  const argv = process.argv.slice(2);
  // `--census` is the repo-wide spelling for "print the measured population" and is the
  // one `check-lint-guard-reachability.mjs` recognises as a COMPANION invocation of this
  // same guard rather than as a second, separately-unwired guard.
  const wantList = argv.includes('--list') || argv.includes('--census');
  const wantJson = argv.includes('--json');

  const files = listTrackedShellScripts();
  const scanned = [];
  const all = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(path.join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    if (!enablesPipefail(text)) continue;
    scanned.push(f);
    all.push(...findSites(text, f));
  }

  const live = all.filter((r) => !r.neutralised);
  const offenders = live.filter((r) => r.unbounded && !allowlistedReason(r));
  const staleAllowlist = ALLOWLIST.filter(
    (a) => !live.some((r) => r.file === a.file && r.code.includes(a.match)),
  );

  if (wantJson) {
    // NOTE: `process.exitCode` + a natural exit, never `process.exit()` — this guard
    // must not commit the truncation defect `lint:no-undrained-stdout-exit` polices.
    console.log(
      JSON.stringify(
        { filesScanned: scanned.length, sites: all.length, live: live.length, offenders, staleAllowlist },
        null,
        2,
      ),
    );
    process.exitCode = offenders.length ? 1 : 0;
    return;
  }

  if (wantList) {
    const byClass = { unbounded: [], bounded: [], neutralised: [] };
    for (const r of all) {
      if (r.neutralised) byClass.neutralised.push(r);
      else if (r.unbounded) byClass.unbounded.push(r);
      else byClass.bounded.push(r);
    }
    console.log(
      `pipefail/SIGPIPE census — ${scanned.length} pipefail script(s) of ${files.length} tracked *.sh, ${all.length} shape match(es)\n`,
    );
    console.log(`UNBOUNDED producer (gated — ${byClass.unbounded.length}):`);
    for (const r of byClass.unbounded) {
      const why = allowlistedReason(r);
      console.log(`  ${r.file}:${r.line}  [${r.producer} | ${r.consumer}] ${r.unbounded}${why ? `  (allowlisted: ${why})` : ''}`);
      console.log(`      ${r.code}`);
    }
    console.log(`\nBOUNDED producer (not gated — ${byClass.bounded.length}), by producer:`);
    const counts = new Map();
    for (const r of byClass.bounded) counts.set(r.producer, (counts.get(r.producer) ?? 0) + 1);
    for (const [w, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${w}`);
    }
    console.log(`\nNEUTRALISED by \`|| true\` (not gated — ${byClass.neutralised.length}).`);
    process.exitCode = 0;
    return;
  }

  if (staleAllowlist.length) {
    console.error('✗ lint:pipefail-sigpipe — stale ALLOWLIST entr(ies); the site is gone, drop the entry:\n');
    for (const a of staleAllowlist) console.error(`    ${a.file}  match: ${a.match}`);
    process.exitCode = 1;
    return;
  }

  if (offenders.length === 0) {
    console.log(
      `lint:pipefail-sigpipe: clean — ${scanned.length} pipefail script(s) scanned, ${all.length} shape match(es), none with an unbounded producer.`,
    );
    return;
  }

  console.error(
    '✗ pipefail + early-exiting consumer over an UNBOUNDED producer — this pipeline reports\n' +
      '  FALSE FAILURE ("not found") exactly when the match IS present and the producer is\n' +
      '  still writing (EI-22176104184812266):\n',
  );
  for (const r of offenders) {
    console.error(`    ${r.file}:${r.line}  ${r.producer} | ${r.consumer} — ${r.unbounded}`);
    console.error(`      ${r.code}`);
  }
  console.error(
    `\n  ${offenders.length} site(s). Fix with one of the shapes already used in this tree:\n` +
      '    • capture, then match:  v="$(producer || true)"; case "$v" in *needle*) ;; esac\n' +
      '    • a consumer that reads to EOF: `grep -c`, or grep without -q/-m\n' +
      '    • drop the pipe: `grep -aqF needle "$file"` reads the file directly\n' +
      '    • `|| true` when the pipeline status genuinely does not matter\n' +
      '  See papercusp-desktop/bin/release-local.sh (capture-then-match) and\n' +
      '  papercusp-desktop/bin/build-windows-cross.sh (grep -a on the file) for worked examples.\n',
  );
  process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) {
  main();
}
