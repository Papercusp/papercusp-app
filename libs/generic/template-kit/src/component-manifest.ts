/**
 * Component-manifest format — the machine-readable description of ONE
 * template-composable component (plan app-templates-2026-07-04 P-004).
 *
 * A TEMPLATE (template.yaml, P-005) composes components by reference; each
 * component carries a manifest so an agent (or the gym) can answer, without
 * reading the source: what does this provide, what tier of discipline does it
 * demand, what does it pair with, and how do I prove it still works?
 *
 * TIERS (design doc D-002, agent-insights/templates-system-design):
 *   A — plain deterministic component: compose/modify freely.
 *   B — seam component: MUST be used for its crossing (work-items transport,
 *       typed contracts, definetools/events, capability envelopes, gym).
 *   C — guardrail: sealed; modify only with disclosure + checks green.
 *
 * Validation is PURE + zero-dep: `validateComponentManifest` returns every
 * problem (never throws); `parseComponentManifest` throws one Error listing
 * them all (the fail-loud form for build/test paths).
 */

export type ComponentTier = "A" | "B" | "C";

/** An extracted, versioned package vs a documented pattern with reference impls. */
export type ComponentKind = "package" | "pattern";

export interface ComponentSource {
  /** GitHub repo slug (`Papercusp/pot-app-seam`) when the component has its own repo. */
  repo?: string;
  /** Repo-relative path of the canonical source / reference implementation. */
  path?: string;
  /** npm package name when consumable as a workspace dep (`@papercusp/pot-app-seam`). */
  package?: string;
}

export interface ComponentManifest {
  /** kebab-case component id, unique within the catalog. */
  id: string;
  /** semver (`0.1.0`). */
  version: string;
  /** D-002 discipline tier. */
  tier: ComponentTier;
  /** package (extracted) | pattern (documented shape + reference impls). */
  kind: ComponentKind;
  /** Capability slugs this component provides (kebab-case). */
  provides: string[];
  /** Catalog ids this component is designed to pair with. */
  composesWith: string[];
  /** Where it lives. At least one of repo/path/package must be present. */
  source: ComponentSource;
  /** How to prove it still works (test command / suite location / "reference apps' suites"). */
  tests: string;
  /** One-paragraph human description. */
  summary: string;
  /** Optional pointer to usage docs (a docs slug or URL). */
  guide?: string;
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const TIERS: readonly string[] = ["A", "B", "C"];
const KINDS: readonly string[] = ["package", "pattern"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate an untrusted value as a ComponentManifest. Returns EVERY problem. */
export function validateComponentManifest(raw: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["manifest must be an object"] };

  if (typeof raw.id !== "string" || !KEBAB.test(raw.id)) errors.push("id: required kebab-case string");
  if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) errors.push("version: required semver string (x.y.z)");
  if (typeof raw.tier !== "string" || !TIERS.includes(raw.tier)) errors.push(`tier: required one of ${TIERS.join("|")}`);
  if (typeof raw.kind !== "string" || !KINDS.includes(raw.kind)) errors.push(`kind: required one of ${KINDS.join("|")}`);

  if (!isStringArray(raw.provides) || raw.provides.length === 0) {
    errors.push("provides: required non-empty string[]");
  } else {
    for (const p of raw.provides) if (!KEBAB.test(p)) errors.push(`provides: '${p}' is not kebab-case`);
  }

  if (!isStringArray(raw.composesWith)) {
    errors.push("composesWith: required string[] (may be empty)");
  } else {
    for (const c of raw.composesWith) if (!KEBAB.test(c)) errors.push(`composesWith: '${c}' is not kebab-case`);
  }

  if (!isRecord(raw.source)) {
    errors.push("source: required object with at least one of repo/path/package");
  } else {
    const { repo, path, package: pkg } = raw.source as ComponentSource;
    for (const [k, v] of [["repo", repo], ["path", path], ["package", pkg]] as const) {
      if (v !== undefined && typeof v !== "string") errors.push(`source.${k}: must be a string when present`);
    }
    if (repo === undefined && path === undefined && pkg === undefined) {
      errors.push("source: at least one of repo/path/package is required");
    }
  }

  if (typeof raw.tests !== "string" || raw.tests.trim() === "") errors.push("tests: required non-empty string");
  if (typeof raw.summary !== "string" || raw.summary.trim() === "") errors.push("summary: required non-empty string");
  if (raw.guide !== undefined && typeof raw.guide !== "string") errors.push("guide: must be a string when present");

  return { ok: errors.length === 0, errors };
}

/** Fail-loud form: returns the typed manifest or throws one Error listing every problem. */
export function parseComponentManifest(raw: unknown): ComponentManifest {
  const { ok, errors } = validateComponentManifest(raw);
  if (!ok) throw new Error(`invalid component manifest: ${errors.join("; ")}`);
  return raw as ComponentManifest;
}

/**
 * Catalog-level validation: every entry parses, ids are unique, and every
 * composesWith reference resolves to a catalog id (dangling refs are how a
 * catalog rots). Returns EVERY problem.
 */
export function validateCatalog(entries: unknown[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  const manifests: ComponentManifest[] = [];
  entries.forEach((e, i) => {
    const v = validateComponentManifest(e);
    if (!v.ok) {
      errors.push(...v.errors.map((msg) => `entry[${i}]: ${msg}`));
      return;
    }
    const m = e as ComponentManifest;
    if (ids.has(m.id)) errors.push(`entry[${i}]: duplicate id '${m.id}'`);
    ids.add(m.id);
    manifests.push(m);
  });
  for (const m of manifests) {
    for (const ref of m.composesWith) {
      if (!ids.has(ref)) errors.push(`'${m.id}' composesWith unknown component '${ref}'`);
    }
  }
  return { ok: errors.length === 0, errors };
}
