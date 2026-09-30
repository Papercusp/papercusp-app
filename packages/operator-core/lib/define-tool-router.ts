/**
 * define-tool-router — the PURE tier router behind meta:define-tool
 * (reflexive-platform-extensibility-datatypes-2026-06-24 P-002, design D-003).
 *
 * D-003: runtime tool creation is first-class; SAFETY = confinement + REVIEW, not
 * prohibition. The TIER decides the rail:
 *   - composed              → a DAG/recipe over EXISTING primitives. Mints NO new
 *                             capability, so it registers LIVE as a code_recipe
 *                             (recipes:run executes it). There is no new cap to confine.
 *   - sandboxed-imperative  → genuinely new power. NEVER registered at runtime: emit a
 *   | elevated                reviewable skeleton (P-004 scaffoldTool) for the PR rail
 *                             (review + adversarial confinement proof → platform:contribute).
 *
 * This module is the pure DECISION (no I/O). The meta:define-tool handler executes the
 * route — `upsertRecipe` for a composition, or return the scaffold for the dangerous
 * tiers. Exhaustively unit-testable without a DB.
 */
import {
  TOOL_TIERS,
  isToolTier,
  scaffoldTool,
  type ToolTier,
  type ToolArgSpec,
  type ToolScaffoldSpec,
  type ScaffoldResult,
} from './tool-scaffold';

function kebab(s: string): string {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface DefineToolSpec {
  name: string;
  description: string;
  tier: ToolTier;
  /** Required for the review-gated tiers (declared for review); ignored for composed. */
  capability?: string;
  // composed tier:
  /** The composition over existing tools (a recipes script). Required for composed. */
  script?: string;
  toolsUsed?: string[];
  tags?: string[];
  // review-gated tiers (delegated to scaffoldTool — P-004):
  group?: string;
  verb?: string;
  args?: ToolArgSpec[];
  firstClass?: boolean;
  migrationTable?: string;
}

/** A composed tool persists as a code_recipe (the recipes substrate, reused per D-003). */
export interface ComposedRecipeInput {
  id: string;
  title: string;
  description: string;
  script: string;
  toolsUsed: string[];
  tags: string[];
}

export type DefineToolRoute =
  | { kind: 'composition'; recipe: ComposedRecipeInput }
  | { kind: 'scaffold'; result: ScaffoldResult }
  | { kind: 'error'; message: string };

/**
 * Route a define-tool request by tier. Pure: composed → a ComposedRecipeInput the caller
 * upserts; sandboxed/elevated → a generated reviewable skeleton (via scaffoldTool); any
 * shape error → `{ kind:'error' }`. The composed path deliberately does NOT require a
 * `capability` — a composition mints none.
 */
export function routeDefineTool(spec: DefineToolSpec): DefineToolRoute {
  const err = (message: string): DefineToolRoute => ({ kind: 'error', message });
  if (!isToolTier(spec.tier)) return err(`tier must be one of ${TOOL_TIERS.join(' | ')}`);
  if (!spec.name.trim()) return err('name is required');
  if (!spec.description.trim()) return err('description is required');

  if (spec.tier === 'composed') {
    if (!spec.script || !spec.script.trim()) {
      return err(
        'composed tier requires `script` — the composition over existing tools (it runs via recipes:run and mints no new capability)',
      );
    }
    const id = kebab(spec.name);
    if (!id) return err(`"${spec.name}" slugifies to empty — give an alphanumeric name`);
    return {
      kind: 'composition',
      recipe: {
        id,
        title: spec.name,
        description: spec.description,
        script: spec.script,
        toolsUsed: spec.toolsUsed ?? [],
        tags: spec.tags ?? [],
      },
    };
  }

  // sandboxed-imperative | elevated → RUNTIME-DANGEROUS (D-003): scaffold to the PR rail.
  if (!spec.capability || !spec.capability.trim()) {
    return err(`tier "${spec.tier}" is review-gated and must declare its capability (for review)`);
  }
  if (!spec.group || !spec.verb) {
    return err(`tier "${spec.tier}" requires group + verb (the scaffold file location)`);
  }
  const scaffoldSpec: ToolScaffoldSpec = {
    group: spec.group,
    verb: spec.verb,
    name: spec.name,
    description: spec.description,
    tier: spec.tier,
    capability: spec.capability,
    args: spec.args,
    firstClass: spec.firstClass,
    migrationTable: spec.migrationTable,
  };
  const result = scaffoldTool(scaffoldSpec);
  if (!result.ok) return err(result.message);
  return { kind: 'scaffold', result };
}
