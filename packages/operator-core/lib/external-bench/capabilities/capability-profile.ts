/**
 * capability-profile.ts — named capability sets + the materializer (plan
 * benchmark-capability-injection-redesign-2026-06-17, P-001).
 *
 * A {@link CapabilityProfile} is a named SET of palette capabilities — the unit a
 * benchmark ARM selects. The single-capability profiles (`+memory` / `+coord` /
 * `+workqueue`) are the PRIMARY attribution arms (D-011: "the sellable story lives in
 * the per-capability deltas, not the bundled ours"); `vanilla` = the empty control;
 * `ours` = a curated combination (the secondary/confirmatory bundle).
 *
 * {@link materializeProfile} turns a profile + a {@link RunSandbox} into the concrete
 * {@link CapabilityTool}[] handed to a turn-generator's tool-set (injection arms) or
 * allow-listed by a blueprint role's tool-scoping (D-010). The profile names ONLY the
 * capabilities; the sandbox supplies the scope every tool binds to.
 */
import { toolsForCapability } from './capability-tools';
import type { CapabilityKind, CapabilityTool, RunSandbox } from './types';

/** A named capability set. `capabilities` is the SET of palette capabilities the arm gets. */
export interface CapabilityProfile {
  /** The arm name (e.g. `vanilla`, `+memory`, `ours`). */
  name: string;
  /** The palette capabilities this profile enables (deduped, order-preserving). */
  capabilities: CapabilityKind[];
  /** A one-line description for the report. */
  description: string;
}

/**
 * The canonical profiles. `vanilla` = the empty control (no capabilities — the bare
 * model). The three single-capability profiles are the attribution arms (D-011). `ours`
 * = the curated combination (memory + work-queue + coord — the full substrate; per-suite
 * harnesses may curate a narrower `ours`, but the default palette bundle is all three).
 */
export const CAPABILITY_PROFILES = {
  vanilla: {
    name: 'vanilla',
    capabilities: [],
    description: 'No capabilities — the bare-model control arm.',
  },
  '+memory': {
    name: '+memory',
    capabilities: ['memory'],
    description: 'Single-capability attribution arm: persistent sandbox memory only.',
  },
  '+coord': {
    name: '+coord',
    capabilities: ['coord'],
    description: 'Single-capability attribution arm: sandbox coord only.',
  },
  '+workqueue': {
    name: '+workqueue',
    capabilities: ['workqueue'],
    description: 'Single-capability attribution arm: sandbox work-queue only.',
  },
  ours: {
    name: 'ours',
    capabilities: ['memory', 'workqueue', 'coord'],
    description: 'Curated bundle: memory + work-queue + coord (the confirmatory ours arm).',
  },
} as const satisfies Record<string, CapabilityProfile>;

/** The canonical profile names. */
export type CapabilityProfileName = keyof typeof CAPABILITY_PROFILES;

/** Resolve a profile by name (or pass a profile through). Throws on an unknown name. */
export function resolveProfile(profile: CapabilityProfileName | CapabilityProfile): CapabilityProfile {
  if (typeof profile === 'string') {
    const found = CAPABILITY_PROFILES[profile];
    if (!found) throw new Error(`unknown capability profile: ${profile}`);
    return found;
  }
  return profile;
}

/**
 * Materialize a profile against a sandbox → the concrete {@link CapabilityTool}[] the
 * arm runs with. `vanilla` → `[]`; `+memory` → only the memory tools; `ours` → the
 * curated set. Each tool is bound to the sandbox so every call carries its scope.
 * Capabilities are deduped (a curated profile that names a capability twice yields its
 * tools once), order-preserving.
 */
export function materializeProfile(
  profile: CapabilityProfileName | CapabilityProfile,
  sandbox: RunSandbox,
): CapabilityTool[] {
  const resolved = resolveProfile(profile);
  const seen = new Set<CapabilityKind>();
  const tools: CapabilityTool[] = [];
  for (const cap of resolved.capabilities) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    tools.push(...toolsForCapability(cap, sandbox));
  }
  return tools;
}
