#!/usr/bin/env node
/**
 * check-no-ungated-infinite-animation.mjs — fail-loud guard against re-growing the
 * always-on CSS animation class removed by WI-6530 / WI-6542.
 *
 * WHY THIS EXISTS (measured, not theoretical). An `infinite` CSS animation on a
 * selector that matches as soon as the element renders — no `:hover`, no state
 * class, no `[data-…=]` — keeps the whole 60fps rendering loop alive forever. In
 * this webview there is no GPU compositing (`GDK_BACKEND=x11`), so every frame
 * repaints a heavy translucent page. Measured on an agent Tauri shell at 1280x800:
 *
 *     /marketplace  (0 always-on animations)  ~18% of a core idle
 *     /settings     (2 always-on animations) ~101% of a core idle
 *     /support      (8 always-on animations) ~104% of a core idle
 *     /settings/voice (34 always-on anims)   ~106% of a core idle
 *
 * The cost is NOT per-animation — 2 costs the same as 34, because the expense is
 * the running loop, not the tween. Two consequences worth internalising:
 *   1. ONE reintroduced always-on animation re-arms the entire tax for that screen.
 *   2. A partial fix measures identically to no fix, which is exactly why this
 *      class grew to 107 declarations without anyone noticing a regression.
 *
 * WHAT IS ALLOWED. Motion tied to a state the user caused or a transient the app
 * is showing is fine — it stops when the state does. A selector qualifies as
 * GATED when it carries an interaction pseudo-class, a state/modifier class, or a
 * state attribute (see GATE_PATTERNS), or when the animated thing is a recognised
 * transient (spinners, skeletons, loading and route-transition overlays).
 *
 * OWNER RULING for this class [owner 2026-07-27, chosen from 4 options]:
 * "drop always-on animation, keep the look" — keep the element and its resting
 * appearance, remove the infinite loop. A sheen that is `opacity: 0` at both ends
 * of its cycle can simply go; a state indicator keeps a static form of its
 * mid-cycle look. Note the REJECTED alternatives, so they are not re-proposed:
 * defaulting `data-visual-effects` to 'minimal' (removes elements, not just
 * motion), making the motion event-driven, and leaving it alone.
 *
 *   node scripts/check-no-ungated-infinite-animation.mjs
 *   node scripts/check-no-ungated-infinite-animation.mjs --report   # list, exit 0
 *
 * The detection predicate (`isUngatedInfiniteAnimation`) and `findOffenders()` are
 * exported and unit-tested (apps/operator/app/_lints/no-ungated-infinite-animation.test.ts)
 * so BOTH directions are durably verified: green on the real tree at its current
 * baseline (no false positive) AND red on synthetic re-introductions (no false
 * negative).
 *
 * BASELINE, and why it is SHRINK-ONLY. The remaining entries in BASELINE are
 * always-on declarations on surfaces that measured 0 live animations when this
 * guard landed — they are latent, not free: they cost a full core the moment their
 * element renders. The count may only go DOWN. Fixing one means deleting its line
 * here; that is the intended direction of travel, and a new offender outside the
 * baseline fails the build.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

/** Directories scanned for stylesheets. */
const SCAN_DIRS = ['apps/operator/app', 'apps/operator-vite/src', 'libs/papercusp-shared'];

/**
 * A selector containing any of these is considered GATED: the animation only runs
 * while a user-caused interaction or an app state is active, so it terminates.
 */
export const GATE_PATTERNS = [
  /:hover\b/,
  /:focus\b/,
  /:focus-visible\b/,
  /:focus-within\b/,
  /:active\b/,
  /:checked\b/,
  /\[data-[^\]]*=/, //  [data-state="open"], [data-route-pending="true"], …
  /\[aria-[^\]]*=/,
  /\.is-[a-z]/i, //  .is-settled, .is-dirty, .is-scanning
  /\.has-[a-z]/i, //  .has-unread
  /--(?:loading|running|pending|active|busy|live|scanning|success|speaking|listening|thinking|recording|streaming|connecting)\b/,
  /\.(?:loading|running|pending|active|busy|live|installed|clean|ok|success|selected|open|streaming)\b/,
];

/**
 * Transient surfaces: the element itself only exists while the app is busy or
 * mid-navigation, so its animation is bounded by that lifetime rather than always-on.
 */
export const TRANSIENT_PATTERNS = [
  /spinner/i,
  /[_.-]spin\b/i, //  .chat-panel__spin, .op-note-spin
  /skeleton/i,
  /thinking/i,
  /route-loading/i,
  /route-transition/i,
  /progress/i,
  /cursor/i, //  a text caret blinks only while the field is live
  /caret/i,
  /streaming/i,
];

/**
 * One always-on animation declaration, located within a single stylesheet.
 *
 * @typedef {object} CssOffender
 * @property {number} line - 1-indexed line of the declaration.
 * @property {string} selector - The rule the declaration belongs to.
 * @property {string} declaration - The offending declaration text.
 */

/**
 * A {@link CssOffender} resolved against the repo, so it can be reported and baselined.
 *
 * @typedef {CssOffender & { file: string; key: string }} TreeOffender
 */

/**
 * True when `selector` is one this guard permits to carry an `infinite` animation —
 * either because motion is tied to an interaction/state that ends, or because the
 * element itself is a transient (spinner, skeleton, route overlay).
 *
 * @param {string} selector
 * @returns {boolean}
 */
export function isGatedSelector(selector) {
  return (
    GATE_PATTERNS.some((re) => re.test(selector)) || TRANSIENT_PATTERNS.some((re) => re.test(selector))
  );
}

/**
 * True when `declaration` starts an infinite animation. Matches the `animation`
 * shorthand and `animation-iteration-count`. A bare mention of the word (in a
 * comment, say) is not a declaration and does not match.
 *
 * @param {string} declaration
 * @returns {boolean}
 */
export function isInfiniteAnimationDeclaration(declaration) {
  if (!/(^|[;{\s])animation(-iteration-count)?\s*:/.test(declaration)) return false;
  return /\binfinite\b/.test(declaration);
}

/**
 * The guard's core predicate, exported so the unit test can drive it directly.
 *
 * @param {string} selector
 * @param {string} declaration
 * @returns {boolean}
 */
export function isUngatedInfiniteAnimation(selector, declaration) {
  return isInfiniteAnimationDeclaration(declaration) && !isGatedSelector(selector);
}

/**
 * Walk a stylesheet tracking brace depth so each declaration can be attributed to
 * the rule that encloses it. A gate on ANY ancestor counts, so nesting a sheen
 * inside `.shell:hover { … }` is correctly treated as gated.
 *
 * @param {string} source - Full text of one stylesheet.
 * @returns {CssOffender[]}
 */
export function findOffendersInCss(source) {
  const lines = source.split('\n');
  const stack = [];
  let pending = '';
  const offenders = [];

  for (let i = 0; i < lines.length; i++) {
    const withoutComments = lines[i].replace(/\/\*.*?\*\//g, '');
    const stripped = withoutComments.replace(/\/\*[\s\S]*$/, '');

    if (isInfiniteAnimationDeclaration(stripped)) {
      // A single-line rule (`.foo { animation: x 1s infinite; }`) opens its own
      // selector on this very line, so it is not on the stack yet — recover it from
      // the text before the brace rather than reporting `(unknown)`.
      const openedHere = stripped.indexOf('{');
      const declAt = stripped.search(/animation(-iteration-count)?\s*:/);
      const inlineSelector =
        openedHere !== -1 && openedHere < declAt
          ? (pending + ' ' + stripped.slice(0, openedHere)).trim().replace(/\s+/g, ' ')
          : '';
      const selector = inlineSelector || (stack.length ? stack[stack.length - 1] : '');
      const scope = stack.join(' ') + ' ' + inlineSelector;
      const inKeyframes = stack.some((s) => /@(-webkit-)?keyframes/.test(s));
      if (!inKeyframes && selector && !isGatedSelector(scope)) {
        offenders.push({ line: i + 1, selector, declaration: stripped.trim() });
      }
    }

    let segment = '';
    for (const ch of stripped) {
      if (ch === '{') {
        stack.push((pending + ' ' + segment).trim().replace(/\s+/g, ' '));
        pending = '';
        segment = '';
      } else if (ch === '}') {
        stack.pop();
        pending = '';
        segment = '';
      } else {
        segment += ch;
      }
    }
    if (segment.trim() && !segment.includes(';') && !segment.includes(':')) pending += ' ' + segment;
    else if (segment.includes(';')) pending = '';
  }
  return offenders;
}

/**
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '_retired' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/**
 * Scan the tree and return every ungated infinite animation as `path:line` records.
 *
 * @param {string} [root] - Repo root to scan; defaults to this repo.
 * @returns {TreeOffender[]}
 */
export function findOffenders(root = ROOT) {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file);
      for (const o of findOffendersInCss(readFileSync(file, 'utf8'))) {
        offenders.push({ ...o, file: rel, key: `${rel}:${o.line}` });
      }
    }
  }
  return offenders;
}

/**
 * Path of the SHRINK-ONLY baseline: always-on declarations that predate the guard
 * and sit on surfaces measuring 0 live animations today. Latent, not free — delete
 * an entry when you fix it. Keyed by SELECTOR TEXT rather than line number, so
 * unrelated edits elsewhere in globals.css do not churn it.
 */
export const BASELINE_PATH = join(ROOT, 'scripts/no-ungated-infinite-animation.baseline.json');

/**
 * Read the baselined selector set. Throws if the baseline file is missing.
 *
 * @param {string} [path]
 * @returns {Set<string>}
 */
export function readBaseline(path = BASELINE_PATH) {
  return new Set(JSON.parse(readFileSync(path, 'utf8')).selectors);
}

function main() {
  const report = process.argv.includes('--report');
  const offenders = findOffenders();

  if (report) {
    console.log(`ungated infinite animations: ${offenders.length}`);
    for (const o of offenders) console.log(`  ${o.file}:${o.line}  ${o.selector.slice(0, 100)}`);
    process.exit(0);
  }

  let baseline;
  try {
    baseline = readBaseline();
  } catch {
    console.error(`missing or unreadable baseline file: ${relative(ROOT, BASELINE_PATH)}`);
    process.exit(1);
  }

  const added = offenders.filter((o) => !baseline.has(o.selector));
  if (added.length) {
    console.error('\nlint:no-ungated-infinite-animation FAILED — new always-on CSS animation(s):\n');
    for (const o of added) {
      console.error(`  ${o.file}:${o.line}`);
      console.error(`    selector:    ${o.selector.slice(0, 140)}`);
      console.error(`    declaration: ${o.declaration.slice(0, 140)}`);
    }
    console.error(
      '\nAn ungated `infinite` animation keeps the 60fps repaint loop alive forever —\n' +
        'measured at ~100% of a core vs ~18% with none, and ONE is enough to re-arm the\n' +
        'full cost for that screen. Options, in the owner-ratified order:\n' +
        '  1. Drop the loop and keep the resting look (a background-position drift rests\n' +
        '     at its `from` frame; an opacity:0-at-both-ends sheen can simply go).\n' +
        '  2. Gate it behind the interaction or state that should drive it\n' +
        '     (:hover / .is-* / [data-state=…]) so it stops when that state does.\n' +
        'See WI-6542 and scripts/check-no-ungated-infinite-animation.mjs for the method.\n',
    );
    process.exit(1);
  }

  const fixed = [...baseline].filter((sel) => !offenders.some((o) => o.selector === sel));
  console.log(
    `lint:no-ungated-infinite-animation OK — ${offenders.length} baselined always-on animation(s)` +
      (fixed.length ? `, ${fixed.length} fixed since the baseline (shrink it: --report)` : ''),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
