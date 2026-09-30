#!/usr/bin/env node
/**
 * check-no-wire-compression.mjs — Papercusp ships as a Tauri DESKTOP app, so
 * nothing it serves crosses a network. This guard keeps response compression
 * out of the transport layer, permanently.
 *
 * WHY (owner directive 2026-07-26, WI-5988):
 *   The operator host binds 127.0.0.1 (resolveBindHost) and every consumer —
 *   the desktop webview, the Vite dev browser, local agents — is on the same
 *   machine. Over loopback there is no bandwidth to buy, so gzip is pure CPU
 *   on BOTH ends for bytes that never leave the box. It was not free: gzipSync
 *   on large sync payloads blocked the main event loop ~50-100 ms per call,
 *   which is a large part of why cpu-task-worker.ts (a whole worker_threads
 *   subsystem) had to be built. We were paying a thread pool to hide the cost
 *   of work that did not need doing.
 *
 *   Two pieces of the codebase had already reached this conclusion
 *   independently before the sweep: the Tauri custom protocol strips
 *   `accept-encoding` outright ("Loopback has ..." — src-tauri/src/custom_protocol.rs)
 *   and pty-ws.ts sets `perMessageDeflate: false`.
 *
 * WHAT IS *NOT* BANNED — this guard is deliberately narrow:
 *   - DECOMPRESSION anywhere (gunzip/inflate/unzstd). Reading a gzipped log or
 *     a zstd archive blob is normal and stays.
 *   - AT-REST and DISTRIBUTION compression, all of which live outside the
 *     scanned roots and are correct: backup pg-dump gzip (packages/backup),
 *     zstd session archives + llm-test transcripts, runtime-pack tarballs,
 *     installer payloads, dev-source-extract.
 *   - Compression at a real EDGE PROXY for a genuine network hop — see
 *     infra/defguard/Caddyfile `encode gzip`. That is where content-encoding
 *     belongs if this is ever fronted by one.
 *
 *   node scripts/check-no-wire-compression.mjs             # scan, exit 1 on offenders
 *   node scripts/check-no-wire-compression.mjs --self-test # verify the matcher
 */
import { firstLiveMatch, stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The transport layer: code whose job is to put bytes on a socket for a
 * client. Compression producers here are the thing being banned.
 */
const SCAN_ROOTS = [
  'apps/operator/bin',
  'packages/operator-core/lib/endpoint-route',
  'libs/generic/sync/src',
];

/** Individual transport files outside the roots above. */
const SCAN_FILES = [
  'packages/operator-core/lib/cpu-task-worker.ts',
  'packages/operator-core/lib/cpu-task-worker.script.mjs',
  'packages/operator-core/lib/sync-sse.ts',
  'packages/operator-core/lib/pty-ws.ts',
];

const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js']);

/**
 * Compression PRODUCERS. Each rule is deliberately anchored so a decompressor
 * (gunzipSync, zstdDecompress, createInflate) never matches.
 */
const RULES = [
  {
    id: 'hono-compress',
    // ANCHORED ON THE IMPORT, NOT THE CALL — `compress()` is too generic a name to match on its
    // own (the self-test pins that bare-call case as a deliberate non-match), and the middleware
    // cannot be used without first being imported. That makes the import the chokepoint, so this
    // rule must cover EVERY way the specifier can be reached: static `from`, `require()`, and
    // dynamic `import()`. The dynamic form was blind until 2026-08-13 (WI-5988) — an
    // import-anchored rule that misses an import shape is a hole the whole guard drains through,
    // because that one line is all a reintroduction needs to go green.
    re: /\bfrom\s+['"]hono\/compress['"]|(?:require|import)\(\s*['"]hono\/compress['"]\s*\)/,
    hint: "hono's compress() middleware gzips every response — remove it.",
  },
  {
    id: 'zlib-compressor',
    // gzip / deflate / brotliCompress / zstdCompress as an identifier, but not
    // their un- counterparts (gunzip, inflate, brotliDecompress, zstdDecompress).
    re: /\b(?:gzipSync|gzip|createGzip|deflateSync|deflate|createDeflate|brotliCompressSync|brotliCompress|zstdCompressSync|zstdCompress)\s*(?:\(|,|\})/,
    hint: 'zlib compression on a response body — the client is on loopback; send it raw.',
  },
  {
    id: 'compression-stream',
    re: /\bnew\s+CompressionStream\b/,
    hint: 'CompressionStream on a response body — not needed over loopback.',
  },
  {
    id: 'content-encoding-header',
    re: /['"]content-encoding['"]\s*:\s*['"](?:gzip|deflate|br|zstd)['"]/i,
    hint: 'setting a compressed content-encoding on a response.',
  },
  {
    id: 'permessage-deflate',
    re: /perMessageDeflate\s*:\s*(?:true|\{)/,
    hint: 'WebSocket permessage-deflate adds latency for no loopback benefit (see pty-ws.ts).',
  },
];

/**
 * MATCH ON RAW, VALIDATE THE ANCHOR AGAINST THE MASK — because THE RULES ABOVE DISAGREE WITH
 * EACH OTHER about where their evidence lives, so no single mask can serve them all:
 *   - `zlib-compressor` / `compression-stream` / `permessage-deflate` are pure CODE, and want
 *     string literals masked away.
 *   - `content-encoding-header` matches `'content-encoding': 'gzip'`, which lives ENTIRELY
 *     inside string literals — masking them deletes the detector outright (a silent pass).
 *   - `hono-compress` SPANS both: the `from` keyword is code, the specifier is a string.
 * Asking instead whether each match's ANCHOR is live program text satisfies all three at once.
 * A rule anchored on its own opening quote still fires on real code (delimiters are kept) but
 * not on the same text nested inside a template literal, where that quote is itself blanked.
 *
 * This replaces a line-start `//`-prefix heuristic that recognised only a comment OPENING a
 * line: a trailing comment, a block-comment body, and any template literal quoting a banned
 * call all walked straight through it (WI-37717).
 *
 * @param {string} text
 * @param {string} [fileName]  passed through to pick a ScriptKind; optional so existing
 *        single-argument callers (this guard's own self-test) keep working.
 */
export function scanSource(text, fileName) {
  const hits = [];
  const lines = text.split('\n');
  // Masked lazily: blanking is MONOTONIC (it can only remove a match, never create one), so a
  // line with no RAW match needs no mask, and the TS parse is skipped for every file that names
  // none of the banned producers — which is nearly all of them.
  let masked = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      masked ??= stripCommentsAndStrings(text, fileName).split('\n');
      if (firstLiveMatch(line, masked[i], rule.re)) {
        hits.push({ line: i + 1, id: rule.id, hint: rule.hint, text: line.trim() });
      }
    }
  }
  return hits;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '_retired' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (EXTS.has(full.slice(full.lastIndexOf('.')))) yield full;
  }
}

function targets() {
  const out = [];
  for (const r of SCAN_ROOTS) out.push(...walk(join(ROOT, r)));
  for (const f of SCAN_FILES) {
    const full = join(ROOT, f);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      /* file moved/renamed — not this guard's problem */
    }
  }
  // Tests assert the ABSENCE of compression, so they legitimately name it.
  return out.filter((f) => !/\.test\.(ts|tsx|mjs|js)$/.test(f));
}

function selfTest() {
  const cases = [
    ["import { compress } from 'hono/compress';", true],
    ["import compress from 'hono/compress';", true],
    ["const { compress } = require('hono/compress');", true],
    // DYNAMIC import — the shape that evaded this rule until WI-5988 (2026-08-13). Since the rule
    // is anchored on the import rather than the call, every import shape has to be covered or the
    // chokepoint leaks; keep all three above green together.
    ["const { compress } = await import('hono/compress');", true],
    ['const m = await import("hono/compress");', true],
    ['host.use("*", compress());', false], // bare call is not distinctive enough; the import is
    ['host.use("*", compress({ threshold: 1024 }));', false], // ditto — the import is the anchor
    ['const buf = gzipSync(json);', true],
    ['const out = gunzipSync(buf);', false],
    ['const out = await zstdDecompress(blob);', false],
    ["headers: { 'content-encoding': 'gzip' }", true],
    ['perMessageDeflate: false,', false],
    ['perMessageDeflate: true,', true],
    ["// do not re-add gzip here — see host-handler.ts", false],
    [' * gzipSync used to block the loop for 50-100ms', false],
  ];
  let bad = 0;
  for (const [src, shouldHit] of cases) {
    const got = scanSource(src).length > 0;
    if (got !== shouldHit) {
      console.error(`  self-test FAIL: ${JSON.stringify(src)} → ${got}, expected ${shouldHit}`);
      bad++;
    }
  }
  if (bad) {
    console.error(`✗ ${bad} self-test case(s) failed`);
    process.exit(1);
  }
  console.log(`✓ matcher self-test passed (${cases.length} cases)`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const offenders = [];
  for (const file of targets()) {
    const hits = scanSource(readFileSync(file, 'utf8'), file);
    for (const h of hits) offenders.push(`${relative(ROOT, file)}:${h.line}  [${h.id}] ${h.hint}\n      ${h.text}`);
  }
  if (offenders.length === 0) {
    console.log('✓ no response compression in the transport layer — desktop app, everything is loopback.');
    return;
  }
  console.error('✗ response compression found in the transport layer:\n');
  for (const o of offenders) console.error('    ' + o + '\n');
  console.error(
    '  Papercusp is a Tauri DESKTOP app: the host binds 127.0.0.1 and every consumer is on\n' +
      '  the same machine, so compressing a response spends CPU on both ends to shrink bytes\n' +
      '  that never leave the box. Send it raw. Decompression (gunzip/unzstd) and at-rest or\n' +
      '  distribution compression (backups, archives, tarballs) are unaffected by this guard;\n' +
      '  if a real network hop ever appears, compress at the edge proxy instead.\n' +
      '\n  See host-handler.ts §1 and WI-5988.',
  );
  process.exit(1);
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
