import { createFileRoute, redirect } from '@tanstack/react-router';

// The Config tab was retired (config-tab-cleanup-2026-06-08): its harness
// file-editor was the pre-blueprint paradigm and was removed; plugin management
// moved into the Settings tab. This legacy route now lands users on Settings.
export const Route = createFileRoute('/adv/config')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'settings' } });
  },
});
