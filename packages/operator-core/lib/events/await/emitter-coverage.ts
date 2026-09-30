/**
 * emitter-coverage — the RECURRENCE GUARD for EI-18676056143796303.
 *
 * The bug it exists to prevent: an event family that genuinely EMITS but was never
 * registered in `./catalog`. The consequence is not cosmetic. `events:await`'s
 * EI-10870 orphan guard checks catalog MEMBERSHIP and then speaks about EMITTERS —
 * an unregistered-but-emitting key gets reported as "NO REGISTERED EMITTER …
 * nothing in this system will ever fire it and this await can only TIME OUT",
 * which is false and maximally actionable in the wrong direction. The live case
 * was `coord:inbox-wake:<ownerId>`: the most-fired key in the entire system AND
 * the mechanism that rescues a stranded agent, so an agent that believed the
 * warning and re-parked elsewhere stranded itself. `events:catalog` also could not
 * surface any of these keys at all, so nobody could discover them.
 *
 * Registering the families is the fix; THIS is what stops the next one drifting in.
 *
 * WHAT IT SCANS. Event keys reach `emitAwaitedEvent` three ways, and the guard
 * resolves all three statically:
 *   1. an inline string literal            — `key: 'green-checkpoint:red'`
 *   2. a template literal with a static head — `key: \`escalation:resolved:${id}\``
 *   3. a named constant or key helper       — `key: inboxWakeKey(x)`, backed by
 *      `const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:'` / `const
 *      REF_ANNOUNCE_EVENT_KEY = 'pot-git:ref-announce'`.
 * (3) is the one that matters most: the live miss was emitted through a helper, so
 * a call-site-literals-only scanner would have missed the very bug this guards.
 * Declaration constants are therefore matched by NAME shape (`*_EVENT_KEY`,
 * `*_WAKE_PREFIX`, `*_KEY_PREFIX`, …) wherever they are declared.
 *
 * WHAT IT CANNOT SEE, by construction: a key assembled from runtime data with no
 * static head (`key: args.event` in events:emit, `key: row.eventKey` in the
 * predicate-watch pump). Those are PASS-THROUGH emitters — they fire whatever a
 * caller hands them and have no family of their own — so there is nothing to
 * register, and skipping them is correct rather than a coverage hole.
 *
 * Pure + injectable (`roots`, `readFile`) so the test drives it over fixtures and
 * over the real tree without a second implementation.
 */

import { readdir, readFile as fsReadFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { keyMatchesCatalog, type EventCatalogEntry } from './catalog';

/** One statically-resolved event key (or key PREFIX) found in the source tree. */
export interface FoundEventKey {
  /** The literal head — a whole key, or the static prefix of a templated one. */
  key: string;
  /** Repo-relative file it was found in. */
  file: string;
  /** 1-indexed line. */
  line: number;
  /** How it was written, for the failure message. */
  via: 'literal' | 'template' | 'constant';
}

/** Directories never worth walking (build output, vendored code, retired trees). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  'coverage',
  '_retired',
  'target',
  'out',
]);

/**
 * A key-ish literal: at least two `:`-separated segments of key-safe characters.
 * Deliberately strict — a one-segment string is far more likely to be prose or an
 * id than an event key, and every real family in the catalog is multi-segment.
 */
const KEY_SHAPE = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+:?$/i;

/** `key: 'x'` / `key: "x"` / `eventKey: 'x'` — an inline literal at an emit site. */
const LITERAL_KEY = /\b(?:key|eventKey)\s*:\s*(['"])([^'"\n]+)\1/g;

/** ``key: `x:y:${…}` `` — take the static head before the first interpolation. */
const TEMPLATE_KEY = /\b(?:key|eventKey)\s*:\s*`([^`\n$]*)\$\{/g;

/**
 * `const FOO_EVENT_KEY = 'x:y'` / `const FOO_KEY_PREFIX = 'x:y:'` — the named
 * constants the helper-emitted families are built from. Matched by NAME so a new
 * key constant is picked up wherever it is declared.
 */
const CONST_KEY = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*(?:EVENT_KEY|KEY_PREFIX|WAKE_PREFIX|EVENT_PREFIX))\s*(?::[^=\n]+)?=\s*(['"])([^'"\n]+)\2/g;

/** A test/fixture file — a key invented for a test is not a real emitter. */
function isTestFile(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
    path.includes(`${sep}__tests__${sep}`) ||
    path.includes(`${sep}test${sep}`) ||
    path.includes(`${sep}fixtures${sep}`)
  );
}

/** Should this file be read at all? (cheap extension gate before any I/O) */
function isScannableSource(path: string): boolean {
  return /\.[cm]?tsx?$/.test(path) && !path.endsWith('.d.ts') && !isTestFile(path);
}

/** Recursively list scannable source files under `root`. */
async function listSourceFiles(root: string, repoRoot: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // a root that doesn't exist in this checkout is not a failure
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      dirs.push(full);
    } else if (entry.isFile() && isScannableSource(full)) {
      out.push(full.startsWith(repoRoot) ? full.slice(repoRoot.length + 1) : full);
    }
  }
  // Fan the subdirectories out in parallel — a serial per-directory await over a
  // tree this size is the A-series fs anti-pattern (/internal/docs/performance).
  await Promise.all(dirs.map((d) => listSourceFiles(d, repoRoot, out)));
}

/**
 * The token that marks a file as part of the AWAITABLE-event surface. Scoping the
 * scan to these files is what keeps it precise: `key:` is an extremely common
 * object property (auth tiers, UI interaction ids, perf-suite step names), and a
 * tree-wide `key:` sweep is ~75% false positives. Every real emit site in the repo
 * routes through `emitAwaitedEvent`, including the helper-backed ones — the live
 * EI-18676056143796303 miss (`coord:inbox-wake:`) is declared in inbox-wake.ts,
 * which calls it — so the gate costs no genuine coverage.
 */
const EMIT_SURFACE_TOKEN = 'emitAwaitedEvent';

/**
 * Blank out comments so an EXAMPLE key in a doc comment is never mistaken for an
 * emit. This file's own header would otherwise self-report, and several emitters
 * document their key shape in prose directly above the call. Replaces with spaces
 * rather than deleting, so reported line numbers stay true to the original file.
 *
 * Exported for `./emitter-pin`, the opposite-direction guard: this module asks
 * "is every EMITTED key registered?", that one asks "does every REGISTERED key's
 * declared emitter really emit it?". Both have to draw the code/prose line the
 * same way, so they share this one implementation rather than each rolling one.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Extract every statically-resolvable event key from one file's text. */
export function scanSourceForEventKeys(source: string, file: string): FoundEventKey[] {
  const found: FoundEventKey[] = [];
  const text = stripComments(source);
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;

  const push = (raw: string, index: number, via: FoundEventKey['via']) => {
    // A template head ends at the interpolation, so trim a dangling separator:
    // `escalation:resolved:${id}` → `escalation:resolved`.
    const key = raw.replace(/:$/, '').trim();
    if (!key || !KEY_SHAPE.test(key)) return;
    found.push({ key, file, line: lineOf(index), via });
  };

  for (const m of text.matchAll(LITERAL_KEY)) push(m[2]!, m.index ?? 0, 'literal');
  for (const m of text.matchAll(TEMPLATE_KEY)) push(m[1]!, m.index ?? 0, 'template');
  for (const m of text.matchAll(CONST_KEY)) push(m[3]!, m.index ?? 0, 'constant');
  return found;
}

export interface EmitterCoverageOptions {
  /** Repo root the `roots` are resolved against and paths reported relative to. */
  repoRoot: string;
  /** Source roots to walk, repo-relative. */
  roots: readonly string[];
  /** Catalog to check against — pass the merged catalog to honour installed packs. */
  catalog?: readonly EventCatalogEntry[];
  /**
   * Keys that are legitimately absent from the catalog. Each entry must carry a
   * reason: an unexplained allowlist entry is how a real gap gets parked forever.
   */
  allow?: Readonly<Record<string, string>>;
  /** Injectable for tests. */
  readFile?: (path: string) => Promise<string>;
}

export interface EmitterCoverageResult {
  /** Every distinct key found, sorted. */
  scanned: FoundEventKey[];
  /** Found keys that resolve to no catalog family and are not allowlisted. */
  unregistered: FoundEventKey[];
  /** Allowlist entries that matched nothing — a stale exemption to delete. */
  unusedAllow: string[];
  filesScanned: number;
}

/**
 * Walk `roots` and report every event key the source emits that the catalog does
 * not know about. Deduplicated by key (first occurrence wins) so one family that
 * emits from three call sites is one finding, not three.
 */
export async function findUnregisteredEventKeys(opts: EmitterCoverageOptions): Promise<EmitterCoverageResult> {
  const readFile = opts.readFile ?? ((p: string) => fsReadFile(join(opts.repoRoot, p), 'utf8'));
  const allow = opts.allow ?? {};

  const files: string[] = [];
  await Promise.all(opts.roots.map((r) => listSourceFiles(join(opts.repoRoot, r), opts.repoRoot, files)));
  files.sort();

  const byKey = new Map<string, FoundEventKey>();
  await Promise.all(
    files.map(async (file) => {
      let text: string;
      try {
        text = await readFile(file);
      } catch {
        return;
      }
      // Only the awaitable-event emit surface — see EMIT_SURFACE_TOKEN.
      if (!text.includes(EMIT_SURFACE_TOKEN)) return;
      for (const hit of scanSourceForEventKeys(text, file)) {
        const prior = byKey.get(hit.key);
        if (!prior || hit.file < prior.file) byKey.set(hit.key, hit);
      }
    }),
  );

  const scanned = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const usedAllow = new Set<string>();
  const unregistered: FoundEventKey[] = [];
  for (const hit of scanned) {
    if (allow[hit.key] !== undefined) {
      usedAllow.add(hit.key);
      continue;
    }
    if (!keyMatchesCatalog(hit.key, opts.catalog)) unregistered.push(hit);
  }

  return {
    scanned,
    unregistered,
    unusedAllow: Object.keys(allow).filter((k) => !usedAllow.has(k)).sort(),
    filesScanned: files.length,
  };
}

/** Render findings as the assertion message — every finding names its fix. */
export function formatUnregisteredEventKeys(unregistered: readonly FoundEventKey[]): string {
  if (unregistered.length === 0) return '';
  const lines = unregistered.map((u) => `  • "${u.key}"  (${u.via} @ ${u.file}:${u.line})`);
  return [
    `${unregistered.length} event key(s) are emitted by the source but registered in NO events:catalog family:`,
    ...lines,
    '',
    'EI-18676056143796303: an unregistered-but-emitting family makes events:await report a VALID',
    'await as `unknown_event_key` — "nothing in this system will ever fire it and this await can',
    'only TIME OUT" — which tells the agent to abandon a park that would have worked, and hides the',
    'key from events:catalog entirely. Add the family to packages/operator-core/lib/events/await/catalog.ts',
    '(ground `emitter` on the real emit site). If the key is genuinely not an awaitable family',
    '(a pass-through emitter, or a test/announced-gate key), add it to the ALLOW map WITH a reason.',
  ].join('\n');
}
