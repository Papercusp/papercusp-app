/**
 * Security-advisories check for pinned plugin versions at fork time.
 *
 * When a snapshot pins a plugin to a specific version (the default per
 * share-semantics spec), forking should consult the marketplace catalog
 * for known advisories on that version. Severity ≥ moderate prompts
 * loudly: "pin (proceed), upgrade (re-pin to latest), or read advisory."
 *
 * Spec: /docs/snapshots/share-semantics#pinning-and-security-advisories.
 */

export type AdvisorySeverity = 'low' | 'moderate' | 'high' | 'critical';

export interface SecurityAdvisory {
  cve?: string;
  severity: AdvisorySeverity;
  fixedIn?: string;
  summary: string;
  advisoryUrl?: string;
}

export interface MarketplaceCatalogEntry {
  pluginSlug: string;
  version: string;
  publisher: string;
  securityAdvisories?: SecurityAdvisory[];
}

const SEVERITY_RANK: Record<AdvisorySeverity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

/**
 * Filter a catalog entry's advisories down to those that meet the
 * minimum severity threshold (default: moderate). Returns empty array
 * if the entry has no advisories.
 */
export function filterAdvisoriesAtOrAbove(
  advisories: SecurityAdvisory[] | undefined,
  minSeverity: AdvisorySeverity = 'moderate',
): SecurityAdvisory[] {
  if (!advisories || advisories.length === 0) return [];
  const threshold = SEVERITY_RANK[minSeverity];
  return advisories.filter((a) => SEVERITY_RANK[a.severity] >= threshold);
}

/**
 * Result of consulting the catalog for a pinned version. Three states:
 *   - 'clean'   no advisories at threshold
 *   - 'flagged' advisories present; UI must prompt loudly
 *   - 'unknown' catalog couldn't be reached (treat as flagged for safety)
 */
export type AdvisoryCheckResult =
  | { state: 'clean' }
  | { state: 'flagged'; advisories: SecurityAdvisory[]; latestSafeVersion?: string }
  | { state: 'unknown'; reason: string };

export interface CatalogClient {
  getEntry(pluginSlug: string, version: string): Promise<MarketplaceCatalogEntry | null>;
  /**
   * Find the highest-version catalog entry whose advisories at threshold
   * are empty. Used when prompting the user to upgrade.
   */
  getLatestSafe?(
    pluginSlug: string,
    minSeverity: AdvisorySeverity,
  ): Promise<string | null>;
}

export async function checkPinnedVersionAdvisories(
  client: CatalogClient,
  pluginSlug: string,
  version: string,
  minSeverity: AdvisorySeverity = 'moderate',
): Promise<AdvisoryCheckResult> {
  let entry: MarketplaceCatalogEntry | null;
  try {
    entry = await client.getEntry(pluginSlug, version);
  } catch (e: unknown) {
    return {
      state: 'unknown',
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  if (!entry) return { state: 'clean' };

  const flagged = filterAdvisoriesAtOrAbove(entry.securityAdvisories, minSeverity);
  if (flagged.length === 0) return { state: 'clean' };

  let latestSafe: string | undefined;
  if (client.getLatestSafe) {
    try {
      latestSafe = (await client.getLatestSafe(pluginSlug, minSeverity)) ?? undefined;
    } catch {
      // best-effort
    }
  }
  return { state: 'flagged', advisories: flagged, latestSafeVersion: latestSafe };
}
