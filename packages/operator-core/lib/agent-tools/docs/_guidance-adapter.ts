/**
 * Guidance-corpus adapter — the agent-facing INSTRUCTION corpus as a DocSource.
 *
 * Workstream C (plan guidance-overlap-contradiction-scan-2026-08-08, P-001).
 * The engineering adapter already exposes the agent-insights runbooks; this one
 * exposes the OTHER half of what an agent is told: the repo CLAUDE.md, the
 * chat-surface prompt sources (`*.tools.md` / `*.persona.md` / friends), the
 * harness blueprint role prompts, and every per-tool `guidance:` block. Sectioned
 * through the same `syncDocSourceSections` seam under `source_key:
 * papercusp-guidance`, so embed-backfill vectorises it with no migration and no
 * second store.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠ CORPUS MEMBERSHIP IS BY EXPLICIT CANONICAL ROOT — NEVER A GLOB (plan D-002)
 * ────────────────────────────────────────────────────────────────────────────
 * Measured 2026-08-08 on this tree:
 *
 *   find . -name '*.tools.md' -o -name '*.persona.md'   →  110 files
 *   git ls-files '*.tools.md' '*.persona.md'            →   19 files
 *
 * The other 91 are UNTRACKED build output — `papercusp-desktop/src-tauri/sidecar/
 * prompts`, two `env-sidecars/staging/prompts` copies, and a cargo target dir.
 * The blueprint prompts are worse: the same 74 files exist under EIGHT roots
 * (dist-host, dist-sidecar, three desktop sidecar trees, two cargo-target trees,
 * `.papercusp/.materialized`).
 *
 * This is load-bearing rather than hygiene. The consumer of this corpus is a
 * pairwise-cosine overlap scan. Fed a glob-derived corpus it would report its
 * HIGHEST-confidence clusters on a file versus its own build copies — cosine
 * ~1.0, structurally guaranteed, 100% false positive, at 6-9x the true corpus
 * size — and it would not look wrong: the scan runs, emits many high-scoring
 * clusters, and reads as a successful first pass. It would also silently wreck
 * threshold calibration (P-003), which is fitted to the top of the score
 * distribution.
 *
 * So the roots below are an ALLOWLIST, and `listPages` additionally drops
 * byte-identical duplicates while RECORDING them in the census — if a copy root
 * is ever re-introduced, it shows up as a census warning instead of as inflated
 * findings. `_guidance-adapter.test.ts` fails if the corpus contains duplicates.
 *
 * ⚠ `libs/papercusp` is a SUBMODULE, so `git ls-files` from the superproject
 * cannot see the blueprint prompts and its silence there is not evidence of
 * absence (the standing submodule trap in the project CLAUDE.md).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DocPage, DocSource, SectionMeta } from '@papercusp/docs-engine';
import { REPO_ROOT } from './_repo-paths';

/** `source_key` these sections land under. Must match what the read leg filters on. */
export const GUIDANCE_SOURCE_NAME = 'papercusp-guidance';

const MAX_FILE_BYTES = 512 * 1024;

/**
 * Canonical file roots. Each is a SINGLE directory whose files are the source
 * of truth for that surface; build copies of the same files live elsewhere and
 * are deliberately unreachable from here (see the header).
 */
interface FileRoot {
  /** Slug namespace — `<ns>/<relative path minus extension>`. */
  ns: string;
  /** Path relative to REPO_ROOT. */
  rel: string;
  /** Max recursion depth below `rel`. */
  maxDepth: number;
  /**
   * When set, only files whose relative path contains this directory segment are
   * taken. `blueprints/` holds far more than prompts (schemas, configs); only
   * `blueprints/<name>/prompts/*.md` is agent-facing instruction text.
   */
  requireSegment?: string;
}

const FILE_ROOTS: readonly FileRoot[] = [
  // Chat-surface prompt sources: *.tools.md, *.persona.md, *.converse.md,
  // *.shell.md, the psu playbooks, plus kickoffs/ pot-instances/
  // power-user-skills/ tutorial/ subtrees.
  { ns: 'prompts', rel: path.join('apps', 'operator', 'prompts'), maxDepth: 3 },
  // Harness blueprint role prompts (the spawn-time personas).
  {
    ns: 'blueprints',
    rel: path.join('libs', 'papercusp', 'packages', 'harness', 'blueprints'),
    maxDepth: 3,
    requireSegment: 'prompts',
  },
];

/** Individually-named canonical files (no directory walk). */
const SINGLE_FILES: ReadonlyArray<{ slug: string; rel: string }> = [
  { slug: 'repo/claude-md', rel: 'CLAUDE.md' },
];

/**
 * Census of what the corpus actually contains, per source kind.
 *
 * Exists because of D-001: an empty or short result from this corpus must never
 * be readable as "the corpus is clean". A caller that finds zero overlaps needs
 * to know whether it scanned 800 pages or 3.
 */
export interface GuidanceCensus {
  claudeMd: number;
  prompts: number;
  blueprints: number;
  toolGuidance: number;
  total: number;
  /** Byte-identical pages dropped (a re-introduced copy root would land here). */
  duplicatesDropped: number;
  registrySource: string | null;
  registryRevision: string | null;
  correctiveCallsChecked: number;
  /**
   * Tool names whose guidance page was SKIPPED because building it failed —
   * the skip-and-warn set (EI-22187811297314993: a single non-conforming
   * tool used to `return []` the WHOLE corpus instead of dropping just its
   * own page). Empty in the healthy case; a regression names the offending
   * tool here instead of forcing a bisect of the whole catalog.
   */
  toolGuidanceSkipped: string[];
  /**
   * Non-fatal conditions that make the census an UNDER-count. Non-empty means a
   * downstream "no overlaps found" verdict is INCONCLUSIVE, not clean.
   */
  warnings: string[];
}

function emptyCensus(): GuidanceCensus {
  return {
    claudeMd: 0,
    prompts: 0,
    blueprints: 0,
    toolGuidance: 0,
    total: 0,
    duplicatesDropped: 0,
    registrySource: null,
    registryRevision: null,
    correctiveCallsChecked: 0,
    toolGuidanceSkipped: [],
    warnings: [],
  };
}

function extractHeadings(content: string): DocPage['toc'] {
  const out: DocPage['toc'] = [];
  for (const line of content.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    out.push({ id: text.replace(/[^A-Za-z0-9]/g, '-'), text, depth: m[1].length });
    if (out.length >= 100) break;
  }
  return out;
}

function extractTitle(content: string, fallback: string): string {
  for (const line of content.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return fallback;
}

async function readSafe(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return await fs.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
}

async function walkMarkdown(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && /\.mdx?$/i.test(e.name)) out.push(full);
    }
  }
  await walk(root, 0);
  return out;
}

/* ─── per-tool guidance blocks ─────────────────────────────────────────── */

/**
 * Shape we read off the runtime registry. Deliberately structural rather than a
 * type-import: the registry lives in `@papercusp/tooldef` and is loaded through a
 * dynamic import (below) to keep it out of this module's static graph.
 *
 * ⚠ The name is at `expose.mcp.name`, NOT `.name` — inventing a `{ name }` shape
 * here builds a silently EMPTY corpus (EI-19283613546965405, where exactly that
 * mistake produced a confident zero).
 */
interface RegistryTool {
  description?: string;
  expose?: { mcp?: { name?: string } };
  guidance?: {
    when?: string;
    notWhen?: string;
    chaining?: string;
    returns?: string;
    argRedirects?: Record<string,
      | string
      | { tool: string; args: Record<string, unknown>; note?: string }
      | { drop: true; note: string }
    >;
    byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
  };
}

/** Render one tool's guidance as a markdown page the sectioner can split. */
export function renderToolGuidancePage(
  name: string,
  tool: RegistryTool,
  correctiveCalls: Array<{ rejectedArg: string; rendered: string; note?: string }> = [],
): string | null {
  const g = tool.guidance;
  if (!g) return null;
  const parts: string[] = [`# ${name}`, ''];
  if (tool.description) parts.push(tool.description, '');
  const field = (heading: string, value?: string): void => {
    if (value && value.trim()) parts.push(`## ${heading}`, '', value.trim(), '');
  };
  field('When', g.when);
  field('Not when', g.notWhen);
  field('Chaining', g.chaining);
  field('Returns', g.returns);
  for (const correction of correctiveCalls) {
    field(
      `Correction for rejected arg: ${correction.rejectedArg}`,
      `\`${correction.rendered}\`${correction.note ? ` — ${correction.note}` : ''}`,
    );
  }
  for (const [role, override] of Object.entries(g.byRole ?? {})) {
    field(`Role override: ${role} — when`, override.when);
    field(`Role override: ${role} — not when`, override.notWhen);
    field(`Role override: ${role} — chaining`, override.chaining);
  }
  // Nothing but the title + description ⇒ no authored guidance worth a vector.
  if (parts.filter((p) => p.startsWith('## ')).length === 0) return null;
  return parts.join('\n');
}

/** Slug-safe rendering of an MCP tool name (`work_items:claim` → `work_items-claim`). */
function toolSlug(mcpName: string): string {
  return mcpName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function loadToolGuidancePages(
  census: GuidanceCensus,
): Promise<Array<{ slug: string; title: string; body: string }>> {
  let tools: readonly RegistryTool[];
  let resolveCorrectiveCalls: (
    name: string,
  ) => Array<{ rejectedArg: string; rendered: string; note?: string }>;
  try {
    const mod = (await import('@papercusp/tooldef')) as {
      listAllProjectedTools?: () => readonly RegistryTool[];
      projectedToolCorrectiveCalls?: (
        name: string,
      ) => Array<{ rejectedArg: string; rendered: string; note?: string }>;
      assertProjectedToolGuidanceConformance?: () => {
        source: string;
        registryRevision: string;
        correctiveCallsChecked: number;
      };
      PROJECTED_TOOL_REGISTRY_SOURCE?: string;
      projectedToolRegistryRevision?: () => string;
    };
    if (
      typeof mod.listAllProjectedTools !== 'function' ||
      typeof mod.projectedToolCorrectiveCalls !== 'function' ||
      typeof mod.assertProjectedToolGuidanceConformance !== 'function' ||
      typeof mod.projectedToolRegistryRevision !== 'function' ||
      typeof mod.PROJECTED_TOOL_REGISTRY_SOURCE !== 'string'
    ) {
      census.warnings.push('tooldef registry/conformance accessor missing — tool guidance NOT indexed');
      return [];
    }
    tools = mod.listAllProjectedTools();
    resolveCorrectiveCalls = mod.projectedToolCorrectiveCalls;

    // Registry identity is independent of whether every redirect passes the
    // EXHAUSTIVE role×profile×modality rail below — derive it directly so a
    // single bad redirect elsewhere in the registry can't blank out metadata
    // that describes the registry itself (EI-22187811297314993).
    census.registrySource = mod.PROJECTED_TOOL_REGISTRY_SOURCE;
    census.registryRevision = mod.projectedToolRegistryRevision();

    // The exhaustive conformance rail. THIS is the call that amplified ONE
    // non-conforming tool/profile combo into wiping ALL ~835 pages
    // (EI-22187811297314993): it throws on the FIRST failure it finds,
    // across the WHOLE registry. Isolate its failure from corpus building —
    // a broken rail means "this diagnostic could not finish", never "no
    // guidance exists". The per-tool loop below still builds every page it
    // legitimately can.
    try {
      mod.assertProjectedToolGuidanceConformance();
    } catch (err) {
      const message = (err as Error).message;
      const offender = /tool contract unavailable: ([^\s(]+)/.exec(message)?.[1];
      census.warnings.push(
        offender
          ? `conformance rail did not complete — first blocker: ${offender} (${message})`
          : `conformance rail did not complete: ${message}`,
      );
    }
  } catch (err) {
    census.warnings.push(`tooldef registry unreadable (${(err as Error).message}) — tool guidance NOT indexed`);
    return [];
  }

  // An EMPTY registry means the tool modules were never imported in this
  // process, not that no tool has guidance. Saying so is the whole point: the
  // caller must not read a thin corpus as a clean one, and the sync wrapper
  // below refuses to PRUNE on it (otherwise one un-warmed process deletes every
  // tool-guidance row the warm one wrote).
  if (tools.length === 0) {
    census.warnings.push('tool registry is EMPTY (tool modules not loaded in this process) — tool guidance NOT indexed');
    return [];
  }

  const out: Array<{ slug: string; title: string; body: string }> = [];
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name) continue;
    // Skip-and-warn (EI-22187811297314993): a single tool's malformed remedy
    // must drop only ITS page, never the other ~834. Name the offender so the
    // next agent doesn't have to bisect the whole catalog to find it.
    let correctiveCalls: Array<{ rejectedArg: string; rendered: string; note?: string }>;
    try {
      correctiveCalls = resolveCorrectiveCalls(name);
    } catch (err) {
      census.toolGuidanceSkipped.push(name);
      census.warnings.push(`tool guidance skipped: ${name} (${(err as Error).message})`);
      continue;
    }
    census.correctiveCallsChecked += correctiveCalls.length;
    const body = renderToolGuidancePage(name, tool, correctiveCalls);
    if (body === null) continue;
    out.push({ slug: `tool-guidance/${toolSlug(name)}`, title: `Tool guidance: ${name}`, body });
  }
  return out;
}

/* ─── the adapter ──────────────────────────────────────────────────────── */

interface GuidancePage extends DocPage {
  /** Rendered body, held so `getContent` never re-reads a file mid-sync. */
  body: string;
}

export interface GuidanceAdapter extends DocSource {
  /**
   * Census of the LAST `listPages()` call. Undefined until one has run —
   * deliberately not defaulted to zeroes, so "not measured" is distinguishable
   * from "measured zero".
   */
  lastCensus(): GuidanceCensus | undefined;
}

export interface GuidanceAdapterOptions {
  /** Override the repo root (tests). */
  repoRoot?: string;
  /** Source name override (tests). */
  name?: string;
  /** Skip the runtime tool registry (tests that only exercise the file legs). */
  includeToolGuidance?: boolean;
}

export function guidanceAdapter(opts: GuidanceAdapterOptions = {}): GuidanceAdapter {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const name = opts.name ?? GUIDANCE_SOURCE_NAME;
  const includeTools = opts.includeToolGuidance !== false;

  let cache: Map<string, GuidancePage> | null = null;
  let census: GuidanceCensus | undefined;

  async function build(): Promise<Map<string, GuidancePage>> {
    if (cache) return cache;
    const c = emptyCensus();
    const pages = new Map<string, GuidancePage>();
    const byContent = new Map<string, string>(); // sha256(body) → first slug

    const add = (slug: string, title: string, body: string, kind: keyof GuidanceCensus): void => {
      const sha = createHash('sha256').update(body).digest('hex');
      const first = byContent.get(sha);
      if (first !== undefined) {
        // Byte-identical to a page we already hold. Dropping it is what keeps a
        // re-introduced copy root from manufacturing perfect-score clusters.
        c.duplicatesDropped += 1;
        c.warnings.push(`duplicate content: ${slug} is byte-identical to ${first}`);
        return;
      }
      byContent.set(sha, slug);
      pages.set(slug, {
        slug,
        slugs: slug.split('/'),
        url: '',
        title,
        toc: extractHeadings(body),
        body,
      });
      (c[kind] as number) += 1;
    };

    for (const f of SINGLE_FILES) {
      const abs = path.join(repoRoot, f.rel);
      const body = await readSafe(abs);
      if (body === null) {
        c.warnings.push(`missing canonical file: ${f.rel}`);
        continue;
      }
      add(f.slug, extractTitle(body, f.rel), body, 'claudeMd');
    }

    for (const root of FILE_ROOTS) {
      const dir = path.join(repoRoot, root.rel);
      const files = await walkMarkdown(dir, root.maxDepth);
      if (files.length === 0) {
        c.warnings.push(`canonical root empty or unreadable: ${root.rel}`);
        continue;
      }
      for (const abs of files) {
        const rel = path.relative(dir, abs);
        if (root.requireSegment && !rel.split(path.sep).includes(root.requireSegment)) continue;
        const body = await readSafe(abs);
        if (body === null) continue;
        const stem = rel.replace(/\.mdx?$/i, '').split(path.sep).join('/');
        const slug = `${root.ns}/${stem}`;
        add(slug, extractTitle(body, stem), body, root.ns === 'prompts' ? 'prompts' : 'blueprints');
      }
    }

    if (includeTools) {
      for (const t of await loadToolGuidancePages(c)) {
        add(t.slug, t.title, t.body, 'toolGuidance');
      }
    } else {
      c.warnings.push('tool guidance intentionally excluded (includeToolGuidance: false)');
    }

    c.total = pages.size;
    census = c;
    cache = pages;
    return pages;
  }

  return {
    name,
    lastCensus: () => census,
    async listPages(): Promise<DocPage[]> {
      const built = await build();
      return [...built.values()].map(({ body: _body, ...page }) => page);
    },
    async getPage(slug: string): Promise<DocPage | null> {
      const built = await build();
      const p = built.get(slug);
      if (!p) return null;
      const { body: _body, ...page } = p;
      return page;
    },
    async getContent(page: DocPage): Promise<string> {
      const built = await build();
      const p = built.get(page.slug);
      if (!p) throw new Error(`guidanceAdapter: page ${page.slug} not found`);
      return p.body;
    },
    async getSectionMeta(_sectionSlug: string): Promise<SectionMeta> {
      return {};
    },
  };
}
