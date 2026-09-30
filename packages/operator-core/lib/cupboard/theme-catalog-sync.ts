/**
 * Theme catalog invalidation has no coalescing window. Install → update →
 * remove are ordinary rapid user actions, and dropping the second name-only
 * event behind sync-sse's 90s default leaves mounted pickers stale until their
 * 180s drift-repair poll.
 *
 * Keep this in one helper so every HTTP/agent writer inherits the same
 * committed-write contract. Dynamic import avoids a sync-resolver cycle:
 * sync-resolver loads custom-themes/theme-store to read this catalog, while
 * sync-sse itself imports the resolver's table bridge.
 */
export const THEME_CATALOG_QUERY = 'themes.catalog';

export async function notifyThemeCatalogChanged(): Promise<void> {
  const { notifySyncInvalidate } = await import('../sync-sse');
  await notifySyncInvalidate(THEME_CATALOG_QUERY, undefined, undefined, { dedupeWindowMs: 0 });
}
