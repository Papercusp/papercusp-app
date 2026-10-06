/**
 * Hash-chained ledgers on D1 (agent-economy-flywheel P-040; D-021).
 *
 * Each append-only ledger table below is a STREAM. A row is chained by
 * "witnessing" it: the next link in `ledger_chain_links` commits to the previous
 * link's hash and to a digest of the row's committed columns (format:
 * @papercusp/hash-chain). Stores call `witnessLedgerStream` right after they
 * append, so in steady state every row is chained within the same request; a
 * crash between append and witness leaves the row UNCHAINED, which
 * `verifyLedgerStream` reports (and the next witness pass repairs) instead of
 * hiding.
 *
 * The committed column list of a stream is part of its format: changing it
 * changes the digest of every existing row, so a schema change that must be
 * committed gets a NEW stream id, never an edited list.
 *
 * What the chain guarantees: once a row is linked, editing it, deleting it,
 * deleting/reordering links, or splicing a forged row anywhere but the tail is
 * detected, and the verdict names the first break. Truncating the tail is
 * detected only against an independently published head (P-041 anchors one).
 */
import {
  appendLinks,
  entryDigest,
  exportChain,
  verifyChain,
  type ChainHead,
  type ChainLink,
  type ChainRecord,
  type ChainVerdict,
} from '@papercusp/hash-chain';

export const LEDGER_STREAM_IDS = [
  'commerce.ledger',
  'commerce.event-log',
  'commerce.prepaid-credits',
  'treasury.transfers',
  'treasury.safe-deployment-records',
] as const;
export type LedgerStreamId = (typeof LEDGER_STREAM_IDS)[number];

interface StreamSpec {
  readonly table: string;
  /** TEXT source id, written against the `src` alias. */
  readonly sourceIdSql: string;
  /** Columns the chain commits to. FROZEN once rows are chained (see header). */
  readonly columns: readonly string[];
  /** Witness order for rows not yet chained, against the `src` alias. */
  readonly orderSql: string;
}

const STREAMS: Readonly<Record<LedgerStreamId, StreamSpec>> = {
  'commerce.ledger': {
    table: 'commerce_ledger_events',
    sourceIdSql: 'src.ledger_event_id',
    columns: ['ledger_event_id', 'kind', 'occurred_at_ms', 'provider', 'provider_event_id', 'payload_json'],
    orderSql: 'src.occurred_at_ms ASC, src.ledger_event_id ASC',
  },
  'commerce.event-log': {
    table: 'commerce_event_log',
    sourceIdSql: 'src.event_id',
    columns: [
      'event_id',
      'stream_id',
      'kind',
      'version',
      'issuer',
      'sequence',
      'occurred_at_ms',
      'idempotency_key',
      'payload',
      'signature',
      'recorded_at_ms',
    ],
    orderSql: 'src.recorded_at_ms ASC, src.stream_id ASC, src.sequence ASC, src.event_id ASC',
  },
  'commerce.prepaid-credits': {
    table: 'prepaid_credit_events',
    sourceIdSql: 'src.credit_event_id',
    columns: ['credit_event_id', 'kind', 'occurred_at_ms', 'principal_id', 'payload_json'],
    orderSql: 'src.occurred_at_ms ASC, src.credit_event_id ASC',
  },
  'treasury.transfers': {
    table: 'treasury_transfers',
    sourceIdSql: 'src.transfer_id',
    columns: [
      'transfer_id',
      'batch_id',
      'channel_id',
      'principal_id',
      'settlement_id',
      'receipt_hash',
      'split_manifest_hash',
      'share',
      'role',
      'chain_id',
      'safe_address',
      'roles_module_address',
      'token',
      'recipient',
      'amount_micros',
      'safe_tx_hash',
      'transaction_hash',
      'block_number',
      'proof_event_id',
      'created_at_ms',
    ],
    orderSql: 'src.created_at_ms ASC, src.transfer_id ASC',
  },
  // treasury_safe_deployments itself is NOT chained: it is an upsert REGISTRY (a
  // re-record overwrites the row), so a link to an old version would read as
  // tampering. recordSafeDeployment appends every record to this log in the same
  // batch, and the log is what is chained (mig 037).
  'treasury.safe-deployment-records': {
    table: 'treasury_safe_deployment_records',
    sourceIdSql: 'src.record_id',
    columns: [
      'record_id',
      'chain_id',
      'safe_address',
      'roles_module_address',
      'roles_version',
      'deployment_tx_hash',
      'network',
      'owners',
      'threshold',
      'automation_signer',
      'deployed_at_ms',
      'recorded_at_ms',
      'recorded_by',
    ],
    orderSql: 'src.recorded_at_ms ASC, src.record_id ASC',
  },
};

export function isLedgerStreamId(value: string): value is LedgerStreamId {
  return (LEDGER_STREAM_IDS as readonly string[]).includes(value);
}

interface LinkRow {
  stream_id: string;
  seq: number;
  source_id: string;
  entry_digest: string;
  prev_hash: string;
  entry_hash: string;
}

type SourceRow = Record<string, unknown> & { __source_id: string };

function toLink(row: LinkRow): ChainLink {
  return {
    streamId: row.stream_id,
    seq: Number(row.seq),
    prevHash: row.prev_hash,
    entryDigest: row.entry_digest,
    entryHash: row.entry_hash,
  };
}

/** The committed entry of a source row: exactly the stream's frozen columns. */
function entryOf(spec: StreamSpec, row: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const column of spec.columns) entry[column] = row[column] ?? null;
  return entry;
}

function selectSql(spec: StreamSpec): string {
  const cols = spec.columns.map((c) => `src.${c}`).join(', ');
  return `SELECT ${spec.sourceIdSql} AS __source_id, ${cols} FROM ${spec.table} AS src`;
}

async function readHeadLink(db: D1Database, streamId: LedgerStreamId): Promise<ChainLink | null> {
  const row = await db
    .prepare(
      'SELECT stream_id, seq, source_id, entry_digest, prev_hash, entry_hash FROM ledger_chain_links WHERE stream_id = ? ORDER BY seq DESC LIMIT 1',
    )
    .bind(streamId)
    .first<LinkRow>();
  return row ? toLink(row) : null;
}

export interface WitnessResult {
  readonly streamId: LedgerStreamId;
  readonly appended: number;
  readonly head: ChainLink | null;
}

/**
 * Chain every row of `streamId` that has no link yet, in the stream's fold
 * order. Idempotent. Two concurrent witnesses race on the (stream_id, seq)
 * primary key: the loser's batch rolls back whole and it retries from the new
 * head, so the chain never forks.
 */
export async function witnessLedgerStream(
  db: D1Database,
  streamId: LedgerStreamId,
  nowMs: number,
  opts: { readonly batchSize?: number; readonly maxConflicts?: number } = {},
): Promise<WitnessResult> {
  const spec = STREAMS[streamId];
  const batchSize = opts.batchSize ?? 200;
  const maxConflicts = opts.maxConflicts ?? 5;
  let appended = 0;
  let conflicts = 0;
  for (;;) {
    const head = await readHeadLink(db, streamId);
    const pending = await db
      .prepare(
        `${selectSql(spec)} WHERE NOT EXISTS (SELECT 1 FROM ledger_chain_links AS l WHERE l.stream_id = ? AND l.source_id = ${spec.sourceIdSql}) ORDER BY ${spec.orderSql} LIMIT ?`,
      )
      .bind(streamId, batchSize)
      .all<SourceRow>();
    const rows = pending.results ?? [];
    if (rows.length === 0) return { streamId, appended, head };
    const links = appendLinks(
      streamId,
      head,
      rows.map((row) => entryDigest(entryOf(spec, row))),
    );
    try {
      await db.batch(
        links.map((link, i) =>
          db
            .prepare(
              'INSERT INTO ledger_chain_links (stream_id, seq, source_id, entry_digest, prev_hash, entry_hash, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(streamId, link.seq, String(rows[i]!.__source_id), link.entryDigest, link.prevHash, link.entryHash, nowMs),
        ),
      );
    } catch (error) {
      conflicts += 1;
      if (conflicts > maxConflicts) {
        throw new Error(`witnessLedgerStream(${streamId}): gave up after ${conflicts} conflicting appends: ${String(error)}`);
      }
      continue;
    }
    appended += links.length;
    if (rows.length < batchSize) return { streamId, appended, head: links[links.length - 1]! };
  }
}

/**
 * Witness after a store append. Chaining failure must not fail the append that
 * already committed (the row is the source of truth), so it is reported, and
 * the row stays visible as `unchained` in `verifyLedgerStream` until a later
 * witness pass links it.
 */
export async function witnessAfterAppend(db: D1Database, streamId: LedgerStreamId, nowMs: number): Promise<void> {
  try {
    await witnessLedgerStream(db, streamId, nowMs);
  } catch (error) {
    console.error(`[ledger-chain] witness ${streamId} failed; rows stay unchained until the next pass`, error);
  }
}

export interface LedgerStreamReport {
  readonly streamId: LedgerStreamId;
  readonly verdict: ChainVerdict;
  /** Source rows with no link: appended but not (yet) chained, or inserted around the store. */
  readonly unchainedCount: number;
  readonly unchainedSample: readonly string[];
  /** True only when the chain verifies AND every source row is chained. */
  readonly ok: boolean;
}

async function loadRecords(
  db: D1Database,
  streamId: LedgerStreamId,
): Promise<{ records: ChainRecord[]; unchained: string[] }> {
  const spec = STREAMS[streamId];
  const links = await db
    .prepare(
      'SELECT stream_id, seq, source_id, entry_digest, prev_hash, entry_hash FROM ledger_chain_links WHERE stream_id = ? ORDER BY seq ASC',
    )
    .bind(streamId)
    .all<LinkRow>();
  const rows = await db.prepare(selectSql(spec)).all<SourceRow>();
  const bySource = new Map<string, SourceRow>();
  for (const row of rows.results ?? []) bySource.set(String(row.__source_id), row);
  const linked = new Set<string>();
  const records: ChainRecord[] = [];
  for (const linkRow of links.results ?? []) {
    linked.add(linkRow.source_id);
    const row = bySource.get(linkRow.source_id);
    records.push(row ? { link: toLink(linkRow), entry: entryOf(spec, row) } : { link: toLink(linkRow), entryMissing: true });
  }
  const unchained = [...bySource.keys()].filter((id) => !linked.has(id));
  return { records, unchained };
}

/** Recompute the stream's chain against its source rows and report the first break. */
export async function verifyLedgerStream(
  db: D1Database,
  streamId: LedgerStreamId,
  opts: { readonly expectedHead?: ChainHead | null } = {},
): Promise<LedgerStreamReport> {
  const { records, unchained } = await loadRecords(db, streamId);
  const verdict = verifyChain(streamId, records, {
    requireEntries: true,
    ...(opts.expectedHead ? { expectedHead: opts.expectedHead } : {}),
  });
  return {
    streamId,
    verdict,
    unchainedCount: unchained.length,
    unchainedSample: unchained.slice(0, 20),
    ok: verdict.ok && unchained.length === 0,
  };
}

/** The stream in the stable @papercusp/hash-chain JSONL export format. */
export async function exportLedgerStream(db: D1Database, streamId: LedgerStreamId): Promise<string> {
  const { records } = await loadRecords(db, streamId);
  return exportChain(streamId, records);
}

// ---------------------------------------------------------------------------
// Anchor feed (agent-economy-flywheel-2026-08-30 D-027): every chain link,
// across every stream, in (stream_id, seq) order. The operator anchors these
// as leaves of its per-workspace Merkle log; the identity is the link, so a
// verifier recomputes it from the stream export above.
// ---------------------------------------------------------------------------

export interface ChainLinkIdentity {
  readonly streamId: string;
  readonly seq: number;
  readonly entryHash: string;
}

export interface ChainLinkPage {
  readonly links: readonly ChainLinkIdentity[];
  /** Opaque; pass back as `after` for the next page. Null on the last page. */
  readonly nextCursor: string | null;
}

export const CHAIN_LINK_PAGE_MAX = 1000;

/** Cursor = `<streamId>:<seq>` of the last link returned. Malformed input → null. */
export function parseChainLinkCursor(cursor: string): { readonly streamId: string; readonly seq: number } | null {
  const sep = cursor.lastIndexOf(':');
  if (sep <= 0) return null;
  const streamId = cursor.slice(0, sep);
  const seq = Number(cursor.slice(sep + 1));
  if (!isLedgerStreamId(streamId) || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { streamId, seq };
}

export async function listChainLinksPage(
  db: D1Database,
  opts: { readonly after?: { readonly streamId: string; readonly seq: number } | null; readonly limit?: number } = {},
): Promise<ChainLinkPage> {
  const limit = Math.max(1, Math.min(CHAIN_LINK_PAGE_MAX, Math.trunc(opts.limit ?? CHAIN_LINK_PAGE_MAX)));
  const after = opts.after ?? null;
  const stmt = after
    ? db
        .prepare(
          'SELECT stream_id, seq, entry_hash FROM ledger_chain_links WHERE stream_id > ? OR (stream_id = ? AND seq > ?) ORDER BY stream_id ASC, seq ASC LIMIT ?',
        )
        .bind(after.streamId, after.streamId, after.seq, limit + 1)
    : db.prepare('SELECT stream_id, seq, entry_hash FROM ledger_chain_links ORDER BY stream_id ASC, seq ASC LIMIT ?').bind(limit + 1);
  const rows = (await stmt.all<{ stream_id: string; seq: number; entry_hash: string }>()).results ?? [];
  const page = rows.slice(0, limit).map((r) => ({ streamId: r.stream_id, seq: Number(r.seq), entryHash: r.entry_hash }));
  const last = page[page.length - 1];
  return { links: page, nextCursor: rows.length > limit && last ? `${last.streamId}:${last.seq}` : null };
}
