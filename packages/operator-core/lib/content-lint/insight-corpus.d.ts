/**
 * The agent-insights CORPUS SCOPE — the single definition of "which files are
 * agent-insight docs", shared by every lint that walks them
 * (unified-agent-state-plane-2026-07-27 P-022).
 *
 * Extracted when the corpus grew a SECOND lint (`check-insight-normative.mjs`
 * alongside `check-insight-citations.mjs`). Two scripts each carrying their own
 * copy of the prefix + extension + exclusion rules is precisely the "drifting
 * duplicate" registry.ts warns about: the moment one adds an exclusion the
 * other does not, the lints silently disagree about what the corpus IS, and a
 * doc can pass one gate while being invisible to the next.
 *
 * Deliberately dependency-light (no fs, no git, no MDX compiler) so a thin
 * `.mjs` walker can import it without dragging in registry.ts's detector
 * dependencies.
 */
/** Repo-relative prefix of the agent-insights corpus. */
export declare const INSIGHT_DOCS_PREFIX = "apps/operator-docs/src/content/docs/agent-insights/";
/**
 * True for a repo-relative path that is an agent-insight doc.
 *
 * NOTE the extension check covers BOTH `.mdx` and `.md`: the corpus is
 * overwhelmingly `.mdx` (620 of 625 at the 2026-07-27 sweep) and a glob written
 * as `*.md` alone silently misses ~99% of it.
 */
export declare function isInsightDoc(file: string): boolean;
