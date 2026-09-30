/**
 * tool-contract-repair-2026-09-05 P-009 — the CLASS-WIDE regression guard for
 * the argument-contract (`invalid_args`) class.
 *
 * ## Why this exists, and why it is not a list
 *
 * The class reached 71 filings because each repair is one optional field plus
 * one `??` chain: cheap to add, invisible to drop. The plan's per-family lanes
 * (P-001..P-008) each pin THEIR OWN repairs with a bespoke test — that is the
 * right place for "this exact alias still parses". What no per-family test can
 * see is the other 800-odd tools nobody wrote a bespoke test for, and the
 * cross-cutting shapes below that make an alias *documented but unusable*.
 *
 * So this module deliberately holds NO list of repairs. It DERIVES the alias
 * population from the live projected catalog every run, which is what keeps it
 * correct while five lanes land new aliases in parallel — a committed manifest
 * would need regenerating every few minutes and would fight them.
 *
 * ## Why the target must be backticked
 *
 * Measured 2026-09-05 over 854 tools: a loose `/alias (for|of) (\w+)/` regex
 * matches 68 field descriptions, of which 3 capture an ENGLISH WORD out of
 * prose like "alias for the persisted measurement" — `persisted`, `optional`,
 * `common`. Asserting on those would red a SHARED gate for a wording choice.
 * Requiring the target in backticks selects 24 declarations across 15 tools
 * with zero false positives, because a backticked token in this codebase is an
 * identifier by convention. The loose matches are still COUNTED and surfaced in
 * failure output, but never asserted on.
 *
 * ## What is actually asserted (see the test beside this file)
 *
 * 1. `dangling-canonical` — the alias names a canonical that is not a sibling
 *    field. This is what a rename leaves behind.
 * 2. `canonical-required`  — the canonical is in `required`, so a caller who
 *    passes ONLY the alias still fails validation. A documented alias that
 *    cannot be used is the defect this class is made of.
 * 3. `alias-required`      — the alias itself is required, which inverts the
 *    relationship: the "compatibility" spelling becomes mandatory.
 *
 * Removal is invisible to any scan that iterates over fields which still
 * exist, so it is caught by the shrink-only floor instead
 * (`STRICT_ALIAS_DECLARATION_FLOOR`) rather than by a rule here.
 */

/**
 * The minimal shape this scanner needs. Deliberately structural rather than
 * `ProjectedTool`, so the test can hand it deliberately-broken synthetic tools
 * as permanent controls without mutating the shared tree (CLAUDE.md: prove a
 * guard falsifiable with a wrong implementation kept in the test file, never
 * with an in-tree mutation the git-sync sweep can commit).
 */
export interface AliasScannableTool {
  name: string;
  properties: Record<string, { description?: unknown } | undefined>;
  required?: readonly string[];
}

export interface AliasDeclaration {
  tool: string;
  /** The compatibility spelling a caller may pass. */
  field: string;
  /** The canonical field it defers to. */
  canonical: string;
}

export type AliasIssueKind = 'dangling-canonical' | 'canonical-required' | 'alias-required';

export interface AliasIssue extends AliasDeclaration {
  kind: AliasIssueKind;
  detail: string;
}

export interface AliasScan {
  /** Backticked-target declarations — the asserted tier. */
  declarations: AliasDeclaration[];
  /** Contract violations among those declarations. */
  issues: AliasIssue[];
  /** Distinct tools carrying at least one asserted declaration. */
  toolsWithAliases: number;
  /**
   * Field descriptions that say "alias" but whose target is not a backticked
   * identifier. Counted for visibility only — NEVER asserted on, because the
   * measurement above showed this tier contains ordinary prose.
   */
  looseMentions: number;
}

/** `alias for \`x\`` / `aliases of \`x\`` — the target MUST be backticked. */
const STRICT_ALIAS_RE = /\balias(?:es)?\s+(?:for|of)\s+`([A-Za-z_][A-Za-z0-9_]*)`/i;

/**
 * The shrink-only floor on asserted alias declarations.
 *
 * Measured 2026-09-05 against the live 854-tool catalog: 24 declarations across
 * 15 tools, 24/24 resolving. Lanes only ever ADD aliases, so a floor never
 * fights concurrent work the way a pinned exact count would — but DELETING a
 * repaired alias drops the count below the floor and fails loudly, which is the
 * one regression shape a field-iterating scan cannot otherwise see.
 *
 * Raising this after adding aliases is correct and expected. LOWERING it is the
 * thing to refuse: that is the class silently returning, which is exactly how it
 * reached 71 filings.
 */
export const STRICT_ALIAS_DECLARATION_FLOOR = 24;

/** Adapt a projected catalog entry; returns null when there is nothing to scan. */
export function toAliasScannableTool(tool: unknown): AliasScannableTool | null {
  const t = tool as
    | { expose?: { mcp?: { name?: unknown } }; inputSchema?: { properties?: unknown; required?: unknown } }
    | undefined;
  const name = t?.expose?.mcp?.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const properties = t?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object') return null;
  const required = t?.inputSchema?.required;
  return {
    name,
    properties: properties as AliasScannableTool['properties'],
    required: Array.isArray(required) ? (required.filter((r) => typeof r === 'string') as string[]) : undefined,
  };
}

/**
 * Scan tools for declared argument aliases and the contract violations among
 * them. Pure: no catalog import, no I/O — so the test can run it over both the
 * live catalog and synthetic controls.
 */
export function scanToolAliases(tools: readonly AliasScannableTool[]): AliasScan {
  const declarations: AliasDeclaration[] = [];
  const issues: AliasIssue[] = [];
  const toolNames = new Set<string>();
  let looseMentions = 0;

  for (const tool of tools) {
    const fieldNames = new Set(Object.keys(tool.properties));
    const required = new Set(tool.required ?? []);

    for (const [field, def] of Object.entries(tool.properties)) {
      const description = def?.description;
      if (typeof description !== 'string' || !/alias/i.test(description)) continue;

      const match = STRICT_ALIAS_RE.exec(description);
      if (!match) {
        looseMentions++;
        continue;
      }

      const canonical = match[1]!;
      const declaration: AliasDeclaration = { tool: tool.name, field, canonical };
      declarations.push(declaration);
      toolNames.add(tool.name);

      if (!fieldNames.has(canonical)) {
        issues.push({
          ...declaration,
          kind: 'dangling-canonical',
          detail:
            `\`${field}\` is documented as an alias for \`${canonical}\`, but \`${canonical}\` is not a field on ` +
            `${tool.name}. A rename left the alias pointing at nothing; callers reading the description will pass ` +
            `an argument whose canonical no longer exists.`,
        });
        continue;
      }

      if (required.has(canonical)) {
        issues.push({
          ...declaration,
          kind: 'canonical-required',
          detail:
            `\`${field}\` is documented as an alias for \`${canonical}\`, but \`${canonical}\` is REQUIRED on ` +
            `${tool.name} — so a caller who passes only \`${field}\` still fails validation. The alias is ` +
            `documented but unusable, which is the defect this class is made of.`,
        });
      }

      if (required.has(field)) {
        issues.push({
          ...declaration,
          kind: 'alias-required',
          detail:
            `\`${field}\` is REQUIRED on ${tool.name} while also being documented as a compatibility alias for ` +
            `\`${canonical}\`. That inverts the relationship: the compatibility spelling has become mandatory.`,
        });
      }
    }
  }

  return { declarations, issues, toolsWithAliases: toolNames.size, looseMentions };
}

/** Render issues for a test failure message, grouped so the fix is obvious. */
export function formatAliasIssues(issues: readonly AliasIssue[]): string {
  return issues.map((i) => `  [${i.kind}] ${i.tool}.${i.field} -> \`${i.canonical}\`\n      ${i.detail}`).join('\n');
}
