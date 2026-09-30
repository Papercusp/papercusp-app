/**
 * Shared postgres-js client-shape fixes, split out of `connection.ts` into
 * their OWN module with ZERO `drizzle-orm` import so they can be safely
 * imported by test fixtures that must avoid drizzle's schema-extraction
 * (see `packages/operator-core/test/_org-test-db.ts`'s docstring: importing
 * anything from `connection.ts` pulls in `drizzle-orm/postgres-js`, which
 * throws under some vitest configs during schema extraction). Importing
 * THIS module only touches `postgres`'s types — never `drizzle-orm`.
 *
 * `connection.ts`'s `buildClient` applies both fixes to every canonical
 * connection; any hand-rolled `postgres(url, {...})` client that is meant to
 * BEHAVE LIKE the canonical `getOrgPg()`/`getHarnessPg()` clients (test
 * fixtures, conformance suites, one-off scripts) should apply them too, or it
 * silently drifts from production serialization behavior.
 */
import type { Sql } from 'postgres';

/**
 * EI-9265: postgres-js parses int8/bigserial columns (OID 20) as JS STRINGS
 * by default (precision-safety — a bigint can exceed Number's 2^53 range).
 * Every hand-rolled `postgres(url, {...})` client that is meant to BEHAVE
 * LIKE the canonical `getOrgPg()`/`getHarnessPg()` clients (test fixtures,
 * conformance suites, one-off scripts) MUST spread this in, or a raw-SQL read
 * of a bigserial PK (e.g. `harness_shared.coord_event_log.id`) silently comes
 * back as a string — a `typeof x === 'number'` guard downstream then treats
 * it as absent with NO thrown error (the WI-3880 coord:feed cursor bug: page
 * 2 of a cursor-paginated read silently returned page 1's rows again).
 */
export const PG_BIGINT_AS_NUMBER_TYPES = {
  bigint: {
    to: 20,
    from: [20],
    serialize: (x: any) => String(x),
    parse: (x: string) => Number(x),
  } as any,
};

/**
 * EI-19331550321709126: postgres-js's default PARSER for OID 1114 (`timestamp
 * WITHOUT time zone`) is `x => new Date(x)` (types.js's `date` type, shared
 * with 1082/date and 1184/timestamptz). V8's `Date` constructor interprets a
 * timezone-less date-TIME string as SERVER-LOCAL, not UTC — so on a server
 * running e.g. America/New_York, a bare `timestamp` value is silently
 * shifted by the server's UTC offset before it ever reaches JS, and the
 * shift is invisible because the resulting `Date` still serializes with a
 * trailing "Z" that looks authoritative (measured: a true 07:15:29Z value
 * rendered as 11:15:29Z — a ~4h corruption read, at first, as clock skew).
 *
 * No canonical schema column in this app is declared bare `timestamp` —
 * every stored timestamp column is `timestamptz` (OID 1184, which carries
 * its own offset and is unaffected by this fix). OID 1114 therefore only
 * ever appears here as a COMPUTED expression, and the idiom agents actually
 * reach for (dev:pg_query's own advisory documents it) is
 * `... AT TIME ZONE 'UTC'` — specifically to "get UTC". So the correct
 * interpretation of a bare 1114 value in this codebase is UTC, not
 * server-local: force it by appending a `Z` to the raw wire text (which has
 * no offset of its own) before handing it to `Date`, which pins the parse to
 * UTC regardless of the process's or server's TZ. OID 1082 (date-only) is
 * untouched — the ECMA-262 date-only grammar already parses those as UTC.
 *
 * Merged into every canonical client's `types` option by `buildClient`
 * (mergeUserTypes in postgres-js overrides the built-in parser per-OID via
 * `Object.assign`, so this only replaces the 1114 leg of the shared `date`
 * type — 1082/1184 keep the library default). Any hand-rolled
 * `postgres(url, {...})` client meant to behave like the canonical clients
 * should spread this in too, same as `PG_BIGINT_AS_NUMBER_TYPES`.
 */
export const PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES = {
  timestampNoTzUtc: {
    to: 1114,
    from: [1114],
    serialize: (x: any) => (x instanceof Date ? x : new Date(x)).toISOString(),
    parse: (x: string) => new Date(/[zZ]$|[+-]\d\d(:?\d\d)?$/.test(x) ? x : `${x}Z`),
  } as any,
};

/**
 * EI-21569018799980044: postgres-js's default parser for OID 1184
 * (`timestamptz`) returns a JS `Date`. `Date` only retains milliseconds, so
 * arbitrary SQL reads silently turn a wire value such as
 * `2026-08-23 00:04:32.646995+00` into `2026-08-23T00:04:32.646Z`.
 *
 * The ad-hoc read pool opts into this parser so the raw PostgreSQL text —
 * including all six fractional-second digits — reaches the JSON result
 * unchanged. This is deliberately NOT merged into ordinary application pools:
 * their existing `Date` behavior is part of their API, while `dev:pg_query`
 * must not corrupt values an agent may write back. The serializer handles the
 * rare parameter use without changing the read-side string contract.
 */
export const PG_TIMESTAMPTZ_AS_STRING_TYPES = {
  timestamptzAsString: {
    to: 1184,
    from: [1184],
    serialize: (x: any) => (x instanceof Date ? x.toISOString() : String(x)),
    parse: (x: string) => x,
  } as any,
};

/**
 * EI-13076: drizzle-orm's postgres-js driver MUTATES the client it wraps —
 * `drizzle(client)` overwrites `client.options.serializers[<date OIDs>]` with a
 * transparent passthrough (`(val) => val`) so its OWN pre-stringified params
 * survive unmangled. But our canonical clients are SHARED between drizzle and
 * raw `sql\`...\`` tagged-template callers, and a raw caller passing a JS `Date`
 * param then hits `Buffer.byteLength(Date)` inside postgres-js:
 *
 *   TypeError: The "string" argument must be of type string or an instance of
 *   Buffer or ArrayBuffer. Received an instance of Date
 *
 * Every such query THROWS — and a `.catch(() => fallback)` around it silently
 * feeds zeros forever (the pot-throughput tick recorded placements=0 on all
 * 22k+ ticks in table history this way). This restores a HYBRID serializer on
 * the date/time OIDs: a `Date` serializes to ISO (what postgres-js does by
 * default), anything else (drizzle's pre-stringified values) passes through
 * unchanged — so BOTH consumers of the shared client work.
 *
 * STICKY on purpose: the OIDs are installed as accessor properties whose
 * setter is a no-op, because `drizzle(tx)` is also called at RUNTIME on
 * transaction handles (operator-audit, agent-mcp tools, …) which share the
 * parent client's `options.serializers` object — a plain assignment there
 * would silently re-break every raw Date param in the process. Parsers are
 * left as drizzle sets them (raw reads return strings; callers already
 * tolerate `string | Date`).
 *
 * Called by `buildClient` on every canonical connection. A hand-rolled
 * `postgres(url, …)` client that gets drizzle-wrapped must call this too, or
 * it drifts back into the trap (same class as EI-9265's bigint note above).
 */
const DRIZZLE_MUTATED_DATE_OIDS = ['1184', '1082', '1083', '1114', '1182', '1185', '1115', '1231'] as const;
export function restoreRawDateSerializers(client: Sql): void {
  const serializers = (client as any)?.options?.serializers as Record<string, (x: any) => any> | undefined;
  if (!serializers) return;
  const hybrid = (x: any) => (x instanceof Date ? x.toISOString() : x);
  for (const oid of DRIZZLE_MUTATED_DATE_OIDS) {
    Object.defineProperty(serializers, oid, {
      configurable: true,
      enumerable: true,
      get: () => hybrid,
      // Swallow drizzle's transparent re-assignment (driver.js does
      // `serializers[oid] = transparentParser` on every drizzle() call).
      set: () => {},
    });
  }
}

/**
 * EI-18698602043482898: postgres-js's json/jsonb OIDs (114, 3802) have the
 * SAME shared-client mutation problem as the date OIDs above, but INVERTED —
 * and because BOTH the "raw" and the "drizzle-mutated" state are wrong for
 * one of the two common call shapes, there is no JS-value form that is
 * correct under both:
 *
 *   - `${sql.json(v)}` explicitly types the param 3802 up front. postgres-js's
 *     DEFAULT serializer for 114/3802 is `JSON.stringify` (types.js), which is
 *     correct here — `v` is the real JS value and needs encoding once.
 *   - `${JSON.stringify(v)}::jsonb` (or any raw `${…}::jsonb` with a
 *     pre-stringified JS value) infers the param as untyped (OID 0); postgres-js
 *     defers serialization until the server's ParameterDescription response
 *     resolves the OID to 3802 via the cast, THEN serializes the ORIGINAL
 *     (already-stringified) value through `options.serializers['3802']`. The
 *     default `JSON.stringify` serializer here DOUBLE-encodes it — e.g. an
 *     empty array `[]` becomes the jsonb SCALAR `"[]"` (jsonb_typeof=string)
 *     instead of the array `[]` — a defect that is invisible on read unless
 *     something asserts the stored type (see seed.ts's `::text::jsonb`
 *     workaround + jsonb_array_length note).
 *
 *   drizzle-orm's postgres-js driver (driver.js) mutates serializers['114']
 *   and ['3802'] to a transparent passthrough (to keep ITS OWN
 *   pre-stringified params from being re-encoded) — which happens to fix the
 *   second bullet above but BREAKS the first: `sql.json(v)` with a real JS
 *   array/object now hits `Buffer.byteLength(Array)` inside postgres-js and
 *   throws. So today, which form is "correct" depends entirely on whether the
 *   shared client happened to get drizzle-wrapped — neither client is right
 *   for both callers.
 *
 * This installs a HYBRID serializer (mirroring `restoreRawDateSerializers`):
 * a string passes through unchanged (the pre-stringified-value case), anything
 * else is JSON.stringify'd (the raw-JS-value / `sql.json` case) — correct for
 * BOTH call shapes, on any client, whether or not it is later drizzle-wrapped.
 * STICKY for the same reason as the date OIDs: `drizzle(tx)` is called at
 * RUNTIME on transaction handles sharing the parent's `options.serializers`
 * object, so a plain assignment would silently re-break the very next
 * `drizzle(tx)` call.
 *
 * Called by `buildClient` on every canonical connection. A hand-rolled
 * `postgres(url, …)` client meant to behave like the canonical clients
 * (test fixtures, conformance suites, one-off scripts) must call this too.
 */
const DRIZZLE_MUTATED_JSON_OIDS = ['114', '3802'] as const;
export function restoreRawJsonbSerializer(client: Sql): void {
  const serializers = (client as any)?.options?.serializers as Record<string, (x: any) => any> | undefined;
  if (!serializers) return;
  const hybrid = (x: any) => (typeof x === 'string' ? x : JSON.stringify(x));
  for (const oid of DRIZZLE_MUTATED_JSON_OIDS) {
    Object.defineProperty(serializers, oid, {
      configurable: true,
      enumerable: true,
      get: () => hybrid,
      // Swallow drizzle's transparent re-assignment (driver.js does
      // `serializers["114"] = serializers["3802"] = transparentParser` on
      // every drizzle() call).
      set: () => {},
    });
  }
}

/**
 * WI-41207: element OID -> array OID for Postgres BUILT-IN types. These are fixed catalog
 * constants (pg_type.oid / pg_type.typarray for built-ins never change across versions or
 * installs), which is what makes seeding them statically sound.
 */
const BUILTIN_ARRAY_TYPE_OIDS: Readonly<Record<number, number>> = {
  16: 1000, // bool
  20: 1016, // int8
  21: 1005, // int2
  23: 1007, // int4
  25: 1009, // text
  114: 199, // json
  700: 1021, // float4
  701: 1022, // float8
  1042: 1014, // bpchar
  1043: 1015, // varchar
  1082: 1182, // date
  1083: 1183, // time
  1114: 1115, // timestamp
  1184: 1185, // timestamptz
  2950: 2951, // uuid
  3802: 3807, // jsonb
};

/**
 * WI-41207: make `sql.array(...)` correct on the FIRST query of a cold pool.
 *
 * THE DEFECT. postgres-js resolves an array parameter's OID at query-BUILD time
 * (`types.js:89`):
 *
 *     x.array[x.type || inferType(x.value)] || x.type || firstIsString(x.value)
 *
 * where `x.array` is `options.shared.typeArrayMap`, populated ONLY by the connection's
 * `fetchArrayTypes()` handshake (`connection.js:770`). The first query on a cold pool is built
 * before that completes, so the lookup misses and the expression falls through to `x.type` —
 * the ELEMENT oid (25/text), not the ARRAY oid (1009/text[]). The parameter is then declared
 * `text` while its value is an array, and the server answers:
 *
 *     op ANY/ALL (array) requires array on right side
 *
 * The identical call succeeds moments later, once the map is populated, which is why this reads
 * as an argument-shape bug and is not one. It is a SILENT TYPE DEGRADATION, not a missing-type
 * error. Measured on postgres-js 3.4.9: 3/3 cold pools fail, 3/3 seeded pools succeed.
 *
 * WHY HERE AND NOT AT THE CALL SITES. 54 non-test `sql.array(` sites share the hazard, and a
 * caller that treats an error as "no rows" reads the failure as an empty result — the
 * false-clean direction, most likely right after an operator restart when ledger reads matter
 * most. Fixing it per-site (`sql.array(x, 1009)`) would have to be remembered by site 55; this
 * is correct for every present and future caller.
 *
 * WHY A STATIC SEED RATHER THAN A WARM-UP QUERY. Firing `SELECT 1` at construction also works
 * (verified), but it forces an EAGER CONNECT where these clients connect lazily today — a
 * lifecycle change every test fixture and import-time handle would inherit. Seeding costs no
 * I/O, cannot race, and leaves the connection lifecycle untouched.
 *
 * SCOPE, STATED HONESTLY: built-ins only. A custom/extension element type (e.g. pgvector) still
 * depends on `fetchArrayTypes()`, so it remains wrong for exactly one query on a cold pool. That
 * is a strict improvement, not a complete fix, and the real fetch overwrites these entries with
 * the catalog's own values on connect (verified to agree: typeArrayMap[25] === 1009 after).
 *
 * NUMBER ARRAYS ARE FIXED SEPARATELY, BELOW: `sql.array([1,2,3])` types a NUMBER array as text[]
 * regardless of this map, because the element OID is already 25 before the map is consulted.
 * Seeding cannot help there — see installNumericArrayTyping (EI-21301868186403490).
 */
export function seedBuiltinArrayTypes(client: Sql): void {
  const map = (client as any)?.options?.shared?.typeArrayMap as Record<number, number> | undefined;
  if (!map) return; // postgres-js internals moved — the guard test reports this loudly
  for (const [elementOid, arrayOid] of Object.entries(BUILTIN_ARRAY_TYPE_OIDS)) {
    // Never clobber: a real fetchArrayTypes() result is authoritative over our constants.
    if (map[elementOid as unknown as number] === undefined) {
      map[elementOid as unknown as number] = arrayOid;
    }
  }
}

/** Element OIDs a JS number array can be sent as. */
export const PG_ELEMENT_OID_INT8 = 20;
export const PG_ELEMENT_OID_FLOAT8 = 701;

/** Marks an already-wrapped `array` so re-wrapping a client cannot nest the patch. */
const NUMERIC_ARRAY_TYPING = Symbol.for('papercusp.db.numericArrayTyping');

/**
 * The element OID a numeric array should be declared as, or `undefined` to leave postgres-js's
 * own inference untouched. Exported so the guard test can pin the classification with no DB.
 *
 * `undefined` is returned for anything that is not an all-number array (including an empty one,
 * and one holding only NULLs) — those carry no numeric type information and are not ours to type.
 */
export function numericArrayElementOid(elements: readonly unknown[]): number | undefined {
  let sawNumber = false;
  let needsFloat = false;
  for (const el of elements) {
    if (el === null || el === undefined) continue; // NULL carries no type information
    if (typeof el !== 'number') return undefined; // not a numeric array — leave it alone
    sawNumber = true;
    if (!Number.isSafeInteger(el)) needsFloat = true;
  }
  if (!sawNumber) return undefined;
  return needsFloat ? PG_ELEMENT_OID_FLOAT8 : PG_ELEMENT_OID_INT8;
}

/**
 * EI-21301868186403490: make `sql.array([1, 2, 3])` reach Postgres as an INTEGER array.
 *
 * THE DEFECT — a COERCION, not a missing case. postgres-js's `inferType` (`types.js:221`) has
 * cases for Date, Uint8Array, boolean and bigint but NONE for `number`, so it returns 0 for a
 * numeric array. `array()` (`index.js:326`) then coerces that 0 to TEXT outright:
 *
 *     new Parameter(x, type || (x.length ? inferType(x) || 25 : 0), options.shared.typeArrayMap)
 *                                                       ^^^^^^^^ 25 = text
 *
 * The parameter is declared `text[]` (typeArrayMap[25] → 1009) and the server answers:
 *
 *     operator does not exist: integer = text
 *
 * Measured on postgres-js 3.4.9 against a WARMED pool — which is exactly what separates this
 * from WI-41207. seedBuiltinArrayTypes cannot help: the element OID is already 25 before the
 * map is consulted. `sql.array([1n, 2n])` is unaffected (inferType HAS a bigint case), so the
 * defect is specific to JS `number`.
 *
 * LATENT, NOT LIVE — stated plainly so nobody re-reads this as an outage. Of 59 non-test
 * `sql.array(` sites, 23 carry no explicit `::type[]` cast and every one of those passes
 * STRINGS, which text[] types correctly. The 36 cast sites are rescued by the cast itself
 * (`text[]::bigint[]` is a valid Postgres conversion, verified). So nothing is broken today;
 * this makes site 60 safe, and it fails LOUD (a query error) rather than silently wrong.
 *
 * WHY HERE AND NOT AT THE CALL SITES. The same argument as seedBuiltinArrayTypes above, at the
 * same seam: a per-site `sql.array(x, 20)` has to be remembered by every future caller.
 *
 * WHY int8 RATHER THAN int4. A JS number can exceed int4 range, and Postgres has an
 * `integer = bigint` operator, so int8 compares correctly against int2/int4/int8 columns while
 * int4 would overflow. A value that is not a SAFE integer is typed float8 rather than silently
 * claiming precision int8 does not have.
 *
 * SCOPE, STATED HONESTLY: this patches the client THIS factory returns. A hand-rolled
 * `postgres(getHarnessAdminUrl(), …)` pool that bypasses the factory keeps the old behaviour
 * (those pools are tracked separately as EI-19306394439939264).
 */
export function installNumericArrayTyping(client: Sql): void {
  const original = (client as any)?.array;
  if (typeof original !== 'function') return; // internals moved — the guard test reports this loudly
  if (original[NUMERIC_ARRAY_TYPING] === true) return; // idempotent

  const patched = function (this: unknown, ...args: unknown[]) {
    // postgres-js resolves its two call shapes by Array.isArray(args[0]):
    //   array(values, type?) — the first argument IS the array
    //   array(a, b, c)       — variadic; EVERY argument is an element
    if (Array.isArray(args[0])) {
      if (args.length < 2 || args[1] === undefined) {
        const oid = numericArrayElementOid(args[0]);
        if (oid !== undefined) return original.call(this, args[0], oid);
      }
    } else if (args.length > 0) {
      const oid = numericArrayElementOid(args);
      if (oid !== undefined) return original.call(this, args, oid);
    }
    // Preserve arity EXACTLY: original() re-reads `arguments` for its variadic form, so passing
    // an explicit `undefined` type would be captured as a second element.
    return original.apply(this, args);
  };
  (patched as any)[NUMERIC_ARRAY_TYPING] = true;
  (client as any).array = patched;
}
