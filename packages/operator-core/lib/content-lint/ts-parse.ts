/**
 * TypeScript PARSE detector — "does this file parse at all" (WI-6683). The
 * general form of the hard-parse-failure class `smart-quotes` already catches
 * one narrow instance of.
 *
 * WI-6683: two sibling projection modules were auto-committed to `staging` in a
 * state where TypeScript cannot PARSE them — a backtick inside a `--` SQL
 * comment that lives INSIDE a `sql` tagged template closed the template, so the
 * rest of each module parsed as garbage (TS1005 / TS1443). A parse error is not
 * a normal type error: it is not baselined, not local, and not attributable to
 * one call site — EVERY consumer of the package fails. Measured, not asserted:
 * repairing one of the two files took `packages/operator-core`'s tsc error count
 * from 231 to 184, and those ~47 were OTHER agents' files that could no longer
 * resolve anything through the broken module. For the whole window it sat
 * committed, no agent could typecheck their own work and the green-checkpoint
 * would red for the entire fleet on a defect none of them introduced.
 *
 * A narrow guard for that one spelling already existed
 * (`scripts/check-sql-comment-backtick.mjs`) and was GREEN the whole time the
 * break sat committed — nothing ran it on the path where the damage happens. A
 * guard that runs on no blocking path is not a guard. This detector states the
 * invariant at the altitude that actually holds: *a file that does not parse
 * must not reach the shared tree*, whatever the spelling of the mistake.
 *
 * SYNTACTIC ONLY. `ts.createSourceFile` is a pure parse — no type graph, no
 * program load, no module resolution, no disk, no network. It can therefore only
 * ever report "this text is not valid TypeScript", never a type error, so it can
 * never quarantine a file over an unresolved import, a missing dependency, or a
 * bad annotation. Measured at ~0.85ms/file across all 10,829 tracked .ts/.tsx
 * files in this repo with ZERO false positives on that corpus; git-sync only
 * checks the handful DIRTY on a given tick, so the real per-tick cost is noise.
 *
 * Deliberately mirrors `findCodePositionCurlyQuotes` in this directory, which
 * already performs this exact parse and reads the same `parseDiagnostics` — it
 * just discards every diagnostic that does not sit at a curly-quote offset.
 */
import ts from 'typescript';

/** A single TypeScript syntax error: 1-based source position + the parser's own reason. */
export interface TsParseError {
  line: number | null;
  col: number | null;
  /** The TS diagnostic code (e.g. 1005 for "';' expected"). */
  code: number;
  reason: string;
}

/**
 * The highest diagnostic code that is still SYNTACTIC/GRAMMAR rather than type-semantic.
 * TypeScript partitions its codes: 1xxx are syntax + grammar errors, 2xxx and above are
 * the type system (unresolved name, wrong annotation, missing property). Phase 2 below
 * runs the checker, so this bound is what keeps a TYPE error from ever quarantining a
 * file — the narrowness property this detector's whole safety argument rests on.
 */
const MAX_GRAMMAR_DIAGNOSTIC_CODE = 2000;

/**
 * Codes ABOVE that bound which esbuild nevertheless REFUSES TO BUNDLE — so a file carrying
 * one takes every bundling host down exactly like a syntax error, even though TypeScript
 * files it with the type system.
 *
 * WHY AN EXPLICIT SET AND NOT A HIGHER BOUND (EI-19457229906581679). The bound above is
 * this detector's whole safety argument: 2xxx is where "cannot find name", "wrong
 * annotation" and friends live, and quarantining on those would fire on ordinary work in
 * progress. Phase 2 also runs with `noLib: true`, so it ROUTINELY produces 2xxx noise of
 * its own (TS2318 "Cannot find global type 'Promise'", TS2584 "Cannot find name
 * 'console'") that must stay filtered. Raising the bound would admit all of it. Only an
 * enumerated set adds the file-breaking codes without any of that.
 *
 * TS2451 — "Cannot redeclare block-scoped variable 'x'". Measured 2026-08-10: an agent's
 * mid-edit duplicate `const startingAdvSessionId` in routes/adv/launch-su.ts failed
 * bundle-host.sh with `✘ [ERROR] The symbol "startingAdvSessionId" has already been
 * declared`, crash-looping papercup-staging-api until systemd's reconciler gave up and
 * :3170 was down fleet-wide. Phase 1 reported ZERO parse diagnostics (the grammar is
 * fine — a redeclaration is an ECMAScript EARLY error, not a parse error), and phase 2's
 * only signal was TS2451, filtered out for being ≥ 2000. The guard built for precisely
 * this outage class watched it happen a second time and said nothing.
 *
 * Membership test: does esbuild REFUSE the file? A duplicate TYPE alias also reports 2xxx
 * (TS2300) but is erased before emit and bundles fine — so it does NOT belong here. Verify
 * with esbuild before adding a code.
 */
const ESBUILD_FATAL_DIAGNOSTIC_CODES: ReadonlySet<number> = new Set([2451]);

/** True when a diagnostic breaks the FILE (syntax/grammar, or esbuild-fatal), rather than
 *  merely describing a type problem. */
function isFileBreakingDiagnostic(code: number): boolean {
  return code < MAX_GRAMMAR_DIAGNOSTIC_CODE || ESBUILD_FATAL_DIAGNOSTIC_CODES.has(code);
}

/**
 * Pure detector: the FIRST syntactic diagnostic in `text`, or null when the file
 * parses cleanly. Never throws on a syntax error (that is the expected result and
 * is returned); it throws only if the TS build cannot report parse diagnostics at
 * all — see below.
 *
 * TWO PHASES, because the parser alone is not enough (WI-37398):
 *
 *  1. `createSourceFile` + `parseDiagnostics` — the cheap pure parse (~0.85ms/file).
 *  2. Only when phase 1 is clean: TypeScript's GRAMMAR diagnostics, filtered to
 *     codes < 2000 (~6ms/file).
 *
 * Phase 2 exists because TypeScript's parser is deliberately ERROR-TOLERANT about
 * DUPLICATE MODIFIERS, and reports them from the checker instead. `export export
 * const X = 1` parses to a perfectly good AST carrying two `export` modifiers, so
 * phase 1 alone returns CLEAN — while esbuild rejects the file outright
 * (`Unexpected "export"`), taking down every consumer of the package.
 *
 * That is not hypothetical: on 2026-08-09T05:55Z git-sync swept exactly that line
 * into `packages/operator-core/lib/memory/corpus-recall-io.ts` at the shared tip —
 * the commit green-checkpoint cuts its candidate from — and BOTH surfaces that run
 * this check (the git-sync content guard and the PostToolUse edit-time nudge) said
 * clean. It surfaced only by coincidence, when :3170 happened to restart and its
 * esbuild pre-step crash-looped the service 6 times. A doubled keyword is the
 * classic bad-edit artifact (a replace that prepends a modifier to a line that
 * already has one), so it is precisely the shape an agent-edited tree produces.
 *
 * Measured over all 11,583 tracked .ts/.tsx files in this repo: ZERO files flagged
 * by phase 2 (no false positives), at 6.18ms/file. Both callers check only a tiny
 * set — git-sync the files DIRTY on a tick, the hook the ONE file just edited — so
 * the real per-invocation cost is noise. The `< 2000` filter is what makes it safe:
 * an unresolved import, a missing lib, or a wrong annotation are all 2xxx+ and are
 * dropped, so phase 2 can no more quarantine a merely-untypecheckable file than
 * phase 1 could.
 */
export function findTsParseError(fileName: string, text: string): TsParseError | null {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKind);
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  // `parseDiagnostics` is an internal property (the same one smart-quotes reads).
  // If a TypeScript upgrade ever removes it, FAIL LOUD rather than return null for
  // everything: a check that can only answer "clean" is precisely the silent
  // non-guard this work item exists to remove. The content guard fails open on a
  // throwing detector, so the fleet's commit is never wedged — the operator log
  // records that this check went dark, which is the outcome we want to be noisy.
  if (diags === undefined) {
    throw new Error(
      'ts-parse: SourceFile.parseDiagnostics is unavailable in this TypeScript build — the parse check cannot run',
    );
  }
  const first = diags[0];
  if (first) return toParseError(sf, first);
  // Phase 2 — the parser accepted it; ask the grammar checks too.
  return findTsGrammarError(fileName, text, scriptKind);
}

/**
 * The grammar half of the check: build a single-file Program with NO lib and NO
 * module resolution, then keep only sub-2000 diagnostics. `noLib`/`noResolve` mean
 * nothing is read from disk and no dependency graph is loaded, so this stays as
 * self-contained as the pure parse — it is the CHECKER we need, not a type graph.
 *
 * Returns null on any internal failure: phase 1 has already run and answered, so a
 * checker that cannot complete must not turn a clean parse into a quarantine.
 */
function findTsGrammarError(fileName: string, text: string, scriptKind: ts.ScriptKind): TsParseError | null {
  let sf: ts.SourceFile;
  let diagnostics: readonly ts.Diagnostic[];
  try {
    // Grammar checks read node.parent, so this parse needs parent pointers.
    sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);
    const host: ts.CompilerHost = {
      getSourceFile: (name) => (name === fileName ? sf : undefined),
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => {},
      getCurrentDirectory: () => '',
      getDirectories: () => [],
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (name) => name === fileName,
      readFile: (name) => (name === fileName ? text : undefined),
    };
    // NestJS and other legacy-decorator consumers are valid TypeScript, but
    // parameter decorators produce TS1206 unless this syntax mode is enabled.
    // Keep the checker isolated (no lib/module resolution) while accepting the
    // decorator syntax used by the projects this guard protects.
    const program = ts.createProgram(
      [fileName],
      {
        noResolve: true,
        noLib: true,
        experimentalDecorators: true,
        // MODULE + TARGET ARE PART OF THE SAFETY ARGUMENT, not incidental setup.
        // TypeScript reports several sub-2000 GRAMMAR codes purely as a function of
        // these two options, so a mismatch here MANUFACTURES file-breaking diagnostics
        // on files that are perfectly valid under the project's real tsconfig.
        //
        // `preserve` is the only kind satisfying all three constraints at once:
        //   · `import x = require("x")` stays legal (TS1202) — without an explicit
        //     module kind TypeScript 6 resolves `ModuleKind.None` and rejects it.
        //   · top-level `await` stays legal (TS1378).
        //   · `import.meta` stays legal (TS1343).
        // `commonjs` satisfies only the first, `esnext` only the last two, and
        // `nodenext` trades TS1343 for TS1470. The explicit ES2022 target is required
        // ALONGSIDE it because TS1378 tests `target >= ES2017` independently: a program
        // built without one defaults to ES5. (The `createSourceFile` ScriptTarget above
        // sets the PARSE target, not `compilerOptions.target`, which is what the grammar
        // checks read.) Both match the repo's own tsconfigs — module ESNext, target ES2022.
        //
        // EI-22372621599811236: `module: CommonJS` with no target quarantined 1,529 of
        // 15,377 tracked files (627 TS1378 + 902 TS1343) — ~10% of the repo, every one
        // of them valid — because git-sync EXCLUDES a flagged file from the auto-commit.
        // Change either option only with a both-directions re-run of ts-parse.test.ts:
        // no new flags on valid modern syntax, AND the real breakage cases still caught.
        module: ts.ModuleKind.Preserve,
        target: ts.ScriptTarget.ES2022,
      },
      host,
    );
    diagnostics = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  } catch {
    return null;
  }
  let earliest: ts.Diagnostic | undefined;
  for (const d of diagnostics) {
    if (!isFileBreakingDiagnostic(d.code)) continue; // a TYPE error — never ours to flag
    if (!earliest || (d.start ?? 0) < (earliest.start ?? 0)) earliest = d;
  }
  return earliest ? toParseError(sf, earliest) : null;
}

/** Render a diagnostic as the 1-based position + the compiler's own reason. */
function toParseError(sf: ts.SourceFile, d: ts.Diagnostic): TsParseError {
  const pos = typeof d.start === 'number' ? sf.getLineAndCharacterOfPosition(d.start) : null;
  return {
    line: pos ? pos.line + 1 : null,
    col: pos ? pos.character + 1 : null,
    code: d.code,
    reason: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  };
}
