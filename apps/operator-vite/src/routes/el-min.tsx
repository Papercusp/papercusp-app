import { createFileRoute } from '@tanstack/react-router';
import ElMinPage from '@/app/el-min/page';

/**
 * /el-min — minimal ElevenLabs diagnostic. Translated from
 * `apps/operator/app/el-min/page.tsx` (clean).
 *
 * NOT demoted under /dev in design-simplification P-013: /el-min is a
 * CHROMELESS route (special-cased in LeftSidebar / DevAdminRail / ChromeShell
 * CHROMELESS_PREFIXES) and a documented iframe target, so it is not a clean
 * orphan lab. Demoting it would require updating those chrome lists + the
 * ChromeShell test; deferred rather than colliding with the in-flight sidebar
 * redesign. See the plan's P-013 note.
 */
export const Route = createFileRoute('/el-min')({
  component: ElMinPage,
});
