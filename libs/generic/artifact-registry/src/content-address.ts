/**
 * Content addressing — the integrity + dedupe + auth-lite primitive under a
 * distributable artifact store. An artifact's storage key IS its content hash,
 * so:
 *   - the same bytes always map to the same key (free dedupe);
 *   - a tampered blob can't masquerade under a key it doesn't hash to (the
 *     writer re-verifies on PUT, the reader on GET);
 *   - keys are stable across machines (cross-machine fork just needs the hash).
 *
 * PURE + transport-free + backend-free. Web-Crypto (`crypto.subtle`) only — runs
 * in Node 18+, Cloudflare Workers, Deno, and browsers identically.
 */

/** Lowercase-hex SHA-256: 64 hex chars. */
export const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

/** Type-guard: a well-formed lowercase-hex SHA-256 string. */
export function isHexSha256(value: unknown): value is string {
  return typeof value === 'string' && HEX_SHA256_RE.test(value);
}

/** SHA-256 of `buf`, lowercase hex. Accepts an ArrayBuffer or a typed-array view. */
export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  // Normalise to a plain ArrayBuffer for Web-Crypto. The hot path (a host PUT
  // handing in `request.arrayBuffer()`) passes straight through with no copy; a
  // Uint8Array view is sliced to exactly its bytes. The `as ArrayBuffer` bridges
  // the TS 5.7+ ArrayBufferLike↔ArrayBuffer typed-array variance. Bare `crypto`
  // is the ambient Web-Crypto global across Node 18+, Workers, Deno, browsers.
  const data: ArrayBuffer =
    buf instanceof Uint8Array
      ? (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
      : buf;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** One blob of a tree: its repo-relative path and its git blob sha (40-hex
 *  SHA-1, or 64-hex on a SHA-256 repository). */
export interface TreeDigestEntry {
  readonly path: string;
  readonly sha: string;
}

/** A git blob object id: 40 lowercase hex (SHA-1) or 64 (SHA-256 repositories). */
export const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The record separator is U+0000 (built at runtime rather than written as an
// escape so the source file itself carries no control byte — lint:no-control-bytes
// is a release-gate leg). A path may contain any character but NUL.
const NUL = String.fromCharCode(0);

/**
 * Canonical digest of a set of (path, blob sha) pairs — the content identity of
 * a directory INDEPENDENT of how it was obtained (GitHub's tree API, a local
 * `git ls-tree -r`, a checkout walked with `git hash-object`). Two parties that
 * see the same blobs at the same paths compute the same hex, so a publisher-side
 * pin and an installer-side recomputation compare as plain strings.
 *
 * Canonical form (fixed — changing it re-keys every stored digest):
 *   - entries sorted by `path`, compared as JS strings (UTF-16 code-unit order —
 *     deterministic on every runtime; NOT locale collation);
 *   - one record per entry: `<path>` U+0000 `<sha>` U+000A — the NUL separator
 *     means a path may contain any character but NUL, and the LF terminator
 *     means an entry set is never a prefix of a larger one;
 *   - SHA-256 over the UTF-8 bytes of the concatenated records, lowercase hex.
 *
 * Refuses (throws) a duplicate path or a malformed sha rather than hashing a
 * set that no real tree can produce: an installer that recomputes from a real
 * checkout could never match such a digest, so storing one would be a pin that
 * fails every verification for a reason nobody can see.
 */
export async function canonicalTreeDigest(entries: readonly TreeDigestEntry[]): Promise<string> {
  const seen = new Set<string>();
  for (const e of entries) {
    if (typeof e.path !== 'string' || e.path.length === 0 || e.path.includes(NUL)) {
      throw new Error(`canonicalTreeDigest: invalid path ${JSON.stringify(e.path)}`);
    }
    if (!GIT_OBJECT_ID_RE.test(e.sha)) {
      throw new Error(`canonicalTreeDigest: invalid blob sha for ${e.path}`);
    }
    if (seen.has(e.path)) throw new Error(`canonicalTreeDigest: duplicate path ${e.path}`);
    seen.add(e.path);
  }
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = sorted.map((e) => `${e.path}${NUL}${e.sha}\n`).join('');
  return sha256Hex(new TextEncoder().encode(canonical));
}

/**
 * A content-addressing scheme: a `<prefix>/<hash><ext>` key layout. Lets a host
 * pick its own namespace + extension (`snapshots/<sha>.tar.gz`,
 * `blobs/<sha>.bin`, …) while the registry logic stays scheme-agnostic.
 */
export interface ContentAddressing {
  readonly prefix: string;
  readonly ext: string;
  /** The storage key for `hash` under this scheme. */
  key(hash: string): string;
  /** Does `key` equal this scheme's key for `hash`? (content-addressed guard) */
  matches(key: string, hash: string): boolean;
  /** Extract the hash from a key, or null if it doesn't fit this scheme. */
  parse(key: string): string | null;
}

/** Build a `<prefix>/<hash><ext>` content-addressing scheme. */
export function contentAddressing(opts: { prefix: string; ext?: string }): ContentAddressing {
  const prefix = opts.prefix.replace(/\/+$/, '');
  const ext = opts.ext ?? '';
  return {
    prefix,
    ext,
    key: (hash) => `${prefix}/${hash}${ext}`,
    matches: (key, hash) => key === `${prefix}/${hash}${ext}`,
    parse: (key) => {
      const head = `${prefix}/`;
      if (!key.startsWith(head) || !key.endsWith(ext)) return null;
      const mid = key.slice(head.length, ext.length ? key.length - ext.length : key.length);
      return HEX_SHA256_RE.test(mid) ? mid : null;
    },
  };
}
