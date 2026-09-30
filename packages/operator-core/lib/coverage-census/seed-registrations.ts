/**
 * Seed this pot's census PROVIDER REGISTRATIONS — the rows `runCensus` actually iterates.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-005 groundwork; fixes WI-39809).
 *
 * WHY THIS EXISTS. `provider-registry.ts` names the two different "registrations" and warns
 * against conflating them. It landed the BUILD side (which providers this build can run) in
 * P-003; nothing ever landed the POT side (which providers this pot WANTS to run), and
 * `runCensus` drives its entire loop from the pot side:
 *
 *     for (const registration of await store.loadRegistrations(scope))   // run.ts:105
 *
 * With zero rows that loop body never executes. The run then reports success with an empty
 * diff — no failed providers, no unimplemented providers, no mass-retirement refusal, because
 * none of those conditions is what happened. Measured 2026-08-18: all four census tables at 0
 * rows, and every write site for `census_provider_registrations` in the whole repo was a test
 * fixture. So the census was a structural no-op on EVERY build, independently of
 * EI-20796266249712348 (the action being absent from the release build).
 *
 * WHY A SEED AND NOT AUTO-REGISTRATION AT CENSUS TIME. D-004 makes registration pot-level and
 * deliberate: `source` is `template` (an app-scope root declared it) | `detected` (stack
 * sniffing at generate-from-repo) | `manual`. A census that silently registered every provider
 * it could run would erase that choice — a pot could never decline a provider, because the next
 * fire would put it back. The Papercusp pot predates the census and was never materialized from
 * a template nor sniffed by `harness:generate-from-repo`, so no path ever created its rows; this
 * script IS that missing detection pass, run once and idempotently thereafter.
 *
 *   tsx seed-registrations.ts             # seed the three declared providers ENABLED
 *   tsx seed-registrations.ts --disabled  # seed them present-but-off
 *
 * Idempotent (upsert on the table's own (workspace_id, harness_slug, provider) primary key).
 */
import type { Sql } from 'postgres';

/**
 * The providers this pot is declared to want, keyed by STACK (D-001) — the same three ids
 * `provider-registry.ts` implements for the Papercusp stack.
 *
 * ⚠ INTENTIONALLY A SEPARATE LIST FROM `censusProviders()`, NOT DERIVED FROM IT. Deriving the
 * pot's WANTS from the build's CAN-RUN is exactly the conflation `provider-registry.ts:6-12`
 * warns about, and it would silently re-register a provider an operator had removed on purpose.
 * A provider present here but absent from the build reports as `unimplementedProviders`, which
 * is the loud misconfiguration signal the census already has.
 */
export const DECLARED_PROVIDERS: readonly string[] = ['hono-routes', 'mcp-tools', 'sync-queries'];

export interface SeedRegistrationsResult {
  /** Rows the upsert touched — inserted or updated. */
  written: number;
  providers: readonly string[];
}

/**
 * Upsert one registration per declared provider.
 *
 * ⚠ `enabled` IS NOT RE-APPLIED ON CONFLICT, for the reason `seed-coverage-census-routine.ts`
 * learned the hard way about `active` (EI-19301170070808928): a re-seed must never clobber an
 * operator's runtime pause of a provider. An operator who disabled `sync-queries` must not find
 * it back on after the next deploy runs this. `enabled` therefore only ever takes effect on the
 * INSERT — which is also why `--disabled` is a first-run choice, not a toggle.
 */
export async function seedCensusRegistrations(
  sql: Sql,
  scope: { workspaceId: string; harnessSlug: string },
  opts: { enabled?: boolean; providers?: readonly string[] } = {},
): Promise<SeedRegistrationsResult> {
  const enabled = opts.enabled ?? true;
  const providers = opts.providers ?? DECLARED_PROVIDERS;

  for (const provider of providers) {
    await sql`
      INSERT INTO harness_shared.census_provider_registrations
        (workspace_id, harness_slug, provider, config, enabled, source)
      VALUES
        (${scope.workspaceId}, ${scope.harnessSlug}, ${provider}, '{}'::jsonb, ${enabled}, 'detected')
      ON CONFLICT (workspace_id, harness_slug, provider) DO UPDATE SET
        -- enabled deliberately absent: see the note above.
        source     = EXCLUDED.source,
        updated_at = now()
    `;
  }

  return { written: providers.length, providers };
}

/* c8 ignore start — CLI entry, exercised by running the script, not by unit tests. */
async function main(): Promise<void> {
  const [{ getOrgPg }, { resolveCensusScope }] = await Promise.all([
    import('@papercusp/db-org'),
    import('./scope'),
  ]);
  const enabled = !process.argv.includes('--disabled');
  const scope = resolveCensusScope();
  const { sql } = getOrgPg();
  const result = await seedCensusRegistrations(sql, scope, { enabled });
  console.log(
    `[seed-census-registrations] seeded ${result.written} registration(s) for ` +
      `${scope.harnessSlug} (ws=${scope.workspaceId}, enabled-on-insert=${enabled}): ` +
      `${result.providers.join(', ')}. The census loop iterates THESE rows — with none, it is a ` +
      `silent no-op (WI-39809).`,
  );
  await sql.end({ timeout: 5 });
}

if (process.argv[1] && /seed-registrations\.(ts|js|mjs)$/.test(process.argv[1])) {
  void main().catch((err) => {
    console.error('[seed-census-registrations] failed:', err);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
