import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /settings/mobile — replaced by Settings → Remote access (external-app-access P-010, D-025);
 * phone pairing lives there as "Pair a phone". Old links land on that panel.
 */
export const Route = createFileRoute('/settings/mobile')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/remote-access', search: { pair: true } as never });
  },
});
