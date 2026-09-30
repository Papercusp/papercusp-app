/**
 * Agent-insights index — compact title + description list for the
 * session-start prelude.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 3, P-011 + P-012).
 *
 * Why not just use the Starlight-emitted `llms-small.txt`?
 * The Starlight `llms-small.txt` output for the agent-insights section
 * includes the full body of every insight (~50 lines × 35 insights),
 * blowing out the prelude token budget. For the prelude we only want
 * slug + title + 1-line description so the agent knows the surface
 * area; the full body is one `docs:get` call away when needed.
 *
 * This module reads the .mdx files in
 * `apps/operator-docs/src/content/docs/agent-insights/`, parses the
 * YAML frontmatter, filters out `status: retired|superseded`, and
 * emits a markdown list ready to splice into a system prompt.
 *
 * Pure-IO module: only `fs.promises` + a small frontmatter parser.
 * No fumadocs, no starlight runtime dep.
 */
export interface InsightEntry {
    slug: string;
    title: string;
    description: string;
    status: string;
    tags: string[];
}
/**
 * Minimal YAML frontmatter parser — handles the shapes the
 * agent-insights files actually use: top-level string scalars, an
 * INLINE array (`tags: [a, b]`), and a BLOCK list (`documents:` followed
 * by `  - item` lines). Not a general YAML parser; explicitly
 * single-purpose so this module has zero deps.
 *
 * Block-list support matters because it is the corpus's DOMINANT list
 * style — a 2026-07-27 sweep found 572/625 docs writing `documents:` and
 * 248 writing `plans:` that way (vs `tags:`, which is always inline). A
 * key parsed without it yields `''`, i.e. silently "absent", which would
 * make any lint keyed on a list field (see content-lint/insight-normative.ts)
 * false-positive on the majority authoring style.
 */
export declare function parseFrontmatter(raw: string): Record<string, string | string[]> | null;
/**
 * Read one .mdx file and produce its InsightEntry (or null when the
 * file lacks valid frontmatter / is the section index page).
 */
export declare function readInsight(filePath: string): Promise<InsightEntry | null>;
/**
 * Read the entire insights directory. Filters out retired/superseded.
 */
export declare function readInsightsDir(dir: string): Promise<InsightEntry[]>;
/**
 * Render the prelude block. Format:
 *
 *   ## Agent insights
 *
 *   Project-specific runbook entries. Drill in with
 *   `docs:get { slugs: ['<slug>'] }` if any look relevant.
 *
 *   - <slug> — <description first sentence>
 *   - …
 *
 * Returns `null` when there are no visible insights — caller can
 * conditionally skip the section.
 */
export declare function renderInsightsPrelude(entries: InsightEntry[]): string | null;
