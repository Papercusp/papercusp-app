/**
 * meta:define-datatype — declare a reusable, named entity TYPE into the workspace
 * datatype registry (reflexive-platform-extensibility-datatypes-2026-06-24 P-013;
 * the registry/dedup half of P-001).
 *
 * A DATATYPE is the shared shape (`bet`, `wager`, `forecast`, `position`, …) that
 * blueprints reference by name via `dependencies.datatypes` (P-012, D-009). Authority
 * is DEDUP-ONLY (D-010, the npm/crates model): anyone may declare; the registry's only
 * job is preventing DUPLICATE datatypes. Declaration runs a two-level check —
 *   1. HARD: the id (kebab slug) is unique within the workspace (the PK). Re-declaring
 *      the same id UPDATES it in place.
 *   2. CERTAIN-ONLY: a canonical-key collision (`orders` vs `order` — singular/plural and
 *      punctuation normalized away) returns `similar_exists`; `force: true` overrides.
 *      Everything else DECLARES and gets the nearest datatypes back as advisory `related`.
 *
 * Level 2 used to be a SOFT semantic gate that refused on a similarity threshold. It
 * refused 100% of legitimate declarations and caught no duplicates (EI-10562): the score
 * cannot separate a duplicate from a same-domain neighbour at any constant. A gate that
 * cannot be certain must ADVISE, not refuse — otherwise callers learn to pass force:true
 * unconditionally and the gate is dead forever. Certainty refuses; uncertainty advises.
 *
 * TIER (D-002 / D-008): `generic-kind` (default — a work_item kind + validated payload,
 * registerable at runtime, zero migration), `first-class` (a native SQL-backed concept —
 * the migration ships via the dogfood PR rail, NOT here), `projection` (read-only,
 * an external engine is the single writer — `authoritativeWriter: 'engine:<name>'`).
 * This endpoint OWNS layer-1 declaration/namespace only (D-010); implementation
 * (first-class migration) and instance-write authority stay on their own rails.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  upsertDatatype,
  getDatatype,
  findSimilarDatatypes,
  findCanonicalDuplicate,
  slugifyDatatype,
  DATATYPE_TIERS,
  type SimilarDatatype,
} from '../../datatype-registry-store';
import { checkSelfImprovementForDeclare } from '../../datatype-self-improvement';
import { isCompilableSchema } from '../../datatype-payload-validation';
import { scaffoldFirstClassDatatype } from '../../datatype-firstclass-scaffold';
import {
  datatypeDisplaySchema,
  isBuiltinDatatypeId,
} from '../../datatype-display';
import { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { resolveProseProfileSelection } from '../../search/prose-vector-dims';

export default defineTool({
  name: 'meta:define-datatype',
  description:
    'Declare a reusable entity TYPE (a "datatype" — bet, wager, forecast, position, …) into the workspace ' +
    'datatype registry, so blueprints can reference it via dependencies.datatypes and (generic-kind tier) ' +
    'work_items can be created with its kind. DEDUP-ONLY authority: the id is unique, and an unmistakable ' +
    'duplicate (`orders` when `order` exists — singular/plural normalized) returns { ok:false, ' +
    'reason:"similar_exists" } so you reuse it (force:true overrides). A merely SIMILAR datatype never blocks ' +
    'you: it declares, and the nearest existing datatypes come back as `related` so you can reuse one if you ' +
    'meant it. Re-declaring the same name UPDATES it in place.',
  guidance: {
    when:
      'When a domain needs a shared, named entity TYPE that should be searchable / plannable / improvable like ' +
      'any Papercusp entity (D-001). Default tier generic-kind (a work_item kind + payload, zero migration). Use ' +
      'projection for money-truth/external-engine-owned types (read-only, authoritativeWriter:"engine:<name>").',
    notWhen:
      'To define a TOOL (use meta:define-tool). To create an INSTANCE of an existing datatype (use work_items:create ' +
      'with the registered kind). A first-class (SQL-backed) datatype\'s migration does NOT ship here — it goes through ' +
      'the dogfood PR rail (tools:scaffold → platform:contribute).',
    chaining:
      'meta:define-datatype { name, description, tier } → (generic-kind) work_items:create { kind } → search/plans/gym ' +
      'inherit it for free. A blueprint references it via dependencies.datatypes [name].',
    seeAlso: [
      'cupboard:publish-datatype (publish the datatype you defined)',
      "cupboard:search { kind:'datatype' } (browse published datatypes before defining)",
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES], // anyone may declare (D-010 open declaration)
  args: z.object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe('the datatype name — kebab-slugified into the registry id (e.g. "bet", "calibration record" → "calibration-record")'),
    description: z
      .string()
      .min(1)
      .max(2000)
      .describe('what this datatype represents — also the semantic-dedup signal; be specific so near-duplicates are caught'),
    tier: z
      .enum([...DATATYPE_TIERS] as [string, ...string[]])
      .default('generic-kind')
      .describe('generic-kind (default: work_item kind + payload, runtime) | first-class (SQL-backed; migration via PR rail) | projection (read-only, external engine writes)'),
    title: z.string().min(1).max(200).optional().describe('human label (defaults to name)'),
    workItemKind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('generic-kind tier: the work_items:create kind this datatype registers (defaults to the slug). Unique within the workspace.'),
    payloadSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSON Schema the kind\'s payload is validated against (generic-kind/first-class)'),
    display: datatypeDisplaySchema
      .optional()
      .describe(
        'Declarative editor + compact renderer: { widget, params?, summary }. Widget is one of the fixed ' +
          'operator vocabulary; ref-picker uses the shared kind registry. No executable renderers.',
      ),
    authoritativeWriter: z
      .string()
      .max(120)
      .optional()
      .describe('projection tier: the external single-writer, e.g. "engine:oddsmith" (D-008). Defaults to "papercusp".'),
    selfImprovement: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'REQUIRED for generic-kind/first-class (P-010): the self-improvement surface ' +
          '{ improvements:[{id,description}], scorecard:[{metric,description,weight?}], gym:{signals:[…],rubric} } ' +
          '— so the datatype is self-improvable by construction. Optional for projection (external engine owns it). ' +
          'On an in-place update you may omit it to keep the stored one.',
      ),
    tags: z
      .array(z.string())
      .max(32)
      .optional()
      .describe(
        'free-form tags. Special: include "hive-placement" on a generic-kind datatype to opt its ' +
          'work-items into the autonomous placement frontier (a bee gets auto-placed); omit it and items ' +
          'are tracked + visible but not auto-placed.',
      ),
    force: z.boolean().optional().describe('bypass the soft semantic-dedup gate (declare even when a similar datatype exists)'),
  }),
  async handler(args, ctx) {
    const reply = (obj: unknown) => ({ data: obj });
    const ident = resolveAgentIdentity(ctx);
    const sql = getOrgPg().sql;
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) {
      return reply({ ok: false, reason: 'no_workspace', message: 'no workspace in the request context' });
    }
    const id = slugifyDatatype(args.name);
    if (!id) {
      return reply({ ok: false, reason: 'invalid_name', message: `"${args.name}" slugifies to empty — give an alphanumeric name` });
    }
    if (isBuiltinDatatypeId(id)) {
      return reply({
        ok: false,
        reason: 'builtin_reserved',
        message: `"${id}" is a built-in primitive datatype and cannot be re-declared`,
      });
    }
    const tier = args.tier as (typeof DATATYPE_TIERS)[number];

    const exists = await getDatatype(sql, workspaceId, id);

    // P-010 — the self-improvement surface. Validate the caller's OWN input completeness
    // first (before the similarity search): an authoritative datatype must be self-
    // improvable by construction. On an in-place update the stored surface is preserved
    // when the call omits it.
    const siCheck = checkSelfImprovementForDeclare(
      tier,
      args.selfImprovement ?? null,
      exists?.selfImprovement ?? null,
    );
    if (!siCheck.ok) {
      return reply({
        ok: false,
        reason: siCheck.reason,
        message: siCheck.message,
        expectedShape: siCheck.expectedShape,
        ...(siCheck.issues ? { issues: siCheck.issues } : {}),
      });
    }

    // P-001: a provided payload_schema must be a COMPILABLE JSON Schema, so every later
    // work_items:create can validate an instance against it (the create path never has to
    // fail-open on a malformed schema — it's caught here, at declaration).
    if (args.payloadSchema && !isCompilableSchema(args.payloadSchema)) {
      return reply({
        ok: false,
        reason: 'invalid_payload_schema',
        message: 'payloadSchema is not a valid JSON Schema (it must compile) — fix it so instances of this datatype can be validated',
      });
    }

    // The title+description embedding — the cosine dedup leg AND the stored vector.
    // Failure-tolerant (mirrors recipes:search): no embedder configured / a transient
    // error ⇒ null ⇒ the lexical (title_tsv) dedup leg carries it, exactly as before.
    const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() }).catch(() => null);
    const embeddingProfile = resolved
      ? resolveProseProfileSelection(resolved.mode, resolved.profile)
      : null;
    const embedding = resolved && embeddingProfile
      ? await resolved.embed(`${args.title ?? args.name}\n${args.description}`).catch(() => null)
      : null;

    // The dedup gate (D-010), for a genuinely NEW id only — re-declaring the same id is an
    // in-place update, not a duplicate.
    //
    // EI-10562 — WHY THIS IS TWO MECHANISMS AND NOT ONE THRESHOLD. This used to refuse on
    // `similarityScore >= 0.05`, which is `cosine >= 0.083` — the noise floor. It refused
    // 7 of 7 legitimate declarations (every datatype in the registry but the very first had
    // to be re-sent with force:true) and caught zero real duplicates. The instinct is to
    // raise the constant; the live data says no constant exists. Cosine between the one true
    // near-duplicate (bet/wager, 0.752) and DISTINCT same-domain pairs (bet/forecast, 0.710)
    // differs by 0.04. Similarity cannot separate a duplicate from a neighbour here.
    //
    // So the DECISION PROCEDURE changed, not the number:
    //   REFUSE only what is certain — an exact canonical-key collision (`orders` vs `order`).
    //   ADVISE on everything else — the neighbours ride along on the success payload.
    // A gate that cannot be certain must advise, not refuse: a refusal it cannot justify
    // just teaches every caller to pass force:true, which destroys the gate permanently.
    let related: SimilarDatatype[] = [];
    if (!exists) {
      const dup = await findCanonicalDuplicate(sql, workspaceId, args.name, id);
      if (dup && !args.force) {
        return reply({
          ok: false,
          reason: 'similar_exists',
          message:
            `"${args.name}" is the same datatype as "${dup.id}" ("${dup.title}") once singular/plural and ` +
            `punctuation are normalized — reuse ${dup.id}, or re-call with force:true if it is genuinely distinct.`,
          candidates: [dup],
        });
      }
      // Advisory only — ranks the nearest existing datatypes, never blocks. A neighbour is
      // information the caller wants ("you may have meant this"), not grounds for refusal.
      related = await findSimilarDatatypes(sql, workspaceId, {
        title: args.title ?? args.name,
        description: args.description,
        embedding,
        embeddingProfile,
        excludeId: id,
        limit: 3,
      }).catch(() => []);
    }

    const row = await upsertDatatype(sql, {
      id,
      workspaceId,
      potSlug: ctx.harnessSlug ?? null,
      title: args.title ?? args.name,
      description: args.description,
      tier,
      // generic-kind registers a work_item kind (defaults to the slug); other tiers leave it null
      workItemKind: tier === 'generic-kind' ? (args.workItemKind ?? id) : (args.workItemKind ?? null),
      payloadSchema: args.payloadSchema ?? null,
      // Omission on an in-place declaration preserves the current display contract.
      display: args.display ?? exists?.display ?? null,
      authoritativeWriter: args.authoritativeWriter ?? (tier === 'projection' ? null : 'papercusp'),
      // P-010: the validated surface (new), the preserved stored surface (omitted update), or null (projection)
      selfImprovement: siCheck.value,
      tags: args.tags ?? [],
      // the title+description vector (cosine dedup); null when no embedder — upsert COALESCEs
      // so a re-declare without an embedder keeps any previously-computed vector.
      embedding,
      embeddingMode: embedding && resolved ? resolved.mode : null,
      embeddingProfile: embedding ? embeddingProfile : null,
      createdBy: ident.ownerId,
    });

    // first-class tier: scaffold the reviewable SQL backing migration (PR rail, D-003 — not
    // applied at runtime) from the payload_schema, so the caller gets it immediately.
    const firstClassScaffold =
      tier === 'first-class'
        ? scaffoldFirstClassDatatype({ id, title: args.title ?? args.name, payloadSchema: args.payloadSchema ?? null })
        : null;

    return reply({
      ok: true,
      datatype: row,
      updated: Boolean(exists),
      ...(firstClassScaffold && firstClassScaffold.ok
        ? { scaffold: { files: firstClassScaffold.files, reviewNotes: firstClassScaffold.reviewNotes, nextSteps: firstClassScaffold.nextSteps } }
        : {}),
      // EI-10562: the nearest existing datatypes, as ADVICE on a successful declaration —
      // the caller sees what it may have meant instead of being refused for looking like it.
      ...(related.length > 0 ? { related } : {}),
      note:
        tier === 'first-class'
          ? 'first-class declared; the SQL backing migration is scaffolded in `scaffold.files` — ship it via the reviewed PR rail (NOT runtime).'
          : tier === 'projection'
            ? `projection declared; ${row.authoritativeWriter} is the single writer — Papercusp holds a read-only view.`
            : `generic-kind declared; work_items:create { kind:"${row.workItemKind}" } is now accepted in this workspace.`,
      ...(related.length > 0
        ? {
            relatedNote:
              `related datatypes already exist: ${related.map((s) => `${s.id} ("${s.title}")`).join(', ')} — ` +
              'if you meant one of those, reuse it and retire this one (datatypes:list to review).',
          }
        : {}),
    });
  },
});
