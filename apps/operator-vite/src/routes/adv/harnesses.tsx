import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/harnesses')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'harnesses' } });
  },
});
