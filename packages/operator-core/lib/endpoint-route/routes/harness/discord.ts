/**
 * GET /api/harness/:slug/discord  — read discord config + live widget data
 * PUT /api/harness/:slug/discord  — save { guildId, inviteUrl } to config.json
 *
 * A harness is "shared" when `.papercusp/shared.json` exists in its repo root.
 * Discord config (guildId + inviteUrl) lives in config.json under the
 * top-level `discord` key — PG-canonical, never committed to git.
 *
 * Widget data is fetched server-side and cached per guild_id for 5 minutes
 * to stay well within Discord's rate limits.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from '../../../harness-registry';
import { loadProjectFiles, saveProjectFiles } from '../../../harness-project-files';
import { defineTool } from '@papercusp/agent-mcp';
import { pinModuleState } from '@papercusp/module-singleton';

const HARNESS_SHARED_JSON = '.papercusp/shared.json';
const WIDGET_TTL_MS = 5 * 60 * 1000;

interface WidgetCacheEntry {
  ts: number;
  presenceCount: number | null;
  name: string | null;
}

// Realm-pinned rather than hand-rolled on globalThis: a split module record would
// give each copy its OWN cache, so the TTL would keep working while quietly halving
// its hit rate — a performance regression with no error and nothing to grep for.
// Key string unchanged; pinModuleState also makes such a split reportable via
// listModuleDuplications() instead of invisible.
const widgetCacheState = pinModuleState<{ cache: Map<string, WidgetCacheEntry> }>(
  'papercusp.discordWidgetCache',
  () => ({ cache: new Map<string, WidgetCacheEntry>() }),
);
function getWidgetCache(): Map<string, WidgetCacheEntry> {
  return widgetCacheState.cache;
}

async function fetchWidget(
  guildId: string,
): Promise<{ presenceCount: number | null; name: string | null }> {
  const cache = getWidgetCache();
  const now = Date.now();
  const hit = cache.get(guildId);
  if (hit && now - hit.ts < WIDGET_TTL_MS) {
    return { presenceCount: hit.presenceCount, name: hit.name };
  }
  try {
    const res = await fetch(
      `https://discord.com/api/guilds/${guildId}/widget.json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) {
      cache.set(guildId, { ts: now, presenceCount: null, name: null });
      return { presenceCount: null, name: null };
    }
    const data = (await res.json()) as { presence_count?: number; name?: string };
    const entry: WidgetCacheEntry = {
      ts: now,
      presenceCount: typeof data.presence_count === 'number' ? data.presence_count : null,
      name: typeof data.name === 'string' ? data.name : null,
    };
    cache.set(guildId, entry);
    return { presenceCount: entry.presenceCount, name: entry.name };
  } catch {
    cache.set(guildId, { ts: now, presenceCount: null, name: null });
    return { presenceCount: null, name: null };
  }
}

function resolveHarnessPath(slug: string, projects: Array<{ slug: string; path: string }>): string | null {
  return projects.find((p) => p.slug === slug)?.path ?? null;
}

function parseDiscordConfig(configJson: string | null): { guildId: string; inviteUrl: string } | null {
  if (!configJson) return null;
  try {
    const cfg = JSON.parse(configJson) as Record<string, unknown>;
    const d = cfg.discord as Record<string, unknown> | undefined;
    if (!d) return null;
    const guildId = typeof d.guildId === 'string' ? d.guildId.trim() : '';
    const inviteUrl = typeof d.inviteUrl === 'string' ? d.inviteUrl.trim() : '';
    if (!guildId) return null;
    return { guildId, inviteUrl };
  } catch {
    return null;
  }
}

const getDiscord = defineTool({
  method: 'GET',
  path: '/harness/:slug/discord',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const reg = await loadHarnessRegistry();
    const harnessPaths = reg.projects;
    const harnesssPath = resolveHarnessPath(slug, harnessPaths);
    if (!harnesssPath) return Response.json({ error: 'unknown harness' }, { status: 404 });

    const isShared = existsSync(join(harnesssPath, HARNESS_SHARED_JSON));
    const pg = await loadProjectFiles(slug);
    const discordCfg = parseDiscordConfig(pg.config);

    let widget: { presenceCount: number | null; name: string | null } | null = null;
    if (discordCfg?.guildId) {
      widget = await fetchWidget(discordCfg.guildId);
    }

    return Response.json({
      isShared,
      discord: discordCfg,
      widget,
    });
  },
});

const putDiscord = defineTool({
  method: 'PUT',
  path: '/harness/:slug/discord',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const reg = await loadHarnessRegistry();
    const harnessPaths = reg.projects;
    const harnesssPath = resolveHarnessPath(slug, harnessPaths);
    if (!harnesssPath) return Response.json({ error: 'unknown harness' }, { status: 404 });

    const isShared = existsSync(join(harnesssPath, HARNESS_SHARED_JSON));
    if (!isShared) {
      return Response.json({ error: 'Discord can only be configured for shared harnesses' }, { status: 400 });
    }

    const body = (await req.json()) as { guildId?: unknown; inviteUrl?: unknown };
    const guildId = typeof body.guildId === 'string' ? body.guildId.trim() : '';
    const inviteUrl = typeof body.inviteUrl === 'string' ? body.inviteUrl.trim() : '';

    if (!guildId) return Response.json({ error: 'guildId required' }, { status: 400 });
    if (!/^\d+$/.test(guildId)) return Response.json({ error: 'guildId must be numeric snowflake' }, { status: 400 });

    const pg = await loadProjectFiles(slug);
    let cfg: Record<string, unknown> = {};
    try {
      if (pg.config) cfg = JSON.parse(pg.config) as Record<string, unknown>;
    } catch { /* start fresh */ }

    cfg.discord = { guildId, inviteUrl };
    await saveProjectFiles(slug, { config: JSON.stringify(cfg, null, 2) });

    // Bust the widget cache for this guild so the next GET reflects any change.
    getWidgetCache().delete(guildId);

    // Invalidate the sync cache for this harness' discord config (data-sync migration P-009)
    const { notifySyncInvalidate } = await import('../../../sync-sse');
    await notifySyncInvalidate('discordConfig.byHarness', { harnessSlug: slug });

    return Response.json({ ok: true, discord: { guildId, inviteUrl } });
  },
});

export default [getDiscord, putDiscord];
