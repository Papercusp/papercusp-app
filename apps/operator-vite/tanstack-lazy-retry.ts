/**
 * Build plugin: give TanStack Router's autoCodeSplitting route-component chunk
 * loads the same retry the React shell already has (WI-2902).
 *
 * When `autoCodeSplitting` is on, `@tanstack/router-plugin` (a `pre`-enforced
 * transform) rewrites every route module to:
 *
 *     import { lazyRouteComponent } from '@tanstack/react-router'
 *     const SplitComponentImporter = () => import('./route.tsx?tsr-split=component')
 *     // …
 *     component: lazyRouteComponent(SplitComponentImporter, 'component')
 *
 * TanStack's `lazyRouteComponent` does NOT retry a failed import and CACHES the
 * rejection, so a transient chunk-fetch failure (first-boot operator event-loop
 * starvation) dead-ends at the fatal route error card. This plugin runs `post`
 * (after the splitter's `pre` transform) and rewrites that emitted import to
 * pull `lazyRouteComponent` from our retry wrapper instead — every route
 * component gets a retrying importer with zero per-route edits.
 *
 * The rewritten specifier is computed RELATIVE to each route file so the build
 * is portable across machines (no alias dependency; operator-vite's `@` alias
 * points at apps/operator, not this app's src).
 */
import { relative, dirname, resolve, sep } from 'node:path';
import MagicString from 'magic-string';
import type { Plugin } from 'vite';

/**
 * Matches the SINGLE-specifier import `@tanstack/router-plugin` emits into every
 * split route module:
 *
 *     import { lazyRouteComponent } from '@tanstack/react-router'
 *
 * Whitespace/quote/semicolon tolerant. The plugin emits this as its OWN
 * statement (a fresh `unshiftContainer`), never merged with other names, so
 * matching a single-specifier import can't strip a co-imported symbol.
 * Exported for the contract test that pins this to the plugin's actual emit.
 */
export const TANSTACK_LAZY_IMPORT_RE =
  /import\s*\{\s*lazyRouteComponent\s*\}\s*from\s*['"]@tanstack\/react-router['"]\s*;?/;

/** The replacement import statement, given a specifier for the retry module. */
export function retryImportStatement(retrySpecifier: string): string {
  return `import { lazyRouteComponentWithRetry as lazyRouteComponent } from '${retrySpecifier}';`;
}

/**
 * Pure rewrite: swap the TanStack `lazyRouteComponent` import for our retry
 * wrapper. Returns the new code, or `null` if nothing matched. Exported for
 * tests (the plugin itself uses MagicString to preserve the sourcemap).
 */
export function rewriteLazyRouteComponentImport(
  code: string,
  retrySpecifier: string,
): string | null {
  if (!TANSTACK_LAZY_IMPORT_RE.test(code)) return null;
  return code.replace(TANSTACK_LAZY_IMPORT_RE, retryImportStatement(retrySpecifier));
}

export function tanstackLazyRetryPlugin(): Plugin {
  // Retry module: apps/operator-vite/src/lib/lazy-route-component-retry.ts.
  const retryModuleAbs = resolve(import.meta.dirname, 'src/lib/lazy-route-component-retry');
  const routesDir = resolve(import.meta.dirname, 'src/routes') + sep;
  let matches = 0;
  let sawRoute = false;

  return {
    name: 'papercusp:tanstack-lazy-retry',
    // Run AFTER the tanstack code-splitter (`enforce: 'pre'`) so we see its
    // emitted `lazyRouteComponent` import.
    enforce: 'post',
    transform(code, id) {
      const clean = id.split('?')[0];
      // Only route reference modules — skip the `?tsr-split` virtual chunks
      // (they carry the component itself, not the wrapper import).
      if (!clean.startsWith(routesDir)) return null;
      if (id.includes('tsr-split')) return null;
      sawRoute = true;
      const m = TANSTACK_LAZY_IMPORT_RE.exec(code);
      if (!m || m.index === undefined) return null;

      let specifier = relative(dirname(clean), retryModuleAbs).split(sep).join('/');
      if (!specifier.startsWith('.')) specifier = `./${specifier}`;

      const s = new MagicString(code);
      s.overwrite(m.index, m.index + m[0].length, retryImportStatement(specifier));
      matches += 1;
      return { code: s.toString(), map: s.generateMap({ hires: true }) };
    },
    buildEnd() {
      // Contract guard: rewriting ZERO route modules means route-component chunk
      // loads silently lost their retry — the exact regression this fixes, one
      // layer up. Fail loud instead of shipping the fatal card back. Two causes,
      // distinguished for the fix-forward:
      if (matches === 0) {
        if (!sawRoute) {
          // The transform never even SAW a route module → our routesDir/id
          // matching is wrong (e.g. this app's src layout moved).
          this.warn(
            '[tanstack-lazy-retry] saw 0 route modules — the src/routes matcher is stale; ' +
              'route-component chunk loads are NOT retried (WI-2902).',
          );
        } else {
          // We saw route modules but matched none → @tanstack/router-plugin
          // changed its emitted `import { lazyRouteComponent }` shape.
          this.warn(
            '[tanstack-lazy-retry] matched 0 of the route modules seen — @tanstack/router-plugin ' +
              'may have changed its emitted `import { lazyRouteComponent }` shape; route-component ' +
              'chunk loads are NO LONGER retried (WI-2902). Update TANSTACK_LAZY_IMPORT_RE.',
          );
        }
      }
    },
  };
}
