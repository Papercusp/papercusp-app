/**
 * dynamic-tool-confinement — the confined capability envelope for a RUNTIME-CREATED tool
 * (reflexive-platform-extensibility-datatypes-2026-06-24 P-003, design D-003).
 *
 * D-003: runtime tool creation is first-class; SAFETY = CONFINEMENT, not prohibition. A
 * dynamic tool (a sandboxed-imperative / elevated tool from meta:define-tool) runs inside a
 * confined envelope that:
 *   - holds ONLY the capabilities / fs paths / network domains it DECLARED — exercising
 *     anything beyond the declaration is denied (no escalation), AND
 *   - can only NARROW the host role's envelope, never widen it (the confinement is a subset
 *     of the role's permissions), AND
 *   - can NEVER touch the MINTING / ESCALATION surface — granting/revoking capabilities,
 *     editing envelopes, raising tiers, defining more tools/datatypes, scaffolding,
 *     contributing to the platform, reading raw secrets, killing processes, spawning fleet
 *     (the self-graduation hazard the capability TCB forbids — capability-envelope/tcb.ts, D-007).
 *
 * This is the PURE derivation + decision, plus its ADVERSARIAL proof (the sibling test). It
 * REUSES the canonical envelope matcher (`capability-envelope/policy`) but is NOT itself part
 * of the TCB: the dispatch WIRING that consults it at the enforcement seat (the PEP) is a
 * TCB edit (`capability-envelope/**`) and ships via the reviewed PR rail, never a runtime
 * auto-apply (D-007: a TCB change classifies tier:'human').
 *
 * Server-or-bundle-safe: pure, no I/O.
 */
import { matchesAny, type RoleEnvelope } from './capability-envelope/policy';

/** What a runtime-created tool DECLARES it needs — its self-confinement request. */
export interface DynamicToolConfinement {
  /** Capabilities the tool may exercise (e.g. ['net:fetch','intel:read']). Required, non-empty. */
  capabilities: readonly string[];
  /** Filesystem path globs the tool may read/write. Absent ⇒ NO filesystem access. */
  allowPathGlobs?: readonly string[];
  /** Network domains the tool may reach. Absent ⇒ NO network access. */
  allowDomains?: readonly string[];
}

/**
 * Capabilities a confined dynamic tool may NEVER hold — the no-minting / no-escalation
 * floor. These are the TCB-mutating + self-graduating surfaces (capability-envelope/tcb.ts,
 * D-007): granting/revoking capabilities, editing the envelope, raising tiers, defining new
 * tools/datatypes, scaffolding, platform-contributing, reading raw secrets, killing
 * processes, spawning fleet. A tool that DECLARES any of these is rejected at derivation; a
 * confined tool that tries to exercise one at runtime is denied.
 */
export const DYNAMIC_TOOL_FORBIDDEN_CAPABILITY_GLOBS: readonly string[] = [
  // These are defineTool CAPABILITY values, not tool names. Several privileged
  // tools share a broader logical capability; denying that whole capability is
  // deliberate. A no-escalation floor must fail closed when the namespace cannot
  // distinguish one privileged verb from its siblings.
  'operator:write', // grant/revoke roles, envelope/tier/config mutation
  'intel:write', // meta:define-tool/datatype and tools:scaffold
  'harness:write', // platform:contribute
  'secrets:*',
  'processes:kill',
  // The "spawning fleet" leg of the floor above. This was `cup:spawn` alone
  // until P-059 retired that verb with the Mug/Kettle/Cup tier; dropping it
  // without a replacement would have NARROWED the floor to nothing on this
  // axis, because the surviving spawn doors were never listed beside it. They
  // are now — deny-widening is the safe direction for a no-escalation floor.
  'capability:terminal', // capability:launch-agent + fleet:launch-on-plan
  'work_items:write', // fleet:place_batch
];

export interface ConfinedEnvelope {
  allowCapabilities: readonly string[];
  denyCapabilities: readonly string[];
  allowPathGlobs: readonly string[];
  allowDomains: readonly string[];
}

export type DeriveResult =
  | { ok: true; envelope: ConfinedEnvelope }
  | {
      ok: false;
      reason: 'mints_capability' | 'widens_role' | 'empty_capabilities';
      message: string;
      offending?: string;
    };

/** Is `cap` on the forbidden minting / escalation floor? */
export function isForbiddenDynamicCapability(cap: string): boolean {
  return matchesAny(cap, DYNAMIC_TOOL_FORBIDDEN_CAPABILITY_GLOBS);
}

/**
 * Derive a confined envelope for a dynamic tool from its declaration, narrowed to the host
 * role. Rejects a declaration that mints/escalates or widens beyond the role (narrow-only).
 * A `role` dimension left default-allow (absent / `['*']`) is not constraining — the
 * declaration stands as the tool's self-confinement, still minus the forbidden floor.
 */
export function deriveDynamicToolEnvelope(
  declared: DynamicToolConfinement,
  role?: RoleEnvelope,
): DeriveResult {
  if (!declared.capabilities || declared.capabilities.length === 0) {
    return {
      ok: false,
      reason: 'empty_capabilities',
      message: 'a dynamic tool must declare ≥1 capability (an empty declaration is not "allow all")',
    };
  }
  // 1) No minting / escalation: a declared forbidden capability is rejected outright.
  for (const cap of declared.capabilities) {
    if (isForbiddenDynamicCapability(cap)) {
      return {
        ok: false,
        reason: 'mints_capability',
        message: `a dynamic tool may not hold "${cap}" — it is on the minting/escalation floor`,
        offending: cap,
      };
    }
  }
  // 2) Narrow-only vs the host role: a dimension the role CONSTRAINS must permit every
  //    declared value. A role dimension left default-allow is not constraining.
  const roleAllowsAllCaps = !role?.allowCapabilities || role.allowCapabilities.includes('*');
  if (!roleAllowsAllCaps) {
    for (const cap of declared.capabilities) {
      if (!matchesAny(cap, role!.allowCapabilities!)) {
        return widens(`capability "${cap}" is outside the host role's allowlist`, cap);
      }
    }
  }
  for (const cap of declared.capabilities) {
    if (role?.denyCapabilities && matchesAny(cap, role.denyCapabilities)) {
      return widens(`capability "${cap}" is denied for the host role`, cap);
    }
  }
  if (role?.allowPathGlobs && role.allowPathGlobs.length > 0) {
    for (const p of declared.allowPathGlobs ?? []) {
      if (!matchesAny(p, role.allowPathGlobs)) {
        return widens(`path "${p}" is outside the host role's allowed paths`, p);
      }
    }
  }
  if (role?.allowDomains && role.allowDomains.length > 0) {
    for (const d of declared.allowDomains ?? []) {
      if (!matchesAny(d, role.allowDomains)) {
        return widens(`domain "${d}" is outside the host role's allowed domains`, d);
      }
    }
  }
  // 3) The confined envelope: allow ONLY the declared dimensions; deny the forbidden floor +
  //    the role's denies (defense in depth — escalation beyond the declaration fails the allow).
  return {
    ok: true,
    envelope: {
      allowCapabilities: [...declared.capabilities],
      denyCapabilities: [...DYNAMIC_TOOL_FORBIDDEN_CAPABILITY_GLOBS, ...(role?.denyCapabilities ?? [])],
      allowPathGlobs: [...(declared.allowPathGlobs ?? [])],
      allowDomains: [...(declared.allowDomains ?? [])],
    },
  };
}

function widens(message: string, offending: string): DeriveResult {
  return { ok: false, reason: 'widens_role', message: `${message} (a dynamic tool can only narrow, never widen)`, offending };
}

export type ConfinedDecision = { allow: true } | { allow: false; reason: string };

/**
 * May a confined dynamic tool exercise `capability`? Denied if it is on the forbidden floor
 * / a role deny, OR outside the tool's declared allowlist (no escalation). The deny is
 * checked FIRST so the floor wins even if a declaration somehow listed it.
 */
export function checkConfinedCapability(env: ConfinedEnvelope, capability: string): ConfinedDecision {
  if (matchesAny(capability, env.denyCapabilities)) {
    return { allow: false, reason: `capability "${capability}" is denied (minting/escalation floor or host-role deny)` };
  }
  if (!matchesAny(capability, env.allowCapabilities)) {
    return { allow: false, reason: `capability "${capability}" is outside the tool's declared envelope (no escalation)` };
  }
  return { allow: true };
}

/** A path segment that escapes its prefix — the traversal that a `**` glob would wrongly admit. */
function hasTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

/**
 * May a confined tool touch `path`? Denied unless the (traversal-free) path matches an
 * allowed glob. The traversal check is load-bearing: `/data/x/**` would otherwise glob-match
 * `/data/x/../../etc/passwd` — so a `..` segment is rejected BEFORE the glob, closing the
 * fs-escape hole a naive allowlist leaves open.
 */
export function checkConfinedPath(env: ConfinedEnvelope, path: string): ConfinedDecision {
  if (env.allowPathGlobs.length === 0) return { allow: false, reason: 'the tool declared no filesystem access' };
  if (hasTraversal(path)) return { allow: false, reason: `path "${path}" contains a ".." traversal segment (fs escape blocked)` };
  if (!matchesAny(path, env.allowPathGlobs)) {
    return { allow: false, reason: `path "${path}" is outside the tool's allowed paths (fs escape blocked)` };
  }
  return { allow: true };
}

/** May a confined tool reach `domain`? Denied unless it matches an allowed domain glob. */
export function checkConfinedDomain(env: ConfinedEnvelope, domain: string): ConfinedDecision {
  if (env.allowDomains.length === 0) return { allow: false, reason: 'the tool declared no network access' };
  if (!matchesAny(domain, env.allowDomains)) {
    return { allow: false, reason: `domain "${domain}" is outside the tool's allowed domains (denied-host network blocked)` };
  }
  return { allow: true };
}
