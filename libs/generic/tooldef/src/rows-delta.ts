/**
 * rows-delta — server-side delta negotiation for a BARE ROW ARRAY (a sync RESOURCE),
 * the resolver/SSE-path sibling of define-tool's `negotiateToolDelta`. Where the tool
 * path negotiates over a ToolResponse, a sync resolver (e.g. `plans.attention`) returns
 * a plain rows array; this composes the SAME delta primitives (computeRowDigest +
 * computeViewChecksum + diffFromDigest + the cursor codec) to turn "client cursor + the
 * freshly-resolved rows" into a `full` or `delta` response.
 *
 * agent-tool-delta-client-rollout-2026-06-23 P-006 (the 327GB sync win): the UI re-fetches
 * the full ~633KB plans.attention view on every plans-table invalidation. With a delta-aware
 * client (useSyncResource sending its cursor) only the changed rows travel. Correctness is the
 * SAME structural guarantee as the tool path: the response carries the full-view `checksum`, the
 * client verifies its merge against it and refetches a full on any mismatch — never a wrong view.
 */
import {
  computeRowDigest,
  computeRowDigestUncapped,
  computeViewChecksum,
  diffFromDigest,
  encodeDeltaCursor,
  decodeDeltaCursor,
  type DeltaChange,
} from './delta-protocol';
import { putRowDigest, getRowDigest } from './delta-digest-store';

/**
 * Max ENCODED CURSOR LENGTH (chars) that may carry an embedded row digest (`dg`).
 *
 * The cursor rides back as a `?delta=` query param, so it is bounded by the server's request-line
 * / header limit (Node's default max header size is 16 KB) — NOT by the row count that
 * `DELTA_MAX_DIGEST_ENTRIES` governs. Measured live 2026-08-08: a 22,207-char cursor returned
 * HTTP 431 while 14,591 was fine. 8,000 leaves better than 2x headroom for the rest of the
 * request line (route, `name`, and a potentially long `args` JSON) plus all other headers.
 *
 * Above this, the digest is parked server-side and only its id (`di`) travels — the P-024 path.
 */
export const DELTA_MAX_EMBEDDED_CURSOR_CHARS = 8_000;

export interface RowsDeltaResult {
  /** `full` = the complete rows; `delta` = only the changed rows (the token/bandwidth win). */
  mode: 'full' | 'delta';
  /** Present iff `mode==='full'` — the complete current view. */
  rows?: unknown[];
  /** Present iff `mode==='delta'` — the added/updated/removed rows vs the client's cursor base. */
  changes?: DeltaChange[];
  /** Set-based checksum of the FULL current view — the client verifies its merge against this
   *  and refetches a full on mismatch (the no-wrong-view guard). */
  checksum: string;
  /** Fresh cursor to hand back; encodes the current row digest so the NEXT call can diff from it. */
  cursor: string;
  /** The itemKey FIELD NAME, so an out-of-process client merges generically (`row[itemKeyField]`). */
  itemKeyField?: string;
  /**
   * Present iff `mode==='full'` — WHY this call could not delta. Without it a client sees an
   * unexplained full and cannot tell a one-off miss from a view that will never delta, which
   * is the diagnosability half of P-024 (a `full` that says nothing is what hid the original
   * ~822 KB/poll regression for so long).
   *
   * `digest_expired` is the only RECOVERABLE one — the next call re-parks and wins. The rest
   * are either expected-once (`cold`, `schema_changed`) or structural (`no_digest`: the view
   * is over the embed cap and no `viewKey` was supplied, so it can never delta as wired).
   */
  fullReason?: 'cold' | 'malformed_cursor' | 'schema_changed' | 'digest_expired' | 'no_digest';
}

/**
 * Negotiate a `full` vs `delta` response for a resolved rows array. Pure: same inputs →
 * same output. A cold call (no cursor), a cursor for a different schema, or a cursor with
 * no row digest all degrade to `full` (+ a fresh cursor). A cursor whose checksum already
 * matches the current view yields an empty `delta` (nothing changed). Otherwise it diffs the
 * current rows against the cursor's base digest.
 */
export function negotiateRowsDelta(input: {
  /** The client's prior cursor (encodes its base digest), or undefined for a cold full. */
  cursor: string | undefined;
  rows: unknown[];
  itemKey: (row: unknown) => string;
  itemKeyField?: string;
  schemaVersion?: string;
  /**
   * Stable identity of THIS view (e.g. `"plans.list:<canonical args>"`) — enables the
   * large-view path (P-024). Above `DELTA_MAX_DIGEST_ENTRIES` the digest cannot ride the
   * cursor, so it is parked server-side under this key and only an id travels.
   *
   * REQUIRED for that path, not optional politeness: the cursor is client-supplied, and
   * `diffFromDigest` reports `removed` ids, so an unbound id would let one caller pair its
   * own cursor with another view's digest and read back that view's row ids. Omit it and
   * behaviour is exactly as before (a large view degrades to `full`) — safe, just not fixed.
   */
  viewKey?: string;
}): RowsDeltaResult {
  const { cursor, rows, itemKey, itemKeyField, schemaVersion, viewKey } = input;
  const checksum = computeViewChecksum(rows, itemKey);
  const embeddable = computeRowDigest(rows, itemKey);
  // no-http-anywhere-2026-07-28 D-091: P-024 fixed the cliff ABOVE the embed cap; this fixes
  // the one BELOW it, which nobody had measured because it fails as a transport error rather
  // than as a silent `full`.
  //
  // `DELTA_MAX_DIGEST_ENTRIES` is a ROW count, but what actually breaks is CURSOR BYTES: the
  // cursor is echoed back as a `?delta=` QUERY PARAM, so a digest that "fits" by row count can
  // still blow the request line. Measured live on :3170 against `workItems.byHarness`
  // (~49 cursor bytes/row):
  //
  //     100 rows →  4,312 char cursor → 200 OK
  //     300 rows → 14,591 char cursor → 200 OK
  //     450 rows → 22,207 char cursor → **HTTP 431**
  //     500 rows → 24,759 char cursor → **HTTP 431**
  //
  // So views in roughly 320–500 rows sat in a DEAD BAND: small enough to embed, too big to
  // send. The delta path did not degrade there — it 431'd, i.e. the warm poll FAILED outright,
  // which is strictly worse than the full re-send it was meant to replace.
  //
  // Fix: decide embed-vs-park on the ENCODED CURSOR SIZE, the quantity that actually breaks.
  // Parking is already the proven path for every large view (plans.list/byHive/codeRecipes) and
  // a park miss degrades to a normal `full`, so this only ever moves WHERE the digest lives.
  const embedProbe = embeddable
    ? encodeDeltaCursor({
        v: 1,
        fp: '',
        rev: checksum,
        ...(schemaVersion ? { sv: schemaVersion } : {}),
        dg: embeddable,
      })
    : null;
  const embedFits = embedProbe !== null && embedProbe.length <= DELTA_MAX_EMBEDDED_CURSOR_CHARS;
  const digest = embedFits ? embeddable : null;
  // P-024: the measured miss. `plans.list` (933 rows) is over the embed cap, so `digest`
  // is null, the cursor shipped without `dg`, and EVERY warm poll re-sent the full ~822 KB
  // (~52 MB/hour per open window) — while `plans.attention` (165 rows) got 83x on this
  // very function. The cap governs what fits in a cursor, not what can be diffed.
  //
  // ⚠ With no `viewKey` there is nowhere to park, so an over-budget view degrades to a
  // cursor carrying neither `dg` nor `di` → the next call returns `full('no_digest')`. That
  // is the SAME outcome this path already had for oversized views, and still far better than
  // emitting a cursor the next request cannot carry.
  const digestId =
    !digest && viewKey ? putRowDigest(computeRowDigestUncapped(rows, itemKey), viewKey, rows.length) : undefined;
  const freshCursor = encodeDeltaCursor({
    v: 1,
    fp: '',
    rev: checksum,
    ...(schemaVersion ? { sv: schemaVersion } : {}),
    ...(digest ? { dg: digest } : {}),
    ...(digestId ? { di: digestId } : {}),
  });
  const full = (fullReason: RowsDeltaResult['fullReason']): RowsDeltaResult => ({
    mode: 'full',
    rows,
    checksum,
    cursor: freshCursor,
    itemKeyField,
    fullReason,
  });

  if (!cursor) return full('cold');
  const decoded = decodeDeltaCursor(cursor);
  // Malformed or a schema bump → can't diff → full.
  if (!decoded) return full('malformed_cursor');
  if ((decoded.sv ?? '') !== (schemaVersion ?? '')) return full('schema_changed');
  // The prior state is either embedded (`dg`, small views) or parked server-side (`di`,
  // large views — P-024). A `di` miss (eviction, restart, or a viewKey mismatch) is an
  // ordinary miss: degrade to `full`, never to a wrong delta.
  const priorDigest = decoded.dg ?? (decoded.di && viewKey ? getRowDigest(decoded.di, viewKey) : undefined);
  // A cursor that CARRIED a `di` but missed is recoverable (we just re-parked a fresh digest
  // above, so the next call deltas); one that carried neither `dg` nor `di` is structural.
  if (!priorDigest) return full(decoded.di ? 'digest_expired' : 'no_digest');
  // Unchanged view → an empty delta (the client keeps its base; the whole point).
  if (decoded.rev === checksum) {
    return { mode: 'delta', changes: [], checksum, cursor: freshCursor, itemKeyField };
  }
  const changes = diffFromDigest(priorDigest, rows, itemKey);
  return { mode: 'delta', changes, checksum, cursor: freshCursor, itemKeyField };
}
