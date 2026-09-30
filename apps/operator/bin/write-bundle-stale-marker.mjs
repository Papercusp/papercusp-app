#!/usr/bin/env node
/**
 * write-bundle-stale-marker.mjs — record WHY the host bundle is stale.
 *
 * EI-20093985382484201. Called by bundle-host.sh ONLY on the fallback path:
 * the esbuild bundle failed, a last-known-good $OUTFILE exists, and the service
 * is about to start on it. Something must say so out loud, because a silently
 * stale service is worse than a down one — an agent can verify a fix against
 * code that is not what is on disk and conclude the fix works.
 *
 * Written as a node helper rather than inline shell on purpose: the esbuild
 * error text is arbitrary (quotes, newlines, backslashes) and hand-escaping it
 * into JSON from bash is exactly the class of quoting bug that caused the
 * outage this marker reports on.
 *
 * Consumed by packages/operator-core/lib/bundle-staleness.ts → /api/health.
 *
 * Usage: node write-bundle-stale-marker.mjs <marker> <entry> <outfile> <buildLog>
 *
 * NEVER throws in a way that matters: bundle-host.sh calls it with `|| true`,
 * because failing to WRITE the marker must not turn a survivable stale boot
 * back into the outage this whole change exists to prevent.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';

const [, , markerPath, entry, outfile, buildLog] = process.argv;

if (!markerPath || !outfile) {
  console.error('write-bundle-stale-marker: usage: <marker> <entry> <outfile> <buildLog>');
  process.exit(2);
}

/** Last N lines, so a pathological log can never bloat the health payload. */
function tail(text, n) {
  const lines = text.split('\n');
  return lines.length <= n ? text : lines.slice(-n).join('\n');
}

/**
 * Pull `path:line:col` out of esbuild's error block. This is the single most
 * useful field for whoever reads the marker: it names the file to go fix,
 * without them having to reconstruct it from the journal.
 *
 * esbuild renders it on its own indented line beneath the ✘ [ERROR] header,
 * with a TRAILING COLON — verified against esbuild 0.25.0 output, not from the
 * incident report, whose quoted journal line had the trailing colon truncated:
 *
 *     ✘ [ERROR] Expected "}" but found "s"
 *
 *         ../../packages/operator-core/lib/.../new-app.ts:333:688:
 *           333 │ ... `supplyChain` is this install's resolved …
 *
 * The `:?` is therefore load-bearing: anchoring `\s*$` directly after the column
 * matches nothing and yields a marker with an empty `failingFiles`, which reads
 * as "no file was named" rather than "the parser missed it".
 */
function failingFiles(log) {
  const out = [];
  for (const line of log.split('\n')) {
    const m = /^\s*(\S+\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|json|css):\d+:\d+):?\s*$/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out.slice(0, 20);
}

let log = '';
try {
  if (buildLog) log = readFileSync(buildLog, 'utf8');
} catch {
  log = '(build log unavailable)';
}

let bundleMtime = null;
let bundleAgeSec = null;
try {
  const st = statSync(outfile);
  bundleMtime = st.mtime.toISOString();
  bundleAgeSec = Math.round((Date.now() - st.mtimeMs) / 1000);
} catch {
  /* the caller already proved it exists; a race here is not worth failing over */
}

const marker = {
  schema: 'bundle-stale-v1',
  failedAt: new Date().toISOString(),
  entry: entry ?? null,
  outfile,
  /** When the code actually being served was built — the age of the lie. */
  servingBundleMtime: bundleMtime,
  servingBundleAgeSecAtFailure: bundleAgeSec,
  /** The files to go fix. Empty means the failure was not a parse error. */
  failingFiles: failingFiles(log),
  error: tail(log.trimEnd(), 40),
};

try {
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
} catch (err) {
  console.error(`write-bundle-stale-marker: could not write ${markerPath}: ${err?.message ?? err}`);
  process.exit(1);
}
