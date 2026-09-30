/**
 * plan-markdown-render/tick.ts — the pure, dependency-injected core of the
 * auto-render projection (plan-markdown-auto-render-2026-06-06).
 *
 * Plans are PG-canonical; this projects each plan's `content` blob to an on-disk
 * markdown mirror under apps/operator/docs/plans/<slug>.md (archived plans →
 * archive/<slug>.md) so plans are grep-able / git-diff-able / readable on disk
 * again. It is a READ-ONLY projection: the files are never read back, PG stays
 * the source of truth, and the on-disk file is a *faithful* mirror of the
 * canonical `content` (no injected banner — a banner would make the mirror
 * non-faithful and corrupt the leading frontmatter).
 *
 * One tick is:
 *   - incremental    — a per-slug watermark (`renderedHashes`, keyed on
 *                      content-hash + archived flag) skips unchanged plans; an
 *                      already-correct on-disk file is *adopted* (watermark
 *                      seeded) without a DB content fetch, so a restart is cheap.
 *   - coalesced      — at most one write per plan per tick, regardless of how
 *                      many writes landed since the last tick.
 *   - settle-guarded — a plan whose last write was within `settleWindowMs` is
 *                      skipped this tick, so a multi-chunk `set-content` write
 *                      renders once *after* it settles, not mid-burst.
 *
 * Fully pure + injected (fs, clock, data access, hash) so it unit-tests with no
 * PG and no real filesystem. The real wiring lives in ./index.ts.
 */
import { join } from 'node:path';

/** Minimal filesystem seam — a real impl is `nodeRenderFs` in ./index.ts. */
export interface RenderFs {
  /** File contents, or `null` when the file is absent. */
  readFile(absPath: string): Promise<string | null>;
  /** `mkdir -p` the parent dir, then write the file. */
  writeFile(absPath: string, content: string): Promise<void>;
  /** Remove a file; a no-op when it is already absent. */
  remove(absPath: string): Promise<void>;
  /** Base names of `*.md` files directly in `dir` (`[]` when the dir is absent). */
  listMarkdown(dir: string): Promise<string[]>;
}

/** The lightweight per-plan facts a tick needs to decide what to render. */
export interface RenderTarget {
  slug: string;
  /** The plan's canonical `content_hash` (NO content fetched yet). */
  contentHash: string;
  archived: boolean;
  /** Row write time as ms-epoch — drives the settle guard. */
  updatedAtMs: number;
}

export interface RenderTickDeps {
  fs: RenderFs;
  plansDir: string;
  archiveDir: string;
  nowMs: number;
  settleWindowMs: number;
  /** Cheap per-plan (slug, hash, archived, updatedAt) listing — NO content. */
  listTargets: () => Promise<RenderTarget[]>;
  /** Fetch one plan's canonical markdown (`null` if it vanished mid-tick). */
  getContent: (slug: string) => Promise<string | null>;
  /** Content hash, matching the DB's `content_hash` derivation. */
  hash: (content: string) => string;
  /** Per-slug rendered watermark, carried across ticks (MUTATED in place). */
  renderedHashes: Map<string, string>;
}

export interface RenderTickResult {
  /** Plans (re)written this tick. */
  rendered: string[];
  /** Plans whose on-disk file was already correct → watermark seeded, no write. */
  adopted: string[];
  /** Changed plans skipped this tick because their last write hasn't settled. */
  skippedUnsettled: string[];
  /** Orphan files removed (relative `active/<f>` / `archive/<f>`). */
  removedOrphans: string[];
  /** True when the orphan sweep was skipped because `listTargets` was empty — a
   *  safety floor so a transient empty read never mass-deletes the mirror. */
  orphanSweepSkipped: boolean;
}

/** Files in the mirror dirs that are NOT plan mirrors → never orphan-swept. */
const SWEEP_KEEP = new Set(['README.md']);

const fileName = (slug: string): string => `${slug}.md`;

/** Watermark value: content-hash AND the archived flag, so an active⇄archive
 *  flip (which keeps the same content) still busts the watermark and relocates
 *  the file. */
const watermark = (t: RenderTarget): string => `${t.contentHash}|${t.archived ? 'a' : 'x'}`;

export async function runPlanRenderTick(deps: RenderTickDeps): Promise<RenderTickResult> {
  const targets = await deps.listTargets();
  const rendered: string[] = [];
  const adopted: string[] = [];
  const skippedUnsettled: string[] = [];

  const expectedActive = new Set<string>();
  const expectedArchive = new Set<string>();

  for (const t of targets) {
    (t.archived ? expectedArchive : expectedActive).add(fileName(t.slug));

    if (deps.renderedHashes.get(t.slug) === watermark(t)) continue; // unchanged since last render

    const target = join(t.archived ? deps.archiveDir : deps.plansDir, fileName(t.slug));

    // Adopt an already-correct on-disk file without a DB content fetch — the
    // cheap-restart path (empty watermark but a fresh mirror on disk).
    const existing = await deps.fs.readFile(target);
    if (existing != null && deps.hash(existing) === t.contentHash) {
      deps.renderedHashes.set(t.slug, watermark(t));
      adopted.push(t.slug);
      continue;
    }

    // Needs a (re)write — but only once the plan's last write has settled.
    if (deps.nowMs - t.updatedAtMs < deps.settleWindowMs) {
      skippedUnsettled.push(t.slug);
      continue;
    }

    const content = await deps.getContent(t.slug);
    if (content == null) continue; // vanished between list + fetch → orphan-swept below

    await deps.fs.writeFile(target, content);
    deps.renderedHashes.set(t.slug, watermark(t));
    rendered.push(t.slug);
  }

  // Orphan sweep: any `*.md` in either dir whose slug isn't a current plan AT
  // THAT location — covers deletions AND active⇄archive relocations (the
  // stale-location copy becomes an orphan). Skipped entirely on an empty target
  // list: never mass-delete the mirror on a transient bad read.
  const removedOrphans: string[] = [];
  let orphanSweepSkipped = false;
  if (targets.length === 0) {
    orphanSweepSkipped = true;
  } else {
    const allSlugs = new Set(targets.map((t) => t.slug));
    for (const loc of ['active', 'archive'] as const) {
      const dir = loc === 'active' ? deps.plansDir : deps.archiveDir;
      const expected = loc === 'active' ? expectedActive : expectedArchive;
      for (const f of await deps.fs.listMarkdown(dir)) {
        if (SWEEP_KEEP.has(f) || expected.has(f)) continue;
        await deps.fs.remove(join(dir, f));
        removedOrphans.push(join(loc, f));
        // Drop the watermark only when the slug is truly gone — NOT when it just
        // relocated (still present in the other dir).
        const slug = f.replace(/\.md$/, '');
        if (!allSlugs.has(slug)) deps.renderedHashes.delete(slug);
      }
    }
  }

  return { rendered, adopted, skippedUnsettled, removedOrphans, orphanSweepSkipped };
}
