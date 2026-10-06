/**
 * Hash-chained ledgers on the Postgres side (agent-economy-flywheel-2026-08-30
 * P-040). The Cupboard D1 ledgers (commerce + treasury) are chained in
 * apps/operator-public/src/ledger-chain-store.ts; this module chains the ledgers
 * that live in the operator's Postgres, starting with the per-pot plan-admission
 * governance event log.
 *
 * Shape: a ledger is exposed as a `LedgerSource` (its entries in fold order,
 * each with a stable source id). `witnessLedger` links every entry that has no
 * link yet onto the tail of its stream; `verifyLedger` recomputes the whole
 * chain against the entries and names the FIRST broken position; `exportLedger`
 * writes the stable @papercusp/hash-chain JSONL format, which verifies offline.
 *
 * Witnessing runs AFTER the source append, never inside it: a source keeps its
 * own write path (including rows that arrive from federated peers), and a failed
 * witness pass leaves the entry unchained, which `verifyLedger` reports as
 * `unchainedCount` instead of a broken chain. A mutable (upsert) table must not
 * be a source: chain an append-only record log instead.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
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

export interface LedgerSourceEntry {
  /** Stable identity of the entry in its source (a primary key, a content-addressed key). */
  readonly sourceId: string;
  /** The entry as the source holds it; hashed as canonical JSON. */
  readonly entry: unknown;
}

export interface LedgerSource {
  readonly streamId: string;
  /** Every entry in the stream, in fold order (the order unchained entries are linked). */
  list(): Promise<readonly LedgerSourceEntry[]>;
}

export interface StoredChainLink {
  readonly sourceId: string;
  readonly link: ChainLink;
}

/** Where links live. Appends are all-or-nothing; a lost race reports `conflict`. */
export interface LedgerChainLinkStore {
  links(workspaceId: string, streamId: string): Promise<readonly StoredChainLink[]>;
  append(workspaceId: string, links: readonly StoredChainLink[]): Promise<'ok' | 'conflict'>;
}

interface LinkDbRow {
  stream_id: string;
  seq: string | number;
  source_id: string;
  entry_digest: string;
  prev_hash: string;
  entry_hash: string;
}

/** `harness_shared.ledger_chain_links` (migration 1283, append-only by trigger). */
export function pgLedgerChainLinkStore(sql?: Sql): LedgerChainLinkStore {
  const db = (): Sql => sql ?? getOrgPg().sql;
  return {
    async links(workspaceId, streamId) {
      const rows = (await db().unsafe(
        `SELECT stream_id, seq, source_id, entry_digest, prev_hash, entry_hash
           FROM harness_shared.ledger_chain_links
          WHERE workspace_id = $1 AND stream_id = $2
          ORDER BY seq ASC`,
        [workspaceId, streamId],
      )) as unknown as LinkDbRow[];
      return rows.map((row) => ({
        sourceId: row.source_id,
        link: {
          streamId: row.stream_id,
          seq: Number(row.seq),
          prevHash: row.prev_hash,
          entryDigest: row.entry_digest,
          entryHash: row.entry_hash,
        },
      }));
    },
    async append(workspaceId, links) {
      if (links.length === 0) return 'ok';
      const params: unknown[] = [];
      const tuples = links.map(({ sourceId, link }) => {
        const base = params.length;
        params.push(workspaceId, link.streamId, link.seq, sourceId, link.entryDigest, link.prevHash, link.entryHash);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      try {
        // One statement: the whole batch commits or none of it does.
        await db().unsafe(
          `INSERT INTO harness_shared.ledger_chain_links
             (workspace_id, stream_id, seq, source_id, entry_digest, prev_hash, entry_hash)
           VALUES ${tuples.join(', ')}`,
          params as never[],
        );
        return 'ok';
      } catch (error) {
        if ((error as { code?: string }).code === '23505') return 'conflict';
        throw error;
      }
    },
  };
}

/** In-process link store with the same contract (tests, offline tooling). */
export function memoryLedgerChainLinkStore(): LedgerChainLinkStore & {
  readonly rows: StoredChainLink[];
} {
  const rows: StoredChainLink[] = [];
  const key = (workspaceId: string, streamId: string) => `${workspaceId}\u0000${streamId}`;
  const owner = new Map<StoredChainLink, string>();
  return {
    rows,
    async links(workspaceId, streamId) {
      return rows
        .filter((row) => owner.get(row) === key(workspaceId, streamId))
        .sort((a, b) => a.link.seq - b.link.seq);
    },
    async append(workspaceId, links) {
      for (const candidate of links) {
        const k = key(workspaceId, candidate.link.streamId);
        const clash = rows.some(
          (row) =>
            owner.get(row) === k &&
            (row.link.seq === candidate.link.seq || row.sourceId === candidate.sourceId),
        );
        if (clash) return 'conflict';
      }
      for (const candidate of links) {
        const stored = { sourceId: candidate.sourceId, link: { ...candidate.link } };
        owner.set(stored, key(workspaceId, candidate.link.streamId));
        rows.push(stored);
      }
      return 'ok';
    },
  };
}

export interface WitnessLedgerResult {
  readonly streamId: string;
  readonly appended: number;
  readonly head: ChainLink | null;
}

/**
 * Link every entry of `source` that has no link yet, in fold order. Idempotent.
 * A concurrent witness loses on the (workspace, stream, seq) key, retries from
 * the new head, and the chain never forks.
 */
export async function witnessLedger(
  workspaceId: string,
  source: LedgerSource,
  store: LedgerChainLinkStore,
  opts: { readonly maxConflicts?: number } = {},
): Promise<WitnessLedgerResult> {
  const maxConflicts = opts.maxConflicts ?? 5;
  for (let conflicts = 0; ; conflicts += 1) {
    const stored = await store.links(workspaceId, source.streamId);
    const linked = new Set(stored.map((row) => row.sourceId));
    const head = stored.length > 0 ? stored[stored.length - 1]!.link : null;
    const pending = (await source.list()).filter((entry) => !linked.has(entry.sourceId));
    if (pending.length === 0) return { streamId: source.streamId, appended: 0, head };
    const links = appendLinks(
      source.streamId,
      head,
      pending.map((entry) => entryDigest(entry.entry)),
    );
    const outcome = await store.append(
      workspaceId,
      links.map((link, i) => ({ sourceId: pending[i]!.sourceId, link })),
    );
    if (outcome === 'ok') {
      return { streamId: source.streamId, appended: links.length, head: links[links.length - 1]! };
    }
    if (conflicts >= maxConflicts) {
      throw new Error(`witnessLedger(${source.streamId}): gave up after ${conflicts + 1} conflicting appends`);
    }
  }
}

/** Witness after a source append; a failure is logged, never thrown into the committed append. */
export async function witnessLedgerAfterAppend(
  workspaceId: string,
  source: LedgerSource,
  store: LedgerChainLinkStore,
): Promise<void> {
  try {
    await witnessLedger(workspaceId, source, store);
  } catch (error) {
    console.error(`[ledger-chain] witness ${source.streamId} failed; entries stay unchained until the next pass`, error);
  }
}

export interface LedgerReport {
  readonly streamId: string;
  readonly verdict: ChainVerdict;
  /** Entries with no link: appended but not (yet) witnessed. */
  readonly unchainedCount: number;
  readonly unchainedSample: readonly string[];
  /** True only when the chain verifies AND every entry is chained. */
  readonly ok: boolean;
}

async function loadRecords(
  workspaceId: string,
  source: LedgerSource,
  store: LedgerChainLinkStore,
): Promise<{ records: ChainRecord[]; unchained: string[] }> {
  const stored = await store.links(workspaceId, source.streamId);
  const entries = await source.list();
  const bySource = new Map<string, LedgerSourceEntry>();
  for (const entry of entries) bySource.set(entry.sourceId, entry);
  const linked = new Set<string>();
  const records: ChainRecord[] = stored.map(({ sourceId, link }) => {
    linked.add(sourceId);
    const entry = bySource.get(sourceId);
    return entry ? { link, entry: entry.entry } : { link, entryMissing: true };
  });
  const unchained = entries.map((entry) => entry.sourceId).filter((id) => !linked.has(id));
  return { records, unchained };
}

/** Recompute the stream's chain against its entries and report the first break. */
export async function verifyLedger(
  workspaceId: string,
  source: LedgerSource,
  store: LedgerChainLinkStore,
  opts: { readonly expectedHead?: ChainHead | null } = {},
): Promise<LedgerReport> {
  const { records, unchained } = await loadRecords(workspaceId, source, store);
  const verdict = verifyChain(source.streamId, records, {
    requireEntries: true,
    ...(opts.expectedHead ? { expectedHead: opts.expectedHead } : {}),
  });
  return {
    streamId: source.streamId,
    verdict,
    unchainedCount: unchained.length,
    unchainedSample: unchained.slice(0, 20),
    ok: verdict.ok && unchained.length === 0,
  };
}

/** The stream in the stable @papercusp/hash-chain JSONL export format. */
export async function exportLedger(
  workspaceId: string,
  source: LedgerSource,
  store: LedgerChainLinkStore,
): Promise<string> {
  const { records } = await loadRecords(workspaceId, source, store);
  return exportChain(source.streamId, records);
}
