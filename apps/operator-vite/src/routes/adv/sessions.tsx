import { createFileRoute, redirect } from '@tanstack/react-router';

// WI-3045: the standalone "Sessions" tab was folded into the "Create" dock
// (AdvCreateDock, tab id 'plans' — a dockview split of inbox/plans/sessions/
// preview panels, sidebar-navigated rather than a top-level tab of its own).
// `tab: 'sessions'` is no longer a member of AdvShell's ADV_TABS, so nuqs'
// parseAsStringEnum silently fell back to its `overview` default — this
// legacy route now lands users on the Create dock, the current home of the
// sessions view, instead.
export const Route = createFileRoute('/adv/sessions')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'plans' } });
  },
});
