/**
 * precut-containment-cli — the one-command go/no-go for "does GREEN main carry the whole
 * pre-cut set?" before a desktop release cut (WI-10002524, plan
 * p2p-public-release-endgame-2026-09-01 D-080).
 *
 * A release is cut from green `main`. Its pre-cut set is a list of work-items whose fixes
 * must be in those bytes. Asking that by hand is a known trap on this tree: HEAD is a moving
 * baseline, a submodule path has no blob in the superproject, and `merge-base --is-ancestor`
 * stays true after a later sweep reverts the lines (CLAUDE.md "Containment is a CONTENT
 * question"). This CLI answers per path, reusing the gate's own submodule-aware comparison
 * (`containmentForPaths`, judged-sha-containment.ts) with `main` as the judged sha:
 *
 *   UNCOMMITTED        the working tree differs from staging for this path (including a new,
 *                      untracked file), so the fix is not even committed. Checked FIRST: equal
 *                      main/staging blobs would otherwise read as contained while both lack
 *                      the fix.
 *   ABSENT             the path exists nowhere, on staging or in the working tree (wrong path)
 *   STAGED-NOT-IN-MAIN main's blob differs from staging's
 *   MARKER-MISSING     blobs are equal but main's content lacks the literal the fix introduced
 *                      (optional per path; positive evidence independent of staging)
 *   IN-MAIN            main carries staging's content, and the marker if one is declared
 *
 * An item with no declared paths is PENDING (its fix is not defined yet). GO requires every
 * item IN-MAIN. Exit codes: 0 GO · 1 NO-GO · 2 misuse or an unreadable ref.
 *
 *   npx tsx apps/operator/lib/release/precut-containment-cli.ts \
 *     --set apps/operator/lib/release/precut-sets/0.0.26.json [--main main] [--json]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import {
  containmentForPaths,
  integrationBranch,
  realGitProbe,
  type GitProbe,
} from '@papercusp/operator-core/lib/release/judged-sha-containment';

export type PathVerdict = 'ABSENT' | 'UNCOMMITTED' | 'STAGED-NOT-IN-MAIN' | 'MARKER-MISSING' | 'IN-MAIN';
export type ItemVerdict = PathVerdict | 'PENDING';

export interface PrecutPath {
  path: string;
  /** A literal the fix introduced; main's content must contain it. */
  marker?: string;
}

export interface PrecutItem {
  id: string;
  label: string;
  paths: Array<string | PrecutPath>;
  note?: string;
}

export interface PrecutSet {
  release: string;
  items: PrecutItem[];
}

export interface PrecutDeps {
  git: GitProbe;
  /** true when the working tree differs from the committed tree for this path. */
  isDirty(root: string, path: string): boolean;
  /** File content at a superproject ref, resolved through the gitlink for submodule paths. */
  readAt(root: string, ref: string, path: string): string | null;
}

export interface PathResult {
  path: string;
  verdict: PathVerdict;
  mainBlob: string | null;
  stagingBlob: string | null;
}

export interface ItemResult {
  id: string;
  label: string;
  verdict: ItemVerdict;
  paths: PathResult[];
  note?: string;
}

export interface PrecutReport {
  release: string;
  mainRef: string;
  mainSha: string;
  stagingRef: string;
  stagingSha: string;
  go: boolean;
  items: ItemResult[];
}

// Worst first: an item takes the first verdict in this order that any of its paths has.
const SEVERITY: PathVerdict[] = ['ABSENT', 'UNCOMMITTED', 'STAGED-NOT-IN-MAIN', 'MARKER-MISSING', 'IN-MAIN'];

const normalize = (p: string | PrecutPath): PrecutPath => (typeof p === 'string' ? { path: p } : p);

export function judgePrecutSet(
  set: PrecutSet,
  root: string,
  mainRef: string,
  deps: PrecutDeps,
  stagingRef: string = integrationBranch(),
): PrecutReport {
  const mainSha = deps.git.revParse(root, mainRef);
  const stagingSha = deps.git.revParse(root, stagingRef);
  if (!mainSha || !stagingSha) {
    throw new Error(`cannot resolve ${!mainSha ? mainRef : stagingRef} in ${root}`);
  }
  const items = set.items.map((item): ItemResult => {
    const declared = item.paths.map(normalize);
    if (declared.length === 0) {
      return { id: item.id, label: item.label, verdict: 'PENDING', paths: [], note: item.note };
    }
    const contained = containmentForPaths(declared.map((d) => d.path), mainSha, root, deps.git, stagingSha);
    const paths = contained.map((c, i): PathResult => {
      const marker = declared[i].marker;
      let verdict: PathVerdict;
      // Dirty first: a NEW file that exists only in the working tree has no staging blob,
      // and is uncommitted rather than absent.
      if (deps.isDirty(root, c.path)) verdict = 'UNCOMMITTED';
      else if (c.stagingBlob === null) verdict = 'ABSENT';
      else if (!c.containedInJudgedSha) verdict = 'STAGED-NOT-IN-MAIN';
      else if (marker && !(deps.readAt(root, mainSha, c.path) ?? '').includes(marker)) verdict = 'MARKER-MISSING';
      else verdict = 'IN-MAIN';
      return { path: c.path, verdict, mainBlob: c.judgedBlob, stagingBlob: c.stagingBlob };
    });
    const verdict = SEVERITY.find((v) => paths.some((p) => p.verdict === v)) ?? 'IN-MAIN';
    return { id: item.id, label: item.label, verdict, paths, note: item.note };
  });
  return {
    release: set.release,
    mainRef,
    mainSha,
    stagingRef,
    stagingSha,
    go: items.every((i) => i.verdict === 'IN-MAIN'),
    items,
  };
}

function submoduleOf(root: string, path: string): { sub: string; rel: string } | null {
  const sub = (realGitProbe.submodulePaths?.(root) ?? []).find((s) => path.startsWith(`${s}/`));
  return sub ? { sub, rel: path.slice(sub.length + 1) } : null;
}

export const realPrecutDeps: PrecutDeps = {
  git: realGitProbe,
  isDirty(root, path) {
    const inSub = submoduleOf(root, path);
    const [cwd, rel] = inSub ? [resolve(root, inSub.sub), inSub.rel] : [root, path];
    const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--', rel], { encoding: 'utf8' });
    // A failed status is not "clean": treat it as dirty so the verdict can never read GO.
    return r.status !== 0 || (r.stdout ?? '').trim().length > 0;
  },
  readAt(root, ref, path) {
    const inSub = submoduleOf(root, path);
    let cwd = root;
    let spec = `${ref}:${path}`;
    if (inSub) {
      const pin = realGitProbe.gitlinkAt?.(root, ref, inSub.sub);
      if (!pin) return null;
      cwd = resolve(root, inSub.sub);
      spec = `${pin}:${inSub.rel}`;
    }
    const r = spawnSync('git', ['-C', cwd, 'show', spec], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  },
};

export function renderReport(report: PrecutReport): string {
  const short = (s: string | null) => (s ? s.slice(0, 10) : '-');
  const lines = [
    `pre-cut containment for ${report.release}: ${report.go ? 'GO' : 'NO-GO'}`,
    `  ${report.mainRef}=${short(report.mainSha)}  ${report.stagingRef}=${short(report.stagingSha)}`,
  ];
  for (const item of report.items) {
    lines.push(`${item.verdict.padEnd(18)} ${item.id}  ${item.label}${item.note ? `  (${item.note})` : ''}`);
    for (const p of item.paths) {
      if (p.verdict === 'IN-MAIN') continue;
      lines.push(`    ${p.verdict.padEnd(18)} ${p.path}  main=${short(p.mainBlob)} staging=${short(p.stagingBlob)}`);
    }
  }
  return lines.join('\n');
}

export function main(argv: string[] = process.argv.slice(2), root: string = process.cwd()): number {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const setPath = arg('--set');
  if (!setPath) {
    console.error('usage: precut-containment-cli --set <set.json> [--main <ref>] [--json]');
    return 2;
  }
  let report: PrecutReport;
  try {
    const set = JSON.parse(readFileSync(resolve(root, setPath), 'utf8')) as PrecutSet;
    report = judgePrecutSet(set, root, arg('--main') ?? 'main', realPrecutDeps);
  } catch (err) {
    console.error(`precut-containment: ${(err as Error).message}`);
    return 2;
  }
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
  return report.go ? 0 : 1;
}

if (isCliEntry(import.meta.url)) {
  process.exit(main());
}
