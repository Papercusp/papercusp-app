import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/settings')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'settings' } });
  },
});
