/**
 * The stable export format: canonical JSON Lines.
 *
 *   line 1      header  {"format":"papercusp.hash-chain","genesis":"00…","head":{…}|null,
 *                        "length":N,"streamId":"…","version":1}
 *   lines 2..N+1 record  {"entry":<entry>,"link":{"entryDigest","entryHash","prevHash","seq","streamId"}}
 *                        (or {"entryMissing":true,"link":{…}} when the store lost the entry)
 *
 * Every line is canonical JSON (see canonical-json.ts) and the file ends with a
 * single newline, so an export is a pure function of the chain: exporting the
 * same chain twice yields identical bytes, and `exportChain(parseChainExport(t))`
 * reproduces `t` exactly. The parser is strict for the same reason — a
 * non-canonical line is a second encoding of the same chain, so it is refused.
 *
 * The header's `head` is the last link the exporter held. `verifyChainExport`
 * checks the records against it, so dropping records from the body is caught;
 * dropping them from the body AND the header is the tail truncation only an
 * independently published head (an anchor) can expose — pass it as
 * `expectedHead`.
 */
import { canonicalJson } from './canonical-json';
import {
  GENESIS_PREV_HASH,
  HASH_CHAIN_FORMAT,
  HASH_CHAIN_VERSION,
  verifyChain,
  type ChainHead,
  type ChainLink,
  type ChainRecord,
  type ChainVerdict,
  type VerifyChainOptions,
} from './chain';

export interface ChainExportHeader {
  readonly format: typeof HASH_CHAIN_FORMAT;
  readonly version: typeof HASH_CHAIN_VERSION;
  readonly streamId: string;
  readonly length: number;
  readonly head: ChainHead | null;
  readonly genesis: string;
}

export interface ParsedChainExport {
  readonly header: ChainExportHeader;
  readonly records: readonly ChainRecord[];
}

export class ChainExportError extends Error {
  override readonly name = 'ChainExportError';
}

export function exportChain(streamId: string, records: readonly ChainRecord[]): string {
  const last = records.length > 0 ? records[records.length - 1]!.link : null;
  const header: ChainExportHeader = {
    format: HASH_CHAIN_FORMAT,
    version: HASH_CHAIN_VERSION,
    streamId,
    length: records.length,
    head: last ? { seq: last.seq, entryHash: last.entryHash } : null,
    genesis: GENESIS_PREV_HASH,
  };
  const lines = [canonicalJson(header)];
  for (const record of records) lines.push(canonicalJson(encodeRecord(record)));
  return `${lines.join('\n')}\n`;
}

function encodeRecord(record: ChainRecord): Record<string, unknown> {
  const link = linkFields(record.link);
  if (record.entryMissing) return { entryMissing: true, link };
  if (!('entry' in record)) {
    throw new ChainExportError(`record seq ${record.link.seq} has no entry; export the entry or mark it entryMissing`);
  }
  return { entry: record.entry, link };
}

function linkFields(link: ChainLink): ChainLink {
  return {
    streamId: link.streamId,
    seq: link.seq,
    prevHash: link.prevHash,
    entryDigest: link.entryDigest,
    entryHash: link.entryHash,
  };
}

export function parseChainExport(text: string): ParsedChainExport {
  if (!text.endsWith('\n')) throw new ChainExportError('export must end with a single newline');
  const lines = text.slice(0, -1).split('\n');
  const header = parseHeader(lines[0] ?? '');
  const records: ChainRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) records.push(parseRecord(lines[i]!, i + 1));
  if (records.length !== header.length) {
    throw new ChainExportError(`header declares ${header.length} records, body has ${records.length}`);
  }
  return { header, records };
}

function parseCanonicalLine(line: string, lineNo: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new ChainExportError(`line ${lineNo}: not JSON (${(error as Error).message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChainExportError(`line ${lineNo}: expected a JSON object`);
  }
  if (canonicalJson(value) !== line) throw new ChainExportError(`line ${lineNo}: not canonical JSON`);
  return value as Record<string, unknown>;
}

function parseHeader(line: string): ChainExportHeader {
  const h = parseCanonicalLine(line, 1);
  if (h.format !== HASH_CHAIN_FORMAT) throw new ChainExportError(`line 1: format must be '${HASH_CHAIN_FORMAT}'`);
  if (h.version !== HASH_CHAIN_VERSION) throw new ChainExportError(`line 1: unsupported version ${String(h.version)}`);
  if (typeof h.streamId !== 'string' || !h.streamId) throw new ChainExportError('line 1: streamId is required');
  if (!Number.isSafeInteger(h.length) || (h.length as number) < 0) throw new ChainExportError('line 1: bad length');
  if (h.genesis !== GENESIS_PREV_HASH) throw new ChainExportError('line 1: unexpected genesis hash');
  const keys = Object.keys(h).sort().join(',');
  if (keys !== 'format,genesis,head,length,streamId,version') {
    throw new ChainExportError(`line 1: unexpected header fields (${keys})`);
  }
  const head = h.head;
  if (head !== null) {
    const ok =
      typeof head === 'object' &&
      Number.isSafeInteger((head as ChainHead).seq) &&
      typeof (head as ChainHead).entryHash === 'string' &&
      Object.keys(head as object).sort().join(',') === 'entryHash,seq';
    if (!ok) throw new ChainExportError('line 1: head must be null or {seq, entryHash}');
  }
  return h as unknown as ChainExportHeader;
}

function parseRecord(line: string, lineNo: number): ChainRecord {
  const r = parseCanonicalLine(line, lineNo);
  const keys = Object.keys(r).sort().join(',');
  const link = r.link as ChainLink | undefined;
  if (!link || typeof link !== 'object' || Array.isArray(link)) {
    throw new ChainExportError(`line ${lineNo}: record has no link object`);
  }
  if (Object.keys(link).sort().join(',') !== 'entryDigest,entryHash,prevHash,seq,streamId') {
    throw new ChainExportError(`line ${lineNo}: unexpected link fields`);
  }
  if (keys === 'entry,link') return { link, entry: r.entry };
  if (keys === 'entryMissing,link' && r.entryMissing === true) return { link, entryMissing: true };
  throw new ChainExportError(`line ${lineNo}: unexpected record fields (${keys})`);
}

/**
 * Parse and fully verify an export. A malformed file is a broken chain too, so
 * parse errors come back as a `malformed` break rather than a throw.
 */
export function verifyChainExport(
  text: string,
  options: Omit<VerifyChainOptions, 'requireEntries'> = {},
): ChainVerdict {
  let parsed: ParsedChainExport;
  try {
    parsed = parseChainExport(text);
  } catch (error) {
    return {
      ok: false,
      streamId: '',
      length: 0,
      verifiedThrough: null,
      firstBreak: { index: 0, seq: null, reason: 'malformed', detail: (error as Error).message },
    };
  }
  const { header, records } = parsed;
  const inner = verifyChain(header.streamId, records, {
    ...options,
    requireEntries: true,
    expectedHead: header.head,
  });
  if (!inner.ok || !options.expectedHead) return inner;
  // The caller's independently published head outranks the file's own header.
  return verifyChain(header.streamId, records, { ...options, requireEntries: true });
}
