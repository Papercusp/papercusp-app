#!/usr/bin/env node
/**
 * GATING guard: no NEW foreign-origin asset URL may enter the shipped bundle.
 *
 * egress-monitor-origin-axis-2026-08-02 P-004. This is the third leg of the
 * three-legged detector in that plan's D-003, and the ONLY one that can see
 * code nobody ran:
 *
 *   - the runtime egress monitor (libs/generic/desktop-ipc/src/egress-monitor.ts,
 *     P-001..P-003) sees dynamically-constructed URLs and proves LIVENESS, but
 *     is structurally blind to a code path no test exercised. Monaco fetched
 *     0.55.1 from jsdelivr for months and no monitor ever saw it, because
 *     nobody opened the Gym while a monitor was installed.
 *   - CSP (P-006) prevents rather than observes, and only in the packaged shell.
 *   - THIS scan reads the built artifact, so an unexercised fetch is as visible
 *     as a hot one.
 *
 * WHY OVER THE BUILT DIST AND NOT THE SOURCE. The per-library guards this
 * generalizes (vditor-cdn.test.ts, monaco-cdn.test.ts, porcupine-cdn.test.ts)
 * assert over OUR source, which works only because we already knew which
 * library and which option to look at. The URL is usually not in our code at
 * all — it is a default baked into a dependency (`@monaco-editor/loader`'s
 * `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs`, vditor's
 * `https://unpkg.com/vditor@<ver>`), so a source scan cannot find the next one.
 * The built bundle is where every such default becomes visible at once.
 *
 * ── THE TWO WAYS THIS CHECK GOES WRONG, AND WHAT IS DONE ABOUT THEM ──────────
 *
 * (1) IT READS FILES ITSELF INSTEAD OF SHELLING OUT TO grep. GNU grep
 *     classifies minified bundle chunks as BINARY and skips them, printing
 *     nothing at all — not even a zero count — for strings that ARE present.
 *     A grep-based version of this guard would pass vacuously and forever, and
 *     would look exactly like a clean run. (Recorded twice independently on
 *     this box; `grep -a` is the shell workaround, but reading the bytes in
 *     Node removes the failure mode rather than tiptoeing around it.)
 *
 * (2) IT DISCRIMINATES A FETCHED URL FROM A MENTIONED ONE. The naive rule —
 *     "any non-local origin is a finding", i.e. the exact P-001 runtime rule —
 *     yields ~500 hits on a clean tree: 267 `www.w3.org` SVG namespace
 *     declarations, 60 `github.com` links in vendored comments, doc links to
 *     mermaid.js.org and react.dev. All inert, none fetchable. A guard whose
 *     first run reports 500 findings on correct code is a guard someone
 *     silences. So a URL is a candidate only when its PATH looks like a
 *     fetchable asset (an asset extension, or a versioned package path like
 *     `/pkg@1.2.3/`). That cuts ~500 to ~24 real ones with no loss of signal:
 *     every finding in the sibling plan `cdn-egress-fixes-2026-08-02` matches
 *     the asset shape, and none of the inert mentions do.
 *
 * DETECTION IS ON URL PRESENCE, NEVER ON A COUNT (plan D-002, and the repo's
 * own "a count DELTA is not presence" rule): the baseline is keyed by
 * (normalized file, URL), so re-minification that changes an occurrence count
 * cannot mask an addition, and a hashed chunk name cannot mask one either.
 *
 * THE BASELINE IS A RATCHET, NOT AN AMNESTY. Every entry carries a `reason`.
 * Entries are expected to be REMOVED as the sibling plan's fixes land; the
 * guard reports removals and tells you to re-run with --update so the floor
 * drops behind you. It never auto-accepts an addition.
 *
 * ── WHAT THIS GUARD MAY NOT CLAIM (sibling plan D-004) ──────────────────────
 *
 * `cdn-egress-fixes-2026-08-02` D-004 settled that "only a RUNTIME
 * resource-timing read can verify this class — never a bundle grep", and this
 * script is a bundle grep. That is not a contradiction, but the boundary is
 * exact and must not be blurred:
 *
 *   - EVERY fix in this class works by overriding a URL at runtime (an AMD
 *     loader path, `options.cdn`, `EXCALIDRAW_ASSET_PATH`). The library's
 *     default string therefore survives in the bundle whether the fix works or
 *     not. So a hit here is NOT evidence of egress, and an absence is NOT
 *     evidence a fix landed. Two of the six findings in that plan (emoji-mart,
 *     speech-rule-engine) were PROVEN NOT LIVE at runtime while their URLs sat
 *     in the bundle exactly as they do today.
 *   - What this scan uniquely provides is DISCOVERY, not a verdict: it is the
 *     only leg that notices a third-party asset URL nobody has classified yet,
 *     including in code no test will ever execute. It answers "is there a new
 *     candidate?", never "is it fetched?".
 *
 * Hence the workflow it enforces: a new hit means GO AND ESTABLISH LIVENESS at
 * runtime (the probe-plan technique in that plan's P-007), then either fix it
 * or baseline it with the runtime verdict written into `reason`. The baseline's
 * `status` field records which of those happened, so a later reader can tell a
 * verified-inert row from one that has simply never been checked.
 *
 * Usage:
 *   node scripts/check-no-cdn-egress.mjs              # builds fresh, then scans
 *   node scripts/check-no-cdn-egress.mjs --dist DIR   # scan an existing dist
 *   node scripts/check-no-cdn-egress.mjs --update     # rewrite the baseline
 *   node scripts/check-no-cdn-egress.mjs --report     # list findings, exit 0
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteDir = join(repoRoot, 'apps', 'operator-vite');
const BASELINE_PATH = join(repoRoot, 'scripts', 'no-cdn-egress-baseline.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const optValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const UPDATE = flag('update');
const REPORT_ONLY = flag('report');
const distArg = optValue('dist');

/**
 * Origins that are OURS. A URL on one of these hosts is never a finding, at
 * any path. This is the static mirror of the runtime rule's local allowlist
 * (egress-monitor.ts `classifyEgress`) — keep the two in sync when either
 * gains a host.
 */
const LOCAL_ORIGIN_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  'papercuspai.com',
  'www.papercuspai.com',
  'chat.papercupai.com',
]);

/** File types that actually execute or are loaded by the shell. */
const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.css', '.html'];

/**
 * Docs publication swaps the live mirror through `docs.old.<pid>` while a
 * concurrent reader finishes walking the previous tree. These directories are
 * stale, gitignored swap leftovers rather than served output; Vite can copy
 * one into a temporary dist before the grace-period reaper removes it. Do not
 * let a dead copy create a second, PID-dependent baseline namespace.
 */
const DOCS_SWAP_LEFTOVER_RE = /(^|\/)docs\.old\.\d+(\/|$)/;

/**
 * A path shaped like a fetchable asset. Either it ends in an asset extension,
 * or it is a versioned package path (`/name@1.2.3`, `/@scope/name@latest`) —
 * the shape every CDN base URL takes, including ones with no extension at all
 * such as `.../monaco-editor@0.55.1/min/vs`.
 */
const ASSET_EXTENSION_RE = /\.(?:js|mjs|cjs|wasm|css|woff2?|ttf|eot|json|pv|onnx|map)(?:$|[?#])/i;
const VERSIONED_PACKAGE_RE = /\/@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?@(?:\d[\w.+-]*|latest)/i;

/** Absolute http(s) URLs. Stops at quote, backtick, whitespace or bracket. */
const URL_RE = /https?:\/\/[a-zA-Z0-9._-]+(?::\d+)?(?:\/[^"'`\s<>()\\]*)?/g;

/**
 * Strip Vite's content hash so a rebuild does not invalidate every baseline
 * row. `assets/es-By_8IktE.js` -> `assets/es-<hash>.js`. Without this the
 * baseline would be pure noise after any code change, and a noisy baseline is
 * one that gets regenerated blindly — which is the same as not having one.
 *
 * Matched NARROWLY on purpose: EXACTLY 8 chars from Vite/Rolldown's base64url
 * alphabet, carrying a digit or an uppercase letter (`By_8IktE`, `CYN-VVQ2`,
 * `K2UTITRG`, `CmCJkiVB`). Both bounds were measured, and each errs in its own
 * direction:
 *   - a loose `{8,}` rule eats real filename words — it rewrote
 *     `third-languages.js` to `third-<hash>.js` and collapsed the distinct
 *     `el-fresh-test.html` / `el-bare-test.html` fixtures into one row,
 *     destroying attribution and letting two files share a baseline key;
 *   - requiring a digit AND an uppercase misses `CmCJkiVB` (no digit), which
 *     leaves a real hash in the key so the NEXT build reports that row as a
 *     brand-new finding and fails the gate spuriously — the far worse
 *     direction, because a guard that cries wolf is a guard that gets muted.
 * Only the LAST segment is stripped: `chunk-K2UTITRG-CmCJkiVB.js` keeps its
 * upstream `K2UTITRG` (excalidraw's own vendored chunk name, stable across our
 * builds) and loses only Vite's suffix.
 */
const VITE_HASH_RE = /-([A-Za-z0-9_-]{8})(\.[a-z]+)$/;
function normalizePath(relPath) {
  const unix = relPath.replace(/\\/g, '/');
  return unix.replace(VITE_HASH_RE, (whole, hash, ext) =>
    /[\d]/.test(hash) || /[A-Z]/.test(hash) ? `-<hash>${ext}` : whole,
  );
}

function walk(dir, out = [], relativeDir = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // The active docs mirror lives at `internal/docs`. A `docs.old.<pid>`
      // sibling is an atomic-publish handoff tree and is never served.
      if (DOCS_SWAP_LEFTOVER_RE.test(relativePath)) continue;
      walk(full, out, relativePath);
    }
    else if (entry.isFile() && SCANNED_EXTENSIONS.some((e) => entry.name.toLowerCase().endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function hostOf(url) {
  const m = /^https?:\/\/([^/:]+)/.exec(url);
  return m ? m[1].toLowerCase() : null;
}

function isAssetShaped(url) {
  const pathPart = url.replace(/^https?:\/\/[^/]+/, '');
  if (!pathPart || pathPart === '/') return false;
  return ASSET_EXTENSION_RE.test(pathPart) || VERSIONED_PACKAGE_RE.test(url);
}

/** Scan a dist directory; returns a sorted array of { file, url }. */
function scanDist(distDir) {
  const findings = new Map();
  for (const file of walk(distDir)) {
    // Read the bytes ourselves — see failure mode (1) in the header.
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = normalizePath(relative(distDir, file));
    for (const match of text.matchAll(URL_RE)) {
      const url = match[0].replace(/[.,;:)\]]+$/, '');
      const host = hostOf(url);
      if (!host || LOCAL_ORIGIN_HOSTS.has(host)) continue;
      if (!isAssetShaped(url)) continue;
      findings.set(`${rel} ${url}`, { file: rel, url });
    }
  }
  return [...findings.values()].sort((a, b) =>
    a.file === b.file ? a.url.localeCompare(b.url) : a.file.localeCompare(b.file),
  );
}

function keyOf(f) {
  return `${f.file} ${f.url}`;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { entries: [] };
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

// ── resolve the dist to scan ────────────────────────────────────────────────
let distDir;
let tempDir = null;
if (distArg) {
  distDir = resolve(distArg);
  if (!existsSync(distDir)) {
    console.error(`[no-cdn-egress] --dist ${distDir} does not exist`);
    process.exit(1);
  }
} else {
  tempDir = mkdtempSync(join(tmpdir(), 'papercusp-cdn-egress-'));
  console.log('[no-cdn-egress] building apps/operator-vite (no existing dist given)…');
  const result = spawnSync('npx', ['vite', 'build', '--outDir', tempDir, '--emptyOutDir'], {
    cwd: viteDir,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(
      `[no-cdn-egress] operator-vite build FAILED (exit ${result.status ?? result.signal ?? '?'}):\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').slice(-40).join('\n'),
    );
    rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  }
  distDir = tempDir;
}

try {
  const findings = scanDist(distDir);

  // A scan that finds NOTHING is far more likely to be a broken scanner than a
  // pristine bundle — the tree has never been clean, and a silent-pass guard is
  // exactly the failure mode this file's header exists to prevent. Refuse it.
  if (findings.length === 0) {
    console.error(
      '[no-cdn-egress] SENSOR FAILURE: zero foreign-origin URLs found in the whole dist.\n' +
        `  Scanned ${walk(distDir).length} file(s) under ${distDir}.\n` +
        '  A real bundle always carries at least the vendored mirrors\' own CDN\n' +
        '  constants. Zero means the scanner did not read the files (wrong dist\n' +
        '  path, an empty build, or a regressed matcher) — NOT that the tree is\n' +
        '  clean. Treated as a failure, per the three-valued-verdict rule\n' +
        '  (a dead detector and a clean run must never look identical).',
    );
    process.exit(1);
  }

  if (UPDATE) {
    // Read the prior baseline ONCE, not once per finding.
    const priorByKey = new Map(loadBaseline().entries.map((e) => [keyOf(e), e]));
    const baseline = {
      $comment:
        'Baseline for scripts/check-no-cdn-egress.mjs (egress-monitor-origin-axis-2026-08-02 P-004). ' +
        'RATCHET, NOT AMNESTY: entries are expected to be removed as fixes land. ' +
        'Every entry needs a `reason`; `status` is one of inert | not-live-verified | unresolved. ' +
        'A bundle hit is a DISCOVERY, never a verdict — establish liveness at runtime before ' +
        'acting on one (sibling plan cdn-egress-fixes-2026-08-02 D-004). ' +
        'Regenerate with: npm run lint:no-cdn-egress:update',
      generated: new Date().toISOString().slice(0, 10),
      // Carry the whole prior row forward, so hand-written classification
      // (status, notes, links to the item tracking a fix) survives a
      // regeneration instead of being silently reset to the TODO placeholder.
      entries: findings.map((f) => {
        const prior = priorByKey.get(keyOf(f));
        return prior
          ? { ...prior, file: f.file, url: f.url }
          : { file: f.file, url: f.url, status: 'unresolved', reason: 'TODO: classify this occurrence' };
      }),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[no-cdn-egress] baseline updated: ${findings.length} entr(ies) -> ${relative(repoRoot, BASELINE_PATH)}`);
    process.exit(0);
  }

  const baseline = loadBaseline();
  const known = new Set(baseline.entries.map(keyOf));
  const seen = new Set(findings.map(keyOf));

  const added = findings.filter((f) => !known.has(keyOf(f)));
  const removed = baseline.entries.filter((e) => !seen.has(keyOf(e)));

  if (REPORT_ONLY) {
    console.log(`[no-cdn-egress] ${findings.length} foreign-origin asset URL(s) in ${distDir}:`);
    for (const f of findings) console.log(`  ${known.has(keyOf(f)) ? ' ' : '+'} ${f.file}\n      ${f.url}`);
    process.exit(0);
  }

  if (removed.length > 0) {
    console.log(
      `[no-cdn-egress] ${removed.length} baseline entr(ies) no longer present — re-run with --update to drop the floor:`,
    );
    for (const e of removed) console.log(`  - ${e.file}  ${e.url}`);
  }

  if (added.length > 0) {
    console.error(
      `\n[no-cdn-egress] FAIL: ${added.length} NEW foreign-origin asset URL(s) entered the bundle.\n` +
        'Each of these is a request the app will make to a host we do not own —\n' +
        'it makes the feature require connectivity, leaks that the user is using\n' +
        'it, and ships bytes we cannot version or audit.\n',
    );
    for (const f of added) console.error(`  + ${f.file}\n      ${f.url}`);
    console.error(
      '\nFix it at the library entry point (point the option at our local mirror,\n' +
        'the way MarkdownEditor passes `cdn: VDITOR_CDN` and the Monaco call sites\n' +
        'pass `loader.config({ paths: { vs } })`), then vendor the asset in the\n' +
        "app's public/ via the postinstall mirror script.\n" +
        'If the URL is genuinely inert (a doc link, a namespace, a string never\n' +
        'fetched), add it to scripts/no-cdn-egress-baseline.json WITH A REASON\n' +
        'stating how you established it is never fetched.\n',
    );
    process.exit(1);
  }

  console.log(
    `[no-cdn-egress] OK — ${findings.length} known foreign-origin asset URL(s), 0 new. ` +
      `(scanned ${walk(distDir).length} file(s))`,
  );
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}
