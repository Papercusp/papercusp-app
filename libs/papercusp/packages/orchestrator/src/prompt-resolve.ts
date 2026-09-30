/**
 * Prompt-file resolution for `invoke <role>`.
 *
 * blueprint-role-bundling-2026-06-15 — K-1 (the keystone): a role's prompt
 * resolves by walking the blueprint **extends-chain**, then the base role library:
 *
 *   1. blueprints/<blueprintId>/prompts/<role>.md        (the blueprint's own override)
 *   2. blueprints/<ancestor>/prompts/<role>.md           (each extends parent, …)
 *   3. blueprints/base/prompts/<role>.md                 (the shared role library — ALWAYS consulted)
 *
 * Returns the first path that exists, or null if none do.
 *
 * `base` is ALWAYS a candidate (step 3) — even when no `blueprintId` is supplied —
 * because the main shared assembler (`assembleRolePrompt`) passes none, yet every
 * concrete blueprint `extends: base`, so base is the universal role library.
 *
 * Phase 5 (D-012, option A): the legacy global `prompts/` tiers — the phase/dept
 * override axis (`prompts/$phase/...`, `prompts/department/...`) and the bare global
 * default (`prompts/$role.md`) — were DELETED. The `staging` phase-variant (what
 * `resolvePhase` defaults to, i.e. what the fleet actually ran) was collapsed into
 * `base` as canonical, so resolution at the live default is unchanged; the
 * rarely-used testing/production/department variants collapsed to it. `ctx.phase` /
 * `ctx.dept` are no longer consulted (there is no phase-axis prompt layer anymore).
 *
 * Role aliasing: a map of requested role names → canonical role names. When code
 * references the mapped name we walk the canonical name's candidates FIRST, then
 * the requested name's. Carries the pot-rename SLICE-2 (EXPAND) aliases — the new
 * role ids resolve their predecessors' still-named persona files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { promptHarnessRoot } from '@papercusp/harness/paths';
import { canonicalBlueprintId } from './blueprint-aliases.js';
import { composeStack, type StackDocument } from './blueprint/render-stack.js';

export interface PromptResolveContext {
  /** Absolute path to the harness install (containing prompts/ + blueprints/). */
  harnessDir: string;
  /** Resolved phase, e.g. "staging" / "department". May be empty. */
  phase: string;
  /** Department slug from .papercusp/config.json `dept`, or empty. */
  dept: string;
  /**
   * The blueprint a spawned role belongs to (e.g. 'vote', 'implement', 'coding').
   * Its own prompts dir is tried FIRST, then its `extends` ancestors, then `base`.
   * Set from the autonomous spawn's `BLUEPRINT_ID=<id>` extra (program + launched
   * blueprints) or threaded by a caller. Absent for a plain pipeline spawn —
   * which still resolves via `base` (the universal library).
   */
  blueprintId?: string;
  /**
   * The pre-resolved extends-chain for `blueprintId`, leaf-first, ending at `base`
   * (e.g. ['implement','single-agent','base']). When omitted, the resolve
   * functions compute it from the blueprint.yaml `extends` headers under
   * `harnessDir` (`resolveBlueprintChain`). Supplied directly by tests and by a
   * marketplace/installed-blueprint resolver (Phase 4). The pure
   * `promptCandidates` consults it as-is; when neither it nor `blueprintId` is set,
   * `base` alone is the chain.
   */
  extendsChain?: string[];
  /**
   * Tier-aware resolution (domain-generic-hive-architecture-2026-06-18 P-014/D-006):
   * ADDITIONAL blueprint roots searched BEFORE `harnessDir`, most-specific tier first —
   * the per-hive LOCAL tier (`<hive>/.papercusp/blueprints`) then the INSTALLED/Comb tier
   * (`~/.papercusp/blueprints`). `harnessDir` is always the final (built-in) tier. Each
   * root holds a `blueprints/<id>/` subtree exactly like `harnessDir`, so a local/installed
   * blueprint contributes both its `blueprint.yaml` (`extends`) AND its prompt files.
   *
   * Resolution keeps blueprint SPECIFICITY as the primary axis (leaf-first across the
   * extends-chain — unchanged), with TIER as the tiebreaker WITHIN one blueprint id: a
   * leaf's prompt in ANY tier still beats an ancestor's, and within one id the local tier
   * wins over installed wins over built-in. Absent/empty ⇒ only `harnessDir` is consulted,
   * byte-identical to before this seam existed.
   */
  blueprintRoots?: string[];
}

/**
 * Requested role name → canonical role name whose persona files we resolve.
 * `promptCandidates` reads `ROLE_ALIASES[requestedRole]` and walks the canonical
 * name's candidates first, then the requested name's — so key = NEW id, value = the
 * OLD (still-named) role whose prompt files exist.
 *
 * pot-rename SLICE-2 (EXPAND): the five new canonical role ids are additive aliases
 * onto their predecessors' still-named persona files, so a `role=<new>` launch
 * resolves the existing persona until the files are renamed in a later slice.
 * (`blender`→`scout` has no persona yet — scout ships none in base or any blueprint;
 * that persona lands with the rest of the rename.)
 */
export const ROLE_ALIASES: Record<string, string> = {
  // Empty since the pot-rename S2 role contract (s2-role-contract.sql backfilled
  // every stored old-id row, so all roles resolve their persona files natively).
  // The seam stays for the next rename: key = requested role id, value = the
  // role whose persona files exist.
};

/** The universal role library — every `extends` chain terminates here. */
const BASE_BLUEPRINT_ID = 'base';
/** The coding hive uses the shared engineering identity without inheriting it. */
const CODING_DOMAIN_IDENTITY_ID = 'papercusp-engineer';

/**
 * The ordered blueprint roots a context resolves against: the tier-aware
 * `blueprintRoots` (local → installed) first, then `harnessDir` (built-in) last.
 * Empty/absent `blueprintRoots` ⇒ just `[harnessDir]` (the pre-tier behavior).
 */
function rootsFor(ctx: PromptResolveContext): string[] {
  // The built-in tier is resolved through `promptHarnessRoot` so a
  // PAPERCUSP_PROMPT_ROOT / PAPERCUSP_INTEGRATION_ROOT override redirects PROMPT
  // resolution to the integration/staging tree without a code-release promotion
  // (decouple-agent-prompts-from-release-gate D-001). Unset ⇒ ctx.harnessDir,
  // byte-identical to before. The per-hive LOCAL/INSTALLED `blueprintRoots` tiers
  // are NOT redirected — they are real running-system customizations.
  const builtin = promptHarnessRoot(ctx.harnessDir);
  return ctx.blueprintRoots && ctx.blueprintRoots.length > 0
    ? [...ctx.blueprintRoots, builtin]
    : [builtin];
}

/**
 * Read a blueprint's `extends` header → parent id(s), searching `roots` in order and
 * taking the FIRST that has a `blueprints/<id>/blueprint.yaml` (so a local/installed
 * blueprint's own `extends` is honored). [] when no root has it / it's unreadable.
 */
function blueprintExtends(roots: readonly string[], id: string): string[] {
  for (const root of roots) {
    const p = join(root, 'blueprints', canonicalBlueprintId(id), 'blueprint.yaml');
    if (!existsSync(p)) continue;
    try {
      const parsed = parseYaml(readFileSync(p, 'utf8')) as { extends?: unknown } | null;
      const ext = parsed && typeof parsed === 'object' ? parsed.extends : undefined;
      if (ext == null) return [];
      return Array.isArray(ext) ? ext.map(String) : [String(ext)];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Resolve a blueprint's `extends`-chain into an ordered, deduped, leaf-first id
 * list ending at `base` — by reading the blueprint.yaml `extends` headers under
 * `harnessDir` (the same headers the blueprint loader merges). Cycle-guarded; a
 * missing/unreadable blueprint.yaml just stops that branch. `base` is always the
 * final element even if a blueprint doesn't declare it (every blueprint inherits
 * the universal library).
 *
 * e.g. resolveBlueprintChain(h, 'implement') → ['implement','single-agent','base'];
 *      resolveBlueprintChain(h, 'coding')    → ['coding','base'];
 *      resolveBlueprintChain(h, 'base')      → ['base'].
 */
export function resolveBlueprintChain(harnessDir: string, blueprintId: string): string[] {
  return resolveBlueprintChainRoots([harnessDir], blueprintId);
}

/**
 * Tier-aware variant: resolve the `extends`-chain reading each blueprint's
 * `blueprint.yaml` from the first root (local → installed → built-in) that has it, so a
 * local/installed blueprint that `extends` a built-in one chains correctly across tiers.
 * `resolveBlueprintChain` is the single-root (built-in only) special case.
 */
export function resolveBlueprintChainRoots(roots: readonly string[], blueprintId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    chain.push(id);
    for (const parent of blueprintExtends(roots, id)) walk(parent);
  };
  walk(blueprintId);
  if (!chain.includes(BASE_BLUEPRINT_ID)) chain.push(BASE_BLUEPRINT_ID);
  return chain;
}

/** The blueprint-chain a context resolves against (leaf-first, base-terminated). */
function chainForCtx(ctx: PromptResolveContext): string[] {
  const base = (chain: string[]): string[] =>
    chain.includes(BASE_BLUEPRINT_ID) ? chain : [...chain, BASE_BLUEPRINT_ID];
  if (ctx.extendsChain && ctx.extendsChain.length > 0) return base(ctx.extendsChain);
  if (ctx.blueprintId) return base([ctx.blueprintId]);
  return [BASE_BLUEPRINT_ID];
}

/**
 * Resolve the replacement-prompt chain, including the coding hive's domain
 * identity as a selective attachment rather than a blueprint inheritance edge.
 *
 * `coding` is the hive blueprint and intentionally extends only `base`; adding
 * `papercusp-engineer` to that YAML would make the identity part of the merged
 * blueprint and would also leak it through `work`, which extends `coding`.
 * The attachment is therefore applied only when `coding` (or its legacy `hive`
 * alias) is the leaf being rendered. A real leaf identity already present in a
 * loader-resolved chain is left untouched.
 */
function replacementPromptChainForCtx(ctx: PromptResolveContext): string[] {
  const chain = chainForCtx(withResolvedChain(ctx));
  const leafId = chain[0];
  if (
    !leafId ||
    canonicalBlueprintId(leafId) !== 'coding' ||
    chain.some((id) => canonicalBlueprintId(id) === CODING_DOMAIN_IDENTITY_ID)
  ) {
    return chain;
  }

  const baseIndex = chain.indexOf(BASE_BLUEPRINT_ID);
  if (baseIndex < 0) return [...chain, CODING_DOMAIN_IDENTITY_ID];
  return [
    ...chain.slice(0, baseIndex),
    CODING_DOMAIN_IDENTITY_ID,
    ...chain.slice(baseIndex),
  ];
}

function candidatesFor(ctx: PromptResolveContext, role: string): string[] {
  const candidates: string[] = [];
  const chain = chainForCtx(ctx);
  const roots = rootsFor(ctx);

  // ── 1. The blueprint's OWN override, then its non-base `extends` ancestors
  //    (e.g. implement → single-agent). Most specific. `base` is held back to
  //    step 2 (it is the universal DEFAULT, not a specialization). Blueprint
  //    SPECIFICITY is the primary axis (leaf-first); TIER (local → installed →
  //    built-in) is the tiebreaker WITHIN one id — so a leaf's built-in prompt
  //    still beats an ancestor's local prompt, and a local override of one id
  //    beats its built-in (P-014). Single-root ctx ⇒ identical to before.
  for (const id of chain) {
    if (id === BASE_BLUEPRINT_ID) continue;
    for (const root of roots) {
      candidates.push(join(root, 'blueprints', canonicalBlueprintId(id), 'prompts', `${role}.md`));
    }
  }

  // ── 2. `base` — the universal role library (every chain terminates here).
  //    ALWAYS consulted, even with no blueprintId. The legacy global `prompts/`
  //    tiers (the phase/dept override axis + the bare default) were DELETED in
  //    Phase 5 (blueprint-role-bundling D-012, option A): the `staging`
  //    phase-variant — which `resolvePhase` defaults to, i.e. what the fleet ran —
  //    was collapsed into `base` as canonical, so resolution at the live default
  //    is unchanged; the rarely-used testing/production variants collapse to it.
  //    `ctx.phase`/`ctx.dept` are no longer consulted (no phase-axis personas).
  //    Tier-aware: a local/installed `base` override is consulted before built-in.
  if (chain.includes(BASE_BLUEPRINT_ID)) {
    for (const root of roots) {
      candidates.push(join(root, 'blueprints', BASE_BLUEPRINT_ID, 'prompts', `${role}.md`));
    }
  }

  return candidates;
}

/** Build the candidate path list (most specific first). Useful for testing.
 *  PURE: consults `ctx.extendsChain`/`ctx.blueprintId` as given (does NOT read
 *  blueprint.yaml). The resolve functions populate `extendsChain` first. */
export function promptCandidates(
  ctx: PromptResolveContext,
  role: string,
): string[] {
  // If the requested role has a canonical alias, walk the canonical name's
  // candidates first, then fall through to the legacy name's candidates.
  const canonical = ROLE_ALIASES[role];
  const all = canonical
    ? [...candidatesFor(ctx, canonical), ...candidatesFor(ctx, role)]
    : candidatesFor(ctx, role);

  // Dedupe while preserving order.
  return Array.from(new Set(all));
}

/**
 * Ensure `ctx.extendsChain` is populated when a `blueprintId` is set — reading the
 * blueprint.yaml `extends` headers so multi-level chains
 * (implement→single-agent→base) resolve their intermediate ancestors' overrides.
 * A no-op when the chain is already supplied (tests, marketplace resolver) or no
 * blueprintId is given (the pure `[base]` chain suffices).
 */
function withResolvedChain(ctx: PromptResolveContext): PromptResolveContext {
  if (ctx.extendsChain || !ctx.blueprintId) return ctx;
  return { ...ctx, extendsChain: resolveBlueprintChainRoots(rootsFor(ctx), ctx.blueprintId) };
}

/**
 * Walk the candidate list, returning the first existing path, or null if none
 * exist — caller decides how to surface that (usually: warn + fall back).
 */
export function resolvePromptFile(
  ctx: PromptResolveContext,
  role: string,
): string | null {
  for (const candidate of promptCandidates(withResolvedChain(ctx), role)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The prompt files that COMPOSE a role's prompt, least- to most-specific: the
 * universal generic-role prefix layer first (the "Base Worker/Validator/…"
 * persona — universal rules + the G3 untrusted-peer-content rule), then the
 * resolved concrete prompt (`resolvePromptFile` — authoritative, per the prompts
 * README's "later sections override earlier ones"). Callers join the files'
 * contents with `\n\n---\n\n`. The prefix is prepended to whatever concrete
 * resolves (the base default OR a blueprint/phase override), and only when it is
 * DISTINCT from that concrete (a base-only role resolves to a single file).
 *
 * The generic prefix lives at blueprints/base/prompts/<role>.base.md (the base
 * blueprint — Phase 2 home; the legacy global prompts/base/<role>.md was deleted in
 * Phase 5). Only ~5 roles (worker/validator/documenter/orchestrator/summarizer) HAVE
 * a generic prefix; the rest resolve to a single self-contained file.
 *
 * Returns [] when the role has no prompt at all.
 */
export function resolvePromptFiles(
  ctx: PromptResolveContext,
  role: string,
): string[] {
  const main = resolvePromptFile(ctx, role);
  const canonical = ROLE_ALIASES[role] ?? role;
  // Tier-aware: a local/installed `base` may supply the generic prefix; built-in last.
  const prefix = rootsFor(ctx)
    .map((root) => join(root, 'blueprints', BASE_BLUEPRINT_ID, 'prompts', `${canonical}.base.md`))
    .find((p) => existsSync(p));
  const sections: string[] = [];
  if (prefix && prefix !== main) sections.push(prefix);
  if (main) sections.push(main);
  return sections;
}

/**
 * domain-generic-agent-personas-2026-06-17 P-009/P-010/P-013 — compose the replacement
 * SYSTEM prompt for a spawn: the neutral base preamble
 * (`blueprints/base/prompts/agent-base-preamble.md`, P-009) + the MOST-SPECIFIC blueprint
 * overlay (`blueprints/<id>/prompts/agent-base-overlay.md`, walking the extends-chain
 * leaf-first; `base` excluded — P-010 authors the `coding` overlay), so a coding hive keeps
 * its SWE framing while a generic hive gets only the neutral base.
 *
 * The agent's ROLE persona + task ride the spawn's stdin/user message UNCHANGED (resolved by
 * `resolvePromptFiles` → `buildPrompt`); this replaces only the SYSTEM prompt. Returns `null`
 * when the base preamble file is absent — the caller cannot replace a system prompt it
 * cannot resolve and leaves the backend default in place. PURE / read-only (testable).
 */
export function resolveReplacementSystemPrompt(ctx: PromptResolveContext): string | null {
  const docs = resolveReplacementSystemPromptStack(ctx);
  if (!docs) return null;
  // identities-v1 P-003 / D-018 §1: the spawn tier IS the slot stack [domain(overlay), kernel(preamble)]
  // rendered by the seal — the overlay above the precedence statement, the kernel base text LAST.
  return composeStack(docs).text;
}

/**
 * The spawn tier's stack, unrendered: the `domain` leaf (`agent-base-overlay.md`,
 * the FIRST hit walking the extends chain leaf-first — the exclusive-slot
 * resolution, D-018 §1) when one exists, and the kernel base text
 * (`agent-base-preamble.md`, tier-aware, built-in last). `null` when the preamble
 * is absent in every tier — the caller leaves the Claude default in place.
 */
export function resolveReplacementSystemPromptStack(ctx: PromptResolveContext): StackDocument[] | null {
  const roots = rootsFor(ctx);
  const basePreamble = roots
    .map((root) => join(root, 'blueprints', BASE_BLUEPRINT_ID, 'prompts', 'agent-base-preamble.md'))
    .find((p) => existsSync(p));
  if (!basePreamble) return null;
  const docs: StackDocument[] = [];
  // The MOST-SPECIFIC blueprint overlay, leaf-first; within one id, local → installed →
  // built-in. The first overlay found across the chain wins (single, not cumulative).
  outer: for (const id of replacementPromptChainForCtx(ctx)) {
    if (id === BASE_BLUEPRINT_ID) continue;
    for (const root of roots) {
      const overlay = join(root, 'blueprints', canonicalBlueprintId(id), 'prompts', 'agent-base-overlay.md');
      if (existsSync(overlay)) {
        docs.push({ id: canonicalBlueprintId(id), layer: 'domain', slot: 'domain', text: readFileSync(overlay, 'utf8'), sourcePath: overlay });
        break outer;
      }
    }
  }
  docs.push({ id: 'agent-base-preamble', layer: 'kernel', text: readFileSync(basePreamble, 'utf8'), sourcePath: basePreamble });
  return docs;
}
