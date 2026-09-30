import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import PublishingClient from '@/app/settings/publishing/PublishingClient';

/**
 * /settings/publishing — Cloudflare publishing settings. Translated from
 * `apps/operator/app/settings/publishing/page.tsx`. The
 * `requireFlag(FLAGS.CLOUDFLARE_PUBLISH)` gate is ported to a `beforeLoad`
 * check — see `lib/require-flag.ts`.
 */
export const Route = createFileRoute('/settings/publishing')({
  beforeLoad: () => requireFlag(FLAGS.CLOUDFLARE_PUBLISH),
  component: PublishingClient,
});
