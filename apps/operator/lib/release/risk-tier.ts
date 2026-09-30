/**
 * Deploy risk-tiering — plan release-gate-ready-branch-2026-06-04, Phase 5.
 *
 * Classifies a deploy (the files changed + migrations staged since the last
 * deploy) into a risk tier, so low-risk changes can deploy auto-when-green-and-idle
 * while core-infra stays human/agent-gated:
 *
 *   - `auto`   — only docs / tests changed, no migrations, nothing touching the
 *                core-infra surfaces. Safe to deploy unattended.
 *   - `review` — everything else (code, schema, coord/lock substrate, the deploy
 *                system itself, the endpoint framework, env). Needs the
 *                release-manager's go/no-go.
 *
 * Conservative by construction: the bias is `review`. A change is `auto` ONLY if
 * EVERY changed file is on the explicit safe list AND there are no migrations —
 * because the blast radius of an unattended deploy is the entire running fleet.
 *
 * Pure (path + optional migration-content based) so it's fully unit-tested and
 * shared by gatherPlan, the deploy CLI's --auto gate, and the release-trigger.
 */

export type RiskTier = 'auto' | 'review';

export interface RiskAssessment {
  tier: RiskTier;
  autoDeployable: boolean;
  /** Why it's `review` (empty when `auto`). */
  reasons: string[];
  /** Extra-loud signals — destructive migrations / deploy-system changes. Never silently auto. */
  blocked: string[];
}

/** A file is SAFE (auto-eligible) only if it matches one of these. */
const SAFE_PATTERNS: RegExp[] = [
  /\.mdx?$/, // docs (.md / .mdx)
  /(^|\/)apps\/operator-docs\//, // the docs site
  /\.test\.(ts|tsx)$/, // vitest
  /\.spec\.ts$/, // playwright
  /(^|\/)apps\/operator\/e2e\//, // e2e specs
  /(^|\/)TESTING\.md$/,
  /(^|\/)quarantine\.txt$/,
];

/** Surfaces that ALWAYS force `review` even if they'd otherwise look benign. */
const CORE_INFRA_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(^|\/)libs\/papercusp\/libs\/db\/sql\//, label: 'schema migration' },
  { re: /(^|\/)(apps\/operator\/(lib|bin)\/release)\//, label: 'the deploy system itself' },
  { re: /(^|\/)harness\/routines\//, label: 'routines engine' },
  { re: /(^|\/)agent-tools\/locks\//, label: 'lock substrate' },
  { re: /(^|\/)coordination\//, label: 'coordination substrate' },
  { re: /(^|\/)sync\/hyperbee\//, label: 'sync/federation substrate' },
  { re: /(^|\/)role-config\.ts$/, label: 'agent role config' },
  { re: /(^|\/)endpoint-route\//, label: 'endpoint framework / routes' },
  { re: /(^|\/)migration-runner\.js$/, label: 'migration runner' },
  { re: /(^|\/)\.env/, label: 'environment config' },
];

/** Destructive SQL that should never deploy silently. */
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|TYPE|CONSTRAINT)|ALTER\s+TABLE[\s\S]*?DROP\s+|TRUNCATE\b|DELETE\s+FROM\b)/i;

export function assessRisk(
  changedFiles: string[],
  migrations: string[],
  migrationContents?: Record<string, string>,
): RiskAssessment {
  const reasons: string[] = [];
  const blocked: string[] = [];

  if (migrations.length > 0) {
    reasons.push(`${migrations.length} staged migration(s)`);
    for (const m of migrations) {
      const body = migrationContents?.[m];
      if (body && DESTRUCTIVE_SQL.test(body)) blocked.push(`destructive migration: ${m}`);
    }
  }

  for (const f of changedFiles) {
    const infra = CORE_INFRA_PATTERNS.find((p) => p.re.test(f));
    if (infra) {
      reasons.push(`${infra.label}: ${f}`);
      if (/(release)\//.test(f) || /libs\/papercusp\/libs\/db\/sql\//.test(f)) blocked.push(f);
    }
  }

  const unsafe = changedFiles.filter((f) => !SAFE_PATTERNS.some((re) => re.test(f)));
  // Files that are unsafe but NOT already named by a core-infra reason.
  const plainUnsafe = unsafe.filter((f) => !CORE_INFRA_PATTERNS.some((p) => p.re.test(f)));
  if (plainUnsafe.length > 0) {
    reasons.push(
      `${plainUnsafe.length} non-safe file(s) (e.g. ${plainUnsafe.slice(0, 3).join(', ')}${plainUnsafe.length > 3 ? ', …' : ''})`,
    );
  }

  const tier: RiskTier = migrations.length === 0 && unsafe.length === 0 ? 'auto' : 'review';
  return { tier, autoDeployable: tier === 'auto', reasons, blocked };
}
