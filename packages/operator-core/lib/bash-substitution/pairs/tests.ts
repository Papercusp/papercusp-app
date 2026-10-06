/**
 * Equivalence pairs — the TEST-RUNNING family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-021).
 *
 * Population (D-021, measured over the 7d corpus): 2,645 test-running atoms
 * across 68 of 86 su sessions. Proposed replacement: `testing:run`, built in
 * this same item.
 *
 * ── What measuring the corpus changed about this family ──────────────────────
 * The plan framed P-021 as "agents run tests by hand, give them a runner". The
 * corpus says they already HAVE a good runner (`scripts/test-files.mjs`) and
 * reach for it 70.8% of the time. What they lack is a RESULT: 84.8% of these
 * commands pipe the output to `tail`/`head`, 81.7% merge `2>&1` into that pipe,
 * and 15.7% redirect to a log and grep it separately. So the tool this family
 * routes to returns counts + per-test failures and offers no raw passthrough —
 * and this file's job is to say precisely which real commands that faithfully
 * replaces, and which it does not.
 *
 * ── Three pairs, because the family splits three ways ────────────────────────
 *  1. `tests.router-files`  — the dominant, healthy shape. Equivalent.
 *  2. `tests.raw-vitest`    — the router BYPASS. Equivalent, and the one that
 *     matters for correctness (see below).
 *  3. `tests.affected`      — `npm run test:affected`. NOT a substitute, and
 *     recorded as such so the conclusion is durable and re-derived every run
 *     rather than living in a code comment (same role `process.ps-pgrep` plays).
 *
 * ── Why the bypass pair is a correctness row, not a style row ────────────────
 * 372 raw-`vitest run` atoms appear across 44 sessions, 107 of them with no
 * `cd` — i.e. root-level `vitest run <path>`. There is intentionally no root
 * Vitest config, so under `--passWithNoTests` such a run can match zero files,
 * execute NOTHING, and exit 0. That is a false green in the one place a false
 * green is most expensive. `scripts/test-files.mjs` hard-refuses it, and
 * `testing:run` can only ever go through the router, so routing this shape at
 * the tool removes the failure mode rather than merely tidying the command.
 *
 * ── The envelope, read from the tool, not assumed ────────────────────────────
 * `testing:run` (lib/agent-tools/testing/run.ts) takes
 * `{ files: string[1..50], changedPaths?, rootHarnessSlug?, testNamePattern?: string(1..200),
 * timeoutMs?, maxFailures? }`. Consequences that decide coverage below:
 *  • `changedPaths` is mutually exclusive with `files` and DERIVES the
 *    test:affected plan from edited source files — then runs nothing. It is why
 *    `tests.affected` below is not-a-substitute for "planning is not running",
 *    NOT for "the tool cannot compute a list"; that older reason is false.
 *  • `files` are handed to the router as-is, so a path must be REPO-ROOT
 *    anchored, relative or absolute. `rootHarnessSlug` can select another registered checkout for
 *    explicit files; these substitutions use the default checkout and still
 *    exclude arbitrary Vitest `--root`/`--config` commands.
 *    `atomize` splits `cd apps/operator && vitest run
 *    app/x.test.ts` into two atoms, so a cwd-relative operand arrives with the
 *    `cd` that gave it meaning already gone. Those are excluded by the pattern
 *    (see {@link ROOT_ANCHOR}), not failed by the envelope — D-008.
 *  • The reporter is fixed at `--reporter=json` and distilled, so a command
 *    that asks for a different reporter is asking for something else.
 *  • The config is chosen by the router from each file's owning workspace, so a
 *    hand-passed `--config`/`--root` is likewise a different request.
 *  • There is no output file. A command that redirects stdout to a log wants an
 *    artifact the tool does not produce (see the note on that exclusion below).
 */

import type { CoverageResult, ReplayToolCall, BashSubstitutionPair } from '../types';

/**
 * Mirrors `testing:run`'s `files` array bound. Exported so `pairs/model-drift.test.ts`
 * can pin it to the tool's real zod `.max()` (D-015) — the mirror is deliberate,
 * the DRIFT is not.
 */
export const TESTING_RUN_MAX_FILES = 50;

/** Mirrors `testing:run`'s `testNamePattern` length bound, same rationale. */
export const TESTING_RUN_MAX_PATTERN = 200;

/**
 * Repo top-level directories a test path may be anchored at.
 *
 * Derived from the corpus rather than from `readdir`: the operand's first
 * segment is `packages` 2,473x, `apps` 725x, `libs` 120x, `scripts` 6x,
 * `papercusp-desktop` 2x. The remaining segments seen — `lib` (72), `src` (32),
 * `app` (13) — are package-INTERNAL directories that only resolve after a `cd`
 * into the workspace, which is exactly the case the tool cannot serve, so they
 * are deliberately absent. `bin`/`tools`/`benchmarks`/`infra`/`templates`/
 * `_retired` are real repo roots included for completeness.
 *
 * Under-matching here is safe (a real command simply falls outside the pattern
 * and no advisory fires); over-matching would claim a command the tool cannot
 * express, which is the failure D-001 exists to prevent.
 */
const ROOT_DIRS = [
  '_retired', 'apps', 'benchmarks', 'bin', 'infra', 'libs',
  'packages', 'papercusp-desktop', 'scripts', 'templates', 'tools',
];

/** A path anchored at the repo root: absolute, or a known top-level directory. */
const ROOT_ANCHOR = `(?:/|(?:${ROOT_DIRS.join('|')})/)`;

/** A JS/TS source path — the only operand shape the router can route. */
const TEST_PATH = String.raw`\S+\.[cm]?[jt]sx?`;

/** One routable operand: a repo-root-anchored JS/TS path. */
const PATH_OPERAND = `${ROOT_ANCHOR}${TEST_PATH}`;

/** A `-t "…"` / `-t '…'` pair — the one Vitest flag with a tool argument. */
const T_PATTERN = String.raw`-t\s+(?:"[^"]*"|'[^']*')`;

/**
 * Trailing shell noise an atom may legitimately end with. `2>&1` is stderr
 * plumbing and `&` is backgrounding; neither changes the request. (A `|` never
 * appears here — `atomize` has already split on it.)
 */
const TRAILING_NOISE = String.raw`(?:\s+2>&1)?(?:\s*&)?\s*`;

/**
 * Tokens allowed AFTER the first path operand, repeated to the end of the atom.
 *
 * WHY THE PATTERNS ARE END-ANCHORED. Constraining only the first operand let a
 * pattern claim a command whose LATER operands the tool cannot express — and
 * the corpus contains exactly that: `vitest run packages/db/src/error-events.
 * unit.test.ts packages/connector-polymarket` mixes a file with a bare
 * DIRECTORY, which the router cannot route. The harness caught it as a
 * `needs-widening` verdict on the raw-vitest sample, and D-008's answer is to
 * narrow the pattern rather than lower the bar. Anchoring to the end costs
 * almost nothing measured against the corpus — the router family goes 920 → 917
 * distinct commands and the raw family 40 → 39, with session coverage unchanged
 * (67 and 5) — and in exchange the pattern now claims a command only when EVERY
 * token in it is expressible.
 */
const TRAILING_OPERANDS = `(?:\\s+(?:${T_PATTERN}|--run|${PATH_OPERAND}))*`;

/**
 * Atoms this family must never claim, excluded by PATTERN per D-008:
 *  • `$`/backtick — a shell expansion the tool cannot resolve to literal paths
 *    (`npm run test:file -- $(ls pkg/*.test.ts)` appears in the corpus)
 *  • `*`/`?` — a glob, same reason
 *  • `{}` — a `find -exec` placeholder
 *  • an stdout redirect — see below
 *  • `--reporter`/`--config`/`--root`/`--coverage`/`--watch` — a different
 *    request, not a differently-spelled one
 *
 * ON EXCLUDING THE REDIRECT FORM, which is worth stating plainly because it
 * costs real coverage: `… > /tmp/run.log 2>&1` is 71 of 400 distinct router
 * commands, and redirect-then-grep is 15.7% of the family — i.e. part of the
 * very output-handling cost `testing:run` was built to remove. It is excluded
 * anyway, because the command's literal effect includes a FILE the tool does not
 * produce, and this registry's standard is that a claimed command has a faithful
 * expression, not merely a better answer to the intent behind it. Claiming it
 * would let a promoted tier nudge an agent who genuinely wanted the artifact.
 * Note `2>&1` alone is NOT a redirect for this purpose — it is stderr plumbing
 * that changes nothing about the request, and it appears on 395 of 400 sampled
 * commands, so treating it as a write would empty the family.
 */
const EXCLUDE_UNEXPRESSIBLE =
  String.raw`(?![^\n]*[$\`])(?![^\n]*[*?])(?![^\n]*\{\})(?![^\n]*(?:^|\s)1?>)` +
  String.raw`(?![^\n]*--(?:reporter|config|root|coverage|watch))`;

/** Vitest flags that are no-ops for this tool: `vitest run` is already run-mode. */
const NOOP_FLAGS = new Set(['--run']);

/** Shell tokens that are stderr plumbing, not operands. */
const STDERR_PLUMBING = /^2>/;

interface ParsedTestCommand {
  /** Literal operands that should become `files`. */
  files: string[];
  /** Vitest flags the agent passed, normalised to their bare name. */
  flags: string[];
  /** The `-t` value, unquoted; `null` when absent. */
  testNamePattern: string | null;
  /** An stdout redirect is present: the command produces a log artifact. */
  writes: boolean;
  /** An operand contains a shell expansion or glob. */
  dynamic: boolean;
}

/** Whitespace tokeniser that keeps simple quoted spans intact. */
function tokenize(atom: string): string[] {
  return atom.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

/** Classify the operand/flag tokens of a test command. */
function walkTokens(tokens: string[]): ParsedTestCommand {
  const out: ParsedTestCommand = { files: [], flags: [], testNamePattern: null, writes: false, dynamic: false };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (STDERR_PLUMBING.test(token)) continue;

    const redirect = /^(\d*)(>>|>)/.exec(token);
    if (redirect) {
      if (redirect[1] === '' || redirect[1] === '1') out.writes = true;
      // A bare `> file` spends the next token on the target filename.
      if (/^\d*(?:>>|>)$/.test(token)) i += 1;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      const inlinePattern = /^--testNamePattern=(.*)$/.exec(token);
      if (inlinePattern) {
        out.testNamePattern = unquote(inlinePattern[1]);
        out.flags.push('--testNamePattern');
        continue;
      }
      if (token === '-t' || token === '--testNamePattern') {
        out.flags.push(token);
        // The pattern is the NEXT token and must not be mistaken for a file.
        if (i + 1 < tokens.length) {
          out.testNamePattern = unquote(tokens[i + 1]);
          i += 1;
        } else {
          out.testNamePattern = '';
        }
        continue;
      }
      out.flags.push(token.replace(/=.*/, ''));
      continue;
    }

    const operand = unquote(token);
    if (/[$`*?]/.test(operand)) out.dynamic = true;
    out.files.push(operand);
  }

  return out;
}

/**
 * `npm run test:file -- <files> [-- <vitest args>]`.
 * The corpus contains the double-`--` form (`-- x.test.ts -- -t "Ask"`), so the
 * second separator, when present, splits operands from Vitest flags. Both halves
 * go through the same walk — the split only matters for readability here.
 */
function parseRouterAtom(atom: string): ParsedTestCommand {
  const tokens = tokenize(atom);
  const sep = tokens.indexOf('--');
  return walkTokens(sep === -1 ? [] : tokens.slice(sep + 1).filter((t) => t !== '--'));
}

/** `[npx] vitest run [flags] <files>`. */
function parseRawVitestAtom(atom: string): ParsedTestCommand {
  const tokens = tokenize(atom);
  const runAt = tokens.findIndex((t) => t === 'run');
  return walkTokens(runAt === -1 ? [] : tokens.slice(runAt + 1));
}

/** Render the tool call a covered command maps onto. */
function expressionFor(parsed: ParsedTestCommand): string {
  const files = parsed.files.map((f) => `"${f}"`).join(', ');
  const pattern = parsed.testNamePattern ? `, testNamePattern: "${parsed.testNamePattern}"` : '';
  return `testing:run { files: [${files}]${pattern} }`;
}

/**
 * The EXECUTABLE form of {@link expressionFor} — the same call, as arguments
 * rather than as display text (P-009).
 *
 * Gated on `cover()` exactly as the file-read family's `readRewrite` is, and for
 * the same reason: an advisory that renders a runnable `tools:invoke` line for a
 * command the tool cannot faithfully serve is worse than one that renders prose,
 * because the agent runs it before noticing. So the two are ONE decision — if
 * this family declines to claim a command, it declines to hand over a call for
 * it too.
 *
 * Args mirror `expressionFor` field-for-field on purpose. That duplication is
 * the same deliberate mirror `cover()`/`rewrite()` keep throughout this module
 * (D-055): the display string and the executable call are allowed to be written
 * twice precisely so a replay can put them side by side and catch a drift, which
 * is how the `head` 200x over-read was found.
 */
function rewriteTestCommand(
  pair: Pick<BashSubstitutionPair, 'cover'>,
  atom: string,
  parse: (atom: string) => ParsedTestCommand,
): ReplayToolCall | null {
  if (!pair.cover(atom).covered) return null;
  const parsed = parse(atom);
  const args: Record<string, unknown> = { files: parsed.files };
  if (parsed.testNamePattern) args.testNamePattern = parsed.testNamePattern;
  return { toolName: 'testing:run', args };
}

/**
 * The shared capability envelope: everything `testing:run` can and cannot
 * express about a parsed test command. Both equivalent pairs use this, so the
 * two rows can never drift from each other.
 */
function coverTestCommand(parsed: ParsedTestCommand): CoverageResult {
  if (parsed.writes) {
    return { covered: false, reason: 'redirects the run to a log file; testing:run returns a structured result and writes no artifact' };
  }
  if (parsed.dynamic) {
    return { covered: false, reason: 'operand is a shell expansion or glob, not a literal path' };
  }
  if (parsed.files.length === 0) {
    return { covered: false, reason: 'no test file operand (runs a whole suite); testing:run requires an explicit file list' };
  }
  if (parsed.files.length > TESTING_RUN_MAX_FILES) {
    return { covered: false, reason: `${parsed.files.length} files in one call; testing:run takes at most ${TESTING_RUN_MAX_FILES}` };
  }

  const unrouteable = parsed.files.find((f) => !/\.[cm]?[jt]sx?$/.test(f));
  if (unrouteable) {
    return { covered: false, reason: `operand "${unrouteable}" is a directory or name filter; testing:run takes explicit file paths` };
  }

  const unanchored = parsed.files.find((f) => !new RegExp(`^${ROOT_ANCHOR}`).test(f));
  if (unanchored) {
    return {
      covered: false,
      reason: `operand "${unanchored}" is relative to the command's cwd (a preceding \`cd\`), which the atom no longer carries; testing:run needs a repo-root-relative or absolute path`,
    };
  }

  if (parsed.testNamePattern !== null) {
    if (parsed.testNamePattern.length === 0) {
      return { covered: false, reason: 'empty -t pattern; testing:run requires a non-empty testNamePattern' };
    }
    if (parsed.testNamePattern.length > TESTING_RUN_MAX_PATTERN) {
      return { covered: false, reason: `-t pattern is ${parsed.testNamePattern.length} chars; testing:run caps testNamePattern at ${TESTING_RUN_MAX_PATTERN}` };
    }
  }

  const unexpressible = parsed.flags.find(
    (f) => f !== '-t' && f !== '--testNamePattern' && !NOOP_FLAGS.has(f),
  );
  if (unexpressible) {
    return { covered: false, reason: `passes \`${unexpressible}\`, which testing:run has no argument for` };
  }

  return { covered: true, expression: expressionFor(parsed) };
}

/**
 * P-021a — `npm run test:file -- <paths>`: the dominant shape, 69.5% of the
 * family. Already correctly routed; what the tool changes is the RESULT the
 * agent gets back, which is where the measured cost actually sits.
 *
 * ── EI-19333354769591247: the routing cell also has to name the QUEUE ────────
 * The rows above sell this pair on output quality, and that is the right
 * everyday reason. But it buries the one that decides the call under fleet
 * load, and an agent reading only the quality argument reasonably concludes the
 * bash form is merely more verbose — not that it may never start at all.
 *
 * MECHANISM (read in source, re-verified 2026-08-31, not inherited from the
 * filing). `package.json` `test:file` is `… bash scripts/pc-heavy.sh node
 * scripts/test-files.mjs`, so every invocation takes a pc-heavy admission
 * ticket. `agent-tools/testing/run.ts` reaches the SAME router by
 * `spawn(process.execPath, [join(root,'scripts','test-files.mjs'), …])` with no
 * wrapper, so it never enters that queue. (It scrubs PC_HEAVY_PREEMPT_READY_FILE
 * / PC_HEAVY_PSI_FINALIZATION_FILE from the child env for the nested case — it
 * declines to own an outer barrier rather than taking a ticket of its own.)
 * Same router, same configs, same verdict; only the admission differs.
 * Pinned against drift by doc-claims/testing-run-pc-heavy-bypass.test.ts.
 *
 * ⚠ SCOPE — deliberately NOT extended to `build:typecheck`, though the filing's
 * title pairs them. The claim does not survive the same check: `build:typecheck`
 * spawns `npx tsc` directly (build/typecheck.ts), but so does the `npx tsc
 * --noEmit -p <project>` its routing row displaces, and `npm run lint:tsc` is
 * `node scripts/lint-tsc.mjs` — none of the three is pc-heavy-wrapped, so there
 * is no queue to bypass. (`lint:tsc:workspaces` / `lint:tsc:papercusp-libs` ARE
 * wrapped, but they answer the whole-tree ratchet question, not this one.)
 * build:typecheck's real win stays what its own docs claim: a refusal of the
 * zero-file run plus structured diagnostics. Stating a queue win there would be
 * a false routing incentive, which is the exact failure this row exists to fix.
 */
export const routerTestFiles: BashSubstitutionPair = {
  id: 'tests.router-files',
  intentLabel: 'run-test-files',
  // `--` is permitted mid-list: the corpus contains the double-separator form
  // `-- <files> -- -t "…"`, where the second `--` hands the rest to Vitest.
  bashPattern: new RegExp(
    `^${EXCLUDE_UNEXPRESSIBLE}npm\\s+run\\s+test:file\\s+--\\s+${PATH_OPERAND}` +
      `(?:\\s+(?:--|${T_PATTERN}|--run|${PATH_OPERAND}))*${TRAILING_NOISE}$`,
  ),
  toolName: 'testing:run',
  advisoryText:
    'testing:run { files } runs the same router and returns { passed, failed, files, failures:[{file,test,message}] } — no `2>&1 | tail -60` and no log to grep afterwards. It also spawns that router DIRECTLY, taking no pc-heavy admission ticket: under fleet load `npm run test:file` queues behind every other heavy job while this returns immediately.',
  routing: {
    want: 'to run specific test files and see which tests failed',
    use: '`testing:run { files: [...] }` — spawns the router directly, so it never waits for a pc-heavy admission ticket',
    // ⚠ 300-char table-cell cap (routing-table.test.ts). This cell is 286; the
    // measurement narrative belongs in `advisoryText` and the header comment.
    insteadOf: '`npm run test:file -- <paths> 2>&1 | tail -60` — pc-heavy-wrapped, so under load it queues behind every heavy job (measured: 14+ min without starting, one attempt killed SIGTERM/143 with ZERO output, vs 1471ms via the tool). A log-file redirect is not this — the tool writes no artifact',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    return coverTestCommand(parseRouterAtom(atom));
  },
  // P-009. No `replayEnvelope`: `npm` is not on the replay allowlist
  // (REPLAYABLE_VERBS), so declaring a rewrite here does NOT enrol this pair in
  // replay execution — D-060's hold on widening that list is untouched. The
  // rewrite exists for the ADVISORY path, which is where this row's 432 fires
  // are, and it is the row the testing:run promotion is about.
  rewrite(atom: string): ReplayToolCall | null {
    return rewriteTestCommand(routerTestFiles, atom, parseRouterAtom);
  },
};

/**
 * P-021b — raw `vitest run <paths>`: the router BYPASS, 12.3% of the family.
 * Same tool call, but here the substitution also removes the root-level
 * zero-match false green described in this file's header.
 */
export const rawVitestFiles: BashSubstitutionPair = {
  id: 'tests.raw-vitest',
  // Distinct from `routerTestFiles`' label even though both route to the same
  // tool: `intentLabel` is the registry's KEY (it mirrors the
  // `harness_shared.bash_tool_substitutions` row), so two pairs sharing one
  // label collapse into a single row and the drift check then compares each
  // pair against the other's stored values. The sibling `file-read` family
  // does the same — four labels, one tool.
  intentLabel: 'run-test-files-unrouted',
  bashPattern: new RegExp(
    `^${EXCLUDE_UNEXPRESSIBLE}(?:npx\\s+)?vitest\\s+run\\s+(?:${T_PATTERN}\\s+)?${PATH_OPERAND}` +
      `${TRAILING_OPERANDS}${TRAILING_NOISE}$`,
  ),
  toolName: 'testing:run',
  advisoryText:
    'testing:run { files } routes each file to its OWNING Vitest config and refuses a zero-match run. A bare `vitest run <path>` from the repo root can match nothing and still exit 0 — a false green.',
  routing: {
    want: 'to run test files without hand-picking a Vitest config',
    use: '`testing:run { files: [...] }`',
    insteadOf: '`npx vitest run <path>` (a root-level run can match zero files and still exit 0 — the router refuses that)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    return coverTestCommand(parseRawVitestAtom(atom));
  },
  // P-009 — see the sibling above. `vitest`/`npx` are likewise off the replay
  // allowlist, so this is an advisory-path rewrite only.
  rewrite(atom: string): ReplayToolCall | null {
    return rewriteTestCommand(rawVitestFiles, atom, parseRawVitestAtom);
  },
};

/**
 * P-021c — `npm run test:affected`: 7.9% of the family, and deliberately NOT
 * covered.
 *
 * This pair exists to make that a RECORDED verdict rather than a comment.
 * `scripts/affected-tests.mjs` walks the dependency graph from a git diff and
 * runs each workspace's own `npm test`; it has no Vitest-argument passthrough,
 * so a JSON reporter cannot be plumbed through it and there is no file list to
 * hand `testing:run` in the first place. The question it answers — "what did my
 * edits affect?" — is not the question `testing:run` answers. Recording it keeps
 * the routing table honest (`not-a-substitute` rows are filtered out of
 * CLAUDE.md) and keeps the DB row pinned at `observe` by the
 * `tier_requires_equivalence` constraint, so no future promotion sweep can
 * quietly start nudging agents off a tool that has no replacement.
 */
export const affectedTests: BashSubstitutionPair = {
  id: 'tests.affected',
  intentLabel: 'run-affected-tests',
  bashPattern: /^npm\s+run\s+test:affected/,
  toolName: 'testing:run',
  advisoryText:
    'No substitute for RUNNING them: keep using the script. But to see only WHAT it would select, `testing:run { changedPaths }` returns that plan in ~0.4s without a pc-heavy admission ticket — and running nothing is exactly why it does not replace this command.',
  // `use` names the tool it was audited against even though the verdict is
  // negative — the routing test requires it, and the reason is sound: the row
  // records WHICH tool was rejected for this intent, not just that one was.
  // Same shape as `process.ps-pgrep`. (Never rendered: the generator emits only
  // `equivalent` pairs.)
  routing: {
    want: 'to run everything your edits affected',
    use: '`testing:run` — REJECTED for this intent (P-021); it needs an explicit file list',
    insteadOf: '`npm run test:affected` — no tool form; keep using the script',
  },
  expectedVerdict: 'not-a-substitute',
  cover(atom: string): CoverageResult {
    void atom;
    return {
      covered: false,
      reason:
        'runs what the dependency graph selects; testing:run can DERIVE that selection (changedPaths) but executes nothing from it, so it plans where this command runs',
    };
  },
};

/** Every pair in the test-running family, in registry order. */
export const TESTS_PAIRS: BashSubstitutionPair[] = [routerTestFiles, rawVitestFiles, affectedTests];
