import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';

/**
 * `dynamic(loader, { loading, ssr })` → `React.lazy` + a `Suspense` boundary.
 * Permanent home for the former `apps/operator-vite/shims/next-dynamic.tsx`.
 * See plan `finish-next-removal-2026-06-01`.
 *
 *   - `loading: () => <Spinner/>` becomes the `Suspense` fallback, so call
 *     sites that don't wrap their own `Suspense` still get the spinner.
 *   - `ssr: false` is a no-op under a Vite SPA (no SSR).
 *   - Loader may return `ComponentType<P>` or `{ default }`; both normalized.
 */

interface DynamicOptions {
  ssr?: boolean;
  loading?: () => ReactNode;
}

type Loader<P> = () => Promise<{ default: ComponentType<P> } | ComponentType<P>>;

export default function dynamic<P extends object>(
  loader: Loader<P>,
  options?: DynamicOptions,
): ComponentType<P> {
  const Lazy = lazy<ComponentType<P>>(async () => {
    const mod = await loader();
    return 'default' in mod ? mod : { default: mod };
  });

  const fallback: ReactNode = options?.loading ? options.loading() : null;

  const Wrapped: ComponentType<P> = (props) => (
    <Suspense fallback={fallback}>
      <Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />
    </Suspense>
  );
  return Wrapped;
}
