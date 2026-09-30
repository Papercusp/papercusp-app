import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import OperatorMockPage from '@/app/operator-mock/page';

/**
 * /dev/operator-mock — 1385-line operator visual mock. Translated from
 * `apps/operator/app/operator-mock/page.tsx` (clean, large).
 *
 * Demoted under /dev + gated behind FLAGS.TESTING (design-simplification P-013).
 */
export const Route = createFileRoute('/dev/operator-mock')({
  beforeLoad: () => requireFlag(FLAGS.TESTING),
  component: OperatorMockPage,
});
