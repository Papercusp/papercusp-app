import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/**
 * Normative-insight classification fields (unified-agent-state-plane-2026-07-27
 * P-022, per D-028).
 *
 * Starlight's `docsSchema()` is a Zod object, and Zod STRIPS keys it does not
 * declare — so a frontmatter field that is not listed here is invisible to every
 * Astro-side consumer no matter what the .mdx says. These three are declared so
 * the classification survives into the built docs rather than being silently
 * dropped at parse time.
 *
 * All three are OPTIONAL, and `normative`'s absence means "not a convention".
 * That default-off is deliberate and is NOT a dark feature flag: this classifies
 * existing prose, it does not gate shipped behavior, so the repo's
 * flags-default-ON mandate does not apply.
 *
 * Deliberately NOT declared here: the corpus's existing `discovered` / `tags` /
 * `status` / `documents` fields. They are also stripped today, but declaring them
 * would newly VALIDATE 626 pre-existing docs — one out-of-enum `status:` or
 * unparseable `discovered:` would fail the whole `astro build`. Widening the
 * schema to cover them is a separate, sweep-first change.
 */
const normativeInsightFields = z.object({
  /**
   * True when this doc is a CONVENTION (a rule that can be violated), not an
   * explanatory runbook. Absent ⇒ explanatory, the corpus default.
   * `normative: true` REQUIRES `governs` — enforced by
   * `npm run lint:insight-normative`, since a Zod schema cannot express a
   * conditional-required field without changing this into a union.
   */
  normative: z.boolean().optional(),
  /**
   * The trigger/surface the convention binds to — what an agent is DOING when
   * this rule applies (e.g. "editing a migration", "adding an MCP tool").
   * Accepts a single scalar or a list; the corpus writes lists as block lists.
   */
  governs: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * Slugs of insights this convention REPLACES. Lets a superseded rule keep
   * pointing forward instead of silently competing with its replacement.
   */
  supersedes: z.union([z.string(), z.array(z.string())]).optional(),
});

/**
 * A YAML date field, in BOTH shapes it can arrive in.
 *
 * Measured, not assumed (2026-08-08): Astro parses frontmatter with **js-yaml**,
 * whose default schema includes the YAML-1.1 timestamp type — so an unquoted
 * `stale_after: 2026-08-08` reaches Zod as a **Date instance**, while a quoted
 * `'2026-08-08'` reaches it as a string. (The `yaml` package, used elsewhere in
 * this repo, returns a string for both — so a probe run with the wrong parser
 * "proves" a `z.string()` is safe when it would red `astro build` on doc #1.)
 *
 * Accepting both is therefore correctness, not leniency: the author's quoting
 * style must not decide whether the build passes. The lint owns semantic date
 * validation, where it can report every malformed value at once instead of
 * failing the whole build on the first.
 */
const okfDate = z.union([z.string(), z.date()]);

/**
 * A single verification event: WHO re-checked this doc against reality, and WHEN.
 * The spec requires both keys — a `by` with no `at` is an unfalsifiable claim and
 * an `at` with no `by` is unattributable, so neither is `.optional()` here.
 */
const okfVerifiedEvent = z.object({
  by: z.string(),
  at: okfDate,
});

/**
 * OKF v0.2 trust/staleness fields (okf-frontmatter-adoption-2026-08-08 P-002).
 *
 * Same reason as `normativeInsightFields` above — Zod STRIPS undeclared keys, so
 * backfilling 659 docs without declaring them here does NOTHING, silently, with a
 * green build. That is the specific failure this plan was written to avoid, so
 * this declaration must land BEFORE the P-003 codemod, not after.
 *
 * Declaring a field newly VALIDATES the whole corpus, which is why the P-001
 * sweep ran first (plan D-001): 659 agent-insight docs, ZERO with any of these
 * four keys, ZERO with unparseable frontmatter. All four are `.optional()`, so on
 * a corpus where every one is absent this declaration is a strict no-op — a
 * required field would red `astro build` on doc #1.
 *
 * ⚠ A green `npx astro sync` on the not-yet-backfilled corpus therefore proves
 * only that the schema tolerates ABSENCE. The real falsifier is a sync run after
 * (or against a sample of) the backfill — verify against a doc that actually
 * carries the fields.
 *
 * Spec: `GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md` (v0.2).
 */
const okfFields = z.object({
  /**
   * OKF's one mandatory field. Deliberately NOT an enum: the spec makes `type`
   * free-form and requires consumers to "tolerate unknown types", so enumerating
   * it here would reject a conformant third-party bundle we ingest later —
   * exactly the interop the adoption is for.
   */
  type: z.string().optional(),
  /**
   * Provenance: who/what PRODUCED this doc. `by` is spec-required; `at` is not,
   * because a doc whose creation date is unknown is still honestly attributable.
   */
  generated: z
    .object({
      by: z.string(),
      at: okfDate.optional(),
    })
    .optional(),
  /**
   * Verification LOG — who re-checked the doc against reality, and when.
   *
   * The union is required BEHAVIOUR, not a convenience: the spec says a consumer
   * MUST treat a bare `verified` mapping as a single-element list. Accepting only
   * the array form would reject conformant input.
   *
   * ABSENT means unverified, and absent is the correct state for a doc nobody has
   * re-checked. Never backfill this — a fabricated verification is strictly worse
   * than none, and inventing one is the precise failure mode
   * (a `VERIFIED` badge outranking the evidence behind it) that this plan exists
   * to make visible rather than manufacture.
   */
  verified: z.union([okfVerifiedEvent, z.array(okfVerifiedEvent)]).optional(),
  /**
   * Absolute date after which this doc should not be trusted without a re-check:
   * stale when `today >= stale_after`. See `okfDate` for why both shapes are
   * accepted.
   */
  stale_after: okfDate.optional(),
});

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({ extend: normativeInsightFields.merge(okfFields) }),
  }),
};
