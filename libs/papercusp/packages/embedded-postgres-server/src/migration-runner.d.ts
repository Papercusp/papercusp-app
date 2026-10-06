/**
 * Schema-qualified `schema.relation` names a migration chunk mentions, in first-seen order.
 * Non-relations (`alias.column`, `schema.function`) are harmless: they match no
 * pg_class row in {@link describeMigrationLockHolders}.
 * @param {string} ddl
 * @returns {string[]}
 */
export function migrationRelationNames(ddl: string): string[];
/**
 * WI-10004820: a SQLSTATE 55P03 means ANOTHER session holds a lock this
 * migration's DDL conflicts with. When the retry and failure lines named no
 * holder, a staging boot crash loop on migration 1295 (a 40-minute ad-hoc
 * `psql` read holding ACCESS SHARE on the altered table) was attributed to
 * backup contention. Name the granted relation-lock holders on the relations
 * the failing chunk mentions, oldest transaction first, so the log answers "who".
 * Read-only catalog query, run after the failed transaction was rolled back.
 * Never throws: a failed diagnosis is reported inline instead of masking the 55P03.
 * @param {{ unsafe: (sql: string) => Promise<unknown> }} client
 * @param {string} ddl the chunk that hit the lock timeout
 * @returns {Promise<string>}
 */
export function describeMigrationLockHolders(client: {
    unsafe: (sql: string) => Promise<unknown>;
}, ddl: string): Promise<string>;
/** @param {string} ddl */
export function migrationTransactionChunks(ddl: string): string[];
export function defaultSkipFile(f: any): any;
/**
 * Order numbered migrations by numeric prefix, then by complete filename for
 * deterministic ties. Plain string sorting breaks at four digits: `1003-*`
 * sorts before `374-*`, so a fresh database can run a dependent migration
 * before the table it targets exists. Unnumbered SQL files sort last.
 *
 * The @returns {number} is load-bearing. tsc prints a literal union such as
 * `-1 | 0 | 1` in type-identity order, even when written explicitly, and that
 * order depends on which files are in the program: gen:types (old .d.ts
 * deleted) and embedded-pg-declarations.test.ts (old .d.ts present) emitted
 * different orders from the same source. `number` prints deterministically,
 * and it is what Array.prototype.sort expects.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareMigrationFilenames(a: string, b: string): number;
/**
 * @param {object} args
 * @param {object} args.client    postgres-js client (sql tag) OR object with `.unsafe(text)` method.
 * @param {string} args.sqlDir    Directory of *.sql files.
 * @param {(s: string) => void} [args.log]
 * @param {(file: string) => boolean} [args.skipFile]   Optional filter; defaults to skipping the per-harness template.
 * @param {(file: string, raw: string) => void | Promise<void>} [args.beforeApply] Optional fail-closed guard run after the file is read and before its SQL executes.
 * @param {number} [args.migrationStatementTimeoutMs] Optional positive per-migration
 *   database deadline in milliseconds. Omitted preserves the production boot
 *   contract (`SET LOCAL statement_timeout = 0`); bounded test setup passes an
 *   explicit value so a stuck DDL/backend phase cannot outlive the runner.
 * @param {boolean} [args.dataDirWasReused] Whether embedded boot found an existing
 *   PGDATA directory. When provided, failure diagnostics distinguish schema drift
 *   in reused data from a broken fresh-install migration/prerequisite.
 * @param {boolean} [args.continueOnError]   Default false (fail-loud — embedded-pg
 *   boot + the fresh-migrate gate rely on a broken migration HALTING). Pass true
 *   on the shared native-:5432 operator boot (handoff-coordination-dx-followups A1):
 *   a migration that fails to apply is logged + collected in the returned `failed`
 *   array and the boot CONTINUES (the bad file stays unrecorded → retried next
 *   boot), so one peer's broken migration can't wedge the dev-api for the fleet.
 */
export function applyPendingMigrations({ client, sqlDir, log, skipFile, beforeApply, migrationStatementTimeoutMs, dataDirWasReused, continueOnError }: {
    client: object;
    sqlDir: string;
    log?: ((s: string) => void) | undefined;
    skipFile?: ((file: string) => boolean) | undefined;
    beforeApply?: ((file: string, raw: string) => void | Promise<void>) | undefined;
    migrationStatementTimeoutMs?: number | undefined;
    dataDirWasReused?: boolean | undefined;
    continueOnError?: boolean | undefined;
}): Promise<{
    appliedCount: number;
    totalKnown: number;
    failed: {
        file: string;
        error: string;
    }[];
}>;
