/**
 * POST /api/agent-mcp/pot-override-set — the per-hive customization write path
 * (domain-generic-hive-architecture-2026-06-18 P-015 / D-005, D-007).
 *
 * One owner-surface write for BOTH halves of a hive's settings-resident override:
 *   - `kind:'prompt'` — a role's PROSE persona delta (`promptOverride.<role>`, D-007).
 *     An empty/whitespace value CLEARS it (so a removed override leaves no stale
 *     materialized file on any peer — symmetric with the materializer).
 *   - `kind:'config'` — a STRUCTURED config delta (`localBlueprint.<section>`, D-005;
 *     e.g. a ScoutConfigOverride). Prose can't express scout's tuning, so this is the
 *     other editor. A null/empty value CLEARS the section. For section `scout` the
 *     route validates the submitted object with the engine's own defensive parser and
 *     returns the ACCEPTED override + the RESOLVED config + any DROPPED keys, so the
 *     editor shows exactly what the scout loop will read (the loop re-parses
 *     defensively, so storing the raw object is safe — junk degrades to the default).
 *
 * Thin wrapper over the hive-settings store (which enforces the "settings belong to a
 * Hive" scope + federates over the Hive peer-log); this route adds the sync
 * invalidation so the /settings/pot-customization editors refresh.
 *
 * Loopback-only + owner authority (the desktop owner surface is the only caller). The
 * `setHiveInstancePromptOverride` / structured-config MCP paths take args (palette-
 * excluded by safety-filter §3), so the settings page writes through this route — the
 * same shape as `autonomy-policy-set` / `trust-set`.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  potSlug?: unknown;
  kind?: unknown;
  /** prompt → role; config → section. */
  name?: unknown;
  /** prompt → markdown string; config → object (or null/'' to clear). */
  value?: unknown;
}

/** Top-level keys a `scout` config block may carry (for the dropped-keys report). */
const SCOUT_CONFIG_KEYS = ['lenses', 'novelty', 'buckets', 'routing'] as const;

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/pot-override-set',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const potSlug = typeof body.potSlug === 'string' ? body.potSlug.trim() : '';
    if (!potSlug) {
      return Response.json({ ok: false, error: 'missing_hive_slug' }, { status: 400 });
    }
    const kind = body.kind === 'prompt' || body.kind === 'config' ? body.kind : '';
    if (!kind) {
      return Response.json({ ok: false, error: 'missing_or_bad_kind' }, { status: 400 });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return Response.json({ ok: false, error: 'missing_name' }, { status: 400 });
    }

    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const ws = activeWorkspaceId();
    const store = await import('../../../hive-settings-store');

    try {
      let extra: Record<string, unknown> = {};
      let cleared = false;

      if (kind === 'prompt') {
        const md = typeof body.value === 'string' ? body.value : '';
        if (md.trim().length === 0) {
          await store.deleteHiveInstancePromptOverride(ws, potSlug, name);
          cleared = true;
        } else {
          // Additive-override guard (owner directive 2026-06-24): an override is APPENDED
          // after the generated blueprint persona, so it must only ADD the hive-specific
          // delta — never re-state what the generated base already supplies. Warn (do NOT
          // gate — overrides are the owner's to author) when it duplicates base content.
          const { additiveOverrideWarning } = await import('../../../hive-override-additive-guard');
          const warning = additiveOverrideWarning(md);
          if (warning) {
            extra = { ...extra, warning };
            console.warn(`[pot-override-set] ${potSlug}/${name}: ${warning}`);
          }
          await store.setHiveInstancePromptOverride(ws, potSlug, name, md);
        }
      } else {
        // kind === 'config'
        const v = body.value;
        const isEmpty =
          v == null ||
          (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);
        if (isEmpty) {
          await store.deleteHiveLocalBlueprintConfig(ws, potSlug, name);
          cleared = true;
        } else {
          if (typeof v !== 'object' || Array.isArray(v)) {
            return Response.json(
              { ok: false, error: 'config_value_must_be_object' },
              { status: 400 },
            );
          }
          // Section-specific validation feedback (scout is the one with a real schema
          // today — D-005). The stored value stays the user's RAW object; the loop
          // re-parses defensively, so this is feedback, not a gate.
          if (name === 'scout') {
            const { parseScoutConfigBlock, resolveScoutConfig } = await import('../../../scout/config');
            const accepted = parseScoutConfigBlock(v);
            const submittedKeys = Object.keys(v as Record<string, unknown>);
            const dropped = submittedKeys.filter(
              (k) => !(SCOUT_CONFIG_KEYS as readonly string[]).includes(k) || !(k in accepted),
            );
            const resolved = resolveScoutConfig(accepted);
            extra = { accepted, resolved, dropped };
            // WI-10004526: llmCall refuses a Codex model with no usage price, so an
            // unpriced Scout model fails every cycle (the WI-10004502 outage). Say so
            // at WRITE time; the value is still stored (feedback, not a gate — D-005).
            const { unpricedCodexModel } = await import('../../../llm-testing/codex-model-pricing');
            const unpricedModels = Object.entries(resolved.models)
              .map(([phase, spec]) => ({ phase, model: unpricedCodexModel(spec) }))
              .filter((row): row is { phase: string; model: string } => row.model !== null);
            if (unpricedModels.length > 0) {
              const warning =
                `scout models with no usage price will fail every call: ` +
                unpricedModels.map((r) => `${r.phase}=${r.model}`).join(', ') +
                ' — add a price to libs/generic/model-pricing/src/index.ts or choose a priced model';
              extra = { ...extra, unpricedModels, warning };
              console.warn(`[pot-override-set] ${potSlug}/${name}: ${warning}`);
            }
          }
          await store.setHiveLocalBlueprintConfig(ws, potSlug, name, v);
        }
      }

      // The /settings/pot-customization editors read `hive.overrides` via useSyncQuery
      // with args `{ potSlug }`; invalidate the SAME key so they refetch (args-scoped
      // exact-key match — the page subscribes with just `{ potSlug }`).
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      await notifySyncInvalidate('hive.overrides', { potSlug }).catch(() => {});

      return Response.json({ ok: true, workspaceId: ws, potSlug, kind, name, cleared, ...extra });
    } catch (err) {
      // setHiveSetting throws when the Hive doesn't exist ("settings belong to a Hive")
      // — a 400 (bad target), not a 500.
      return Response.json(
        { ok: false, error: (err as Error)?.message ?? 'hive_override_set_failed' },
        { status: 400 },
      );
    }
  },
});
