import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /signup — the create-user mode of the login screen.
 *
 * Translated from `apps/operator/app/signup/page.tsx`. Next's `redirect()`
 * called at module-load became a TSR `beforeLoad` throw-redirect. Same
 * URL effect: GET /signup → 302/SPA-replace to /login?mode=signup.
 */
export const Route = createFileRoute('/signup')({
  beforeLoad: () => {
    throw redirect({ to: '/login', search: { mode: 'signup' } });
  },
});
