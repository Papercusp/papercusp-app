/**
 * /api/gym/* — the gym CONTROL-PLANE routes the generalized harness-gym UI consumes
 * (gym-ui-handoff-2026-06-02, D-020). Thin HTTP wrappers over lib/gym/control-plane.ts
 * (persistent state in the live operator DB) + lib/gym/read-api.ts (the ephemeral gym
 * run DB, when one is configured).
 *
 *   GET  /api/gym/harnesses                  → per-harness gym summaries
 *   GET  /api/gym/:slug                       → status + prompts for one harness
 *   GET  /api/gym/:slug/prompts               → { judgeRubric, roles }
 *   POST /api/gym/:slug/prompts   {role, md}  → set a prompt → updated prompts
 *   GET  /api/gym/:slug/proposals?status=     → proposer suggestions (default pending)
 *   POST /api/gym/:slug/accept    {id|variantId} → promote → harness_prompt_overrides
 *   POST /api/gym/:slug/reject    {id|variantId} → discard
 *   GET  /api/gym/:slug/autoloop               → autoloop config (defaults if unset)
 *   POST /api/gym/:slug/autoloop  {enabled?,budgetUsd?,status?} → upsert → config
 *   GET  /api/gym/:slug/cycles | /variants | /compare | /frontier → run analytics
 *        (read the DURABLE harness_gym read-cache in the LIVE operator DB — migration 650,
 *        populated by the cycle-end copy step store.ts copyRunAnalyticsToDurable — via the
 *        SAME routeWithWorkspace pool as the control plane, scoped by (workspace, harness);
 *        replaces the old per-request postgres() to a separate PAPERCUSP_GYM_DATABASE_URL)
 *
 * Public + loopback-only, consistent with the sibling /adv + /harness UI routes.
 * State is workspace-scoped via routeWithWorkspace (RLS GUC = active workspace).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { routeWithWorkspace } from '../../../route-workspace';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  getPrompts,
  setPrompt,
  listProposals,
  decideProposal,
  getAutoloop,
  setAutoloop,
  summarizeGymStatus,
  GYM_PROMPT_KEYS,
} from '../../../gym/control-plane';
// P-002 / D-004(3): the shared promotion gate. Imported here — not just relied on
// inside decideProposal — because the blueprint accept branch below never touches
// decideProposal and installs the same prompt by committing it.
import { realAnchorHeld } from '../../../gym/promotion-gate';
import { readDurableCycleHistory, readDurableVariants, durableFrontierView } from '../../../gym/read-api';
import { compareDurableVariants } from '../../../gym/store';
import { rubricHash, GYM_JUDGE_RUBRIC_V1 } from '../../../gym/judge-scoring';
// P-016 (D-007/D-021): accept = commit→reproject for blueprint-harness targets.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePhasedProject } from '../../../harness-core';
import { acceptProposalViaCommit } from '../../../blueprint/commit-reproject-real';

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The frozen judge rubric hash the gym scores every run under. The compare/frontier reads
 *  default to it when the caller omits rubricHash, so the tabs populate without the UI having
 *  to know the hash (the gym only ever uses this one rubric). */
const DEFAULT_RUBRIC_HASH = rubricHash(GYM_JUDGE_RUBRIC_V1);

const harnesses = defineTool({
  method: 'GET',
  path: '/gym/harnesses',
  auth: 'public',
  async handler() {
    const ws = activeWorkspaceId();
    const summaries = await routeWithWorkspace(async (tx) => {
      // Harnesses that have any gym state (a pending/decided proposal OR autoloop config).
      const slugs = (await tx`
        SELECT harness_slug FROM harness_shared.gym_proposals
        UNION
        SELECT harness_slug FROM harness_shared.gym_autoloop_config`) as { harness_slug: string }[];
      const out = [];
      for (const { harness_slug } of slugs) {
        const [pending, autoloop] = await Promise.all([
          listProposals(tx, { workspaceId: ws, harnessSlug: harness_slug, status: 'pending' }),
          getAutoloop(tx, { workspaceId: ws, harnessSlug: harness_slug }),
        ]);
        out.push({ harnessSlug: harness_slug, ...summarizeGymStatus(pending, autoloop) });
      }
      return out;
    });
    return Response.json({ harnesses: summaries });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/gym/:slug',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const payload = await routeWithWorkspace(async (tx) => {
      const [pending, autoloop, prompts] = await Promise.all([
        listProposals(tx, { workspaceId: ws, harnessSlug: slug, status: 'pending' }),
        getAutoloop(tx, { workspaceId: ws, harnessSlug: slug }),
        getPrompts(tx, { workspaceId: ws, harnessSlug: slug }),
      ]);
      return { harnessSlug: slug, status: summarizeGymStatus(pending, autoloop), prompts, editableKeys: GYM_PROMPT_KEYS };
    });
    return Response.json(payload);
  },
});

const promptsGet = defineTool({
  method: 'GET',
  path: '/gym/:slug/prompts',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const prompts = await routeWithWorkspace((tx) => getPrompts(tx, { workspaceId: ws, harnessSlug: slug }));
    return Response.json({ ...prompts, editableKeys: GYM_PROMPT_KEYS });
  },
});

const promptSet = defineTool({
  method: 'POST',
  path: '/gym/:slug/prompts',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const body = await readJson(req);
    const role = typeof body.role === 'string' ? body.role : '';
    const md = typeof body.md === 'string' ? body.md : '';
    if (!role) return Response.json({ error: 'role_required' }, { status: 400 });
    try {
      const prompts = await routeWithWorkspace(async (tx) => {
        await setPrompt(tx, { workspaceId: ws, harnessSlug: slug, role, md });
        return getPrompts(tx, { workspaceId: ws, harnessSlug: slug });
      });
      return Response.json({ ok: true, ...prompts });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  },
});

const proposals = defineTool({
  method: 'GET',
  path: '/gym/:slug/proposals',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const url = new URL(req.url);
    const status = url.searchParams.get('status') ?? 'pending';
    const variantId = url.searchParams.get('variantId') ?? undefined;
    const rows = await routeWithWorkspace((tx) =>
      listProposals(tx, { workspaceId: ws, harnessSlug: slug, status: status === 'all' ? undefined : status, variantId }),
    );
    return Response.json({ proposals: rows });
  },
});

/** A proposal selection — one `id`, or every pending proposal of a candidate `variantId`. */
interface ProposalSelection {
  id: string | null;
  variantId: string | null;
}

function readSelection(body: Record<string, unknown>): ProposalSelection {
  return {
    id: typeof body.id === 'string' ? body.id : null,
    variantId: typeof body.variantId === 'string' ? body.variantId : null,
  };
}

/**
 * P-002 / D-004(3): a deliberate install of a challenger that has NOT been shown to
 * hold the real-anchor pool. Requires a NON-EMPTY reason — a bare `override: true` is
 * read as no override at all, because the point of the escape hatch is that the ledger
 * can later say why the live prompt is what it is. An override with nothing to say is
 * indistinguishable from the ungated accept D-004 ruled out.
 */
function readOverride(body: Record<string, unknown>): { reason: string } | undefined {
  const raw = body.overrideRealAnchor;
  const reason = typeof raw === 'string' ? raw.trim() : typeof (raw as { reason?: unknown })?.reason === 'string' ? String((raw as { reason: string }).reason).trim() : '';
  return reason ? { reason } : undefined;
}

/** Shared decide path: promote-to-PG (legacy accept) / mark-rejected (reject), by the
    parsed selection. Takes parsed params (NOT the Request) so a caller that already
    read the body — e.g. acceptRoute's fallback — never double-reads the request body. */
async function decideRoute(
  slug: string,
  decision: 'accepted' | 'rejected',
  sel: ProposalSelection,
  override?: { reason: string },
): Promise<Response> {
  const ws = activeWorkspaceId();
  if (!sel.id && !sel.variantId) return Response.json({ error: 'id_or_variantId_required' }, { status: 400 });

  const result = await routeWithWorkspace(async (tx) => {
    const ids = sel.id
      ? [sel.id]
      : (await listProposals(tx, { workspaceId: ws, harnessSlug: slug, status: 'pending', variantId: sel.variantId! })).map((p) => p.id);
    const results = [];
    for (const pid of ids) {
      // `override` is spread conditionally so an ordinary decide sends the exact same
      // argument object it always did — the real-anchor gate is opt-OUT, never opt-in.
      results.push(await decideProposal(tx, { id: pid, workspaceId: ws, harnessSlug: slug, decision, ...(override ? { override } : {}) }));
    }
    return results;
  });
  const decided = result.filter((r) => r.ok).length;
  const promoted = result.filter((r) => r.promoted).length;
  return Response.json({ ok: decided > 0, decided, promoted, results: result });
}

/**
 * Accept = live-edit via commit → reproject (P-016 / D-007 / D-021). For a
 * blueprint-harness target (one with a git-canonical `.papercusp/blueprint.yaml`),
 * an accepted proposal commits its prompt edit to the TARGET's own git tree and
 * re-projects the blueprint to PG — replacing the ungated `harness_prompt_overrides`
 * write. A legacy target with no `.papercusp/blueprint.yaml` falls back to the old
 * promote-to-PG path (decideRoute), so accept never breaks for un-migrated harnesses.
 */
async function acceptRoute(req: Request, slug: string): Promise<Response> {
  const ws = activeWorkspaceId();
  const body = await readJson(req);
  const sel = readSelection(body);
  const override = readOverride(body);
  if (!sel.id && !sel.variantId) return Response.json({ error: 'id_or_variantId_required' }, { status: 400 });

  // Is the target a blueprint-harness? (git-canonical `.papercusp/blueprint.yaml` at the repo root.)
  const project = await resolvePhasedProject(slug, undefined);
  const blueprintPath = project ? join(project.path, '.papercusp', 'blueprint.yaml') : null;
  if (!project || !blueprintPath || !existsSync(blueprintPath)) {
    // Legacy / un-migrated target: keep the original promote-to-PG accept (no re-read of req).
    // decideProposal applies the real-anchor gate on that path.
    return decideRoute(slug, 'accepted', sel, override);
  }

  // Resolve the pending proposals to accept (by id, or every pending of a variant).
  const proposals = await routeWithWorkspace(async (tx) => {
    const pending = await listProposals(tx, { workspaceId: ws, harnessSlug: slug, status: 'pending', variantId: sel.variantId ?? undefined });
    return sel.id ? pending.filter((p) => p.id === sel.id) : pending;
  });

  // commit→reproject each. A failure leaves THAT proposal pending (D-007 discipline):
  // the git commit is the source of truth, the PG reproject is an idempotent cache, and
  // the proposal is marked accepted only after both succeed. Per-proposal isolation so
  // one failure doesn't abort the rest; a retry is idempotent (no-op commit + re-project).
  const results: Array<Record<string, unknown>> = [];
  for (const p of proposals) {
    // P-002 / D-004(3) — the SAME gate decideProposal applies on the legacy path. This
    // branch post-dates the ruling and installs the identical prompt by a different
    // mechanism (git commit + reproject rather than a harness_prompt_overrides write),
    // so gating only the table named in D-004 would leave the route real harnesses
    // actually take wide open. Refusing leaves the proposal PENDING, exactly as a
    // failed commit does.
    const hold = realAnchorHeld(p.candidateVersion);
    if (!hold.held && !override) {
      results.push({ ok: false, id: p.id, role: p.role, committed: false, reason: hold.reason, detail: hold.detail });
      continue;
    }
    try {
      const res = await routeWithWorkspace((tx) =>
        acceptProposalViaCommit(tx, {
          workspaceId: ws,
          harnessSlug: slug,
          harnessDir: project.path,
          proposalId: p.id,
          role: p.role,
          proposedMd: p.proposedMd,
        }),
      );
      results.push({
        ok: res.ok && res.proposalMarked,
        id: p.id,
        role: p.role,
        committed: res.committed,
        commit: res.commit,
        contentHash: res.contentHash,
        reason: res.reason,
        // Surfaced per-proposal so an override is legible in the accept response, not
        // only later in the git history — the same reason decideProposal stamps it into
        // the change-ledger line.
        ...(override && !hold.held ? { realAnchorOverridden: override.reason } : {}),
      });
    } catch (e) {
      results.push({ ok: false, id: p.id, role: p.role, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const decided = results.filter((r) => r.ok).length;
  return Response.json({ ok: decided > 0, decided, promoted: decided, mode: 'commit-reproject', results });
}

const accept = defineTool({
  method: 'POST',
  path: '/gym/:slug/accept',
  auth: 'loopback',
  async handler(req, ctx) {
    return acceptRoute(req, ctx.params.slug as string);
  },
});

const reject = defineTool({
  method: 'POST',
  path: '/gym/:slug/reject',
  auth: 'loopback',
  async handler(req, ctx) {
    return decideRoute(ctx.params.slug as string, 'rejected', readSelection(await readJson(req)));
  },
});

const autoloopGet = defineTool({
  method: 'GET',
  path: '/gym/:slug/autoloop',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const cfg = await routeWithWorkspace((tx) => getAutoloop(tx, { workspaceId: ws, harnessSlug: slug }));
    return Response.json({
      autoloop: cfg ?? { workspaceId: ws, harnessSlug: slug, enabled: false, budgetUsd: null, spentUsd: 0, status: 'idle', lastCycle: null, lastCycleAt: null, updatedAt: 0 },
      configured: cfg !== null,
    });
  },
});

const autoloopSet = defineTool({
  method: 'POST',
  path: '/gym/:slug/autoloop',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const body = await readJson(req);
    const patch: { enabled?: boolean; budgetUsd?: number | null; status?: string } = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (body.budgetUsd === null || typeof body.budgetUsd === 'number') patch.budgetUsd = body.budgetUsd as number | null;
    if (typeof body.status === 'string') patch.status = body.status;
    const cfg = await routeWithWorkspace((tx) => setAutoloop(tx, { workspaceId: ws, harnessSlug: slug, ...patch }));
    return Response.json({ ok: true, autoloop: cfg });
  },
});

// --- run-analytics reads (the DURABLE harness_gym read-cache in the live operator DB) ---

const cycles = defineTool({
  method: 'GET',
  path: '/gym/:slug/cycles',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const rows = await routeWithWorkspace((tx) => readDurableCycleHistory(tx, { workspaceId: ws, harnessSlug: slug }));
    return Response.json({ cycles: rows });
  },
});

const variants = defineTool({
  method: 'GET',
  path: '/gym/:slug/variants',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const rows = await routeWithWorkspace((tx) => readDurableVariants(tx, { workspaceId: ws, harnessSlug: slug }));
    return Response.json({ variants: rows });
  },
});

const compare = defineTool({
  method: 'GET',
  path: '/gym/:slug/compare',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const url = new URL(req.url);
    const a = url.searchParams.get('a') ?? '';
    const b = url.searchParams.get('b') ?? '';
    const rh = url.searchParams.get('rubricHash') || DEFAULT_RUBRIC_HASH;
    if (!a || !b) return Response.json({ error: 'a_b_required', rows: [] }, { status: 400 });
    const rows = await routeWithWorkspace((tx) => compareDurableVariants(tx, { workspaceId: ws, harnessSlug: slug }, a, b, rh));
    return Response.json({ rows });
  },
});

const frontier = defineTool({
  method: 'GET',
  path: '/gym/:slug/frontier',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const rh = new URL(req.url).searchParams.get('rubricHash') || DEFAULT_RUBRIC_HASH;
    const rows = await routeWithWorkspace((tx) => durableFrontierView(tx, { workspaceId: ws, harnessSlug: slug }, rh));
    return Response.json({ frontier: rows });
  },
});

export default [
  harnesses,
  get,
  promptsGet,
  promptSet,
  proposals,
  accept,
  reject,
  autoloopGet,
  autoloopSet,
  cycles,
  variants,
  compare,
  frontier,
];
