/**
 * template.yaml schema — the machine-readable half of ONE template
 * (plan app-templates-2026-07-04 P-005; anatomy in
 * agent-insights/templates-system-design).
 *
 * A template = components (version-pinned catalog refs) + guidance (GUIDE.md)
 * + checks (the acceptance suite). template.yaml says *what exists*; GUIDE.md
 * says *how to think about composing it*. This module is what the Cupboard
 * listing and the materializer read.
 *
 * Validation is PURE + zero-dep, exactly like component-manifest.ts: the
 * consumer parses the YAML with whatever loader it already has and passes the
 * resulting object here — this lib never takes a yaml runtime dep.
 * `validateTemplateManifest` returns EVERY problem (never throws);
 * `parseTemplateManifest` throws one Error listing them all.
 *
 * Cross-validation against the component catalog
 * (`validateTemplateAgainstCatalog`) keeps refs honest: every component ref
 * must resolve to a catalog id, and its version pin must match the catalog's
 * current version (the catalog holds exactly one living version per
 * component, so a mismatched pin is rot, not history — the anti-rot gym
 * P-009 re-runs this).
 *
 * Multi-template composition SEMANTICS (how `scope`/`composesWith` stack, the
 * union-of-checks rule) land in P-014 — this module only carries the fields.
 */
import type { ComponentManifest } from "./component-manifest.js";

/** D-006: a whole-app scaffold vs a capability composed INTO an app. */
export type TemplateScope = "app" | "aspect";

/**
 * The BROWSE axis (owner directive 2026-07-04 / P-015) — orthogonal to
 * `scope` (the STRUCTURAL axis): what shelf the template sits on in the
 * Cupboard Templates section. A flat validated enum so a typo fails the
 * manifest, not the storefront.
 */
export const TEMPLATE_CATEGORIES = [
  "app", // whole-app scaffolds (scope: app)
  "agentic", // hives / agent-orchestration aspects
  "shell", // desktop chassis / host aspects
  "data", // data layer + data sync aspects
  "search", // search/rerank aspects
  "ui", // UI library aspects
  "release", // release pipeline aspects
  "design", // brand/design adoption aspects
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * A HARD, version-pinned reference to another OFFICIAL template (owner
 * directive 2026-07-04 / P-015): `requires` is a composition DEPENDENCY —
 * installing/composing this template pulls the referenced template in, and
 * the checks union covers the whole requires-closure. Contrast `composesWith`,
 * which stays a soft design-affinity declaration (no edge, no pin).
 */
export interface TemplateRequireRef {
  /** The required template's id (kebab-case). */
  id: string;
  /** Exact semver pin; must match the required template's current version. */
  version: string;
}

/** A version-pinned reference to a catalog component — never a vendored copy. */
export interface TemplateComponentRef {
  /** Component catalog id (kebab-case). */
  id: string;
  /** Exact semver pin; must match the catalog's current version. */
  version: string;
}

/**
 * One answer to a SELECTING decision point, and the templates that join the
 * composition when it is chosen (plan unified-app-template-2026-08-23 D-001).
 */
export interface TemplateDecisionOption {
  /** kebab-case answer token, unique within the decision point (`web`). */
  value: string;
  /** One line on what choosing this answer means; GUIDE.md expands on it. */
  summary?: string;
  /**
   * The templates that join the composition for this answer — version-pinned
   * exactly like `requires`. MAY be empty, and an empty option is load-bearing:
   * it is the explicit "none" answer, and its PRESENCE is what makes the axis
   * optional (see `composeTemplates`).
   */
  templates: TemplateRequireRef[];
}

/**
 * The selector half of a decision point that does not merely ASK but CHOOSES
 * (D-001). `requires` cannot express "web chassis OR desktop chassis": it is a
 * static hard pin, walked unconditionally by `resolveRequiresClosure` and
 * enforced by `composeTemplates`, and both run with NO answers in hand. So the
 * ONE root that serves both targets names the alternatives HERE, on the
 * decision point that asks the question, and `composeTemplates` enforces the
 * choice structurally — no answers needed, no conditional edges.
 */
export interface TemplateDecisionSelect {
  /**
   * `one` (default) — exactly one answer. `one-or-more` — answers combine,
   * which is what makes a dual-target (`web` + `desktop`) app expressible.
   */
  arity?: "one" | "one-or-more";
  /** The answers. Fewer than two is not a choice. */
  options: TemplateDecisionOption[];
}

/** A declared decision point — where agent judgment is explicitly invited. */
export interface TemplateDecisionPoint {
  /** kebab-case id, unique within the template (`seam-work-item-kind`). */
  id: string;
  /** The question the building agent must answer; GUIDE.md expands on it. */
  prompt: string;
  /**
   * OPTIONAL: makes this decision point SELECTING — its answer picks templates
   * into the composition (D-001). Absent (the common case) it is a pure
   * judgment prompt that composes nothing.
   */
  selects?: TemplateDecisionSelect;
}

/** The decision points that SELECT templates, in declaration order (D-001). */
export function selectingDecisionPoints(
  manifest: TemplateManifest,
): (TemplateDecisionPoint & { selects: TemplateDecisionSelect })[] {
  return manifest.decisionPoints.filter(
    (d): d is TemplateDecisionPoint & { selects: TemplateDecisionSelect } => d.selects !== undefined,
  );
}

/**
 * Whether a selecting axis is OPTIONAL — i.e. it ships an explicit empty
 * ("none") option, so a composition satisfying no option is legal. The single
 * place that rule is stated; `composeTemplates` and `resolveSelection` both
 * read it here rather than re-deriving `templates.length === 0`.
 */
export function isOptionalSelect(select: TemplateDecisionSelect): boolean {
  return select.options.some((o) => o.templates.length === 0);
}

/** The `enforcedBy` sentinel for a MUST no check enforces (visible, lintable debt). */
export const MUST_PROSE_ONLY = "prose-only";

/**
 * A structured MUST invariant (template-prompt-hardening-2026-07-05 P-002).
 * GUIDEs carry numbered MUST sections; historically their mapping onto the
 * checks was informal, so unenforced MUSTs were only discovered per build
 * round (the round-2 GUIDE-gap items). Declaring each MUST here with its
 * enforcing check makes the enforcement gap a queryable fact: `enforcedBy`
 * must resolve to a declared check id, or be the literal "prose-only" —
 * and `unenforcedMusts()` lists the debt.
 */
export interface TemplateMust {
  /** kebab-case id, unique within the template (`thin-shell`). */
  id: string;
  /** One-sentence statement of the invariant; GUIDE.md expands on it. */
  rule: string;
  /** The check id (within this template) that enforces it, or "prose-only". */
  enforcedBy: string;
}

/** One app-parameterized acceptance check shipped in checks/. */
export interface TemplateCheck {
  /** kebab-case id, unique within the template (`seam-round-trip`). */
  id: string;
  /** Template-relative entry point (a checks/ file or command). */
  run: string;
  /** One-line statement of what green means. */
  summary?: string;
}

export interface TemplateManifest {
  /** kebab-case template id, unique across the template set. */
  id: string;
  /** semver of the template itself (`0.1.0`). */
  version: string;
  /** app (whole-app scaffold) | aspect (composed into an app) — D-006. */
  scope: TemplateScope;
  /** The browse axis — which Cupboard Templates shelf (P-015; orthogonal to scope). */
  category: TemplateCategory;
  /** One-paragraph human description (the Cupboard listing text). */
  summary: string;
  /**
   * Version-pinned catalog refs. Non-empty UNLESS the template is a pure
   * composition (non-empty composesWith) — an app-scope template is typically
   * a thin composition of aspect templates and may carry no own components
   * (P-014); a template with neither components nor composesWith is a doc,
   * not a template.
   */
  components: TemplateComponentRef[];
  /** OPTIONAL starter blueprint dirs (kebab ids under blueprints/); a design-adoption template ships none. */
  blueprints?: string[];
  /** Typed seam-contract template names under contracts/ (kebab; may be empty for templates that don't cross the seam). */
  contracts: string[];
  /** Declared decision points (may be empty — but an empty list means NO judgment is invited, which is rare by design). */
  decisionPoints: TemplateDecisionPoint[];
  /** Template ids this template is designed to stack with (semantics = P-014; may be empty). */
  composesWith: string[];
  /**
   * HARD version-pinned official cross-template dependencies (P-015).
   * Composing/installing this template pulls in its whole requires-closure;
   * the checks union covers the closure. Optional — absent means none.
   */
  requires?: TemplateRequireRef[];
  /**
   * Canonical /internal/docs page slugs for the building agent to consult
   * when the GUIDE is not enough (P-015; the dogfooding rule — you are
   * building ON a live papercusp, its docs are served on your install).
   */
  docs?: string[];
  /** The acceptance suite. Non-empty — checks are the load-bearing replacement for the old deterministic generator. */
  checks: TemplateCheck[];
  /**
   * Structured MUST invariants, each linked to the check that enforces it
   * (or explicitly "prose-only" — visible debt). Optional while templates
   * adopt; the GUIDE's numbered MUSTs should mirror these ids.
   */
  musts?: TemplateMust[];
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SCOPES: readonly string[] = ["app", "aspect"];
const CATEGORIES: readonly string[] = TEMPLATE_CATEGORIES;
// A docs entry is a /internal/docs page slug: kebab segments, "/" separators
// (e.g. "agent-insights/templates-system-design").
const DOC_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const SELECT_ARITIES: readonly string[] = ["one", "one-or-more"];

/**
 * Validate one decision point's `selects` block (D-001), appending EVERY
 * problem to `errors`. Split out because it is the deepest nesting in the
 * schema and inlining it would bury the decisionPoints leg.
 */
function validateDecisionSelect(
  raw: unknown,
  path: string,
  manifestId: unknown,
  errors: string[],
): void {
  if (!isRecord(raw)) {
    errors.push(`${path}: must be an object { options, arity? } when present`);
    return;
  }
  if (raw.arity !== undefined && (typeof raw.arity !== "string" || !SELECT_ARITIES.includes(raw.arity))) {
    errors.push(`${path}.arity: must be one of ${SELECT_ARITIES.join("|")} when present (default 'one')`);
  }
  if (!Array.isArray(raw.options)) {
    errors.push(`${path}.options: required array of { value, templates }`);
    return;
  }
  if (raw.options.length < 2) {
    errors.push(`${path}.options: needs at least 2 options — a single answer is not a choice`);
  }

  const seenValues = new Set<string>();
  let emptyOptions = 0;
  raw.options.forEach((o, j) => {
    const optPath = `${path}.options[${j}]`;
    if (!isRecord(o)) {
      errors.push(`${optPath}: must be an object { value, templates }`);
      return;
    }
    if (typeof o.value !== "string" || !KEBAB.test(o.value)) {
      errors.push(`${optPath}.value: required kebab-case string`);
    } else {
      if (seenValues.has(o.value)) errors.push(`${optPath}: duplicate option value '${o.value}'`);
      seenValues.add(o.value);
    }
    if (o.summary !== undefined && typeof o.summary !== "string") {
      errors.push(`${optPath}.summary: must be a string when present`);
    }
    if (!Array.isArray(o.templates)) {
      errors.push(`${optPath}.templates: required array of { id, version } (may be empty — the explicit "none" answer)`);
      return;
    }
    if (o.templates.length === 0) emptyOptions += 1;
    const seenRefs = new Set<string>();
    o.templates.forEach((r, k) => {
      const refPath = `${optPath}.templates[${k}]`;
      if (!isRecord(r)) {
        errors.push(`${refPath}: must be an object { id, version }`);
        return;
      }
      if (typeof r.id !== "string" || !KEBAB.test(r.id)) errors.push(`${refPath}.id: required kebab-case string`);
      if (typeof r.version !== "string" || !SEMVER.test(r.version)) {
        errors.push(`${refPath}.version: required exact semver pin (x.y.z)`);
      }
      if (typeof r.id === "string") {
        if (r.id === manifestId) errors.push(`${refPath}: a template cannot select itself ('${r.id}')`);
        if (seenRefs.has(r.id)) errors.push(`${refPath}: duplicate template ref '${r.id}' in one option`);
        seenRefs.add(r.id);
      }
    });
  });

  // ONE empty option means "this axis is optional". TWO would make optionality
  // ambiguous (which "none" did the builder pick?) and is always a mistake.
  if (emptyOptions > 1) {
    errors.push(`${path}.options: ${emptyOptions} options declare no templates — at most one may be the explicit "none" answer`);
  }
}

/** Validate an untrusted (already YAML-parsed) value as a TemplateManifest. Returns EVERY problem. */
export function validateTemplateManifest(raw: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["template manifest must be an object"] };

  if (typeof raw.id !== "string" || !KEBAB.test(raw.id)) errors.push("id: required kebab-case string");
  if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) errors.push("version: required semver string (x.y.z)");
  if (typeof raw.scope !== "string" || !SCOPES.includes(raw.scope)) errors.push(`scope: required one of ${SCOPES.join("|")}`);
  if (typeof raw.category !== "string" || !CATEGORIES.includes(raw.category)) {
    errors.push(`category: required one of ${CATEGORIES.join("|")} (the Cupboard browse axis — P-015)`);
  }
  if (typeof raw.summary !== "string" || raw.summary.trim() === "") errors.push("summary: required non-empty string");

  if (!Array.isArray(raw.components)) {
    errors.push("components: required array of { id, version }");
  } else if (raw.components.length === 0) {
    // A pure composition (non-empty composesWith) may carry no own components (P-014).
    const composes = isStringArray(raw.composesWith) && raw.composesWith.length > 0;
    if (!composes) errors.push("components: may be empty only for a pure-composition template (non-empty composesWith)");
  } else {
    const seen = new Set<string>();
    raw.components.forEach((c, i) => {
      if (!isRecord(c)) {
        errors.push(`components[${i}]: must be an object { id, version }`);
        return;
      }
      if (typeof c.id !== "string" || !KEBAB.test(c.id)) errors.push(`components[${i}].id: required kebab-case string`);
      if (typeof c.version !== "string" || !SEMVER.test(c.version)) errors.push(`components[${i}].version: required exact semver pin (x.y.z)`);
      if (typeof c.id === "string") {
        if (seen.has(c.id)) errors.push(`components[${i}]: duplicate component ref '${c.id}'`);
        seen.add(c.id);
      }
    });
  }

  if (raw.blueprints !== undefined) {
    if (!isStringArray(raw.blueprints)) {
      errors.push("blueprints: must be string[] when present");
    } else {
      for (const b of raw.blueprints) if (!KEBAB.test(b)) errors.push(`blueprints: '${b}' is not kebab-case`);
    }
  }

  if (!isStringArray(raw.contracts)) {
    errors.push("contracts: required string[] (may be empty)");
  } else {
    for (const c of raw.contracts) if (!KEBAB.test(c)) errors.push(`contracts: '${c}' is not kebab-case`);
  }

  if (!Array.isArray(raw.decisionPoints)) {
    errors.push("decisionPoints: required array of { id, prompt } (may be empty)");
  } else {
    const seen = new Set<string>();
    raw.decisionPoints.forEach((d, i) => {
      if (!isRecord(d)) {
        errors.push(`decisionPoints[${i}]: must be an object { id, prompt }`);
        return;
      }
      if (typeof d.id !== "string" || !KEBAB.test(d.id)) errors.push(`decisionPoints[${i}].id: required kebab-case string`);
      if (typeof d.prompt !== "string" || d.prompt.trim() === "") errors.push(`decisionPoints[${i}].prompt: required non-empty string`);
      if (typeof d.id === "string") {
        if (seen.has(d.id)) errors.push(`decisionPoints[${i}]: duplicate decision point '${d.id}'`);
        seen.add(d.id);
      }
      if (d.selects !== undefined) validateDecisionSelect(d.selects, `decisionPoints[${i}].selects`, raw.id, errors);
    });
  }

  if (!isStringArray(raw.composesWith)) {
    errors.push("composesWith: required string[] (may be empty)");
  } else {
    for (const t of raw.composesWith) if (!KEBAB.test(t)) errors.push(`composesWith: '${t}' is not kebab-case`);
  }

  if (raw.requires !== undefined) {
    if (!Array.isArray(raw.requires)) {
      errors.push("requires: must be an array of { id, version } when present (hard pinned template deps — P-015)");
    } else {
      const seen = new Set<string>();
      raw.requires.forEach((r, i) => {
        if (!isRecord(r)) {
          errors.push(`requires[${i}]: must be an object { id, version }`);
          return;
        }
        if (typeof r.id !== "string" || !KEBAB.test(r.id)) errors.push(`requires[${i}].id: required kebab-case string`);
        if (typeof r.version !== "string" || !SEMVER.test(r.version)) errors.push(`requires[${i}].version: required exact semver pin (x.y.z)`);
        if (typeof r.id === "string") {
          if (r.id === raw.id) errors.push(`requires[${i}]: a template cannot require itself ('${r.id}')`);
          if (seen.has(r.id)) errors.push(`requires[${i}]: duplicate requires ref '${r.id}'`);
          seen.add(r.id);
        }
      });
    }
  }

  if (raw.docs !== undefined) {
    if (!isStringArray(raw.docs)) {
      errors.push("docs: must be string[] when present (/internal/docs page slugs — P-015)");
    } else {
      for (const d of raw.docs) if (!DOC_SLUG.test(d)) errors.push(`docs: '${d}' is not a doc slug (kebab segments, '/' separators)`);
    }
  }

  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    errors.push("checks: required non-empty array of { id, run } — checks are load-bearing");
  } else {
    const seen = new Set<string>();
    raw.checks.forEach((c, i) => {
      if (!isRecord(c)) {
        errors.push(`checks[${i}]: must be an object { id, run }`);
        return;
      }
      if (typeof c.id !== "string" || !KEBAB.test(c.id)) errors.push(`checks[${i}].id: required kebab-case string`);
      if (typeof c.run !== "string" || c.run.trim() === "") errors.push(`checks[${i}].run: required non-empty string`);
      if (c.summary !== undefined && typeof c.summary !== "string") errors.push(`checks[${i}].summary: must be a string when present`);
      if (typeof c.id === "string") {
        if (seen.has(c.id)) errors.push(`checks[${i}]: duplicate check '${c.id}'`);
        seen.add(c.id);
      }
    });
  }

  if (raw.musts !== undefined) {
    if (!Array.isArray(raw.musts)) {
      errors.push('musts: must be an array of { id, rule, enforcedBy } when present (P-002 structured MUSTs)');
    } else {
      // enforcedBy resolves against the DECLARED check ids (best-effort when
      // checks itself is malformed — those errors are already reported above).
      const checkIds = new Set(
        Array.isArray(raw.checks)
          ? raw.checks.filter(isRecord).map((c) => c.id).filter((id): id is string => typeof id === "string")
          : [],
      );
      const seen = new Set<string>();
      raw.musts.forEach((m, i) => {
        if (!isRecord(m)) {
          errors.push(`musts[${i}]: must be an object { id, rule, enforcedBy }`);
          return;
        }
        if (typeof m.id !== "string" || !KEBAB.test(m.id)) errors.push(`musts[${i}].id: required kebab-case string`);
        if (typeof m.rule !== "string" || m.rule.trim() === "") errors.push(`musts[${i}].rule: required non-empty string`);
        if (typeof m.enforcedBy !== "string" || m.enforcedBy.trim() === "") {
          errors.push(`musts[${i}].enforcedBy: required — a check id or the literal "${MUST_PROSE_ONLY}"`);
        } else if (m.enforcedBy !== MUST_PROSE_ONLY && !checkIds.has(m.enforcedBy)) {
          errors.push(
            `musts[${i}].enforcedBy: '${m.enforcedBy}' is not a declared check id (use "${MUST_PROSE_ONLY}" if nothing enforces it yet)`,
          );
        }
        if (typeof m.id === "string") {
          if (seen.has(m.id)) errors.push(`musts[${i}]: duplicate must '${m.id}'`);
          seen.add(m.id);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** The MUSTs nothing enforces yet — the visible check-coverage debt (P-002). */
export function unenforcedMusts(manifest: TemplateManifest): TemplateMust[] {
  return (manifest.musts ?? []).filter((m) => m.enforcedBy === MUST_PROSE_ONLY);
}

/** Fail-loud form: returns the typed manifest or throws one Error listing every problem. */
export function parseTemplateManifest(raw: unknown): TemplateManifest {
  const { ok, errors } = validateTemplateManifest(raw);
  if (!ok) throw new Error(`invalid template manifest: ${errors.join("; ")}`);
  return raw as TemplateManifest;
}

/**
 * Cross-validate a template's component refs against the component catalog:
 * every ref must resolve to a catalog id, and its pin must match the
 * catalog's CURRENT version (the catalog carries exactly one living version
 * per component — a mismatched pin means the template or the catalog rotted;
 * update whichever is stale). Returns EVERY problem.
 */
export function validateTemplateAgainstCatalog(
  manifest: TemplateManifest,
  catalog: ComponentManifest[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map(catalog.map((c) => [c.id, c]));
  for (const ref of manifest.components) {
    const entry = byId.get(ref.id);
    if (!entry) {
      errors.push(`'${manifest.id}' references unknown component '${ref.id}'`);
      continue;
    }
    if (entry.version !== ref.version) {
      errors.push(
        `'${manifest.id}' pins '${ref.id}@${ref.version}' but the catalog has ${entry.version} (stale pin — update the template or the catalog)`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
