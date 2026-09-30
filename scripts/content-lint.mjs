#!/usr/bin/env node
/**
 * content-lint.mjs — ask the registered content detectors "would you flag THIS
 * content?", for ARBITRARY content (EI-19457795809466683).
 *
 * The per-detector `check-*.mjs` scripts answer a different question: they
 * enumerate the TRACKED TREE and report every offender in it. That makes them
 * unable to answer the question you actually have during an incident — "does the
 * guard catch this specific text?" — because a path outside the tracked tree is
 * silently ignored and stdin is not accepted at all. Answering it used to require
 * hand-rolling a probe that imports the detector by absolute path, at the exact
 * moment (a guard has just missed something in production) when being wrong is
 * most expensive.
 *
 * ⚠ This script is a THIN SHIM, deliberately. Everything decidable lives in
 * `packages/operator-core/lib/content-lint/probe.ts` — the same D-003 split the
 * per-detector scripts use — so the behaviour is unit-tested without spawning a
 * process and this file cannot drift from what the tests cover.
 *
 * Run via the package's boundary launcher (`scripts/content-lint-runner.mjs`).
 * The launcher uses Node's tsx loader to import the TypeScript registry directly
 * while mapping loader/startup failures to MISUSE instead of a false FLAGGED result.
 *
 *   npm run content-lint -- --file=packages/operator-core/lib/foo.ts
 *   npm run content-lint -- --file=/tmp/scratch.ts --detector=sql-comment-backtick
 *   cat foo.ts | npm run content-lint -- --stdin --as=packages/operator-core/lib/foo.ts
 *   npm run content-lint -- --list
 *
 * Exit: 0 = ran and nothing flagged · 1 = flagged · 2 = misuse / NOTHING RAN.
 *
 * NOTE on exit 2: if no detector is in scope for the filename, this exits 2, not
 * 0. Nothing was measured, and a "clean" report for a run that measured nothing
 * is the false-green class this repo keeps paying for (`tsc -p .` on zero files,
 * `-t` matching zero tests). The filename is a real INPUT — every detector's
 * scope is a function of the path — which is why `--as` is REQUIRED with
 * `--stdin` rather than defaulted.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { relative, resolve, isAbsolute } from 'node:path';
import {
  probeContent,
  probeExitCode,
  formatProbeResult,
  PROBE_EXIT,
} from '../packages/operator-core/lib/content-lint/probe';
import { DEFAULT_CONTENT_DETECTORS } from '../packages/operator-core/lib/content-lint/registry';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

const USAGE = `content-lint — would a registered content detector flag THIS content?

  --file=<path>          read this file (any path, inside or outside the tree)
  --stdin                read content from stdin (requires --as)
  --as=<path>            the path detectors should judge SCOPE by. Required with
                         --stdin; with --file it overrides the real path (use it
                         to ask "would this be flagged if it lived at X?").
  --detector=<key>       restrict to a detector (repeatable, or comma-separated)
  --json                 machine-readable output
  --list                 list registered detectors and exit
  -h, --help             this message

Exit: 0 ran+clean · 1 flagged · 2 misuse or NOTHING RAN (no detector in scope).`;

function parseArgs(argv) {
  const out = { file: null, stdin: false, as: null, detectors: [], json: false, list: false, help: false };
  for (const arg of argv) {
    if (arg === '--stdin') out.stdin = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg.startsWith('--file=')) out.file = arg.slice('--file='.length);
    else if (arg.startsWith('--as=')) out.as = arg.slice('--as='.length);
    else if (arg.startsWith('--detector=')) {
      out.detectors.push(...arg.slice('--detector='.length).split(',').filter(Boolean));
    } else return { error: `unknown argument: ${arg}` , ...out };
  }
  return out;
}

/** The path detectors judge scope by: `--as` wins, else repo-relative when the
 *  file is inside the tree (scope predicates test repo-relative prefixes such as
 *  `apps/operator-docs/src/content/docs/`), else the path as given. */
function scopePathFor(filePath, as) {
  if (as) return as;
  const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const rel = relative(ROOT, abs);
  return rel && !rel.startsWith('..') ? rel : filePath;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    process.exit(PROBE_EXIT.CLEAN);
  }
  if (args.error) {
    console.error(`✗ ${args.error}\n\n${USAGE}`);
    process.exit(PROBE_EXIT.MISUSE);
  }
  if (args.list) {
    console.log('registered content detectors:');
    for (const d of DEFAULT_CONTENT_DETECTORS) console.log(`  ${d.key.padEnd(22)} ${d.glob}`);
    console.log(
      `\n${DEFAULT_CONTENT_DETECTORS.length} detector(s). Corpus-level lints ` +
        '(insight-citations, insight-normative) are NOT here: they judge cross-file citations ' +
        'over the whole tracked corpus, not one file\'s content, so they do not fit this shape.',
    );
    process.exit(PROBE_EXIT.CLEAN);
  }

  if (args.stdin && args.file) {
    console.error('✗ pass either --file or --stdin, not both.\n\n' + USAGE);
    process.exit(PROBE_EXIT.MISUSE);
  }
  if (!args.stdin && !args.file) {
    console.error('✗ nothing to probe: pass --file=<path> or --stdin --as=<path>.\n\n' + USAGE);
    process.exit(PROBE_EXIT.MISUSE);
  }
  // Deliberately NOT defaulted: scope is a function of the path, so a defaulted
  // filename would answer confidently about a scope the caller never asked for.
  if (args.stdin && !args.as) {
    console.error(
      '✗ --stdin requires --as=<path>.\n\n' +
        '  Every detector decides scope FROM THE PATH, so there is no safe default: a guess would\n' +
        '  silently answer about the wrong scope. Pass the path this content does (or would) live\n' +
        "  at, e.g. --as=packages/operator-core/lib/watchdog.ts\n\n" +
        USAGE,
    );
    process.exit(PROBE_EXIT.MISUSE);
  }

  let text;
  if (args.stdin) {
    const r = readStdin();
    if (typeof r !== 'string') {
      console.error(`✗ could not read stdin: ${r.error}`);
      process.exit(PROBE_EXIT.MISUSE);
    }
    text = r;
  } else {
    try {
      text = readFileSync(isAbsolute(args.file) ? args.file : resolve(process.cwd(), args.file), 'utf8');
    } catch (err) {
      console.error(`✗ could not read ${args.file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(PROBE_EXIT.MISUSE);
    }
  }

  const fileName = args.stdin ? args.as : scopePathFor(args.file, args.as);
  const result = await probeContent({ fileName, text, only: args.detectors });
  const code = probeExitCode(result);

  if (args.json) {
    console.log(JSON.stringify({ ...result, exitCode: code }, null, 2));
  } else {
    const body = formatProbeResult(result);
    if (code === PROBE_EXIT.CLEAN) console.log(body);
    else console.error(body);
  }
  process.exit(code);
}

// Run only as the entry point — importing for reuse has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) await main();
