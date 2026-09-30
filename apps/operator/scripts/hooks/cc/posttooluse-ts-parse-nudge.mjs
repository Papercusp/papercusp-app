#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-ts-parse-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge: the file you just wrote does
// not PARSE (EI-19457231269012320 / EI-19457320059999661).
//
// THE TRAP
//   An unparseable .ts file in the shared tree is not a compile error someone
//   notices later. `apps/operator/bin/bundle-host.sh` esbuild-bundles operator-core
//   as `ExecStartPre` for `papercup-staging-api`, `papercup-bg-host` and the release
//   host — so a file that cannot parse is an IMMEDIATE boot failure for every host
//   that bundles it. Measured 2026-08-03: backticks written as prose inside a
//   `sql` tagged template closed the literal at watchdog.ts:1836; :3170 crash-looped
//   6x, systemd hit its start-limit and gave up, and the port the whole fleet uses
//   to test server-side edits was down for 17 minutes.
//
// WHY EDIT TIME, WHEN A COMMIT-PATH GUARD ALREADY EXISTS
//   It does exist and it is correct: `tsParseDetector` in
//   packages/operator-core/lib/content-lint/registry.ts, consumed by
//   harness/git-sync/content-guard.ts. But it is a COMMIT-path guard, and the
//   damage here does not need a commit. bundle-host.sh bundles the WORKING TREE, so
//   uncommitted bytes take the service down. Measured on the 2026-08-03 outage:
//   `git log --since '2026-08-03 12:00'` on that file returns exactly ONE commit —
//   the FIX. The break was NEVER COMMITTED and still took :3170 down fleet-wide.
//   A commit-path guard structurally cannot see that window.
//
//   The sibling PreToolUse content-lint hook cannot cover it either, and not by
//   oversight: PreToolUse sees `new_string` — a FRAGMENT. Smart-quotes and the
//   identity-leak classes are substring checks, so a fragment is a valid input for
//   them. A parse check on a fragment is meaningless (an `new_string` is usually a
//   function body or a partial object literal and does not parse standalone), so it
//   would fire on almost every edit. PostToolUse reads the ACTUAL resulting file
//   from disk, which is the only complete, un-reconstructed post-edit content
//   available — no replay of Edit semantics, no guessing.
//
// WHY NOT SPAWN esbuild PER EDIT (the obvious-looking alternative)
//   A `ts.createSourceFile` parse is pure, in-process, and needs no bundler: no
//   type graph, no module resolution, no disk, no network. It is measured at
//   ~0.85ms/file with ZERO false positives across all 10,829 tracked .ts/.tsx files
//   in this repo (see ts-parse.ts). Spawning esbuild per edit costs a subprocess
//   plus resolution for the same answer, on a path that fires on every write in the
//   fleet.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block, and must not try to: a multi-step
//     refactor legitimately passes through unparseable intermediate states, so a
//     verdict here would be wrong as often as it was right. This reports; it never
//     judges. The git-sync content-guard remains the real backstop.
//   - SYNTACTIC ONLY. A pure parse can only ever say "this text is not valid
//     TypeScript". It can never flag a type error, an unresolved import, a missing
//     dependency or a bad annotation, so it cannot nag about work in progress.
//   - MIRRORS the pure detector `findTsParseError`
//     (packages/operator-core/lib/content-lint/ts-parse.ts). That file is .ts and
//     this hook runs under plain node from an INSTALLED copy detached from any
//     repo, so importing it would require `tsx` (~300ms) on every edit in the
//     fleet. The parse invariant has no tunable policy to drift — it is
//     `parseDiagnostics[0] != null` — and __tests__/posttooluse-ts-parse-nudge.test.ts
//     pins this implementation against the REAL detector over a shared corpus, so
//     divergence fails a test rather than going unnoticed.
//   - OPTION-AWARE at the edit-time boundary: `nudgeFor` resolves the nearest
//     tsconfig.json and passes its compiler options to the grammar phase. Direct
//     `findParseError` calls retain the detector's safe defaults, while a real edit
//     is checked under the project's `module`/decorator settings instead of node's
//     defaults.
//   - FAILS OPEN on every internal error — bad JSON, missing file, unreadable path,
//     no resolvable typescript, an oversized file. A bug here must never disturb an
//     edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors the sibling PostToolUse nudges.
//
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

/**
 * How the repo root is identified — and, because `typescript` is what this hook
 * needs, finding it also PROVES the dependency is present. One check, so there is
 * no separate existence probe to drift out of sync (mirrors the sibling's
 * DETECTOR_REL trick).
 */
const TS_REL = join('node_modules', 'typescript', 'package.json');

/** Parsing a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 2_000_000;

/** 1 MiB, then rotated to a single `.1` sibling — mirrors bash-resource-gate. */
const FIRING_LOG_MAX_BYTES = 1 << 20;

/**
 * EI-19899815073760910: this hook is deliberately ADVISORY, which makes its
 * effectiveness a BEHAVIOURAL question — does an agent that receives the nudge
 * actually repair the file before the next bundle? Until now it wrote to stdout and
 * persisted nothing, so that question was permanently unanswerable: when occurrence
 * #3 of the backtick-in-SQL-comment class landed ~7.5h AFTER this guard was authored,
 * the two candidate causes (hook not yet registered in that session vs. hook fired and
 * was ignored) left no trace, the journal had rotated, and the diagnosis dead-ended.
 *
 * One append-only line per firing closes that. Deliberately NOT a behaviour change:
 * the guard still only advises.
 *
 * ⚠ FAIL-OPEN IS THE CONTRACT, and this function is the riskiest place to break it —
 * it runs AFTER an edit has already succeeded, so anything it throws would turn a
 * successful edit into a hook error. Every path is inside one try/catch that swallows,
 * including the rotation probe. It returns nothing and is never awaited on.
 */
export function logFiring(relPath, hit, deps = {}) {
  try {
    const home = deps.homedir ?? homedir;
    const dir = deps.logDir ?? join(home(), '.papercusp', 'hooks', 'cc');
    (deps.mkdir ?? mkdirSync)(dir, { recursive: true });
    const path = join(dir, 'ts-parse-nudge.firings.log');
    try {
      if ((deps.sizeOf ?? ((p) => statSync(p).size))(path) > FIRING_LOG_MAX_BYTES) {
        (deps.rename ?? renameSync)(path, `${path}.1`);
      }
    } catch {
      // missing (first write) or unrotatable — append anyway, exactly as the sibling does.
    }
    const rec = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      file: relPath,
      code: hit?.code ?? null,
      // `line:col` as ONE field: it is read as a position, and splitting it invites a
      // reader to correlate on line alone across different columns.
      at: hit?.line != null ? `${hit.line}:${hit.col ?? '?'}` : null,
      reason: hit?.reason ?? null,
    };
    (deps.append ?? appendFileSync)(path, `${JSON.stringify(rec)}\n`);
  } catch {
    // Never disturb an edit that already succeeded — see CONTRACT.
  }
}

// Run the hook ONLY when executed as a binary — never on import. Without this,
// importing the module (as the test suite does, to exercise the checker against the
// REAL detector) runs main(), which waits on stdin and then calls process.exit(0),
// killing the vitest worker mid-run.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    // The hook is installed globally, so the edited path may belong to a different
    // repository than the one whose PostToolUse hook is running. Derive the protected
    // repository from the client's cwd and pass it explicitly; otherwise nudgeFor would
    // discover a foreign repository from the target path and judge it with this repo's
    // bundling warning.
    const cwd = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd();
    const repoRoot = findRepoRootFromDirectory(cwd);
    if (!repoRoot) return done();

    const msg = await nudgeFor(filePath, { repoRoot, onFire: logFiring });
    if (msg) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
        }) + '\n',
      );
    }
  } catch {
    // fail open — see CONTRACT
  }
  return done();
}

/**
 * True for a file whose parseability this hook can meaningfully assert.
 *
 * `.d.ts` is deliberately INCLUDED, unlike the required-field-strand sibling: a
 * declaration file that does not parse breaks every consumer exactly as hard as an
 * implementation file does, and the reason that sibling skips it (a .d.ts declares
 * no constructible interface to strand) has no analogue here.
 */
export function isCandidateFile(filePath) {
  return /\.(ts|tsx|mts|cts)$/.test(filePath);
}

/**
 * Walk up from the edited file until a directory carries `typescript`. Returns the
 * repo root, or null when the edit is outside any tree that has it (in which case
 * the hook stays silent rather than guessing).
 */
export function findRepoRoot(filePath, exists = existsSync) {
  return findRepoRootFromDirectory(dirname(resolve(filePath)), exists);
}

/**
 * Walk up from a directory until it carries the TypeScript dependency used by this
 * hook. The PostToolUse entrypoint uses the client's cwd, while direct nudgeFor callers
 * retain the target-file behavior for backwards-compatible tests and tooling.
 */
export function findRepoRootFromDirectory(directory, exists = existsSync) {
  let dir = resolve(directory);
  for (;;) {
    if (exists(join(dir, TS_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True only when the target resolves inside the repository being protected. */
export function isWithinRepo(repoRoot, filePath) {
  const rel = relative(resolve(repoRoot), resolve(filePath));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Resolve the nearest tsconfig inside the edited repository. A config outside the
 * repository is deliberately ignored: an installed hook may inspect files from
 * several trees, and borrowing a parent workspace's options is another source of
 * false diagnostics.
 */
export function findNearestTsConfig(ts, filePath, repoRoot, exists = existsSync) {
  const root = resolve(repoRoot);
  const start = dirname(resolve(filePath));
  const found = typeof ts.findConfigFile === 'function'
    ? ts.findConfigFile(start, exists)
    : findNearestTsConfigFallback(start, exists);
  if (!found) return null;

  return isWithinRepo(root, found) ? resolve(found) : null;
}

function findNearestTsConfigFallback(start, exists) {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read only compiler options; config diagnostics must never make an edit fail. */
function loadProjectCompilerOptions(ts, filePath, repoRoot, exists) {
  const configPath = findNearestTsConfig(ts, filePath, repoRoot, exists);
  if (!configPath || typeof ts.readConfigFile !== 'function' || typeof ts.parseJsonConfigFileContent !== 'function') {
    return {};
  }
  try {
    const config = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'));
    if (config.error) return {};
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );
    return parsed.options ?? {};
  } catch {
    return {};
  }
}

/**
 * The highest diagnostic code that is still SYNTACTIC/GRAMMAR rather than type-semantic.
 * Mirrors MAX_GRAMMAR_DIAGNOSTIC_CODE in ts-parse.ts — 1xxx are syntax + grammar errors,
 * 2xxx+ are the type system, and phase 2 runs the checker, so this bound is what stops a
 * TYPE error ever producing a nudge.
 */
const MAX_GRAMMAR_DIAGNOSTIC_CODE = 2000;

/**
 * Codes ABOVE that bound which esbuild nevertheless REFUSES TO BUNDLE — so a file carrying
 * one takes every bundling host down exactly like a syntax error. Mirrors
 * ESBUILD_FATAL_DIAGNOSTIC_CODES in ts-parse.ts (the drift test pins the two).
 *
 * An explicit SET, never a higher bound (EI-19457229906581679): phase 2 runs with
 * `noLib: true` and routinely emits 2xxx noise of its own (TS2318 "Cannot find global type
 * 'Promise'", TS2584 "Cannot find name 'console'") that must stay filtered.
 *
 * TS2451 — "Cannot redeclare block-scoped variable 'x'". Measured 2026-08-10: a mid-edit
 * duplicate `const startingAdvSessionId` failed bundle-host.sh and crash-looped
 * papercup-staging-api until the reconciler gave up. Phase 1 saw ZERO parse diagnostics (a
 * redeclaration is an ECMAScript EARLY error, not a parse error) and TS2451 was filtered
 * for being ≥ 2000 — so this hook, built for exactly this outage class, watched it happen
 * again in silence.
 */
const ESBUILD_FATAL_DIAGNOSTIC_CODES = new Set([2451]);

/** True when a diagnostic breaks the FILE (syntax/grammar, or esbuild-fatal), rather than
 *  merely describing a type problem. */
function isFileBreakingDiagnostic(code) {
  return code < MAX_GRAMMAR_DIAGNOSTIC_CODE || ESBUILD_FATAL_DIAGNOSTIC_CODES.has(code);
}

/**
 * The parse check itself — deliberately identical in behaviour to
 * `findTsParseError` in packages/operator-core/lib/content-lint/ts-parse.ts.
 * Returns the FIRST syntactic diagnostic, or null when the text parses cleanly.
 * (A drift-guard test asserts the two agree on every corpus case.)
 *
 * TWO PHASES, mirroring that function (WI-37398): the parser is error-TOLERANT about
 * DUPLICATE MODIFIERS and reports them from the checker, so `export export const X = 1`
 * yields a clean `parseDiagnostics` while esbuild rejects the file outright. Phase 2
 * therefore runs TypeScript's grammar checks, filtered to codes < 2000 so a type error
 * can never produce a nudge.
 *
 * Throws only when the TypeScript build cannot report parse diagnostics at all:
 * a check that can only ever answer "clean" is precisely the silent non-guard this
 * hook exists to remove, so that case must fail loudly into the caller's fail-open
 * rather than quietly returning null for everything.
 */
export function findParseError(ts, fileName, text, compilerOptions = {}) {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKind);
  const diags = sf.parseDiagnostics;
  if (diags === undefined) {
    throw new Error('ts-parse-nudge: SourceFile.parseDiagnostics is unavailable — the parse check cannot run');
  }
  const first = diags[0];
  if (first) return toParseError(ts, sf, first);
  return findGrammarError(ts, fileName, text, scriptKind, compilerOptions);
}

/**
 * The grammar half — a single-file Program with NO lib and NO module resolution, so
 * nothing is read from disk and no dependency graph is loaded. Project compiler
 * options are retained for syntax/grammar switches such as `module` and
 * `experimentalDecorators`. Returns null on any internal failure: phase 1 has already
 * answered, so a checker that cannot complete must not turn a clean parse into a nudge.
 */
function findGrammarError(ts, fileName, text, scriptKind, compilerOptions = {}) {
  let sf;
  let diagnostics;
  try {
    // Grammar checks read node.parent, so this parse needs parent pointers.
    sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);
    const host = {
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
    const program = ts.createProgram(
      [fileName],
      {
        ...compilerOptions,
        // Keep this a single-file check even when the project config enables
        // resolution or libraries for the real build.
        noResolve: true,
        noLib: true,
        // Preserve the historical fail-open default when no tsconfig exists, but
        // honor an explicit project setting when one does.
        experimentalDecorators: compilerOptions.experimentalDecorators ?? true,
      },
      host,
    );
    diagnostics = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  } catch {
    return null;
  }
  let earliest;
  for (const d of diagnostics) {
    if (!isFileBreakingDiagnostic(d.code)) continue; // a TYPE error — never ours to flag
    if (!earliest || (d.start ?? 0) < (earliest.start ?? 0)) earliest = d;
  }
  return earliest ? toParseError(ts, sf, earliest) : null;
}

/** Render a diagnostic as the 1-based position + the compiler's own reason. */
function toParseError(ts, sf, d) {
  const pos = typeof d.start === 'number' ? sf.getLineAndCharacterOfPosition(d.start) : null;
  return {
    line: pos ? pos.line + 1 : null,
    col: pos ? pos.character + 1 : null,
    code: d.code,
    reason: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  };
}

/** The advisory text. Exported so the test asserts the real string. */
export function formatNudge(relPath, hit) {
  const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'an unknown position';
  return [
    'This file does NOT PARSE as TypeScript right now:',
    `  ${relPath}  —  ${at}  (TS${hit.code})`,
    `  ${hit.reason}`,
    '',
    '  This is not a type error and not baselined. bundle-host.sh esbuild-bundles',
    '  operator-core as ExecStartPre for papercup-staging-api, papercup-bg-host and',
    '  the release host, and it bundles the WORKING TREE — so an unparseable file',
    '  takes those services down with no commit involved. On 2026-08-03 exactly this',
    '  crash-looped :3170 into systemd start-limit for 17 minutes, fleet-wide.',
    '',
    '  If you are mid-refactor this may be a legitimate intermediate state — but do',
    '  not leave the tree this way, and note git-sync sweeps the WHOLE tree every few',
    '  minutes, so an unparseable file left sitting here can also get committed.',
    '',
    '  A frequent cause is a backtick written as prose inside a tagged template',
    '  literal (a markdown-quoted identifier in a SQL comment closes the template).',
  ].join('\n');
}

/**
 * The whole check for one edited file. Returns the advisory string, or null.
 * Every dependency is injectable so the test can drive it without a real repo.
 */
export async function nudgeFor(filePath, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const sizeOf = deps.sizeOf ?? ((p) => statSync(p).size);
  const loadTs = deps.loadTs ?? defaultLoadTs;

  if (!isCandidateFile(filePath)) return null;

  const repoRoot = deps.repoRoot ?? findRepoRoot(filePath, exists);
  if (!repoRoot) return null;
  if (!isWithinRepo(repoRoot, filePath)) return null;

  let text;
  try {
    if (sizeOf(filePath) > MAX_BYTES) return null;
    text = readFile(filePath);
  } catch {
    return null; // deleted/renamed/unreadable between the write and this hook
  }
  if (typeof text !== 'string' || text.length === 0) return null;

  const ts = await loadTs(repoRoot);
  if (!ts || typeof ts.createSourceFile !== 'function') return null;

  const compilerOptions = deps.compilerOptions
    ?? loadProjectCompilerOptions(ts, filePath, repoRoot, exists);
  const hit = findParseError(ts, filePath, text, compilerOptions);
  if (!hit) return null;

  const rel = relative(repoRoot, resolve(filePath)) || filePath;
  const relPath = rel.split(/[\\/]/).join('/');
  // EI-19899815073760910: the observation seam. Injected rather than called directly so
  // the firing is assertable WITHOUT touching the filesystem, and so `--self-test` (which
  // passes no onFire) cannot write synthetic firings into the real log — a self-test that
  // polluted the instrument would make the instrument's own data untrustworthy.
  if (typeof deps.onFire === 'function') {
    try {
      deps.onFire(relPath, hit);
    } catch {
      // An instrument must never break the thing it measures.
    }
  }
  return formatNudge(relPath, hit);
}

/**
 * Resolve `typescript` from the REPO BEING EDITED, not from the hook's own
 * location. The hook is installed to a directory detached from any repo, so a bare
 * `import('typescript')` resolves against that directory and finds nothing — which
 * fails open silently, i.e. the guard would appear installed and never fire.
 */
async function defaultLoadTs(repoRoot) {
  try {
    const req = createRequire(pathToFileURL(join(repoRoot, 'package.json')).href);
    const entry = req.resolve('typescript');
    const mod = await import(pathToFileURL(entry).href);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res('');
    let data = '';
    const t = setTimeout(() => res(data), timeoutMs);
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      res(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      res(data);
    });
  });
}

function done() {
  process.exit(0);
}

async function selfTest() {
  const failures = [];
  const check = (name, ok) => {
    if (!ok) failures.push(name);
  };

  const ts = await defaultLoadTs(findRepoRoot(fileURLToPath(import.meta.url)) ?? process.cwd());
  if (!ts) {
    console.error('posttooluse-ts-parse-nudge --self-test: cannot resolve typescript');
    process.exit(1);
  }

  const base = {
    exists: () => true,
    repoRoot: '/repo',
    sizeOf: () => 100,
    loadTs: async () => ts,
  };

  // A clean file is silent.
  const clean = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    readFile: () => 'export const a: number = 1;\n',
  });
  check('silent on a file that parses', clean === null);

  // The measured 2026-08-03 outage shape: a backtick inside a SQL comment that
  // lives inside a tagged template literal closes the template.
  //
  // The backticks are written as \x60 ON PURPOSE — do not "tidy" them back into
  // literal characters. This fixture reproduces a SQL comment carrying a
  // markdown-quoted identifier, which is exactly what `sqlCommentBacktickDetector`
  // (packages/operator-core/lib/content-lint/registry.ts) exists to catch. Spelled
  // literally, the git-sync content-guard quarantines THIS FILE — the guard for the
  // class gets blocked by the guard for the class. Verified 2026-08-03: literal
  // backticks here produce a real hit at this line with backticks:3. Escaping them
  // keeps the runtime string byte-identical while leaving no backtick in the source.
  const broken = await nudgeFor('/repo/packages/x/watchdog.ts', {
    ...base,
    readFile: () =>
      'const rows = await sql\x60\n  SELECT 1\n  -- crowded out; \x60name\x60 is a tiebreak\n  ORDER BY 1\x60;\n',
  });
  check('reports the template-literal break', typeof broken === 'string' && /does NOT PARSE/.test(broken));
  check('names the file', typeof broken === 'string' && /watchdog\.ts/.test(broken));

  // A plain syntax error is reported too (the general form).
  const trunc = await nudgeFor('/repo/packages/x/b.ts', {
    ...base,
    readFile: () => 'export function f( {\n',
  });
  check('reports a plain syntax error', typeof trunc === 'string' && /does NOT PARSE/.test(trunc));

  // A TYPE error must NOT be reported — syntactic only.
  const typeErr = await nudgeFor('/repo/packages/x/c.ts', {
    ...base,
    readFile: () => 'const n: number = "not a number";\nimport { nope } from "./does-not-exist";\n',
  });
  check('silent on a type error / unresolved import', typeErr === null);

  // EI-19457229906581679 — the 2026-08-10 outage shape. A duplicate block-scoped
  // declaration parses cleanly (it is an ECMAScript EARLY error, not a parse error), so
  // phase 1 reports nothing and the ONLY signal is TS2451 — which the < 2000 bound used to
  // discard. esbuild refuses the file outright, so this DOES take the bundling hosts down.
  const dupConst = await nudgeFor('/repo/packages/x/launch-su.ts', {
    ...base,
    readFile: () =>
      'export function f(ownerId: string) {\n  const sessionId = ownerId ? "a" : null;\n  const sessionId = ownerId ? "b" : null;\n  return sessionId;\n}\n',
  });
  check('reports a duplicate block-scoped declaration (TS2451)', typeof dupConst === 'string' && /does NOT PARSE/.test(dupConst));
  check('names the redeclared symbol', typeof dupConst === 'string' && /sessionId/.test(dupConst));

  // ...and the noLib NOISE that shares the same 2xxx range must STAY filtered — this is
  // what makes the enumerated set necessary instead of simply raising the bound.
  const noLibNoise = await nudgeFor('/repo/packages/x/d.ts', {
    ...base,
    readFile: () => 'export async function f() {\n  console.log("hi");\n  return Promise.resolve(1);\n}\n',
  });
  check('silent on noLib-only diagnostics (TS2318/TS2584)', noLibNoise === null);

  // Non-candidate paths short-circuit without touching the filesystem.
  const notTs = await nudgeFor('/repo/packages/x/readme.md', {
    ...base,
    readFile: () => {
      throw new Error('must not be called');
    },
  });
  check('skips a non-TypeScript path', notTs === null);

  // Outside any tree carrying typescript => silent.
  const noRoot = await nudgeFor('/elsewhere/a.ts', {
    ...base,
    repoRoot: null,
    exists: () => false,
    readFile: () => {
      throw new Error('must not be called');
    },
  });
  check('silent outside a repo that has typescript', noRoot === null);

  // An unreadable file fails open.
  const unreadable = await nudgeFor('/repo/packages/x/gone.ts', {
    ...base,
    readFile: () => {
      throw new Error('ENOENT');
    },
  });
  check('fails open on an unreadable file', unreadable === null);

  // An unresolvable typescript fails open.
  const noTs = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    readFile: () => 'export function f( {\n',
    loadTs: async () => null,
  });
  check('fails open when typescript cannot be loaded', noTs === null);

  // An oversized file is skipped without reading it.
  const huge = await nudgeFor('/repo/packages/x/huge.ts', {
    ...base,
    sizeOf: () => MAX_BYTES + 1,
    readFile: () => {
      throw new Error('must not be called');
    },
  });
  check('skips an oversized file without reading it', huge === null);

  if (failures.length) {
    console.error(`posttooluse-ts-parse-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-ts-parse-nudge --self-test: all cases passed');
  process.exit(0);
}
