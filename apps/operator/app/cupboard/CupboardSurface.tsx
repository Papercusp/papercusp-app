'use client';

/**
 * The Cupboard as ONE mountable component: the listing grid, or the detail
 * page when the route carries an id (portal-parity D-007 / P-003).
 *
 * The operator has two routes here — `/cupboard` (`CupboardClient`) and
 * `/cupboard/$id` (`CupboardDetailPage`) — and its router picks between them.
 * A host that mounts the operator's components without that router (the web
 * portal) gets the same switch from this component, keyed by the very
 * `useParams().id` the detail page itself reads, so the listing's
 * `router.push('/cupboard/<id>')` lands on the detail exactly as it does in
 * the operator. The detail page is lazy so the listing does not pay for the
 * install flows it carries.
 */
import { Suspense, lazy } from 'react';
import { useParams } from '@/lib/router-compat/navigation';
import CupboardClient from './CupboardClient';

const CupboardDetailPage = lazy(() => import('./[id]/page'));

export default function CupboardSurface() {
  const id = useParams().id;
  if (!id) return <CupboardClient />;
  return (
    <Suspense fallback={null}>
      <CupboardDetailPage />
    </Suspense>
  );
}
