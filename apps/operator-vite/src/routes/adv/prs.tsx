import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/prs')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'prs' } });
  },
});
