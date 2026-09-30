/**
 * The dead-typecheck verdict for a BACKGROUNDED job — the half of
 * `deadTypecheckVerdict` that nothing was applying.
 *
 * WHY (EI-20057167830211785, measured 2026-08-10)
 * ──────────────────────────────────────────────
 * `deadTypecheckVerdict` (./inspect) turns "tsc exited non-zero and emitted no
 * diagnostics" into a loud refusal instead of a clean-looking zero. It runs on
 * `capability:inspect`'s FOREGROUND path only. The background path returns a
 * `bash_id` before the compile has produced a byte, so it cannot classify
 * anything — and every later read goes through `capability:bash_output`, which
 * knew nothing about tsc. The guard was therefore absent from exactly the path
 * agents are ROUTED to for a project too big to finish inside the ~50s
 * foreground cap: `build:typecheck`'s timeout hint says, verbatim, "run it
 * detached instead: capability:inspect { …, run_in_background: true }, then
 * poll capability:bash_output".
 *
 * A hand-rolled `capability:bash { command: 'npx tsc …', run_in_background:
 * true }` is the same hole and is strictly worse: that path applies no heap pin
 * either (`capability:bash` runs arbitrary commands and does not know one of
 * them is a compile), so it still dies at node's default ~4GB *and* still reads
 * clean. Both paths converge on `capability:bash_output`, which is why the
 * verdict belongs there rather than in either caller.
 *
 * The numbers, so the ceiling is not mistaken for a permanent fix: apps/operator
 * typechecks in 110s at **5.0GB peak RSS** (850 real diagnostics) under the
 * committed 8192MB pin — i.e. it needs ~1.3x node's DEFAULT ceiling. That is why
 * it OOMed unpinned, and why "we raised the heap" is a moving answer as the tree
 * grows. Detection is the durable half.
 *
 * ⚠ This module only DETECTS. It deliberately does NOT rewrite NODE_OPTIONS for
 * a job the caller composed itself: silently re-tuning an arbitrary command is a
 * different and far more surprising act than telling its caller that the run
 * measured nothing.
 */

import { deadTypecheckVerdict } from './inspect';
import { TSC_HEAP_MB, parseHeapPinMb } from '../tsc-heap';

/**
 * Program-shaped prefixes we walk PAST to find the real command, because each
 * keeps that command as its first non-flag operand. Shell env assignments
 * (`NODE_OPTIONS=… tsc …`) are handled separately.
 *
 * `job.command` is stored RAW (bash-jobs: `command: opts.command`; the sandbox
 * wraps only at spawn time), so this list is about what a CALLER types — and
 * callers here really do type all of these: `scripts/pc-heavy.sh` is what this
 * repo tells agents to queue heavy compiles behind, and `/usr/bin/time -v env
 * NODE_OPTIONS=… npx tsc …` is the shape of a measured run. Omitting them would
 * leave the detector armed for a narrower population than the one that hits this
 * bug.
 */
const RUNNER_PREFIXES = new Set(['npx', 'env', 'time', 'bash', 'sh', 'pc-heavy.sh']);

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Last path segment, unquoted — `./node_modules/.bin/tsc` → `tsc`, `'npx` → `npx`. */
function baseName(token: string): string {
  const unquoted = token.replace(/^['"]+/, '').replace(/['"]+$/, '');
  const cut = unquoted.lastIndexOf('/');
  return cut === -1 ? unquoted : unquoted.slice(cut + 1);
}

/**
 * Does this command invoke the `tsc` BINARY directly?
 *
 * The population is deliberately narrow, and the exclusions are the point:
 *
 * - It must be a command HEAD, not any occurrence of the letters. `grep tsc
 *   build.log` exiting 1 (no match) is not a typecheck that died, and a
 *   substring test would announce that it was — a false alarm is a bug in the
 *   alarm, and this one would fire on an ordinary failed grep.
 * - An npm SCRIPT that wraps tsc (`npm run lint:tsc`) is excluded on purpose.
 *   Those wrap the compiler in a reporter whose output format we do not own, so
 *   "zero parsed diagnostics" there means "we could not read it", not "it died"
 *   — and `scripts/lib/tsc-baseline-gate.mjs` already owns that verdict for the
 *   gate paths.
 */
export function isTypecheckCommand(command: string): boolean {
  for (const segment of command.split(/\|\||&&|[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (ENV_ASSIGNMENT_RE.test(token)) {
        i += 1;
        continue;
      }
      if (RUNNER_PREFIXES.has(baseName(token))) {
        i += 1;
        while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
        continue;
      }
      break;
    }
    if (i < tokens.length && baseName(tokens[i]) === 'tsc') return true;
  }
  return false;
}

/**
 * A LAUNCH-time warning for a tsc command whose heap is unpinned or pinned too
 * low — or `null` when there is nothing worth saying.
 *
 * Why warn instead of fixing it: `capability:bash` runs a command the CALLER
 * composed, and silently rewriting NODE_OPTIONS underneath it is more surprising
 * than letting it fail — the tool cannot know that a smaller pin was not
 * deliberate. The sibling paths (`build:typecheck`, `capability:inspect`) spawn
 * tsc THEMSELVES, so they can and do pin it via `tscHeapEnv()`. This one only
 * removes the tacit-knowledge requirement (EI-20063051138162607).
 *
 * The under-pinned case is reported as well as the unpinned one, and is the more
 * dangerous of the two: `withTscHeap` RAISES a too-small pin precisely because
 * deferring to one below what the compile needs froze the fleet gate for ~10h
 * across 11 reds (WI-37450). A hand-rolled command gets no such correction, so
 * here it is the reading that most needs saying out loud.
 *
 * Stated at launch because the failure is SILENT-SHAPED: an OOM-killed tsc emits
 * a V8 GC dump and native stack trace containing zero `error TS` lines, so the
 * grep a caller reaches for next reports a clean compile (EI-20057167830211785).
 */
export function typecheckHeapLaunchWarning(
  command: string,
  ambientNodeOptions: string | undefined = process.env.NODE_OPTIONS,
): string | null {
  if (!isTypecheckCommand(command)) return null;
  const pinned = parseHeapPinMb(command) ?? parseHeapPinMb(ambientNodeOptions);
  if (pinned !== null && pinned >= TSC_HEAP_MB) return null;
  const diagnosis =
    pinned === null
      ? `this looks like a direct \`tsc\` invocation with no \`--max-old-space-size\`, so it inherits node's ~4GB default`
      : `this looks like a direct \`tsc\` invocation pinned to only ${pinned}MB`;
  return (
    ` NOTE: ${diagnosis} — a large project in this repo needs ~5GB peak RSS, and the sibling ` +
    `typecheck tools pin ${TSC_HEAP_MB}MB for exactly that reason. Nothing has been changed about your ` +
    `command. If it dies on heap the failure is SILENT-SHAPED: the V8 GC dump contains zero \`error TS\` ` +
    `lines, so grepping the log for diagnostics reports a CLEAN compile rather than a dead one — read ` +
    `capability:bash_output's typecheck verdict, not a grep. To pin it yourself, prefix the command with ` +
    `\`NODE_OPTIONS=--max-old-space-size=${TSC_HEAP_MB}\`; or use build:typecheck / capability:inspect, ` +
    `which pin the heap for you.`
  );
}

/**
 * How many tsc diagnostics the log actually contains. Mirrors the `\berror
 * TS\d+\b` shape the sibling paths parse; the count only has to answer "did this
 * run say ANYTHING", which is what separates a real failing compile from a dead
 * one.
 */
export function countTscDiagnostics(log: string): number {
  return (log.match(/\berror TS\d+\b/g) ?? []).length;
}

/**
 * The verdict for a background job, or `null` when there is nothing to say:
 * the command is not a tsc invocation, the job is still running, or the run
 * produced a real result (clean, or non-zero WITH diagnostics).
 */
export function backgroundTypecheckVerdict(job: {
  command: string;
  status: string;
  exitCode: number | null;
  log: string;
}): { reason: string; headline: string; advice: string } | null {
  if (!isTypecheckCommand(job.command)) return null;
  // A running job has not failed yet; classifying one would turn "not finished"
  // into "measured nothing", which is the same false verdict pointed the other
  // way.
  if (job.status === 'running') return null;
  return deadTypecheckVerdict({
    exitCode: job.exitCode,
    status: job.status,
    output: job.log,
    parsedErrors: countTscDiagnostics(job.log),
  });
}
