#!/usr/bin/env tsx
/**
 * guard-rail-probes — the probe SOURCE for verification-harness preflights
 * (expensive-verification-loops-2026-09-29 P-004).
 *
 * Prints, as a JSON array of GuardRailProbe, every live local-origin standing fact whose
 * recheck.exec scope shares a tag with VH_SCOPE_TAGS (comma-separated; set by the harness).
 * A shell harness wires it with:
 *
 *   export VH_GUARD_RAIL_SOURCE='npx tsx scripts/guard-rail-probes.mts'
 *   vh_scope p505
 *
 * Exit codes: 0 printed the array (possibly empty); 2 could not load. The harness fails its
 * preflight CLOSED on a non-zero exit, so an unreachable fact store never reads as "no rails".
 */
import { loadGuardRailProbes } from '../packages/operator-core/lib/agent-facts/guard-rail-probes.ts';
import { getOrgPg } from '@papercusp/db-org';

const tags = (process.env.VH_SCOPE_TAGS ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

let code = 0;
try {
  const probes = await loadGuardRailProbes({ tags });
  process.stdout.write(`${JSON.stringify(probes)}\n`);
} catch (err) {
  process.stderr.write(`guard-rail-probes: ${err instanceof Error ? err.message : String(err)}\n`);
  code = 2;
} finally {
  await getOrgPg()
    .sql.end({ timeout: 5 })
    .catch(() => {});
}
process.exit(code);
