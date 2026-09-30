/**
 * SU-TIER ROLES — a role that runs as a FULL su engineer session plus a few
 * role-specific lines, rather than as a role-scoped session (EI-996).
 *
 * Owner ask (2026-06-17), verbatim: planners should "be full su agents and get
 * the full su prompt, but just a few lines added about their planner role."
 *
 * ── THE SHAPE, AND WHY IT IS A ROLE NAME ─────────────────────────────────────
 * The wire carries `su_role: 'planner'` — a NAME, validated against the
 * `SU_TIER_ROLES` allow-list, whose addendum text is resolved SERVER-SIDE from a
 * prompt source. It deliberately does NOT carry the addendum prose itself.
 *
 * That is a security boundary, not a style preference: routing a role through
 * the su path grants it the SUPERUSER MCP tier, so this request mints a
 * superuser-tier system prompt. A free-text `role_addendum` field would let any
 * loopback caller append arbitrary instructions to a superuser prompt — an
 * open prompt-injection surface on the most privileged launch path we have. A
 * closed allow-list of names has no such degree of freedom: the worst a caller
 * can do is select a different vetted, in-repo addendum.
 *
 * (`buildSuLaunchSpec` still takes `roleAddendum` as TEXT — that is an internal
 * builder seam reached only after this resolution, not a wire field.)
 *
 * ── WHERE THE TEXT LIVES ─────────────────────────────────────────────────────
 * The planner role is a compatibility selector for the built-in
 * `su.specialist-planner` identity's practice document. The role allow-list
 * still controls superuser-tier admission; it does not author a second prompt.
 * An explicit operatorAppRoot keeps the old file-root resolver available to
 * callers testing a legacy prompt layout.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { builtinBlueprintPath } from '@papercusp/orchestrator/blueprint';

import {
  operatorAppRootForPrompts,
  promptsDirCandidates,
} from './desktop-install/papercusp-files';
// The ONE definition of the role list, shared with psu-launcher.mjs (bare node,
// cannot import TS) — see su-tier-roles.mjs. Importing it here rather than
// re-declaring it is what makes launcher/server divergence STRUCTURALLY
// impossible instead of merely detectable.
import {
  SU_TIER_ROLES,
  isSuTierRole as isSuTierRoleUntyped,
  suRoleAddendumFileName,
} from './su-tier-roles.mjs';

export { SU_TIER_ROLES, suRoleAddendumFileName };

/**
 * Is this role name one that launches on the su tier?
 *
 * Deliberately a plain boolean, NOT a `role is SuTierRole` type-predicate: the
 * shared .mjs types the list as `readonly string[]`, so a predicate would narrow
 * `string` against `string` and leave the FAILING branch as `never` — which is
 * how the first cut of this broke bootstrap-su's own 400 message (it could no
 * longer call `.slice()` on the rejected value). The allow-list is a RUNTIME
 * security check; there is nothing for the type system to add here.
 */
export function isSuTierRole(role: string | null | undefined): boolean {
  return isSuTierRoleUntyped(role);
}

/**
 * Resolve a su-tier role's addendum TEXT from its prompt source.
 *
 * Returns null for an unknown role or a missing/blank file — a missing addendum
 * degrades the launch to a plain su session (full playbook, no role lines),
 * which is strictly better than failing the launch outright: the role still
 * gets the su tier the owner asked for.
 */
export function resolveSuRoleAddendum(
  role: string | null | undefined,
  opts: { operatorAppRoot?: string } = {},
): string | null {
  if (!role || !isSuTierRole(role)) return null;
  if (role === 'planner' && !opts.operatorAppRoot) {
    const source = path.join(path.dirname(builtinBlueprintPath('su.specialist-planner')), 'prompts', 'practice.md');
    try {
      const text = readFileSync(source, 'utf8').trim();
      return text || null;
    } catch {
      return null;
    }
  }
  const explicitRoot = !!opts.operatorAppRoot;
  const root = opts.operatorAppRoot ?? operatorAppRootForPrompts();
  const fileName = suRoleAddendumFileName(role);
  for (const dir of promptsDirCandidates(root, explicitRoot)) {
    const candidate = path.join(dir, fileName);
    try {
      if (!existsSync(candidate)) continue;
      const text = readFileSync(candidate, 'utf8').trim();
      if (text) return text;
    } catch {
      /* unreadable candidate → try the next root */
    }
  }
  return null;
}
