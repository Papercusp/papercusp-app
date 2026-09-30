import { createFileRoute } from '@tanstack/react-router';
import CupboardDetailPage from '@/app/cupboard/[id]/page';

/**
 * /cupboard/$id — Cupboard harness detail. Mirrors
 * `apps/operator/app/cupboard/[id]/page.tsx`; reuses `CupboardDetailPage`,
 * which reads the `id` route param via the router-compat `useParams` shim.
 * Without this route the listing grid's "view detail" navigation
 * (`router.push('/cupboard/<id>')`) would 404.
 */
export const Route = createFileRoute('/cupboard/$id')({
  component: CupboardDetailPage,
});
