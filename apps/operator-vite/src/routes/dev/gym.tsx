import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import GymDashboard from '@/app/gym/GymDashboard';

/**
 * /dev/gym — Harness Gym dashboard: prompt editor, proposer-diff review (accept→promote),
 * autoloop control, and run analytics (cycles/variants/compare/frontier) over the gym
 * control plane (`/api/gym/*`, D-020). Impl in apps/operator/app/gym/GymDashboard.tsx.
 *
 * Demoted under /dev + gated behind FLAGS.TESTING (design-simplification P-013).
 */
export const Route = createFileRoute('/dev/gym')({
  beforeLoad: () => requireFlag(FLAGS.TESTING),
  component: GymPage,
});

function GymPage() {
  return <GymDashboard />;
}
