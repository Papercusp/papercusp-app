/**
 * `## Promote` policy — the plan-resident, fine-grained control over how a plan
 * is promoted into a harness as features (promote-policy-and-waves-2026-05-30).
 *
 * The pure `@papercusp/plan-parser` is left untouched (it deliberately avoids a
 * YAML dependency for its flat frontmatter); promote-policy parsing lives here,
 * operator-side, and reads the full plan source (`ParsedPlan.raw`) to extract a
 * `## Promote` section's fenced YAML block.
 *
 * Format (a fenced ```yaml block under `## Promote`):
 *
 *   ## Promote
 *   ```yaml
 *   target_harness: restart
 *   waves:
 *     - id: tier1
 *       features:
 *         - title: "Fix marketplace schema fetchers"
 *           from_items: [P-001]
 *           assigned_role: worker
 *           brief: "Schema moved under marketplace/v3 — touch only the fetchers."  # P-021: per-lane overlay → work-item payload.brief
 *     - id: tier2
 *       blocked_by: tier1
 *       generate:
 *         for_each: universal_type        # a named runtime set the promote step queries
 *         feature_template:
 *           title: "Universal schema: {item}"
 *           acceptance: ["validates vs asinDetails for {item}"]
 *     - id: extract-cli                   # EXCEPTION case: a spawn_child wave
 *       spawn_child:
 *         slug: my-tool-cli               # new child harness (own repo via template)
 *         template: node-cli              # spawnable template (required for v1, D-003)
 *         goal: "Extract the CLI into its own repo + lifecycle"
 *       features:
 *         - title: "Port the CLI entrypoints"
 *           acceptance: ["CLI builds + smoke-runs in the child repo"]
 *   ```
 *
 * ANTI-OVER-SPAWN (promote-spawn-child-harness-2026-05-31 D-001): a wave should
 * declare `spawn_child` ONLY when its work crosses a **repo/worktree boundary**
 * or needs its **own lifecycle/done-definition**. Same-repo "more stuff to
 * build" stays as plain features in the current harness — the dispatcher
 * already runs feature pipelines concurrently, so a child harness buys no extra
 * parallelism, only overhead (own schema, worktree, crew, recursion budget).
 * `plans:lint` warns (never blocks) on every spawn_child wave to prompt that
 * boundary justification; default to features-in-parent when in doubt.
 *
 * FAIL-SAFE: a missing block → `null` (no warning); a malformed block → `null`
 * plus a warning. Never throws — a bad policy must not break plan parsing.
 */
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

// ── Schema ────────────────────────────────────────────────────────────────

/** A statically-declared feature within a wave. */
export const StaticFeatureSchema = z.object({
  title: z.string().min(1).max(200),
  /** Plan item ids this feature covers (marked done on promote). */
  from_items: z.array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form')).optional(),
  acceptance: z.array(z.string().min(1)).optional(),
  body: z.string().optional(),
  /** Per-lane situational brief (queen-wave-dispatch P-021): the Queen's
   *  situational overlay, carried onto the placed work-item at convert time —
   *  distinct from `body` (the durable feature description). Optional; like
   *  `body`, it is `{item}`-substituted in a generative wave's template. */
  brief: z.string().optional(),
  /** Pipeline role hint carried into the feature import (worker/architect/…). */
  assigned_role: z.string().optional(),
  /** Within-wave ordering: titles/ids of features that must finish first. */
  blocked_by: z.array(z.string().min(1)).optional(),
  order: z.number().int().optional(),
});
export type StaticFeature = z.infer<typeof StaticFeatureSchema>;

/**
 * A deterministic resolver for a generative wave's item-set (P-043 / D-012a /
 * D-019): the set is produced by RUNNING A QUERY (or reading a producing
 * feature's published items), not an LLM generator and not the promote agent
 * hand-passing it. `.strict()` so an ambiguous multi-key spec (e.g. `{glob,sql}`)
 * is rejected loudly.
 *
 * PROMOTE-TIME (the set exists now → expand up front):
 *   - items:      an inline explicit set
 *   - glob:       repo files matching a glob (e.g. `app/api/​**​/route.ts`)
 *   - sql:        the first column of each row from the harness PG
 *   - from_input: the named PLAN INPUT holding the set
 *     (plan-structured-inputs-2026-08-01 P-012). The other three make a wave's
 *     fan-out a property of the PLAN — hardcoded, or derived from the repo/DB.
 *     This one makes it a property of the RUN, so one plan fans out differently
 *     per invocation instead of needing a near-duplicate plan per target set.
 *     Resolved from the run's validated inputs; declare the field as an array in
 *     the plan's input_schema and the start gate guarantees it is present before
 *     any wave expands.
 * COMPLETION-TIME (the set derives from a feature's discovery work → deferred):
 *   - from_feature: the feature id/title whose worker PUBLISHES the item-set via
 *     the `generators:publish` tool. The wave is NOT expanded at promote; when
 *     that feature publishes, one child per item is minted `blocked_by` it.
 */
export const ForEachResolverSchema = z.union([
  z.object({ items: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ glob: z.string().min(1) }).strict(),
  z.object({ sql: z.string().min(1) }).strict(),
  z.object({ from_input: z.string().min(1) }).strict(),
  z.object({ from_feature: z.string().min(1) }).strict(),
]);
export type ForEachResolver = z.infer<typeof ForEachResolverSchema>;

/** A generative rule: one feature per item in a runtime-resolved set. */
export const GenerateRuleSchema = z.object({
  /** EITHER a named set the promote agent resolves (legacy — pass `generate_items`),
   *  OR a deterministic resolver the system runs as a query (P-043: items/glob/sql). */
  for_each: z.union([z.string().min(1), ForEachResolverSchema]),
  feature_template: z.object({
    /** May contain `{item}` placeholders, substituted per generated feature. */
    title: z.string().min(1),
    acceptance: z.array(z.string().min(1)).optional(),
    body: z.string().optional(),
    /** Per-lane situational brief (P-021) — `{item}`-substituted per generated lane. */
    brief: z.string().optional(),
    assigned_role: z.string().optional(),
    agent_hint: z.string().optional(),
  }),
});
export type GenerateRule = z.infer<typeof GenerateRuleSchema>;

/** Kebab-case slug: lower alnum + hyphens, no leading/trailing hyphen. Same
 *  shape as `plans:new`'s topic slug + `scaffold_harness`'s harness slug. */
const KEBAB_SLUG = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * P-001 (promote-spawn-child-harness): a wave may declare `spawn_child` to route
 * its features into a **newly-created child harness** (parented to the current
 * one) instead of a pre-existing `target_harness`. Per D-001, a child is only
 * justified at a repo/worktree boundary or for work needing its own lifecycle —
 * `plans:lint` warns on every spawn_child wave to prompt that confirmation.
 *
 * ADDITIVE + fail-safe: the field is optional and inert — no existing promote
 * path reads it, so a wave without `spawn_child` parses and behaves identically.
 * The promote-time spawn branch (scaffold → seed-plan → import → start) is
 * P-003, held for the owner D-002/D-003/D-004 calls. `.strict()` so a typo'd key
 * (e.g. `tempate:`) surfaces as a parse warning rather than being silently dropped.
 */
export const SpawnChildSchema = z
  .object({
    /** Child harness slug (kebab). Unique across waves AND differs from
     *  `target_harness` — enforced in `PromotePolicySchema.superRefine`. */
    slug: z.string().regex(KEBAB_SLUG, 'kebab-case slug (a-z0-9, hyphen-separated)'),
    /** Spawnable template the child is initialized from (D-003 own-repo path —
     *  `scaffold_harness --from <template>`). */
    template: z.string().min(1).optional(),
    /** Optional git URL overriding the template's repo. */
    repo: z.string().url().optional(),
    /** One-line goal seeding the child's plan (≤280). */
    goal: z.string().max(280).optional(),
  })
  .strict();
export type SpawnChild = z.infer<typeof SpawnChildSchema>;

export const WaveSchema = z
  .object({
    id: z.string().min(1),
    /** Prior wave id this wave is blocked by (must drain before this promotes). */
    blocked_by: z.string().optional(),
    features: z.array(StaticFeatureSchema).optional(),
    generate: GenerateRuleSchema.optional(),
    /** P-001: route this wave's features into a new child harness (see above).
     *  A spawn_child wave STILL requires features[]/generate (the .refine below) —
     *  those populate the child. */
    spawn_child: SpawnChildSchema.optional(),
  })
  .refine((w) => (w.features?.length ?? 0) > 0 || !!w.generate, {
    message: 'a wave must declare features[] and/or generate',
  });
export type PromoteWave = z.infer<typeof WaveSchema>;

export const PromotePolicySchema = z
  .object({
    /** Default target harness (a promote call may still override). */
    target_harness: z.string().min(1).optional(),
    defaults: z
      .object({
        assigned_role: z.string().optional(),
        mark_items: z.boolean().optional(),
      })
      .optional(),
    waves: z.array(WaveSchema).min(1),
  })
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    for (const w of p.waves) {
      if (ids.has(w.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate wave id: ${w.id}` });
      }
      ids.add(w.id);
    }
    for (const w of p.waves) {
      if (w.blocked_by && !ids.has(w.blocked_by)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `wave ${w.id} blocked_by unknown wave: ${w.blocked_by}`,
        });
      }
    }
    // P-001 (spawn_child): a child slug names a NEW harness, so it must be unique
    // across waves and must differ from `target_harness` (the promote target is
    // an existing harness, never the child being created). Cross-wave + needs
    // target_harness → enforced at the policy level, not per-wave.
    const childSlugs = new Set<string>();
    for (const w of p.waves) {
      const child = w.spawn_child;
      if (!child) continue;
      if (childSlugs.has(child.slug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate spawn_child slug: ${child.slug}`,
        });
      }
      childSlugs.add(child.slug);
      if (p.target_harness && child.slug === p.target_harness) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `spawn_child slug ${child.slug} must differ from target_harness`,
        });
      }
    }
  });
export type PromotePolicy = z.infer<typeof PromotePolicySchema>;

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract the raw text body of the `## Promote` section from a plan's markdown,
 * or null if absent. Section runs from the heading to the next `## ` or EOF.
 */
export function extractPromoteSection(planRaw: string): string | null {
  // (JS regex has no `\Z`; find the heading then slice to the next `## ` or EOF.)
  const heading = /^##\s+(?:\d+(?:\.\d+)?[a-z]?\.\s+)?Promote\b.*$/m.exec(planRaw);
  if (!heading) return null;
  const rest = planRaw.slice(heading.index + heading[0].length);
  const next = /^##\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Pull the first fenced ```yaml|yml|json block out of a section; else the
 *  whole section body (YAML is a superset of JSON, so both parse). */
function extractFencedBody(section: string): string {
  const fence = /```(?:ya?ml|json)?\s*\n([\s\S]*?)```/m.exec(section);
  return (fence ? fence[1] : section).trim();
}

export interface ParsePromoteResult {
  policy: PromotePolicy | null;
  warnings: string[];
}

/**
 * Parse a plan's `## Promote` policy from its full markdown source. Fail-safe:
 * returns `{ policy: null, warnings: [] }` when there is no `## Promote` section,
 * and `{ policy: null, warnings: [...] }` (never throws) on a malformed one.
 */
export function parsePromotePolicy(planRaw: string): ParsePromoteResult {
  const section = extractPromoteSection(planRaw);
  if (section === null) return { policy: null, warnings: [] };

  const body = extractFencedBody(section);
  if (!body) return { policy: null, warnings: ['`## Promote` section is empty'] };

  let raw: unknown;
  try {
    raw = parseYaml(body);
  } catch (e) {
    return { policy: null, warnings: [`\`## Promote\` YAML parse error: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const parsed = PromotePolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      policy: null,
      warnings: parsed.error.issues.map((i) => `\`## Promote\` invalid: ${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { policy: parsed.data, warnings: [] };
}

/** Convenience: the policy or null, discarding warnings. */
export function getPromotePolicy(planRaw: string): PromotePolicy | null {
  return parsePromotePolicy(planRaw).policy;
}

// ── Wave resolution ──────────────────────────────────────────────────────────

/** A feature resolved from a wave — the shape `plans:promote`'s FEATURE_INPUT
 *  accepts. (Generated features carry no `from_items`; they aren't plan items.) */
export interface BuiltFeature {
  title: string;
  from_items?: string[];
  acceptance?: string[];
  body?: string;
  /** Per-lane situational brief (P-021) carried onto the placed work-item as the
   *  Queen's situational overlay (via `plan_items:convert`'s `brief`). */
  brief?: string;
  assigned_role?: string;
  blocked_by?: string[];
  order?: number;
  /** True for features produced by a generative `for_each` rule (P-043) — the
   *  promote step stamps `metadata.generated_by` on these. */
  generated?: boolean;
  /** The policy wave this feature came from. Set by the all-waves-up-front
   *  promote (P-044) so each feature records its own wave (consolidated.wave +
   *  the `## Promoted` row), since one promote spans many waves. */
  wave?: string;
  /** P-001: the child-harness slug this feature is destined for, when its wave
   *  declares `spawn_child`. Stamped by `buildWaveFeatures`; the promote spawn
   *  branch (P-003, held) reads it to route the feature into the child instead
   *  of `target_harness`. Undefined for ordinary in-parent features. */
  spawn_child_slug?: string;
}

/**
 * All-waves-up-front cross-wave wiring (P-044 / Path A). A wave's
 * `blocked_by: <prior-wave-id>` is turned into FEATURE-level edges: every feature
 * in the wave becomes `blocked_by` every feature TITLE of the wave it depends on,
 * so the P-042 frontier alone enforces cross-wave ordering (no 30s wave-advance
 * poll). Mutates the built features' `blocked_by` in place; titles are resolved
 * to canonical ids by the import's blocked_by resolver. Idempotent + dedupes.
 */
export function applyInterWaveEdges(
  waves: readonly PromoteWave[],
  builtByWave: ReadonlyMap<string, BuiltFeature[]>,
): void {
  for (const w of waves) {
    if (!w.blocked_by) continue;
    const priorTitles = (builtByWave.get(w.blocked_by) ?? []).map((f) => f.title);
    if (priorTitles.length === 0) continue;
    for (const f of builtByWave.get(w.id) ?? []) {
      f.blocked_by = [...new Set([...(f.blocked_by ?? []), ...priorTitles])];
    }
  }
}

export interface BuildWaveResult {
  features: BuiltFeature[];
  warnings: string[];
}

/** Substitute the `{item}` placeholder. */
const sub = (s: string, item: string): string => s.replace(/\{item\}/g, item);

/**
 * Resolve a wave's features: static `features[]` verbatim, plus the generative
 * `feature_template` expanded **once per `generateItems`** (with `{item}`
 * substituted in title/acceptance/body). A generative wave with no items yields
 * no generated features + a warning — the caller (promote agent) is responsible
 * for resolving the `for_each` set (e.g. the discovered universal types) and
 * passing it; this keeps the promote tool domain-agnostic.
 */
export function buildWaveFeatures(
  wave: PromoteWave,
  opts: { generateItems?: string[] } = {},
): BuildWaveResult {
  const warnings: string[] = [];
  const features: BuiltFeature[] = [];

  for (const f of wave.features ?? []) features.push({ ...f });

  if (wave.generate) {
    const items = opts.generateItems ?? [];
    if (items.length === 0) {
      warnings.push(
        `wave ${wave.id} is generative (for_each: ${wave.generate.for_each}) but no generateItems were provided`,
      );
    }
    const t = wave.generate.feature_template;
    for (const item of items) {
      const bodyParts = [
        t.body ? sub(t.body, item) : null,
        t.agent_hint ? `Hint: ${sub(t.agent_hint, item)}` : null,
      ].filter(Boolean) as string[];
      features.push({
        title: sub(t.title, item),
        ...(t.acceptance && { acceptance: t.acceptance.map((a) => sub(a, item)) }),
        ...(bodyParts.length > 0 && { body: bodyParts.join('\n\n') }),
        ...(t.brief && { brief: sub(t.brief, item) }),
        ...(t.assigned_role && { assigned_role: t.assigned_role }),
        generated: true,
      });
    }
  }

  // P-001: a spawn_child wave routes ALL its features (static + generated) into
  // the child harness — stamp each with the destination slug so the promote
  // spawn branch (P-003, held) can route them. Purely additive: a wave without
  // spawn_child leaves the built features byte-identical to before.
  if (wave.spawn_child) {
    for (const f of features) f.spawn_child_slug = wave.spawn_child.slug;
  }

  return { features, warnings };
}
