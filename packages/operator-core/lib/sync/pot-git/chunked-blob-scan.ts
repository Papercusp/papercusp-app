/**
 * chunked-blob-scan.ts — bounded, batched reading of new blobs for the G-10
 * secrets guards.
 *
 * Extracted from publish-guard.ts (WI-6254) so that its SIBLING guard,
 * foreign-mirror-quarantine.ts (WI-6258), gets the same bound from the same
 * code rather than a second copy. The `cat-file --batch` frame parser below is
 * byte-exact and easy to get subtly wrong; two independently-maintained copies
 * of it is precisely the drift this module exists to prevent.
 *
 * The two callers differ in what they are protecting:
 *   - publish-guard judges the device's OWN namespace (trusted-ish input, but
 *     it runs inside ref-announce, whose OOM took the whole sidecar down).
 *   - foreign-mirror-quarantine judges UNTRUSTED peer input, already bounded by
 *     hard object/blob/total caps — so the risk there is a burst inside those
 *     caps rather than an unbounded one.
 * Both want the same property: peak resident content is one chunk, not the
 * whole admissible range.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import { createTimeSlice } from '../../event-loop-lag-monitor';
import { defaultRunGitStdin } from './storage';
import { type SecretFinding, scanForSecrets } from './secrets-guard';

/**
 * Default ceiling on blob CONTENT held in memory at once during a scan.
 *
 * This is a RESOURCE bound on the guard's own work, NOT a volume policy: it
 * changes how much is read at a time, never what is admitted or refused. That
 * distinction matters because it is why the bound holds even where volume
 * gates are downgraded to warnings, and why it is never waivable.
 */
export const DEFAULT_SCAN_CHUNK_BYTES = 32 * 1024 * 1024;

/** A new blob in the judged range, with the size `--batch-check` already told
 *  us — which is what lets the scan be partitioned without a second stat pass. */
export interface BlobEntry {
  oid: string;
  path: string;
  bytes: number;
}

/**
 * Partition blobs into groups whose total size stays within `chunkBytes`.
 *
 * A blob larger than the budget forms its own group rather than being dropped:
 * coverage is never traded for the bound. That is safe because both callers
 * enforce a hard per-blob cap (`blob-over-cap`) before reaching here, so a
 * single blob is already bounded.
 */
export function partitionBlobsForScan(blobs: readonly BlobEntry[], chunkBytes: number): BlobEntry[][] {
  const budget = Math.max(1, chunkBytes);
  const groups: BlobEntry[][] = [];
  let current: BlobEntry[] = [];
  let currentBytes = 0;
  for (const b of blobs) {
    const size = Number.isFinite(b.bytes) && b.bytes > 0 ? b.bytes : 0;
    if (current.length > 0 && currentBytes + size > budget) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(b);
    currentBytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Read one partition's blobs with a SINGLE `git cat-file --batch`, returning
 * the decodable TEXT ones. Binary blobs are skipped (the size caps already own
 * that class), matching the per-blob behaviour both callers had before.
 *
 * `--batch` frames each object as `<oid> SP <type> SP <size> LF <contents> LF`,
 * or `<oid> SP missing LF` for one git cannot read. We parse against the
 * declared size rather than scanning for delimiters, so content containing
 * newlines (i.e. every source file) cannot desynchronise the stream.
 */
export async function readTextBlobs(
  group: readonly BlobEntry[],
  repoPath: string,
): Promise<{
  files: { oid: string; path: string; content: string }[];
  /** Blobs git returned but that are BINARY (contain NUL). Reported so the
   *  verdict cache can remember them: binary-ness is a property of the oid. A
   *  `missing` object is in neither list, so it is re-attempted next time. */
  binaryOids: string[];
  error: string | null;
}> {
  const pathByOid = new Map(group.map((b) => [b.oid, b.path] as const));
  // `defaultRunGitStdin` returns stdout as BYTES, which is what the frame walk
  // below needs: `cat-file --batch` interleaves headers with raw object content
  // on one stream, so decoding it as a string would corrupt binary blobs and
  // desynchronise the parser from the byte-exact sizes git reports.
  const out = await defaultRunGitStdin(
    ['cat-file', '--batch', '--buffer'],
    repoPath,
    group.map((b) => b.oid).join('\n') + '\n',
  );
  // Fail-CLOSED: an unreadable batch means part of the range went unjudged.
  // (A single `missing` object inside an otherwise good batch is tolerated
  // below, exactly as the old per-blob loops tolerated a `cat-file` failure.)
  if (out.code !== 0) return { files: [], binaryOids: [], error: `cat-file --batch failed: ${out.stderr.trim()}` };

  const files: { oid: string; path: string; content: string }[] = [];
  const binaryOids: string[] = [];
  const buf = out.stdout;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    const [oid, type, sizeS] = header.trim().split(/\s+/);
    if (!oid || !type || type === 'missing') continue;
    const size = Number(sizeS ?? 0);
    if (!Number.isFinite(size) || size < 0) break; // unparseable frame — stop rather than misread
    const end = Math.min(pos + size, buf.length);
    const content = buf.subarray(pos, end);
    pos = end + 1; // skip the LF git appends after contents
    const p = pathByOid.get(oid) ?? '';
    if (!p) continue;
    if (content.includes(0)) {
      binaryOids.push(oid); // binary
      continue;
    }
    files.push({ oid, path: p, content: content.toString('utf8') });
  }
  return { files, binaryOids, error: null };
}

// ── Scan-verdict memo (WI-10002541 / WI-10002478) ────────────────────────
//
// The findings for a blob are a PURE function of (path, content), and a git
// oid IS its content. Nothing here remembered that, so the same immutable blob
// was re-read (`cat-file --batch` + a UTF-8 decode) and re-scanned:
//   - twice per new commit: own-head-publish (first-line guard) judges the
//     range, then ref-announce (second-line guard) re-judges the same blobs;
//   - log2(n)+2 more times in a tick whenever resolveIncrementalPublishSha's
//     fast path refuses (the binary search re-judges nested prefixes);
//   - on EVERY git-sync tick while a hard refusal pins a baseline (the
//     namespace ref / sigrefs never advance, so the whole growing range is
//     judged again from scratch).
// On the rig VM that re-scanning held 19-28% of the operator main thread
// (scanTextForSecrets self time plus Buffer.toString), in competition with the
// P-203 read-merge fold.
//
// The key is oid AND path, because `scanForSecrets` applies the static
// FIXTURE_FILES exemption by path: one oid seen at a fixture path must never
// answer for the same bytes committed elsewhere. Runtime path exemptions
// (secrets_guard_path_exemptions) are applied by the CALLERS after this
// returns, so a memoized verdict never hides a newly added or retracted one.
// Binary blobs are memoized as clean (binary-ness is an oid property); a
// `missing` object is not memoized, so it is re-attempted next time.
//
// Bounded LRU: a range larger than the bound degrades to today's cost (it
// re-scans), never to wrong answers.

/** Max remembered (oid, path) verdicts. ~100-200 bytes each, so ~10-20MB at
 *  the cap, and 2x the 50k new-object flood cap of a single publish. */
export const BLOB_SCAN_VERDICT_CACHE_MAX = 100_000;

const NO_FINDINGS: readonly SecretFinding[] = Object.freeze([]);

interface BlobScanCacheStats {
  /** Blobs whose verdict came from the memo: no read, no scan. */
  hits: number;
  /** Blobs that had to be read (and, if text, scanned). */
  misses: number;
  /** Text bytes actually handed to the scanner. */
  scannedBytes: number;
  /** Verdicts dropped to stay within the bound. */
  evictions: number;
}

const blobScanState = pinModuleState('@papercusp/operator-core.pot-git.blob-scan-verdicts', () => ({
  verdicts: new Map<string, readonly SecretFinding[]>(),
  stats: { hits: 0, misses: 0, scannedBytes: 0, evictions: 0 } as BlobScanCacheStats,
  max: BLOB_SCAN_VERDICT_CACHE_MAX,
}));

/** Scoped to the repo too. The live callers (own-head-publish, ref-announce)
 *  judge the SAME pot-git store, so this costs none of the reuse that matters.
 *  It also keeps the memo from answering for a repo it never read, which
 *  preserves the fail-closed posture: an unreadable store still reports an
 *  unjudged chunk rather than another store's verdict. */
function verdictKey(repoPath: string, b: { oid: string; path: string }): string {
  return `${repoPath}\u0000${b.oid}\u0000${b.path}`;
}

function rememberVerdict(key: string, findings: readonly SecretFinding[]): void {
  const { verdicts, stats } = blobScanState;
  verdicts.delete(key);
  verdicts.set(key, findings.length === 0 ? NO_FINDINGS : findings);
  while (verdicts.size > blobScanState.max) {
    const oldest = verdicts.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    verdicts.delete(oldest);
    stats.evictions += 1;
  }
}

function recallVerdict(key: string): readonly SecretFinding[] | undefined {
  const { verdicts } = blobScanState;
  const hit = verdicts.get(key);
  if (hit === undefined) return undefined;
  verdicts.delete(key); // refresh recency
  verdicts.set(key, hit);
  return hit;
}

/** Memo counters since process start (or the last reset), for health and
 *  for the call-count test. A copy, so callers cannot mutate the live one. */
export function getBlobScanCacheStats(): BlobScanCacheStats & { size: number } {
  return { ...blobScanState.stats, size: blobScanState.verdicts.size };
}

/** Test-only: forget every memoized verdict, zero the counters, and optionally
 *  shrink the bound so eviction is testable without 100k blobs. */
export function resetBlobScanCacheForTests(opts: { max?: number } = {}): void {
  blobScanState.verdicts.clear();
  blobScanState.stats = { hits: 0, misses: 0, scannedBytes: 0, evictions: 0 };
  blobScanState.max = opts.max ?? BLOB_SCAN_VERDICT_CACHE_MAX;
}

/**
 * Scan every named TEXT blob for secrets, reading in bounded chunks.
 *
 * Coverage is identical to a single whole-range read: every text blob is still
 * scanned, and `scanForSecrets` is a pure per-file map-concat, so scanning in
 * ordered chunks yields exactly the findings — and the order — one call would.
 *
 * Fail-CLOSED: a chunk that cannot be read is returned as `error`, because it
 * means part of the range went unjudged. Callers must refuse on it rather than
 * treat an empty finding list as "clean".
 */
export async function scanTextBlobsChunked(
  blobs: readonly BlobEntry[],
  repoPath: string,
  chunkBytes: number,
): Promise<{ findings: SecretFinding[]; error: string | null }> {
  const named = blobs.filter((b) => b.path);
  // This call's verdicts, held locally so a range larger than the memo bound
  // cannot evict an entry between computing it and assembling the result.
  const verdictByKey = new Map<string, readonly SecretFinding[]>();
  const pending: BlobEntry[] = [];
  const pendingKeys = new Set<string>();
  for (const b of named) {
    const key = verdictKey(repoPath, b);
    if (verdictByKey.has(key) || pendingKeys.has(key)) continue;
    const hit = recallVerdict(key);
    if (hit !== undefined) {
      verdictByKey.set(key, hit);
      blobScanState.stats.hits += 1;
    } else {
      pending.push(b);
      pendingKeys.add(key);
    }
  }

  // A chunk is up to `chunkBytes` (32 MB) of text. Scanning it in one turn held
  // bg-host's main thread for seconds (WI-10005476), so yield between files once
  // a slice is spent. Verdicts are per file, so this changes no result or order.
  const slice = createTimeSlice();
  for (const group of partitionBlobsForScan(pending, chunkBytes)) {
    const { files, binaryOids, error } = await readTextBlobs(group, repoPath);
    if (error) return { findings: [], error };
    blobScanState.stats.misses += group.length;
    const binary = new Set(binaryOids);
    for (const b of group) {
      if (binary.has(b.oid)) {
        const key = verdictKey(repoPath, b);
        verdictByKey.set(key, NO_FINDINGS);
        rememberVerdict(key, NO_FINDINGS);
      }
    }
    for (const f of files) {
      await slice.maybeYield();
      blobScanState.stats.scannedBytes += f.content.length;
      // Per file, so each verdict is attributable to exactly one (oid, path).
      // Still `scanForSecrets` (never the raw per-line scanner): it applies the
      // FIXTURE_FILES exemption, which secrets-guard.test.ts pins for every
      // module in this scan's delegation closure.
      const found = scanForSecrets([{ path: f.path, content: f.content }]);
      const key = verdictKey(repoPath, f);
      verdictByKey.set(key, found);
      rememberVerdict(key, found);
    }
  }

  // Assemble in the caller's blob order, which is the order the un-memoized
  // chunked scan produced (partitioning preserves order; so does `pending`).
  const findings: SecretFinding[] = [];
  for (const b of named) {
    const v = verdictByKey.get(verdictKey(repoPath, b));
    if (!v) continue; // a `missing` object: tolerated, exactly as before
    for (const f of v) findings.push({ ...f });
  }
  return { findings, error: null };
}
