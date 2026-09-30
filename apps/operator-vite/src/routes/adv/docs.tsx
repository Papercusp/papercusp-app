import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/docs')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'docs' } });
  },
});
