import type { ComponentProps, ReactNode } from 'react';
import { Link as TsrLink } from '@tanstack/react-router';

/**
 * `<Link href="/foo">` → TanStack-Router `<Link to="/foo">`. Permanent home
 * for the former `apps/operator-vite/shims/next-link.tsx`; the `href` prop name
 * is preserved at call sites by adapting here. See plan
 * `finish-next-removal-2026-06-01`.
 *
 * Dropped (Next-only, ignored under TSR): `prefetch` (TSR has its own
 * preloading), `legacyBehavior`, `passHref`, `as`.
 */
type NextLinkOnlyProps = {
  prefetch?: boolean;
  legacyBehavior?: boolean;
  passHref?: boolean;
  as?: string;
};

type LinkProps = NextLinkOnlyProps &
  Omit<ComponentProps<typeof TsrLink>, 'to'> & {
    href: string;
    children?: ReactNode;
  };

export default function Link({
  href,
  prefetch: _prefetch,
  legacyBehavior: _legacyBehavior,
  passHref: _passHref,
  as: _as,
  ...rest
}: LinkProps) {
  return <TsrLink to={href} {...rest} />;
}
