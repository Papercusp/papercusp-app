import { createFileRoute } from '@tanstack/react-router';
import SwarmLogosPage from '@/app/dev/swarm-logos/page';

/** /dev/swarm-logos — bee-themed logo replacement options for The Swarm. */
export const Route = createFileRoute('/dev/swarm-logos')({
  component: SwarmLogosPage,
});
