/**
 * src-hash.ts — content-hash a module's OWN source file, read from disk at CALL time
 * (WI-5397: the running-generation identity needs a scout module's content AT ITS OWN
 * load instant).
 *
 * Node's module cache means a source-file edit AFTER a module has loaded does not
 * change what that process is actually executing — so a hash computed later (or once,
 * centrally, well after the fact) risks naming code that was never actually loaded by
 * THIS process. Calling {@link computeOwnSourceHash} from a target module's own top
 * level (`computeOwnSourceHash(import.meta.url)`) ties the read to as close to that
 * module's own parse/evaluate instant as a runtime fs read can get.
 *
 * Pure-ish IO edge: never throws, degrades to null (missing file, a bundled build with
 * no on-disk source next to it, a non-file URL, ...).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Hash a file's current bytes (sha256, truncated to 16 hex chars — an identity tag,
 *  not a security digest). Never throws. */
export function computeOwnSourceHash(moduleUrl: string): string | null {
  try {
    const bytes = readFileSync(fileURLToPath(moduleUrl));
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** Hash an explicit list of files' concatenated bytes, in order — used to combine
 *  several modules into ONE identity (order matters: callers must pass a STABLE
 *  order so the same code always produces the same combined hash). Never throws;
 *  any unreadable file makes the whole combination null (a partial identity is
 *  worse than an honest "unknown" — never silently hash a subset). */
export function computeCombinedSourceHash(paths: readonly string[]): string | null {
  try {
    const hash = createHash('sha256');
    for (const p of paths) {
      hash.update(readFileSync(p));
      hash.update('\0'); // path separator so ["ab","c"] != ["a","bc"]
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
