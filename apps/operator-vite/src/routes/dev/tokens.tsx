import { createFileRoute } from '@tanstack/react-router';
import TokensGallery from '@/app/dev/tokens/page';

/**
 * /dev/tokens — DTCG token gallery. Translated from
 * `apps/operator/app/dev/tokens/page.tsx` (clean).
 */
export const Route = createFileRoute('/dev/tokens')({
  component: TokensGallery,
});
