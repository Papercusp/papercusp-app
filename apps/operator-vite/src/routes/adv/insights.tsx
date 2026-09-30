import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/insights')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'insights' } });
  },
});
