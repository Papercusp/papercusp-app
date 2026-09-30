/**
 * bundle-staleness — is this process serving code that is NOT what is on disk?
 *
 * EI-20093985382484201. `papercup-{staging,bg-host,dev}-api` bundle the LIVE
 * shared working tree in `ExecStartPre` (apps/operator/bin/bundle-host.sh) and
 * then `exec node dist-host/hono-host.mjs`. Many agents edit that tree
 * continuously, so it is momentarily INVALID between two keystrokes of any
 * multi-part edit. That used to be an OUTAGE: the bundle failed, ExecStartPre
 * exited non-zero, systemd refused to start, and Restart=always re-bundled the
 * same broken tree every 5s. Measured 2026-08-10, twice in one day.
 *
 * bundle-host.sh now falls back to the last-known-good bundle instead of
 * refusing to start — which trades an outage for a subtler hazard: an agent
 * verifying a fix against a process running PRE-FIX code, and concluding the
 * fix works. That trade is only defensible if the staleness is IMPOSSIBLE TO
 * MISS, which is what this module is for. A visibly-stale service beats a down
 * one; an invisibly-stale one is worse than both.
 *
 * ── Why a module-level cache is sound here (not the usual staleness bug) ──
 * The marker is written by ExecStartPre, which runs to completion BEFORE this
 * process is exec'd. It therefore cannot change during the process's lifetime:
 * clearing it requires a rebuild, and a rebuild requires a restart, which is a
 * different process. Reading it once preserves /api/health's documented
 * zero-dependency contract (it must answer even half-init and must never
 * throw) — the same reasoning build-info.ts uses for its sha cache.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type BundleStaleness = {
  schema: string;
  /** When the failed rebuild happened. */
  failedAt: string;
  /** Entry that failed to bundle, e.g. `bin/hono-host.ts`. */
  entry: string | null;
  /** The bundle being served instead. */
  outfile: string;
  /** When the code actually running was built — i.e. how old the lie is. */
  servingBundleMtime: string | null;
  servingBundleAgeSecAtFailure: number | null;
  /** `path:line:col` entries parsed from the esbuild error — the files to fix. */
  failingFiles: string[];
  /** Tail of the build output. */
  error: string;
};

/**
 * Where bundle-host.sh writes the marker: beside the bundled entry.
 *
 * Inside the esbuild bundle every module shares the OUTPUT file's
 * `import.meta.url`, so this resolves to `dist-host/.bundle-stale.json` — the
 * same derivation `@papercusp/locks` and the harness blueprint resolver already
 * rely on (see bundle-host.sh's asset-publish steps).
 *
 * Running UNBUNDLED (tsx dev, vitest) it resolves next to this source file,
 * where no marker exists — and that answer is correct rather than merely
 * convenient: a process that did not boot from a bundle has no bundle that
 * could be stale.
 */
function markerPath(): string {
  const override = process.env.PAPERCUSP_BUNDLE_STALE_MARKER;
  if (override) return override;
  return fileURLToPath(new URL('./.bundle-stale.json', import.meta.url));
}

let cached: BundleStaleness | null | undefined;

/**
 * A marker we could not fully understand. Reached whenever the file EXISTS but
 * its contents are unusable — corrupt JSON, or written by a writer whose shape
 * we do not recognise.
 *
 * ⚠ The ONLY signal that matters for the verdict is that the file EXISTS:
 * bundle-host.sh writes it exclusively on the fallback path and deletes it on
 * every success, so its mere presence proves a build failed and this process
 * booted on an older bundle. The contents are detail. Degrading an
 * unparseable marker to `null` would report a genuinely-stale process as
 * healthy — the single failure mode this module exists to prevent — so we
 * return staleness with a `reason` instead.
 */
function unreadable(reason: string): BundleStaleness {
  return {
    schema: 'bundle-stale-v1',
    failedAt: 'unknown',
    entry: null,
    outfile: '(unreadable marker)',
    servingBundleMtime: null,
    servingBundleAgeSecAtFailure: null,
    failingFiles: [],
    error: `${reason} — the marker at ${markerPath()} exists, so this process is serving STALE code; its details could not be read`,
  };
}

function read(): BundleStaleness | null {
  let raw: string;
  try {
    raw = readFileSync(markerPath(), 'utf8');
  } catch {
    // ENOENT is the overwhelmingly common case and is the ONLY thing that means
    // HEALTHY: the last build succeeded, so bundle-host.sh removed the marker.
    return null;
  }

  let parsed: Partial<BundleStaleness>;
  try {
    parsed = JSON.parse(raw) as Partial<BundleStaleness>;
  } catch {
    return unreadable('bundle-stale marker could not be parsed as JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    return unreadable('bundle-stale marker was not a JSON object');
  }
  if (typeof parsed.outfile !== 'string') {
    return unreadable('bundle-stale marker is missing the `outfile` field');
  }

  return {
    schema: typeof parsed.schema === 'string' ? parsed.schema : 'bundle-stale-v1',
    failedAt: typeof parsed.failedAt === 'string' ? parsed.failedAt : 'unknown',
    entry: typeof parsed.entry === 'string' ? parsed.entry : null,
    outfile: parsed.outfile,
    servingBundleMtime:
      typeof parsed.servingBundleMtime === 'string' ? parsed.servingBundleMtime : null,
    servingBundleAgeSecAtFailure:
      typeof parsed.servingBundleAgeSecAtFailure === 'number'
        ? parsed.servingBundleAgeSecAtFailure
        : null,
    failingFiles: Array.isArray(parsed.failingFiles)
      ? parsed.failingFiles.filter((f): f is string => typeof f === 'string')
      : [],
    error: typeof parsed.error === 'string' ? parsed.error : '',
  };
}

/**
 * The staleness of the code this process is running, or `null` when the running
 * code matches the tree it was built from (the healthy case).
 */
export function getBundleStaleness(): BundleStaleness | null {
  if (cached === undefined) cached = read();
  return cached;
}

/** Test seam only — the cache is deliberately permanent in a real process. */
export function __resetBundleStalenessCacheForTests(): void {
  cached = undefined;
}
