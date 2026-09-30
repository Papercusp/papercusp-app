/**
 * Capability — the unified capability-metadata contract.
 *
 * One declarative descriptor that the command palette, voice, keyboard
 * shortcuts AND the agent/MCP catalog can all project from. See plan
 * `capability-metadata-contract-2026-05-31` (P-002).
 *
 * D-002: the host-agnostic CORE (`CapabilityCore` + `CapabilityGate`) is a
 * candidate to lift into `@papercusp/tooldef` later — keep it browser-free
 * so the move is mechanical. The browser-only surface annotations
 * (`CapabilitySurfaces`) stay in the operator host. Phase 1 lands the whole
 * type here in `apps/operator/lib/capabilities/`.
 */

/** Risk tier — mirrors tooldef `CapabilityTier` exactly (`'low' | 'medium' | 'high'`). */
export type CapabilityRiskTier = 'low' | 'medium' | 'high';

/**
 * Where the capability executes. Mirrors `CommandDef.browser` (3-valued),
 * so the Action-Registry mapping is lossless (review #4):
 *   - `server`  — dispatch-stack handler, no live tab    (browser:'none')
 *   - `browser` — reflexive UI; needs a tab; mutates DOM  (browser:'required')
 *   - `hybrid`  — server-canonical, updates a tab if any  (browser:'optional')
 */
export type CapabilityRunsIn = 'server' | 'browser' | 'hybrid';

export type CapabilityConcurrency = 'allow' | 'queue' | 'deny';

/** Minimum principal trust floor. String to keep the core free of a hard tooldef dep. */
export type CapabilityTrust = string;

export interface CapabilityGate {
  /**
   * PERSONA / SURFACE axis (today: `CommandDef.agents` + tooldef `tool.roles`).
   * NEVER principal RBAC — see D-004 / RFC tooldef-auth D-E.
   */
  agentRoles?: readonly string[];
  /** PRINCIPAL RBAC axis — RFC tooldef-auth D-E disambiguated names. */
  auth?: {
    roles?: readonly string[];
    capabilities?: readonly string[];
    trust?: CapabilityTrust;
  };
}

/** Host-agnostic core (D-002): browser-free. */
export interface CapabilityCore {
  /** Stable, namespaced: `'group:verb'` (e.g. `'features:get'`, `'nav:settings'`). */
  id: string;
  /** SHORT human label (palette row / voice). */
  title: string;
  /** SHORT human noun-phrase (palette subtitle). Distinct from `agentDescription` (review #5). */
  description: string;
  /** LONG model-facing/imperative text (tooldef `guidance.when`; `CommandDef.promptDescription`). */
  agentDescription?: string;
  runsIn: CapabilityRunsIn;
  /**
   * `true` ⇒ the args schema rejects `{}` (has required args) ⇒ excluded from
   * one-keystroke palette execution until the palette grows an arg prompt
   * (Phase 2). Computed by {@link schemaRequiresArgs}.
   */
  requiresArgs: boolean;
  concurrent?: CapabilityConcurrency;
  /** Irreversible / outward-facing (delete, kill, promote, send). Forces a confirm step. */
  destructive?: boolean;
  /** Emits incremental state (`ctx.publishState`) — the dispatch+toast shim can't host it. */
  streaming?: boolean;
  /** Prompts the caller mid-run (`ctx.askUser`) — needs a card surface, not a toast. */
  interactive?: boolean;
  /** RISK tier (`capability-tiers.ts`) — distinct from a plan item's importance. */
  tier: CapabilityRiskTier;
  gating: CapabilityGate;
}

/** Operator-host surface annotations (D-002): browser-only, never in tooldef. */
export interface CapabilitySurfaces {
  palette?: { section: string; icon?: string; keywords?: string; confirm?: boolean };
  voice?: boolean;
  /** Registry shortcut id (`lib/shortcut-registry.ts`). */
  shortcut?: string;
  /** Exposed to agents as a first-class MCP tool (default derived: `runsIn !== 'browser'`). */
  mcp?: boolean;
}

export type Capability = CapabilityCore & { surfaces?: CapabilitySurfaces };
