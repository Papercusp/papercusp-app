/**
 * jco transpile cache (rev3 plan G2).
 *
 * Plugin authors ship a `.wasm` component built against the WIT in
 * `@papercusp/plugin-wit`. The TS host can't load components directly
 * — it needs jco's transpiled ESM + core wasm output. Transpile is
 * expensive (~200ms per plugin) so we cache by sha256 of the input
 * `.wasm` bytes.
 *
 * Layout:
 *   <cacheRoot>/<sha256-of-wasm>/
 *     transpiled.js      ← ESM entry jco produced
 *     <name>.core.wasm   ← extracted core wasm
 *     interfaces/        ← typed bindings
 *
 * Cache hit: return immediately with the cached entrypoint path.
 * Cache miss: invoke the injected transpiler, write outputs, return.
 *
 * The transpiler itself (`@bytecodealliance/jco`) is injected so:
 *   - this module can be unit-tested without the 50MB jco install
 *   - production wiring lives in a single seam (one place to swap if
 *     jco gets renamed, replaced, or pinned to a specific version)
 *
 * Concurrency: two concurrent transpile() calls for the same wasm
 * race on the cache dir. Resolution: write to a temp dir, then
 * `rename` into place. Same-dir rename is atomic on Linux/macOS;
 * second writer's rename overwrites first writer's (functionally
 * fine since contents are byte-identical for the same input hash).
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Pluggable transpiler shape. Production callers pass a thin wrapper
 * around `@bytecodealliance/jco`'s `transpile()`. Tests pass a stub.
 *
 * Contract: given input wasm bytes + an OUTPUT directory, write
 * transpiled output files into that directory. Resolves with the
 * path (relative to outputDir) of the ESM entry file callers should
 * import — typically `transpiled.js` but the transpiler decides.
 */
export type Transpiler = (
  wasmBytes: Uint8Array,
  outputDir: string,
) => Promise<{ entryRelPath: string }>;

export interface TranspileOptions {
  /** Path to the input `.wasm` component. */
  wasmPath: string;
  /** Cache root. Each transpiled wasm gets a subdirectory under this. */
  cacheRoot: string;
  /** Function to invoke when cache misses. */
  transpiler: Transpiler;
}

export interface TranspileResult {
  /** Absolute path to the directory holding all transpiled output. */
  cacheDir: string;
  /** Absolute path to the ESM entry file callers should `import()`. */
  entryPath: string;
  /** Hex sha256 of the input wasm — same as cacheDir's basename. */
  hash: string;
  /** True iff the transpiler was actually invoked (false → cache hit). */
  wasInvoked: boolean;
}

/**
 * Idempotent transpile + cache. Multiple calls with the same input
 * wasm return the cached entry without re-invoking the transpiler.
 */
export async function transpileWasm(
  opts: TranspileOptions,
): Promise<TranspileResult> {
  const wasmBytes = await fs.readFile(opts.wasmPath);
  const hash = sha256Hex(wasmBytes);
  const cacheDir = join(opts.cacheRoot, hash);

  // Cache hit if the marker file exists (which we write LAST).
  const markerPath = join(cacheDir, '.transpile-complete');
  if (existsSync(markerPath)) {
    const recorded = await fs.readFile(markerPath, 'utf8').catch(() => '');
    const entryRelPath = recorded.trim();
    if (entryRelPath && existsSync(join(cacheDir, entryRelPath))) {
      return {
        cacheDir,
        entryPath: join(cacheDir, entryRelPath),
        hash,
        wasInvoked: false,
      };
    }
    // Marker exists but entry missing — corrupt cache. Tear it down
    // BEFORE re-transpiling so the rename below isn't fooled into
    // thinking another writer beat us. Without this, we'd leave the
    // corrupt dir in place and return a non-existent entryPath.
    await fs.rm(cacheDir, { recursive: true, force: true });
  }

  // Cache miss. Write to a temp dir alongside the cache, then rename.
  // Same-parent rename is atomic on Linux/macOS. The random suffix is
  // load-bearing: pid+Date.now() alone COLLIDES for two concurrent calls in
  // the same process within one millisecond — they then share a tmp dir and
  // the winner's rename yanks it out from under the loser mid-transpile
  // (caught on the 2-core CI runner, WI-123 round 6).
  const tmpDir = `${cacheDir}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  await fs.mkdir(tmpDir, { recursive: true });
  let entryRelPath: string;
  try {
    const out = await opts.transpiler(new Uint8Array(wasmBytes), tmpDir);
    entryRelPath = out.entryRelPath;
    if (!existsSync(join(tmpDir, entryRelPath))) {
      throw new Error(
        `transpiler returned entryRelPath=${entryRelPath} but file not found in ${tmpDir}`,
      );
    }
    // Marker tells future readers which file is the entry. Written
    // LAST so a half-written cache dir isn't mistaken for complete.
    await fs.writeFile(join(tmpDir, '.transpile-complete'), entryRelPath);
  } catch (err) {
    // Clean up partial output before propagating.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // Atomic rename into place. If the cache dir already exists (e.g.
  // a concurrent writer beat us here), remove ours and use theirs.
  if (existsSync(cacheDir)) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } else {
    await fs.rename(tmpDir, cacheDir).catch(async (err) => {
      // ENOTEMPTY → another writer raced us during the rename. Use
      // their result, drop ours.
      if (existsSync(cacheDir)) {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } else {
        throw err;
      }
    });
  }

  return {
    cacheDir,
    entryPath: join(cacheDir, entryRelPath),
    hash,
    wasInvoked: true,
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
