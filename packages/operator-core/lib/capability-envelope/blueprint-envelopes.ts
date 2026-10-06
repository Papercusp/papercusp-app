/**
 * Per-hive capability envelopes from a blueprint's `fleet.workerRoles`
 * (hive-blueprint-generalization P-012). A hive blueprint may declare, per worker
 * role, the capability ALLOW-list its bees are confined to — the per-hive analogue of
 * the global `ROLE_ENVELOPES` tuning in `./policy`. This resolves that declaration
 * into the envelope map `evaluateCapabilityEnvelope` consumes (pass it as the
 * `envelopes` arg), MERGED OVER the global defaults so a role the blueprint does not
 * name keeps its global envelope.
 *
 * Behavior-preserving: a non-fleet harness (today's coding hive AND generic-hive, which
 * declare no `fleet`) ⇒ `undefined`, so the caller uses the global `ROLE_ENVELOPES`
 * map unchanged. Reading is best-effort + fail-safe (a bad/absent blueprint ⇒ undefined).
 *
 * Caching: keyed by stateDir + the blueprint file's mtime, so the (cheap) blueprint
 * read happens at most once per harness-config version — never on the per-call hot path.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadBlueprintFromFile, type ResolvedAgentSpecification } from '@papercusp/orchestrator/blueprint';
import type { PotCapabilityProviderBindingRow } from '../capability-class-registry-store';
import { grantProviderToolReach } from '../agent-identities/grant-provider-kinds';
import { matchesAny, PROTECTED_CAPABILITY_GLOBS, ROLE_ENVELOPES, type RoleEnvelope } from './policy';
import { identityRefusalContract, type RefusalContract } from './identity-refusal-contract';

interface CacheEntry {
  mtimeMs: number;
  envelopes: Partial<Record<string, RoleEnvelope>> | undefined;
}
const cache = new Map<string, CacheEntry>();

/** Test seam: drop the mtime cache so a fixture's rewritten blueprint is re-read. */
export function __clearBlueprintEnvelopeCache(): void {
  cache.clear();
}

export function blueprintRoleEnvelopes(
  stateDir: string,
): Partial<Record<string, RoleEnvelope>> | undefined {
  const f = join(stateDir, 'blueprint.yaml');
  let mtimeMs = 0;
  try {
    if (!existsSync(f)) return undefined;
    mtimeMs = statSync(f).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(stateDir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.envelopes;

  let envelopes: Partial<Record<string, RoleEnvelope>> | undefined;
  try {
    const workerRoles = loadBlueprintFromFile(f).blueprint.fleet?.workerRoles ?? [];
    if (workerRoles.length === 0) {
      envelopes = undefined;
    } else {
      const merged: Partial<Record<string, RoleEnvelope>> = { ...ROLE_ENVELOPES };
      for (const wr of workerRoles) {
        // A declared capability list IS that role's allow-list (the per-hive envelope);
        // an empty list leaves the role's global envelope untouched.
        if (wr.capabilities && wr.capabilities.length > 0) {
          merged[wr.id] = { ...merged[wr.id], allowCapabilities: wr.capabilities };
        }
      }
      envelopes = merged;
    }
  } catch {
    envelopes = undefined; // fail-safe: a bad blueprint never strands capability checks
  }
  cache.set(stateDir, { mtimeMs, envelopes });
  return envelopes;
}

/**
 * Every cause the identity gate can refuse with. A const list (not just a union) so
 * the refusal-contract table and its test derive from the one truth instead of
 * paraphrasing it (EI-23766133296678780).
 */
export const IDENTITY_GRANT_FAILURE_CAUSES = [
  'stale-artifact', 'no-launch-record', 'policy-unavailable', 'provider-unbound',
  'provider-changed', 'tool-unavailable', 'outside-ceiling',
] as const;
export type IdentityGrantFailureCause = (typeof IDENTITY_GRANT_FAILURE_CAUSES)[number];

export interface IdentityGrantFailure {
  code: 'capability_unsatisfied';
  classRef: string | null;
  cause: IdentityGrantFailureCause;
  toolName?: string;
  routes: readonly ['operator-notify', 'suggest-provider', 'needs_human'];
  /** What would lift this refusal, who can make it true, and what was compared (set on runtime denials). */
  refusal?: RefusalContract;
}

/** One ceiling predicate shared by install validation and runtime grants. */
export function identityGrantToolFailure(input: {
  toolName: string;
  ceilings: readonly RoleEnvelope[] | null;
  tools: ReadonlyMap<string, readonly string[]>;
  protectedAdditions?: readonly string[];
}): IdentityGrantFailure['cause'] | null {
  if (!input.ceilings?.length) return 'policy-unavailable';
  const capabilities = input.tools.get(input.toolName);
  if (!capabilities) return 'tool-unavailable';
  const floor = [...PROTECTED_CAPABILITY_GLOBS, ...(input.protectedAdditions ?? [])];
  const names = [input.toolName, ...capabilities];
  if (names.some((name) => matchesAny(name, floor))) return 'outside-ceiling';
  return input.ceilings.every((ceiling) => {
    if (ceiling.denyCapabilities && names.some((name) => matchesAny(name, ceiling.denyCapabilities!))) return false;
    if (ceiling.allowCapabilities === undefined) return true;
    return matchesAny(input.toolName, ceiling.allowCapabilities) ||
      (capabilities.length > 0 && capabilities.every((cap) => matchesAny(cap, ceiling.allowCapabilities!)));
  }) ? null : 'outside-ceiling';
}

/** A resolved narrowing, never a replacement for the caller's role ceiling. */
export type IdentityGrantEnvelope =
  | { applied: false }
  | {
      applied: true;
      specificationRevision: string;
      policyRevision: string;
      allowedTools: readonly string[];
      failures: readonly IdentityGrantFailure[];
    };

/**
 * P-005/D-005: derive exact tool grants from an APPLIED compiled artifact and
 * current host policy. No reads/cache here: dispatch must supply fresh bindings
 * and ceilings at each enforcement boundary, including after prompt failure.
 * The artifact must already have passed the compiler's integrity check. Tools,
 * bindings and ceilings are host-resolved evidence, never tool-call arguments.
 *
 * Rebinding does not silently activate a different provider under an old pin.
 * Optional unavailable providers grant nothing; a required failure closes the
 * whole envelope. No grants declaration preserves the legacy role-envelope path.
 */
export function resolveIdentityGrantEnvelope(input: {
  specification: ResolvedAgentSpecification;
  appliedSpecificationRevision: string;
  policyRevision: string;
  potSlug: string;
  bindings: readonly PotCapabilityProviderBindingRow[] | null;
  /** Every independently authorized ceiling must pass. Null/empty = unknown. */
  ceilings: readonly RoleEnvelope[] | null;
  /** Exact projected tool name -> required capabilities, read from the host. */
  tools: ReadonlyMap<string, readonly string[]>;
  protectedAdditions?: readonly string[];
}): IdentityGrantEnvelope {
  const { specification } = input;
  const grants = specification.configuration.grants;
  if (!grants) return { applied: false };
  const failures: IdentityGrantFailure[] = [];
  const allowedTools = new Set<string>();
  const fail = (cause: IdentityGrantFailure['cause'], classRef: string | null, toolName?: string) => {
    // WI-10005197: the same lift condition the kernel verdict carries for this cause.
    failures.push({ code: 'capability_unsatisfied', cause, classRef,
      ...(toolName ? { toolName } : {}), routes: ['operator-notify', 'suggest-provider', 'needs_human'],
      refusal: identityRefusalContract(cause) });
  };
  const result = (): IdentityGrantEnvelope => ({
    applied: true,
    specificationRevision: specification.specificationRevision,
    policyRevision: input.policyRevision,
    allowedTools: failures.length ? [] : [...allowedTools].sort(),
    failures,
  });
  if (specification.specificationRevision !== input.appliedSpecificationRevision) {
    fail('stale-artifact', null);
    return result();
  }
  if (!input.policyRevision.trim() || !input.potSlug.trim() || !input.bindings || !input.ceilings?.length) {
    fail('policy-unavailable', null);
    return result();
  }
  const pins = specification.inputs.filter((entry) => entry.kind === 'capability-provider');
  const required = new Set(grants.requires ?? []);
  const classes = new Set([...required, ...(grants.optional ?? [])]);
  for (const classRef of classes) {
    const matchingPins = pins.filter((pin) => pin.ref === classRef);
    // An optional class absent at compilation cannot acquire authority later.
    if (matchingPins.length === 0 && !required.has(classRef)) continue;
    const current = input.bindings.filter((binding) =>
      binding.classRef === classRef && binding.potSlug === input.potSlug &&
      binding.status === 'active' && binding.conformanceStatus === 'passed');
    if (current.length === 0) {
      if (required.has(classRef)) fail('provider-unbound', classRef);
      continue;
    }
    const pin = matchingPins[0];
    const binding = current[0];
    const sameVerbs = pin && Object.keys(pin.verbBindings).length === Object.keys(binding.verbBindings).length &&
      Object.entries(pin.verbBindings).every(([verb, tool]) => binding.verbBindings[verb] === tool);
    if (matchingPins.length !== 1 || current.length !== 1 || !pin ||
        pin.providerPackage !== binding.providerPackage || pin.providerVersion !== binding.providerVersion ||
        pin.registryRevision !== binding.registryRevision || pin.conformanceRunId !== binding.conformanceRunId || !sameVerbs) {
      if (required.has(classRef)) fail('provider-changed', classRef);
      continue;
    }
    // P-012 / D-040(e): a recipe provider's verbs name recipes; the grant is the
    // tool reach its inspection recorded, the same reach install admitted.
    const classTools = grantProviderToolReach(binding);
    if (!classTools) {
      if (required.has(classRef)) fail('provider-unbound', classRef);
      continue;
    }
    const permitted: string[] = [];
    for (const toolName of classTools) {
      const cause = identityGrantToolFailure({ ...input, toolName });
      if (cause) fail(cause, classRef, toolName);
      else permitted.push(toolName);
    }
    permitted.forEach((toolName) => allowedTools.add(toolName));
  }
  return result();
}
