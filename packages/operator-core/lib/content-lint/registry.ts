/**
 * The content-detector REGISTRY (git-sync-content-guard-2026-06-13 P-003).
 *
 * One list of `{ key, glob, matches, detect, fixerRole }` consumed by the
 * git-sync content guard (run-git-sync.ts) — and extensible: a future content
 * check rides this same mechanism by adding one entry, no guard change.
 *
 * Each detector wraps a PURE detector function (the same one the CI lint scripts
 * call — D-003) and normalises its result to a single human-readable error
 * string (fed to the escalation + the content-fixer agent) or null when valid.
 * The `matches` predicate mirrors each CI lint's EXACT scope so the guard never
 * quarantines a file the lint wouldn't flag (and vice-versa).
 */
import { findMdxCompileError, autoFixMdxAngles } from './mdx';
import { findCodePositionCurlyQuotes, curlyLabel } from './smart-quotes';
import { findShellSyntaxError } from './shell-syntax';
import { findConflictMarker } from './conflict-markers';
import { findTsParseError } from './ts-parse';
import { findEsbuildTransformError } from './esbuild-transform';
import { findNulBytes, autoFixNulBytes, nulByteScopeMatches } from './nul-bytes';
import { findConstantConditional } from './constant-conditional';
import { findFocusedTest } from './focused-test';
import {
  findSqlCommentBacktick,
  sqlCommentBacktickScopeMatches,
  autoFixSqlCommentBacktick,
} from './sql-comment-backtick';
import {
  findCommitBlockingSecrets,
  describeCommitBlockingSecrets,
  cachedExemptionLoader,
  defaultExemptionLoader,
  type ExemptionLoader,
} from './secrets';
import { findIdentityLeakError, identityLeakScopeMatches } from './identity-leak';

/**
 * The registry's shared runtime-exemption reader for the `secrets` detector.
 *
 * Module-scoped ON PURPOSE so a tick that scans hundreds of dirty files pays one
 * database read rather than one per file, and so the TTL is measured across the
 * whole tick. `setContentLintExemptionLoader` is the test seam — production never
 * calls it, which is why the default is installed here rather than injected.
 */
let contentLintExemptions: ExemptionLoader = cachedExemptionLoader(defaultExemptionLoader);

/** Read the current runtime secrets-guard path exemptions (cached). */
export const loadContentLintExemptions: ExemptionLoader = () => contentLintExemptions();

/** Replace the exemption reader (tests only). Pass nothing to restore the default. */
export function setContentLintExemptionLoader(loader?: ExemptionLoader): void {
  contentLintExemptions = loader ?? cachedExemptionLoader(defaultExemptionLoader);
}

/** Context available when a detector runs against a concrete repository checkout. */
export interface ContentDetectorContext {
  /**
   * Physical repository checkout whose working-tree content is being checked.
   *
   * Most detectors are repository-independent, but detectors whose rules are
   * source files in the checked tree must resolve those files from this path
   * rather than from the operator bundle's checkout.
   */
  repoPath?: string;
}

/** A registered content check. */
export interface ContentDetector {
  /** Stable key — recorded on offender records + escalation bodies (e.g. 'mdx'). */
  key: string;
  /** The glob the detector targets, for registry display / docs (the authoritative
   *  scope is `matches`, which also encodes the lint's prefix + exclusions). */
  glob: string;
  /** Whether this detector applies to a repo-relative path — mirrors the CI lint's
   *  EXACT scope so the guard + CI never disagree (D-003). */
  matches: (file: string, context?: ContentDetectorContext) => boolean | Promise<boolean>;
  /** Run the check on the file's text. Returns a human-readable error string when
   *  the file is broken, or null when it is valid. May be async (MDX compiles). */
  detect: (
    file: string,
    text: string,
    context?: ContentDetectorContext,
  ) => Promise<string | null> | string | null;
  /** The agent role git-sync dispatches to fix this class of content error. */
  fixerRole: string;
  /**
   * Optional DETERMINISTIC repair (WI-276), applied by the git-sync content guard
   * as a pre-pass BEFORE quarantining + dispatching the LLM `fixerRole`. The guard
   * invokes it ONLY on a file that already failed `detect`, then RE-RUNS `detect`
   * on the result: if the repair makes the file clean it is written back so it
   * commits on this tick (no LLM, no human, no 5-tick build block); if it does not
   * fully resolve the error the file is quarantined for the LLM fixer exactly as
   * before. Must be PURE + idempotent (given the same text twice it returns the
   * same fix). Omit for detectors with no safe deterministic repair (smart-quotes).
   */
  /** Deterministic repair. `file` is the repo-relative path, threaded through because a
   *  repair can be path-sensitive (sql-comment-backtick's template host tokenizes `.tsx`
   *  differently from `.ts`). Optional so detectors that ignore it need no signature. */
  autoFix?: (text: string, file: string) => { fixed: string; changed: boolean };
  /**
   * Optional REPO SCOPE (EI-19381677675617429). git-sync sweeps the superproject AND
   * every submodule with this same detector list, and `matches` only ever receives a
   * path relative to whichever repo is being guarded — so a detector cannot tell the
   * two apart on its own. Declaring `'superproject-only'` makes the content guard skip
   * this detector entirely inside a submodule.
   *
   * Needed by any rule whose CI lint is deliberately superproject-only. The identity
   * lints are: 45 submodule files carry identity literals BY DESIGN (redacted at tar
   * time by bin/stage-source-tree.sh), so an unscoped identity detector would quarantine
   * all 45 from every submodule commit. Omit for a detector that applies everywhere
   * (mdx, smart-quotes, secrets, …) — that stays the default.
   */
  repoScope?: 'superproject-only';
}

/** Shared exclusions — retired trees, vendored code, build output (mirror the lint scripts).
 *  Exported so sibling git-sync checks (e.g. the deletion-import guard, EI-17) can reuse the
 *  SAME exclusion set instead of a drifting duplicate. */
export const isExcludedPath = (f: string): boolean =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/');

/** The astro-built docs set — exactly what `astro build` compiles (mirror check-mdx.mjs). */
const DOCS_PREFIX = 'apps/operator-docs/src/content/docs/';

export const CONTENT_FIXER_ROLE = 'content-fixer';

/** The MDX compile detector — scoped to the astro-built docs set (check-mdx.mjs). */
export const mdxDetector: ContentDetector = {
  key: 'mdx',
  glob: `${DOCS_PREFIX}**/*.mdx`,
  matches: (f) => f.endsWith('.mdx') && f.startsWith(DOCS_PREFIX) && !isExcludedPath(f),
  detect: async (file, text) => {
    const hit = await findMdxCompileError(file, text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'unknown position';
    return `MDX compile error at ${at}: ${hit.reason}`;
  },
  fixerRole: CONTENT_FIXER_ROLE,
  // WI-276: the deterministic pre-pass — escape a bare `<`+digit / `<word>` placeholder
  // (the single most common MDX offender) so the guard auto-repairs + commits it this tick
  // instead of quarantining it for 5 ticks. Applied only to an already-failing file, then
  // the guard re-runs `detect`; anything still broken falls through to the LLM fixer.
  autoFix: autoFixMdxAngles,
};

/** The curly-quote-as-code detector — tracked .ts/.tsx (check-smart-quotes.mjs). */
export const smartQuotesDetector: ContentDetector = {
  key: 'smart-quotes',
  glob: '**/*.{ts,tsx}',
  matches: (f) => /\.(ts|tsx)$/.test(f) && !isExcludedPath(f),
  detect: (file, text) => {
    const hits = findCodePositionCurlyQuotes(file, text);
    if (hits.length === 0) return null;
    return (
      'curly/smart quote used as code (hard esbuild/tsc parse failure): ' +
      hits.map((h) => `${h.line}:${h.col} [${curlyLabel(h.ch)}]`).join('; ')
    );
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The TypeScript PARSE detector — tracked .ts/.tsx (WI-6683). The GENERAL form of
 * the hard-parse-failure class `smart-quotes` above catches one narrow instance
 * of: a curly quote in code position is only one way to stop a file parsing, and
 * the invariant worth enforcing at this seam is the general one — *a file that
 * does not parse must not reach the shared tree*.
 *
 * Earned by two live instances on 2026-08-01: sibling projection modules were
 * auto-committed with a backtick inside a SQL comment inside a `sql` template,
 * which closed the template and left the rest of each module unparseable. Unlike
 * a type error that is baselined and local, a PARSE error takes down every
 * consumer of the package — repairing one file moved operator-core's tsc count
 * 231 → 184, those ~47 being other agents' files that could no longer resolve
 * through it. A narrow lint for that exact spelling already existed and was green
 * throughout, because nothing ran it on the path where the damage happens.
 *
 * SYNTACTIC ONLY (see ts-parse.ts): a pure `createSourceFile` parse, so it can
 * never flag a type error, an unresolved import, or a missing dependency. Runs at
 * ~0.85ms/file with zero false positives over all 10,829 tracked .ts/.tsx files
 * in this repo. No `autoFix` — like shell-syntax and conflict-markers, a parse
 * break needs a human/LLM to decide the intended code; the goal here is
 * quarantine-before-commit, not guessing at someone's unfinished edit.
 */
/**
 * EI-20089601803883232: `.mts`/`.cts` are INCLUDED. They were not, and the two halves of
 * this same guard disagreed about which files exist — the PostToolUse sibling
 * (`posttooluse-ts-parse-nudge.mjs`) has always used `/\.(ts|tsx|mts|cts)$/`, while this
 * commit-path detector stopped at `.ts|.tsx`. The narrower half is the one that
 * quarantines, so an unparseable `.mts` committed clean: found live in
 * `apps/operator/lib/release/test-e2e-generation.mts`, which carried ten `\!` shell-escape
 * artifacts (TS1127 "Invalid character") in the committed tree. `.mts` is executed by tsx
 * on the RELEASE path, so it breaks exactly like a `.ts` file does.
 *
 * Widening measured before landing: 52 tracked `.mts`/`.cts` files, of which exactly one
 * was unparseable (a 9-day-abandoned scratchpad probe with a trailing comma) — fixed in
 * the same change, so this adds coverage without newly quarantining anything.
 */
export const tsParseDetector: ContentDetector = {
  key: 'ts-parse',
  glob: '**/*.{ts,tsx,mts,cts}',
  matches: (f) => /\.(ts|tsx|mts|cts)$/.test(f) && !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findTsParseError(file, text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'unknown position';
    return (
      `TypeScript parse error at ${at} (TS${hit.code}): ${hit.reason} — the file does not PARSE, ` +
      'so every consumer of this package hard-fails to typecheck, not just this file'
    );
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The esbuild TRANSFORM detector — source files that TypeScript accepts but
 * the bundle host rejects (EI-5240). A TypeScript-only parse/check is not
 * enough here: esbuild reports hard failures for duplicate declarations,
 * duplicate modifiers, and other ECMAScript transform errors that can survive
 * the TypeScript diagnostics used by `ts-parse`.
 *
 * Esbuild is loaded lazily by the pure helper, keeping registry import safe in
 * hosts without its optional runtime installation; a loader failure propagates
 * and the content guard's existing fail-open path logs and skips the detector.
 */
/**
 * TypeScript DECLARATION files (`.d.ts` / `.d.mts` / `.d.cts`). They end in `.ts`/`.mts`/
 * `.cts`, so any suffix test written for source files matches them too.
 *
 * WI-481326: that is not cosmetic for {@link esbuildTransformDetector}. A declaration file's
 * whole job is to declare types WITHOUT values — `export const X: number;` is the correct and
 * only syntax there — but transformed as a source module that is illegal, and esbuild says so:
 * `The constant "X" must be initialized`. So every declaration file exporting a
 * non-literal-typed const failed this detector and was quarantined (excluded from every
 * auto-commit) FOREVER: there is nothing for the content-fixer to repair, so it burned through
 * MAX_CONTENT_FIXER_ATTEMPTS against a correct file and escalated needs_human. Measured on
 * papercusp 2026-08-28: `scripts/lib/governed-test-process.d.mts` and
 * `apps/operator/scripts/ptool.d.mts` stranded 62 consecutive ticks while the routine's own
 * `last_status` still read 'synced'.
 *
 * Excluding them costs no coverage: this detector's purpose is source files the BUNDLE HOST
 * rejects, and a declaration file carries no runtime code and is never bundled. `ts-parse`
 * still covers them — TypeScript parses declaration files by design.
 */
const DECLARATION_FILE_RE = /\.d\.(ts|mts|cts)$/;

export const esbuildTransformDetector: ContentDetector = {
  key: 'esbuild-transform',
  glob: '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
  matches: (f) =>
    /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f) &&
    !DECLARATION_FILE_RE.test(f) &&
    !isExcludedPath(f),
  detect: async (file, text) => {
    const hit = await findEsbuildTransformError(file, text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'unknown position';
    return `esbuild transform error at ${at}: ${hit.reason}`;
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The SQL-comment-backtick detector — non-test .ts/.tsx/.mjs carrying SQL
 * (EI-7661 / EI-19317789732905891 / EI-19415157731625374).
 *
 * Registered immediately BEFORE `ts-parse` for the same reason `smart-quotes`
 * is: a file with a backtick-quoted identifier inside a SQL comment usually
 * trips BOTH, and this one names the actual mistake while ts-parse reports the
 * parser's first confusion — which lands tens of lines away, at the template's
 * intended closing backtick. `excludePaths` dedupes by path, so the file is
 * quarantined once, with the more actionable message recorded.
 *
 * It is not merely a nicer message, though. It is the ONLY detector here that
 * can see the SILENT form of this bug: inside a postgres-js tagged template the
 * text after the stray backtick can still parse as valid TS, so the file
 * compiles, ships, and RUNS with the query truncated mid-comment. On 2026-07-05
 * that amputated the WHERE clause from the mig-504 LWW upserts — the apply-guard
 * vanished and stale writes applied unconditionally, caught only because an
 * unrelated unit test regressed. ts-parse is structurally blind to it: the file
 * parses.
 *
 * A narrow script for this class already existed (`scripts/check-sql-comment-backtick.mjs`)
 * and ran on NO blocking path — the condition WI-6683 already ruled on. It had
 * also silently ROTTED there: at the time this entry was written that script was
 * RED, on `registry.ts` itself, on a false positive. Both of its FP mechanisms
 * are fixed in the pure predicate (a >=2-backtick rule, and a scope gate that no
 * longer mistakes prose ABOUT SQL for SQL); the script now imports that same
 * predicate, so the two cannot drift.
 *
 * CARRIES an `autoFix` (EI-19493869861442174). This entry long read "No autoFix —
 * rephrasing a comment without its backticks is an authoring choice ... and the file
 * may also be mid-edit". Both halves were answered by the 2026-08-04 incident:
 * `detect` itself already MAKES the authoring choice it deferred ("use straight
 * quotes"), and the LLM fixer, when it finally ran, produced exactly that — after
 * ~76min with :3170 down fleet-wide and a peer's fix stranded in quarantine. The
 * mid-edit worry is handled a layer up, by the guard's CAS-guarded write. Keeping
 * the repair manual bought no safety and cost an outage.
 */
export const sqlCommentBacktickDetector: ContentDetector = {
  key: 'sql-comment-backtick',
  glob: '**/*.{ts,tsx,mjs}',
  matches: (f) => sqlCommentBacktickScopeMatches(f) && !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findSqlCommentBacktick(file, text);
    if (!hit) return null;
    if (hit.host === 'template') {
      return (
        `backtick-quoted identifier inside a // comment INSIDE a template literal at ` +
        `line ${hit.line}:${hit.col} — \`${hit.text}\`. That backtick ENDS the enclosing ` +
        'template, so everything after it is reparsed as real code and the file stops ' +
        'parsing. The reported error lands wherever the parser first gives up, which is ' +
        'why this reads as a missing semicolon on a COMMENT line (EI-21219437374882016: ' +
        '`Expected ";" but found "inputs"`, on a comment, in a worker-source template). ' +
        'Fix: escape them — \\` — which is what the rest of the same template already does.'
      );
    }
    return (
      `backtick-quoted identifier inside a SQL comment at line ${hit.line}:${hit.col} — ` +
      `\`${hit.text}\`. That backtick ENDS the enclosing template literal. ` +
      'If the template is a postgres-js tag, the rest may still parse as valid TS, so the file ' +
      'compiles and RUNS with the SQL truncated mid-comment (this is how the mig-504 LWW ' +
      'apply-guard silently vanished); if it is a plain DDL template it is a TS1005 cascade ' +
      "anchored tens of lines away, at the template's intended closing backtick. " +
      'Fix: rephrase the comment without backticks — use straight quotes, e.g. ' +
      'a comment reading "the \'closed_ts\' column" rather than backtick-quoting the name.'
    );
  },
  autoFix: autoFixSqlCommentBacktick,
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The shell syntax detector — tracked `.sh` scripts (EI-13192). A real `bash -n`
 * parse, not a regex heuristic — catches a corrupted/truncated shell script (a
 * concurrent shared-tree edit interleave duplicated ~475 lines of one and
 * git-sync committed it before anyone ran `bash -n` by hand) BEFORE it ever
 * reaches `staging`, the same way the mdx/smart-quotes detectors already catch
 * their own hard-parse-failure classes. No deterministic `autoFix` — a
 * corrupted script needs a human/LLM to decide which duplicated block is
 * correct, so this always quarantines + dispatches the content-fixer.
 */
export const shellSyntaxDetector: ContentDetector = {
  key: 'shell-syntax',
  glob: '**/*.sh',
  matches: (f) => f.endsWith('.sh') && !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findShellSyntaxError(text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}` : 'unknown position';
    return `bash -n syntax error at ${at}: ${hit.reason}`;
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The committed-conflict-marker detector (EI-1836 / EI-18217568076594579) — a
 * COMMITTED git conflict marker (`<<<<<<<`, `>>>>>>>`, `|||||||` at line start)
 * is a hard, language-agnostic build breaker (a stray "Stashed" token froze the
 * whole fleet's SPA + desktop-sidecar + green-checkpoint builds for ~27min, twice).
 * Scoped to EVERY tracked file (mirrors check-conflict-markers.mjs's tree-wide
 * scan) rather than one extension, since a conflict marker can land in any file
 * type. No `autoFix` — like shell-syntax, a real conflict needs a human/LLM to
 * pick the correct side; the goal here is quarantine-before-commit, not silent
 * auto-resolution of someone's merge.
 */
export const conflictMarkersDetector: ContentDetector = {
  key: 'conflict-markers',
  glob: '**/*',
  matches: (f) => !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findConflictMarker(file, text);
    if (!hit) return null;
    return `committed git conflict marker at line ${hit.line} (${hit.marker.slice(0, 1)}×7): ${hit.text.slice(0, 80)}`;
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The raw-NUL-byte detector (EI-19393386475030577) — tracked text sources
 * (check-no-nul-in-source.mjs + app/_lints/no-nul-bytes.test.ts).
 *
 * The check already existed and was already tree-wide; its only FIRING POINT was
 * the green-checkpoint suite, ~55min downstream, which converts one author's
 * typo into a fleet-wide gate red every time (measured 2026-08-03: ~1h of the
 * whole fleet blocked, six prior instances in the class header). Registering it
 * here moves detection onto the path every edit takes, ~3min after the write.
 *
 * ⚠ Deliberately does NOT apply `isExcludedPath`, unlike every sibling above.
 * Both the CI script and the gate lint scan `_retired/` (their scope is
 * `git ls-files --recurse-submodules` filtered by extension + fixture dirs, with
 * no retired-tree exclusion). Excluding it here would let a NUL under
 * `_retired/` slip past the guard and still red the shared gate — the exact
 * failure this entry exists to prevent. `matches` mirrors the lint's scope, and
 * that scope is the authority (D-003); node_modules/dist need no exclusion
 * because the guard only ever sees `git status` paths, which are gitignored.
 *
 * Carries an `autoFix` (unlike ts-parse/shell-syntax) because the repair is a
 * pure re-spelling with no semantic choice: `\x00` and a raw NUL are the
 * byte-identical runtime string. It must auto-repair, because this is the one
 * class the agent Edit tool cannot fix — Read renders a NUL as a space, so
 * `old_string` never matches and instances sit unrepaired.
 */
export const nulBytesDetector: ContentDetector = {
  key: 'nul-bytes',
  glob: '**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,mdx,css,sql,sh,yml,yaml,toml}',
  matches: nulByteScopeMatches,
  detect: (file, text) => {
    const hit = findNulBytes(text);
    if (!hit) return null;
    const plural = hit.lines.length === 1 ? '' : 's';
    return (
      `literal NUL byte (0x00) ×${hit.count} at line${plural} ${hit.lines.join(', ')} — ` +
      'makes file(1) report this valid UTF-8 source as BINARY and makes grep refuse to search it, ' +
      'while tsc/esbuild still compile it (so it is invisible until the shared gate reds). ' +
      'Almost always a composite map key: write `${a}\\x00${b}` (escape) instead of a raw NUL byte.'
    );
  },
  fixerRole: CONTENT_FIXER_ROLE,
  autoFix: autoFixNulBytes,
};

/**
 * The constant-forced `if` detector — tracked .ts/.tsx (EI-19446174755157221).
 *
 * The one detector here that guards against an UNFINISHED edit rather than an
 * INVALID one: `if (false && …)` parses, compiles, and looks deliberate. It is
 * registered at this seam because that is the only place it can help. On
 * 2026-08-03 an agent flipped a branch off for ~90 seconds to prove a new
 * exemption had teeth and git-sync's whole-tree sweep committed the experiment
 * mid-flight — putting 7 TS18047 errors on a file whose baseline was 0, i.e. a
 * committed standing red for the whole fleet, while also silently reverting a
 * load-bearing behaviour (the veto that stops `stalled-loops-guard` disarming a
 * loop merely backed off behind a provider wall). The author's own conclusion
 * generalises past the typo: *on an auto-committing tree there is no safe
 * temporary source mutation*. A CI lint cannot deliver that — by the time it
 * runs the mutation is already shared — so the check belongs on the commit path.
 *
 * The leading literal is not merely dead weight: in first position of an `&&`
 * chain it SUPPRESSES the narrowing the later operands perform, so
 * `if (false && wall && wall.x)` makes every `wall` dereference "possibly null"
 * inside a provably unreachable block. That is why a "harmless" disable reds a
 * clean file, and why the failure is invisible to its author.
 *
 * Narrow by construction (see constant-conditional.ts): `IfStatement` only, so
 * `while (true)` / `for (;;)` are never inspected; and only a literal
 * `true`/`false` TOKEN, so a named gate (`if (ENABLED && …)`) — the recommended
 * way to disable a branch, and the fix the author themselves prescribed — stays
 * clean. AST-based, so a `false` inside a comment or string cannot false-fire.
 * Measured ZERO hits across every tracked .ts/.tsx in this repo, so the baseline
 * is empty and no file needs allowlisting.
 *
 * No `autoFix`, like ts-parse/shell-syntax/conflict-markers: whether a disabled
 * branch should be re-enabled or deleted is a semantic choice only its author
 * can make, so this quarantines rather than guesses at an unfinished edit.
 */
export const constantConditionalDetector: ContentDetector = {
  key: 'constant-conditional',
  glob: '**/*.{ts,tsx}',
  matches: (f) => /\.(ts|tsx)$/.test(f) && !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findConstantConditional(file, text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'unknown position';
    const forced = hit.operator ? `${hit.constant} ${hit.operator} …` : hit.constant;
    const effect =
      hit.constant === 'false'
        ? 'the branch can never run'
        : 'the branch always runs and the real condition is ignored';
    return (
      `constant-forced if at ${at}: \`if (${forced})\` — ${effect}. ` +
      `Condition reads: \`${hit.text}\`. ` +
      'This is almost always a temporary local disable, and git-sync commits the whole tree ' +
      'every few minutes, so it reaches `staging` mid-experiment. A leading literal also ' +
      'suppresses `&&` narrowing, turning a clean file into a committed tsc red. ' +
      'Delete the branch if it is dead, or gate it on a NAMED constant/flag if it is temporary. ' +
      'If you are running a DIFFERENTIAL ("does this still misbehave with the guard off?"), ' +
      'the source edit is avoidable entirely: lift the logic into a pure function and drive ' +
      'both arms from a test. On an auto-committing tree that is the only version of the ' +
      'experiment that cannot be committed half-finished.'
    );
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The focused-test (`.only`) detector — tracked test/spec files (EI-19447067535467975).
 *
 * `constant-conditional`'s sibling, from the same incident and the same root
 * cause: on an auto-committing tree there is no safe temporary source mutation.
 * That one catches a disabled BRANCH; this one catches a disabled FILE.
 *
 * It is the more dangerous of the two despite being the smaller edit, because a
 * committed `.only` fails nothing: vitest runs the focused test, skips every
 * other test in the file, and exits 0. The suite reports PASSED. So this defect
 * forges the exact signal an agent uses to decide the work is done, which is
 * why it belongs on the commit path — by the time a later check runs, the false
 * green has already been believed and acted on. Measured before writing it:
 * `allowOnly` is configured nowhere in the repo (so vitest narrows silently
 * rather than failing), and ZERO tracked test files contain `.only`, so the
 * baseline is empty and nothing needs allowlisting.
 *
 * `.skip` is deliberately NOT flagged — a measured decision, not an oversight.
 * 50 tracked test files use it as this repo's quarantine idiom, and a skipped
 * test announces itself as skipped in every run's output, so it is visible
 * rather than silent. The two patterns were filed together in the originating
 * item and are not the same shape: only `.only` has the silent-green property.
 *
 * Precision comes from requiring BOTH a test/spec filename AND a `.only` that
 * resolves back through any call/property chain to a known test global, so
 * `describe.each([…]).only` and `test.describe.only` match while `options.only`
 * never does. AST-based, so `.only` in a comment or string cannot false-fire.
 *
 * No `autoFix`: stripping `.only` is one character but not a safe automatic
 * edit — the focused test may be the only one currently passing, and silently
 * re-enabling its siblings mid-sweep hands back a red with no explanation.
 */
export const focusedTestDetector: ContentDetector = {
  key: 'focused-test',
  glob: '**/*.{test,spec}.{ts,tsx}',
  matches: (f) => /\.(test|spec)\.(ts|tsx)$/.test(f) && !isExcludedPath(f),
  detect: (file, text) => {
    const hit = findFocusedTest(file, text);
    if (!hit) return null;
    const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'unknown position';
    return (
      `focused test at ${at}: \`${hit.text}\` — every OTHER test in this file is silently skipped. ` +
      'Vitest still exits 0, so the suite reports PASSED: this turns a green run into no evidence at all. ' +
      'This is almost always a local debug focus, and git-sync commits the whole tree every few minutes, ' +
      'so it reaches `staging` mid-experiment and the next agent trusts the green. ' +
      `Remove the \`.only\` (\`${hit.root}.only\` → \`${hit.root}\`). ` +
      'To run ONE test without editing tracked source, pass the file and a name filter on the command ' +
      'line instead: `npm run test:file -- <path> -- -t "<test name>"`. On an auto-committing tree that ' +
      'is the only version of the experiment that cannot be committed half-finished.'
    );
  },
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The COMMIT-TIME secrets detector (EI-21230011589307899) — the ONE detector here
 * whose miss is not recoverable by a later commit.
 *
 * Every other detector in this registry guards a BUILD: a miss ships a broken
 * file and the fix is another commit. This one guards git HISTORY. A
 * credential-shaped blob that lands in a commit freezes this pot's p2p egress
 * permanently — pot-git's own-head publish guard re-scans `(baseline, head]`,
 * its baseline never advances past a refused range, and editing the file
 * afterwards does not remove the earlier blob. Only a path exemption clears it.
 * Three instances in four days; the last froze egress ~51min with 55 commits
 * queued behind it.
 *
 * The write-time PreToolUse secrets hook already covers Edit/Write, and is
 * sound. It does NOT cover Bash — `sed -i`, a heredoc, a `>` redirect — which is
 * exactly the path the stock Claude Code bypass-mode preamble steers agents onto.
 * Scanning the working tree HERE is write-path-agnostic, so it closes the gap
 * however the bytes arrived. See ./secrets.ts for the full rationale, the
 * rejected alternative (widening the hook matcher), and the exemption layering.
 *
 * SCOPE is deliberately the whole tracked tree rather than a suffix set: a
 * credential shape is not a property of a file TYPE, and the historical
 * instances were a .test.ts, a .mjs hook and a test harness — no suffix filter
 * would have caught all three. `scanTextForSecrets` skips >4096-char lines, so
 * minified/one-line blobs cost nothing.
 */
export const secretsDetector: ContentDetector = {
  key: 'secrets',
  glob: '**/*',
  matches: (f) => !isExcludedPath(f),
  detect: async (file, text) => {
    const findings = findCommitBlockingSecrets(file, text, await loadContentLintExemptions());
    if (findings.length === 0) return null;
    return describeCommitBlockingSecrets(file, findings);
  },
  // The same role the other detectors dispatch to. The remedy for the overwhelming
  // majority case — a credential STAND-IN in a test — is a rename to a low-entropy
  // role-named constant, which is ordinary content-fixer work, and the error string
  // names that remedy BEFORE the exemption path on purpose. Deliberately NO
  // `autoFix`: a deterministic rewrite of something that looks like a credential is
  // exactly the repair that must be read by someone before it is applied.
  fixerRole: CONTENT_FIXER_ROLE,
};

/**
 * The default registry the git-sync content guard runs with. Extend by adding an
 * entry (a new `{ key, glob, matches, detect, fixerRole }`); the guard + escalation
 * + fixer dispatch pick it up with no further change.
 */
/**
 * The identity-leak detector (EI-19381677675617429) — the route-independent half of a
 * rule that already had an edit-time advisory. That advisory only ever fires on
 * Edit/Write/MultiEdit, so a unit `cp`'d in from the host bypassed it entirely and was
 * committed 4m39s before its fix. This one sees the dirty set however it was written.
 *
 * SUPERPROJECT-ONLY (see `repoScope`): 45 submodule files carry identity literals by
 * design and are redacted at tar time, so enforcing there would quarantine all of them.
 *
 * No `autoFix`: unlike the MDX/NUL repairs there is no single safe substitution — the
 * correct fix is context-dependent (`%h` in a systemd unit, `"$HOME"` in shell,
 * `os.homedir()` in node, a redacted `<user>` in a doc or fixture), so this quarantines
 * for the fixer rather than guessing, exactly as smart-quotes does.
 */
export const identityLeakDetector: ContentDetector = {
  key: 'identity-leak',
  glob: '**/*',
  matches: (file, context) => identityLeakScopeMatches(file, context?.repoPath),
  detect: (file, text, context) => findIdentityLeakError(file, text, context?.repoPath),
  fixerRole: CONTENT_FIXER_ROLE,
  repoScope: 'superproject-only',
};

export const DEFAULT_CONTENT_DETECTORS: ContentDetector[] = [
  // Ordered FIRST: a file carrying a credential shape is the one offence here whose
  // cost is unbounded and unrecoverable (a permanent egress freeze) rather than a
  // broken build, so when a file trips several detectors this is the message that
  // gets recorded and escalated first.
  secretsDetector,
  identityLeakDetector,
  mdxDetector,
  smartQuotesDetector,
  nulBytesDetector,
  // Ordered AFTER smart-quotes deliberately: a curly-quote-as-code file trips both
  // (it is a parse error), and smart-quotes names the exact offending character —
  // the more actionable message, recorded first. Both offenders point at the same
  // file and `excludePaths` dedupes by path, so the file is quarantined once.
  //
  // Ordered BEFORE ts-parse for that same reason: a backtick in a SQL comment is
  // a parse error whose generic diagnostic points tens of lines from the cause,
  // so the specific detector must record first. It also catches the SILENT form,
  // which ts-parse cannot see at all (the file parses).
  sqlCommentBacktickDetector,
  esbuildTransformDetector,
  tsParseDetector,
  shellSyntaxDetector,
  conflictMarkersDetector,
  // Ordered AFTER ts-parse for the same reason: a file that does not parse cannot
  // be meaningfully inspected for a forced branch, and findConstantConditional
  // deliberately reports clean on one so the same break is never quarantined twice.
  constantConditionalDetector,
  // Ordered AFTER ts-parse for the same reason as constant-conditional, and
  // adjacent to it because they are the same class: an UNFINISHED edit the
  // sweep committed, not an INVALID file. Scoped to test/spec files only, so it
  // never overlaps the detectors above on ordinary source.
  focusedTestDetector,
];
