/**
 * generic-rag-chunking-2026-09-29 P-013 (R-31, EI-24609404813504679): every
 * embed-backfill TARGET must name a search site that reads the vector it fills.
 *
 * The sweep only ever WRITES vectors, so nothing forced a target to have a
 * reader, and three write-only vectors accumulated before anyone noticed:
 * carry_notes.note_embedding, harness_docs.embedding and
 * coord_thread_posts.body_embedding (the last with 1.1M vectors and a 4.3 GB
 * HNSW index). Each paid embed compute on every sweep and a full re-embed on
 * every width migration for nothing.
 *
 * This module is the PURE check. File I/O is injected (`readSource`) so the
 * unit test can plant readerless or stale targets next to the real TARGETS.
 */
import type { EmbedVectorReader } from './embed-backfill';

/**
 * Substrings that mark a query-time READ of a stored vector: the pgvector
 * distance operators, plus a call to the chunk-aware vector leg, a declared
 * reader in its own right that applies `<=>` to the columns it is handed.
 */
export const VECTOR_READ_MARKERS: readonly string[] = [
  '<=>',
  '<->',
  '<#>',
  '<+>',
  'chunkAwareVectorLegSql(',
  'chunkAwareVectorLeg(',
];

export type ReaderViolationReason =
  /** The target declares no reader at all. */
  | 'no-readers'
  /** A reader names a file that does not exist. */
  | 'file-missing'
  /** A reader declares no evidence substrings. */
  | 'no-evidence'
  /** An evidence substring is not in the named file (the reader was removed or rewritten). */
  | 'evidence-missing'
  /** None of a reader's evidence is a vector read (only table names, say). */
  | 'no-vector-read';

export interface ReaderViolation {
  table: string;
  embedCol: string;
  reason: ReaderViolationReason;
  file?: string;
  evidence?: string;
}

/** The shape the check needs. `readers` is optional so a readerless target can be planted. */
export interface ReaderCheckTarget {
  table: string;
  embedCol: string;
  readers?: readonly EmbedVectorReader[];
}

/** True when the text carries one of {@link VECTOR_READ_MARKERS}. */
export function isVectorRead(text: string): boolean {
  return VECTOR_READ_MARKERS.some((m) => text.includes(m));
}

/**
 * Every violation across `targets`; an empty array means every target has at
 * least one reader, every reader's file exists and still contains all of its
 * evidence, and each reader's evidence includes a vector read.
 *
 * `readSource` returns a repo-relative file's text, or null when it is absent.
 */
export function findReaderViolations(
  targets: readonly ReaderCheckTarget[],
  readSource: (repoRelativePath: string) => string | null,
): ReaderViolation[] {
  const out: ReaderViolation[] = [];
  const cache = new Map<string, string | null>();
  const read = (file: string): string | null => {
    if (!cache.has(file)) cache.set(file, readSource(file));
    return cache.get(file) ?? null;
  };

  for (const t of targets) {
    const base = { table: t.table, embedCol: t.embedCol };
    const readers = t.readers ?? [];
    if (readers.length === 0) {
      out.push({ ...base, reason: 'no-readers' });
      continue;
    }
    for (const r of readers) {
      const text = read(r.file);
      if (text == null) {
        out.push({ ...base, reason: 'file-missing', file: r.file });
        continue;
      }
      if (r.evidence.length === 0) {
        out.push({ ...base, reason: 'no-evidence', file: r.file });
        continue;
      }
      for (const e of r.evidence) {
        if (!text.includes(e)) out.push({ ...base, reason: 'evidence-missing', file: r.file, evidence: e });
      }
      if (!r.evidence.some(isVectorRead)) out.push({ ...base, reason: 'no-vector-read', file: r.file });
    }
  }
  return out;
}

/** One line per violation, for an assertion message a reader can act on. */
export function describeReaderViolation(v: ReaderViolation): string {
  const where = v.file ? ` in ${v.file}` : '';
  const what = v.evidence ? `: ${JSON.stringify(v.evidence)}` : '';
  return `${v.table}.${v.embedCol} ${v.reason}${where}${what}`;
}
