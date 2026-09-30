import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/expert-routing/page';

/**
 * /settings/expert-routing — the consult expert-routing owner surface
 * (consult-expert-routing-2026-09-22 P-006): the ranked allowlist of models
 * allowed to answer a consult, plus the stage-2 recency half-life. Client page
 * re-exported via the page-import pattern (B-4), mirroring /settings/trust.
 */
export const Route = createFileRoute('/settings/expert-routing')({
  component: Page,
});
