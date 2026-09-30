/** Thin release-registry adapter for the shared Project History contract. */
import { build, transform } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  assembleProjectHistory,
  assertProjectHistoryDocument,
  type ProjectHistoryDocument,
  type ProjectHistoryWorkItemInput,
} from '@papercusp/plan-parser/project-history';
import type { HydratedRelease } from './release-history-page';
import { identityLiterals, scrubIdentity, type IdentityLiteral } from './release-content-scrub';
import type { Scope } from './release-registry';

export function releaseHistoryStem(version: string, channel: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !/^(stable|beta|alpha)$/.test(channel)) {
    throw new Error('Invalid release history version or channel');
  }
  return `desktop-v${version}-${channel}`;
}

export function releaseProjectHistory(
  release: HydratedRelease,
  scope: Scope,
  redact: IdentityLiteral[] = identityLiterals(),
): ProjectHistoryDocument {
  const included = new Set(release.row.workItemIds);
  const items = release.items.filter((item) => included.has(item.id));
  const plans = release.plans.filter((plan) => release.row.planSlugs.includes(plan.slug));
  const bySlug = new Map(plans.map((plan) => [plan.slug, plan]));
  const unplanned = items.filter((item) => !item.planSlug || !bySlug.has(item.planSlug));
  const workItem = (item: typeof items[number]): ProjectHistoryWorkItemInput => ({
    id: item.id,
    title: item.title,
    kind: item.kind ?? 'work-item',
    state: item.state ?? 'unknown',
    completedAt: item.closedAt ?? null,
    completionAuthority: item.completionAuthority ?? null,
    completionSummary: item.terminalCompletionEvidence?.summary ?? null,
    completionEvidence: item.terminalCompletionEvidence
      ? { ...item.terminalCompletionEvidence }
      : null,
  });
  const document = assembleProjectHistory({
    project: { id: 'papercusp', name: 'Papercusp', repository: null },
    source: {
      kind: 'papercusp-plan-export',
      workspace: scope.workspaceId,
      harness: scope.harnessSlug,
      planPrefix: null,
      generatedAt: release.row.cutAt.toISOString(),
      generator: 'papercusp-release-project-history',
    },
    plans: [
      ...plans.map((plan) => ({
        // Use canonical markdown, including its validation assertions and decisions.
        markdown: plan.content.startsWith('---\n') ? plan.content :
          `---\nslug: ${JSON.stringify(plan.slug)}\ntitle: ${JSON.stringify(plan.title)}\nstatus: ${JSON.stringify(plan.status)}\n---\n${plan.content}`,
        filePath: `${plan.slug}.md`,
        completedItems: items.filter((item) => item.planSlug === plan.slug).map(workItem),
      })),
      ...(unplanned.length ? [{
        markdown: '---\nslug: release-unplanned-work\ntitle: Other completed work\nstatus: shipped\n---\nWork recorded in this release without an available plan document.\n',
        completedItems: unplanned.map(workItem),
      }] : []),
    ],
  });
  // The assembler can infer completions from the current plan's WI markers.
  // Those may have landed AFTER this release. Its frozen registry membership wins.
  for (const plan of document.plans) {
    const explicitIds = new Set((plan.slug === 'release-unplanned-work' ? unplanned :
      items.filter((item) => item.planSlug === plan.slug)).map((item) => item.id));
    plan.completedItems = plan.completedItems.filter((item) => explicitIds.has(item.id));
  }
  // Scrub the complete serialized artifact, just like history.json. Validate the
  // final bytes too: a redaction must never produce malformed public JSON.
  return assertProjectHistoryDocument(JSON.parse(scrubIdentity(JSON.stringify(document), redact)));
}

/**
 * Wall-clock milliseconds per asset-build phase, filled in as each phase
 * completes. A caller that passes this record can report how far a slow or
 * stalled build got (a phase that is absent never finished).
 */
export interface ReleaseHistoryAssetTimings {
  bundleMs?: number;
  mirrorMs?: number;
  normalizeMs?: number;
  normalizedFiles?: number;
}

/** Self-hosted assets: no live operator, database, or public CDN is needed. */
export async function buildReleaseHistoryAssets(
  outDir: string,
  timings: ReleaseHistoryAssetTimings = {},
): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../../../..');
  const assets = path.join(outDir, 'assets');
  fs.mkdirSync(outDir, { recursive: true });
  const staged = fs.mkdtempSync(path.join(outDir, '.history-assets-'));
  try {
    let started = performance.now();
    await build({
    // Keep the executed browser entry repo-relative and literal: the module-reachability
    // guard can then prove this file is a production caller even though esbuild loads it
    // by path rather than through a JavaScript import edge.
    entryPoints: {
      'project-history': path.join(
        root,
        'apps/operator/lib/release/release-project-history-client.tsx',
      ),
    },
    outdir: staged,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'file' },
    });
    timings.bundleMs = Math.round(performance.now() - started);
    started = performance.now();
    const require = createRequire(import.meta.url);
    const vditorDist = path.dirname(require.resolve('vditor/dist/index.min.js'));
    const mirror = path.join(staged, 'vditor', 'dist');
    fs.cpSync(vditorDist, mirror, {
    recursive: true,
    // Development source/maps are not runtime dependencies of the preview.
    filter: (source) => !source.endsWith('.map') && !source.endsWith('.d.ts') && source !== path.join(vditorDist, 'index.js'),
    });
    timings.mirrorMs = Math.round(performance.now() - started);
    started = performance.now();
    timings.normalizedFiles = await normalizeReleaseHistoryAssets(mirror);
    timings.normalizeMs = Math.round(performance.now() - started);
    // A reused output directory must not retain excluded development files or
    // old source maps. Replace only this generator's completed asset output.
    fs.rmSync(assets, { recursive: true, force: true });
    fs.renameSync(staged, assets);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

function collectNormalizableAssets(directory: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectNormalizableAssets(file, out);
    else if (/\.(js|css)$/.test(entry.name)) out.push(file);
  }
  return out;
}

async function normalizeReleaseHistoryAsset(file: string): Promise<boolean> {
  const text = await fs.promises.readFile(file, 'utf8');
  // MathJax ships JSON dictionaries with a .js suffix; they are data.
  try { JSON.parse(text); return false; } catch { /* JavaScript or CSS */ }
  const { code } = await transform(text, {
    loader: file.endsWith('.css') ? 'css' : 'js', minify: true, legalComments: 'none',
  });
  // Checkpoint node_modules is materialized from an immutable dependency
  // generation. Its files are deliberately 0444, and fs.cpSync preserves
  // that mode in this private staging tree. Make only the staged copy
  // owner-writable before replacing its normalized contents; the source
  // generation remains immutable and its hardlinked inode is untouched.
  const { mode } = await fs.promises.stat(file);
  if ((mode & 0o200) === 0) await fs.promises.chmod(file, mode | 0o200);
  await fs.promises.writeFile(file, code);
  return true;
}

/**
 * Strip development comments from the third-party runtime before privacy scanning.
 * Resolves to the number of files rewritten.
 *
 * The vendor mirror is ~330 JS/CSS files (~21 MB, mostly MathJax). Minifying
 * them one by one with `transformSync` held the calling thread for ~3 s of
 * serial CPU; the async `transform` API hands each file to esbuild's service,
 * which minifies concurrent requests in parallel, so a bounded pool keeps the
 * wall time a fraction of that without flooding the service.
 */
export async function normalizeReleaseHistoryAssets(directory: string): Promise<number> {
  const files = collectNormalizableAssets(directory, []);
  const concurrency = Math.max(2, Math.min(16, os.availableParallelism()));
  let next = 0;
  let rewritten = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++];
      if (await normalizeReleaseHistoryAsset(file)) rewritten += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return rewritten;
}
