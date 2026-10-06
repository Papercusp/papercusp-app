/**
 * Generate `.d.mts` declarations for the plain-JS `.mjs` modules listed in
 * `tsconfig.declarations.json` (WI-6394). See that file for WHY these are
 * generated rather than hand-written.
 *
 *   npm run gen:declarations                         # emit every enrolled output
 *   npm run gen:declarations -- --files=a.mjs,b.mjs # emit selected enrolled outputs
 *   npm run gen:declarations:check                   # verify every committed output
 *
 * Both modes compile into an isolated temp directory. `--check` compares that
 * output without publishing it; normal generation publishes only after the
 * compiler and stamping succeed. That matters here beyond politeness — this repo
 * has ONE checkout shared by the whole fleet, and a failed compile must not leave
 * the working tree missing declarations or carrying partial/untracked output.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { exportParityProblems, formatProblems } from './lib/declaration-export-parity.js';
import { orphanedJsdocProblems, formatOrphanedJsdoc } from './lib/orphaned-jsdoc.ts';
import {
  formatStaleSuppressions,
  importerSources,
  staleDeclarationSuppressions,
  type StaleSuppression,
} from './lib/stale-declaration-suppressions.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = 'tsconfig.declarations.json';

/**
 * The compiler, resolved through the `typescript` PACKAGE — never through
 * `node_modules/.bin/tsc` (WI-40183).
 *
 * A declaration file is a function of (source, COMPILER), so the compiler is an
 * INPUT to this generator and has to be pinned like one. `.bin/tsc` cannot pin
 * it: that slot is first-come-first-served across every installed package that
 * ships a `tsc` bin, so its identity changes when the dependency tree changes,
 * with no edit to this repo. Adding `@typescript/native` (TypeScript 7)
 * repointed it, and all 52 committed declarations — byte-identical to their
 * sources under the pinned TypeScript 6 — went "stale" in one step and red-pinned
 * the green gate. Note the failure is SYMMETRIC and the other direction is worse:
 * the same ambient slot can silently false-GREEN a genuinely drifted declaration.
 *
 * `typescript/lib/tsc.js` is precisely what `bin/tsc` runs (that shim is one
 * line: `require('../lib/tsc.js')`), so this changes which compiler is selected,
 * never how it is invoked. Resolving BY SPECIFIER also tracks whatever the repo
 * designates as `typescript` — including the aliased
 * `npm:@typescript/typescript6` install, whose bin is deliberately named `tsc6`
 * so that it does not claim the shared slot. Should the repo ever promote TS7 to
 * the `typescript` name, this follows it with no edit here.
 */
const TSC_JS = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');

/**
 * Which compiler produced this run, named in the output of BOTH modes.
 *
 * A wrong-compiler run does not look like a wrong-compiler run: every
 * declaration differs at once, so it reads as "the whole repo went stale" and
 * sends you looking for 52 source edits that never happened. Printing the
 * compiler — including on the FAILURE path, before the comparison — is what makes
 * that one glance instead of an archaeology session, and it is the assertion
 * surface `generated-declarations.test.ts` uses to pin the compiler identity.
 */
const COMPILER_LABEL = relative(REPO_ROOT, TSC_JS) || TSC_JS;

/** The `.mjs` inputs, read from the config so the two can never disagree. */
function inputs(repoRoot: string, config: string): string[] {
  // The config carries `//` comments (tsc accepts JSONC), so strip them before parsing.
  const raw = readFileSync(join(repoRoot, config), 'utf8');
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  const parsed = JSON.parse(stripped) as { files?: string[] };
  if (!parsed.files?.length) throw new Error(`${CONFIG} declares no \`files\``);
  return parsed.files;
}

/** `scripts/foo.mjs` -> `scripts/foo.d.mts` */
function declarationFor(mjs: string): string {
  return mjs.replace(/\.mjs$/, '.d.mts');
}

/** Resolve an optional publish selection against the config-owned input set. */
function publishSelection(declaredInputs: string[], requestedInputs?: readonly string[]): string[] {
  if (requestedInputs === undefined) return declaredInputs;
  const requested = new Set(requestedInputs);
  if (requested.size === 0) throw new Error('`--files` must name at least one enrolled .mjs input');
  for (const input of requested) {
    if (!declaredInputs.includes(input)) {
      throw new Error(`cannot generate undeclared input: ${input}`);
    }
  }
  // Preserve config order so logs and writes stay deterministic regardless of
  // the order supplied by an edit hook.
  return declaredInputs.filter((input) => requested.has(input));
}

type Compile = (repoRoot: string, config: string, outDir: string) => void;

function runTsc(repoRoot: string, config: string, outDir: string): void {
  const args = ['-p', config, ...(outDir ? ['--outDir', outDir] : [])];
  try {
    execFileSync(process.execPath, [TSC_JS, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    // Surface tsc's own diagnostics — a bare "Command failed" hides what broke.
    throw new Error(`tsc failed:\n${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`);
  }
}

/**
 * Opens every emitted declaration (below any shebang — see `stamp`).
 *
 * `generated-declarations.test.ts` asserts on this string but DUPLICATES the
 * literal rather than importing it, deliberately: this module calls `generate()`
 * at top level, so importing it from a test would emit declarations into the
 * shared working tree as a side effect of collecting the suite. If you change the
 * text here, change it there too — the test failure will point you at it.
 */
export const BANNER_MARKER = '// GENERATED by `npm run gen:declarations`';

function bannerFor(mjs: string): string {
  return (
    `${BANNER_MARKER} from ${mjs}. DO NOT EDIT.\n` +
    `// Edits here are silently discarded on the next run — change the JSDoc in\n` +
    `// ${mjs} and regenerate.\n`
  );
}

/**
 * Stamp the provenance banner onto every declaration under `outRoot`.
 *
 * MUST be called by BOTH `generate()` and `check()`. `check()` compares the
 * regenerated bytes against the committed copy, so a banner applied on only one
 * side would make every check fail.
 *
 * The banner goes AFTER a leading shebang, never before it. `tsc` copies the
 * source's `#!` line into the declaration (9 of the 11 modules here are
 * executable scripts), and TypeScript accepts `#!` ONLY at byte 0 — pushing it
 * to line 2 is `error TS18026: '#!' can only be used at the start of a file`,
 * plus a cascading TS1005 as `#!` is then scanned as a private identifier. A
 * naive prepend therefore breaks most of these files, including
 * `tsc-baseline-gate.d.mts`, which the whole fleet's type gate runs through.
 *
 * Not idempotent by design, and it does not need to be: both callers stamp the
 * output of a fresh `tsc` emit (`generate()` unlinks the previous declarations
 * first, `check()` emits into an empty temp dir), so this always sees unstamped
 * input. A "skip if already stamped" guard here would only be able to hide a
 * caller that stopped doing that.
 */
function stamp(outRoot: string, declaredInputs: string[]): void {
  for (const mjs of declaredInputs) {
    const path = join(outRoot, declarationFor(mjs));
    const text = readFileSync(path, 'utf8');

    let shebang = '';
    let body = text;
    if (text.startsWith('#!')) {
      const nl = text.indexOf('\n');
      // A shebang with no trailing newline would otherwise swallow the banner
      // onto its own line, so re-terminate it.
      shebang = nl === -1 ? `${text}\n` : text.slice(0, nl + 1);
      body = nl === -1 ? '' : text.slice(nl + 1);
    }

    writeFileSync(path, shebang + bannerFor(mjs) + body);
  }
}

/**
 * Publish only the declarations explicitly listed by the config.
 *
 * `tsc` may also emit declarations for reachable modules that are not in the
 * config's `files` list. Those are compiler intermediates, not part of the
 * committed generated surface, and publishing them creates the stray untracked
 * files this command is meant to prevent.
 */
function publish(outRoot: string, repoRoot: string, declaredInputs: string[]): void {
  const outputs = declaredInputs.map((mjs) => {
    const rel = declarationFor(mjs);
    const source = join(outRoot, rel);
    const destination = join(repoRoot, rel);
    if (!existsSync(source)) throw new Error(`tsc did not emit declared output: ${rel}`);
    return { source, destination };
  });

  for (const { source, destination } of outputs) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

/**
 * Generate into an isolated tree, then publish the declared outputs.
 *
 * The optional compiler callback is a hermetic test seam: it lets the regression
 * test simulate a compiler that emitted partial output before failing without
 * touching this checkout. Production callers use `runTsc` (the default).
 */
export function generate(
  repoRoot = REPO_ROOT,
  config = CONFIG,
  compile: Compile = runTsc,
  requestedInputs?: readonly string[],
): void {
  const declaredInputs = inputs(repoRoot, config);
  const selectedInputs = publishSelection(declaredInputs, requestedInputs);
  const out = mkdtempSync(join(tmpdir(), 'papercusp-decl-generate-'));
  try {
    compile(repoRoot, config, out);
    stamp(out, declaredInputs);
    publish(out, repoRoot, selectedInputs);
    console.log(
      `✓ gen:declarations: emitted ${selectedInputs.length} of ${declaredInputs.length} declaration file(s) — compiler: ${COMPILER_LABEL}`,
    );
    // Publishing a declaration is exactly the moment an importer's `@ts-expect-error` goes stale
    // (WI-10005290). Report it HERE, naming each line, rather than leaving it to surface as TS2578
    // whenever someone next typechecks that importer. Reported, not auto-removed: this runs from
    // an edit hook, and rewriting arbitrary importers from a script would bypass the file locks.
    const stale = staleSuppressionsIn(repoRoot, declaredInputs);
    if (stale?.length) {
      console.error(
        `✗ gen:declarations: ${stale.length} @ts-expect-error suppression(s) are now unused (TS2578) because ` +
          `the module they guarded has a declaration. Delete each line:\n   ${formatStaleSuppressions(stale).join('\n   ')}`,
      );
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** `null` = importers could not be listed (not a git checkout): NOT measured, never "none". */
export function staleSuppressionsIn(repoRoot: string, modules: readonly string[]): StaleSuppression[] | null {
  const sources = importerSources(repoRoot, modules);
  return sources === null ? null : staleDeclarationSuppressions(modules, sources);
}

export function check(repoRoot = REPO_ROOT, config = CONFIG): void {
  // BEFORE the comparison, so a red names the compiler that produced the emit.
  console.log(`gen:declarations:check — compiler: ${COMPILER_LABEL}`);
  const out = mkdtempSync(join(tmpdir(), 'papercusp-decl-check-'));
  try {
    const declaredInputs = inputs(repoRoot, config);
    runTsc(repoRoot, config, out);
    stamp(out, declaredInputs);

    const stale: string[] = [];
    const missing: string[] = [];
    for (const mjs of declaredInputs) {
      const rel = declarationFor(mjs);
      const committedPath = join(repoRoot, rel);
      if (!existsSync(committedPath)) {
        missing.push(rel);
        continue;
      }
      const fresh = readFileSync(join(out, rel), 'utf8');
      if (readFileSync(committedPath, 'utf8') !== fresh) stale.push(rel);
    }

    if (missing.length || stale.length) {
      if (missing.length) console.error(`✗ missing declaration(s):\n   ${missing.join('\n   ')}`);
      if (stale.length) console.error(`✗ stale declaration(s):\n   ${stale.join('\n   ')}`);
      console.error(`\nRun \`npm run gen:declarations\` and commit the result.`);
      process.exit(1);
    }

    // Hand-written declarations are not regenerated, so the byte-compare above says
    // nothing about them. This is the only thing that does (EI-20805816236289594).
    const parity = formatProblems(
      exportParityProblems(repoRoot, new Set(declaredInputs.map(declarationFor))),
    );
    if (parity.length) {
      console.error(`✗ hand-written declaration(s) out of sync with their source:\n   ${parity.join('\n   ')}`);
      console.error(
        `\nEdit the .d.mts to match its .mjs. (Do NOT "fix" this by adding the module to\n` +
          `${CONFIG} — for these modules generation emits a WEAKER type than the\n` +
          `hand-written declaration; the measurement is in the header of\n` +
          `scripts/lib/declaration-export-parity.ts.)`,
      );
      process.exit(1);
    }

    // A JSDoc block stranded before ANOTHER JSDoc block documents nothing, so tsc infers the
    // signature and the emit above is DEGRADED but self-consistent — the byte-compare cannot
    // see it, and once committed it stays "up to date" forever (EI-19448039697242208).
    const orphaned = formatOrphanedJsdoc(
      orphanedJsdocProblems(
        new Map(declaredInputs.map((mjs) => [mjs, readFileSync(join(repoRoot, mjs), 'utf8')])),
      ),
    );
    if (orphaned.length) {
      console.error(
        `✗ orphaned JSDoc — these blocks document a signature but are followed by another\n` +
          `  doc block, so their types are silently dropped:\n   ${orphaned.join('\n   ')}`,
      );
      console.error(
        `\nMove each block to sit immediately above the function it documents, then run\n` +
          `\`npm run gen:declarations\` and commit the result.`,
      );
      process.exit(1);
    }

    const unusedSuppressions = staleSuppressionsIn(repoRoot, declaredInputs);
    if (unusedSuppressions === null) {
      console.error(`✗ could not list importers (git grep failed in ${repoRoot}); stale suppressions NOT checked`);
      process.exit(1);
    }
    if (unusedSuppressions.length) {
      console.error(
        `✗ @ts-expect-error suppression(s) guarding a module that now has a declaration — each is\n` +
          `  TS2578 "Unused '@ts-expect-error' directive":\n   ${formatStaleSuppressions(unusedSuppressions).join('\n   ')}`,
      );
      console.error(`\nDelete each listed line (WI-10005290).`);
      process.exit(1);
    }

    console.log(
      `✓ gen:declarations:check: ${declaredInputs.length} declaration file(s) up to date; ` +
        `hand-written declarations match their sources; no importer suppresses a declared module`,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const filesArgs = process.argv.slice(2).filter((arg) => arg.startsWith('--files='));
  const requestedInputs = filesArgs.flatMap((arg) =>
    arg.slice('--files='.length).split(',').filter((input) => input.length > 0),
  );
  if (process.argv.includes('--check')) {
    if (filesArgs.length > 0) throw new Error('`--files` is only valid for generation, not `--check`');
    check();
  } else {
    generate(REPO_ROOT, CONFIG, runTsc, filesArgs.length > 0 ? requestedInputs : undefined);
  }
}
