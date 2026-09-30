/**
 * templates:list — browse the first-party app-template storefront.
 *
 * v1 (local-first-party-template-bundling-2026-07-07): the official "Papercusp
 * Official: …" templates ship BUNDLED in the app and are enumerated from the LOCAL
 * store (offline — no Cupboard/GitHub round-trip). The Cupboard MARKETPLACE (user-
 * published, runtime-fetched templates) is a wired-but-dormant v2 seam gated by
 * FLAGS.TEMPLATES_MARKETPLACE; when ON, remote listings merge on top of the local
 * set (a local ref shadows a remote one). Read-only, no side effects.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { COORD_ROLES } from '../coordination/roles';
import { fetchCupboardTemplates, type TemplateListing } from '../../cupboard/templates';
import { listLocalTemplatesWithShadows, toTemplateListing } from '../../cupboard/template-store';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});

export default defineTool({
  name: 'templates:list',
  description:
    'Browse the app-template storefront — the official "Papercusp Official: …" templates a NEW app is composed from (whole-app: papercusp-app for desktop/web, android-app, iphone-app; aspect: mobile-base, android-shell, iphone-shell, data-sync, search, ui, release-pipeline, data-layer, …). V1: these ship BUNDLED and are listed from the local store (works offline). Returns { ok, reachable, count, source, templates:[{ id, ref, title, description, category?, scope?, githubUrl }] }. `ref` (e.g. "papercusp-app") is the handle you pass to templates:get-guide / templates:new-app.',
  guidance: {
    when: 'A user asks to build/scaffold an app (or "use the papercusp-app template") and you need to discover which official templates exist before building. The entry point to the app-template flow.',
    notWhen:
      'You already know the template ref → skip to templates:get-guide (read the build guide) or templates:new-app (materialize + start building). Installing a blueprint/plugin (that is the Cupboard install path, not a template). A plan/rubric template — that is plans:*-template-data, unrelated.',
    chaining: 'templates:list → templates:get-guide { template } → templates:new-app { template, slug }.',
    seeAlso: [
      'templates:get-guide (read a template\'s GUIDE.md + component catalog)',
      'templates:new-app (materialize a template into a fresh harness + start a builder)',
      'harness:create (create a harness from a blueprint instead of an app-template)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    q: z
      .string()
      .max(200)
      .optional()
      .describe('Optional search query (matches ref/title/description).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max templates to return (default 50).'),
  }),
  async handler(args) {
    // v1: the first-party templates are bundled + resolved from the local store.
    const q = args.q?.trim().toLowerCase();
    const { templates: localTemplates, shadows } = listLocalTemplatesWithShadows();
    const localAll = localTemplates.map(toTemplateListing);
    const local = q
      ? localAll.filter(
          (t) =>
            t.ref.toLowerCase().includes(q) ||
            t.title.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q),
        )
      : localAll;

    const byRef = new Map<string, TemplateListing>(local.map((t) => [t.ref, t])); // local wins
    let reachable = true; // the local store is always available
    let marketplace = false;

    // v2 (FLAGS.TEMPLATES_MARKETPLACE): merge the Cupboard marketplace on top; a local
    // ref shadows a remote one so first-party stays authoritative.
    if (await getFlag(FLAGS.TEMPLATES_MARKETPLACE, 'system')) {
      marketplace = true;
      const remote = await fetchCupboardTemplates({ q: args.q, limit: args.limit });
      reachable = remote.reachable;
      for (const t of remote.templates) if (!byRef.has(t.ref)) byRef.set(t.ref, t);
    }

    let templates = [...byRef.values()];
    const limit = args.limit ?? 50;
    if (templates.length > limit) templates = templates.slice(0, limit);

    return ok({
      reachable,
      count: templates.length,
      source: marketplace ? 'local+marketplace' : 'local',
      templates,
      // A user-layer dir colliding with a bundled ref used to happen SILENTLY,
      // which is how two official templates spent weeks listed as untitled,
      // non-official entries (WI-37781). Report every collision, and lead with
      // the refused ones — those name a dir that needs a listing.json or removal.
      ...(shadows.length
        ? {
            shadows,
            shadowNote:
              `${shadows.length} template ref(s) exist in more than one layer. ` +
              (shadows.some((s) => s.refused)
                ? 'REFUSED entries were kept official on purpose — the shadowing dir is incomplete (no listing.json); fix or remove it.'
                : 'The user layer is in effect for these refs.'),
          }
        : {}),
      ...(marketplace && !reachable
        ? { note: 'Marketplace unreachable — showing the bundled first-party templates only.' }
        : {}),
    });
  },
});
