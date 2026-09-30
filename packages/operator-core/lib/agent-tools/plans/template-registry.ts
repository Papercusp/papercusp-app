/**
 * Plan-template registry (plan-templates-and-rubric-v2-2026-06-20 P-004).
 *
 * A CODE-REGISTRY of per-template zod schemas — the chosen design over a
 * `plan_templates` table (D: types are code-defined; instances are plans). A
 * plan's `template:` frontmatter names a TYPE registered here; its `template_data`
 * jsonb (mig 329) is validated against that type's schema on write
 * (plans:set-template-data, P-005). Phase 2 ships ONE built-in type — `rubric`,
 * whose schema P-006 registers via registerPlanTemplate(). Phase-4 auto-
 * crystallization drafts template-INSTANCE *plans*, never new TYPES, so this
 * registry stays code-defined.
 *
 * Pure + dependency-free (just zod) so it unit-tests in isolation and can be
 * imported by both the write path (P-005) and the schema definitions (P-006)
 * without a cycle.
 */

import type { z } from 'zod';

export interface PlanTemplate {
  /** The template type name — matches a plan's `template:` frontmatter / column. */
  name: string;
  /** One-line human description (surfaced by plans:list template discovery). */
  description: string;
  /** Validates a plan's `template_data` for this type (P-005 validate-on-write). */
  schema: z.ZodTypeAny;
}

const REGISTRY = new Map<string, PlanTemplate>();

/** Register (or replace) a built-in template type. Idempotent by name — P-006
 *  registers `rubric`; tests register fixtures. Last write wins. */
export function registerPlanTemplate(template: PlanTemplate): void {
  REGISTRY.set(template.name, template);
}

/** The registered template, or undefined. */
export function getPlanTemplate(name: string): PlanTemplate | undefined {
  return REGISTRY.get(name);
}

/** Is `name` a known template type? */
export function isKnownPlanTemplate(name: string): boolean {
  return REGISTRY.has(name);
}

/** All registered template types (for plans:list template discovery). */
export function listPlanTemplates(): PlanTemplate[] {
  return [...REGISTRY.values()];
}

/** Test-only: clear the registry so a suite starts clean. */
export function _resetPlanTemplateRegistryForTests(): void {
  REGISTRY.clear();
}

export type ValidateTemplateDataResult =
  | { ok: true; data: unknown }
  | { ok: false; code: 'unknown_template'; known: string[] }
  | { ok: false; code: 'invalid_data'; issues: string[] };

/**
 * Validate `data` against template `name`'s registered schema — the registry's
 * validate-on-write contract that P-005's plans:set-template-data calls before
 * persisting template_data. Returns the parsed (schema-coerced) data on success,
 * or a structured, fail-loud error (unknown type / schema violation) — never
 * throws, never silently strips.
 */
export function validateTemplateData(name: string, data: unknown): ValidateTemplateDataResult {
  const template = REGISTRY.get(name);
  if (!template) {
    return { ok: false, code: 'unknown_template', known: [...REGISTRY.keys()] };
  }
  const parsed = template.schema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_data',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, data: parsed.data };
}
