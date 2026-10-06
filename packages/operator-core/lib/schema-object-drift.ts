/**
 * schema-object-drift.ts — LIVE SCHEMA vs MIGRATION-DERIVED SCHEMA, for indexes.
 *
 * ## The gap this fills
 *
 * `migration-drift.ts` (its sibling) answers "which migration FILES have been
 * applied": it compares the `sql/` directory against the
 * `harness_shared.schema_migrations` tracker, and separately compares applied
 * bytes against on-disk bytes. Both are questions about the LEDGER.
 *
 * Neither can see an index that exists in the live database but is named by no
 * migration at all — because such an index leaves no trace in the ledger. Every
 * tracked migration can be applied, byte-identical, and the live schema still
 * carry objects a fresh install will never have. Measured on the dev database
 * 2026-08-29 (WI-918476): 1,003 live non-PK indexes, of which
 * `plugin_configs_plugin_idx` and `plugin_enables_plugin_idx` appear in no
 * migration in the corpus. A fresh install does not get them; every query plan
 * tuned against them here is tuned against something users do not have.
 *
 * ## Why the reference is MATERIALIZED, not parsed
 *
 * The obvious implementation — grep the migration SQL for index names — was
 * tried by hand first and produces two irreducible classes of false positive:
 *
 *   (a) Indexes created through `EXECUTE format(...)` with a name assembled at
 *       runtime. Migration 530 builds five `*_embedding_mode_idx` names this
 *       way; no text search over the corpus can find them, because the string
 *       never appears in it.
 *   (b) Indexes Postgres names itself. A `UNIQUE (a, b)` table constraint
 *       creates an index called `<table>_<cols>_key`; that identifier is never
 *       written in the SQL either. Nine of these exist here.
 *
 * Both vanish if the reference is a real database with the migrations actually
 * applied: a dynamically-named index is genuinely present in it, and so is an
 * auto-named constraint index. So the reference here is a CENSUS taken from a
 * materialized schema (see `db-schema-reference/index-manifest.json`, which
 * `apps/operator/test/schema-object-drift.integration.test.ts` regenerates from
 * the real migration runner and pins), never a text search. That choice is what
 * makes the guard quiet enough to be believed — a guard with a known
 * false-positive class gets ignored, and then it is not a guard.
 *
 * ## Scope is DERIVED, never a maintained allowlist
 *
 * Only schemas that EXIST IN THE REFERENCE are compared. `dbos` (created by the
 * DBOS library at runtime), `zero_0/cvr` (the retired sync engine), and any
 * per-harness schema built from the name-skipped `per-harness-template`
 * migration are therefore out of scope by construction rather than by a list
 * someone has to remember to update. Add a migration that creates a schema and
 * it starts being policed on its own.
 */

import { getOrgPg } from '@papercusp/db-org';
/**
 * The committed reference census is a generated TypeScript MODULE, not a JSON
 * file read at runtime, and deliberately so.
 *
 * A data file has to be FOUND, and this module runs in places with no repo tree
 * above cwd — the Tauri sidecar, a packaged headless rig, the release checkout.
 * Its sibling `migration-drift.ts` already carries the scar from exactly that
 * (EI-18737837917400418: repo-relative resolution silently found nothing on a
 * packaged deploy, so the boot-apply safety net skipped every boot unnoticed,
 * because a miss only logged a warning). An import cannot miss: it is resolved
 * at build time, travels inside whatever bundle this module travels in, and is
 * type-checked on the way.
 */
import { INDEX_MANIFEST } from './db-schema-reference/index-manifest';

/** One index, as the census identifies it. */
export interface IndexCensusEntry {
  /** Namespace the index lives in. */
  readonly schema: string;
  /** Index name — unique within its schema, which is what makes it the key. */
  readonly name: string;
  /** Relation the index is on, for a legible report. */
  readonly table: string;
  /**
   * `pg_indexes.indexdef`, normalized. Compared so that an index REDEFINED in
   * place (different columns, a changed `WHERE`, a switched opclass) is caught
   * as well as one added or removed — a same-named index with different columns
   * is a different index for every purpose that matters.
   */
  readonly definition: string;
  /**
   * True when this index backs a PRIMARY KEY or UNIQUE constraint. Not used for
   * filtering — a materialized reference needs no such exclusion — but reported,
   * because it changes the REMEDY: a constraint-backed index is dropped by
   * altering the constraint, not by `DROP INDEX`.
   */
  readonly constraintBacked: boolean;
}

/** A same-named index whose definition differs between the two schemas. */
export interface IndexDefinitionMismatch {
  readonly schema: string;
  readonly name: string;
  readonly table: string;
  readonly reference: string;
  readonly live: string;
}

export interface SchemaObjectDrift {
  /**
   * Indexes present in the LIVE database that the migrations do not produce.
   * This is the finding the guard exists for: something created them outside
   * the migration set, and a fresh install will not have them.
   */
  readonly liveOnly: IndexCensusEntry[];
  /**
   * Indexes the migrations produce that the LIVE database is missing. Usually
   * an unapplied migration (which `checkMigrationDrift` reports first and more
   * precisely), but it also catches the case that one cannot: a migration that
   * WAS applied whose index was later dropped by hand.
   */
  readonly referenceOnly: IndexCensusEntry[];
  /** Same name, different definition. */
  readonly definitionMismatch: IndexDefinitionMismatch[];
  /** Schemas actually compared — derived from the reference, reported for audit. */
  readonly schemasCompared: string[];
  /**
   * Schemas present live but absent from the reference, and therefore NOT
   * compared. Reported rather than silently dropped: an unexpected name here
   * (one you believe a migration creates) means the reference is stale, and
   * reading it as "nothing to report" would be exactly the wrong conclusion.
   */
  readonly schemasNotCompared: string[];
  /** Total live indexes considered, so a zero result can be told from an empty read. */
  readonly liveIndexCount: number;
  readonly referenceIndexCount: number;
}

/**
 * The census query. Deliberately reads `pg_indexes` (which renders a canonical,
 * fully-qualified `indexdef` via `pg_get_indexdef`) rather than reconstructing
 * the definition from `pg_index` columns — the rendered form is what Postgres
 * itself considers the index's definition, so two identical schemas cannot
 * disagree through a reconstruction bug of ours.
 *
 * `constraintBacked` is an EXISTS over the index's OWN constraint kinds
 * (primary key, unique, exclusion), never a join on `conindid` alone. A foreign
 * key also sets `conindid` — to the REFERENCED table's unique index — so a join
 * emitted one census row per referencing FK (duplicate (schema, name) keys,
 * inflated counts) and labelled a plain unique index constraint-backed merely
 * because an FK pointed at it (WI-10005064). Filtering on `conrelid` instead
 * would not be enough: a self-referencing FK has the index's own table there.
 */
export const INDEX_CENSUS_SQL = `
  SELECT i.schemaname                             AS schema,
         i.indexname                              AS name,
         i.tablename                              AS "table",
         i.indexdef                               AS definition,
         EXISTS (
           SELECT 1
             FROM pg_constraint con
            WHERE con.conindid = ic.oid
              AND con.contype IN ('p', 'u', 'x')
         )                                        AS "constraintBacked"
    FROM pg_indexes i
    JOIN pg_class ic
      ON ic.relname = i.indexname
     AND ic.relnamespace = i.schemaname::regnamespace
   WHERE i.schemaname NOT LIKE 'pg\\_%'
     AND i.schemaname <> 'information_schema'
   ORDER BY i.schemaname, i.indexname
`;

/** Minimal structural shape of a `postgres` client, so callers can pass any of them. */
type Queryable = { unsafe: (sql: string) => Promise<unknown> };

/**
 * Rewrite one `timestamp with time zone` literal to a canonical `+00` rendering,
 * or return null if it is not one this understands (in which case it is left
 * exactly as Postgres wrote it — an unparsed literal must never be silently
 * rewritten into something that compares equal).
 */
function toUtcTimestamptzLiteral(body: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(
    body,
  );
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? '00'}`);
  if (Number.isNaN(at.getTime())) return null;
  const [date, time] = at.toISOString().slice(0, -1).split('T');
  return `${date} ${time.endsWith('.000') ? time.slice(0, -4) : time}+00`;
}

/**
 * Normalize a rendered index definition for comparison.
 *
 * Exactly TWO rules, and both are about RENDERING rather than meaning. Resist
 * adding a third on principle: every "harmless" rewrite (lowercasing, stripping
 * `USING btree`, collapsing parentheses) is a rule about what counts as the SAME
 * index, and each one is a place a real difference can hide.
 *
 *  1. Whitespace — the one difference Postgres will never render inconsistently
 *     between two identical schemas.
 *  2. `timestamp with time zone` literals, rewritten to a `+00` rendering.
 *     NOT a cosmetic nicety — this one was measured. `pg_get_indexdef` renders a
 *     timestamptz literal in the SESSION's TimeZone, so the partial-index
 *     predicate in `session_turn_journal_turn_uq` comes back as
 *     `'1970-01-01 00:00:00+00'` from the UTC test container and
 *     `'1969-12-31 19:00:00-05'` from the America/New_York dev box — the same
 *     instant, the same index, reported as a REDEFINITION on 2026-08-29 before
 *     this rule existed. Left unfixed, the guard would have cried wolf on every
 *     install whose server timezone is not UTC, which is most of them.
 */
export function normalizeIndexDefinition(definition: string): string {
  return definition
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/'([^']*)'::timestamp with time zone/g, (whole, body: string) => {
      const utc = toUtcTimestamptzLiteral(body);
      return utc === null ? whole : `'${utc}'::timestamp with time zone`;
    });
}

export async function takeIndexCensus(client: Queryable): Promise<IndexCensusEntry[]> {
  const rows = (await client.unsafe(INDEX_CENSUS_SQL)) as Array<{
    schema: string;
    name: string;
    table: string;
    definition: string;
    constraintBacked: boolean;
  }>;
  return rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    table: r.table,
    definition: normalizeIndexDefinition(r.definition),
    constraintBacked: Boolean(r.constraintBacked),
  }));
}

const keyOf = (e: { schema: string; name: string }): string => `${e.schema}.${e.name}`;

/**
 * Compare two censuses. Pure — no I/O, no clock, no environment — which is what
 * lets the unit tests exercise the real false-positive classes directly instead
 * of asserting them through a database.
 */
export function compareIndexCensus(
  reference: readonly IndexCensusEntry[],
  live: readonly IndexCensusEntry[],
): SchemaObjectDrift {
  const referenceSchemas = new Set(reference.map((e) => e.schema));
  const liveSchemas = new Set(live.map((e) => e.schema));

  // Scope: only what the migrations actually build. See the module header.
  const inScope = (e: IndexCensusEntry): boolean => referenceSchemas.has(e.schema);
  const liveInScope = live.filter(inScope);

  const referenceByKey = new Map(reference.map((e) => [keyOf(e), e]));
  const liveByKey = new Map(liveInScope.map((e) => [keyOf(e), e]));

  const liveOnly: IndexCensusEntry[] = [];
  const definitionMismatch: IndexDefinitionMismatch[] = [];
  for (const [key, entry] of liveByKey) {
    const ref = referenceByKey.get(key);
    if (!ref) {
      liveOnly.push(entry);
    } else if (ref.definition !== entry.definition) {
      definitionMismatch.push({
        schema: entry.schema,
        name: entry.name,
        table: entry.table,
        reference: ref.definition,
        live: entry.definition,
      });
    }
  }

  const referenceOnly = reference.filter((e) => !liveByKey.has(keyOf(e)));

  return {
    liveOnly,
    referenceOnly,
    definitionMismatch,
    schemasCompared: [...referenceSchemas].sort(),
    schemasNotCompared: [...liveSchemas].filter((s) => !referenceSchemas.has(s)).sort(),
    liveIndexCount: liveInScope.length,
    referenceIndexCount: reference.length,
  };
}

/** True when there is anything to report. */
export function hasSchemaObjectDrift(drift: SchemaObjectDrift): boolean {
  return (
    drift.liveOnly.length > 0 ||
    drift.referenceOnly.length > 0 ||
    drift.definitionMismatch.length > 0
  );
}

/**
 * A one-paragraph, human-readable rendering — what a watchdog finding or a
 * `db:check_drift` result shows. Names the objects; a count alone is not
 * actionable and is what turns a guard into background noise.
 */
export function describeSchemaObjectDrift(drift: SchemaObjectDrift): string {
  if (!hasSchemaObjectDrift(drift)) {
    return `No index drift: ${drift.liveIndexCount} live indexes across ${drift.schemasCompared.length} migration-owned schema(s) all match the migration-derived reference.`;
  }
  const parts: string[] = [];
  if (drift.liveOnly.length > 0) {
    parts.push(
      `${drift.liveOnly.length} index(es) exist live but are produced by NO migration (a fresh install will not have them): ` +
        drift.liveOnly
          .map((e) => `${e.schema}.${e.name} ON ${e.table}${e.constraintBacked ? ' [constraint-backed]' : ''}`)
          .join(', '),
    );
  }
  if (drift.referenceOnly.length > 0) {
    parts.push(
      `${drift.referenceOnly.length} index(es) the migrations produce are MISSING live: ` +
        drift.referenceOnly.map((e) => `${e.schema}.${e.name} ON ${e.table}`).join(', '),
    );
  }
  if (drift.definitionMismatch.length > 0) {
    parts.push(
      `${drift.definitionMismatch.length} index(es) are REDEFINED live: ` +
        drift.definitionMismatch
          .map((m) => `${m.schema}.${m.name} (migrations: ${m.reference} / live: ${m.live})`)
          .join('; '),
    );
  }
  return parts.join(' ');
}

export interface IndexManifest {
  /**
   * How many migration files were on disk when this was generated. Not used for
   * comparison; carried so a STALE manifest can be diagnosed (the count moved)
   * rather than merely distrusted.
   */
  readonly migrationCountAtGeneration: number;
  readonly generatedAt: string;
  readonly indexes: readonly IndexCensusEntry[];
}

export function readIndexManifest(): IndexManifest | null {
  return Array.isArray(INDEX_MANIFEST?.indexes) ? INDEX_MANIFEST : null;
}

export interface SchemaObjectDriftResult {
  /** Null when the check could not run; `unavailableReason` says why. */
  readonly drift: SchemaObjectDrift | null;
  /**
   * Why no verdict was produced. An UNAVAILABLE check must never be reported as
   * a clean one — a missing manifest and a clean database are the same zero if
   * you only look at the counts.
   */
  readonly unavailableReason: string | null;
  /** The manifest's generation stamp, for staleness triage. */
  readonly manifestGeneratedAt: string | null;
}

/**
 * The standing check: compare the LIVE operator database against the committed
 * migration-derived manifest.
 *
 * Cheap by construction — one catalog query and one file read — because it is
 * called from surfaces that run on a schedule. Materializing a fresh reference
 * costs a full migration apply and belongs in the integration test that pins
 * the manifest, not here.
 */
export async function checkSchemaObjectDrift(): Promise<SchemaObjectDriftResult> {
  const manifest = readIndexManifest();
  if (!manifest || manifest.indexes.length === 0) {
    return {
      drift: null,
      unavailableReason:
        'the migration-derived index manifest is empty or malformed — regenerate it with PAPERCUSP_UPDATE_INDEX_MANIFEST=1 npm run test:file -- apps/operator/test/schema-object-drift.integration.test.ts',
      manifestGeneratedAt: null,
    };
  }

  let live: IndexCensusEntry[];
  try {
    const { sql } = getOrgPg();
    live = await takeIndexCensus(sql as unknown as Queryable);
  } catch (err) {
    return {
      drift: null,
      unavailableReason: `live index census failed: ${err instanceof Error ? err.message : String(err)}`,
      manifestGeneratedAt: manifest.generatedAt ?? null,
    };
  }

  // Normalize the manifest side too: it was written by this module, but a
  // hand-edit or a formatter pass must not be able to manufacture a mismatch.
  const reference = manifest.indexes.map((e) => ({
    ...e,
    definition: normalizeIndexDefinition(e.definition),
  }));

  return {
    drift: compareIndexCensus(reference, live),
    unavailableReason: null,
    manifestGeneratedAt: manifest.generatedAt ?? null,
  };
}
