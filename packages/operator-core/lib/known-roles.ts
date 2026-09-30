import { AGENT_ROLES } from '@papercusp/agent-mcp';

/**
 * The single source of truth for "what role names exist": the `AGENT_ROLES`
 * const (`@papercusp/agent-mcp`), NOT a filesystem walk.
 *
 * blueprint-role-bundling-2026-06-15 Phase 0 (EI-621 / D-008): this used to walk
 * every `.md` under the global `prompts/` directory (top-level + phase subdirs).
 * That made the *filesystem* the role registry, which blocked deleting the global
 * `prompts/` dir (Phase 5) — and silently drifted from `AGENT_ROLES`. The registry
 * is now the const; `AGENT_ROLES` was expanded (Phase 0) to the COMPLETE built-in
 * universe so this switch is superset-preserving. Plugin-contributed roles widen
 * `AgentRole` to bare `string` at runtime and are intentionally NOT in this set.
 *
 * Kept as a function (rather than inlining `AGENT_ROLES` at every call site) so
 * operator-core has one local accessor for the built-in registry. Returns a fresh
 * array each call — callers may freely mutate/sort it.
 */
export function getKnownRoles(): string[] {
  return [...AGENT_ROLES];
}
