/**
 * The ONE safe renderer for `ts_headline` output (security-boundary-remediation-
 * and-usability-2026-09-04 P-003, under D-001: enforce at the existing safe-
 * renderer chokepoint, keep the capability — highlighting — working).
 *
 * WHY THIS EXISTS AT ALL. Search hits are drawn from corpora that are FULL of
 * markup by nature: agent transcripts quote HTML, JSX, `<script>` snippets and
 * shell one-liners; escalations and brainstorm notes paste stack traces and tag
 * soup. Passing a headline straight to `dangerouslySetInnerHTML` therefore
 * executes whatever the corpus happens to contain — the hostile path is not an
 * exotic injection, it is an ordinary turn that mentioned `<img onerror=…>`.
 *
 * THE CONTRACT, in the order it runs — the order is the whole mechanism:
 *   1. escape `&`, `<`, `>` — EVERYTHING becomes inert text, including any
 *      markup the corpus carried;
 *   2. restore ONLY the exact byte sequences `&lt;mark&gt;` / `&lt;/mark&gt;`.
 *
 * Because step 2 matches the BARE tag exactly, an attribute-bearing lookalike
 * (`<mark onmouseover=alert(1)>`) escapes in step 1 and never matches in step
 * 2 — it stays visible as literal text. That is the property the regression
 * tests pin, and it is why the restore must stay an exact-string replace and
 * never become a regex with an attribute allowance.
 *
 * WHICH SURFACES THIS IS FOR. `<mark>` is the delimiter this workspace's own
 * search engine is configured with — `StartSel=<mark>, StopSel=</mark>` in
 * `packages/operator-core/lib/agent-tools/search/sources.ts` (the `SEARCH_SOURCES`
 * that back `/api/user/search`) and the same `<mark>` convention in
 * `packages/operator-core/lib/adv-session-search.ts` (the transcript search
 * behind `/api/adv/sessions/search-transcripts`). Consumers today:
 *   - `apps/operator-vite/src/components/adv/AgentsPillSessions.tsx` (agents-pill
 *     session search),
 *   - `apps/operator/app/_components/plans/PlanSessionsTab.tsx` (plan-session
 *     transcript results),
 *   - `apps/operator/app/settings/user/search/page.tsx` (workspace search prose).
 *
 * ⚠ NOT for `GlobalSearchDialog`, even though it searches the same corpora with
 * the same `<mark>` marker. That surface builds React text nodes and `<mark>`
 * ELEMENTS via its own `renderHighlight` and touches no innerHTML at all — a
 * strictly stronger position than this function, which only makes a string safe
 * to hand to innerHTML. Moving it onto this helper would be a downgrade.
 *
 * (Corrected 2026-09-04: an earlier version of this note claimed that surface
 * was `<b>`-delimited because `ts_headline` DEFAULTS to `<b>…</b>`. The default
 * is real; the claim about the route was not — `HEADLINE_OPTS` in
 * `packages/operator-core/lib/agent-tools/search/sources.ts` overrides it to
 * `<mark>` for all four sources, and `search:fulltext` passes that through. The
 * renderer had made the same wrong assumption, so its highlighting was dead.
 * Whatever the delimiter, do not widen THIS function's restored set beyond the
 * bare `<mark>` pair — that is the direction that loses the property above.)
 *
 * WHY IT LIVES HERE. `apps/operator/app/**` cannot import up-layer from
 * `apps/operator-vite/src/**`, but BOTH trees resolve `@` to `apps/operator`
 * (operator-vite's `vite.config.ts` and `vitest.config.ts` alias it; operator's
 * own tsconfig maps `@/*` → `./*`). `apps/operator/lib/` is therefore the only
 * place a single implementation can serve all three consumers — which is the
 * point: three copies of an escaper drift, and the copy that drifts is the one
 * that stops escaping.
 *
 * Pure, no DOM, no React — directly unit-testable.
 */
export function headlineToSafeHtml(headline: string): string {
  return headline
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('&lt;mark&gt;', '<mark>')
    .replaceAll('&lt;/mark&gt;', '</mark>');
}

/**
 * The full display string for a search hit, safely.
 *
 * Every consumer renders `highlight || excerpt`, and that fallback is
 * load-bearing rather than cosmetic: `highlight` is legitimately EMPTY for a
 * hit whose source deferred highlight hydration (WI-4734) or whose hydration
 * degraded, and — separately — for a purely semantic hit the lexical ranker
 * never returned, since there is no matched term to mark. `libs/generic/search`
 * documents both cases. Without the fallback those rows render as blank cards.
 *
 * The fallback arm needs escaping just as much as the highlight arm — arguably
 * more, since an excerpt is the raw head of the document with no engine
 * post-processing at all — so it goes through the same escaper. It simply
 * contains no `<mark>` to restore.
 */
export function hitDisplayHtml(hit: { highlight?: string | null; excerpt?: string | null }): string {
  return headlineToSafeHtml(hit.highlight || hit.excerpt || '');
}
