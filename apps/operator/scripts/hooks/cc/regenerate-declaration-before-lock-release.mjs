#!/usr/bin/env node
/**
 * Collapse a DERIVED-ARTIFACT staleness window while an edit lock is held.
 *
 * The lock hooks pass either their native PostToolUse payload or an exact
 * (repo root, path[]) pair. This helper keeps path discovery, enrollment checks,
 * and generator invocation identical across Claude, Codex, and OMP — which is
 * the whole reason regeneration lives HERE rather than in a Claude-only
 * PostToolUse nudge: the edit that strands the artifact can arrive from any of
 * the three clients, and it runs while the source's own edit lock is still held.
 *
 * WHAT IT COVERS — `DERIVED_ARTIFACTS` below, one entry per (source paths ->
 * generator) pair:
 *   - generated `.d.mts` declarations (tsconfig.declarations.json's explicit
 *     `.mjs` inputs -> `gen:declarations`);
 *   - `.papercusp/testing-domains.json` (-> `gen:contract`), EI-20094472685960957.
 * It is a no-op unless an edited path is an enrolled input of some entry.
 *
 * WHY REGENERATE RATHER THAN WARN: every entry here is DERIVED and its generator
 * is deterministic, so writing the output needs no judgment — there is nothing a
 * human decides that re-running the generator does not decide identically. A
 * check-and-nudge would hand the author a chore whose only correct answer is the
 * command the hook just declined to run.
 *
 * FAILURE POLICY: entries run INDEPENDENTLY and their failures are aggregated,
 * so a broken config or generator in one entry cannot silently suppress another.
 * A real failure exits non-zero so the caller can record it, but callers always
 * continue to release the lock — a failed emit must never strand a source lock
 * for its full TTL.
 *
 * FILENAME retained deliberately now that the scope is no longer
 * declarations-only: four call sites reference it by name
 * (posttooluse-locks-release.sh, posttoolbatch-locks-release.sh,
 * omp/coord-hook.ts, and the built dist-host bundle), and the CLI entry guard at
 * the bottom matches that exact basename.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

// These two also IDENTIFY the repo root (validRepoRoot / findRepoRoot below), so
// they stay the root marker even as more artifacts are enrolled.
const CONFIG = 'tsconfig.declarations.json';
const GENERATOR = join('scripts', 'gen-declarations.ts');

// EI-20094472685960957 — `.papercusp/testing-domains.json` is derived from the
// operator's testing-domains registry, but it is also COMMITTED (the harness
// Tests tab reads it at runtime), and its freshness is asserted deep inside the
// full operator-core suite. Editing the registry therefore looked like any other
// source edit while arming a red that surfaced minutes-to-hours later as a
// fleet-wide gate failure attributed to whoever was looking. Three occurrences of
// that exact shape (WI-37793, EI-20081777912524409, WI-6235) before this entry.
const TESTING_DOMAINS_GENERATOR = join('scripts', 'gen-testing-domains-contract.ts');
const TESTING_DOMAINS_CONTRACT = join('.papercusp', 'testing-domains.json');
// Exactly the generator's own DATA inputs, plus the generator itself (it owns the
// tier split, the display order and the serialized shape). Deliberately NOT
// `packages/operator-core/lib/testing-domains.ts`: the generator imports that for
// the `TestDomain` TYPE only, and a type has no bearing on the emitted bytes.
// Keep this list in step with the generator's imports — widening them without
// widening this set re-opens the drift window this entry closes.
const TESTING_DOMAINS_SOURCES = new Set([
  'packages/operator-core/lib/testing-domains-registry.ts',
  'packages/operator-core/lib/harness-testing-registry.ts',
  'scripts/gen-testing-domains-contract.ts',
]);

const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'apply_patch',
  'write_file',
  'edit_file',
]);

function validRepoRoot(root) {
  return existsSync(join(root, CONFIG)) && existsSync(join(root, GENERATOR));
}

function findRepoRoot(filePath) {
  let dir = resolve(filePath);
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }
  for (;;) {
    if (validRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function patchPaths(value) {
  const source =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? Object.values(value).find((entry) => typeof entry === 'string' && entry.includes('*** ')) ?? ''
        : '';
  const paths = [];
  for (const match of source.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    paths.push(match[1].trim());
  }
  for (const match of source.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(match[1].trim());
  return paths;
}

function hookPaths(payload) {
  const tool = payload?.tool_name ?? '';
  const input = payload?.tool_input;
  if (!EDIT_TOOLS.has(tool)) return [];
  if (tool === 'apply_patch') return patchPaths(input);
  if (!input || typeof input !== 'object') return [];
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits
      .map((edit) => edit?.file_path ?? edit?.path)
      .filter((path) => typeof path === 'string' && path.length > 0);
  }
  const path = input.file_path ?? input.filePath ?? input.path;
  return typeof path === 'string' && path.length > 0 ? [path] : [];
}

function resultSucceeded(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 && !/^(?:error|failed|failure|denied|permission denied)\b/i.test(text);
  }
  if (Array.isArray(value)) return value.length > 0 && value.every(resultSucceeded);
  if (typeof value !== 'object') return false;
  if (value.is_error === true || value.isError === true || value.ok === false || value.success === false) {
    return false;
  }
  if (value.error) return false;
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (['error', 'failed', 'failure', 'denied'].includes(status)) return false;
  if (
    value.ok === true ||
    value.success === true ||
    value.is_error === false ||
    value.isError === false ||
    ['ok', 'success', 'succeeded', 'completed', 'applied'].includes(status)
  ) {
    return true;
  }
  for (const key of [
    'content', 'result', 'output', 'message', 'filePath', 'file_path',
    'structuredPatch', 'oldString', 'newString', 'path',
  ]) {
    const entry = value[key];
    if (entry !== undefined && entry !== null && entry !== '' && (!Array.isArray(entry) || entry.length > 0)) {
      return true;
    }
  }
  return (value.type === 'text' || value.type === 'tool_result') && Boolean(value.text);
}

function enrolledInputs(repoRoot) {
  const raw = readFileSync(join(repoRoot, CONFIG), 'utf8');
  const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  if (!Array.isArray(parsed.files)) return [];
  return parsed.files.filter((path) => typeof path === 'string' && path.endsWith('.mjs'));
}

/** Repo-relative, POSIX-separated — the one form every `select` compares against. */
function toRepoRelative(repoRoot, paths) {
  return paths.map((path) =>
    relative(repoRoot, resolve(repoRoot, path)).split(sep).join('/'),
  );
}

function npmRun(repoRoot, args) {
  execFileSync('npm', ['run', '--silent', ...args], {
    cwd: repoRoot,
    stdio: 'ignore',
    timeout: 120_000,
  });
}

/**
 * One entry per derived artifact: which edited paths strand it, and the
 * deterministic command that un-strands it.
 *
 * `select` returns the enrolled inputs THIS edit touched, already repo-relative.
 * An empty return means "not stranded by this edit" and skips the generator —
 * load-bearing, not an optimization: this helper runs on every successful edit in
 * the repo, so an entry that regenerated unconditionally would put its generator
 * in the hot path of every unrelated file change.
 */
const DERIVED_ARTIFACTS = [
  {
    id: 'declarations',
    // Enrollment is tsconfig.declarations.json's own `files` list, so the hook
    // cannot drift from the set gen:declarations actually emits for.
    select: (repoRoot, relPaths) => {
      const wanted = new Set(relPaths);
      return enrolledInputs(repoRoot).filter((path) =>
        wanted.has(relative(repoRoot, resolve(repoRoot, path)).split(sep).join('/')),
      );
    },
    run: (repoRoot, selected) =>
      npmRun(repoRoot, ['gen:declarations', '--', `--files=${selected.join(',')}`]),
  },
  {
    id: 'testing-domains-contract',
    // Presence-checked rather than assumed: this helper is invoked for any repo
    // that has the declarations pair above, and a checkout without the contract
    // generator must be a silent no-op rather than a failing npm run.
    //
    // The CONTRACT file itself is deliberately not a trigger. Its own hand-edit is
    // refused upstream by pretooluse-generated-file-edit-guard (the file declares
    // itself GENERATED in its `_comment`), and treating it as a trigger would make
    // this hook silently revert an edit the author is still looking at. Drift
    // arriving by any non-hook route is caught instead by the `gen:contract:check`
    // repo-wide invariant guard in scripts/affected-tests.mjs, which does cover it.
    select: (repoRoot, relPaths) => {
      if (!existsSync(join(repoRoot, TESTING_DOMAINS_GENERATOR))) return [];
      if (!existsSync(join(repoRoot, TESTING_DOMAINS_CONTRACT))) return [];
      return relPaths.filter((path) => TESTING_DOMAINS_SOURCES.has(path));
    },
    // Whole-artifact generator: it reads the registry, not a file list, so there
    // is no per-file argument to forward.
    run: (repoRoot) => npmRun(repoRoot, ['gen:contract']),
  },
];

/**
 * Plan the regeneration: which artifacts this edit stranded, plus any entry whose
 * own selection blew up.
 *
 * Each entry is selected under its OWN try. A malformed tsconfig.declarations.json
 * used to throw straight out of the single code path and take every other artifact
 * with it — the failure would be reported, but the unrelated regeneration would
 * silently never happen, which is the exact shape of staleness this file exists to
 * remove.
 */
function planRegeneration(root, relPaths) {
  const selections = [];
  const errors = [];
  for (const artifact of DERIVED_ARTIFACTS) {
    try {
      const selected = artifact.select(root, relPaths);
      if (selected.length > 0) selections.push({ artifact, selected });
    } catch (error) {
      errors.push(`${artifact.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { selections, errors };
}

/**
 * Which artifacts this edit stranded, without running anything.
 *
 * Exported as the pure seam the tests assert on: proving the SELECTION rule needs
 * no npm, no generator and no writes. Returns `{ id, selected }` and never throws
 * — an entry that cannot decide is simply absent.
 */
export function selectDerivedArtifacts(repoRoot, paths) {
  const root = resolve(repoRoot);
  if (!validRepoRoot(root)) return [];
  return planRegeneration(root, toRepoRelative(root, paths)).selections.map(
    ({ artifact, selected }) => ({ id: artifact.id, selected }),
  );
}

function groupByRepo(paths, cwd) {
  const groups = new Map();
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) continue;
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const root = findRepoRoot(absolute);
    if (!root) continue;
    const list = groups.get(root) ?? [];
    list.push(absolute);
    groups.set(root, list);
  }
  return groups;
}

/**
 * Regenerate every artifact this edit stranded. Returns the number of enrolled
 * inputs that selected across all entries (0 = nothing to do).
 *
 * Generators run INDEPENDENTLY: one failing generator must not stop the others,
 * because they emit unrelated artifacts. Every failure is still surfaced — the
 * aggregated throw is what the callers turn into a recorded release error.
 */
export function regenerateForPaths(repoRoot, paths) {
  const root = resolve(repoRoot);
  if (!validRepoRoot(root)) return 0;
  const { selections, errors } = planRegeneration(root, toRepoRelative(root, paths));
  let count = 0;
  for (const { artifact, selected } of selections) {
    try {
      artifact.run(root, selected);
      count += selected.length;
    } catch (error) {
      errors.push(`${artifact.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return count;
}

export function regenerateForHookPayload(payload) {
  const tool = payload?.tool_name ?? '';
  const response = payload?.tool_response ?? payload?.toolResponse;
  if (!EDIT_TOOLS.has(tool) || !resultSucceeded(response)) return 0;
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  let count = 0;
  for (const [root, paths] of groupByRepo(hookPaths(payload), cwd)) {
    count += regenerateForPaths(root, paths);
  }
  return count;
}

function args(argv) {
  const out = { repoRoot: null, paths: [], hookPayload: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hook-payload') out.hookPayload = true;
    else if (argv[i] === '--repo-root') out.repoRoot = argv[++i] ?? null;
    else if (argv[i] === '--path') out.paths.push(argv[++i] ?? '');
  }
  return out;
}

async function main() {
  const parsed = args(process.argv.slice(2));
  if (parsed.hookPayload) {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    try {
      regenerateForHookPayload(JSON.parse(raw || '{}'));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (!parsed.repoRoot) return;
  try {
    regenerateForPaths(parsed.repoRoot, parsed.paths);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'regenerate-declaration-before-lock-release.mjs') {
  await main();
}
