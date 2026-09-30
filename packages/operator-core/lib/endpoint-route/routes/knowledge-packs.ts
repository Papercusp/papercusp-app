/**
 * /knowledge-packs/* — the HTTP faces the Learnings view drives
 * (learning-packs-2026-06-11 P-009/P-010/P-013). Thin over
 * lib/knowledge-packs/manage — the SAME classify→review→apply contract as the
 * knowledge_packs:* MCP verbs: install/upgrade return `review_required` + the
 * per-item report when clashes exist and no resolutions were given; the UI
 * renders the side-by-side cards and re-submits with explicit resolutions.
 *
 * All loopback (mutating, Wave-1 rule) + flag-gated (KNOWLEDGE_PACKS).
 */
import { FLAGS } from '@papercusp/flags';
import { defineTool } from '@papercusp/agent-mcp';
import { gateApiRoute } from '../../require-flag';
import { activeWorkspaceId } from '../../workspace-registry';
import { getSessionUserOrDefault } from '../../auth';

type InstallBody = {
  hive?: string;
  pack?: string;
  resolutions?: Array<{ itemId: string; action: 'install' | 'skip' | 'replace' | 'keep-both' }>;
  acceptDefaults?: boolean;
};

function badRequest(msg: string): Response {
  return Response.json({ ok: false, error: msg }, { status: 400 });
}

const install = defineTool({
  method: 'POST',
  path: '/knowledge-packs/install',
  auth: 'loopback',
  // Classification = N searches + ≤N judge calls; give it headroom.
  timeoutSec: 180,
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.KNOWLEDGE_PACKS);
    if (gated) return gated;
    let body: InstallBody = {};
    try { body = (await req.json()) as InstallBody; } catch { /* empty */ }
    const hive = String(body.hive ?? '').trim();
    const packId = String(body.pack ?? '').trim();
    if (!hive || !packId) return badRequest('hive and pack are required');

    const { loadKnowledgePack } = await import('../../knowledge-packs/load-packs');
    const loaded = await loadKnowledgePack(packId);
    if (!loaded) return Response.json({ ok: false, error: 'pack_not_found' }, { status: 404 });

    const { classifyPackInstall, applyPackInstall } = await import('../../knowledge-packs/manage');
    const review = await classifyPackInstall({ potSlug: hive, pack: loaded.pack });
    const hasClashes = review.duplicates + review.conflicts > 0;
    if (hasClashes && !body.resolutions && body.acceptDefaults !== true) {
      return Response.json({ ok: false, reason: 'review_required', review });
    }
    const result = await applyPackInstall({
      workspaceId: activeWorkspaceId(),
      potSlug: hive,
      pack: loaded.pack,
      review,
      ...(body.resolutions ? { resolutions: body.resolutions } : {}),
      createdBy: (await getSessionUserOrDefault(req.headers)).id,
    });
    return Response.json(result);
  },
});

const upgrade = defineTool({
  method: 'POST',
  path: '/knowledge-packs/upgrade',
  auth: 'loopback',
  timeoutSec: 180,
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.KNOWLEDGE_PACKS);
    if (gated) return gated;
    let body: InstallBody = {};
    try { body = (await req.json()) as InstallBody; } catch { /* empty */ }
    const hive = String(body.hive ?? '').trim();
    const packId = String(body.pack ?? '').trim();
    if (!hive || !packId) return badRequest('hive and pack are required');

    const { loadKnowledgePack } = await import('../../knowledge-packs/load-packs');
    const loaded = await loadKnowledgePack(packId);
    if (!loaded) return Response.json({ ok: false, error: 'pack_not_found' }, { status: 404 });

    const { planPackUpgrade, applyPackInstall } = await import('../../knowledge-packs/manage');
    const plan = await planPackUpgrade({ potSlug: hive, pack: loaded.pack });
    if (plan.newItems.items.length === 0) {
      return Response.json({ ok: true, upToDate: true, ...plan });
    }
    const hasClashes = plan.newItems.duplicates + plan.newItems.conflicts > 0;
    if (hasClashes && !body.resolutions && body.acceptDefaults !== true) {
      return Response.json({ ok: false, reason: 'review_required', review: plan.newItems, plan });
    }
    const result = await applyPackInstall({
      workspaceId: activeWorkspaceId(),
      potSlug: hive,
      pack: loaded.pack,
      review: plan.newItems,
      ...(body.resolutions ? { resolutions: body.resolutions } : {}),
      createdBy: (await getSessionUserOrDefault(req.headers)).id,
    });
    return Response.json({ ...result, installedVersions: plan.installedVersions, availableVersion: plan.availableVersion });
  },
});

const uninstall = defineTool({
  method: 'POST',
  path: '/knowledge-packs/uninstall',
  auth: 'loopback',
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.KNOWLEDGE_PACKS);
    if (gated) return gated;
    let body: { hive?: string; pack?: string; keepEdited?: boolean } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty */ }
    const hive = String(body.hive ?? '').trim();
    const packId = String(body.pack ?? '').trim();
    if (!hive || !packId) return badRequest('hive and pack are required');

    const { loadKnowledgePack } = await import('../../knowledge-packs/load-packs');
    const { uninstallPack } = await import('../../knowledge-packs/manage');
    const loaded = await loadKnowledgePack(packId);
    const result = await uninstallPack({
      potSlug: hive,
      packId,
      pack: loaded?.pack ?? null,
      ...(body.keepEdited !== undefined ? { keepEdited: body.keepEdited === true } : {}),
    });
    return Response.json(result);
  },
});

const setEnabled = defineTool({
  method: 'POST',
  path: '/knowledge-packs/set-enabled',
  auth: 'loopback',
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.KNOWLEDGE_PACKS);
    if (gated) return gated;
    let body: { hive?: string; pack?: string; enabled?: boolean } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty */ }
    const hive = String(body.hive ?? '').trim();
    const packId = String(body.pack ?? '').trim();
    if (!hive || !packId || typeof body.enabled !== 'boolean') {
      return badRequest('hive, pack and enabled are required');
    }
    const { setPackEnabled } = await import('../../knowledge-packs/manage');
    const result = await setPackEnabled({
      workspaceId: activeWorkspaceId(),
      potSlug: hive,
      packId,
      enabled: body.enabled,
    });
    return Response.json({ ...result, pack: packId, enabled: body.enabled });
  },
});

/**
 * POST /knowledge-packs/fetch-from-comb — stage a Comb-listed knowledge pack
 * locally (P-017): resolve the listing's repo coords, shallow-clone, validate,
 * copy under ~/.papercusp/knowledge-packs. The pack then appears in
 * knowledgePacks.list and installs into a hive through the normal review.
 */
const fetchFromComb = defineTool({
  method: 'POST',
  path: '/knowledge-packs/fetch-from-comb',
  auth: 'loopback',
  timeoutSec: 180,
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.KNOWLEDGE_PACKS);
    if (gated) return gated;
    let body: { listingId?: string; githubUrl?: string; listingRef?: string } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty */ }

    let githubUrl = typeof body.githubUrl === 'string' ? body.githubUrl.trim() : '';
    let listingRef = typeof body.listingRef === 'string' ? body.listingRef.trim() : undefined;
    if (!githubUrl && body.listingId) {
      const { resolveListingCoords } = await import('../../cupboard/install-io');
      const resolved = await resolveListingCoords(String(body.listingId));
      if (!resolved) {
        return Response.json({ ok: false, error: 'listing_not_found_or_unreachable' }, { status: 404 });
      }
      githubUrl = resolved.githubUrl;
      listingRef = listingRef ?? resolved.listingRef;
    }
    if (!githubUrl) return badRequest('githubUrl or listingId required');

    const { fetchKnowledgePackFromRepo } = await import('../../knowledge-packs/install-from-repo');
    const result = await fetchKnowledgePackFromRepo({ githubUrl, ...(listingRef ? { listingRef } : {}) });
    return Response.json(result, { status: result.ok ? 200 : 422 });
  },
});

/**
 * POST /knowledge-packs/candidate-decide — the owner's adopt/dismiss on one
 * staged fleet→pack candidate (consume-edges P-032, B-11). Adopt writes the
 * fleet-lessons pack (version bump ⇒ hives see updateAvailable and ride the
 * normal install/upgrade review); dismiss is terminal. Candidate list rides
 * the `knowledgePacks.candidates` sync query — no GET here.
 */
const candidateDecide = defineTool({
  method: 'POST',
  path: '/knowledge-packs/candidate-decide',
  auth: 'loopback',
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.KNOWLEDGE_PACKS);
    if (gated) return gated;
    let body: { id?: string; action?: string; note?: string; title?: string; text?: string } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty */ }
    const id = String(body.id ?? '').trim();
    const action = body.action === 'adopt' || body.action === 'dismiss' ? body.action : null;
    if (!id || !action) return badRequest('id and action (adopt|dismiss) are required');

    const { decideKnowledgePackCandidate } = await import('../../knowledge-packs/candidates');
    const result = await decideKnowledgePackCandidate({
      id,
      action,
      by: (await getSessionUserOrDefault(req.headers)).id,
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
      ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
      ...(typeof body.text === 'string' && body.text.trim() ? { text: body.text.trim() } : {}),
      workspaceId: activeWorkspaceId(),
    });
    return Response.json(result, { status: result.ok ? 200 : result.reason === 'not_found' ? 404 : 409 });
  },
});

export default [install, upgrade, uninstall, setEnabled, fetchFromComb, candidateDecide];
