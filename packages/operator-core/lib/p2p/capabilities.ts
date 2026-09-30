/**
 * P2P capability vocabulary + presets (p2p-work-distribution-2026-07-02 P-001).
 *
 * Pure module — no PG, no IO. The grant table stores the EXPANDED capability
 * set (`capabilities text[]`); a preset is display sugar the settings surface
 * (P-002) offers, expanded at write time. Enforcement reads ONLY the expanded
 * set, never the preset label.
 *
 * Item spec (the plan item is the spec, D-016):
 *   capabilities {chat, steer, work-offer, wake, spawn, read-artifacts}
 *   presets Observer(chat) / Collaborator(+steer) / Delegate(+work-offer,wake)
 *           / Operator(+spawn) — cumulative.
 *   `read-artifacts` belongs to NO preset — grantable only à la carte.
 */

export const P2P_CAPABILITIES = [
  'chat',
  'steer',
  'work-offer',
  'wake',
  'spawn',
  'read-artifacts',
] as const;

export type P2pCapability = (typeof P2P_CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(P2P_CAPABILITIES);

export function isP2pCapability(v: unknown): v is P2pCapability {
  return typeof v === 'string' && CAPABILITY_SET.has(v);
}

/**
 * Validate + normalize a capability list: unknown entries are REFUSED (loud,
 * D-004 — a typo'd capability silently granting nothing is a refusal the
 * grantor must see), duplicates dropped, canonical order applied.
 */
export function normalizeCapabilities(
  input: readonly unknown[],
): { ok: true; capabilities: P2pCapability[] } | { ok: false; invalid: string[] } {
  const invalid = input.filter((c) => !isP2pCapability(c)).map((c) => String(c));
  if (invalid.length > 0) return { ok: false, invalid };
  const set = new Set(input as P2pCapability[]);
  return { ok: true, capabilities: P2P_CAPABILITIES.filter((c) => set.has(c)) };
}

/** Cumulative presets, exactly as the plan item defines them. */
export const P2P_PRESETS = {
  observer: ['chat'],
  collaborator: ['chat', 'steer'],
  delegate: ['chat', 'steer', 'work-offer', 'wake'],
  operator: ['chat', 'steer', 'work-offer', 'wake', 'spawn'],
} as const satisfies Record<string, readonly P2pCapability[]>;

export type P2pPresetName = keyof typeof P2P_PRESETS;

export function isP2pPresetName(v: unknown): v is P2pPresetName {
  return typeof v === 'string' && v in P2P_PRESETS;
}

/** Expand a preset to its capability set (a fresh mutable array). */
export function expandPreset(preset: P2pPresetName): P2pCapability[] {
  return [...P2P_PRESETS[preset]];
}

/**
 * X6 "spawn-class": the capabilities that lead to FOREIGN EXECUTION on the
 * grantor's machines (spawn itself, and work-offer — a claimed offer becomes a
 * local-authority spawn, P-104). These are the ops that must refuse a grant
 * record whose grantor_epoch trails the receiver's high-water. chat/steer/
 * read-artifacts are not execution paths; wake is DoS-bounded by its own M9
 * rate cap instead.
 */
export const SPAWN_CLASS_CAPABILITIES: ReadonlySet<P2pCapability> = new Set([
  'spawn',
  'work-offer',
]);

/** D-010 polymorphic grantee kinds (fleet now; pool = the v2 broker, P-304). */
export const P2P_GRANTEE_KINDS = ['fleet', 'pool'] as const;
export type P2pGranteeKind = (typeof P2P_GRANTEE_KINDS)[number];

export function isP2pGranteeKind(v: unknown): v is P2pGranteeKind {
  return v === 'fleet' || v === 'pool';
}
