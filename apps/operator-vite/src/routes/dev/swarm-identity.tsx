import { createFileRoute } from '@tanstack/react-router';
import SwarmIdentityPage from '@/app/dev/swarm-identity/page';

/** /dev/swarm-identity — visual identity options for theswarm.dev. */
export const Route = createFileRoute('/dev/swarm-identity')({
  component: SwarmIdentityPage,
});
