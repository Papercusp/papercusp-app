/**
 * unhandled-directives-source — the owner's "nobody is handling these" list
 * (owner-directive-delivery-redesign-2026-09-22 P-008 / R-7).
 *
 * Derived live on every read, never stored: an open owner directive whose
 * session ENDED, with no live fleet leader or work-item holder to take it
 * (owner-directive-routing.ts). The moment any session adopts and closes it,
 * or a holder picks it up, it drops off by construction.
 *
 * Its own module so the attention route's test can mock it by path, the way
 * needs-human-work-items-source.ts is mocked.
 */
import type { UnhandledDirectiveInput } from './adapters';

export async function readUnhandledDirectives(input: { workspaceId: string }): Promise<UnhandledDirectiveInput[]> {
  const [{ listOwnerDirectives }, { directiveDisplayText }, { routeOpenDirectives }] = await Promise.all([
    import('../owner-directives'),
    import('../owner-directive-display'),
    import('../owner-directive-routing'),
  ]);
  const open = await listOwnerDirectives({ workspaceId: input.workspaceId, state: ['open'], limit: 200 });
  if (open.length === 0) return [];
  const routes = await routeOpenDirectives(input.workspaceId, open);
  const out: UnhandledDirectiveInput[] = [];
  for (const row of open) {
    const route = routes.get(row.id);
    if (route?.kind !== 'unhandled') continue;
    out.push({
      directiveId: row.id,
      displayText: directiveDisplayText(row),
      recordedBy: row.recordedBy,
      why: route.why,
      fleetSlug: route.fleetSlug,
      createdAt: new Date(row.createdAtMs).toISOString(),
    });
  }
  return out;
}
