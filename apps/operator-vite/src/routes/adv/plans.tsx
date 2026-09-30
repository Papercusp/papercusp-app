import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/plans')({
  // Carry through every search param to /adv so deep links like
  // `/adv/plans?slug=<harness>&plan=<planSlug>` (rendered by
  // FeatureList, ProposalsPanel, PromotePlanBlock) land in the Plans
  // tab with both the active harness and the open plan resolved.
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/adv', search: { ...(search ?? {}), tab: 'plans' } });
  },
});
