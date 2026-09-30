import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /adv/HUD — kept as a URL, redirected into the tab strip.
 *
 * It WAS a standalone route (the board is a destination you keep open), but the
 * owner asked for it in the /adv tab strip (2026-07-25), first slot right of
 * Overview. Two surfaces for one board would have meant the strip stayed dead
 * while you were on /adv/HUD — every trigger writes `?tab=` on the CURRENT route,
 * so clicking "git" from the standalone page changed the URL and kept rendering
 * the HUD. So this follows the same convention as its `adv/*` siblings
 * (plans, insights): the tab shell owns the surface, the named route redirects.
 *
 * Casing is deliberate: TanStack file routes are case-sensitive, so this file
 * must stay `HUD.tsx` for the requested `/adv/HUD` URL to keep resolving.
 *
 * Search params carry through so a deep link like `/adv/HUD?hudcol=blocked`
 * lands on the board with the column focus intact. The HUD's nuqs keys:
 * `hudcol` / `hudfleet` / `hudplan` / `hudall` / `hudsession` (sessions board)
 * and `hudtab` / `hudecol` / `hudq` / `hudpsort` (the tab axis + the entity
 * boards + the Plans board's sort axis). This list is spread, not enumerated,
 * in `beforeLoad` — a new key needs no change here beyond keeping this comment
 * honest.
 */
export const Route = createFileRoute('/adv/HUD')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/adv', search: { ...(search ?? {}), tab: 'hud' } });
  },
});
