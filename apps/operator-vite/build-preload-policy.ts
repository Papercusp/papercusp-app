/**
 * Initial-document preload policy for lazy operator routes and panes.
 *
 * Vite 8/rolldown correctly emits these modules as dynamic chunks, but its
 * HTML builder still walks their CSS into the entry chunk's stylesheet set.
 * `build.modulePreload.resolveDependencies` can filter the JavaScript preload
 * list, but Vite deliberately keeps CSS outside that hook on both the HTML and
 * runtime-dynamic-import paths. The post HTML transform below closes only the
 * initial-document half of that gap; runtime import() dependency maps retain
 * the CSS so opening the route or pane still loads its styles on demand.
 *
 * WI-5502 carries the build + Tauri waterfall evidence behind this policy.
 */

const NON_CRITICAL_LAZY_ASSET_RE =
  /(?:^|\/)(?:InboxPane|PlanDetail|WorkItemDiscussion|triggers|review-report|plan-cleanup-report|inbox-bulk(?:-report)?|BulkResolverStrip|SessionsRosterView)-[^/]+\.(?:js|css)(?:[?#].*)?$/;

const LINK_TAG_RE = /[ \t]*<link\b[^>]*>\s*/gi;
const STYLESHEET_REL_RE = /\brel\s*=\s*(?:"stylesheet"|'stylesheet'|stylesheet)(?=\s|\/?>)/i;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;

export function isNonCriticalLazyAsset(path: string): boolean {
  return NON_CRITICAL_LAZY_ASSET_RE.test(path);
}

export function filterInitialModulePreloadDependencies(dependencies: readonly string[]): string[] {
  return dependencies.filter((dependency) => !isNonCriticalLazyAsset(dependency));
}

/**
 * Remove generated stylesheet links for known lazy chunks from built
 * `index.html`. This runs as a post transform, after Vite injects entry CSS.
 * It intentionally leaves modulepreload links, unrelated stylesheets, and all
 * source markup untouched.
 */
export function stripNonCriticalLazyStylesheetsFromInitialHtml(html: string): string {
  return html.replace(LINK_TAG_RE, (tag) => {
    if (!STYLESHEET_REL_RE.test(tag)) return tag;
    const hrefMatch = HREF_RE.exec(tag);
    const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
    return href && isNonCriticalLazyAsset(href) ? '' : tag;
  });
}
