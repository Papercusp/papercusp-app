#!/usr/bin/env node
/**
 * mug-kettle-surface-census — a machine-generated inventory of every ENTRY POINT
 * through which the Mug / Kettle / Cup tier can initiate, display, or offer work.
 *
 * Plan: retire-mug-kettle-su-only-2026-08-09 (P-005). Written BEFORE the retirement
 * so the change is measurable, and so P-016's lint has a real population rather than
 * one agent's grep.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A GREP FOR "mug"
 * ─────────────────────────────────────────────────────────────────────────────────
 * P-005 requires anchoring on the PROPERTY (does this site initiate / display / offer
 * mug-kettle work) rather than on the spelling of a word. Two measured facts from this
 * tree make a word-grep actively wrong, in BOTH directions:
 *
 *   FALSE NEGATIVE — the registration name can be a CONSTANT, not a literal.
 *     `overwatch/loop.ts:576` reads:
 *         registerSystemAction(OVERWATCH_LAUNCH_ACTION, handleOverwatchLaunch);
 *     A scan for `registerSystemAction('system:...')` finds 54 actions and MISSES this
 *     one entirely — i.e. it misses the Kettle's own launcher. Any literal-only detector
 *     reports the Kettle as having no launch action, which reads exactly like "already
 *     retired" and is the most expensive possible wrong answer here.
 *
 *   FALSE POSITIVE — the blueprint id does NOT discriminate.
 *     `POT_BLUEPRINT_ID === 'coding'` AND `OVERWATCH_BLUEPRINT_ID === 'coding'`, the same
 *     id an ordinary su coding session uses. Classifying by the VALUE would sweep up
 *     unrelated launches; so blueprint launches are classified by the CONSTANT NAME.
 *
 * Therefore every detector below anchors on a MECHANISM (a call, a registration, a role
 * assignment, a mounted surface) and resolves identifier arguments through a constant
 * table before classifying.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * COVERAGE IS REPORTED, NOT ASSUMED
 * ─────────────────────────────────────────────────────────────────────────────────
 * A detector is only as wide as the shape it matches. This script therefore emits a
 * `coverage` block naming (a) the shapes each detector DOES match, and (b) every site it
 * found but could NOT resolve (`unresolved`). An empty findings list is only meaningful
 * next to `coverage.status === 'complete'`. Read `unresolved` before concluding anything
 * is absent — "not found" is never reported as "does not exist".
 *
 * Usage:
 *   node scripts/mug-kettle-surface-census.mjs             # printed table
 *   node scripts/mug-kettle-surface-census.mjs --json      # JSON to stdout
 *   node scripts/mug-kettle-surface-census.mjs --out c.json
 *   node scripts/mug-kettle-surface-census.mjs --category system-action
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';
import { offersTierRoute } from './lib/mug-kettle-ui-route.mjs';
import { findDanglingSubstrateSymbols } from './lib/mug-kettle-substrate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Roots we scan. Everything else (node_modules, build output) is skipped. */
const SCAN_ROOTS = ['packages', 'libs', 'apps', 'scripts'];
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', '.next', 'coverage', 'target',
  '.turbo', '.cache', 'out', '.astro',
]);
/**
 * Any `dist*` directory is BUILD OUTPUT, not a surface. Skipping only the exact name
 * `dist` let `apps/operator/dist-host/hono-host.mjs` in — a 700k-line bundle that
 * contributed duplicate "findings" for every source site it inlined, inflating the
 * census with sites nobody can edit.
 */
const isBuildOutputDir = (name) => /^dist(-|$)/.test(name);

/** The census must not inventory ITSELF — its own doc comments name every shape it hunts. */
const SELF_FILE = fileURLToPath(import.meta.url);

/**
 * `_retired/` is scanned but bucketed SEPARATELY: those surfaces are already retired,
 * so counting them in the live population would overstate the work remaining.
 */
const RETIRED_MARKER = `${path.sep}_retired${path.sep}`;

const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx']);
const isTestFile = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || `${path.sep}__tests__${path.sep}`.includes(path.sep) && p.includes(`${path.sep}__tests__${path.sep}`);

/* ══════════════════════════════════════════════════════════════════════════════════
   THE DOMAIN — what counts as mug/kettle/cup machinery
   ══════════════════════════════════════════════════════════════════════════════════ */

/** Runtime roles. Ground truth: harness_shared.spawned_agents.child_role. */
const RETIRING_ROLES = new Set(['mug', 'kettle', 'cup']);

/**
 * Constants whose NAME (not value) marks a blueprint launch as mug/kettle machinery.
 * Both resolve to 'coding', which is why the name is the discriminator.
 */
const DOMAIN_BLUEPRINT_CONSTS = new Set(['POT_BLUEPRINT_ID', 'OVERWATCH_BLUEPRINT_ID']);

/** Source directories that ARE the deciders (D-003 population (a)). */
const DOMAIN_DIR_PATTERNS = [
  /packages\/operator-core\/lib\/pot\//,
  /packages\/operator-core\/lib\/overwatch\//,
  /packages\/operator-core\/lib\/agent-tools\/pot\//,
  /packages\/operator-core\/lib\/agent-tools\/cup\//,
  /packages\/operator-core\/lib\/agent-tools\/overwatch\//,
];

/** Tool-name prefixes owned by the retiring tier. */
const DOMAIN_TOOL_PREFIXES = ['pot:', 'cup:', 'kettle:', 'overwatch:', 'mug:'];

const inDomainDir = (rel) => DOMAIN_DIR_PATTERNS.some((re) => re.test(rel));

/* ── TIER VOCABULARY — matched as WHOLE TOKENS, never as substrings ────────────────
 * The tier has two vocabularies because the lexicon rename (hive→pot, bee→cup,
 * queen→mug, sentinel→papercup) left flag KEYS and flag VALUES out of sync, so both
 * spellings are live in the same file.
 *
 * ⚠ These MUST be tested against tokens, not with `/hive/i.test(s)`. Measured here:
 * `SESSION_ARCHIVE_AT_END: "papercusp-session-archive-at-end"` matched the tier on a
 * substring scan because **"arc·HIVE·-at-end"** contains "hive". "archive" is one of
 * the most common words in this codebase, so a substring detector reports a large,
 * confident, wrong population — the exact spelling-vs-property error P-005 forbids.
 */
const TIER_TOKENS = new Set([
  'pot', 'mug', 'cup', 'kettle', 'overwatch',
  'hive', 'queen', 'bee', // pre-rename spellings, still live in flag values
  'nursery',
]);

/**
 * Genuine HOMONYMS — tokens that equal a tier word but name something else entirely.
 * Each entry is an exclusion with a stated reason; without them the census sends the
 * retirement into unrelated product surface.
 */
const HOMONYMS = new Map([
  ['papercup', 'the Sentinel role (FLAGS.PAPERCUP = "papercusp-sentinel") — a separate role, not the Cup tier'],
  ['cupboard', 'the template/plugin marketplace — unrelated to the Cup tier'],
  ['papercusp', 'the product name — contains no tier token once split'],
]);

/**
 * Whole NAMES excluded even though they contain a real tier token. Tokenization cannot
 * settle these — they need the semantic call, so each carries its reason.
 */
const NAME_EXCLUSIONS = new Map([
  ['RED_QUEEN', 'the red-queen learning-loop blueprint (Scout/learning family) — STAYS per D-001'],
  ['AnimatedPapercuspCup', 'the brand coffee-cup animation — not the Cup agent tier'],
  ['PotThemeBridge', 'visual theming for the pot concept — displays no mug/kettle work'],
  ['PotVisualIdentity', 'visual theming for the pot concept — displays no mug/kettle work'],
]);

/**
 * Split an identifier / flag value / filename into whole words: on non-alphanumerics
 * AND on camelCase boundaries. "archive" → ["archive"] (no "hive"); "papercusp-hive-
 * agent-tabs" → [...,"hive",...]; "AnimatedPapercuspCup" → ["animated","papercusp","cup"].
 */
function tokenize(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Does this name refer to the retiring tier? Returns the matched token, or null.
 * A name whose ONLY tier hit is explained by a homonym is rejected.
 */
function namesTier(...parts) {
  for (const p of parts) {
    if (p == null) continue;
    if (NAME_EXCLUSIONS.has(p)) continue;
    const tokens = tokenize(p);
    if (tokens.some((t) => HOMONYMS.has(t) && !tokens.some((u) => TIER_TOKENS.has(u) && u !== t))) continue;
    for (const t of tokens) {
      if (HOMONYMS.has(t)) continue;
      if (TIER_TOKENS.has(t)) return t;
    }
  }
  return null;
}

/**
 * SHARED POT SUBSTRATE (plan D-003 population (b)) — symbols the SU SYSTEM ITSELF runs
 * on. `loop:arm` and `loop:checkpoint` import `resolvePotHomeSlug`; the scout watchdogs
 * and search ingest-lag watchdog use the pot_watchdog_fires debounce table. Gating these
 * with the tier would break the replacement system, so findings that name them are marked
 * `substrate: true` — inventory them, do NOT retire them.
 */
const SUBSTRATE_SYMBOLS = new Set([
  'resolvePotHomeSlug', 'listStartedPots', 'recentWatchdogFires',
  'recordFire', 'claimWatchdogFire',
]);

/**
 * The SAME D-003 population (b) exemption, for the UI category (P-077).
 *
 * The `ui` finding below is a FILENAME heuristic — any `.tsx` whose basename carries a
 * tier noun ("Pot…") is flagged — and a filename cannot tell a retired-tier control from
 * a current product surface scoped by pot. The map therefore carries the classification
 * reason per component: federation readers survive as D-003 population (b), while the
 * LearningPot surfaces drive today's learning/gym/governor system and never offer a route
 * into Mug/Kettle/Cup. Gating either class with the retired tier would remove live product
 * functionality — the exact opposite of what the guard is protecting.
 *
 * This closes a REAL mechanism gap, not just this file's case: the guard's failure text
 * tells you a genuine substrate site "belongs in the census's SUBSTRATE_SYMBOLS", but the
 * census consulted that set ONLY on symbol findings, so a UI finding had nowhere correct
 * to go and the only route left was appending to a baseline whose own first rule is
 * "NEVER append to it to silence a new finding" (filed as EI-20092489577490038).
 *
 * ⚠ Membership is a claim about the FILE, not its name. Add one only after reading the
 * component and confirming it reads substrate rather than driving the tier — the whole
 * failure mode here is a name standing in for a fact nobody checked.
 */
const SUBSTRATE_UI = new Map([
  [
    'PotFederationStatus',
    'D-003 population (b): reads p2p reach + install substrate health (Brief M / G-004), not the retired tier',
  ],
  [
    'PotPeerRoster',
    'D-003 population (b): reads the p2p peer roster over shared_presence (re-homed by P-077), not the retired tier',
  ],
  // learning-pot-scope-gate-2026-08-30 (shipped). These three surfaces use
  // "pot" in its LIVE product sense: the scope that owns learning automation.
  // Read the writers before adding them here — Drawer/Rail invoke only the
  // current learning:set-pot-scope, gym:arm and governor:arm tools; Picker invokes
  // learning:set-pot-scope. None mounts, launches or controls Mug/Kettle/Cup.
  [
    'LearningPotDrawer',
    'Live per-pot learning control: reads automation.catalog/hive.overrides and writes learning:set-pot-scope, gym:arm and governor:arm — no retired-tier route',
  ],
  [
    'LearningPotPicker',
    'Live every-pot learning-scope picker: reads automation.catalog/harnessProjects.lite and writes learning:set-pot-scope — no retired-tier route',
  ],
  // 'LearningPotRail' sat here until 2026-09-07, when its chips were folded
  // into the Learning tab's start/pause dropdown and the component was deleted.
  // The exemption is REMOVED rather than renamed onto its successor: this list
  // exempts components whose BASENAME names the retiring tier (that is what
  // raises the finding at all), and LearningLoopControl does not — it writes
  // learning:set-pot-scope but is never flagged, so an entry for it would be
  // the dead exemption the dangling-check below exists to reject.
]);

/* ══════════════════════════════════════════════════════════════════════════════════
   FILE WALK
   ══════════════════════════════════════════════════════════════════════════════════ */

function walk(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || isBuildOutputDir(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (abs === SELF_FILE) continue;
    if (e.isDirectory()) walk(abs, acc);
    else if (CODE_EXT.has(path.extname(e.name)) || e.name.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

const allFiles = [];
for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), allFiles);

const rel = (abs) => path.relative(REPO_ROOT, abs);
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Read once, reuse across every detector. */
const fileCache = new Map();
function read(abs) {
  if (!fileCache.has(abs)) {
    try { fileCache.set(abs, fs.readFileSync(abs, 'utf8')); } catch { fileCache.set(abs, ''); }
  }
  return fileCache.get(abs);
}

/**
 * Source with COMMENTS MASKED — what every detector below scans.
 *
 * WHY (WI-37661, measured 2026-08-10): the detectors text-match tokens, and a comment is
 * not code. D7's `D7_TAB_RE` matches a QUOTED role token, and its backtick alternative —
 * there to catch template literals — also matches ordinary markdown code-quoting in prose.
 * So a JSX comment in `OperatorChatSidebar.tsx` EXPLAINING why the kettle glyph was removed
 * (it names the cast glyph for `kettle`/`overwatch`) was reported as a NEW UNGATED entry
 * point "mounts tier tab token(s): kettle", red-pinning the fleet gate on a comment.
 *
 * That is structural for THIS census specifically: the plan it enforces
 * (retire-mug-kettle-su-only-2026-08-09) is executed by writing comments that name the
 * retired roles, so the guard was primed to fire on its own plan's documentation. Rewording
 * the one offending comment would leave the trap armed for the next one.
 *
 * Two prior detectors already worked AROUND comment-blindness instead of removing it — the
 * SELF_FILE exclusion (census:71, "its own doc comments name every shape it hunts") and
 * D1_DEFINITION_SITES (which exists partly to skip a "header comment"). Those workarounds
 * are now belt-and-braces rather than load-bearing.
 *
 * `stripCommentsOnly`, NOT `stripCommentsAndStrings`: the tokens these detectors read are
 * quoted VALUES (`'kettle'`, `role: 'cup'`, the flags map's `MUG_*: 'papercusp-queen-*'`),
 * so stripping string CONTENTS would blind the census completely — trading a false positive
 * for a false negative, the worse direction for a guard. That is the per-call-site A/B the
 * shared module's own docs prescribe.
 *
 * It is length- and newline-preserving (verified against the implementation, not its
 * docstring), so `lineOf(...)` offsets and every reported line number stay exact.
 */
function code(abs) {
  if (!codeCache.has(abs)) codeCache.set(abs, stripCommentsOnly(read(abs), abs));
  return codeCache.get(abs);
}
const codeCache = new Map();

const codeFiles = allFiles.filter((f) => CODE_EXT.has(path.extname(f)) && !isTestFile(f));

/* ══════════════════════════════════════════════════════════════════════════════════
   CONSTANT TABLE — so an identifier argument can be resolved to its value
   This is what makes the detectors immune to the literal-vs-constant false negative.
   ══════════════════════════════════════════════════════════════════════════════════ */

const constants = new Map(); // NAME -> { value, file }
const CONST_RE = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*["'`]([^"'`]+)["'`]/g;
for (const abs of codeFiles) {
  const src = code(abs);
  for (const m of src.matchAll(CONST_RE)) {
    if (!constants.has(m[1])) constants.set(m[1], { value: m[2], file: rel(abs) });
  }
}

/* ── IMPORT TABLE — which MODULE does a symbol actually come from? ────────────────
 * A bare call name is not evidence of provenance. Measured here: `recordFire` is
 * exported BOTH by `pot/watchdog` (the tier's debounce table) and by `autoloop` (the
 * routine-fire recorder). 20 of 20 sampled call sites imported the AUTOLOOP one, so a
 * name-only detector attributed a completely unrelated subsystem to the retirement.
 * Provenance is the property; the name is only its spelling.
 */
const IMPORT_RE = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["'`]([^"'`]+)["'`]/g;
const importSources = new Map(); // absFile -> Map(localName -> moduleSpecifier)

for (const abs of codeFiles) {
  const src = code(abs);
  if (!src.includes('import')) continue;
  const table = new Map();
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[2];
    for (const piece of m[1].split(',')) {
      const t = piece.trim();
      if (!t) continue;
      const asMatch = t.match(/^(\S+)\s+as\s+(\S+)$/);
      table.set(asMatch ? asMatch[2] : t.replace(/^type\s+/, ''), spec);
    }
  }
  if (table.size) importSources.set(abs, table);
}

/** Is `symbol`, as used in `abs`, actually the TIER's symbol (not a same-named sibling)? */
const DOMAIN_MODULE_RE = /(^|\/)(pot|overwatch)(\/|$)/;
function symbolIsFromTier(abs, symbol) {
  const spec = importSources.get(abs)?.get(symbol);
  if (spec) return { ok: DOMAIN_MODULE_RE.test(spec), source: spec };
  // No import record: either defined in this file, or re-exported. Trust the file's own
  // location — a domain file defining the symbol IS the tier.
  if (inDomainDir(rel(abs))) return { ok: true, source: 'defined in a domain file' };
  return { ok: false, source: 'unresolved — no import record and file is outside the domain' };
}

/**
 * DERIVED constants — `const A = B.startsWith(…) ? … : …` where B is a known constant.
 * The Kettle's launcher is exactly this shape:
 *   overwatch/loop.ts:79   const OVERWATCH_LAUNCH_ACTION = OVERWATCH_WAKE_TARGET_ACTION.startsWith(…)
 *   overwatch/loop.ts:576  registerSystemAction(OVERWATCH_LAUNCH_ACTION, handleOverwatchLaunch)
 * A literal-only scan misses it and reports the Kettle as having NO launch action —
 * indistinguishable from "already retired", the most expensive wrong answer available.
 * We record it as resolved-by-derivation and carry the base constant's value as the hint.
 */
const derivedConstants = new Map(); // NAME -> { value, from, file }
const DERIVED_RE = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*([A-Z][A-Z0-9_]*)\b/g;
for (const abs of codeFiles) {
  const src = code(abs);
  for (const m of src.matchAll(DERIVED_RE)) {
    const [, name, base] = m;
    if (constants.has(name) || derivedConstants.has(name)) continue;
    const baseConst = constants.get(base);
    if (baseConst) derivedConstants.set(name, { value: baseConst.value, from: base, file: rel(abs) });
  }
}

/** Resolve a call argument that may be a string literal or an identifier. */
function resolveArg(raw) {
  const trimmed = raw.trim();
  const lit = trimmed.match(/^["'`]([^"'`]+)["'`]$/);
  if (lit) return { value: lit[1], via: 'literal', resolved: true };
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const c = constants.get(trimmed);
    if (c) return { value: c.value, via: `const ${trimmed} (${c.file})`, resolved: true, constName: trimmed };
    const d = derivedConstants.get(trimmed);
    if (d) {
      return {
        value: d.value, resolved: true, constName: trimmed,
        via: `const ${trimmed} DERIVED from ${d.from} (${d.file})`, derived: true,
      };
    }
    return { value: null, via: `identifier ${trimmed}`, resolved: false, constName: trimmed };
  }
  return { value: null, via: `expression ${trimmed.slice(0, 40)}`, resolved: false };
}

/* ══════════════════════════════════════════════════════════════════════════════════
   FINDINGS
   ══════════════════════════════════════════════════════════════════════════════════ */

const findings = [];
const unresolved = [];
/**
 * Sites whose argument is genuinely runtime-determined AND whose resolution SOURCE is
 * known and named (e.g. a registry lookup). These are inventoried doors, not coverage
 * holes: keeping them out of `unresolved` preserves that list's meaning ("I could not
 * tell what this is"), while still printing them so an empty category is never misread
 * as proof of absence. A door here is a real door — it is classified, not suppressed.
 */
const dynamicSites = [];

/**
 * Resolve a file-local `const <name> = <rhs>` one hop, for args that are neither a
 * literal nor a module-level constant. Two shapes carry real information:
 *   `const x = opts.y ?? SOME_CONST`  → the DEFAULT is SOME_CONST (caller-overridable)
 *   `const x = someLookup(arg)`       → genuinely dynamic, but the SOURCE is nameable
 * Anything else stays unresolved — this widens resolution, it never invents a verdict.
 */
function resolveLocalConst(src, name) {
  const decl = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([^;\\n]+)`).exec(src);
  if (!decl) return null;
  const rhs = decl[1].trim();
  const fallback = rhs.match(/\?\?\s*([A-Za-z_$][\w$]*)\s*$/);
  if (fallback) {
    const c = resolveArg(fallback[1]);
    if (c.resolved) return { kind: 'default', constName: fallback[1], value: c.value, rhs };
  }
  const call = rhs.match(/^(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/);
  if (call) return { kind: 'dynamic', source: `${call[1]}()`, rhs };
  return null;
}

function add(category, abs, index, subject, detail, extra = {}) {
  const r = rel(abs);
  findings.push({
    category,
    subject,
    file: r,
    line: lineOf(read(abs), index),
    detail,
    retired: r.includes('_retired/') || abs.includes(RETIRED_MARKER),
    ...extra,
  });
}

/* ── D1: registered system actions ─────────────────────────────────────────────────
   Shape: registerSystemAction(<name>, handler). <name> may be a literal OR a constant.
   Classified into the domain when the resolved action name, the constant name, or the
   defining file sits in the mug/kettle/cup domain.                                    */
const D1_RE = /registerSystemAction\s*\(\s*([^,)]+)/g;
/**
 * The registry's own DEFINITION (`system-actions.ts`, where the function's signature
 * reads `name: string`) and the side-effect import manifest's header comment are not
 * registrations. Excluding them keeps `coverage.unresolved` meaning "genuinely dynamic",
 * so a reader is not desensitised to the entries that matter.
 */
const D1_DEFINITION_SITES = /harness\/routines\/(system-actions|register-system-actions)\.ts$/;
let d1Sites = 0;
for (const abs of codeFiles) {
  const src = code(abs);
  if (!src.includes('registerSystemAction')) continue;
  if (D1_DEFINITION_SITES.test(rel(abs))) continue;
  for (const m of src.matchAll(D1_RE)) {
    d1Sites++;
    const r = resolveArg(m[1]);
    if (!r.resolved) {
      unresolved.push({ category: 'system-action', file: rel(abs), line: lineOf(src, m.index), arg: r.via });
      continue;
    }
    const name = r.value;
    const hit = namesTier(name, r.constName);
    if (hit || inDomainDir(rel(abs))) {
      add('system-action', abs, m.index, name, `registerSystemAction via ${r.via}`, { matchedToken: hit });
    }
  }
}

/* ── D2: spawn role assignment ─────────────────────────────────────────────────────
   Shape: role: 'mug' | childRole: 'cup' | child_role = 'kettle' (incl. inside SQL).   */
const D2_RE = /\b(?:role|childRole|child_role|parent_role|parentRole)\s*[:=]\s*["'`](mug|kettle|cup)["'`]/g;
for (const abs of codeFiles) {
  const src = code(abs);
  for (const m of src.matchAll(D2_RE)) {
    if (!RETIRING_ROLES.has(m[1])) continue;
    add('spawn-role', abs, m.index, m[1], m[0].replace(/\s+/g, ' '));
  }
}

/* ── D3: blueprint launches ────────────────────────────────────────────────────────
   Classified by CONSTANT NAME, because POT_BLUEPRINT_ID and OVERWATCH_BLUEPRINT_ID
   both resolve to 'coding' — the same id ordinary coding sessions use.                */
// Deliberately NOT `fireLaunchBlueprint\w*` — that also matches `fireLaunchBlueprintForEvent`,
// whose first arg is an eventKey, not a blueprintId, so a domain const there would be a
// false classification. Match the exact name; the ForEvent forward is caught at its own
// inner `fireLaunchBlueprint(` call.
const D3_RE = /(function\s+)?fireLaunchBlueprint\s*\(\s*([^,)]+)/g;
for (const abs of codeFiles) {
  const src = code(abs);
  if (!src.includes('fireLaunchBlueprint')) continue;
  for (const m of src.matchAll(D3_RE)) {
    // The function's own DECLARATION is not a launch site — its CALLERS are. Anchored on
    // the declaration form (`function fireLaunchBlueprint(`) rather than on the defining
    // FILE, because that file also contains a real call (the event-driven forward below);
    // a path-based exclusion would silently drop it. Same discipline as D1's definition
    // sites: keep `unresolved` meaning "genuinely could not tell".
    if (m[1]) continue;
    const r = resolveArg(m[2]);
    if (r.constName && DOMAIN_BLUEPRINT_CONSTS.has(r.constName)) {
      add('blueprint-launch', abs, m.index, r.constName,
        `fireLaunchBlueprint(${r.constName}) → '${r.value ?? '?'}'`,
        { note: 'value is shared with ordinary coding sessions — the CONSTANT is the discriminator' });
      continue;
    }
    if (r.resolved) continue;
    const local = r.constName ? resolveLocalConst(src, r.constName) : null;
    if (local?.kind === 'default' && DOMAIN_BLUEPRINT_CONSTS.has(local.constName)) {
      add('blueprint-launch', abs, m.index, local.constName,
        `fireLaunchBlueprint(${r.constName}) → defaults to ${local.constName} ('${local.value ?? '?'}')`,
        { note: `local \`${local.rhs}\` — the DEFAULT is the tier blueprint, but a caller may override it` });
      continue;
    }
    if (local?.kind === 'dynamic') {
      dynamicSites.push({
        category: 'blueprint-launch', file: rel(abs), line: lineOf(src, m.index),
        arg: `identifier ${r.constName}`, resolvedBy: local.source,
        note: `runtime-determined via ${local.source} — inventoried door, blueprint id known only at call time`,
      });
      continue;
    }
    unresolved.push({ category: 'blueprint-launch', file: rel(abs), line: lineOf(src, m.index), arg: r.via });
  }
}

/* ── D4: tool registrations owned by the tier ──────────────────────────────────────
   Shape: name: 'pot:start' inside a tooldef.                                          */
const D4_RE = /name\s*:\s*["'`]((?:pot|cup|kettle|overwatch|mug):[a-z0-9_-]+)["'`]/gi;
for (const abs of codeFiles) {
  const src = code(abs);
  for (const m of src.matchAll(D4_RE)) {
    const toolName = m[1];
    if (!DOMAIN_TOOL_PREFIXES.some((p) => toolName.toLowerCase().startsWith(p))) continue;
    add('tool', abs, m.index, toolName, 'tool registration');
  }
}

/* ── D5: feature flags gating the tier ─────────────────────────────────────────────
   Shape: KEY: "papercusp-…" in libs/flags/src/types.ts. Matched on KEY or VALUE, since
   the lexicon rename left keys (MUG_*) and values ("papercusp-queen-*") out of sync.   */
const FLAGS_FILE = path.join(REPO_ROOT, 'libs/flags/src/types.ts');
/**
 * `[ \t]*`, NOT `\s*`, after the `^` anchor — `\s` matches NEWLINES, and this scans
 * comment-masked source where a comment block becomes a run of spaces AND blank lines.
 * With `\s*` the match started at the top of that whitespace run and swallowed it, so
 * `m.index` (and therefore the reported line) pointed at the doc COMMENT above the flag
 * instead of the flag itself. Caught by mug-kettle-census-comment-blindness.test.ts —
 * masking comments and anchoring with `\s*` interact, and neither is wrong alone.
 */
const D5_RE = /^[ \t]*([A-Z][A-Z0-9_]*)\s*:\s*["'`]([a-z0-9-]+)["'`]\s*,/gm;
if (fs.existsSync(FLAGS_FILE)) {
  const src = code(FLAGS_FILE);
  for (const m of src.matchAll(D5_RE)) {
    const [, key, value] = m;
    const hit = namesTier(key, value);
    if (hit) add('flag', FLAGS_FILE, m.index, key, `FLAGS.${key} = "${value}"`, { matchedToken: hit });
  }
}

/* ── D6: blueprint prompt files (the role's own contract) ──────────────────────────── */
for (const abs of allFiles) {
  const r = rel(abs);
  if (!r.endsWith('.md')) continue;
  const m = r.match(/blueprints\/([^/]+)\/prompts\/(mug|kettle|cup)(\.[a-z]+)?\.md$/);
  if (m) add('prompt', abs, 0, `${m[1]}/${m[2]}`, `role prompt for '${m[2]}' in blueprint '${m[1]}'`);
  else if (/blueprints\/(cup|mug|kettle)\//.test(r)) add('prompt', abs, 0, r, 'file inside a role-owned blueprint dir');
}

/* ── D7: UI mounts ─────────────────────────────────────────────────────────────────
   A surface counts when it DISPLAYS or OFFERS the tier: a sidebar tab id, or a
   component file named for the tier.                                                  */
const D7_TAB_RE = /["'`](mug|kettle|cup|queen|pot-health|potHealth)["'`]/g;

/**
 * OFFERS vs MERELY DISPLAYS — the split the third D7 branch could not make, and the
 * reason it red-pinned the fleet gate on a read-only badge (EI-20091394509538630).
 *
 * That branch fires on ANY quoted tier token in a .tsx whose basename matches
 * Sidebar|Tab|Rail|Nav, and then asserts the token "mounts a tier tab" — a claim about
 * the token's ROLE, made without ever looking at its position. Measured on the live
 * population, 3 of its 4 findings mount nothing:
 *   · FleetPeersRail:69 / GoalSessionsRail:56 — `agentPaneKind === 'cup' ? <span>cup</span>`
 *   · AdvEvalsTab:1305                        — `sub={… ? 'mug' : \`mug · ${age}s\`}`
 * and only LeftSidebar:159 (`{ id: 'queen', render: () => <MugTab/> }`) is the shape the
 * detector was built for.
 *
 * WHY IT MATTERS, beyond noise: the second of those two identical badge lines is what
 * froze `main` for over an hour. The first had already been absorbed into the baseline,
 * so the guard was in the state its own header warns about — noise rubber-stamped as
 * population — and the next COPY of that line then read as a novel ungated entry point.
 *
 * THE PROPERTY, stated so it survives a rename (the same discipline check-ungated's
 * role-door family states for itself): the retirement gates what can OFFER A ROUTE INTO
 * the tier. An equality test against a role token READS a value the roster already
 * returned; it cannot bring a pane into being, and refusing it would hide what a live
 * pane IS rather than gate a capability. A tab IDENTITY — an id/key/value a router or
 * tab strip can select — can. So membership keys on the token's position, never on its
 * presence.
 *
 * ⚠ These findings are still INVENTORIED, marked `display: true` rather than dropped:
 * the census's job is the census, and `check-ungated-mug-kettle.mjs` is where a finding
 * decides the gate. That is the same seam `retired` and `substrate` already use — a
 * census that stopped SEEING these would be a real loss of recall, and would also make
 * this change invisible to the comment-blindness suite's population CONTROL.
 *
 * The classifier itself lives in `scripts/lib/mug-kettle-ui-route.mjs` — not for reuse
 * (this is its only caller) but for FALSIFIABILITY: proving it still fires on a real
 * mount needs a fixture, and the only way to hand THIS script a new mount is to write one
 * into the shared tree, where git-sync can commit it before the probe finishes. `namesTier`
 * is injected so the homonym ruling above stays the single copy.
 */

/**
 * Control surfaces the plan names explicitly (D-009/D-010): the buttons that drive
 * pot/plan start-stop. Named because their filenames carry no tier token at all
 * (`PlanRail`, `AdvNowRunning`, `pot-control`) — a token scan alone would miss them,
 * which is the false-negative direction.
 */
// `pot-control` is ANCHORED ($) because this regex substring-matches a basename:
// unanchored it also swallows `pot-control-policy.ts`, which is a placement-threshold
// config store in operator-core, not a start-stop button (and would be mislabelled `ui`).
// Keep this branch anchored, and re-key it whenever the module is renamed — when P-064
// renamed hive-control-policy.ts -> pot-control-policy.ts while this regex still read
// `hive-control`, the file silently fell OUT of the census and the next baseline re-seed
// recorded that loss as normal. (WI-37687)
// Split by INTENT so a guard can tell a broken literal from a deliberately-absent one
// (EI-20059308594618912). Before the split these were one alternation, and "this literal
// matches nothing" was ambiguous: it meant EITHER the census had gone blind to a rename
// (the hive-control bug above) OR the surface is retired and absent on purpose. Those need
// opposite responses, so the distinction is declared here rather than guessed by the reader.
//
// LIVE: these name surfaces that exist today. A literal here matching NOTHING is a BUG —
// the census has stopped seeing a file that still exists under a new name.
const LIVE_CONTROL_SURFACES = [
  'PotHealthPane', 'PlanRail', 'MugTab', 'AdvNowRunning', 'pot-control$',
];
// TRIPWIRES: retired surfaces that must NOT exist. A literal here matching nothing is the
// DESIRED state — it is armed to fire if the surface ever reappears. Do not "fix" one by
// deleting it; that disarms the tripwire.
// `LocalPotsControl` moved LIVE -> TRIPWIRE on 2026-08-10 (P-077): the per-pot
// start/stop control was deleted once both its mounts were gone (adv/PotsRunningPill
// by P-075, left-sidebar/PotsTab by P-077), so it is now a surface that must NOT
// come back. Moving it rather than dropping it is the whole point of the split
// above — deleting the literal would silently disarm the tripwire.
const RETIRED_SURFACE_TRIPWIRES = ['KettleTab', 'LocalPotsControl'];
// Same alternatives as the single regex this replaces. `KettleTab` moves to the END of the
// alternation, which cannot change behaviour here: the only use is `.test(base)`, a boolean,
// and no caller reads a capture group — alternation order decides WHICH branch matched, never
// WHETHER one did. (Verified after the split: the census reports the same 6 named-control
// entries and `check-ungated-mug-kettle.mjs` still exits 0.)
const NAMED_CONTROL_SURFACES = new RegExp(
  `(${[...LIVE_CONTROL_SURFACES, ...RETIRED_SURFACE_TRIPWIRES].join('|')})`,
);

const seenSubstrateUi = new Set();
for (const abs of allFiles) {
  const r = rel(abs);
  if (!/\.tsx?$/.test(r) || isTestFile(r)) continue;
  const base = path.basename(r, path.extname(r));
  const src = code(abs);
  const tabHits = [...src.matchAll(D7_TAB_RE)];

  if (NAMED_CONTROL_SURFACES.test(base)) {
    add('ui', abs, 0, base, 'named control surface for pot/plan start-stop (plan D-009/D-010)');
  } else if (/\.tsx$/.test(r) && namesTier(base)) {
    if (SUBSTRATE_UI.has(base)) seenSubstrateUi.add(base);
    add('ui', abs, 0, base, 'component file named for the retiring tier',
      { matchedToken: namesTier(base), tabTokens: tabHits.length,
        ...(SUBSTRATE_UI.has(base)
          ? { substrate: true, why: `${SUBSTRATE_UI.get(base)} — inventory, do NOT gate` }
          : {}) });
  } else if (/\.tsx$/.test(r) && tabHits.length > 0 && /(LeftSidebar|Sidebar|Tab|Rail|Nav)/.test(base)) {
    const tokens = [...new Set(tabHits.map((h) => h[1]))].join(', ');
    const offers = offersTierRoute(src, namesTier);
    if (offers) {
      add('ui', abs, tabHits[0].index, base, `mounts tier tab token(s): ${tokens} — ${offers}`);
    } else {
      add('ui', abs, tabHits[0].index, base,
        `displays tier token(s): ${tokens} — no tab identity declared and no tier component ` +
        'mounted, so this READS a value the roster already returned rather than offering a ' +
        'route into the tier (see D7_DECL_RE)',
        { display: true });
    }
  }
}

const danglingSubstrateUi = [...SUBSTRATE_UI.keys()].filter(
  (base) => !seenSubstrateUi.has(base),
);
if (danglingSubstrateUi.length > 0) {
  throw new Error(
    'mug-kettle-surface-census: SUBSTRATE_UI contains basenames that no current non-test ' +
      `.tsx finding resolves: ${danglingSubstrateUi.join(', ')}. Reclassify a deliberate ` +
      'rename/deletion; do not leave a dead exemption that looks protective.',
  );
}

/* ── D8: wake / watchdog arming ────────────────────────────────────────────────────
   The engine: anything that ARMS or FIRES a pot/overwatch wake keeps the tier alive
   even with the UI gone. This is the dead-man's-switch surface P-007 must gate.       */
const D8_FNS = [
  'declarePotTimeWake', 'recordPotWake', 'readPotWakeState', 'withinWakeFloor',
  'effectivePotWakeFloorSec', 'wakeMug', 'resolveMugOwner', 'claimWatchdogFire',
  'getPotStarted', 'setPotStarted', 'listStartedPots', 'getOverwatchStarted',
  'setOverwatchStarted',
  // shared substrate (D-003 population (b)) — detected so the retirement can SEE them
  'resolvePotHomeSlug', 'recentWatchdogFires', 'recordFire',
];
const danglingSubstrateSymbols = findDanglingSubstrateSymbols(SUBSTRATE_SYMBOLS, D8_FNS);
if (danglingSubstrateSymbols.length > 0) {
  throw new Error(
    'mug-kettle-surface-census: SUBSTRATE_SYMBOLS contains names outside the wake/function detector vocabulary; ' +
      `the entries are no-ops: ${danglingSubstrateSymbols.join(', ')}`,
  );
}
let d8Rejected = 0;
for (const abs of codeFiles) {
  const src = code(abs);
  for (const fn of D8_FNS) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    for (const m of src.matchAll(re)) {
      const prov = symbolIsFromTier(abs, fn);
      if (!prov.ok) { d8Rejected++; break; } // same name, different subsystem — not ours
      add('wake', abs, m.index, fn, `calls ${fn}() [from ${prov.source}]`,
        SUBSTRATE_SYMBOLS.has(fn)
          ? { substrate: true, why: 'D-003 population (b): the su system itself depends on this — inventory, do NOT gate' }
          : {});
      break; // one finding per fn per file — the file is the unit of work
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════
   REPORT
   ══════════════════════════════════════════════════════════════════════════════════ */

const live = findings.filter((f) => !f.retired);
const retiredAlready = findings.filter((f) => f.retired);

const byCategory = {};
for (const f of live) (byCategory[f.category] ??= []).push(f);

const byFile = {};
for (const f of live) (byFile[f.file] ??= []).push(f.category);

const census = {
  generatedAt: new Date().toISOString(),
  plan: 'retire-mug-kettle-su-only-2026-08-09',
  item: 'P-005',
  scanned: { roots: SCAN_ROOTS, codeFiles: codeFiles.length, constantsResolved: constants.size },
  totals: {
    live: live.length,
    alreadyRetired: retiredAlready.length,
    distinctLiveFiles: Object.keys(byFile).length,
    /**
     * Findings on shared pot substrate the SU system itself runs on (D-003 population
     * (b)). These are INVENTORY, not retirement targets — gating them breaks loop:arm.
     */
    sharedSubstrate: live.filter((f) => f.substrate).length,
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
  },
  coverage: {
    status: unresolved.length === 0 ? 'complete' : 'partial',
    unresolvedCount: unresolved.length,
    unresolved,
    /**
     * Doors whose argument is runtime-determined but whose resolution SOURCE is named.
     * They do NOT hold coverage below `complete` — "I know exactly where this is decided,
     * and it is decided at runtime" is a finished answer, unlike `unresolved`. They are
     * still listed on every read: a dynamic door can launch a tier blueprint, so an empty
     * category next to a non-empty `dynamic` list is not proof of absence.
     */
    dynamicCount: dynamicSites.length,
    dynamic: dynamicSites,
    systemActionSitesSeen: d1Sites,
    detectorShapes: {
      'system-action': "registerSystemAction(<literal|CONST>, …) — identifier args resolved via the constant table",
      'spawn-role': "role|childRole|child_role|parent_role [:=] 'mug'|'kettle'|'cup' (incl. inside SQL template strings)",
      'blueprint-launch': 'fireLaunchBlueprint(<CONST>) where CONST ∈ {POT_BLUEPRINT_ID, OVERWATCH_BLUEPRINT_ID} — classified by NAME, not value',
      tool: "name: '<pot|cup|kettle|overwatch|mug>:<verb>' tool registrations",
      flag: 'FLAGS entries in libs/flags/src/types.ts whose KEY or VALUE names the tier',
      prompt: 'blueprints/**/prompts/(mug|kettle|cup).md and files under a role-owned blueprint dir',
      ui: '.tsx named for the tier, or a sidebar/rail/tab file mounting a tier tab token',
      wake: `call sites of ${D8_FNS.length} wake/started-bit functions (one finding per function per file)`,
    },
    notCovered: [
      'live routine rows (harness_shared.routines) — query separately, see --sql',
      'dynamic dispatch through a variable action name not in the constant table',
      'prompt/doc prose mentioning the tier without offering it (deliberately excluded — prose is not an entry point)',
    ],
    readingRule:
      'An empty category is meaningful ONLY when coverage.status === "complete" AND `dynamic` is empty for that category. Read BOTH before concluding a surface is absent — a dynamic door decides its target at runtime, so it can launch a tier blueprint without ever naming one in source. This reports "none found", never "none exists".',
  },
  findings: live,
  alreadyRetired: retiredAlready,
};

const ROUTINE_SQL = `-- live routine rows for the retiring tier (run with dev:pg_query)
SELECT target_role, install_slug, active, last_fired_at, interval_sec
  FROM harness_shared.routines
 WHERE workspace_id = 'papercusp-workspace'
   AND (target_role ~* '(pot|mug|kettle|cup|hive|overwatch|queen|bee|placement|nursery)')
 ORDER BY active DESC, last_fired_at DESC NULLS LAST;`;

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const outIdx = args.indexOf('--out');
const catIdx = args.indexOf('--category');
const catFilter = catIdx >= 0 ? args[catIdx + 1] : null;

if (args.includes('--sql')) { console.log(ROUTINE_SQL); process.exit(0); }

if (outIdx >= 0) {
  const dest = path.resolve(args[outIdx + 1]);
  fs.writeFileSync(dest, JSON.stringify(census, null, 2));
  console.log(`census written to ${dest} (${live.length} live entry points)`);
  process.exit(0);
}

/* Write stdout SYNCHRONOUSLY, then exit.
 *
 * `console.log(big); process.exit(0)` silently TRUNCATES at exactly one 64 KiB
 * pipe buffer: writes to a pipe are async in Node, and process.exit() does not
 * drain them. It survives a `> file` redirect (file writes are sync), so the
 * bug is invisible until someone PIPES the output — `--json | jq`, `| python3`
 * — and it only began firing when the census grew past 64 KiB (it is ~72 KiB
 * now). The failure mode is a partial census that parses as "fewer findings",
 * i.e. a FALSE CLEAN, not a loud error.
 *
 * writeSync on a non-blocking pipe can also short-write, so loop until drained.
 * Measured 2026-08-10: pipe 65536 bytes/invalid -> 71902 bytes/valid. */
const writeStdoutSync = (s) => {
  const buf = Buffer.from(s.endsWith('\n') ? s : s + '\n');
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(1, buf, off, buf.length - off); }
    catch (err) { if (err.code === 'EAGAIN') continue; if (err.code === 'EPIPE') break; throw err; }
  }
};

if (wantJson) { writeStdoutSync(JSON.stringify(census, null, 2)); process.exit(0); }

/* ── printed table ─────────────────────────────────────────────────────────────── */
const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log('MUG / KETTLE / CUP SURFACE CENSUS   ' + census.generatedAt);
console.log('plan retire-mug-kettle-su-only-2026-08-09 · P-005');
console.log('─'.repeat(100));
console.log(`scanned ${census.scanned.codeFiles} code files · resolved ${census.scanned.constantsResolved} constants`);
console.log(`LIVE entry points: ${live.length} across ${census.totals.distinctLiveFiles} files` +
  (retiredAlready.length ? `  (+${retiredAlready.length} already under _retired/)` : ''));
if (census.totals.sharedSubstrate) {
  console.log(`  of which ${census.totals.sharedSubstrate} are SHARED SUBSTRATE (D-003 (b)) — the su system runs on these; inventory, do NOT gate`);
}
console.log('');
console.log(pad('CATEGORY', 20) + pad('COUNT', 8) + 'SUBJECTS');
console.log('─'.repeat(100));
for (const [cat, list] of Object.entries(byCategory).sort((a, b) => b[1].length - a[1].length)) {
  const subjects = [...new Set(list.map((f) => f.subject))];
  const shown = subjects.slice(0, 6).join(', ');
  console.log(pad(cat, 20) + pad(list.length, 8) + shown + (subjects.length > 6 ? `, …+${subjects.length - 6}` : ''));
}
console.log('');

if (catFilter) {
  console.log(`── ${catFilter} — every site ──`);
  for (const f of (byCategory[catFilter] ?? [])) {
    console.log(`  ${pad(f.subject, 34)} ${f.file}:${f.line}`);
  }
  console.log('');
}

console.log(`COVERAGE: ${census.coverage.status.toUpperCase()}  (${unresolved.length} unresolved site(s))`);
if (unresolved.length) {
  for (const u of unresolved.slice(0, 12)) console.log(`  ? ${u.category}  ${u.file}:${u.line}  arg=${u.arg}`);
  if (unresolved.length > 12) console.log(`  …+${unresolved.length - 12} more`);
}
if (dynamicSites.length) {
  console.log(`\nDYNAMIC doors (${dynamicSites.length}) — resolution source known, target decided at RUNTIME.`);
  console.log('  These do not hold coverage below complete, but a category is not "absent" while one is listed here.');
  for (const d of dynamicSites) {
    console.log(`  ~ ${d.category}  ${d.file}:${d.line}  ${d.arg} ← ${d.resolvedBy}`);
  }
}
console.log('');
console.log('NOT COVERED by this scan (query separately):');
for (const n of census.coverage.notCovered) console.log(`  · ${n}`);
console.log('');
console.log(census.coverage.readingRule);
console.log('');
console.log('Live routine rows are NOT scanned from source — run:  node scripts/mug-kettle-surface-census.mjs --sql');
console.log('');
