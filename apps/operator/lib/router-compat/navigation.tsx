import { useMemo } from 'react';
import {
  Link as TsrLink,
  useNavigate,
  useParams as useTsrParams,
  useRouterState,
  redirect as tsrRedirect,
  notFound as tsrNotFound,
} from '@tanstack/react-router';

/**
 * Router compatibility hooks — TanStack-Router-backed implementations of the
 * small `next/navigation` surface the operator's page/component tree still
 * uses (`useRouter`/`usePathname`/`useSearchParams`/`useParams`/`redirect`/
 * `notFound`/`useSelectedLayoutSegment`).
 *
 * This is the PERMANENT home for these adapters (formerly the migration-time
 * `apps/operator-vite/shims/next-navigation.tsx`, deleted with the `next/*`
 * Vite aliases). Keeping them as one shared module — rather than inlining the
 * TSR calls at ~30 sites — keeps the behaviour (refresh semantics, memoized
 * search params) DRY in one tested place. Imported via `@/lib/router-compat/*`.
 * See plan `finish-next-removal-2026-06-01`.
 *
 * Behaviour notes:
 *   - `useRouter().refresh()` re-navigates to the current URL so TSR loaders
 *     re-run (TSR's equivalent of Next's soft refresh; not a full reload).
 *   - `useRouter().prefetch()` is a no-op — TSR's `<Link>` owns preloading.
 *   - `useSearchParams()` returns a fresh `URLSearchParams` memoized on the
 *     search string (stable identity between same-search renders).
 */

export type AppRouterInstance = {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
};

export function useRouter(): AppRouterInstance {
  const navigate = useNavigate();
  return useMemo<AppRouterInstance>(
    () => ({
      push: (href: string) => {
        void navigate({ to: href });
      },
      replace: (href: string) => {
        void navigate({ to: href, replace: true });
      },
      back: () => {
        window.history.back();
      },
      forward: () => {
        window.history.forward();
      },
      refresh: () => {
        // A navigate to the current URL forces TSR loaders to re-run.
        void navigate({ to: window.location.pathname + window.location.search, replace: true });
      },
      prefetch: () => {
        // no-op — TSR's <Link> handles prefetching; manual prefetch() is rare
      },
    }),
    [navigate],
  );
}

export function usePathname(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

export function useSearchParams(): URLSearchParams {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr ?? '' });
  return useMemo(() => new URLSearchParams(searchStr), [searchStr]);
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useTsrParams({ strict: false }) as T;
}

/** `redirect(href)` — throws a TSR redirect. Must be thrown / never returns. */
export function redirect(href: string): never {
  throw tsrRedirect({ to: href });
}

/** `notFound()` — throws a TSR not-found marker. */
export function notFound(): never {
  throw tsrNotFound();
}

/**
 * Returns the last non-empty path segment — the single behaviour every
 * existing `useSelectedLayoutSegment()` call site reads.
 */
export function useSelectedLayoutSegment(): string | null {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

export { TsrLink };
