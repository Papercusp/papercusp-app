import { createFileRoute } from '@tanstack/react-router';
import CupboardClient from '@/app/cupboard/CupboardClient';

/**
 * /cupboard — the Cupboard harness registry (card grid). Mirrors
 * `apps/operator/app/cupboard/page.tsx`; reuses the self-fetching
 * `CupboardClient` via the `@/app` alias (the global ChromeShell supplies the
 * surrounding nav). The navbar "Cupboard" link points here — previously it
 * opened the external `cupboard.papercusp.com`, so the in-app page was
 * unreachable from the nav.
 */
export const Route = createFileRoute('/cupboard/')({
  component: CupboardPage,
});

function CupboardPage() {
  return <CupboardClient />;
}
