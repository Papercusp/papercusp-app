/**
 * POST /cupboard/install-deps — close the install loop
 * (`tool-distribution-discovery-2026-06-08` P-002 / D-002).
 *
 * The deliberate one-click "install everything this needs" action. Given a
 * declared dep set (or a blueprint id to read deps from), resolve each
 * Cupboard-installable tool/pack/plugin to its providing listing and INSTALL it
 * — transitively, recursing on each installed unit's own deps — instead of just
 * reporting it advisorily like the shipped gate. Wraps the pure
 * `resolveAndInstallDeps` core with the real install IO.
 *
 * Body: { deps?: {tools,packs,plugins}, blueprintId?, blueprint?, harness?, acceptCapabilities? }
 *   - deps        install exactly these declared deps
 *   - blueprintId resolve a blueprint (local→installed→built-in) and install ITS deps
 *   - blueprint   an inline blueprint object (alternative to blueprintId)
 *   - harness + acceptCapabilities → grant installed units' caps for that harness
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate, like the
 * sibling cupboard routes.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { resolveAndValidate } from '../../agent-tools/blueprint/_resolve';
import { derivePackCatalog } from '../../cupboard/pack-catalog';
import { resolveAndInstallDeps, type DepSet, type EventDep } from '../../cupboard/resolve-and-install';
import { installCupboardUnitFromListing } from '../../cupboard/install-io';

const asStrArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

/**
 * Wire → `EventDep[]` (D-003 / P-007). Accepts `[{ family, optional? }]`, and
 * also a bare `["family"]` string form as sugar for a REQUIRED dep — required
 * is the safe reading of an under-specified declaration: it fails the install
 * loudly instead of installing a unit whose reactions silently never fire.
 */
const asEventDeps = (v: unknown): EventDep[] => {
  if (!Array.isArray(v)) return [];
  const out: EventDep[] = [];
  for (const e of v) {
    if (typeof e === 'string' && e.length > 0) {
      out.push({ family: e });
      continue;
    }
    if (e == null || typeof e !== 'object') continue;
    const { family, optional } = e as Record<string, unknown>;
    if (typeof family !== 'string' || family.length === 0) continue;
    out.push({ family, optional: optional === true });
  }
  return out;
};

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-deps',
  auth: 'loopback',
  timeoutSec: 180,
  // Close the install loop: resolve a blueprint's (or an explicit set of)
  // tool/pack/plugin deps to their Cupboard listings and INSTALL them — the
  // deliberate one-click "install missing deps" action (the harness:create gate
  // only REPORTS installable deps; autoInstallDeps:true does both in one call).
  // (HTTP-route defineTools carry no `guidance` block — that's MCP-tool only.)
  async handler(req) {
    let body: {
      deps?: { tools?: unknown; packs?: unknown; plugins?: unknown; events?: unknown };
      blueprintId?: string;
      blueprint?: Record<string, unknown>;
      harness?: string;
      acceptCapabilities?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    let declared: DepSet | null = null;
    if (body.deps) {
      declared = {
        tools: asStrArray(body.deps.tools),
        packs: asStrArray(body.deps.packs),
        plugins: asStrArray(body.deps.plugins),
        // Event deps (D-003 / P-007) — `[{ family, optional? }]`. Malformed
        // entries are dropped rather than 400'd, matching asStrArray's posture
        // on the other three axes (the resolver is the authority on what a
        // declared dep means; this layer only shapes the wire payload).
        events: asEventDeps(body.deps.events),
      };
    } else if (body.blueprintId || body.blueprint) {
      const resolver = operatorResolveExtends({});
      const childObj: Record<string, unknown> = body.blueprint ?? { id: 'install-deps-probe', extends: body.blueprintId };
      const validation = resolveAndValidate(childObj, resolver);
      if (validation.parseError || !validation.ok) {
        return Response.json(
          { ok: false, error: 'blueprint invalid', parseError: validation.parseError, errors: validation.validation?.errors },
          { status: 422 },
        );
      }
      if (body.blueprintId && resolver(body.blueprintId) == null) {
        return Response.json({ ok: false, error: `unknown blueprint "${body.blueprintId}"` }, { status: 404 });
      }
      const d = validation.blueprint!.dependencies;
      // No `events` here on purpose: the event axis (D-003 / P-005) is declared
      // at the UNIT level (a plugin/pack manifest's `dependencies.events`), not
      // on a blueprint. A blueprint reaches events transitively — through the
      // units it depends on, whose own manifests the install loop folds in.
      declared = { tools: d?.tools ?? [], packs: d?.packs ?? [], plugins: d?.plugins ?? [], events: [] };
    }
    if (!declared) {
      return Response.json({ ok: false, error: 'pass `deps`, `blueprintId`, or `blueprint`' }, { status: 400 });
    }

    const harness = typeof body.harness === 'string' ? body.harness.trim() : undefined;
    const acceptCapabilities = body.acceptCapabilities === true;

    const result = await resolveAndInstallDeps(declared, {
      deriveCatalog: () => derivePackCatalog({ harnessSlug: harness }),
      installUnit: (u) => installCupboardUnitFromListing(u, { harness, acceptCapabilities }),
    });
    return Response.json(result);
  },
});
