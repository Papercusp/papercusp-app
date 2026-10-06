/**
 * build:typecheck — run `tsc --noEmit` for one project and return DISTILLED
 * diagnostics, refusing a run that would have checked nothing.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-024.
 *
 * ── Why this exists (measured, not assumed) ─────────────────────────────────
 * The 7d corpus holds 622 direct `tsc` atoms across 59 of 86 su sessions — the
 * widest bash family left after git and file-read, and 95% of it is
 * `--noEmit`, i.e. TYPECHECKING rather than building. 72% of the family's
 * whole-commands pipe the compiler's output into `grep`/`head`/`tail` and 17%
 * redirect it to a log file, so agents are pulling a full compiler log across
 * the pipe to throw nearly all of it away. That is the same defect `logs:read`
 * fixed for journalctl, and the reason this tool returns
 * `{ errors:[{file,line,column,code,message}], errorCount, byFile }` and
 * pushes the filtering down (`files`) instead of handing back text.
 *
 * ── The correctness argument: a typecheck that checked NOTHING ──────────────
 * This repo has NO root `tsconfig.json` (only `tsconfig.base.json`), yet the
 * two most common project operands in the corpus are `-p .` (183 atoms) and
 * `-p tsconfig.json` (225). Run from the repo root both fail instantly —
 * TS5057 / TS5058 — having checked zero files. Replaying each session's cwd
 * over the corpus, 45 of 425 decidable `tsc` invocations (11%, across 24 of 86
 * sessions) checked nothing; a cwd-agnostic reading of the same data puts it at
 * 103 of 455 (23%). Either way the failure mode is the same, and what makes it
 * expensive is how it was READ: 42% of those runs were piped into `grep`, and a
 * `grep <my-file>` over a one-line TS5057 prints NOTHING — indistinguishable
 * from "my file is clean". Under `2>&1 | tail`, `$?` is the PIPE's status, so
 * tsc's exit 1 is lost too.
 *
 * So this tool refuses rather than reporting a clean zero, exactly as
 * `testing:run` refuses a zero-match Vitest run. It is the same class as
 * EI-6479 (`npm run typecheck --if-present` silently no-opping) and the fifth
 * instance in this plan of ABSENT EVIDENCE MUST NOT READ AS EVIDENCE OF
 * ABSENCE — after the soak-report's zeroed OOM gate, `dev:listening_ports`'
 * `ownerVisible`, `logs:read`' `unitsUnknown`, and `dev:service_health`'s
 * phantom units.
 *
 * ── What it deliberately does NOT reimplement ───────────────────────────────
 * Nothing about the type-error BASELINE. `scripts/lint-tsc.mjs` +
 * `scripts/lib/tsc-baseline-gate.mjs` own the per-file ratchet, `--mine`
 * scoping and the ratchet-only-down policy; this tool answers the prior, more
 * literal question ("what does tsc say about this project right now") and
 * points at that gate for the verdict. `--incremental false` is inherited from
 * it as a correctness flag, not a style choice (EI-487: a warm tsbuildinfo
 * makes `--noEmit` UNDER-report).
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  errorsOnly,
  filterToDirs,
  filterToFiles,
  noInputDiagnostic,
  parseFoundSummary,
  parseTscDiagnostics,
  splitVanishedIncludeFiles,
  summariseByFile,
  syntaxBrokenFiles,
  TSC_DECOY_BANNER,
} from '../../tsc-diagnostics';
import type { TscDiagnostic, TscFileCount } from '../../tsc-diagnostics';
import {
  resolveAgentWorkspaceRoot,
  resolveCapabilityIntegrationRoot,
} from '../capability/base-dir';
import { selectUnambiguousEvidenceRoot } from '../../evidence-root-selection';
import { tscHeapEnv } from '../tsc-heap';
import { activeWorkspaceId } from '../../workspace-registry';
import { beginGovernedExecution, governedExecutionRuntime } from '../../resource-governor/execution';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
} from '../capability/foreground-transport-cap';
import {
  TSC_SERVICE_ENV,
  requestTscService,
  tscServiceSocketPath,
} from '../../../../../scripts/lib/tsc-service.mjs';
import type { TscServiceResponse } from '../../../../../scripts/lib/tsc-service.mjs';

/** A cold full-repo typecheck runs minutes, not seconds; a wedged one must still end. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;

/**
 * EI-18776865728050036 — this tool is dispatched FOREGROUND over the papercusp-su MCP
 * transport, which hard-caps a call at ~55s (EI-6073). Its own budget above is 300s default /
 * 900s max, so for any project slower than ~55s the transport killed the call BEFORE the
 * `error:'timeout'` branch below could ever be reached — and the failure surfaced as
 * `MCP error -32603: write CONNECTION_CLOSED 127.0.0.1:6432`, an error naming the DATABASE.
 *
 * Measured 2026-07-27: `packages/operator-core` takes 104.4s → failed 3/3, while `libs/flags`
 * (2.1s) succeeded on the identical path. So the tool was structurally unusable on the largest
 * workspace — and the one the repo's own CLAUDE.md tells every agent to typecheck after
 * editing. Worse, the pgbouncer-shaped error sends the reader off to debug PG (it cost me
 * several calls), and the fallback is a hand-rolled `npx tsc` — precisely the trap this tool
 * exists to prevent (`-p .` checks ZERO files and a grep over the one-line TS5057 prints
 * nothing, reading as "clean").
 *
 * EI-6073 already solved this class for the sibling `capability:inspect` — and its comment even
 * names this case ("operator-core's tsc runs 60-90s"). We IMPORT that ceiling rather than
 * re-declaring 50_000 here: a second copy of a transport constant is exactly the kind of twin
 * that drifts silently the day the cap moves.
 */
const DEFAULT_MAX_ERRORS = 50;
const MAX_BY_FILE = 30;

interface BoundedDiagnostics {
  errors: TscDiagnostic[];
  errorsTruncated: boolean;
  byFile: TscFileCount[];
  byFileTruncated: boolean;
  filesWithErrors: number;
}

export interface ScopedDiagnosticPartition {
  requested: TscDiagnostic[];
  other: TscDiagnostic[];
  unattributed: TscDiagnostic[];
}

/**
 * Split a scoped program's diagnostics at the attribution boundary the caller
 * actually asked about. `filterToFiles` already owns the path-normalisation
 * contract; the Set preserves compiler order inside both buckets.
 *
 * Global diagnostics stay in `other` so they remain visible, and are also
 * called out in `unattributed`: unlike an ordinary imported-file error, a
 * config/global error may mean the requested files were never checked fully and
 * therefore must keep the scoped verdict from reading green.
 */
export function partitionScopedDiagnostics(
  errors: TscDiagnostic[],
  resolvedFiles: string[],
): ScopedDiagnosticPartition {
  const requestedSet = new Set(filterToFiles(errors, resolvedFiles));
  const requested: TscDiagnostic[] = [];
  const other: TscDiagnostic[] = [];
  const unattributed: TscDiagnostic[] = [];

  for (const error of errors) {
    if (requestedSet.has(error)) {
      requested.push(error);
      continue;
    }
    other.push(error);
    if (error.file === null) unattributed.push(error);
  }
  return { requested, other, unattributed };
}

/**
 * Bound the two potentially large diagnostic arrays without making a bounded
 * response look complete. The full counts remain available to callers through
 * `errorCount`/`filesWithErrors`; the flags are deliberately adjacent to the
 * arrays so a grep or a shallow projection cannot miss the caveat.
 */
export function boundDiagnostics(
  errors: TscDiagnostic[],
  byFile: TscFileCount[],
  maxErrors: number,
): BoundedDiagnostics {
  return {
    errors: errors.slice(0, maxErrors),
    errorsTruncated: errors.length > maxErrors,
    byFile: byFile.slice(0, MAX_BY_FILE),
    byFileTruncated: byFile.length > MAX_BY_FILE,
    filesWithErrors: byFile.length,
  };
}

/** Depth-bounded scan for real tsconfigs, used only to make a refusal actionable. */
const SUGGEST_ROOTS = ['packages', 'apps', 'libs'];
const MAX_SUGGESTIONS = 12;

/** Never descend into these when hunting for projects. */
const SUGGEST_PRUNE = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '_retired']);

/**
 * How far BELOW a bucket root to hunt.
 *
 * EI-19302566985147894: this scan used to be exactly one level deep
 * (`libs/<entry>/tsconfig.json`), which silently made every project inside a
 * nested workspace UNSUGGESTABLE — `libs/papercusp` is a git submodule with its
 * own `apps/*`/`packages/*`/`libs/*`, so its projects live at depth 3
 * (`libs/papercusp/libs/db`). The user-visible failure was not a missing
 * suggestion but a WRONG conclusion: an agent told to run
 * `build:typecheck { project: "<workspace>" }` for the package it had just
 * edited got `project_not_found` plus an `availableProjects` list containing no
 * path under `libs/papercusp/**` at all, and reasonably read that as "this tree
 * cannot be typechecked" rather than "the suggester cannot see this far down".
 */
const SUGGEST_MAX_DEPTH = 3;

interface FoundProject {
  /** repo-relative path to the tsconfig.json */
  path: string;
  /** levels below the bucket root — shallower projects are suggested first */
  depth: number;
}

/**
 * Walk one bucket, collecting directories that really contain a tsconfig.json.
 * Descent stops AT a project: a project's own subdirectories are not separate
 * projects worth suggesting, and letting one package recurse freely would flood
 * the cap with its internals.
 */
function collectProjects(root: string, dir: string, depth: number, out: FoundProject[]): void {
  if (depth > SUGGEST_MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || SUGGEST_PRUNE.has(entry.name)) continue;
    const child = join(dir, entry.name);
    const candidate = join(child, 'tsconfig.json');
    if (existsSync(candidate)) {
      out.push({ path: relative(root, candidate), depth });
      continue;
    }
    collectProjects(root, child, depth + 1, out);
  }
}

interface TscOutcome {
  code: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * Kill a spawned command's ENTIRE process group, not just the direct child.
 * Mirrors the already-vetted fix in capability/bash-jobs.ts
 * (capability-bash-orphan-kill-2026-06-21): `spawn(..., { detached: true })`
 * makes the child its own process-group leader (pgid === child.pid on Linux),
 * so signalling the NEGATIVE pid reaches it AND every descendant it spawned.
 * Falls back to a direct child kill if the group signal fails, or if `pid` is
 * unavailable (spawn never actually started the process — nothing to reach by
 * pgid, but a direct `.kill()` is still the right no-op-or-signal call rather
 * than silently doing nothing). Never throws.
 */
function killProcessTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, sig); // negative pid → the whole process group
      return;
    } catch {
      /* fall through to a direct kill below */
    }
  }
  try {
    child.kill(sig);
  } catch {
    /* already exited */
  }
}

export function runTsc(args: string[], cwd: string, timeoutMs: number): Promise<TscOutcome> {
  return new Promise((resolvePromise) => {
    let output = '';
    let settled = false;
    // EI-18793290418757939: the old version gated promise resolution on the
    // child's OWN 'close' event even after the timeout fired — it only killed
    // the child and kept waiting. A killed process is not guaranteed to close
    // promptly: under real memory-pressure thrashing (the WI-5471 class,
    // repeatedly observed on this box via the infra-liveness watchdog: "PSI
    // memory full avg60 ≥ 5 — all tasks stalled on memory reclaim/swap"), a
    // SIGKILL'd child can sit reaping in D-state for many extra seconds. That
    // pushed this tool's real wall-clock time past BOTH the outer MCP-transport
    // deadline (~55s) and the dispatch-stack's own hard AbortController timeout
    // (60s default — this tool declares no static `timeoutSec`, so it inherits
    // that default), producing exactly the watchdog signature this bug reports:
    // "exceeded timeout of 60s (handler returned but signal had aborted)" —
    // the handler eventually DID return, just long after the abort fired.
    // Fix: settle the promise the moment OUR OWN timer fires — kill + reap are
    // best-effort background cleanup from then on, never gating the return.
    const settle = (outcome: TscOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    // EI-19342308665972321: `npx tsc` is TWO processes — npx forks a separate
    // `node .../.bin/tsc` grandchild rather than exec-replacing itself. Killing
    // only `child` (the npx wrapper, via `child.kill`) leaves that grandchild
    // ORPHANED and running at full CPU — measured live: the "timed out" compile
    // was still running ~4 minutes after this tool returned `error:'timeout'`,
    // invisible to the task ledger and unattributable except by reading argv out
    // of `pgrep`. `detached: true` makes `child` the process-group leader, so
    // `killProcessTree` (negative-pid kill) reaches npx AND the tsc grandchild —
    // the same fix bash-jobs.ts already applies to `capability:bash`'s spawned
    // shells. Never `unref()`d, so the operator still tracks + reaps it normally.
    const child = spawn('npx', ['tsc', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // EI-20019651513530828: without a pinned heap this OOMs on operator-core
      // (~9k files vs node's default ~4GB old-space) and is killed BEFORE emitting
      // any diagnostics — which parses as zero errors, i.e. a clean pass.
      env: { ...process.env, ...tscHeapEnv() },
    });
    const timer = setTimeout(() => {
      killProcessTree(child, 'SIGTERM');
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 5000).unref();
      settle({ code: null, timedOut: true, output });
    }, timeoutMs);
    // Diagnostics are the payload here (unlike testing:run, where the router's
    // output is only an error-path fallback), so the buffer is generous: a
    // full-repo check can emit thousands of lines and truncating the HEAD would
    // silently drop errors rather than merely losing context.
    const append = (b: Buffer) => { output = (output + b.toString('utf8')).slice(-8 * 1024 * 1024); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => { settle({ code: null, timedOut: false, output: `${output}\n[spawn-error] ${e.message}` }); });
    child.on('close', (code) => { settle({ code, timedOut: false, output }); });
  });
}

/**
 * Resolve a project operand the way tsc does: a directory means
 * `<dir>/tsconfig.json`, a file means itself. Returns null when nothing is there.
 */
export function resolveProjectPath(root: string, project: string): string | null {
  const abs = isAbsolute(project) ? project : resolve(root, project);
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      const candidate = join(abs, 'tsconfig.json');
      return existsSync(candidate) ? candidate : null;
    }
    return existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

export type TypecheckRootSource = 'requested' | 'integration-root';

export interface SelectedTypecheckRoot {
  root: string;
  source: TypecheckRootSource;
}

export type TypecheckCwdSource = 'caller' | 'external-project';

export interface SelectedTypecheckCwd {
  cwd: string;
  source: TypecheckCwdSource;
}

/**
 * Select the checkout that actually contains the requested TypeScript project.
 *
 * A valid caller root remains authoritative. A phantom harness root may fall back
 * to the explicitly published integration checkout, but only when that checkout
 * resolves the same project operand. When neither root resolves it, preserve the
 * caller root so the handler's existing `project_not_found` refusal stays loud and
 * reports the tree the caller actually supplied.
 */
export function selectTypecheckRoot(
  project: string,
  requestedRoot: string,
  integrationRoot = resolveCapabilityIntegrationRoot(),
): SelectedTypecheckRoot {
  const preferred: SelectedTypecheckRoot = { root: requestedRoot, source: 'requested' };
  const selected = selectUnambiguousEvidenceRoot<TypecheckRootSource>({
    preferred,
    ...(integrationRoot
      ? { fallback: { root: integrationRoot, source: 'integration-root' as const } }
      : {}),
    resolvesEvery: (root) => resolveProjectPath(root, project) !== null,
  });
  return selected ?? preferred;
}

/**
 * Pick the cwd used to launch the compiler after the project config is resolved.
 *
 * `npx` resolves a package-local binary from its cwd. Keeping the caller workspace
 * as cwd for an absolute project outside that workspace therefore runs the caller's
 * TypeScript against the target config (EI-22565359278502654). That is especially
 * misleading when the target intentionally pins a different compiler version.
 * Relative and in-tree absolute operands retain the existing workspace cwd; an
 * external absolute operand runs from the directory containing its tsconfig so its
 * own `node_modules/.bin/tsc` (or nearest package-local ancestor) wins.
 */
export function resolveTypecheckCwd(
  project: string,
  requestedRoot: string,
  resolvedProject: string,
): SelectedTypecheckCwd {
  const rel = relative(requestedRoot, resolvedProject);
  const outsideRequestedRoot = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!isAbsolute(project) || !outsideRequestedRoot) {
    return { cwd: requestedRoot, source: 'caller' };
  }
  return { cwd: dirname(resolvedProject), source: 'external-project' };
}

/**
 * Real tsconfigs near the repo root, so a refusal names what the caller could
 * have meant. This is the whole reason the refusal is useful rather than merely
 * correct: an agent who typed `-p .` out of habit needs the list, not a scolding.
 *
 * The buckets are INTERLEAVED rather than concatenated. Filling the cap in
 * order put all 12 slots into `packages/` (it alone holds more than the cap), so
 * an agent who meant `apps/operator-vite` was handed twelve suggestions with not
 * one `apps/` entry among them — a list that is technically correct and
 * practically useless. Caught by live verification, not by the unit suite.
 *
 * `requested` — the operand that just failed — RANKS the list. Without it the
 * cap is the whole problem again in a new place (EI-19302566985147894): widening
 * the scan to find nested projects changed nothing on the real tree, because the
 * 12 slots are filled by depth-1 projects long before any `libs/papercusp/**`
 * entry is reached. A generic list cannot help someone who asked for a specific
 * path; the projects sharing that path's prefix are the only ones they plausibly
 * meant, so those go first. Verified against the live repo, not just fixtures.
 */
export function suggestProjects(root: string, requested?: string): string[] {
  const byBucket: string[][] = [];
  for (const bucket of SUGGEST_ROOTS) {
    const dir = resolve(root, bucket);
    if (!existsSync(dir)) continue;
    const found: FoundProject[] = [];
    collectProjects(root, dir, 1, found);
    if (found.length === 0) continue;
    // Shallowest first, then alphabetical: a top-level `libs/flags` still
    // outranks a submodule's `libs/papercusp/libs/db` for the same cap slot,
    // so widening the scan cannot demote the suggestions that were there
    // before — it only fills slots the old one-level scan left empty.
    found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    byBucket.push(found.map((f) => f.path));
  }

  const interleaved: string[] = [];
  for (let i = 0; interleaved.length < MAX_SUGGESTIONS; i += 1) {
    const before = interleaved.length;
    for (const bucket of byBucket) {
      if (interleaved.length >= MAX_SUGGESTIONS) break;
      if (i < bucket.length) interleaved.push(bucket[i]);
    }
    if (interleaved.length === before) break; // every bucket exhausted
  }

  const related = requested ? relatedProjects(byBucket, requested) : [];
  if (related.length === 0) return interleaved;
  // Related first, then the generic list fills whatever cap remains. Dedupe so a
  // project that is both related and generically-ranked appears once.
  const ordered = [...related];
  for (const p of interleaved) {
    if (ordered.length >= MAX_SUGGESTIONS) break;
    if (!ordered.includes(p)) ordered.push(p);
  }
  return ordered.slice(0, MAX_SUGGESTIONS);
}

/**
 * Projects whose path shares a leading directory prefix with what the caller
 * asked for, most-specific first. Matching on whole path SEGMENTS (not raw
 * characters) is deliberate: `libs/pap` must not look like a partial match for
 * `libs/papercusp`, or a typo would rank above a real neighbour.
 */
function relatedProjects(byBucket: string[][], requested: string): string[] {
  const wanted = requested.replace(/\\/g, '/').replace(/\/?(tsconfig\.json)?\/*$/, '').split('/').filter(Boolean);
  if (wanted.length === 0) return [];
  const scored: { path: string; shared: number }[] = [];
  for (const bucket of byBucket) {
    for (const path of bucket) {
      const segs = path.split('/').slice(0, -1); // drop the trailing tsconfig.json
      let shared = 0;
      while (shared < segs.length && shared < wanted.length && segs[shared] === wanted[shared]) shared += 1;
      if (shared > 0) scored.push({ path, shared });
    }
  }
  scored.sort((a, b) => b.shared - a.shared || a.path.localeCompare(b.path));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.path);
}

/**
 * Build the recovery guidance for a foreground timeout.
 *
 * A first project-wide timeout can be usefully narrowed to the caller's files,
 * but a timeout from an already-scoped run proves that the requested import
 * graph is itself too large. Recommending another scoped run in that branch
 * sends callers into a deterministic retry loop (EI-20277722187795413).
 */
export function buildTimeoutHint(project: string, timeoutMs: number, alreadyScoped: boolean): string {
  const prefix =
    `hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (held below the ~55s MCP transport limit so you get this instead of an opaque CONNECTION_CLOSED). `;

  if (alreadyScoped) {
    return (
      prefix +
      `SCOPED RUN ALSO TIMED OUT, so this import graph is too large for the foreground cap; re-running the same scoped check will repeat the timeout. ` +
      `Run the repo's operator-core baseline gate instead: ` +
      `npm run lint:tsc -- --files=path/to/changed.ts,path/to/another.ts. ` +
      `This uses the configured heap and per-file baseline, while the explicit file list ` +
      `avoids attributing a peer's dirty working-tree edits to you. ` +
      `Do NOT fall back to a hand-rolled \`npx tsc\`: \`-p .\` checks ZERO files here, and piping a real run through \`head\`/\`grep\` truncates PATH-ORDERED output, so your file can be silently absent and read as clean.`
    );
  }

  return (
    prefix +
    `CHEAPEST NEXT STEP (one call): re-run scoped to your own files — ` +
    `build:typecheck { project: '${project || '.'}', files: ['<your changed files>'], scopeToFiles: true }. ` +
    `That compiles only those files + their import graph; cost tracks YOUR import graph, not the project (measured: leaf 2.6s, hub 63s), so it fixes this for a leaf file but a hub can still time out. ` +
    `It also does NOT see errors your change caused in files that do not import yours. ` +
    `For the full project-wide answer, run the repo's operator-core baseline gate instead: ` +
    `npm run lint:tsc -- --files=path/to/changed.ts,path/to/another.ts. ` +
    `This uses the configured heap and per-file baseline, while the explicit file list ` +
    `avoids attributing a peer's dirty working-tree edits to you. ` +
    `Do NOT fall back to a hand-rolled \`npx tsc\`: \`-p .\` checks ZERO files here, and piping a real run through \`head\`/\`grep\` truncates PATH-ORDERED output, so your file can be silently absent and read as clean.`
  );
}

/**
 * EI-19297428004790873 — build a throwaway tsconfig that checks ONLY the given files
 * and their import graph, so a project too big to typecheck inline under fleet load
 * still has a fast, HONEST answer.
 *
 * Why this exists at all: the foreground cap (~50s, held below the transport's ~55s)
 * is not raisable, so on a big workspace under load the tool could only ever hand back
 * `error:'timeout'`. The documented next step (a detached `capability:inspect` + poll)
 * is several calls, so agents hand-rolled `npx tsc -p ... | head -25` instead — which
 * lies in the GREEN direction: tsc emits path-ordered, so on a project with a
 * pre-existing error backlog the head budget is consumed by unrelated files and your
 * file never appears. A zero-hit grep over that output is indistinguishable from a
 * pass, and whether you get away with it depends on your file's ALPHABETICAL position
 * relative to an unrelated backlog. This mode removes the reason to hand-roll.
 *
 * THREE TRAPS, all hit while proving the recipe out — do not "simplify" them away:
 *  1. The config lives OUTSIDE the tree (writing it inside would be swept into a commit
 *     by git-sync, which commits the whole shared tree). That means `typeRoots` MUST be
 *     absolute — left relative, `@types` resolves against the temp dir and every ambient
 *     type vanishes, producing a flood of phantom errors.
 *  2. `include: []` is required alongside `files`. Without it the extended project's own
 *     `include` globs survive and pull the entire project back in, silently restoring the
 *     very cost this mode exists to avoid — and it still LOOKS scoped.
 *  3. `types` must be listed EXPLICITLY. Absolute `typeRoots` (trap 1) is necessary but
 *     NOT sufficient: with `types` left undefined, TS's automatic "@types under typeRoots"
 *     inclusion does not survive the config living in a temp dir, so every ambient global
 *     disappears — the identical phantom-error flood trap 1 is about, from a different
 *     cause. It hid because the projects this mode was proved on (operator-core) declare
 *     `types: ["node"]` in their OWN tsconfig and so were immune; a project that does not
 *     (apps/operator) got a wall of nonsense. MEASURED 2026-08-02 on
 *     apps/operator/scripts/hooks/cc/__tests__/pc-heavy.test.ts: 28 errors, every one a
 *     "Cannot find name 'process'" / "Cannot find name 'node:fs'" phantom -> 0 errors with
 *     `types` populated, same file, same everything else.
 *
 *     The list is READ from disk rather than hardcoded to `["node"]` so this reproduces
 *     TS's own default faithfully instead of guessing: hardcoding node would both miss a
 *     project's other ambient packages AND inject node globals into a DOM-only project,
 *     where `process` SHOULD be an error and would silently start passing.
 *
 * `extends` is absolute for the same reason as (1): a relative extends would resolve
 * against the temp dir.
 */
/**
 * The `@types/*` packages tsc would auto-include for a config whose `types` is undefined
 * — i.e. every directory directly under `typeRoot`. Returned as bare package names
 * (`node`, `babel__core`), which is the form `compilerOptions.types` expects.
 *
 * Returns [] on any read failure, and the caller then OMITS `types` entirely: emitting
 * `types: []` would be strictly worse than not setting it, because it means "include NO
 * ambient packages" and would guarantee the very phantom-error flood this exists to stop.
 */
export function ambientTypePackages(typeRoot: string): string[] {
  try {
    return readdirSync(typeRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Does this project (or anything in its `extends` chain) DECLARE `compilerOptions.types`?
 *
 * This gate is why the trap-3 fix is not simply "always set `types`". A project that
 * declares `types` has usually done so to EXCLUDE things, and an explicit `types` in the
 * extending config silently overrides the inherited one. MEASURED 2026-08-02: injecting
 * the full 96-package enumeration into a scoped run of packages/operator-core took it from
 * 1 error to 92 — operator-core pins `types: ["node"]` precisely to keep the other ambient
 * test-framework globals out, and overriding it dragged them all back in. So: declared ⇒
 * inherit it untouched; undeclared ⇒ supply the enumeration tsc would have used anyway.
 *
 * Fails OPEN (returns true ⇒ "leave it alone") on an unreadable/malformed config: the
 * enumeration is a repair for a known-broken case, never something to force on a project
 * whose intent we could not read.
 */
function projectDeclaredTypes(tsconfigAbs: string, depth = 0): string[] | undefined | null {
  if (depth > 8) return null; // unknown: cyclic or absurd extends chain — do not intervene
  let parsed: { compilerOptions?: { types?: unknown }; extends?: unknown };
  try {
    const raw = readFileSync(tsconfigAbs, 'utf8');
    // Plain JSON FIRST, and only fall back to comment-stripping if that fails.
    //
    // Not an optimisation — stripping unconditionally is actively WRONG here. tsconfig
    // path aliases contain `/*` (`"@/*": ["./*"]`), which a block-comment regex happily
    // treats as the start of a comment and eats through the rest of `paths`. That made
    // apps/operator's perfectly valid JSON unparseable, and since this function fails
    // open, every project silently reported "declares types" and the repair never ran —
    // a fix that quietly did nothing while its tests looked fine.
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(
        raw
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/,(\s*[}\]])/g, '$1'),
      );
    }
  } catch {
    return null;
  }
  if (parsed?.compilerOptions && 'types' in parsed.compilerOptions) {
    const types = parsed.compilerOptions.types;
    return Array.isArray(types) && types.every(type => typeof type === 'string') ? types : null;
  }
  const ext = parsed?.extends;
  if (typeof ext !== 'string' || ext.length === 0) return undefined;
  // Only a relative/absolute path extends is resolvable here; a bare package specifier
  // (e.g. "@tsconfig/node20/tsconfig.json") is treated as declaring, i.e. hands-off.
  if (!ext.startsWith('.') && !isAbsolute(ext)) return null;
  const next = isAbsolute(ext) ? ext : resolve(dirname(tsconfigAbs), ext);
  const withExt = existsSync(next) ? next : `${next}.json`;
  if (!existsSync(withExt)) return null;
  return projectDeclaredTypes(withExt, depth + 1);
}

export function projectDeclaresTypes(tsconfigAbs: string, depth = 0): boolean {
  return projectDeclaredTypes(tsconfigAbs, depth) !== undefined;
}

/**
 * Find project-local ambient declaration files that the inherited `include` globs
 * would normally add to the program. Scoped configs replace those globs with
 * `include: []`, so an unimported declaration such as apps/operator/css-modules.d.ts
 * otherwise disappears and side-effect CSS imports surface as TS2882.
 *
 * Dependency and generated trees are deliberately pruned: imported declarations are
 * still followed by tsc, while dependency globals are restored through `typeRoots`
 * and the explicit ambient package list above.
 */
const SCOPED_DECLARATION_PRUNE = new Set([
  ...SUGGEST_PRUNE,
  '.next',
  '.turbo',
  'out',
  'target',
]);

function collectAmbientDeclarationFiles(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SCOPED_DECLARATION_PRUNE.has(entry.name)) {
        collectAmbientDeclarationFiles(fullPath, out);
      }
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      out.push(fullPath);
    }
  }
}

export function ambientDeclarationFiles(projectDir: string): string[] {
  const files: string[] = [];
  collectAmbientDeclarationFiles(projectDir, files);
  return files.sort();
}

/**
 * Resolve the scoped `files` the way both engines judge them, so the shared service and the
 * CLI fallback always answer about the same requested set.
 */
export function resolveScopedFiles(
  root: string,
  projectTsconfigAbs: string,
  requestedFiles: string[],
): { resolvedFiles: string[]; missing: string[] } {
  const resolvedFiles: string[] = [];
  const missing: string[] = [];
  for (const f of requestedFiles) {
    // Match capability:inspect's scoped path contract: callers may use a
    // repository-relative path, a path relative to the selected project, or an
    // absolute path. Repository-relative wins when both spellings happen to
    // resolve, preserving the meaning of an explicit repo path while still
    // making the common `files: ['lib/foo.ts']` package call shape work.
    const candidates = isAbsolute(f)
      ? [f]
      : [resolve(root, f), resolve(dirname(projectTsconfigAbs), f)];
    const abs = candidates.find((candidate) => {
      try {
        return existsSync(candidate) && statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (abs) resolvedFiles.push(abs);
    else missing.push(f);
  }
  return { resolvedFiles, missing };
}

export function buildScopedTsconfig(
  root: string,
  projectTsconfigAbs: string,
  requestedFiles: string[],
): { configPath: string; cleanup: () => void; resolvedFiles: string[]; missing: string[] } {
  const { resolvedFiles, missing } = resolveScopedFiles(root, projectTsconfigAbs, requestedFiles);

  const declarationFiles = ambientDeclarationFiles(dirname(projectTsconfigAbs));
  const scopedFiles = [...new Set([...resolvedFiles, ...declarationFiles])];
  const typeRoot = join(root, 'node_modules', '@types');
  // Only repair a project that declares NO `types` — see projectDeclaresTypes for the
  // measured reason overriding a declared one is destructive.
  const declaredTypes = projectDeclaredTypes(projectTsconfigAbs);
  const ambientTypes = declaredTypes !== undefined ? [] : ambientTypePackages(typeRoot);
  const dir = mkdtempSync(join(tmpdir(), 'pc-typecheck-scoped-'));
  const configPath = join(dir, 'tsconfig.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        extends: projectTsconfigAbs,
        compilerOptions: {
          noEmit: true,
          incremental: false,
          // The throwaway config lives under /tmp. Without an absolute rootDir here,
          // TypeScript resolves an inherited/implicit rootDir against that temp
          // directory and rejects every real workspace file with TS6059. Scoped runs
          // may include imports from anywhere in the workspace, so anchor the synthetic
          // program at the real workspace root rather than the temp config directory.
          rootDir: root,
          // An explicit package subpath such as vitest/globals lives outside
          // @types. /tmp cannot find the project's node_modules by ancestry.
          // Add that search root only with a KNOWN explicit list, so implicit
          // discovery cannot inject every package's globals into the program.
          typeRoots: Array.isArray(declaredTypes) ? [typeRoot, join(root, 'node_modules')] : [typeRoot],
          // Trap 3 above — enumerated, not hardcoded, so this mirrors what tsc would have
          // auto-included. Omitted entirely when the scan finds nothing, so an unreadable
          // or absent @types dir degrades to today's behaviour rather than pinning `types`
          // to [] and deleting every ambient global we were trying to preserve.
          ...(ambientTypes.length > 0 ? { types: ambientTypes } : {}),
        },
        // `include: []` keeps the run scoped, but the original project globs also
        // carried unimported ambient declarations. Restore only those project-local
        // declarations; imported declarations remain in the normal import graph.
        files: scopedFiles,
        include: [],
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    configPath,
    resolvedFiles,
    missing,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leaked temp dir is harmless; never fail a typecheck over cleanup */
      }
    },
  };
}

/**
 * WI-10003415 / plan host-memory-reduction-2026-09-27 P-011 — a scoped run asks the shared
 * typecheck service first.
 *
 * 248 of this tool's 321 calls in the 7 days to 2026-09-27 were `scopeToFiles` runs on
 * operator-core, and each paid its own compile of the requested files' import graph: a hub file
 * pulls in most of the ~17.7k-file program (13 GB, 63 s, past the foreground cap). The service
 * (scripts/tsc-service/server.mjs, shared with `lint:tsc --files`) keeps the program loaded and
 * checks only what the verdict depends on. Measured on the live service: a hub file 1.4 s, a
 * cold start 2.8 s, a file with 1,069 importers 14.5 s.
 *
 * The two engines check DIFFERENT neighbourhoods, so the result names which one answered:
 *   - tsc-service: the requested files inside the FULL project program (the verdict the
 *     project-wide run gives them), plus files that reference their exported types and their
 *     direct importers. That is the reverse graph, where a change's breakage lands.
 *   - tsc-cli: a throwaway program of the requested files and their import graph. That is the
 *     forward graph, so otherErrors are in files they import.
 *
 * Whatever the service cannot answer faithfully falls back to the CLI: unreachable, declined
 * (another checkout, a declaration-emitting project, a checked set too wide), or a requested
 * file outside the project's program. The service never checked that file, so it must not
 * report it clean.
 */
const SERVICE_CLI_RESERVE_MS = 15_000;

/**
 * The share of the foreground budget the service may use. The rest stays with the CLI fallback,
 * so a wedged service degrades to the old path instead of turning every scoped call into a
 * timeout.
 */
export function serviceBudgetMs(timeoutMs: number): number {
  return Math.max(1000, timeoutMs - Math.min(SERVICE_CLI_RESERVE_MS, Math.floor(timeoutMs / 3)));
}

export type TypecheckServiceAttempt =
  | { served: true; response: Extract<TscServiceResponse, { ok: true }> }
  | { served: false; reason: string };

export async function askTypecheckService(opts: {
  root: string;
  project: string;
  files: string[];
  timeoutMs: number;
  env?: Record<string, string | undefined>;
}): Promise<TypecheckServiceAttempt> {
  const env = opts.env ?? process.env;
  if (env[TSC_SERVICE_ENV] === '0') return { served: false, reason: `${TSC_SERVICE_ENV}=0` };
  const socketPath = tscServiceSocketPath(env);
  let response: TscServiceResponse;
  try {
    response = await requestTscService({
      socketPath,
      request: { v: 1, root: opts.root, project: opts.project, files: opts.files },
      timeoutMs: opts.timeoutMs,
    });
  } catch (error) {
    return {
      served: false,
      reason: `unreachable at ${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    return { served: false, reason: `declined: ${response.reason}${response.detail ? ` (${response.detail})` : ''}` };
  }
  if (response.namedNotInProgram.length > 0) {
    return {
      served: false,
      reason: `not in the project's program, so the service never checked them: ${response.namedNotInProgram.join(', ')}`,
    };
  }
  return { served: true, response };
}

export default defineTool({
  name: 'build:typecheck',
  description:
    'Run `tsc --noEmit` for ONE project and return structured diagnostics — { ok, errorCount, errors:[{file,line,column,code,message}], byFile, syntaxBroken, semanticCheckIncomplete } — instead of a compiler log you pipe through grep/tail. In scopeToFiles mode, ok/errorCount/exitCode describe the requested files, while otherErrorCount/otherErrors preserve other-file diagnostics separately. Parser/global/partial-scope failures remain incomplete, never green. When syntaxBroken is non-empty, semanticCheckIncomplete is true and the diagnostic counts are LOWER BOUNDS, not complete totals. REFUSES a run that checked zero files. Such a run (TS5057/TS5058/TS18003) is refused rather than reported as a clean zero: this repo has no root tsconfig.json, so `-p .` silently checks zero files. `files` filters diagnostics server-side. Runs with --incremental false so a warm tsbuildinfo cannot under-report.',
  guidance: {
    when: 'You edited TypeScript and want to know whether a project typechecks, and exactly which errors are where. Also the way to check a workspace OUTSIDE operator-core, which `npm run lint:tsc` does not cover.',
    notWhen:
      'You want the baseline VERDICT on whether your change added errors — that is `npm run lint:tsc -- --files=…` (per-file ratchet, peer-drift aware), which this tool does not replace. Not for building/emitting, eslint, or cargo.',
    chaining:
      'build:typecheck { project, files } → fix → re-run scoped to the same `files`; then `npm run lint:tsc -- --files=<same files>` for the gate verdict.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  // EI-18793290418757939: declare the REAL wall-clock budget instead of inheriting
  // dispatch-stack's generic 60s default. The handler's own worst case is bounded by
  // FOREGROUND_TIMEOUT_CEILING_MS (50s) now that runTsc() resolves at its own timer
  // instead of blocking on the child's 'close' event — this margin covers scheduling
  // + serialization overhead, not process-kill latency. Keeping this declared (rather
  // than implicit) means dispatch-stack's AbortController and _mcp-handler's
  // effectiveMcpDeadlineMs both derive their budget from the SAME number this tool
  // actually honors, so the three layers can't silently drift apart again the way they
  // did here (the tool waited past a 60s abort it never knew about).
  timeoutSec: 58,
  // EI-18803497769946984: the handler shells out to `tsc` and blocks for as long as
  // that takes (observed up to 141s) without ever reading `ctx.tx`. Holding the
  // ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s) and surfaces as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    project: z
      .string()
      .min(1)
      .max(400)
      .describe(
        'tsconfig path, or a directory containing one — repo-root-relative or absolute (e.g. "packages/operator-core" or "apps/operator/tsconfig.json"). REQUIRED and deliberately un-defaulted: this repo has no root tsconfig.json, so any default would be the exact silent no-op this tool exists to refuse.',
      ),
    files: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe(
        'Return only diagnostics in these files (matched by path suffix). The server-side form of `| grep -E "myfile"` — the whole project is still checked, so counts stay honest; `errorCount` is the filtered count and `totalErrorCount` the project-wide one.',
      ),
    dirs: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        'Return only diagnostics whose file falls under one of these directories — a repo-relative PREFIX match anchored at a path-segment boundary ("apps/operator" cannot match "apps/operator-vite"). The server-side form of `grep -E "^dir/"`, for a directory-ATTRIBUTION question `files` (suffix match) cannot express, e.g. "does ANY error fall under apps/operator-vite/?" (EI-22050606808498557). Combines with `files` as an OR: a diagnostic matching either is kept. `errorCount` is the filtered count; `totalErrorCount` the project-wide one.',
      ),
    maxErrors: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        `Cap the returned errors list (default ${DEFAULT_MAX_ERRORS}). Counts stay complete; errorsTruncated and byFileTruncated flag bounded arrays.`,
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Hard budget for the compile. Default ${DEFAULT_TIMEOUT_MS}ms, but a FOREGROUND run is clamped to ${FOREGROUND_TIMEOUT_CEILING_MS}ms — below the ~55s MCP transport cap — so an over-long compile returns an actionable timeout instead of an opaque transport error. A project that needs longer (packages/operator-core is ~104s) KEEPS these structured diagnostics via scopeToFiles, or "npm run lint:tsc -- --files=..." for the baseline-gated verdict; a detached capability:inspect { run_in_background: true } run returns a raw LOG, not these diagnostics.`,
      ),
    incremental: z
      .boolean()
      .optional()
      .describe(
        'Allow tsc to use a warm tsconfig.tsbuildinfo. Default false — EI-487: an incremental run UNDER-reports errors in files the cache has not reindexed, which read as green for days. Only set true when you want a fast re-check and already know the tree is warm.',
      ),
    scopeToFiles: z
      .boolean()
      .optional()
      .describe(
        'Check ONLY `files` instead of the whole project, so a run fits the foreground cap under fleet load. Requires `files`; each path may be repository-relative, relative to the selected project directory, or absolute. `engine` says who answered. engine:"tsc-service" — the shared typecheck service (when it serves this checkout and project): your files are checked inside the FULL program, and otherErrors cover files that reference their exported types or import them directly; measured 1.4s for a hub file. engine:"tsc-cli" (serviceFallback says why) — a throwaway program of `files` + their import graph, so otherErrors are in files they import; cost is YOUR import graph (leaf 2.6s, hub 63s), so a hub can time out. Either way ok/errorCount/errors/exitCode describe the requested files, otherErrorCount/otherErrors stay separate, and parser/global/partial-scope failures make scopedVerdict incomplete rather than green. ⚠ NARROWER GUARANTEE: neither sees every file your change can break (a transitive importer on the service, any non-importer on the CLI). For the gate verdict use the project-wide run or `npm run lint:tsc -- --files=...`.',
      ),
  }),
  async handler(args, ctx) {
    // EI-1754 (same defect as testing:run): `inferWorkspaceRoot()` walks up from
    // `process.cwd()`, and the :3070 operator runs FROM the release checkout — so
    // this tool typechecked the RELEASE tree, not the tree the agent just edited,
    // and reported it clean. Start from the same projectDir-aware workspace root
    // every capability tool uses, then recover from a phantom root only when the
    // explicitly published integration checkout resolves THIS project operand.
    const requestedRoot = resolveAgentWorkspaceRoot(ctx);
    const root = selectTypecheckRoot(args.project, requestedRoot).root;
    const started = Date.now();

    // Pre-flight the project so the refusal can be specific and name alternatives.
    // tsc's own verdict (below) stays authoritative — this only catches the case
    // early and with a better message.
    const resolved = resolveProjectPath(root, args.project);
    if (!resolved) {
      return {
        data: {
          ok: false,
          error: 'project_not_found',
          project: args.project,
          searchedFrom: root,
          message:
            `No tsconfig at "${args.project}". Nothing would have been typechecked — ` +
            'this is the failure mode the tool refuses rather than reporting zero errors.' +
            (existsSync(resolve(root, 'tsconfig.base.json')) && /^\.?$|^tsconfig\.json$/.test(args.project)
              ? ' The repo root has only tsconfig.base.json (a shared base, not a project), which is why `-p .` and `-p tsconfig.json` check nothing here.'
              : ''),
          availableProjects: suggestProjects(root, args.project),
        },
      };
    }

    // `npx tsc` searches from cwd. For a project explicitly outside the caller's
    // workspace, launch from the target config directory so the target's package-local
    // TypeScript is used instead of the caller repo's compiler. This cwd also feeds the
    // scoped throwaway config: its rootDir and ambient typeRoot must describe the target
    // project, not the unrelated caller workspace.
    const typecheckCwd = resolveTypecheckCwd(args.project, root, resolved).cwd;

    // Clamp BELOW the ~55s MCP transport cap so this handler always wins the race and can
    // return the structured timeout below, instead of the transport killing the call and
    // surfacing an opaque `CONNECTION_CLOSED 127.0.0.1:6432` (EI-18776865728050036).
    const timeoutMs = clampForegroundTimeoutMs(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    // EI-19297428004790873: scoped mode swaps the project for a throwaway config over just
    // `files` + their import graph. Refuse the two ways it could silently check NOTHING —
    // same ethos as the project_not_found and tsc_failed_to_run guards: this tool never
    // reports a zero it did not earn.
    let scoped: ReturnType<typeof resolveScopedFiles> | null = null;
    let service: TypecheckServiceAttempt | null = null;
    if (args.scopeToFiles) {
      if (!args.files?.length) {
        return {
          data: {
            ok: false,
            error: 'scope_requires_files',
            message:
              'scopeToFiles:true needs `files` — with no files the generated config would compile an EMPTY program and exit 0, i.e. report a clean zero having checked nothing.',
          },
        };
      }
      scoped = resolveScopedFiles(typecheckCwd, resolved, args.files);
      if (!scoped.resolvedFiles.length) {
        return {
          data: {
            ok: false,
            error: 'scope_files_not_found',
            project: relative(root, resolved),
            missing: scoped.missing,
            searchedFrom: root,
            message:
              'None of the requested `files` exist on disk, so the scoped program would be empty and tsc would exit 0 — a clean zero that checked nothing. Paths are resolved as repository-relative first, then relative to the selected project directory, or pass absolute; note this differs from the non-scoped `files` filter, which matches by path SUFFIX.',
          },
        };
      }
      // The service holds only its own checkout's programs, and an external project must run
      // its own package-local compiler (resolveTypecheckCwd), so only an in-tree project asks.
      service =
        typecheckCwd === root
          ? await askTypecheckService({
              root,
              project: resolved,
              files: scoped.resolvedFiles,
              timeoutMs: serviceBudgetMs(timeoutMs),
            })
          : { served: false, reason: 'external project runs its own package-local compiler' };
    }
    const engineFields = {
      engine: service?.served ? ('tsc-service' as const) : ('tsc-cli' as const),
      ...(service && !service.served ? { serviceFallback: service.reason } : {}),
    };

    let outcome: TscOutcome;
    if (service?.served) {
      // tsgo 7.0.2 exits 1 for any error under --noEmit and 0 when clean (measured 2026-09-27),
      // so the service's verdict carries the status the CLI would have given it.
      outcome = {
        code: service.response.errorCount > 0 ? 1 : 0,
        timedOut: false,
        output: service.response.output,
      };
    } else {
      const scopedConfig = scoped ? buildScopedTsconfig(typecheckCwd, resolved, args.files ?? []) : null;
      const tscArgs = ['--noEmit', '--pretty', 'false', '-p', scopedConfig ? scopedConfig.configPath : resolved];
      if (args.incremental !== true) tscArgs.push('--incremental', 'false');

      const workspaceId =
        (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : undefined) ??
        (ctx.principal?.workspaceId && ctx.principal.workspaceId !== '*' ? ctx.principal.workspaceId : undefined) ??
        activeWorkspaceId();
      const execution = await beginGovernedExecution(
        {
          idempotencyKey: `build:typecheck:${ctx.principal?.slug ?? 'operator'}:${randomUUID()}`,
          admissionClass: 'process',
          demand: { cpuWeight: 1, memoryBytes: 512 * 1024 * 1024 },
          payloadRef: `build:typecheck:${relative(root, resolved)}`,
          metadata: { project: relative(root, resolved), scoped: args.scopeToFiles === true },
        },
        { owner: ctx.principal?.slug ?? 'build:typecheck' },
        governedExecutionRuntime(workspaceId, 'build-typecheck'),
      );

      // A declined or unreachable service already spent part of the foreground budget; the
      // compile gets what is left, so the handler still returns before the transport cap.
      const cliTimeoutMs = service ? Math.max(1000, timeoutMs - (Date.now() - started)) : timeoutMs;
      try {
        outcome = await runTsc(tscArgs, typecheckCwd, cliTimeoutMs);
        await execution.finish();
      } catch (error) {
        await execution.cancel(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        scopedConfig?.cleanup();
      }
    }
    const durationMs = Date.now() - started;

    if (outcome.timedOut) {
      return {
        data: {
          ok: false,
          error: 'timeout',
          project: relative(root, resolved),
          timeoutMs,
          durationMs,
          // The whole point of the clamp: a timeout must hand back a WORKING next step, not a
          // dead end. A first project-wide timeout can try the cheap scoped path; once that
          // path itself timed out, lead with the reachable baseline gate instead of looping.
          hint: buildTimeoutHint(relative(root, resolved) || '.', timeoutMs, args.scopeToFiles === true),
          ...engineFields,
          output: outcome.output.slice(-2000),
        },
      };
    }

    const diagnostics = parseTscDiagnostics(outcome.output);

    // A run that produced no diagnostics AND did not exit 0 never really ran —
    // never let that read as "clean". Same guard the baseline gate applies.
    if (diagnostics.length === 0 && outcome.code !== 0) {
      // EI-22142032090978471 — one toolchain failure is common enough, and mis-diagnosed
      // expensively enough, to name: `npx` could not find a local tsc binary and ran the
      // unrelated REGISTRY package called `tsc` instead, which only prints a banner. The
      // generic message below is true but sends the reader after the project operand or
      // the tsconfig; the actual condition is a missing/half-written node_modules.
      const ranDecoy = TSC_DECOY_BANNER.test(outcome.output);
      return {
        data: {
          ok: false,
          error: ranDecoy ? 'tsc_decoy_package_ran' : 'tsc_failed_to_run',
          project: relative(root, resolved),
          exitCode: outcome.code,
          ...engineFields,
          durationMs,
          message: ranDecoy
            ? 'No TypeScript compiler ran: `npx tsc` found no local tsc binary and executed the unrelated registry package named `tsc`, which only prints a banner. ' +
              'Your project and tsconfig are not implicated — `node_modules/.bin/tsc` is missing or half-written. Run `npm run install:safe`, then retry.'
            : 'tsc exited non-zero with no parseable diagnostics — a toolchain failure, NOT a clean run.',
          output: outcome.output.slice(-2000),
        },
      };
    }

    // EI-24801454238382823 — a file the include glob listed and that was deleted before
    // tsc read it is TREE CHURN on a shared checkout, not a no-input run: every other file
    // WAS checked. Strip it from the verdict and say so. A vanished path that exists AGAIN
    // now (a rewrite-by-rename) was never checked, so it keeps the verdict incomplete.
    const { vanished, rest: checkedDiagnostics } = splitVanishedIncludeFiles(diagnostics);
    const vanishedAbs = vanished.map((p) => (isAbsolute(p) ? p : resolve(typecheckCwd, p)));
    const vanishedStillPresent = vanishedAbs.filter((p) => existsSync(p));
    const inputRaceIncomplete = vanishedStillPresent.length > 0;

    // tsc's own word on "I checked nothing" — catches TS18003 (a real tsconfig
    // whose include/files match no inputs), which no path check can predict.
    const noInput = noInputDiagnostic(diagnostics);
    if (noInput) {
      return {
        data: {
          ok: false,
          error: 'nothing_typechecked',
          project: relative(root, resolved),
          code: noInput.code,
          durationMs,
          message: `${noInput.code}: ${noInput.message} — zero files were typechecked, so this is NOT a clean result.`,
          availableProjects: suggestProjects(root, args.project),
        },
      };
    }

    const errors = errorsOnly(checkedDiagnostics);
    const scopedPartition = scoped ? partitionScopedDiagnostics(errors, scoped.resolvedFiles) : null;
    // In scoped mode `files`/`dirs` defined the PROGRAM, so they must not also narrow the
    // OUTPUT: the scoped program deliberately includes the import graph, and an error your
    // change caused in a file you import is exactly what you need to see. Re-applying either
    // filter here would hide it and hand back a clean-looking zero — the same false-green
    // this mode exists to eliminate.
    const hasFilter = (args.files || args.dirs) && !args.scopeToFiles;
    const shown = scopedPartition
      ? scopedPartition.requested
      : hasFilter
        ? [
            ...new Set([
              ...(args.files ? filterToFiles(errors, args.files) : []),
              ...(args.dirs ? filterToDirs(errors, args.dirs) : []),
            ]),
          ]
        : errors;
    const maxErrors = args.maxErrors ?? DEFAULT_MAX_ERRORS;
    const byFile = summariseByFile(scopedPartition ? scopedPartition.requested : errors);
    const bounded = boundDiagnostics(shown, byFile, maxErrors);
    // The service prints no "Found N errors" summary but counts its own errors; either tally
    // cross-checks the parser below.
    const reported = service?.served ? service.response.errorCount : parseFoundSummary(outcome.output);
    const syntaxBroken = syntaxBrokenFiles(errors);
    const scopedVerdictIncomplete = Boolean(
      scoped &&
      (scoped.missing.length > 0 ||
        (scopedPartition?.unattributed.length ?? 0) > 0 ||
        syntaxBroken.length > 0 ||
        inputRaceIncomplete),
    );
    const scopedOk = Boolean(
      scoped && scopedPartition && scopedPartition.requested.length === 0 && !scopedVerdictIncomplete,
    );
    const otherErrorCapacity = Math.max(0, maxErrors - bounded.errors.length);
    const otherErrors = scopedPartition?.other ?? [];
    const otherErrorsShown = otherErrors.slice(0, otherErrorCapacity);
    const otherByFile = summariseByFile(otherErrors);
    const otherByFileCapacity = Math.max(0, MAX_BY_FILE - bounded.byFile.length);
    const otherByFileShown = otherByFile.slice(0, otherByFileCapacity);

    return {
      data: {
        // tsc exits non-zero on the stripped TS6053 alone, so a vanished-glob run is judged
        // on the diagnostics that remain rather than on the compiler's exit code.
        ok: scoped
          ? scopedOk
          : errors.length === 0 && (outcome.code === 0 || vanished.length > 0) && !inputRaceIncomplete,
        project: relative(root, resolved),
        ...engineFields,
        errorCount: shown.length,
        ...(vanished.length > 0
          ? {
              vanishedDuringRun: vanishedAbs.map((p) => relative(root, p)),
              inputRaceIncomplete,
              ...(inputRaceIncomplete
                ? { vanishedStillPresent: vanishedStillPresent.map((p) => relative(root, p)) }
                : {}),
              inputRaceNote:
                'These files matched the project include glob when tsc listed it and were gone when it read them ' +
                '(tree churn on the shared checkout, e.g. a short-lived scratch directory under the include root). ' +
                'Every other file was checked. ' +
                (inputRaceIncomplete
                  ? 'vanishedStillPresent exist again and were NOT checked, so this verdict is incomplete: re-run.'
                  : 'None of them exists now, so the verdict describes the current tree.'),
            }
          : {}),
        // A scoped PASS is a weaker claim than a project-wide one, so it must never be
        // reported in the same shape. These fields travel with the result so a reader
        // (or a successor reading a checkpoint that quotes it) cannot mistake
        // "this file's import graph compiles" for "my change is safe".
        ...(scoped && scopedPartition
          ? {
              scopedToFiles: scoped.resolvedFiles.map((f) => relative(root, f)),
              ...(scoped.missing.length ? { scopeMissing: scoped.missing } : {}),
              scopedVerdict: scopedVerdictIncomplete
                ? 'incomplete'
                : scopedPartition.requested.length > 0
                  ? 'requested-files-error'
                  : 'requested-files-clean',
              scopedVerdictIncomplete,
              errorsInRequestedFiles: scopedPartition.requested.length,
              totalErrorCount: errors.length,
              otherErrorCount: otherErrors.length,
              otherErrors: otherErrorsShown,
              otherErrorsTruncated: otherErrors.length > otherErrorsShown.length,
              otherByFile: otherByFileShown,
              otherByFileTruncated: otherByFile.length > otherByFileShown.length,
              otherFilesWithErrors: otherByFile.length,
              unattributedErrorCount: scopedPartition.unattributed.length,
              compilerExitCode: outcome.code,
              ...(service?.served
                ? {
                    serviceScope: {
                      checkedFiles: service.response.checked.length,
                      ...service.response.counts,
                      snapshotAgeMs: service.response.snapshotAgeMs,
                      queuedMs: service.response.queuedMs,
                      checkMs: service.response.checkMs,
                    },
                    scopeCaveat:
                      'SCOPED RUN (shared typecheck service) — ok/errorCount/errors/exitCode describe the requested files, checked inside the FULL project program. otherErrorCount/otherErrors cover files that reference their exported types or import them directly, and do not fail that requested-file verdict; missing requested paths make scopedVerdict incomplete instead. A TRANSITIVE importer whose error names none of those types is NOT covered, nor are project-global diagnostics. This is not the gate verdict.',
                  }
                : {
                    scopeCaveat:
                      'SCOPED RUN — ok/errorCount/errors/exitCode describe the requested files. Other loaded import-graph diagnostics remain under otherErrorCount/otherErrors and do not fail that requested-file verdict; parser/global diagnostics or missing requested paths make scopedVerdict incomplete instead. Errors your change caused in files that do not import these are NOT covered (e.g. adding a required field to a shared interface breaks distant fixtures). This is not the gate verdict.',
                  }),
            }
          : {}),
        ...(hasFilter
          ? {
              totalErrorCount: errors.length,
              ...(args.files ? { filteredTo: args.files } : {}),
              ...(args.dirs ? { filteredToDirs: args.dirs } : {}),
            }
          : {}),
        errors: bounded.errors,
        errorsTruncated: bounded.errorsTruncated,
        byFile: bounded.byFile,
        byFileTruncated: bounded.byFileTruncated,
        filesWithErrors: bounded.filesWithErrors,
        syntaxBroken,
        // EI-19278981435037331 — a parser/scanner failure can stop TypeScript before
        // semantic checking reaches the rest of the program. `errorsTruncated:false`
        // only says OUR returned arrays are complete relative to tsc's emitted output;
        // it cannot make that output a complete project verdict. Keep the machine flag
        // adjacent to the counts and add the human caveat only on the unsafe branch, so
        // `2 errors` can never again be compared with a later `615 errors` as like units.
        semanticCheckIncomplete: syntaxBroken.length > 0,
        ...(syntaxBroken.length > 0
          ? {
              countCaveat:
                `Parsing failed in ${syntaxBroken.length} file(s); TypeScript did not complete semantic checking. ` +
                '`errorCount` and `totalErrorCount` (when present) are LOWER BOUNDS, not complete totals. ' +
                '`errorsTruncated:false` means only that the diagnostics TypeScript emitted fit in the returned arrays.',
            }
          : {}),
        durationMs,
        exitCode: scoped ? (scopedOk ? 0 : outcome.code || 2) : outcome.code,
        // Cross-check against tsc's own tally: a mismatch means the diagnostic
        // grammar drifted (a compiler upgrade), and the caller is told rather
        // than handed a silently wrong number.
        ...(reported !== null && reported !== errors.length + vanished.length
          ? {
              parseWarning: `tsc reported ${reported} errors but ${errors.length} were parsed — the diagnostic format may have changed; treat counts as approximate.`,
            }
          : {}),
      },
    };
  },
});
