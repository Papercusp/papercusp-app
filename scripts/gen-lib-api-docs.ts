/**
 * gen-lib-api-docs.ts — TypeDoc lib-API markdown reference for the borrowable
 * `libs/generic/*` libraries (docs-and-memory-as-projections-2026-06-05 P-004 /
 * D-002: the lib-API "what" is derivable from source, so project it).
 *
 * Runs TypeDoc (+ typedoc-plugin-markdown) per lib entry point and writes
 * markdown under .papercusp/lib-api/<lib>/. ON-DEMAND, NOT committed or
 * CI-gated — same stance as gen-tool-catalog/gen-openapi: the output churns
 * with every export change across many libs, and its only renderer (the P-005
 * Starlight projection site) is still owner-gated. When P-005 lands, point
 * starlight-typedoc/its loader at the same entry points this script resolves.
 *
 *   Run:  npm run gen:lib-api               (all borrowable libs)
 *         npm run gen:lib-api -- memory rrf (just those libs)
 *
 * Lib discovery: every workspace under libs/generic/** (read from the root
 * package.json workspaces globs) whose package.json has a resolvable source
 * entry (`src/index.ts` preferred, else the `main`/`exports` target). Libs
 * without one are reported and skipped, never silently dropped.
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(REPO_ROOT, '.papercusp', 'lib-api');

interface LibTarget {
  name: string;
  dir: string;
  entry: string;
}

function resolveEntry(dir: string): string | null {
  for (const cand of ['src/index.ts', 'src/index.tsx', 'index.ts']) {
    const p = join(dir, cand);
    if (existsSync(p)) return p;
  }
  return null;
}

function discoverLibs(): { targets: LibTarget[]; skipped: string[] } {
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    workspaces: string[];
  };
  const targets: LibTarget[] = [];
  const skipped: string[] = [];
  for (const ws of rootPkg.workspaces) {
    if (!ws.startsWith('libs/generic/')) continue;
    const dir = join(REPO_ROOT, ws);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) {
      skipped.push(`${ws} (no package.json)`);
      continue;
    }
    const entry = resolveEntry(dir);
    if (!entry) {
      skipped.push(`${ws} (no src/index.ts entry)`);
      continue;
    }
    const name = ws.replace('libs/generic/', '').replace(/\//g, '-');
    targets.push({ name, dir, entry });
  }
  return { targets, skipped };
}

// Shells out to the typedoc CLI (the path the markdown plugin is verified
// against; the programmatic Application API mis-renders with the plugin).
async function docOne(target: LibTarget): Promise<boolean> {
  const out = join(OUT_ROOT, target.name);
  mkdirSync(out, { recursive: true });
  // Libs without their own tsconfig (git-graph, ui-primitives, p2p-voice,
  // audio-dsp) fall back to the repo-wide base config.
  const tsconfig = existsSync(join(target.dir, 'tsconfig.json'))
    ? join(target.dir, 'tsconfig.json')
    : join(REPO_ROOT, 'tsconfig.base.json');
  const typedocBin = join(REPO_ROOT, 'node_modules', '.bin', 'typedoc');
  const r = spawnSync(
    typedocBin,
    [
      '--plugin', 'typedoc-plugin-markdown',
      '--out', out,
      '--tsconfig', tsconfig,
      '--excludeInternal',
      '--excludePrivate',
      // doc generation must not gate on the tree's tsc baseline
      '--skipErrorChecking',
      '--logLevel', 'Warn',
      target.entry,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ');
    process.stderr.write(`  ${target.name}: typedoc exit ${r.status}: ${msg}\n`);
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const { targets, skipped } = discoverLibs();
  const selected = only.length > 0 ? targets.filter((t) => only.includes(t.name)) : targets;

  if (only.length > 0 && selected.length === 0) {
    process.stderr.write(
      `✗ no lib matched [${only.join(', ')}]. Known: ${targets.map((t) => t.name).join(', ')}\n`,
    );
    process.exit(1);
  }

  let okCount = 0;
  const failed: string[] = [];
  for (const t of selected) {
    const ok = await docOne(t).catch((e: unknown) => {
      process.stderr.write(`  ${t.name}: ${(e as Error).message}\n`);
      return false;
    });
    if (ok) okCount++;
    else failed.push(t.name);
  }

  if (skipped.length > 0) {
    process.stdout.write(`skipped (no entry): ${skipped.join(', ')}\n`);
  }
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.join(', ')}\n`);
  }
  process.stdout.write(
    `✓ generated markdown API docs for ${okCount}/${selected.length} libs under .papercusp/lib-api/\n`,
  );
  process.exit(failed.length > 0 && okCount === 0 ? 1 : 0);
}

void main();
