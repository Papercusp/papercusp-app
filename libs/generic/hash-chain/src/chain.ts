/**
 * Per-stream hash chains.
 *
 * A stream is an ordered, append-only sequence of entries. Each entry gets a
 * LINK: its position (`seq`, 0-based and gap-free), the hash of the previous
 * link (`prevHash`, a fixed all-zero genesis for `seq` 0), a digest of the entry
 * itself, and `entryHash`, which commits to all of those plus the stream id.
 * Changing, deleting, inserting or reordering any entry or link therefore
 * breaks the chain at that point, and `verifyChain` names the FIRST break.
 *
 * What a chain alone cannot detect is truncation of the TAIL: dropping the last
 * k entries leaves a shorter chain that is internally valid. Pass the head you
 * published elsewhere (an anchor, a previous export, a transparency log) as
 * `expectedHead` and truncation is reported as `head-mismatch`.
 *
 * The module is storage-agnostic: callers keep links wherever they keep the
 * entries and hand `verifyChain` the records in `seq` order. It never sorts —
 * sorting would hide the reordering it exists to catch.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

export const HASH_CHAIN_FORMAT = 'papercusp.hash-chain' as const;
export const HASH_CHAIN_VERSION = 1 as const;
/** `prevHash` of the first link in every stream. */
export const GENESIS_PREV_HASH = '0'.repeat(64);

const ENTRY_DOMAIN = 'papercusp.hash-chain/v1/entry\n';
const LINK_DOMAIN = 'papercusp.hash-chain/v1/link\n';
const HEX64 = /^[0-9a-f]{64}$/;

export interface ChainHead {
  readonly seq: number;
  readonly entryHash: string;
}

export interface ChainLink extends ChainHead {
  readonly streamId: string;
  readonly prevHash: string;
  readonly entryDigest: string;
}

/**
 * One position in a stream as handed to the verifier. `entry` is the logical
 * entry the link commits to; leave it out to verify link structure only.
 * `entryMissing: true` means the store has the link but the entry it points at
 * is gone — a deletion the verifier reports as `entry-missing`.
 */
export interface ChainRecord {
  readonly link: ChainLink;
  readonly entry?: unknown;
  readonly entryMissing?: boolean;
}

export type ChainBreakReason =
  /** A link names a different stream than the one being verified. */
  | 'stream-mismatch'
  /** `seq` is not the next position: a link was deleted, inserted or reordered. */
  | 'seq-gap'
  /** `prevHash` is not the previous link's `entryHash`: a link was spliced or rewritten. */
  | 'prev-mismatch'
  /** `entryHash` does not match its own fields: the link was edited. */
  | 'link-hash-mismatch'
  /** The entry's recomputed digest differs from the link: the entry was edited. */
  | 'entry-mismatch'
  /** The link exists but its entry is gone (or was required and not supplied). */
  | 'entry-missing'
  /** A field has the wrong shape (non-hex hash, negative seq, …). */
  | 'malformed'
  /** The chain does not end at the expected head: the tail was truncated or forked. */
  | 'head-mismatch';

export interface ChainBreak {
  /** Index into the records array (equals `seq` on an intact prefix). */
  readonly index: number;
  readonly seq: number | null;
  readonly reason: ChainBreakReason;
  readonly detail: string;
}

export type ChainVerdict =
  | {
      readonly ok: true;
      readonly streamId: string;
      readonly length: number;
      readonly head: ChainLink | null;
    }
  | {
      readonly ok: false;
      readonly streamId: string;
      /** Records verified before the first break. */
      readonly length: number;
      /** The last link that verified, or null if the break is at the start. */
      readonly verifiedThrough: ChainLink | null;
      readonly firstBreak: ChainBreak;
    };

export interface VerifyChainOptions {
  /** Every record must carry its entry (a full audit). Default false. */
  readonly requireEntries?: boolean;
  /** How an entry is digested; default {@link entryDigest}. */
  readonly digestEntry?: (entry: unknown) => string;
  /** A head published elsewhere; detects tail truncation and forks. */
  readonly expectedHead?: ChainHead | null;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Digest of one entry: SHA-256 over a domain tag and its canonical JSON. */
export function entryDigest(entry: unknown): string {
  return sha256Hex(ENTRY_DOMAIN + canonicalJson(entry));
}

/** The hash a link commits to: its stream, position, predecessor and entry digest. */
export function linkHash(input: {
  readonly streamId: string;
  readonly seq: number;
  readonly prevHash: string;
  readonly entryDigest: string;
}): string {
  return sha256Hex(
    LINK_DOMAIN +
      canonicalJson({
        entryDigest: input.entryDigest,
        prevHash: input.prevHash,
        seq: input.seq,
        streamId: input.streamId,
      }),
  );
}

/** The link for the next entry after `head` (or the first entry when `head` is null). */
export function appendLink(streamId: string, head: ChainLink | null, digest: string): ChainLink {
  if (!streamId) throw new Error('appendLink: streamId is required');
  if (!HEX64.test(digest)) throw new Error('appendLink: entry digest must be 64 lowercase hex characters');
  if (head && head.streamId !== streamId) {
    throw new Error(`appendLink: head belongs to stream '${head.streamId}', not '${streamId}'`);
  }
  const seq = head ? head.seq + 1 : 0;
  const prevHash = head ? head.entryHash : GENESIS_PREV_HASH;
  return { streamId, seq, prevHash, entryDigest: digest, entryHash: linkHash({ streamId, seq, prevHash, entryDigest: digest }) };
}

/** Links for a run of entry digests appended in order after `head`. */
export function appendLinks(streamId: string, head: ChainLink | null, digests: readonly string[]): ChainLink[] {
  const out: ChainLink[] = [];
  let current = head;
  for (const digest of digests) {
    current = appendLink(streamId, current, digest);
    out.push(current);
  }
  return out;
}

/** Recompute the chain over `records` (in seq order) and report the first break. */
export function verifyChain(
  streamId: string,
  records: readonly ChainRecord[],
  options: VerifyChainOptions = {},
): ChainVerdict {
  const digestOf = options.digestEntry ?? entryDigest;
  let previous: ChainLink | null = null;
  const fail = (index: number, seq: number | null, reason: ChainBreakReason, detail: string): ChainVerdict => ({
    ok: false,
    streamId,
    length: index,
    verifiedThrough: previous,
    firstBreak: { index, seq, reason, detail },
  });

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const link = record.link;
    const shape = malformed(link);
    if (shape) return fail(index, Number.isSafeInteger(link?.seq) ? link.seq : null, 'malformed', shape);
    if (link.streamId !== streamId) {
      return fail(index, link.seq, 'stream-mismatch', `link names stream '${link.streamId}'`);
    }
    if (link.seq !== index) {
      return fail(index, link.seq, 'seq-gap', `expected seq ${index}, found ${link.seq}`);
    }
    const expectedPrev = previous ? previous.entryHash : GENESIS_PREV_HASH;
    if (link.prevHash !== expectedPrev) {
      return fail(index, link.seq, 'prev-mismatch', `prevHash ${link.prevHash} does not match ${expectedPrev}`);
    }
    const recomputed = linkHash(link);
    if (link.entryHash !== recomputed) {
      return fail(index, link.seq, 'link-hash-mismatch', `entryHash ${link.entryHash} recomputes to ${recomputed}`);
    }
    if (record.entryMissing) {
      return fail(index, link.seq, 'entry-missing', 'the link exists but its entry is gone');
    }
    if ('entry' in record) {
      let digest: string;
      try {
        digest = digestOf(record.entry);
      } catch (error) {
        return fail(index, link.seq, 'entry-mismatch', `entry cannot be digested: ${(error as Error).message}`);
      }
      if (digest !== link.entryDigest) {
        return fail(index, link.seq, 'entry-mismatch', `entry digests to ${digest}, link records ${link.entryDigest}`);
      }
    } else if (options.requireEntries) {
      return fail(index, link.seq, 'entry-missing', 'entry was required but not supplied');
    }
    previous = link;
  }

  const expected = options.expectedHead;
  if (expected) {
    if (!previous || previous.seq !== expected.seq || previous.entryHash !== expected.entryHash) {
      const found = previous ? `seq ${previous.seq} ${previous.entryHash}` : 'an empty chain';
      return fail(
        records.length,
        previous ? previous.seq : null,
        'head-mismatch',
        `expected head seq ${expected.seq} ${expected.entryHash}, chain ends at ${found}`,
      );
    }
  }
  return { ok: true, streamId, length: records.length, head: previous };
}

function malformed(link: ChainLink | undefined): string | null {
  if (!link || typeof link !== 'object') return 'record has no link';
  if (typeof link.streamId !== 'string' || !link.streamId) return 'streamId must be a non-empty string';
  if (!Number.isSafeInteger(link.seq) || link.seq < 0) return 'seq must be a non-negative integer';
  for (const field of ['prevHash', 'entryDigest', 'entryHash'] as const) {
    if (typeof link[field] !== 'string' || !HEX64.test(link[field])) {
      return `${field} must be 64 lowercase hex characters`;
    }
  }
  return null;
}
