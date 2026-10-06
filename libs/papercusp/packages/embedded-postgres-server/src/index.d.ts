/**
 * True when `value` holds a strong, non-default password for every role slot.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidRoleCredentials(value: unknown): boolean;
/**
 * Load this host's per-role PostgreSQL passwords from `file`, generating them on
 * first use. The file is written 0600 (parent created 0700) and must stay readable
 * ONLY by the account that runs the operator — it is the whole boundary between a
 * co-resident account and a DB superuser login.
 *
 * An EXISTING but unreadable/invalid file is a hard error, never a silent
 * regenerate: the cluster is keyed to the old owner password, so replacing it would
 * lock the operator out of its own database.
 *
 * @param {string} file
 * @param {{ generate?: () => string, log?: (m: string) => void }} [opts]
 * @returns {Promise<{ owner: string, admin: string, app: string, zero: string }>}
 */
export function loadOrCreateRoleCredentials(file: string, opts?: {
    generate?: () => string;
    log?: (m: string) => void;
}): Promise<{
    owner: string;
    admin: string;
    app: string;
    zero: string;
}>;
/**
 * The idempotent role bootstrap. With `rekey`, every framework role is ALTERed to
 * the given password on every boot, so a cluster first keyed to the repo-public
 * defaults (an upgrade, a legacy physical seed) converges to this host's secrets.
 * @param {{ owner?: string, admin: string, app: string, zero: string }} secrets
 * @param {{ rekey?: boolean }} [opts]
 */
export function roleBootstrapSql(secrets: {
    owner?: string;
    admin: string;
    app: string;
    zero: string;
}, { rekey }?: {
    rekey?: boolean;
}): string;
/**
 * Fail closed unless NO framework role still authenticates with its repo-public
 * default password. Every slot is probed with a real login; only a refused
 * password (28P01/28000) counts as closed — any other outcome is unverifiable and
 * refuses too, because this is the rail between a co-resident account and a DB
 * superuser.
 * @param {{ port: number, database: string, connect?: typeof openRoleClient }} opts
 */
export function assertNoDefaultRoleCredentials({ port, database, connect }: {
    port: number;
    database: string;
    connect?: typeof openRoleClient;
}): Promise<void>;
/**
 * Integrity check for a multi-account host: refuse to serve a cluster holding an
 * unexpected login/elevated role, or a harness_app that gained SUPERUSER. Either
 * means the database was altered through the default-password exposure and must
 * not be trusted.
 * @param {(strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>} sql
 */
export function assertNoRogueRoles(sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>): Promise<void>;
/**
 * Ensure the `zero_harness` logical-replication publication exists and is
 * correctly configured, then fold in any per-harness schemas. Called at boot
 * AFTER migrations (the schemas it references must exist) and imported by the
 * fresh-migrate integration guard so the EXACT boot DDL is tested.
 *
 * Scoping: FOR TABLES IN SCHEMA (not FOR ALL TABLES) — the latter captured
 * zero-cache's own bookkeeping schemas (papercusp_0/cvr, papercusp_0/cdc, audit)
 * and OOMed initial replication on workspaces with accumulated history. FOR
 * TABLES IN SCHEMA auto-includes new tables in the listed schemas.
 *
 * Note (WI-2914): agent_facts DELETEs under this delete-publishing publication
 * are made safe by migration 505 (surrogate PK + REPLICA IDENTITY DEFAULT), NOT
 * by any publication-level setting here — a deliberately version-agnostic fix
 * (the PG18-only `publish_generated_columns` route would break the PG16 test
 * container and any non-PG18 server). See that migration for the full root cause.
 */
export function ensureZeroHarnessPublication(sql: any): Promise<void>;
/** True when `value` is a runtime lc_* value valid on EVERY target libc (incl. macOS). Pure. */
export function localeIsUniversal(value: any): boolean;
/**
 * Extract the `--locale=<value>` an initdb flag list requests, or null if none.
 * Pure. Handles both the `--locale=X` and the split `--locale X` spellings.
 */
export function initdbLocale(flags?: any[]): any;
/**
 * True when `flags` pin an EXPLICIT, portable initdb locale — i.e. the resulting
 * cluster's postgresql.conf lc_* will name a locale present on a lean host, never
 * a host-specific one like en_US.UTF-8. A MISSING `--locale` is NOT portable: it
 * makes initdb inherit the build host's LANG, which is the exact WI-2649
 * regression. Pure — the WI-2649 recurrence guard asserts on this.
 */
export function initdbLocaleIsPortable(flags?: any[]): boolean;
/** True when `value` names a locale present on every lean target rootfs. Pure. */
export function localeIsPortable(value: any): boolean;
/**
 * Return the list of `param='value'` for every ACTIVE (uncommented) RUNTIME_LC_PARAMS
 * assignment in a postgresql.conf whose value is not UNIVERSAL — empty means the
 * conf will boot on every target libc (lean WSL rootfs AND macOS). Pure; the
 * WI-2749 recurrence guard asserts empty. Judged against UNIVERSAL_LC_VALUES,
 * not PORTABLE_INITDB_LOCALES: `C.UTF-8` passes the glibc-only initdb set but
 * FATALs macOS's postmaster (2026-07-05).
 */
export function confLcNonPortable(confText: any): string[];
/**
 * Rewrite every ACTIVE RUNTIME_LC_PARAMS assignment whose value is not universal
 * to `portableLocale`, preserving the trailing comment + surrounding formatting.
 * Pure — returns { text, changed }. Idempotent: a conf already universal is a
 * no-op. Default 'C' — the only spelling (with POSIX) every libc accepts; the
 * previous default C.UTF-8 was itself the macOS FATAL (see UNIVERSAL_LC_VALUES).
 */
export function normalizeConfLc(confText: any, portableLocale?: string): {
    text: any;
    changed: boolean;
};
/**
 * Force every runtime-settable lc_* GUC in <dataDir>/postgresql.conf to a
 * PORTABLE locale, on disk, before the postmaster starts. Run on EVERY boot
 * (fresh initdb, extracted seed, AND a reused/possibly-pre-fix data dir) so an
 * already-installed broken cluster self-heals on update rather than staying
 * wedged. Idempotent + best-effort: a missing conf (no initdb yet) is a no-op.
 * See SEED_INITDB_FLAGS / normalizeConfLc for the why (WI-2749).
 */
export function normalizePortableLocaleConf(dataDir: any, log?: () => void): Promise<void>;
/**
 * Resolve the effective pre-built-seed path from opts + env (pure — the caller
 * checks existence). opts.seedPath wins, then PAPERCUSP_PG_SEED_PATH env;
 * PAPERCUSP_PG_DISABLE_SEED (any truthy value) forces null (always initdb).
 * Returns null when no seed is configured.
 */
export function resolveSeedPath(opts?: {}, env?: NodeJS.ProcessEnv): any;
/**
 * Classify the seed representation without opening it. New bundles ship a
 * pg_dump custom archive (`.dump` / `.backup`); older bundles may still carry
 * a physical PGDATA directory/tar. Keeping this decision at the existing
 * seedPath seam lets upgraded runtimes boot both formats without cloning a
 * cluster identity in newly-built artifacts.
 */
export function seedKind(seedPath: any): "logical" | "physical" | null;
/**
 * Extract a pre-built PGDATA seed into `dataDir`. `seedPath` may be a directory
 * (raw PGDATA — recursively copied) or a `.tar`/`.tar.gz` archive whose ROOT is
 * the PGDATA contents (extracted with the system `tar`, gzip auto-detected;
 * present on macOS/Linux/Win10+). Postgres requires the data dir be mode 0700,
 * so we chmod it after (no-op on Windows). Throws on any failure so the caller
 * can wipe + fall back to a clean initdb — never boot a half-extracted dir.
 */
export function extractSeed(seedPath: any, dataDir: any): Promise<void>;
/**
 * Every role a logical seed's restore SQL grants to, revokes from, or names in a
 * row-level-security policy. pg_dump never serializes roles (they are
 * cluster-global), so a seed built on a cluster where a migration created a role
 * (978 creates hosted_owner/hosted_app/hosted_service) carries GRANTs and policies
 * naming a role the fresh install's cluster does not have, and `pg_restore
 * --exit-on-error` then fails on the first one (WI-10004427). Reading the names
 * out of the dump itself keeps this correct for any future role-creating migration.
 *
 * @param {string} restoreSql output of `pg_restore --schema-only --no-owner --file -`
 * @returns {string[]} sorted, de-duplicated role names, excluding PUBLIC,
 *          CURRENT_USER/CURRENT_ROLE/SESSION_USER and PostgreSQL's pg_* built-ins
 */
export function granteeRolesInRestoreSql(restoreSql: string): string[];
/**
 * The roles a pg_dump custom archive references (see granteeRolesInRestoreSql).
 * `pg_restore --file -` renders the archive's SQL without connecting to a server.
 *
 * @param {string} seedPath
 * @param {{ pgRestoreBin?: string }} [opts]
 * @returns {string[]}
 */
export function logicalSeedGranteeRoles(seedPath: string, { pgRestoreBin, }?: {
    pgRestoreBin?: string;
}): string[];
/**
 * Create, with SEED_ROLE_ATTRIBUTES, every seed-referenced role the cluster lacks.
 * Existing roles are left untouched.
 *
 * @param {import('postgres').Sql} sql a connection allowed to CREATE ROLE
 * @param {string[]} roles
 * @returns {Promise<string[]>} the roles this call created
 */
export function createMissingSeedRoles(sql: import("postgres").Sql, roles: string[]): Promise<string[]>;
/**
 * Restore a pg_dump custom archive into an ALREADY-INITIALISED fresh cluster.
 * initdb must run before this helper: its per-cluster system_identifier is the
 * identity boundary WI-39304 requires. `--single-transaction` makes a failed
 * restore safe to abandon in favour of the normal migration replay; no partial
 * schema/data is left behind. Keep privileges (the framework roles already
 * exist), but never replay build-box ownership.
 *
 * @param {string} seedPath
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} [opts.dbName]
 * @param {string} [opts.pgRestoreBin]
 * @param {string} [opts.ownerSecret] The cluster owner's password (default: the DEV default).
 */
export function restoreLogicalSeed(seedPath: string, { port, dbName, pgRestoreBin, ownerSecret, }: {
    port: number;
    dbName?: string | undefined;
    pgRestoreBin?: string | undefined;
    ownerSecret?: string | undefined;
}): void;
/**
 * @param {object} opts
 * @param {string} [opts.dataDir]      Postgres data dir. Default: ~/.papercusp/embedded-pg-data
 * @param {number} [opts.port]         TCP port. Default: 5532 (avoiding 5432 collision with system PG).
 * @param {string} [opts.dbName]       Database to create + connect to. Default: papercusp.
 * @param {boolean} [opts.debug]
 * @param {string} [opts.dbSqlDir]     Directory of *.sql migration files. If set, migrations apply on every boot.
 * @param {string} [opts.seedPath]     Path to a pre-built logical `.dump` / `.backup` seed (current),
 *        or a legacy physical PGDATA directory / .tar(.gz). A logical seed is restored only AFTER a
 *        fresh per-install initdb, so every install keeps a distinct system_identifier while avoiding
 *        the full migration replay. Legacy physical seeds remain readable for already-built bundles.
 *        The idempotent runner still applies any migration DELTA afterwards. Falls back to
 *        PAPERCUSP_PG_SEED_PATH env, or to clean initdb + replay if absent/unusable. Force-disable with
 *        PAPERCUSP_PG_DISABLE_SEED=1.
 * @param {string} [opts.pgRestoreBin] pg_restore executable for logical seeds. Default:
 *        PAPERCUSP_PG_RESTORE_BIN, then `pg_restore` from PATH.
 * @param {Record<string,string>} [opts.extraPostgresSettings] Host-scaled server knobs
 *        (max_connections, shared_buffers, parallelism, …) the caller derived from
 *        resource-profile (`databaseTuningToSettings(getResourceProfile().database)`).
 *        Empty by default → stock PG defaults (backward compatible). Passing them is
 *        how the desktop's embedded PG autoadjusts to the machine instead of running
 *        on the laptop-sized stock `max_connections=100` / `shared_buffers=128MB`.
 * @param {string} [opts.credentialsFile] Multi-account hosts (WI-10003627): path of a 0600
 *        file holding this host's per-role passwords, generated on first boot. When set,
 *        every role (owner, harness_admin, harness_app, harness_zero) is keyed to its
 *        generated password on every boot — re-keying a cluster first keyed to the
 *        repo-public defaults — and boot REFUSES while any default still authenticates
 *        or an unexpected privileged role exists. Unset keeps the documented DEV defaults.
 * @param {(m: string) => void} [opts.onLog]
 * @param {boolean} [opts.supervise] Restart the postmaster with capped backoff when it
 *        exits without a stop() request (WI-10003688). Default: true.
 * @param {readonly number[]} [opts.restartBackoffMs] Override the restart delays
 *        (default PG_RESTART_BACKOFF_MS; the last step repeats).
 * @param {(e: import('./pg-supervisor.js').PostgresExitEvent) => void} [opts.onPostgresExit]
 *        Called on every unexpected postmaster exit and every failed restart attempt.
 * @param {(e: { attempt: number }) => void} [opts.onPostgresRestarted]
 *        Called when a supervised restart reaches "ready to accept connections".
 */
export function startEmbeddedPostgresServer(opts?: {
    dataDir?: string | undefined;
    port?: number | undefined;
    dbName?: string | undefined;
    debug?: boolean | undefined;
    dbSqlDir?: string | undefined;
    seedPath?: string | undefined;
    pgRestoreBin?: string | undefined;
    extraPostgresSettings?: Record<string, string> | undefined;
    credentialsFile?: string | undefined;
    onLog?: ((m: string) => void) | undefined;
    supervise?: boolean | undefined;
    restartBackoffMs?: readonly number[] | undefined;
    onPostgresExit?: ((e: import("./pg-supervisor.js").PostgresExitEvent) => void) | undefined;
    onPostgresRestarted?: ((e: {
        attempt: number;
    }) => void) | undefined;
}): Promise<{
    /** TCP port the postmaster is listening on. */
    port: number;
    /** Database name created/used. */
    dbName: string;
    /** Owner credentials. */
    user: string;
    password: string;
    /** True when roles are keyed to per-host generated passwords (`credentialsFile`). */
    hostCredentials: boolean;
    /** Connection URLs for common roles (matches connection.ts expectations). */
    urls: {
        admin: string;
        app: string;
        zero: string;
    };
    /**
     * Postmaster supervision state (WI-10003688). `null` when started with
     * `supervise: false`.
     * @returns {import('./pg-supervisor.js').PostgresSupervisorHealth | null}
     */
    health(): import("./pg-supervisor.js").PostgresSupervisorHealth | null;
    stop(): Promise<void>;
}>;
/**
 * The repo-public default role passwords (WI-10003627). They are the documented
 * DEV convention libs/db/src/connection.ts falls back to, and they are safe only
 * where every local account is the same trust principal (a developer box, a
 * single-user desktop). On a MULTI-ACCOUNT host — a hosted workspace VM, where the
 * customer account shares loopback with the service user — they hand every local
 * account a DB SUPERUSER login: loopback TCP is not a uid boundary, and PostgreSQL
 * cannot restrict a TCP login by the connecting uid. Measured on a hosted VM
 * (2026-09-28): the customer uid logged in as harness_admin (rolsuper) with its
 * repo-public default. Such hosts must pass `credentialsFile` so every role gets a
 * per-host random password and boot refuses while any default still authenticates.
 */
export const DEFAULT_ROLE_PASSWORDS: Readonly<{
    owner: "postgres";
    admin: "harness_admin_pwd";
    app: "harness_app_pwd";
    zero: "harness_zero_pwd";
}>;
/** The PostgreSQL role behind each credential slot. */
export const ROLE_NAMES: Readonly<{
    owner: "postgres";
    admin: "harness_admin";
    app: "harness_app";
    zero: "harness_zero";
}>;
/**
 * Roles a hosted cluster may hold with LOGIN or any elevated attribute. The
 * migrations create none, so anything else was planted by a co-resident account
 * while the default passwords were live.
 */
export const EXPECTED_PRIVILEGED_ROLES: readonly ("postgres" | "harness_admin" | "harness_app" | "harness_zero")[];
/**
 * The initdb flags used for EVERY fresh cluster this package creates — the
 * build-time source database and every target install (including a logical-seed
 * restore target). The dump itself carries no postgresql.conf; the destination
 * cluster always inherits these flags from its own initdb. SINGLE SOURCE OF
 * TRUTH — do not inline a divergent locale.
 *
 * Pinning an explicit UNIVERSAL locale here is load-bearing. initdb otherwise
 * derives lc_* from the build/runtime host's LANG, so a seed built on a
 * full-locale host (LANG=en_US.UTF-8) bakes lc_*='en_US.UTF-8' into
 * postgresql.conf — which then FATALs at first boot on the minimal Windows WSL
 * rootfs (papercup-runtime ships only C / C.utf8 / POSIX — no en_US.UTF-8):
 * "configuration file contains errors: invalid value for parameter lc_numeric:
 * en_US.UTF-8". Found live 2026-07-04 (WI-2649): the seed extracted fine but
 * postgres refused to start.
 *
 * The locale MUST be `C`, not `C.UTF-8`. `C.UTF-8` is a glibc-ism: it exists on
 * every Linux/WSL host but macOS's BSD libc has NO such locale, so `initdb
 * --locale=C.UTF-8` FATALs OUTRIGHT on macOS — "initdb: error: invalid locale
 * name \"C.UTF-8\"" — before any conf is even written (found live on the mac
 * build VM 2026-07-05: seed generation aborted, AND the runtime fallback below
 * would identically FATAL on a fresh user Mac, leaving the app unable to
 * initialise its DB at all). `C` is the ONE locale POSIX guarantees on every libc (glibc, musl,
 * macOS, Windows) and every PG version. Its collation is byte-order (memcmp) —
 * BIT-IDENTICAL to glibc `C.UTF-8`'s collation, so sort/index order is
 * unchanged; the only delta is lc_ctype (ASCII-only upper/lower vs UTF-8-aware),
 * immaterial for this control-plane DB and already the accepted trade for the
 * runtime lc_* (normalized to `C` too — see UNIVERSAL_LC_VALUES). `--encoding=UTF8`
 * keeps UTF-8 STORAGE regardless of the C ctype. Only affects a FRESH initdb
 * (seed build + the seedless fallback); existing data dirs are untouched.
 *
 * `--lc-messages=C` is NOT redundant with `--locale`: the bundled
 * `embedded-postgres` package hard-injects `--lc-messages=<getBestLocale()>`
 * into initdb BEFORE these flags (it greps the initdb readiness banner, so it
 * forces a known-locale), and getBestLocale() prefers `en_US.UTF-8` when the
 * BUILD host has it. A per-category `--lc-messages` overrides `--locale` for
 * that one category regardless of `--locale`, so without pinning it explicitly
 * (later, so initdb's last-duplicate-wins picks ours) the seed baked
 * `lc_messages='en_US.utf8'` while every other lc_* was C — and THAT one
 * param FATALed first boot on the lean rootfs (WI-2749, follow-on to WI-2649).
 * normalizeConfLc() below is the deterministic belt-and-suspenders.
 */
export const SEED_INITDB_FLAGS: string[];
/**
 * The runtime-settable lc_* GUCs that live in postgresql.conf and are VALIDATED
 * against the OS locale set at postmaster startup — a non-portable value here
 * (e.g. en_US.utf8 on a C/C.utf8/POSIX-only rootfs) is the exact "invalid value
 * for parameter <lc_*>" FATAL of WI-2649 / WI-2749. (lc_collate / lc_ctype are
 * initdb-fixed in pg_database, not re-validated at start, so they are not here.)
 */
export const RUNTIME_LC_PARAMS: string[];
/**
 * Locales acceptable as the INITDB --locale pin (lc_collate/lc_ctype, baked
 * into pg_database at initdb time) on EVERY platform this package ships to.
 *
 * ⚠ `C.UTF-8` is deliberately NOT here. It is glibc-only: valid at initdb on
 * Linux/WSL but REJECTED by macOS's BSD libc ("initdb: error: invalid locale
 * name \"C.UTF-8\"", mac build VM 2026-07-05). Since a desktop build targets
 * macOS too, the only initdb locales portable across ALL targets are exactly the
 * POSIX-guaranteed `C` / `POSIX` — which makes this set identical to
 * UNIVERSAL_LC_VALUES now. (It was ['C','POSIX','C.UTF-8',…] pre-macOS, when
 * C.UTF-8's UTF-8 ctype looked worth the glibc-only bet — that bet is what
 * bricked the mac build. Do NOT re-add C.UTF-8: it re-arms the macOS FATAL.)
 * initdb-time and runtime lc_* now share one universal set: `C` / `POSIX`.
 */
export const PORTABLE_INITDB_LOCALES: string[];
/**
 * Locale values valid for the RUNTIME_LC_PARAMS on EVERY libc a desktop build
 * ships to — glibc (Linux/WSL), musl, **macOS BSD libc**, and Windows. This is
 * exactly the POSIX-guaranteed set: `C.UTF-8` is a glibc-ism that macOS
 * setlocale() REJECTS, so a conf carrying lc_messages='C.UTF-8' FATALs the
 * postmaster on macOS ("invalid value for parameter lc_messages", found live on
 * the mac VM 2026-07-05, WI-2945 fallout — the WI-2749 normalizer itself had
 * stamped it there). The runtime lc_* params control message/number/date
 * FORMATTING only (never collation/ctype), so plain 'C' loses nothing.
 */
export const UNIVERSAL_LC_VALUES: string[];
export const SEED_ROLE_ATTRIBUTES: "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS";
declare function openRoleClient({ port, user, password, database }: {
    port: any;
    user: any;
    password: any;
    database: any;
}): postgres.Sql<{}>;
import postgres from 'postgres';
export { applyPendingMigrations, defaultSkipFile, migrationTransactionChunks } from "./migration-runner.js";
export { PG_DEATH_LOG_WINDOW, PG_RESTART_BACKOFF_MS, childHasExited, classifyPostgresDeath, createPostgresLogWindow, superviseEmbeddedPostgres } from "./pg-supervisor.js";
