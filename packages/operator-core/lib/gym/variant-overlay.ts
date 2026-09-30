/**
 * A gym VARIANT is a prompt-override overlay (D-010): never an in-place edit of
 * canonical prompt files. The SAME overlay object is what promotion writes into a
 * dedicated harness via `setPromptOverride` (D-012). This validates the overlay's
 * roles and produces the ordered ops to apply.
 *
 * v1 mutates prompts ONLY (D-015). The schema carries `models` for a later phase,
 * but it never produces a prompt op here, and the v1 runner does not apply it.
 */
import { AGENT_ROLES, FROZEN_OVERLAY_ROLES } from '@papercusp/agent-mcp';

const KNOWN_ROLES: ReadonlySet<string> = new Set(AGENT_ROLES);
// The external judge is frozen (D-003) and must never be overlaid — guarded
// EXPLICITLY now that `judge` is a member of AGENT_ROLES (blueprint-role-bundling
// EI-621), so the freeze no longer relies on it being an "unknown" role.
const FROZEN_ROLES: ReadonlySet<string> = new Set(FROZEN_OVERLAY_ROLES);

export interface VariantOverlay {
  /** role → full prompt markdown that overrides that role for the run. */
  promptOverrides: Record<string, string>;
  /** Reserved (D-015): per-role model swaps, enumerated but not mutated in v1. */
  models?: Record<string, string>;
}

export interface PromptOverrideOp {
  role: string;
  promptMd: string;
}

export interface VariantOverlayPlan {
  /** setPromptOverride(wsId, harnessSlug, role, promptMd) ops, ordered by role. */
  promptOverrideOps: PromptOverrideOp[];
}

export function planVariantOverlay(overlay: VariantOverlay): VariantOverlayPlan {
  const roles = Object.keys(overlay.promptOverrides).sort();
  for (const role of roles) {
    if (FROZEN_ROLES.has(role)) {
      throw new Error(
        `gym variant overlay cannot overlay the frozen role "${role}": the external ` +
          `judge is frozen (D-003) so a variant cannot rewrite its own evaluator.`,
      );
    }
    if (!KNOWN_ROLES.has(role)) {
      throw new Error(
        `gym variant overlay references unknown role "${role}" (not in AGENT_ROLES).`,
      );
    }
  }
  return {
    promptOverrideOps: roles.map((role) => ({ role, promptMd: overlay.promptOverrides[role] })),
  };
}
