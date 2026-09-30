/**
 * `system:coverage-census` — the census cadence's routine-engine registration.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-002).
 *
 * A bespoke `tier:'ephemeral'` operator-HOME cadence (same deviation reasoning as
 * supervision-reconcile-action: one sweep serves the host, not a per-blueprint-install generic
 * schedule). Ephemeral rows are armed by the per-host ephemeral executor — NOT a bare
 * setInterval (`lint:no-raw-setinterval`).
 *
 * REGISTERED HERE EVEN THOUGH NO PROVIDERS EXIST YET (they land in P-003). That is deliberate:
 * a routine seeded ACTIVE whose `system:` action is registered NOWHERE silently skips every
 * fire and looks alive in the routines table (EI-18741229858124453 — `template-gym` sat in
 * exactly that state). Registering the handler up front means the cadence is genuinely running;
 * with an empty provider set it is a correct no-op, because no provider reporting success means
 * no kind is retirable and the census cannot write a retirement.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';

registerSystemAction('coverage-census', async (_ctx: SystemActionCtx) => {
  // Keep the registry side-effect import cheap. These modules pull the complete census/provider
  // graph (and the sync invalidation path); loading them only when the cadence actually fires
  // avoids making every host boot and registration test pay that cost.
  const [
    { getOrgPg },
    { runCensus },
    { createPgCensusStore },
    { censusProviders },
    { resolveCensusScope },
    { notifySyncInvalidate },
  ] = await Promise.all([
    import('@papercusp/db-org'),
    import('@papercusp/testing-shell/census'),
    import('../../coverage-census/pg-store'),
    import('../../coverage-census/provider-registry'),
    import('../../coverage-census/scope'),
    import('../../sync-sse'),
  ]);

  const providers = censusProviders();
  // D-011: the SAME resolver the attribution layer uses, so evidence rows can only ever
  // land in the scope these surfaces are written under. Inlining the two resolvers here
  // is what let attribution drift onto an env-only derivation that resolved to (NULL,
  // NULL) in every real run — see coverage-census/scope.ts.
  const scope = resolveCensusScope();

  const store = createPgCensusStore({ getSql: () => getOrgPg().sql });

  const report = await runCensus({
    scope,
    store,
    providers,
    repoRoot: process.cwd(),
  });

  // The breaker refusing a write is the one outcome that must never be quiet: it means the
  // census believes most of the world disappeared, and a silent refusal would leave the gate
  // reading a stale census with nobody aware.
  if (report.retirementBlocked) {
    console.warn(
      `[coverage-census] MASS-RETIREMENT REFUSED for ${scope.harnessSlug}: ` +
        `${report.retirementBlocked.wouldRetire} of ${report.retirementBlocked.liveRows} live rows ` +
        `would have been retired (threshold ${report.retirementBlocked.threshold}). ` +
        `Upserts were still applied; retirements were NOT. Inspect the providers before re-running ` +
        `with allowMassRetirement.`,
    );
  }

  if (report.failedProviders.length > 0) {
    console.warn(
      `[coverage-census] ${report.failedProviders.length} provider(s) FAILED — their kinds were ` +
        `left untouched this run (absent means unknown, not gone): ` +
        report.failedProviders.map((f) => `${f.provider}: ${f.error}`).join('; '),
    );
  }

  if (report.unimplementedProviders.length > 0) {
    console.warn(
      `[coverage-census] registered but not implemented in this build: ` +
        report.unimplementedProviders.join(', '),
    );
  }

  console.log(
    `[coverage-census] ${scope.harnessSlug}: ran ${report.ranProviders.length} provider(s), ` +
      `upserted ${report.applied?.upserted ?? 0}, retired ${report.applied?.retired ?? 0} ` +
      `(retirable kinds: ${report.diff.retirableKinds.join(',') || 'none'})`,
  );

  // PRODUCER-SIDE PUSH for the `/admin/testing` Coverage panel, exactly ONCE per run.
  //
  // The alternative — an `emit_change_notify` trigger on `testing_surfaces` — is the wrong
  // instrument for a BATCH producer: a run re-upserts the whole surface population (1,105 rows
  // here), nearly all of them byte-identical to what was already there, so the trigger would
  // fire ~1,105 NOTIFYs per hour to communicate one fact. Same reasoning the derived-reads
  // resolvers are PUSH_EXEMPT for (sync-resolver/__tests__/resolver-backing-table-coverage.test.ts).
  //
  // ⚠ This fires once per RUN, not once per CHANGE: `upserted` counts no-op upserts too, so a
  // census that changed nothing still pushes. That is deliberate (one cheap invalidation an hour
  // beats plumbing a change-hash through the generic census core) but it is NOT the stronger
  // "only when the payload actually changed" guarantee derived-reads gives — do not read it as one.
  if (report.applied) {
    await notifySyncInvalidate('testing.coverage');
  }
});
