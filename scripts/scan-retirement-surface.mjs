#!/usr/bin/env node
/**
 * scan-retirement-surface.mjs — surface-precise retirement scanning (P-005,
 * agent-trap-guards-2026-07-26).
 *
 * During WI-6097 (retire-work-item-mail-surface-2026-07-26), scanning for a
 * retired surface by BARE SUBSTRING was a false-positive generator:
 *   - `messages`        matched the LIVE `coord:*` plane (`coord/messages.ts`,
 *                        `coord_event_log`, `coord-inbox-bus`)
 *   - `messages:send`   matched Google FCM's endpoint URL in
 *                        `device-push-dispatcher.ts`
 *   - `FAIL`             matched test NAMES ("FAIL-OPEN allow", "FAILED SPA
 *                        build") when auditing for residual failures
 *
 * This helper takes the SURFACE being retired — the exact tool names, table/
 * view names, or op-codes — as a list of IDENTIFIERS rather than a loose word,
 * matches them with word-boundary anchoring (so `messages:send` never matches
 * `messages:sender`), and lets the caller pre-register KNOWN false positives
 * (a file + optional line-text pattern + a reason) so a real retirement sweep
 * isn't re-litigated by hand every time it's re-run. Any hit NOT covered by
 * the allowlist is a genuine reference the sweep must still account for.
 *
 * This is a SCAN HELPER an agent runs while planning/verifying a retirement —
 * not a CI gate. See "Convention for retiring-but-keeping a surface" in
 * /internal/docs/system/repo-conventions.
 *
 * Usage:
 *   node scripts/scan-retirement-surface.mjs --surface <path-to-surface.json>
 *   node scripts/scan-retirement-surface.mjs --id "messages:send" --id "messages:dismiss"
 *   node scripts/scan-retirement-surface.mjs --surface <path> --report-only   # never exits 1
 *
 * Surface config JSON shape:
 *   {
 *     "name": "work-item-mail",
 *     "identifiers": ["messages:send", "messages:dismiss", "messages:inbox", "messages:outbox"],
 *     "allowlist": [
 *       { "file": "**\/device-push-dispatcher.ts", "reason": "Google FCM endpoint URL, unrelated to the retired tool" },
 *       { "file": "**\/coord/messages.ts", "match": "messages", "reason": "live coord:* plane, shares the word" }
 *     ],
 *     "excludeGlobs": ["**\/_retired/**"]   // optional, appended to the defaults
 *   }
 *
 * Each allowlist entry's `file` is a glob (relative to repo root, `**` and `*`
 * supported); `match` (optional) further restricts the suppression to hits of
 * that specific identifier/substring within the file — omit it to suppress
 * every hit in that file for this surface.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { coverageOf, describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Same structural exclusions as check-no-retired-imports.mjs, plus a couple
// more binary-ish / generated dirs a retirement sweep should never scan.
export const DEFAULT_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/_retired/**',
  '**/*.d.ts',
  '**/package-lock.json',
  'apps/operator/public/internal/docs/**',
  // Generated / runtime-scratch / build-sidecar dirs, tracked in this repo but
  // not hand-written source — a retirement sweep cares about live CODE, not a
  // stale prompt/tool-catalog snapshot or a build cache (found by running this
  // helper on the worked example: .papercusp/tool-catalog.json and
  // .rig-sidecar-current/serve.mjs alone contributed >250 of ~290 raw hits).
  '.papercusp/**',
  '.papercusp-scratch/**',
  '.rig-sidecar-current/**',
  '.agent-tmp/**',
  '.tmp-vitest-*/**',
  'scratch/**',
  'scratchpad/**',
  'test-results/**',
  '**/junit.xml',
  '**/coverage/**',
  // Same class of generated build-sidecar bundle, inside the papercusp-desktop
  // submodule — only reachable once `git ls-files --recurse-submodules` was
  // fixed to see submodule content at all (P-007, 2026-07-26): these are
  // minified/compiled Tauri sidecar + SPA build outputs, tracked in that
  // submodule's own git index but regenerated frequently by the fleet
  // (non-canonical, not hand-written source) — a retirement sweep hitting a
  // compiled string literal here is noise, not a real coupling.
  'papercusp-desktop/src-tauri/sidecar/**',
  'papercusp-desktop/src-tauri/env-sidecars/**',
  'papercusp-desktop/src-tauri/sidecar.tmp.*/**',
];

/** Compile a small glob (supporting `*`, `**`, literal) to a RegExp anchored on the whole path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        // swallow an immediately-following slash so `**/x` also matches `x` at the root
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(glob, filePath) {
  return globToRegExp(glob).test(filePath);
}

/** Word-boundary-safe matcher: an identifier must not be flanked by an identifier-ish char. */
const BOUNDARY_CHARS = /[A-Za-z0-9_]/;

export function findIdentifierHits(text, identifier) {
  const hits = [];
  let from = 0;
  while (true) {
    const idx = text.indexOf(identifier, from);
    if (idx === -1) break;
    const before = idx > 0 ? text[idx - 1] : '';
    const after = idx + identifier.length < text.length ? text[idx + identifier.length] : '';
    const boundaryOk = !BOUNDARY_CHARS.test(before) && !BOUNDARY_CHARS.test(after);
    if (boundaryOk) hits.push(idx);
    from = idx + 1;
  }
  return hits;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

function lineTextAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

export function loadSurface(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.identifiers) || raw.identifiers.length === 0) {
    throw new Error(`surface config ${path} must have a non-empty "identifiers" array`);
  }
  return {
    name: raw.name ?? path,
    identifiers: raw.identifiers,
    allowlist: raw.allowlist ?? [],
    excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS, ...(raw.excludeGlobs ?? [])],
  };
}

function isAllowlisted(allowlist, filePath, identifier, lineText) {
  return allowlist.find(
    (entry) =>
      matchesGlob(entry.file, filePath) &&
      (!entry.match || identifier === entry.match || lineText.includes(entry.match)),
  );
}

/**
 * Scan the tracked tree for `identifiers`, suppressing hits covered by
 * `allowlist`. `listFiles` is injectable for tests (defaults to `git
 * ls-files`); `readFile` likewise.
 */
export function scanSurface({
  identifiers,
  allowlist = [],
  excludeGlobs = DEFAULT_EXCLUDE_GLOBS,
  root = ROOT,
  // --recurse-submodules is REQUIRED: libs/papercusp is a git submodule, so a
  // plain `git ls-files` from the superproject silently returns NOTHING for
  // anything under it — meaning a retirement sweep using the DEFAULT listFiles
  // would silently skip the whole libs/papercusp/packages/harness/blueprints
  // tree (found empirically while building this surface's sibling, P-007
  // agent-trap-guards-2026-07-26, which hit the identical blind spot and
  // confirmed the fix against the real tree: 122 files recovered).
  listFiles = () =>
    execSync('git ls-files --recurse-submodules', { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean),
  readFile = (f) => readFileSync(new URL(f, `file://${root.endsWith('/') ? root : root + '/'}`), 'utf8'),
}) {
  const files = listFiles().filter((f) => !excludeGlobs.some((g) => matchesGlob(g, f)));
  const hits = [];
  const suppressed = [];

  for (const f of files) {
    let text;
    try {
      text = readFile(f);
    } catch {
      continue; // binary / unreadable / gone since ls-files ran
    }
    for (const identifier of identifiers) {
      for (const idx of findIdentifierHits(text, identifier)) {
        const lineText = lineTextAt(text, idx);
        const line = lineNumberAt(text, idx);
        const entry = isAllowlisted(allowlist, f, identifier, lineText);
        const record = { file: f, line, identifier, lineText };
        if (entry) suppressed.push({ ...record, reason: entry.reason ?? '(no reason given)' });
        else hits.push(record);
      }
    }
  }

  const byIdentifier = {};
  for (const h of hits) (byIdentifier[h.identifier] ??= []).push(h);

  // WI-6776: return the file LIST, not just its length, so the caller can state what
  // the scan did not cover. A retirement sweep is an absence proof ("no references
  // remain"), and an absence proof over a subtree that was never opened is worthless.
  return { hits, suppressed, byIdentifier, filesScanned: files.length, files };
}

function parseArgs(argv) {
  const args = { ids: [], reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--surface') args.surface = argv[++i];
    else if (a === '--id') args.ids.push(argv[++i]);
    else if (a === '--report-only') args.reportOnly = true;
    else if (a === '--root') args.root = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let surface;
  if (args.surface) {
    surface = loadSurface(args.surface);
  } else if (args.ids.length > 0) {
    surface = { name: '(inline)', identifiers: args.ids, allowlist: [], excludeGlobs: DEFAULT_EXCLUDE_GLOBS };
  } else {
    console.error('usage: scan-retirement-surface.mjs --surface <config.json> | --id <identifier> [--id ...] [--report-only]');
    process.exit(2);
  }

  const root = args.root ?? ROOT;
  const { hits, suppressed, filesScanned, files } = scanSurface({ ...surface, root });

  const cov = coverageOf(files, root);
  console.log(
    `scan-retirement-surface: "${surface.name}" — ${surface.identifiers.length} identifier(s), ` +
      `${filesScanned} file(s) scanned across the superproject + ${cov.scanned.length}/${cov.declared.length} submodule(s)` +
      describeUnscanned(cov, root),
  );
  if (suppressed.length > 0) {
    console.log(`\n${suppressed.length} known-false-positive hit(s) suppressed by allowlist:`);
    for (const s of suppressed) {
      console.log(`  (allowlisted) ${s.file}:${s.line}  [${s.identifier}]  ${s.reason}`);
    }
  }

  if (hits.length === 0) {
    console.log(`\n✓ no un-allowlisted references to the "${surface.name}" surface remain.`);
    process.exit(0);
  }

  console.log(`\n✗ ${hits.length} live reference(s) to the "${surface.name}" surface:`);
  for (const h of hits) {
    console.log(`  ${h.file}:${h.line}  [${h.identifier}]  ${h.lineText.slice(0, 140)}`);
  }
  console.log(
    `\nEach is either a genuine remaining coupling to re-point/remove, or a NEW false positive to`,
    `add to this surface's "allowlist" (with a reason) so future runs don't re-flag it.`,
  );
  process.exit(args.reportOnly ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
