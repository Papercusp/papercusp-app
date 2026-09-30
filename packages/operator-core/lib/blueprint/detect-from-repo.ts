/**
 * Generate-from-repo detection (kind #1 harness creation) —
 * `harness-blueprint-orchestration-2026-06-03` P-009 / D-023.
 *
 * Given an existing git repo, DETERMINISTICALLY infer the cheap seed for an
 * `extends: coding` blueprint override (no LLM — the gym optimizes the seed
 * later, D-022). The inference covers exactly the four D-023 signals:
 *
 *   1. test command — detected from the ecosystem (package.json scripts / Cargo
 *      / go / pytest / Makefile) or harvested from the repo's instruction docs,
 *      then **VERIFIED by running it once** (the un-skippable D-023 step).
 *   2. the tool set — the detected toolchain(s) + package manager.
 *   3. structural flags — monorepo → recursion (sub-harness per sub-project,
 *      D-016/D-023); frontend → the ui-qa quality gate.
 *   4. harvest `AGENTS.md` / `CLAUDE.md` / `TESTING.md` into the override so the
 *      seed is self-contained / portable (the distribution plan can install it).
 *
 * This module is pure fs + one child-process (the test-verify run). It produces
 * a `DetectionResult` and a `detectionToOverride()` that maps the result onto the
 * frozen `@papercusp/orchestrator/blueprint` schema. The `harness:generate-from-repo`
 * tool composes it with `harness:create`.
 *
 * Override-shape discipline (the loader deep-merges objects, REPLACES arrays):
 *   - only object-valued fields are touched (`knobs`, `recursion`) so the
 *     inherited `coding` `roles`/`reactive`/`spine` arrays are never clobbered.
 *   - `knobs` is `.catchall(unknown)`, so seed keys (`testCommand`, `uiQa`,
 *     `fromRepo`, `projectInstructions`) survive `BlueprintSchema.parse` even
 *     before they are promoted to typed knobs.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { collectChildOutput } from '../child-output';

/**
 * Shell-metacharacter guard for the verify step (audit P-030): test commands
 * can be doc-harvested (arbitrary README text), so verification runs them
 * WITHOUT a shell as a whitespace-split argv. Returns null when the command
 * needs shell syntax — the caller records it as not-auto-verified instead of
 * executing it. Exported for tests.
 */
const SHELL_META_RE = /[|&;<>$`\\!*?(){}[\]~#\n\r'"]/;
export function splitTestCommandArgv(command: string): string[] | null {
  if (SHELL_META_RE.test(command)) return null;
  const argv = command.trim().split(/\s+/).filter(Boolean);
  return argv.length ? argv : null;
}

/** Max bytes of each harvested instruction doc folded into the override. */
const HARVEST_CAP = 8_000;
/** Tail of test output captured on a non-zero / failed verify run. */
const OUTPUT_TAIL = 2_000;
/** Default wall-clock budget for the one test-verify run. */
export const DEFAULT_TEST_TIMEOUT_MS = 120_000;

/** The named repo instruction docs harvested into the override (root-level). */
export const HARVEST_FILES = ['AGENTS.md', 'CLAUDE.md', 'TESTING.md'] as const;

/** Frontend-signalling dependency names (presence in package.json deps). */
const FRONTEND_DEPS = [
  'react',
  'react-dom',
  'vue',
  'svelte',
  '@sveltejs/kit',
  'next',
  'nuxt',
  'astro',
  'solid-js',
  '@angular/core',
  'preact',
  'vite',
  '@vitejs/plugin-react',
  'tailwindcss',
];

/** Frontend-signalling config files at the repo root. */
const FRONTEND_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'svelte.config.js',
  'astro.config.mjs',
  'astro.config.ts',
  'angular.json',
  'index.html',
  'tailwind.config.js',
  'tailwind.config.ts',
];

export interface HarvestedDoc {
  file: string;
  bytes: number;
  truncated: boolean;
  content: string;
}

export interface TestCommandDetection {
  /** The command string (split into an argv and run without a shell). */
  command: string;
  /** Where the command came from. */
  source: 'package.json' | 'cargo' | 'go' | 'pytest' | 'makefile' | (typeof HARVEST_FILES)[number];
  /** Did the verify run exit 0? null when the run was skipped (`runTests:false`). */
  verified: boolean | null;
  /** Process exit code, or null on timeout / spawn error / skipped. */
  exitCode: number | null;
  /** Wall-clock of the verify run in ms, or null when skipped. */
  durationMs: number | null;
  /** True when the run hit the timeout budget. */
  timedOut?: boolean;
  /** Tail of combined stdout+stderr, captured only on a failed/non-zero run. */
  output?: string;
}

export interface DetectionResult {
  repoPath: string;
  isGitRepo: boolean;
  /** Set (with a reason) when generation should be skipped — e.g. the repo already has a blueprint. */
  skip?: { reason: string };
  /** The detected + verified test command (null when nothing matched). */
  testCommand: TestCommandDetection | null;
  /** The "tool set": detected language/runtime toolchains (e.g. ['node','rust']). */
  toolchains: string[];
  /** The resolved package manager (npm/pnpm/yarn/bun/cargo/go/pip/poetry/…), or null. */
  packageManager: string | null;
  flags: { monorepo: boolean; frontend: boolean };
  harvestedDocs: HarvestedDoc[];
  notes: string[];
}

export interface DetectOptions {
  /** Run the detected test command once to verify it (D-023). Default true. */
  runTests?: boolean;
  /** Budget for the verify run. Default DEFAULT_TEST_TIMEOUT_MS. */
  testTimeoutMs?: number;
}

interface TestProcessResult {
  status: number | null;
  error: NodeJS.ErrnoException | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** True if `<parent>/<any-subdir>/<child>` exists (cheap one-level monorepo probe). */
function hasNestedManifest(repoPath: string, parents: string[], child: string): boolean {
  for (const parent of parents) {
    const dir = join(repoPath, parent);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const sub = join(dir, e);
      try {
        if (statSync(sub).isDirectory() && existsSync(join(sub, child))) return true;
      } catch {
        /* skip unreadable */
      }
    }
  }
  return false;
}

/** Resolve the node package manager from the lockfile present. */
function detectNodePackageManager(repoPath: string): string {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoPath, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** Known test runners — the first token of a harvested command must be one of these. */
const RUNNER = /^(npm|pnpm|yarn|bun|cargo|go|make|pytest|python|tox|deno|gradle|mvn)\b/;
const TESTY = /\btest\b/i;

/** Is `cand` a usable test command? (runner-led, mentions "test", no placeholders.) */
function isTestCommand(cand: string): boolean {
  return RUNNER.test(cand) && TESTY.test(cand) && !/[<>]/.test(cand);
}

/** Normalize a candidate command: drop a shell prompt and a trailing inline comment. */
function normalizeCommand(raw: string): string {
  return raw
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/\s+#.*$/, '')
    .trim();
}

/**
 * Harvest a test command from the instruction docs. Commands in these docs live
 * in code formatting, so we look there FIRST (precise — the exact command, never
 * surrounding prose): fenced code-block lines, then inline `code spans`, then a
 * bare line whose first token is a runner. Deterministic — first match by doc
 * order, then by candidate order within a doc. Prose mentioning a command (not in
 * code formatting, not runner-led) is deliberately ignored.
 */
function harvestTestCommand(
  docs: HarvestedDoc[],
): { command: string; source: (typeof HARVEST_FILES)[number] } | null {
  for (const doc of docs) {
    const lines = doc.content.split('\n');
    let inFence = false;
    for (const rawLine of lines) {
      if (/^\s*```/.test(rawLine)) {
        inFence = !inFence;
        continue;
      }
      const candidates: string[] = [];
      if (inFence) {
        // 1. Fenced code-block line — the whole line is literal code.
        candidates.push(normalizeCommand(rawLine));
      } else {
        // 2. Inline `code spans`.
        for (const m of rawLine.matchAll(/`([^`]+)`/g)) candidates.push(normalizeCommand(m[1]));
        // 3. A bare line that is itself a command (first token is a runner).
        const bare = normalizeCommand(rawLine.replace(/^[\s>*-]+/, ''));
        candidates.push(bare);
      }
      for (const cand of candidates) {
        if (cand && cand.length <= 200 && isTestCommand(cand)) {
          return { command: cand, source: doc.file as (typeof HARVEST_FILES)[number] };
        }
      }
    }
  }
  return null;
}

/** Harvest the named instruction docs (root-level), capped. */
function harvestDocs(repoPath: string): HarvestedDoc[] {
  const out: HarvestedDoc[] = [];
  for (const file of HARVEST_FILES) {
    const text = readTextSafe(join(repoPath, file));
    if (text == null) continue;
    const truncated = text.length > HARVEST_CAP;
    out.push({
      file,
      bytes: Buffer.byteLength(text, 'utf8'),
      truncated,
      content: truncated ? text.slice(0, HARVEST_CAP) : text,
    });
  }
  return out;
}

/**
 * Apply the D-023 verify result to the detected command and notes.
 */
function applyTestVerification(
  testCommand: TestCommandDetection,
  notes: string[],
  timeoutMs: number,
  result: TestProcessResult,
): void {
  testCommand.durationMs = result.durationMs;
  testCommand.timedOut = result.timedOut;
  testCommand.exitCode = result.status;
  testCommand.verified = result.status === 0;
  if (!testCommand.verified) {
    const spawnErr = result.error && !result.timedOut ? `\n[spawn error] ${result.error.message}` : '';
    const combined = `${result.stdout}\n${result.stderr}${spawnErr}`.trim();
    testCommand.output = combined.slice(-OUTPUT_TAIL);
    notes.push(
      result.timedOut
        ? `test command timed out after ${timeoutMs}ms: ${testCommand.command}`
        : `test command did not pass (exit ${testCommand.exitCode}): ${testCommand.command}`,
    );
  }
}

/**
 * Prepare the detected command for the D-023 verify step. Commands that need a
 * shell remain deliberately unverified; harvested instruction text must never
 * be handed to a shell.
 */
function prepareTestVerification(
  detection: DetectionResult,
  opts: DetectOptions,
): { testCommand: TestCommandDetection; argv: string[]; timeoutMs: number } | null {
  const testCommand = detection.testCommand;
  if (!testCommand) return null;
  if (opts.runTests === false) {
    detection.notes.push('test command not verified (runTests:false)');
    return null;
  }
  const argv = splitTestCommandArgv(testCommand.command);
  if (!argv) {
    detection.notes.push(
      `test command not auto-verified (shell metacharacters; harvested commands run without a shell): ${testCommand.command}`,
    );
    return null;
  }
  return {
    testCommand,
    argv,
    timeoutMs: opts.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
  };
}

/** Run a verify command synchronously for the backwards-compatible API. */
function verifyTestCommandSync(
  repoPath: string,
  verification: { testCommand: TestCommandDetection; argv: string[]; timeoutMs: number },
  notes: string[],
): void {
  const startedAt = Date.now();
  const result = spawnSync(verification.argv[0], verification.argv.slice(1), {
    cwd: repoPath,
    timeout: verification.timeoutMs,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  applyTestVerification(verification.testCommand, notes, verification.timeoutMs, {
    status: typeof result.status === 'number' ? result.status : null,
    error: (result.error as NodeJS.ErrnoException | undefined) ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error != null && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
    durationMs: Date.now() - startedAt,
  });
}

/** Run a verify command without blocking the event loop. */
function verifyTestCommandAsync(
  repoPath: string,
  verification: { testCommand: TestCommandDetection; argv: string[]; timeoutMs: number },
  notes: string[],
): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(verification.argv[0], verification.argv.slice(1), {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Chunk-safe accumulation (WI-6728): a multi-byte UTF-8 character split across two
    // 'data' events must not decode to replacement chars. `text()` is read once, at
    // the terminal finish, which is the flushing read the collector is designed for.
    const output = collectChildOutput(child);
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, verification.timeoutMs);

    const finish = (status: number | null, error: NodeJS.ErrnoException | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      applyTestVerification(verification.testCommand, notes, verification.timeoutMs, {
        status,
        error,
        stdout: output.stdout.text(),
        stderr: output.stderr.text(),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
      resolve();
    };

    child.once('error', (error) => finish(null, error as NodeJS.ErrnoException));
    child.once('close', (status) => finish(status, null));
  });
}

/**
 * Deterministically detect the blueprint seed for a repo without running its
 * test command. The returned result is completed by either the synchronous or
 * asynchronous verifier below.
 */
function detectFromRepoBase(repoPath: string): DetectionResult {
  const notes: string[] = [];
  const isGitRepo = existsSync(join(repoPath, '.git'));
  if (!isGitRepo) notes.push('no .git directory — not a git repo (proceeding with path as-is)');

  // Skip if the repo already carries a blueprint (D-023).
  if (existsSync(join(repoPath, '.papercusp', 'blueprint.yaml'))) {
    return {
      repoPath,
      isGitRepo,
      skip: { reason: 'repo already has .papercusp/blueprint.yaml' },
      testCommand: null,
      toolchains: [],
      packageManager: null,
      flags: { monorepo: false, frontend: false },
      harvestedDocs: [],
      notes,
    };
  }

  const harvestedDocs = harvestDocs(repoPath);

  // ── toolchains + package manager ───────────────────────────────────────────
  const toolchains: string[] = [];
  let packageManager: string | null = null;

  const pkg = readJsonSafe(join(repoPath, 'package.json'));
  const cargoToml = readTextSafe(join(repoPath, 'Cargo.toml'));
  const goMod = existsSync(join(repoPath, 'go.mod'));
  const pyproject = readTextSafe(join(repoPath, 'pyproject.toml'));
  const hasPyReqs = existsSync(join(repoPath, 'requirements.txt')) || existsSync(join(repoPath, 'setup.py'));

  if (pkg) {
    toolchains.push('node');
    packageManager = detectNodePackageManager(repoPath);
  }
  if (cargoToml != null) {
    toolchains.push('rust');
    packageManager ??= 'cargo';
  }
  if (goMod) {
    toolchains.push('go');
    packageManager ??= 'go';
  }
  if (pyproject != null || hasPyReqs) {
    toolchains.push('python');
    packageManager ??= pyproject != null && /\[tool\.poetry\]/.test(pyproject) ? 'poetry' : 'pip';
  }

  // ── test command (priority: native ecosystem → harvested docs) ─────────────
  let testCommand: TestCommandDetection | null = null;
  const mkCmd = (command: string, source: TestCommandDetection['source']): TestCommandDetection => ({
    command,
    source,
    verified: null,
    exitCode: null,
    durationMs: null,
  });

  const pkgScripts = (pkg?.scripts ?? null) as Record<string, unknown> | null;
  if (pkgScripts && typeof pkgScripts.test === 'string' && pkgScripts.test.trim()) {
    const pm = packageManager ?? 'npm';
    // npm/bun: `<pm> test`; pnpm/yarn: `<pm> test` also works (they alias `run test`).
    testCommand = mkCmd(`${pm} test`, 'package.json');
  } else if (cargoToml != null) {
    testCommand = mkCmd('cargo test', 'cargo');
  } else if (goMod) {
    testCommand = mkCmd('go test ./...', 'go');
  } else if (pyproject != null || hasPyReqs) {
    testCommand = mkCmd('pytest', 'pytest');
  } else if (existsSync(join(repoPath, 'Makefile')) && /^test:/m.test(readTextSafe(join(repoPath, 'Makefile')) ?? '')) {
    testCommand = mkCmd('make test', 'makefile');
  }
  if (!testCommand) {
    const harvested = harvestTestCommand(harvestedDocs);
    if (harvested) testCommand = mkCmd(harvested.command, harvested.source);
  }
  if (!testCommand) notes.push('no test command detected from ecosystem or instruction docs');

  // ── structural flags ───────────────────────────────────────────────────────
  const monorepo = detectMonorepo(repoPath, pkg, cargoToml);
  const frontend = detectFrontend(repoPath, pkg);

  return {
    repoPath,
    isGitRepo,
    testCommand,
    toolchains,
    packageManager,
    flags: { monorepo, frontend },
    harvestedDocs,
    notes,
  };
}

/**
 * Deterministically detect the blueprint seed for a repo. This compatibility
 * API retains the historical synchronous verify behavior; async request paths
 * should use {@link detectFromRepoAsync} so a test command cannot block the
 * operator event loop.
 */
export function detectFromRepo(repoPath: string, opts: DetectOptions = {}): DetectionResult {
  const detection = detectFromRepoBase(repoPath);
  if (detection.skip) return detection;
  const verification = prepareTestVerification(detection, opts);
  if (verification) verifyTestCommandSync(repoPath, verification, detection.notes);
  return detection;
}

/**
 * Async counterpart for request handlers. Detection remains deterministic and
 * filesystem-based, while the one D-023 verify child is supervised through
 * non-blocking spawn events.
 */
export async function detectFromRepoAsync(repoPath: string, opts: DetectOptions = {}): Promise<DetectionResult> {
  const detection = detectFromRepoBase(repoPath);
  if (detection.skip) return detection;
  const verification = prepareTestVerification(detection, opts);
  if (verification) await verifyTestCommandAsync(repoPath, verification, detection.notes);
  return detection;
}

function detectMonorepo(
  repoPath: string,
  pkg: Record<string, unknown> | null,
  cargoToml: string | null,
): boolean {
  if (pkg && pkg.workspaces != null) return true; // npm/yarn workspaces
  if (existsSync(join(repoPath, 'pnpm-workspace.yaml'))) return true;
  for (const f of ['lerna.json', 'nx.json', 'turbo.json']) {
    if (existsSync(join(repoPath, f))) return true;
  }
  if (cargoToml != null && /^\s*\[workspace\]/m.test(cargoToml)) return true; // cargo workspace
  // Cheap one-level probe: multiple manifests under packages/ or apps/.
  if (hasNestedManifest(repoPath, ['packages', 'apps'], 'package.json')) return true;
  if (hasNestedManifest(repoPath, ['crates'], 'Cargo.toml')) return true;
  return false;
}

function detectFrontend(repoPath: string, pkg: Record<string, unknown> | null): boolean {
  if (pkg) {
    const deps = {
      ...((pkg.dependencies as Record<string, unknown>) ?? {}),
      ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
    };
    if (FRONTEND_DEPS.some((d) => d in deps)) return true;
  }
  return FRONTEND_CONFIG_FILES.some((f) => existsSync(join(repoPath, f)));
}

/**
 * Map a `DetectionResult` onto an `extends: coding` blueprint override object —
 * `{ id, extends:'coding', knobs, recursion? }`. Touches only object-valued
 * fields (knobs / recursion) so the inherited coding spine/roles/reactive arrays
 * are preserved (the loader replaces arrays wholesale). The result is what
 * `resolveAndValidate` / `harness:create` consume.
 */
export function detectionToOverride(slug: string, det: DetectionResult): Record<string, unknown> {
  const knobs: Record<string, unknown> = { harnessKind: 'coding' };

  // Real harness levers at the top of `knobs`.
  if (det.testCommand) knobs.testCommand = det.testCommand.command;
  if (det.flags.frontend) knobs.uiQa = { enabled: true }; // frontend → ui-qa quality gate (seed)

  // Detection provenance — the seed the gym optimizes (D-022). Grouped so the
  // real levers above stay legible.
  knobs.fromRepo = {
    toolchains: det.toolchains,
    packageManager: det.packageManager,
    monorepo: det.flags.monorepo,
    frontend: det.flags.frontend,
    isGitRepo: det.isGitRepo,
    testCommandSource: det.testCommand?.source ?? null,
    testCommandVerified: det.testCommand?.verified ?? null,
    harvestedDocs: det.harvestedDocs.map((d) => d.file),
  };

  // Harvest the instruction docs INTO the override so the seed is portable
  // (the distribution plan can install this blueprint into another checkout).
  if (det.harvestedDocs.length) {
    knobs.projectInstructions = Object.fromEntries(det.harvestedDocs.map((d) => [d.file, d.content]));
  }

  const override: Record<string, unknown> = { id: slug, extends: 'coding-factory', knobs };

  // monorepo → sub-harness per sub-project (D-016/D-023). `recursion` is a typed
  // object so it deep-merges cleanly; declare a trigger so it isn't a no-op
  // (validateBlueprint warns on `enabled` without `spawnOn`). `childBlueprint`
  // defaults to self (coding).
  if (det.flags.monorepo) {
    override.recursion = {
      enabled: true,
      maxDepth: 1,
      strategy: 'escalate',
      spawnOn: { custom: 'monorepo-subproject' },
    };
  }

  if (det.toolchains.length) {
    override.description = `Coding harness generated from repo (${det.toolchains.join(', ')}${
      det.flags.monorepo ? ', monorepo' : ''
    }${det.flags.frontend ? ', frontend' : ''}).`;
  }

  return override;
}
