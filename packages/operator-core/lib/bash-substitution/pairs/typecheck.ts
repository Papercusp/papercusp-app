/**
 * Equivalence pairs — the TYPECHECK family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-024).
 *
 * Population (measured over the 7d corpus): 622 direct `tsc` atoms across 59 of
 * 86 su sessions, 95% of them carrying `--noEmit` — so this family is
 * TYPECHECKING, not building, and the pair is named for what it actually is.
 * The pre-authoring overlap test returned ZERO atoms claimed by any existing
 * pair, the same licence that greenlit `logs:read` (D-027).
 *
 * Proposed replacement: `build:typecheck`, built in this same item.
 *
 * ── What the measurement changed about this family ───────────────────────────
 * Two things, and the second is the reason the tool exists at all.
 *
 * 1. THE DISTILLING THESIS HELD. 72% of the family's whole-commands pipe the
 *    compiler's output into `grep`/`head`/`tail` and 17% redirect it to a log
 *    file — agents pulling a full compiler log across the pipe to throw nearly
 *    all of it away, exactly the defect `logs:read` fixed for journalctl.
 *
 * 2. A LARGE SHARE OF THIS FAMILY TYPECHECKED NOTHING. This repo has no root
 *    `tsconfig.json` (only `tsconfig.base.json`), yet the two most common
 *    project operands in the whole corpus are `-p .` (183 atoms) and
 *    `-p tsconfig.json` (225). From the repo root both fail instantly —
 *    TS5057 / TS5058 — having checked zero files. Replaying each session's cwd
 *    over the corpus puts it at 45 of 425 decidable invocations (11%, 24 of 86
 *    sessions); a cwd-agnostic reading of the same data says 103 of 455 (23%).
 *    What makes it expensive is how it was READ: 42% of those runs were piped
 *    into `grep`, and a `grep <my-file>` over a one-line TS5057 prints NOTHING —
 *    indistinguishable from "my file is clean". See {@link NO_OP_TYPECHECK_FINDING}.
 *
 * ── ONE pair, and why there is no negative sibling ───────────────────────────
 * `tests.affected` and `process.ps-pgrep` exist to record a durable NEGATIVE
 * verdict. There is deliberately no such row for the `-p .` / `-p tsconfig.json`
 * shape, because `not-a-substitute` would be a WRONG verdict: those commands are
 * precisely what `build:typecheck` serves best. They are unclaimable for a
 * different reason — `atomize` splits `cd <dir> && tsc -p .` in two, so the atom
 * no longer carries the cwd that gave `.` its meaning, and the pattern cannot
 * decide whether it named a real project or the no-op above. That is an
 * undecidable ATOM, not an absent tool, so it is excluded by pattern (the same
 * treatment `tests.ts` gives a cwd-relative test path) and recorded as data
 * here rather than mislabelled as a verdict.
 *
 * ── The envelope, read from the tool, not assumed ────────────────────────────
 * `build:typecheck` (lib/agent-tools/build/typecheck.ts) takes
 * `{ project: string(1..400), files?: string[0..50], dirs?: string[0..20], maxErrors?,
 * timeoutMs?, incremental?, scopeToFiles? }`. Consequences that decide coverage below:
 *  • `scopeToFiles` (EI-19297428004790873) compiles only `files` + their import
 *    graph, under a generated config that EXTENDS the project's. It does NOT
 *    widen this family: no plain-tsc command asks for "the project's
 *    compilerOptions over a SUBSET of its files" — `tsc -p X a.ts` is refused by
 *    tsc itself, and `tsc a.ts` discards tsconfig and uses default options.
 *  • `project` is resolved against the REPO ROOT, so a cwd-relative operand
 *    cannot be expressed (above).
 *  • The tool always passes `--noEmit`, so a command WITHOUT it is asking tsc to
 *    EMIT — a different request, not a differently-spelled one.
 *  • The tool always passes `--pretty false` and parses the result, so a command
 *    choosing a different output format wants something else.
 *  • There is no output file. A command redirecting stdout to a log wants an
 *    artifact the tool does not produce — the same deliberate coverage sacrifice
 *    `tests.ts` makes, for the same reason.
 *  • `incremental` is the ONLY compiler option with an argument. Any other
 *    (`--skipLibCheck`, `--target`, `--module`, `--strict`, …) changes what is
 *    being checked and has no tool expression.
 */

import type { CoverageResult, ReplayToolCall, BashSubstitutionPair } from '../types';

/** Mirrors `build:typecheck`'s `project` length bound (pinned by model-drift.test.ts). */
export const BUILD_TYPECHECK_MAX_PROJECT = 400;

/** Mirrors `build:typecheck`'s `files` array bound, same rationale. */
export const BUILD_TYPECHECK_MAX_FILES = 50;

/**
 * What excluding the cwd-relative project operand DROPS, recorded as data
 * rather than discarded — the same role `SOCKET_STATE_FINDING` and
 * `HEALTH_PAYLOAD_FINDING` play for the service family (D-029).
 *
 * This is the largest single exclusion in the family (305 of 622 atoms), and
 * unlike those two it is not merely a different question: an unknown fraction
 * of these commands typechecked NOTHING and reported it in a way that reads as
 * clean. The pattern cannot claim them, but the finding must not evaporate —
 * it is the tool's whole correctness argument, and it is the fifth instance in
 * this plan of ABSENT EVIDENCE MUST NOT READ AS EVIDENCE OF ABSENCE.
 */
export const NO_OP_TYPECHECK_FINDING = {
  droppedAtoms: 305,
  reason: 'cwd-relative project operand (`-p .` / `-p tsconfig.json`); the atom no longer carries the `cd` that gave it meaning',
  noOpInvocations: 45,
  noOpOfDecidable: 425,
  noOpSessions: 24,
  pipedToGrepShare: 0.42,
  note:
    'The repo has no root tsconfig.json, so at the root these resolve to TS5057/TS5058 and check zero files. ' +
    'build:typecheck refuses that rather than reporting a clean zero (see NO_INPUT_CODES in lib/tsc-diagnostics.ts).',
} as const;

/**
 * Repo top-level directories a project path may be anchored at — the same
 * ROOT_ANCHOR device `tests.ts` uses, for the same reason: it is the only way
 * to know an operand means the same thing without the `cd` the atomizer removed.
 *
 * Absolute paths are deliberately NOT anchored here even though the tool accepts
 * them. The corpus's absolute `-p` operands point into OTHER checkouts (oddsmith
 * clones, sibling worktrees) with their own `node_modules`, and this tool runs
 * from the papercusp root — so claiming them would claim commands the tool
 * cannot faithfully reproduce. Costing: zero, since no absolute operand appears
 * among the family's common shapes. The arg being more permissive than the
 * claim is the safe direction.
 */
const ROOT_DIRS = [
  '_retired', 'apps', 'benchmarks', 'bin', 'infra', 'libs',
  'packages', 'papercusp-desktop', 'scripts', 'templates', 'tools',
];

/** A project operand anchored at a known repo top-level directory. */
const PROJECT_OPERAND = `(?:${ROOT_DIRS.join('|')})/[\\w./@-]*`;

/**
 * Flags that change nothing about the request `build:typecheck` serves.
 * `--incremental` maps onto the tool's own arg; `--pretty` is an output-format
 * choice the tool makes for itself (it always parses `--pretty false`).
 */
const NOOP_FLAGS = String.raw`(?:--incremental(?:\s+(?:true|false))?|--pretty(?:\s+(?:true|false))?)`;

/** Stderr plumbing and backgrounding — neither changes the request. */
const TRAILING_NOISE = String.raw`(?:\s+2>&1)?(?:\s*&)?\s*`;

/**
 * `--noEmit` must actually be PRESENT.
 *
 * A structural `(?:\s+--noEmit)*` group permits zero occurrences, so the first
 * draft of this pattern claimed `npx tsc -p packages/engine/tsconfig.build.json`
 * — a command with no `--noEmit` at all, i.e. one that EMITS. The harness caught
 * it as 23/24 (`needs-widening`), and D-029's rule decides the exit: emitting is
 * a DIFFERENT QUESTION from typechecking, so the PATTERN was over-claiming and
 * the tool needs nothing. A lookahead is used rather than making the group
 * mandatory because the flag legitimately appears on either side of `-p`.
 */
const REQUIRE_NO_EMIT = String.raw`(?=[^\n]*\s--noEmit(?:\s|$))`;

/**
 * Atoms this family must never claim, excluded by PATTERN per D-008:
 * a shell expansion or glob (the tool needs a literal path), a `find -exec`
 * placeholder, and an stdout redirect (the command's literal effect includes a
 * FILE the tool does not produce — 135 atoms, the same sacrifice `tests.ts`
 * makes). `2>&1` alone is NOT a redirect for this purpose: it is stderr
 * plumbing present on most of the family, and treating it as a write would
 * empty the pattern.
 */
const EXCLUDE_UNEXPRESSIBLE =
  String.raw`(?![^\n]*[$\`])(?![^\n]*[*?])(?![^\n]*\{\})(?![^\n]*(?:^|\s)1?>)`;

/** Compiler options with no tool argument — each changes WHAT is checked. */
const UNEXPRESSIBLE_OPTIONS = /--(?:skipLibCheck|target|module|moduleResolution|strict|types|noResolve|lib|jsx|declaration|composite|watch|listFiles|traceResolution|explainFiles|generateTrace)\b/;

interface ParsedTypecheckCommand {
  /** The `-p`/`--project` operand; null when absent. */
  project: string | null;
  /** Non-flag operands (explicit file inputs) — a different request. */
  files: string[];
  /** Every flag, normalised to its bare name. */
  flags: string[];
  /** `--noEmit` was passed. */
  noEmit: boolean;
  /** Build mode (`-b`/`--build`) — orchestrates project references, not this. */
  buildMode: boolean;
  /** An stdout redirect is present: the command produces a log artifact. */
  writes: boolean;
  /** An operand contains a shell expansion or glob. */
  dynamic: boolean;
  /** The `--incremental` value, when given. */
  incremental: boolean | null;
}

function tokenize(atom: string): string[] {
  return atom.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

/** `[npx] tsc [flags] [-p <project>] [files…]` */
function parseTscAtom(atom: string): ParsedTypecheckCommand {
  const out: ParsedTypecheckCommand = {
    project: null, files: [], flags: [], noEmit: false,
    buildMode: false, writes: false, dynamic: false, incremental: null,
  };
  const tokens = tokenize(atom);
  const start = tokens.findIndex((t) => t === 'tsc');
  if (start === -1) return out;

  for (let i = start + 1; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (/^2>/.test(token)) continue;
    const redirect = /^(\d*)(>>|>)/.exec(token);
    if (redirect) {
      if (redirect[1] === '' || redirect[1] === '1') out.writes = true;
      if (/^\d*(?:>>|>)$/.test(token)) i += 1;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      const bare = token.replace(/=.*/, '');
      out.flags.push(bare);
      if (bare === '--noEmit') { out.noEmit = true; continue; }
      if (bare === '-b' || bare === '--build') { out.buildMode = true; continue; }
      if (bare === '-p' || bare === '--project') {
        const inline = /^(?:-p|--project)=(.*)$/.exec(token);
        if (inline) { out.project = unquote(inline[1]); continue; }
        // The project is the NEXT token and must not be mistaken for a file.
        if (i + 1 < tokens.length) { out.project = unquote(tokens[i + 1]); i += 1; }
        else out.project = '';
        continue;
      }
      if (bare === '--incremental') {
        const inline = /^--incremental=(.*)$/.exec(token);
        const value = inline ? inline[1] : (tokens[i + 1] === 'true' || tokens[i + 1] === 'false' ? tokens[i + 1] : null);
        if (!inline && value !== null) i += 1;
        out.incremental = value === null ? true : value === 'true';
        continue;
      }
      continue;
    }

    const operand = unquote(token);
    if (/[$`*?]/.test(operand)) out.dynamic = true;
    out.files.push(operand);
  }

  if (out.project !== null && /[$`*?]/.test(out.project)) out.dynamic = true;
  return out;
}

/** Render the tool call a covered command maps onto. */
function expressionFor(parsed: ParsedTypecheckCommand): string {
  const incremental = parsed.incremental === true ? ', incremental: true' : '';
  return `build:typecheck { project: "${parsed.project}"${incremental} }`;
}

/** Everything `build:typecheck` can and cannot express about a parsed tsc command. */
function coverTypecheckCommand(parsed: ParsedTypecheckCommand): CoverageResult {
  if (parsed.writes) {
    return { covered: false, reason: 'redirects the compiler output to a log file; build:typecheck returns a structured result and writes no artifact' };
  }
  if (parsed.dynamic) {
    return { covered: false, reason: 'the project operand is a shell expansion or glob, not a literal path' };
  }
  if (parsed.buildMode) {
    return { covered: false, reason: 'runs tsc in BUILD mode (-b), which orchestrates project references and emits; build:typecheck runs a single --noEmit check' };
  }
  if (!parsed.noEmit) {
    return { covered: false, reason: 'no --noEmit: the command asks tsc to EMIT output, which build:typecheck never does' };
  }
  if (parsed.files.length > 0) {
    return {
      covered: false,
      // NOT "build:typecheck always checks a project" any more — `scopeToFiles` checks a
      // SUBSET. The refusal survives that change for a sharper reason: the tool always
      // applies the PROJECT'S compilerOptions (scoped mode extends them), whereas explicit
      // file operands make tsc discard tsconfig and compile under DEFAULTS. Same files,
      // different compiler settings, so it is a different question — not a re-spelling.
      reason: `passes explicit file operand(s) (${parsed.files[0]}), which makes tsc IGNORE tsconfig.json and compile under DEFAULT compilerOptions; build:typecheck always applies the project's own options (scopeToFiles narrows the file set but still extends that config)`,
    };
  }
  if (parsed.project === null) {
    return {
      covered: false,
      reason: 'no -p/--project: tsc auto-discovers a tsconfig by walking up from the shell\'s cwd, which the atom no longer carries; build:typecheck requires an explicit project',
    };
  }
  if (parsed.project.length === 0) {
    return { covered: false, reason: 'empty -p operand' };
  }
  if (parsed.project.length > BUILD_TYPECHECK_MAX_PROJECT) {
    return { covered: false, reason: `project path is ${parsed.project.length} chars; build:typecheck caps it at ${BUILD_TYPECHECK_MAX_PROJECT}` };
  }
  if (!new RegExp(`^(?:${ROOT_DIRS.join('|')})/`).test(parsed.project)) {
    return {
      covered: false,
      reason:
        `project "${parsed.project}" is relative to the command's cwd (a preceding \`cd\`), which the atom no longer carries; ` +
        'build:typecheck resolves `project` against the repo root',
    };
  }

  const unexpressible = parsed.flags.find(
    (f) => !['--noEmit', '-p', '--project', '--incremental', '--pretty'].includes(f),
  );
  if (unexpressible) {
    return { covered: false, reason: `passes \`${unexpressible}\`, which build:typecheck has no argument for` };
  }

  return { covered: true, expression: expressionFor(parsed) };
}

/**
 * P-024 — `tsc --noEmit -p <repo-anchored project>`: the claimable core of the
 * typecheck family, 123 atoms / 38 distinct shapes across 33 of 86 sessions.
 *
 * What the substitution changes is twofold, and both halves were measured: the
 * agent gets structured diagnostics instead of a log to pipe through `grep`,
 * AND a run that checked nothing is refused instead of reported as clean.
 */
export const tscProjectTypecheck: BashSubstitutionPair = {
  id: 'typecheck.tsc-project',
  intentLabel: 'typecheck-a-project',
  bashPattern: new RegExp(
    `^${EXCLUDE_UNEXPRESSIBLE}${REQUIRE_NO_EMIT}(?:npx\\s+)?tsc` +
      `(?:\\s+(?:--noEmit|${NOOP_FLAGS}))*` +
      `\\s+(?:-p|--project)\\s+(?:${PROJECT_OPERAND})` +
      `(?:\\s+(?:--noEmit|${NOOP_FLAGS}))*${TRAILING_NOISE}$`,
  ),
  toolName: 'build:typecheck',
  advisoryText:
    'build:typecheck { project } returns { errorCount, errors:[{file,line,column,code,message}], byFile } — no `2>&1 | grep` over a compiler log. It also REFUSES a run that typechecked zero files (TS5057/TS5058/TS18003) instead of reporting a clean zero; `-p .` does exactly that here, since this repo has no root tsconfig.json.',
  routing: {
    want: 'to typecheck a project and see the errors',
    use: '`build:typecheck { project: "packages/operator-core" }`',
    insteadOf: '`npx tsc --noEmit -p <project> 2>&1 | grep …` (the tool refuses a run that checked ZERO files — `-p .` does that here, and a `grep` over its one-line error prints nothing, which reads as clean)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    return coverTypecheckCommand(parseTscAtom(atom));
  },
  /**
   * P-009 — the executable form of {@link expressionFor}, gated on `cover()`
   * exactly as the file-read and test families are: if this pair declines to
   * claim a command it declines to hand over a call for it, because a runnable
   * line is acted on before it is read.
   *
   * No `replayEnvelope`: `tsc`/`npx` are off REPLAYABLE_VERBS, so declaring a
   * rewrite enrols nothing in replay execution and D-060's hold on widening
   * that list is untouched. This feeds the advisory path only.
   */
  rewrite(atom: string): ReplayToolCall | null {
    const parsed = parseTscAtom(atom);
    if (!coverTypecheckCommand(parsed).covered) return null;
    if (!parsed.project) return null;
    const args: Record<string, unknown> = { project: parsed.project };
    if (parsed.incremental === true) args.incremental = true;
    return { toolName: 'build:typecheck', args };
  },
};

/** Every pair in the typecheck family, in registry order. */
export const TYPECHECK_PAIRS: BashSubstitutionPair[] = [tscProjectTypecheck];

/** Exported for the model-drift guard (D-015): the flags cover() treats as expressible. */
export const EXPRESSIBLE_FLAGS = ['--noEmit', '-p', '--project', '--incremental', '--pretty'] as const;
export { UNEXPRESSIBLE_OPTIONS, parseTscAtom, coverTypecheckCommand };
