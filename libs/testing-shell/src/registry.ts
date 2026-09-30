/**
 * testing-shell registry — declarative registry for the testing-domains
 * surface, shared by /admin/testing (operator-vite) and the harness
 * Tests tab (operator).
 *
 * Moved here verbatim from apps/operator/lib/testing-domains.ts as
 * Phase A of harness-tests-tab-and-tester-promotion-2026-05-26 (P-001).
 * The original lib path is now a re-export shim. No API changes.
 *
 * Original provenance: apps/operator/docs/plans/admin-testing-tab-restructure-2026-05-24.md
 * Phase 1, P-001 + P-002.
 *
 * One entry per subtab. Each entry declares its sections, file globs, and
 * (optionally) ad-hoc runner descriptors. The admin UI walks the registry
 * via GET /api/admin/testing/domains/:id (P-003) — server-side glob walk,
 * no checked-in catalog to drift.
 *
 * Shape mirrors the agent-mcp `defineTool` pattern (drop a file, no
 * central switch to edit). Adding a new domain = call `defineTestDomain`
 * with a unique id and add to the export array below; the SPA renders it
 * automatically via the shared <DomainTestPanel>.
 *
 * Existing bespoke tabs are mounted by each host's `customTabs` map; the
 * registry remains the server-safe data/run descriptor.
 */

/**
 * Discriminated union of every way a single test can be run from the UI.
 * The run route (POST /api/admin/testing/run, P-014) dispatches on `kind`.
 *
 * `vitest` / `playwright` / `cargo` are auto-discovered via globs.
 * `node` / `shell` are explicit ad-hoc runners — these will shrink to zero
 * after Phase 5 framework standardization (D-006).
 * `k6` is a load-test script (porting Restart's /load-tests; the run route
 * spawns `k6 run <script>` with the given VUs/duration). `category` tags it
 * with the smoke/load/stress/spike/soak/browser taxonomy so the panel can
 * render the category badge + filter chips (see ./k6).
 * `admin-suite` defers to the existing admin-test-suites orchestrator.
 */
export type TestRunner =
  | { kind: 'vitest'; filePath: string }
  | { kind: 'playwright'; filePath: string }
  // `manifestPath` (EI-1610): a standalone crate with no root Cargo.toml workspace
  // can't be reached via `-p <crate>` from the repo root; point cargo at the crate's
  // own manifest instead. Optional — omitted preserves the workspace `-p` path.
  | { kind: 'cargo'; crate: string; test?: string; manifestPath?: string }
  | { kind: 'node'; cmd: string; args?: string[]; label?: string }
  | { kind: 'shell'; cmd: string; args?: string[]; label?: string }
  | { kind: 'k6'; script: string; vus?: number; duration?: string; category?: string }
  | { kind: 'admin-suite'; suiteId: string };

/**
 * One leaf section within a tab.
 *
 * Sections may declare:
 *  - `globs`: file paths discovered server-side, each rendered as a row.
 *  - `runners`: explicit non-vitest runners (`.mjs`/`.sh`/cargo) rendered
 *    as named buttons. Used while ad-hoc scripts await migration to
 *    Vitest in Phase 5; the descriptor disappears with the script.
 *  - `role`: a logical glob slot, left unresolved by the lib. A
 *    *universal* domain (one shared across projects) names a `role`
 *    instead of a hardcoded glob; each project supplies the concrete
 *    globs via a role→globs map applied with {@link applyRoleGlobs}. This
 *    is what lets the same domain resolve against any repo, instead of
 *    baking in `apps/operator/**` (which only ever matched the operator).
 *
 * At least one of `globs`, `runners`, or `role` must be present.
 */
export interface TestSection {
  id: string;
  label: string;
  description?: string;
  globs?: string[];
  runners?: TestRunner[];
  role?: string;
}

/**
 * Display tiers a domain can belong to. `quick` / `domain` / `surface` are
 * the /admin/testing taxonomy; `universal` marks domains that apply to ANY
 * project (declared in registry/universal.ts, shown under "Universal" in the
 * harness Tests tab); `project` is the harness-specific acceptance tier.
 * Each consumer maps these to its own section labels.
 */
export type TestTier = 'universal' | 'quick' | 'domain' | 'surface' | 'project';

export interface TestDomain {
  id: string;
  label: string;
  description: string;
  tier: TestTier;
  sections: TestSection[];
}

/**
 * Universal domains (apply to any project) are declared in
 * registry/universal.ts and re-exported here so SERVER-SIDE callers can
 * reach them via the React/CSS-free `@papercusp/testing-shell/registry`
 * entry (and the operator's `./testing-domains` shim) without importing
 * DomainTestPanel / TestingShell (which would crash the Hono/tsx server).
 */
export { universalDomains, UNIVERSAL_PANEL_DOMAINS, type UniversalPanelDomain } from './registry/universal';

const _registry = new Map<string, TestDomain>();

/**
 * Register a test domain. Throws on duplicate id (same shape as
 * defineSuite auto-loader — fail fast at module load).
 *
 * Validates `sections` invariant: every section must declare globs OR
 * runners (or both). An empty section would render an empty tab page,
 * which is always a mistake at registration time.
 */
export function defineTestDomain(domain: TestDomain): TestDomain {
  if (_registry.has(domain.id)) {
    throw new Error(
      `defineTestDomain: duplicate domain id "${domain.id}" — every domain id must be unique.`,
    );
  }
  if (domain.sections.length === 0) {
    throw new Error(
      `defineTestDomain: domain "${domain.id}" has no sections — at least one section is required.`,
    );
  }
  const sectionIds = new Set<string>();
  for (const section of domain.sections) {
    if (sectionIds.has(section.id)) {
      throw new Error(
        `defineTestDomain: domain "${domain.id}" has duplicate section id "${section.id}".`,
      );
    }
    sectionIds.add(section.id);
    const hasGlobs = (section.globs?.length ?? 0) > 0;
    const hasRunners = (section.runners?.length ?? 0) > 0;
    const hasRole = !!section.role;
    if (!hasGlobs && !hasRunners && !hasRole) {
      throw new Error(
        `defineTestDomain: domain "${domain.id}" section "${section.id}" ` +
          `must declare globs, runners, or a role.`,
      );
    }
  }
  _registry.set(domain.id, domain);
  return domain;
}

/** Get one domain by id, or undefined. */
export function getTestDomain(id: string): TestDomain | undefined {
  return _registry.get(id);
}

/** Snapshot of every registered domain, ordered by tier then registration order. */
export function listTestDomains(): TestDomain[] {
  const tierOrder: Record<TestTier, number> = {
    universal: -1,
    quick: 0,
    domain: 1,
    surface: 2,
    project: 3,
  };
  return Array.from(_registry.values()).sort((a, b) => {
    const t = tierOrder[a.tier] - tierOrder[b.tier];
    if (t !== 0) return t;
    return 0;
  });
}

/**
 * Resolve a universal domain set against one project's `role → globs` map.
 *
 * Each section that names a `role` gets its `globs` filled from the map
 * (an unmapped role → `[]`, which renders as an empty section rather than
 * silently matching the wrong repo's paths). Sections without a `role`
 * pass through untouched. Pure — never mutates the input.
 *
 * This is the seam that makes the universal tier project-agnostic: the lib
 * ships the domain *definitions* (id/label/role), and each consumer (the
 * operator generating its harness contract, Restart's data source, …)
 * supplies the globs for its own repo.
 */
export function applyRoleGlobs(
  domains: TestDomain[],
  roleGlobs: Record<string, string[]>,
): TestDomain[] {
  const declaredRoles = new Set(
    domains.flatMap((domain) => domain.sections.flatMap((section) => (section.role ? [section.role] : []))),
  );
  const suppliedRoles = new Set(Object.keys(roleGlobs));
  const missing = [...declaredRoles].filter((role) => !suppliedRoles.has(role)).sort();
  const surplus = [...suppliedRoles].filter((role) => !declaredRoles.has(role)).sort();
  if (missing.length || surplus.length) {
    const details = [
      missing.length ? `missing role bindings: ${missing.join(', ')}` : '',
      surplus.length ? `surplus role bindings: ${surplus.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`applyRoleGlobs: role binding parity violation — ${details}`);
  }
  return domains.map((d) => ({
    ...d,
    sections: d.sections.map((s) =>
      s.role ? { ...s, globs: roleGlobs[s.role] ?? [] } : s,
    ),
  }));
}

/**
 * INTERNAL — test-only. Clears the registry so test files can reseed it
 * with a known set without side effects from other tests. Not exported
 * from the package index.
 */
export function _resetTestDomainRegistry(): void {
  _registry.clear();
}
