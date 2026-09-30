/**
 * Class-fired reaction targets — the seam that frees a rule from its plugin
 * (identities-v1-2026-08-30 P-028, D-011 / D-054).
 *
 * A PLUGIN rule's `fire` names a concrete tool and is validated AT REGISTRATION
 * (`lookupByMcpName`, `plugin-host-runtime.ts`): the target must already exist as
 * one of that plugin's own projected tools. That check is correct for plugin
 * rules and stays (D-054 §7). A STANDALONE rule cannot be checked that way, and
 * the reason is architectural rather than a strictness preference:
 * `getPotCapabilityProviderBinding` is PER-POT and mutable —
 * `bindCapabilityProviderToPot` / `deletePotCapabilityProviderBinding` can move
 * or remove the binding after the rule registers, and the point of D-004 is that
 * two pots resolve the SAME rule to different providers. A registration-time
 * tool check would therefore either refuse a valid rule (this pot has no binding
 * yet) or bake in one pot's answer.
 *
 * So the one check splits across two different times:
 *
 *   - REGISTRATION — `validateClassFireTarget`: the ref parses, the class exists,
 *     it DECLARES the named verb, and that verb declares the capability the
 *     reaction will be sandboxed to. Entirely pot-independent, and the check that
 *     makes a bad rule fail early.
 *   - FIRE — `resolveClassFireTarget`: the pot's own binding resolves
 *     `verbBindings[verb]` to a concrete tool mcp name, which the existing fire
 *     machinery then dispatches unchanged.
 *
 * The capability comes from the CLASS, never from the resolved provider tool
 * (D-054 §4): the fired tool is provider-dependent, so sourcing the sandbox from
 * it would let installing a different provider silently widen what the rule may
 * do. `validateClassFireTarget` refuses a verb that declares no capability
 * instead of falling back to the tool's.
 */

import type postgres from 'postgres';
import {
  capabilityClassRef,
  getCapabilityClass,
  getPotCapabilityProviderBinding,
  parseCapabilityClassRef,
} from '../capability-class-registry-store';

/** The scheme a standalone rule's `fire` uses: `class:<id>@<version>#<verb>`. */
export const CLASS_FIRE_SCHEME = 'class:';

export interface ClassFireTarget {
  /** Canonical `<id>@<version>` ref, normalized through `capabilityClassRef`. */
  classRef: string;
  classId: string;
  classVersion: string;
  /** The class interface verb this rule fires. */
  verb: string;
}

/**
 * Does this `fire` name a capability class rather than a tool? Cheap and total —
 * the dispatch path uses it to decide which resolution applies, so it must never
 * throw and never touch the database.
 */
export function isClassFireTarget(fire: string): boolean {
  return typeof fire === 'string' && fire.startsWith(CLASS_FIRE_SCHEME);
}

/**
 * Parse `class:<id>@<version>#<verb>` — syntax only, no existence check.
 * Returns null for anything that is not a well-formed class fire target,
 * INCLUDING an ordinary tool name, so a caller can branch on it directly.
 */
export function parseClassFireTarget(fire: string): ClassFireTarget | null {
  if (!isClassFireTarget(fire)) return null;
  const body = fire.slice(CLASS_FIRE_SCHEME.length);
  // The verb is after the LAST '#': a class id may not contain one, but keeping
  // this symmetric with parseCapabilityClassRef's lastIndexOf('@') costs nothing.
  const hash = body.lastIndexOf('#');
  if (hash <= 0 || hash === body.length - 1) return null;
  const verb = body.slice(hash + 1).trim();
  if (!verb) return null;
  const parsed = parseCapabilityClassRef(body.slice(0, hash));
  if (!parsed) return null;
  return {
    classRef: capabilityClassRef(parsed.id, parsed.version),
    classId: parsed.id,
    classVersion: parsed.version,
    verb,
  };
}

/** Build the canonical fire string for a class verb. */
export function classFireTarget(classRef: string, verb: string): string {
  return `${CLASS_FIRE_SCHEME}${classRef}#${verb}`;
}

export type ValidateClassFireResult =
  | { ok: true; target: ClassFireTarget; capability: string }
  | { ok: false; error: string };

/**
 * REGISTRATION-time validation (D-054 §3). Pot-independent by construction: it
 * reads the class, never a binding, so the same verdict holds in every pot the
 * rule ships to.
 *
 * Returns the capability the reaction must be sandboxed to. A verb that declares
 * none is REFUSED rather than defaulted — see the module docstring.
 */
export async function validateClassFireTarget(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  fire: string,
): Promise<ValidateClassFireResult> {
  const target = parseClassFireTarget(fire);
  if (!target) {
    return {
      ok: false,
      error: `fire target "${fire}" is not a capability class verb (expected "class:<id>@<version>#<verb>")`,
    };
  }

  const row = await getCapabilityClass(sql, workspaceId, target.classId, target.classVersion);
  if (!row) {
    return {
      ok: false,
      error: `fire target "${fire}" names capability class "${target.classRef}", which is not defined in this workspace`,
    };
  }

  const verb = row.interfaceVerbs?.[target.verb];
  if (!verb) {
    const declared = Object.keys(row.interfaceVerbs ?? {}).sort();
    return {
      ok: false,
      error:
        `capability class "${target.classRef}" does not declare verb "${target.verb}"` +
        (declared.length ? ` (it declares: ${declared.join(', ')})` : ' (it declares no verbs)'),
    };
  }

  const capability = typeof verb.capability === 'string' ? verb.capability.trim() : '';
  if (!capability) {
    return {
      ok: false,
      error:
        `capability class "${target.classRef}" verb "${target.verb}" declares no \`capability\` — a class-fired rule is ` +
        'sandboxed to the CLASS\'s capability, never the resolved provider tool\'s (D-054 §4), so there is nothing to scope it to',
    };
  }

  return { ok: true, target, capability };
}

/**
 * The FIRE-time outcome.
 *
 * `unbound` is a first-class runtime outcome, NOT a registration error and NOT
 * silence. D-054 §3 left the disposition open ("skip quietly vs surface") and
 * D-055 rules SURFACE: a rule installed into a pot whose class has no provider is
 * a misconfiguration of that install, and this registry's own docstring records
 * what quiet non-firing costs — `reconcile-rule.ts` sat dead for weeks because a
 * non-matching rule fails silently with no error (EI-5925 / EI-6960). The caller
 * reports it as a failed reaction naming the class, the pot, and the remedy.
 */
export type ResolveClassFireResult =
  | {
      status: 'resolved';
      target: ClassFireTarget;
      /** The concrete tool mcp name this pot's provider binds the verb to. */
      tool: string;
      providerPackage: string;
      providerVersion: string;
    }
  | { status: 'unbound'; target: ClassFireTarget; error: string }
  | { status: 'invalid'; error: string };

/**
 * FIRE-time provider resolution (D-054 §3). `verbBindings` is already exactly the
 * verb -> tool map this needs; it was built for P-043 conformance, and the header
 * invariant there ("pot bindings may only reference a provider backed by a passing
 * run") is what makes resolving through it safe without re-checking conformance.
 */
export async function resolveClassFireTarget(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { workspaceId: string; potSlug: string; fire: string },
): Promise<ResolveClassFireResult> {
  const target = parseClassFireTarget(input.fire);
  if (!target) {
    return {
      status: 'invalid',
      error: `fire target "${input.fire}" is not a capability class verb (expected "class:<id>@<version>#<verb>")`,
    };
  }

  const binding = await getPotCapabilityProviderBinding(sql, {
    workspaceId: input.workspaceId,
    potSlug: input.potSlug,
    classId: target.classId,
    classVersion: target.classVersion,
  });

  if (!binding) {
    return {
      status: 'unbound',
      target,
      error:
        `capability class "${target.classRef}" has no active provider bound in pot "${input.potSlug}" — ` +
        'bind one (capability_classes:bind_provider) or uninstall the rule',
    };
  }

  const tool = binding.verbBindings?.[target.verb];
  if (typeof tool !== 'string' || !tool.trim()) {
    const bound = Object.keys(binding.verbBindings ?? {}).sort();
    return {
      status: 'unbound',
      target,
      error:
        `provider "${binding.providerPackage}@${binding.providerVersion}" is bound to "${target.classRef}" in pot ` +
        `"${input.potSlug}" but binds no tool for verb "${target.verb}"` +
        (bound.length ? ` (it binds: ${bound.join(', ')})` : ''),
    };
  }

  return {
    status: 'resolved',
    target,
    tool: tool.trim(),
    providerPackage: binding.providerPackage,
    providerVersion: binding.providerVersion,
  };
}
