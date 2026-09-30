import { Outlet } from '@tanstack/react-router';
import '@/app/dev/dev.css';

/**
 * `/dev` layout body, split out of `routes/dev.tsx` (WI-5502 item 2).
 *
 * `@tanstack/router-plugin`'s `autoCodeSplitting` moves a route's
 * `component:` FUNCTION into a lazy chunk automatically, but it does not
 * relocate a bare side-effect import (`import '...css'`) that sits beside it
 * in the same source file — the import has no bound identifier for the
 * codemod to trace into the split component's dependency graph, so it stays
 * in the eagerly-loaded route-registration file. `dev.css` (~42KB) was
 * therefore modulepreloaded on every first paint even though it only styles
 * this route. Routing the CSS import through this file, which is reached
 * only via `routes/dev.tsx`'s own `lazyRouteComponent(() => import(...))`
 * call, gives it a real dynamic-import boundary: Vite emits it as its own
 * chunk with a runtime-injected `<link>`, loaded only when `/dev` is
 * actually visited. See /internal/docs/performance.
 */
export default function DevLayoutContent() {
  return <Outlet />;
}
