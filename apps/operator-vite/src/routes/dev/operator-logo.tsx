import { createFileRoute } from '@tanstack/react-router';
import OperatorLogoLabPage from '@/app/dev/operator-logo/page';

/** /dev/operator-logo — Hive visual identity preview lab. */
export const Route = createFileRoute('/dev/operator-logo')({
  component: OperatorLogoLabPage,
});
