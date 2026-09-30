/**
 * Idempotent migration runner.
 *
 * Tracks applied SQL files in `harness_shared.schema_migrations` (filename
 * is the natural key). On every boot:
 *   1. Ensure schema_migrations exists.
 *   2. Read the SQL dir, filter to *.sql sorted by filename.
 *   3. For each file not already in schema_migrations, apply it inside a
 *      transaction and INSERT a row. Files carrying the established
 *      `--> statement-breakpoint` delimiter run each chunk in its own
 *      transaction and record the file only with the final chunk.
 *
 * This fixes the long-standing bug where pglite-server only applied SQL on
 * "first boot" (when harness_shared didn't exist), causing migrations
 * authored after the DB was first booted to silently never run. Found in
 * the wild on 2026-05-05 — the symptom was provisioning failing with
 * `column "kind" of relation "token_index" does not exist` because
 * 009-workspace-scoping.sql had never been applied.
 *
 * Per-harness templates ({{SCHEMA}}-substituted) are NOT tracked here —
 * those are scaffolded on demand by scaffold-harness-schema.sh and don't
 * have a single file path.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MIGRATION_TRANSACTION_PREFIX = 'BEGIN;\nSET LOCAL statement_timeout = 0;\n';
// WI-41781: a fresh-schema replay applies hundreds of migrations while many
// integration forks share one Postgres container. Parallel SELECT/aggregate
// plans buy nothing on that empty schema but each can request a dynamic shared-
// memory segment; a fleet burst exhausted /dev/shm and aborted migration 859
// before any test ran. Transaction-local keeps the production session default
// untouched and scopes the guard to bulk (fresh-install/template) replay only.
const MAX_STATEMENT_EXCERPT_CHARS = 320;
// A migration keeps the caller's fail-fast lock_timeout so it never queues an
// ACCESS EXCLUSIVE request ahead of ordinary readers. A transient 55P03 still
// gets a small, bounded chance to win the lock race again after its aborted
// transaction is rolled back. Keep this retry here, at the shared runner seam,
// so embedded boot and every other runner caller get the same behavior.
const MIGRATION_LOCK_RETRY_MAX_ATTEMPTS = 3;
const MIGRATION_LOCK_RETRY_BASE_DELAY_MS = 400;
const MIGRATION_LOCK_RETRY_MAX_DELAY_MS = 2_000;

/** @param {number} attempt 1-based failed-attempt number */
function migrationLockRetryBackoffMs(attempt) {
  return Math.min(MIGRATION_LOCK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MIGRATION_LOCK_RETRY_MAX_DELAY_MS);
}

/** @param {unknown} error */
function isMigrationLockTimeout(error) {
  if (!error || typeof error !== 'object') return false;
  return /** @type {{ code?: unknown }} */ (error).code === '55P03';
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** @param {number} statementTimeoutMs @param {boolean} bulkApply */
function migrationTransactionPrefix(statementTimeoutMs, bulkApply) {
  const prefix = `BEGIN;\nSET LOCAL statement_timeout = ${statementTimeoutMs};\n`;
  return bulkApply ? `${prefix}SET LOCAL max_parallel_workers_per_gather = 0;\n` : prefix;
}

// Drizzle's generated schema and @papercusp/test-config already use this exact
// marker to delimit statements that must run in separate autocommit
// transactions. Honour the same convention in the production runner. This is
// intentionally opt-in: ordinary migrations retain the all-or-nothing
// transaction they have always had, while a migration touching several
// unrelated fleet-hot relations can avoid holding one relation's ACCESS
// EXCLUSIVE lock while it waits for the next (the migration-1154 deadlock
// class).
//
// A breakpoint migration MUST be idempotent. If chunk N fails, chunks 1..N-1
// are already committed but the schema_migrations row is absent; the next run
// therefore replays the earlier chunks before retrying N. The ledger write is
// included only in the final chunk's transaction, so it can never claim a
// partially-applied file as complete.
const STATEMENT_BREAKPOINT = /-->\s*statement-breakpoint/g;

/** @param {string} ddl */
export function migrationTransactionChunks(ddl) {
  if (!ddl.includes('statement-breakpoint')) return [ddl];
  return ddl
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.trim())
    // Do not use a repeated group with an optional newline here. A long
    // comment containing "--" followed by SQL makes that pattern explore
    // exponentially many partitions, blocking migration bootstrap entirely.
    .filter((chunk) => chunk.length > 0 && chunk.split('\n').some((line) => {
      const text = line.trim();
      return text.length > 0 && !text.startsWith('--');
    }));
}

const SCHEMA_MIGRATIONS_DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sha256 TEXT NOT NULL
  );
`;

async function sha256(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Return a compact excerpt of the top-level SQL statement containing `offset`.
 * The scanner mirrors the proven quote handling in operator-core's baseline
 * sanitizer without importing that higher-level package into this low-level
 * embedded-PG runtime. It additionally handles double quotes + nested block
 * comments because migration files are hand-authored, not only pg_dump output.
 *
 * @param {string} sql
 * @param {number} offset Zero-based JavaScript string offset into `sql`.
 * @returns {string | null}
 */
function statementExcerptAt(sql, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= sql.length) return null;

  let statementStart = 0;
  let statementEnd = sql.length;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  /** @type {string | null} */
  let dollarTag = null;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (ch === '/' && next === '*') {
        blockCommentDepth += 1;
        i += 1;
      } else if (ch === '*' && next === '/') {
        blockCommentDepth -= 1;
        i += 1;
      }
      continue;
    }
    if (dollarTag !== null) {
      if (ch === '$' && sql.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (next === "'") i += 1;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (next === '"') i += 1;
        else inDouble = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockCommentDepth = 1;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch !== ';') continue;

    if (offset <= i) {
      statementEnd = i + 1;
      break;
    }
    statementStart = i + 1;
  }

  let excerptStart = statementStart;
  let excerptEnd = statementEnd;
  if (statementEnd - statementStart > MAX_STATEMENT_EXCERPT_CHARS) {
    excerptStart = Math.max(statementStart, offset - Math.floor(MAX_STATEMENT_EXCERPT_CHARS / 2));
    excerptEnd = Math.min(statementEnd, excerptStart + MAX_STATEMENT_EXCERPT_CHARS);
    excerptStart = Math.max(statementStart, excerptEnd - MAX_STATEMENT_EXCERPT_CHARS);
  }

  const leadingEllipsis = excerptStart > statementStart ? '…' : '';
  const trailingEllipsis = excerptEnd < statementEnd ? '…' : '';
  const excerpt = sql.slice(excerptStart, excerptEnd).replace(/\s+/g, ' ').trim();
  return excerpt ? `${leadingEllipsis}${excerpt}${trailingEllipsis}` : null;
}

/**
 * Translate postgres-js's one-based position in the complete transaction query
 * into the executed migration text. PostgreSQL counts Unicode characters; the
 * returned offset is converted back to JavaScript's UTF-16 string indexing.
 *
 * @param {unknown} value
 * @param {string} ddl
 * @param {string} [queryPrefix]
 * @returns {{ character: number, offset: number } | null}
 */
function migrationPosition(value, ddl, queryPrefix = MIGRATION_TRANSACTION_PREFIX) {
  const queryCharacter = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(queryCharacter)) return null;

  const character = queryCharacter - Array.from(queryPrefix).length;
  const ddlCharacters = Array.from(ddl);
  if (character < 1 || character > ddlCharacters.length) return null;
  return {
    character,
    offset: ddlCharacters.slice(0, character - 1).join('').length,
  };
}

/**
 * Add the migration context that a raw postgres-js ErrorResponse cannot carry.
 * This is the single diagnostic used by both fail-loud embedded boot and the
 * shared native boot's continue-on-error path.
 *
 * @param {object} args
 * @param {unknown} args.cause
 * @param {string} args.file
 * @param {string} args.migrationPath
 * @param {string} args.ddl Executed SQL after psql metacommands are stripped.
 * @param {boolean | undefined} args.dataDirWasReused
 * @param {boolean} args.haltBoot
 * @param {string} [args.queryPrefix]
 * @returns {Error}
 */
function wrapMigrationFailure({
  cause,
  file,
  migrationPath,
  ddl,
  dataDirWasReused,
  haltBoot,
  queryPrefix = MIGRATION_TRANSACTION_PREFIX,
}) {
  const details = /** @type {{ message?: unknown, code?: unknown, position?: unknown }} */ (
    cause && typeof cause === 'object' ? cause : {}
  );
  const causeMessage = String(details.message ?? cause ?? 'unknown migration error');
  const sqlState = details.code ? ` (SQLSTATE ${String(details.code)})` : '';
  const position = migrationPosition(details.position, ddl, queryPrefix);
  const excerpt = position ? statementExcerptAt(ddl, position.offset) : null;

  const lines = [
    `Migration ${file} FAILED: ${causeMessage}${sqlState}`,
    `Migration file: ${migrationPath}`,
  ];
  if (position && excerpt) {
    lines.push(`Offending statement near migration character ${position.character}: ${excerpt}`);
  } else {
    lines.push('The underlying error did not report a usable query position; inspect the migration file directly.');
  }
  if (dataDirWasReused === true) {
    lines.push('This boot reused an existing Postgres data directory; its schema may predate assumptions in this migration.');
  } else if (dataDirWasReused === false) {
    lines.push('This boot created a fresh Postgres data directory; the migration or one of its prerequisites is invalid.');
  }
  if (/type "vector" does not exist/.test(causeMessage)) {
    lines.push(
      'The pgvector extension is missing from this Postgres. For the embedded database run `node scripts/install-embedded-pgvector.mjs` from the repository root after installing pgvector for the embedded Postgres major (Debian/Ubuntu: `sudo apt install postgresql-18-pgvector`; macOS: `brew install pgvector`), then restart.',
    );
  }
  lines.push(
    haltBoot
      ? 'The operator cannot start until this migration applies. Inspect the migration and database schema, repair the mismatch or missing prerequisite, then restart Papercusp.'
      : 'This migration remains pending and will retry on the next boot. Inspect the migration and database schema, then repair the mismatch or missing prerequisite.',
  );

  const wrapped = new Error(lines.join('\n'), { cause });
  wrapped.name = 'MigrationError';
  return wrapped;
}

// Files that the migration runner must NOT auto-apply on boot. These
// are one-shot manual data backfills that depend on `psql -v` variable
// substitution (`:key` expansion) — sending them raw to postgres-js
// produces "syntax error at or near :".
const MANUAL_ONLY = new Set([
  '040-plugin-configs-backfill.sql', // requires PAPERCUSP_DB_ENCRYPTION_KEY via psql -v key=...
  '__seed_restored__.marker',         // sentinel inserted by seed-restore path; not a real migration file
]);

// EI-19403856469813053: extracted (pure refactor, same predicate as before) so a
// caller that wants to layer ITS OWN skip logic on top (e.g. db-boot-migrate.ts's
// cross-boot failure cooldown, below) can compose with the real default instead
// of re-deriving/duplicating `per-harness-template` + MANUAL_ONLY knowledge that
// lives here.
export function defaultSkipFile(f) {
  return f.includes('per-harness-template') || MANUAL_ONLY.has(f);
}

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
export function compareMigrationFilenames(a, b) {
  const aMatch = a.match(/^(\d+)(?:-|$)/);
  const bMatch = b.match(/^(\d+)(?:-|$)/);
  if (aMatch && bMatch) {
    const aNumber = BigInt(aMatch[1]);
    const bNumber = BigInt(bMatch[1]);
    if (aNumber < bNumber) return -1;
    if (aNumber > bNumber) return 1;
  } else if (aMatch) {
    return -1;
  } else if (bMatch) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// ⚠ KEEP THE JSDOC BLOCK BELOW ADJACENT TO THE FUNCTION. It used to sit ABOVE
// `MANUAL_ONLY`, so TypeScript bound it to that const instead of to
// `applyPendingMigrations` — every `@param` was silently inert and all four
// parameters inferred as `any` (and `skipFile` as REQUIRED), in a function that
// looked fully documented. Anything inserted between the block and the function
// re-breaks it. The generated `migration-runner.d.ts` + its drift test are the
// recurrence guard: detach it again and the regenerated declaration falls back
// to `any`, which fails the compare loudly instead of silently widening types.
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
export async function applyPendingMigrations({ client, sqlDir, log = () => {}, skipFile, beforeApply, migrationStatementTimeoutMs, dataDirWasReused, continueOnError = false }) {
  const effectiveMigrationStatementTimeoutMs = migrationStatementTimeoutMs ?? 0;
  if (!Number.isSafeInteger(effectiveMigrationStatementTimeoutMs) || effectiveMigrationStatementTimeoutMs < 0) {
    throw new TypeError(`migrationStatementTimeoutMs must be a non-negative integer; got ${migrationStatementTimeoutMs}`);
  }
  const skip = skipFile ?? defaultSkipFile;
  const failed = [];

  // Ensure tracker exists.
  await client.unsafe(SCHEMA_MIGRATIONS_DDL);

  // Read files.
  const allFiles = (await readdir(sqlDir))
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !skip(f))
    .sort(compareMigrationFilenames);

  // Read applied set.
  const appliedRows = await client.unsafe(
    `SELECT filename FROM harness_shared.schema_migrations`,
  );
  const applied = new Set((appliedRows ?? []).map((r) => r.filename));

  // First-boot fast path (desktop first-launch perf). A fresh install applies the
  // full migration set (~370 files); each file COMMITs in its own txn → one WAL fsync
  // per file, and those ~370 serial fsyncs dominate the desktop's ~10s first-boot wait
  // (measured: cold 13s vs warm 3s — the ~10s delta is initdb + this apply). For a large
  // batch (a fresh initdb) drop synchronous_commit so those commits don't each fsync,
  // then synchronously commit a ledger write after the loop so the applied schema is durable before
  // the operator touches the DB. SAFE: `client` is a dedicated, short-lived boot-setup
  // connection (embedded-postgres-server postgres({ max: 1 })), and a crash mid-apply
  // leaves an INCOMPLETE data dir that first-boot discards + re-initdb's — nothing durable
  // is lost. Normal update boots (a handful of new files) keep synchronous_commit=on.
  const pendingCount = allFiles.reduce((n, f) => (applied.has(f) ? n : n + 1), 0);
  const bulkApply = pendingCount >= 20;
  if (bulkApply) await client.unsafe('SET synchronous_commit = off').catch(() => {});

  let appliedCount = 0;
  let lastAppliedFile = null;
  for (const f of allFiles) {
    if (applied.has(f)) continue;
    const ddlRaw = await readFile(join(sqlDir, f), 'utf8');
    // Strip psql metacommands (\set, \if, \else, \endif, \echo, etc.) —
    // they're psql-client-side directives that postgres-js sends raw to
    // the server, which throws "syntax error at or near \\". Hash the
    // RAW contents (so files don't re-apply just because we change the
    // stripper), but execute the cleaned version.
    const ddl = ddlRaw
      .split('\n')
      .filter((line) => !/^\s*\\[a-z]/i.test(line))
      .join('\n');
    const hash = await sha256(ddlRaw);
    log(`apply ${f}`);
    // Apply + record in one transaction so a partial apply doesn't leave
    // schema_migrations claiming success.
    //
    // CONTRACT — the runner provides the transaction: migration files MUST
    // NOT contain their own top-level BEGIN;/COMMIT;. An inner COMMIT ends
    // this wrapper transaction early, so the <ddl> + ledger-INSERT pair stops
    // being atomic and a mid-file failure leaves schema_migrations lying
    // (plpgsql `BEGIN…END` inside $$ bodies is fine). Enforced for new files
    // by `npm run lint:migrations` (audit P-074, EI-170); files 116–200
    // predate this contract and are grandfathered as applied history.
    //
    // WI-832: the default `SET LOCAL statement_timeout = 0` is the MIGRATION OPT-OUT for the
    // org-pool default statement_timeout (a DDL migration legitimately runs longer
    // than any interactive cap). SET LOCAL is txn-scoped, so it reverts at COMMIT.
    // This is the single chokepoint every migration path funnels through (embedded-pg
    // boot, native boot-migrate, db:migrate), so the opt-out holds regardless of
    // which client/pool applies the file — even once a non-zero default is live.
    // A bounded fixture can explicitly override that default through
    // migrationStatementTimeoutMs. ONLY statement_timeout is changed here:
    // lock_timeout stays as the caller's deliberate fail-fast guard. A raw
    // SQLSTATE 55P03 is retried below only after its transaction is rolled
    // back, so each attempt remains fail-fast and never leaves the connection
    // in an aborted transaction.
    const migrationPath = resolve(sqlDir, f);
    const queryPrefix = migrationTransactionPrefix(effectiveMigrationStatementTimeoutMs, bulkApply);
    let activeChunk = ddl;
    let rollbackCompleted = false;
    try {
      await beforeApply?.(f, ddlRaw);
      const chunks = migrationTransactionChunks(ddl);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        activeChunk = chunks[chunkIndex];
        rollbackCompleted = false;
        const isFinalChunk = chunkIndex === chunks.length - 1;
        const ledgerWrite = isFinalChunk
          ? `INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${f.replace(/'/g, "''")}', '${hash}');\n`
          : '';
        const query = `${queryPrefix}${activeChunk};\n${ledgerWrite}COMMIT;`;
        for (let attempt = 1; attempt <= MIGRATION_LOCK_RETRY_MAX_ATTEMPTS; attempt += 1) {
          try {
            await client.unsafe(query);
            break;
          } catch (err) {
            // A failed BEGIN…COMMIT leaves the connection in an aborted
            // transaction. Reset it before deciding whether a raw 55P03 is
            // eligible for another fail-fast attempt.
            await client.unsafe('ROLLBACK').catch(() => {});
            rollbackCompleted = true;
            if (!isMigrationLockTimeout(err) || attempt >= MIGRATION_LOCK_RETRY_MAX_ATTEMPTS) throw err;
            const delayMs = migrationLockRetryBackoffMs(attempt);
            log(
              `retry ${f} after SQLSTATE 55P03 lock timeout in ${delayMs}ms ` +
                `(attempt ${attempt + 1}/${MIGRATION_LOCK_RETRY_MAX_ATTEMPTS})`,
            );
            await sleep(delayMs);
            // The next attempt starts a fresh transaction. If it fails too,
            // this flag is set again before the outer diagnostic wrapper runs.
            rollbackCompleted = false;
          }
        }
      }
      appliedCount++;
      lastAppliedFile = f;
    } catch (err) {
      // The failed `BEGIN…COMMIT` left the connection in an aborted
      // transaction; reset it so error reporting isn't masked by
      // "current transaction is aborted, commands ignored until end of block".
      if (!rollbackCompleted) await client.unsafe('ROLLBACK').catch(() => {});
      // No skip-on-42P01 anymore. That tolerance existed only because the OLD
      // incremental migrations ALTERed `harness_shared.*` tables that ensure-schema
      // (not a migration) created lazily at runtime — so an ALTER could hit a
      // not-yet-existing table at boot. The schema is now a single self-contained
      // 000-baseline.sql (self-contained-migration-baseline-2026-06-02): it creates
      // every table before touching it, so empty→head applies with ZERO skips and
      // any 42P01 (or any other error) is a genuine break that MUST fail loudly —
      // UNLESS continueOnError (the shared native-box boot), where we log + skip
      // the bad file (left unrecorded → retried next boot) instead of wedging boot.
      const failure = wrapMigrationFailure({
        cause: err,
        file: f,
        migrationPath,
        ddl: activeChunk,
        dataDirWasReused,
        haltBoot: !continueOnError,
        queryPrefix,
      });
      if (continueOnError) {
        log(`FAILED ${failure.message}`);
        failed.push({ file: f, error: failure.message });
        continue;
      }
      throw failure;
    }
  }

  // A synchronous commit flushes its WAL and all preceding migration commits.
  // Reuse one existing tracker row without changing its values; unlike CHECKPOINT,
  // this does not flush unrelated databases across a shared Postgres cluster.
  // In particular, a cold test template must not wait for that cluster-wide work
  // before it can be published. PostgreSQL's commit-order recovery guarantee:
  // https://www.postgresql.org/docs/18/wal-async-commit.html
  // Use the last SUCCESSFUL file, including when continueOnError skipped the tail.
  // A missing row or failed flush must fail boot, never silently report durability.
  if (bulkApply) {
    await client.unsafe('SET synchronous_commit = on');
    if (lastAppliedFile !== null) {
      const flushed = await client.unsafe(
        `UPDATE harness_shared.schema_migrations SET sha256 = sha256 WHERE filename = '${lastAppliedFile.replace(/'/g, "''")}' RETURNING filename`,
      );
      if (!Array.isArray(flushed) || !flushed.some((row) => row.filename === lastAppliedFile)) {
        throw new Error(`Migration durability barrier could not find recorded file ${lastAppliedFile}`);
      }
    }
  }

  return { appliedCount, totalKnown: allFiles.length, failed };
}
