/**
 * tool-contract-class-sizing-and-non-vacuous-guard-2026-09-05 P-004 — the
 * class-wide guard for `argRedirects` reachability.
 *
 * ## The defect this catches, stated by the codebase itself
 *
 * `invalidInputCorrections` runs ONLY over UNRECOGNIZED KEYS. So an
 * `argRedirects` entry whose key IS a declared argument on that same tool can
 * never fire — the schema accepts the key, validation never rejects it, and the
 * correction the author wrote is dead text. `facts/list.ts` states it verbatim
 * at the one site where it was noticed by hand:
 *
 *   "the ONE filing shape in this cluster that no `argRedirects` entry can ever
 *    reach. `scope` IS a declared key, so the rejection is an invalid ENUM
 *    VALUE, and `invalidInputCorrections` only runs over UNRECOGNIZED KEYS — a
 *    redirect authored here would never fire."
 *
 * That is a per-tool observation someone had to make while reading one file.
 * This module makes it a property of the whole catalog.
 *
 * ## Why this is a guard and not a lint
 *
 * `contract-repair-p008-scope-keys.test.ts` already asserts exactly this rule
 * ("the redirect is now a lie, delete it") — but only over the eight tools it
 * imports by hand. Every other redirect-carrying tool is unguarded, and a
 * redirect becomes dead SILENTLY: adding the key to the schema is the natural
 * repair for "callers keep passing X", and it retires the redirect without
 * touching it. Nothing fails. The redirect stays in the guidance, costing the
 * caller a correction that will never arrive.
 *
 * ## Which oracle answers "is this key accepted", and why it is this one
 *
 * `tool.inputSchema.properties`, NOT a `.shape` walk over the raw zod args.
 *
 * This is the whole reason the plan's P-002/P-003 exist. Measured at zod 4.4.3
 * (D-012): `.shape` is UNREACHABLE through preprocess, union and pipe — their
 * `_def` is `{type,in,out}` or `{type,options}` and carries neither `schema`
 * nor `innerType`. A guard reading `.shape` therefore resolves NOTHING on those
 * tools, and a per-argument assertion over them passes vacuously. That is
 * D-008's blind spot and it is real; only its stated cause (`.refine` wrapping
 * in ZodEffects) was wrong — `.refine`/`.superRefine` keep `.shape`.
 *
 * The JSON-Schema projection does NOT share that blind spot. `inputSchema` is
 * built by `flattenForOpenAi(toArgsJsonSchema(...))`, which flattens root
 * unions. Measured 2026-09-05 against the projection functions directly, with a
 * plain-object positive control: keys survive through preprocess, union,
 * discriminated union, pipe, union-under-refine and optional — 0 of 9 shapes
 * lost a key. So reading the projection is not a convenience, it is what keeps
 * this guard from inheriting the exact blind spot it was written to close.
 *
 * ## Non-vacuity (D-001 rule 2, D-007 FLOOR A)
 *
 * A scan that inspects nothing reports zero issues, which reads identically to
 * a clean catalog. So the scan reports every denominator it used, the test
 * asserts each against a shrink-only floor POST-filter, and a tool that yields
 * ZERO accepted keys is an ERROR rather than a silently-skipped row.
 *
 * FLOOR A is catalog-derived and computed here. It is deliberately NOT sized to
 * the filing population P-001 measured (346 open filings, 104 structurally
 * classifiable): per D-007 that is FLOOR B, the CLASS floor, and it belongs in
 * this header as the justification for the guard's existence — never in an
 * assertion. Pinning a tools-inspected assertion to a filings-derived count is
 * the category error D-007 was raised to stop.
 */

/** A redirect is either prose, or a structured corrective call. */
export type ArgRedirect = string | { tool: string; args?: Record<string, unknown>; note?: string };

/**
 * The minimal shape this scanner needs. Structural rather than `ProjectedTool`
 * so the test can hand it deliberately-broken synthetic tools as permanent
 * controls without mutating the shared tree (CLAUDE.md: prove a guard
 * falsifiable with a wrong implementation kept in the test file, never with an
 * in-tree mutation the git-sync sweep can commit).
 */
export interface RedirectScannableTool {
  name: string;
  /** Accepted TOP-LEVEL argument names, from the JSON-Schema projection. */
  acceptedKeys: readonly string[];
  /** Declared `guidance.argRedirects`, possibly empty. */
  redirects: Record<string, ArgRedirect>;
}

export interface RedirectDeclaration {
  tool: string;
  /** The key a caller might wrongly pass, which this redirect corrects. */
  key: string;
  form: 'prose' | 'structured';
}

export type RedirectIssueKind = 'unreachable-redirect' | 'zero-accepted-keys';

export interface RedirectIssue {
  tool: string;
  key: string | null;
  kind: RedirectIssueKind;
  detail: string;
}

export interface RedirectScan {
  /** Tools whose accepted-key set resolved — the inspected denominator. */
  toolsInspected: number;
  /** Accepted keys summed across inspected tools. Zero here means vacuous. */
  argsInspected: number;
  /** Tools carrying at least one redirect declaration. */
  toolsWithRedirects: number;
  /** Every redirect declaration found. */
  declarations: RedirectDeclaration[];
  /** Redirect declarations in structured (corrective-call) form. */
  structuredDeclarations: number;
  /** Contract violations. */
  issues: RedirectIssue[];
}

/**
 * Adapt a projected catalog entry. Returns null when there is nothing to scan —
 * no exposed MCP name, or no resolvable `properties` — so the caller can count
 * the drop rather than silently folding it into a clean result.
 *
 * `discoveryInputSchema` branches are unioned in as well: `inputSchema` relaxes
 * branch-specific requirements for strict function-calling clients, and a key
 * that survives only in the discovery schema is still a key the tool accepts.
 */
export function toRedirectScannableTool(tool: unknown): RedirectScannableTool | null {
  const t = tool as
    | {
        expose?: { mcp?: { name?: unknown } };
        inputSchema?: { properties?: unknown };
        discoveryInputSchema?: unknown;
        guidance?: { argRedirects?: unknown };
      }
    | undefined;

  const name = t?.expose?.mcp?.name;
  if (typeof name !== 'string' || name.length === 0) return null;

  const accepted = new Set<string>();
  const props = t?.inputSchema?.properties;
  if (props && typeof props === 'object') for (const k of Object.keys(props)) accepted.add(k);

  const walk = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    const n = node as Record<string, unknown>;
    const p = n.properties;
    if (p && typeof p === 'object') for (const k of Object.keys(p)) accepted.add(k);
    for (const branch of ['anyOf', 'oneOf', 'allOf'] as const) {
      const b = n[branch];
      if (Array.isArray(b)) for (const sub of b) walk(sub, depth + 1);
    }
  };
  walk(t?.discoveryInputSchema);

  if (accepted.size === 0) return null;

  const rawRedirects = t?.guidance?.argRedirects;
  const redirects: Record<string, ArgRedirect> =
    rawRedirects && typeof rawRedirects === 'object'
      ? (rawRedirects as Record<string, ArgRedirect>)
      : {};

  return { name, acceptedKeys: [...accepted], redirects };
}

/**
 * Scan tools for `argRedirects` entries that can never fire. Pure: no catalog
 * import, no I/O — so the test can run it over both the live catalog and
 * synthetic controls.
 */
export function scanArgRedirects(tools: readonly RedirectScannableTool[]): RedirectScan {
  const declarations: RedirectDeclaration[] = [];
  const issues: RedirectIssue[] = [];
  let toolsWithRedirects = 0;
  let argsInspected = 0;
  let structuredDeclarations = 0;

  for (const tool of tools) {
    const accepted = new Set(tool.acceptedKeys);
    argsInspected += accepted.size;

    // D-001 rule 2, per-tool: a tool that yielded no arguments was not
    // inspected. Reporting it as clean is the vacuous pass this guard exists to
    // make impossible, so it is an ISSUE, not a skip.
    if (accepted.size === 0) {
      issues.push({
        tool: tool.name,
        key: null,
        kind: 'zero-accepted-keys',
        detail:
          `${tool.name} yielded ZERO accepted argument keys, so every per-argument assertion over it ` +
          `passed without inspecting anything. A guard that inspected nothing must be an error, never a ` +
          `pass. Fix the projection or the adapter; do not exclude the tool to restore green.`,
      });
      continue;
    }

    const keys = Object.keys(tool.redirects);
    if (keys.length === 0) continue;
    toolsWithRedirects += 1;

    for (const key of keys) {
      const raw = tool.redirects[key];
      const form: RedirectDeclaration['form'] =
        typeof raw === 'object' && raw !== null ? 'structured' : 'prose';
      if (form === 'structured') structuredDeclarations += 1;
      declarations.push({ tool: tool.name, key, form });

      if (accepted.has(key)) {
        issues.push({
          tool: tool.name,
          key,
          kind: 'unreachable-redirect',
          detail:
            `${tool.name} declares an argRedirect for \`${key}\`, but \`${key}\` IS a declared argument on ` +
            `${tool.name}. \`invalidInputCorrections\` only runs over UNRECOGNIZED keys, so this redirect can ` +
            `never fire: the schema accepts the key and validation never rejects it. Either the key was added ` +
            `to the schema and the redirect should be deleted, or the caller's real failure is a wrong VALUE ` +
            `(an invalid enum member, say) — which no redirect can reach, and which has to be taught on the ` +
            `field's own description instead. Do NOT silence this by removing the key from the schema.`,
        });
      }
    }
  }

  return {
    toolsInspected: tools.length,
    argsInspected,
    toolsWithRedirects,
    declarations,
    structuredDeclarations,
    issues,
  };
}

/**
 * The shrink-only floor on tools carrying at least one redirect (FLOOR A ii).
 *
 * Measured 2026-09-05 over the live catalog — see the test, which re-measures
 * every run and reports the live figure in its failure message. Lanes only ever
 * ADD redirects, so a floor never fights concurrent work the way a pinned exact
 * count would; DELETING the last redirect from a tool is the regression shape a
 * scan over declarations-that-still-exist cannot otherwise see.
 *
 * Raising this after adding redirects is correct and expected. LOWERING it is
 * the thing to refuse.
 */
export const REDIRECT_TOOL_FLOOR = 26;

/**
 * The shrink-only floor on total redirect declarations (FLOOR A iii).
 *
 * Measured 2026-09-05 over the live catalog: 817 tools inspected, 4,174 accepted
 * arguments resolved, 26 tools carrying 122 declarations (57 structured, 65
 * prose). Both floors are set from THAT measurement, not from the plan's item
 * text — which is the whole point of P-001/D-007: FLOOR A is catalog-derived.
 *
 * Note the counts are one tool and one declaration below the first live scan
 * (27/123). The difference is the single violation this guard found on its first
 * run — `capability:launch-agent.carry`, removed in the same change — not drift.
 */
export const REDIRECT_DECLARATION_FLOOR = 122;

/** Render issues for a test failure message, grouped so the fix is obvious. */
export function formatRedirectIssues(issues: readonly RedirectIssue[]): string {
  return issues
    .map((i) => `  [${i.kind}] ${i.tool}${i.key ? `.${i.key}` : ''}\n      ${i.detail}`)
    .join('\n');
}
