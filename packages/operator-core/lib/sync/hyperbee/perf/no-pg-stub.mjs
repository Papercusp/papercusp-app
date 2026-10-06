/**
 * no-pg-stub.mjs — what `@papercusp/db-org` resolves to inside a perf peer-child.
 * See no-pg-hooks.mjs for why. Every export throws: a perf peer that reaches a
 * Postgres path is a RIG DEFECT to surface, not a cost to absorb.
 *
 * ## Why this file lists names at all, and why the list is guarded
 *
 * A named ESM import is bound at INSTANTIATE time, before a single line runs. So a
 * missing name here is not a lazy "throws if you touch it" — it is a hard
 * `SyntaxError: The requested module '@papercusp/db-org' does not provide an export
 * named 'X'` that kills the child during module linking, before it can emit even a
 * boot event. The parent sees only `waitFor('ready')` resolving null after its
 * timeout, and the real one-line cause sits unread in the child's stderr.
 *
 * That is exactly how this broke (WI-761481): `resource-governor/execution.ts` added
 * `import { createDedicatedOrgPg } from '@papercusp/db-org'`, the stub did not export
 * it, and `child-driver.test.ts` failed for days as an opaque 30s timeout on the
 * green-checkpoint gate.
 *
 * So the export list is a SECOND COPY of a truth the sources own, and it WILL drift — it
 * already did, twice. `no-pg-stub-covers-db-org-imports.test.ts` DERIVES the required set
 * and fails if any name is missing. Add names by making that guard pass, never by hand.
 *
 * ⚠ ITS SCOPE, STATED EXACTLY — an earlier revision of this paragraph claimed the guard
 * reads "every npm workspace ... from the root package.json". It does not, and believing
 * that is worse than knowing the real bound. `PACKAGES_ROOT` is a hardcoded relative path
 * that resolves to `packages/`, and the walk covers every `.ts`/`.mts` beneath it
 * (skipping node_modules, dist and dotfiles). Nothing reads the root package.json.
 * So `libs/`, `apps/` and `scripts/` are NOT scanned: a db-org import added there is
 * invisible to this guard, and the peer-child would die at link time with the guard green.
 *
 * The second break (2026-09-02, WI-2141194 #9) is what widened the walk from
 * `packages/operator-core/lib/` to all of `packages/`: `packages/agent-mcp/src/auth.ts`
 * gained `getOrgPgListener` on 2026-08-28. The child's graph reaches agent-mcp through
 * operator-core (~1,500 imports), so every peer-child died at link time for five days
 * while the guard, looking only at operator-core, stayed green.
 *
 * ⚠ AND THE STAGE THIS GUARD CANNOT SEE AT ALL: it checks WHICH NAMES EXIST, never WHEN
 * they are called. A name that is present and throwing, but invoked while a module is
 * being EVALUATED, kills the child just as dead — same opaque 30s symptom, different
 * cause. That is the third break (also WI-2141194 #9); see the inert bindings below.
 */

const REASON =
  'perf peer-child reached @papercusp/db-org, which is deliberately stubbed out ' +
  '(perf/no-pg-hooks.mjs, plan harden-shared-hive-to-256-peers-2026-06-29 P-012). ' +
  'A perf peer must never query Postgres — it supplies applyOverride / ' +
  'loadRevokedOverride / verifyBindingOverride / announceIdentityOverride for exactly ' +
  'that reason. Either the boot path gained a PG call the override set no longer ' +
  'covers, or this child was spawned for something other than a substrate measurement. ' +
  'Fix the path or the overrides; do not soften this stub, and do not read a run that ' +
  'hit it as a measurement.';

function refuse() {
  throw new Error(REASON);
}

/**
 * One throwing binding per exported name. Kept as a plain function (not a Proxy) on
 * purpose: the job here is to satisfy the LINKER so the child boots far enough to
 * report a real error, then throw loudly if the binding is ever actually called.
 */
const stub = (name) => {
  const fn = () => {
    throw new Error(`${REASON} (reached via \`${name}\`)`);
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
};

// ── Names imported from '@papercusp/db-org' anywhere in any npm workspace of this repo.
// Type-only names are included deliberately: tsx erases them, so an extra binding is
// inert, while a MISSING one is a hard link error. Guarded by
// no-pg-stub-covers-db-org-imports.test.ts — do not prune by hand.
export const _resetForTests = stub('_resetForTests');
export const _resetStoreIdentityForTests = stub('_resetStoreIdentityForTests');
export const buildConnectionOptions = stub('buildConnectionOptions');
export const consumeEvents = stub('consumeEvents');
export const createDedicatedOrgPg = stub('createDedicatedOrgPg');
export const createGoal = stub('createGoal');
export const createInsertSchema = stub('createInsertSchema');
export const DbCallDeadlineError = stub('DbCallDeadlineError');
export const DEFAULT_DB_CALL_DEADLINE_MS = stub('DEFAULT_DB_CALL_DEADLINE_MS');
export const DEFAULT_TX_ACQUIRE_DEADLINE_MS = stub('DEFAULT_TX_ACQUIRE_DEADLINE_MS');
export const deleteRoutine = stub('deleteRoutine');
export const describeStoreIdentityMismatch = stub('describeStoreIdentityMismatch');
export const dSql = stub('dSql');
export const endStalePool = stub('endStalePool');
export const explainOnConflictSkew = stub('explainOnConflictSkew');
export const fireRoutine = stub('fireRoutine');
export const formatLineageForPrompt = stub('formatLineageForPrompt');
// Inert for the same reason as `schemaOf` (see its note): `generated` is the drizzle TABLE
// METADATA registry — plain schema descriptors, no connection and no query. Tool modules read
// it at module top level (`const projects = generated.projectsInHarnessShared`) purely to hand
// the descriptor to `schemaOf`, so any defined value is enough to let evaluation finish.
export const generated = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'then' ? undefined : {}) },
);
export const getFeatureLineage = stub('getFeatureLineage');
export const getHarnessPg = stub('getHarnessPg');
export const getLegacyClient = stub('getLegacyClient');
export const getOrgPg = stub('getOrgPg');
export const getOrgPgListener = stub('getOrgPgListener');
export const getOrgPgLosslessBigint = stub('getOrgPgLosslessBigint');
export const GOAL_SPEND_SNAPSHOT_SOURCE = stub('GOAL_SPEND_SNAPSHOT_SOURCE');
export const goalSpend = stub('goalSpend');
export const GoalSpend = stub('GoalSpend');
export const goalsForPot = stub('goalsForPot');
export const harnessQuery = stub('harnessQuery');
export const harnessTransaction = stub('harnessTransaction');
export const HOSTED_SERVICE_ROLE = stub('HOSTED_SERVICE_ROLE');
export const isParkedNextFire = stub('isParkedNextFire');
export const linkPot = stub('linkPot');
export const listActiveEphemeralRoutines = stub('listActiveEphemeralRoutines');
export const listDueCronRoutines = stub('listDueCronRoutines');
export const listGoals = stub('listGoals');
export const listInProcessSweepRoutines = stub('listInProcessSweepRoutines');
export const listUnconsumedEvents = stub('listUnconsumedEvents');
export const longLivedPoolConnectionOptions = stub('longLivedPoolConnectionOptions');
export const normalizeNextFireAt = stub('normalizeNextFireAt');
export const ObservedStoreIdentity = stub('ObservedStoreIdentity');
export const OrgPg = stub('OrgPg');
export const orgPg = stub('orgPg');
export const parseStoreIdentity = stub('parseStoreIdentity');
export const PG_BIGINT_AS_NUMBER_TYPES = stub('PG_BIGINT_AS_NUMBER_TYPES');
export const pgbouncerEnabled = stub('pgbouncerEnabled');
export const pgDiagnosticIdentity = stub('pgDiagnosticIdentity');
export const pinOrVerifyStoreIdentity = stub('pinOrVerifyStoreIdentity');
export const poolIdleTimeoutSec = stub('poolIdleTimeoutSec');
export const potsForGoal = stub('potsForGoal');
export const recordEphemeralFire = stub('recordEphemeralFire');
export const recordPgResult = stub('recordPgResult');
export const restoreRawJsonbSerializer = stub('restoreRawJsonbSerializer');
export const retryOnRetryableDbDeadline = stub('retryOnRetryableDbDeadline');
export const RoutineRow = stub('RoutineRow');
// Inert for the same reason as `setAdminPoolStatementTimeoutProvider` below — see that note
// for the full rule. `schemaOf(table)` derives three zod shapes FROM drizzle table metadata
// (libs/db/src/schema/zod.ts); it opens nothing and queries nothing. It is evaluated at MODULE
// TOP LEVEL by agent-mcp tool modules the child's graph drags in — e.g.
// `packages/agent-mcp/src/tools/harness/get.ts:19`, `const ProjectSelect = schemaOf(projects).select`
// — so a throwing binding kills the child mid-evaluation instead of at a Postgres call.
// The derived shapes are consumed by `z.infer<...>`, which tsx erases, so undefined is inert.
export const schemaOf = () => ({ insert: undefined, select: undefined, update: undefined });
export const SerializableRetryExhaustedError = stub('SerializableRetryExhaustedError');
export const SerializableRetryOptions = stub('SerializableRetryOptions');
// THE ONE DELIBERATE NO-OP, and the reason it is not "softening the stub" (WI-2141194 #9).
//
// Every other binding here throws when CALLED, which works because every other binding is
// called from a code PATH — the child can boot, and only a peer that actually reaches
// Postgres dies. This one is different: `agent-tools/locks/configure.ts` calls it at MODULE
// TOP LEVEL, and every operator-side locks shim imports that module for its side effect, so
// it runs while the child's graph is still being EVALUATED. A throwing binding there kills
// the child before it can emit a single event — which defeats this file's own stated goal
// ("satisfy the LINKER so the child boots far enough to report a real error") and surfaces
// as exactly the opaque 30s `expected null to match { evt: 'ready' }` timeout the docstring
// above describes. It is the same failure as a missing export, one stage later.
//
// Making it inert is sound rather than merely convenient: it REGISTERS a statement-timeout
// provider on the db-org connection factory. It opens nothing, queries nothing, and in this
// child the factory it would configure IS this stub — there is no org pool to construct, so
// there is no timeout to apply and no Postgres access to hide. Every binding that could
// actually reach a database still throws, so a perf run that touches PG still cannot be
// misread as a measurement.
//
// Keep this list to registration setters that are provably side-effect-free. Anything that
// opens, queries, listens or transacts stays a throwing `stub(...)`.
export const setAdminPoolStatementTimeoutProvider = () => {};
export const setRoutineActive = stub('setRoutineActive');
export const setRoutinesPerWorkspaceConflict = stub('setRoutinesPerWorkspaceConflict');
export const slugToSchemaName = stub('slugToSchemaName');
export const STORE_IDENTITY_SQL = stub('STORE_IDENTITY_SQL');
export const storeIdentityViolation = stub('storeIdentityViolation');
export const typedSql = stub('typedSql');
export const unlinkPot = stub('unlinkPot');
export const upsertRoutine = stub('upsertRoutine');
export const VerifiedTenantServerContext = stub('VerifiedTenantServerContext');
export const withAcquisitionDeadline = stub('withAcquisitionDeadline');
export const withDbCallDeadline = stub('withDbCallDeadline');
export const withHostedServiceContext = stub('withHostedServiceContext');
export const withSerializableRetry = stub('withSerializableRetry');
export const withTenantContext = stub('withTenantContext');
export const withWorkspace = stub('withWorkspace');
export const withWorkspaceLegacy = stub('withWorkspaceLegacy');
export const withWorkspaceQuery = stub('withWorkspaceQuery');
// 2026-09-05: names operator-core newly binds from @papercusp/db-org (the
// no-pg-stub-covers-db-org-imports guard names each with an example importer).
export const GoalPotLink = stub('GoalPotLink');
export const beginAcquire = stub('beginAcquire');
export const deriveTenantContext = stub('deriveTenantContext');
export const pgResultDiagnosticSnapshot = stub('pgResultDiagnosticSnapshot');
export const readBuildStamp = stub('readBuildStamp');
export const resetAcquireRegistryForTest = stub('resetAcquireRegistryForTest');
export const resetBuildStampResolver = stub('resetBuildStampResolver');
export const setBuildStampResolver = stub('setBuildStampResolver');
export const stampedTag = stub('stampedTag');
// 2026-09-20: pg diagnostic-correlation names operator-core newly binds from
// @papercusp/db-org (db-diagnostic-correlation-wiring.ts, dev/pg_health.test.ts).
export const PgResultDiagnosticCorrelation = stub('PgResultDiagnosticCorrelation');
export const capturePgDiagnosticContext = stub('capturePgDiagnosticContext');
export const createPgDiagnosticHooks = stub('createPgDiagnosticHooks');
export const resetPgDiagnosticContextResolver = stub('resetPgDiagnosticContextResolver');
export const setPgDiagnosticContextResolver = stub('setPgDiagnosticContextResolver');
// 2026-09-28: snapshot-read helper operator-core newly binds from @papercusp/db-org
// (carry-note.integration.test.ts and friends).
export const acquireSnapshot = stub('acquireSnapshot');
// 2026-10-02: completed-query diagnostic row type operator-core newly names from
// @papercusp/db-org (service-memory-attribution.integration.test.ts).
export const PgResultDiagnostic = stub('PgResultDiagnostic');

export default new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined; // never look thenable to `await import(...)`
      return refuse;
    },
  },
);
