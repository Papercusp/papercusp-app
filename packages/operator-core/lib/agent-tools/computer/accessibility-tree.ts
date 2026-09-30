/**
 * accessibility-tree.ts — the pure AT-SPI observation path that sits BESIDE the
 * screenshot path (agent-virtual-desktops-2026-08-23 P-007; D-010).
 *
 * WHY THIS EXISTS. A computer-use loop pays for its eyes on EVERY step. D-006 cut
 * the per-observation image bill by capturing at 1024-wide instead of native
 * (1920x1080 -> 1024x576, 2,765 -> 786 tokens), but 786 tokens is the FLOOR for a
 * screenshot: the model is billed by area, so a screen with three buttons on it
 * costs exactly what a dense IDE costs. An accessibility tree is billed by CONTENT
 * instead — a simple dialog is a few dozen tokens — and it is the only observation
 * of the two that carries the semantics the model actually wants (which node is a
 * button, what it is called, whether it is focused, what the entry contains).
 *
 * THIS IS NOT A REPLACEMENT FOR THE SCREENSHOT and must never be sold as one. It
 * sees only what the toolkit EXPORTS: a GTK/Qt/Electron app publishes a rich tree,
 * a canvas-drawn app or a video publishes an empty box, and `xterm` — which is a
 * plain X11 client with no ATK bridge — publishes NOTHING AT ALL (measured on the
 * box 2026-08-23: a live 484x316 xterm window is entirely absent from the a11y
 * desktop). So an empty tree is genuinely ambiguous between "nothing is running"
 * and "this app is invisible to accessibility", which is precisely why `observe`
 * reports the app census it walked rather than just the tree: the caller can see
 * that it found zero applications and fall back to a screenshot.
 *
 * MECHANICS. AT-SPI2 exposes the tree over a per-session D-Bus. The bus address is
 * advertised on the X ROOT WINDOW as the `AT_SPI_BUS` property, which is what makes
 * this work per-display in a fleet of sandbox desktops: binding `DISPLAY` to the
 * sandbox is sufficient to reach that sandbox's OWN a11y bus and no other's
 * (measured: `AT_SPI_BUS(STRING) = "unix:path=/run/user/1000/at-spi/bus_114"` on
 * display :114). The walker is a `gjs` one-liner passed on argv — deliberately NOT
 * a checked-in `.js` asset, because operator-core is bundled and a runtime asset
 * path is one more thing that can be wrong in a release checkout that is right in
 * the source tree.
 *
 * This module is FRAMEWORK-INDEPENDENT and PURE by the same discipline as
 * `desktop-driver.ts`: no MCP imports, no process spawning. Every transformation
 * below unit-tests against a fixture with no live display.
 */

import { sandboxXEnv } from './desktop-driver';

/** Debian/Ubuntu packages a desktop needs before ANY accessibility observation works. */
export const A11Y_APT_PACKAGES: readonly string[] = Object.freeze(['at-spi2-core', 'gjs']);

/**
 * Env that turns the accessibility bridge ON for a launched app.
 *
 * `GTK_A11Y=atspi` is the GTK4 selector; `GTK_MODULES=gail:atk-bridge` is the GTK3
 * one; `NO_AT_BRIDGE=0` un-does the opt-out some images set; `QT_ACCESSIBILITY=1`
 * covers Qt. They are additive and harmless where they do not apply, which is why
 * this is one constant rather than a per-toolkit branch the provisioner would have
 * to guess at before it knows what the app is.
 */
export const A11Y_APP_ENV: Readonly<Record<string, string>> = Object.freeze({
  GTK_A11Y: 'atspi',
  GTK_MODULES: 'gail:atk-bridge',
  NO_AT_BRIDGE: '0',
  QT_ACCESSIBILITY: '1',
});

/**
 * The sentinel the walker prefixes its ONE result line with.
 *
 * Load-bearing, not decoration: a headless GTK app floods stdout/stderr with
 * `libEGL warning`, `GLib-GIO-CRITICAL` and xdg-desktop-portal chatter (measured:
 * ~120 lines of it around a 3-line result). Scanning for a sentinel is what makes
 * the parse robust to noise that is guaranteed to be there.
 */
export const ATSPI_SENTINEL = '@@ATSPI@@';

/**
 * The walker, as a gjs program. Walks the a11y desktop and prints ONE sentinel line
 * of JSON. Keys are single letters because this is an internal wire format between
 * two halves of the same feature and every byte crosses a pipe on every observation.
 *
 * Everything is individually try/caught: a node can vanish mid-walk (the app is
 * live and repainting), and losing one node's name must degrade that node, never
 * abort the observation.
 */
export const ATSPI_WALKER_JS = `
imports.gi.versions.Atspi = '2.0';
const { Atspi } = imports.gi;
const MAX_NODES = ${5000};
const MAX_DEPTH = ${16};
const init = Atspi.init();
const out = [];
let truncated = false;
function states(n) {
  const s = [];
  try {
    const set = n.get_state_set();
    const M = [['showing', Atspi.StateType.SHOWING], ['visible', Atspi.StateType.VISIBLE],
               ['focused', Atspi.StateType.FOCUSED], ['focusable', Atspi.StateType.FOCUSABLE],
               ['enabled', Atspi.StateType.ENABLED], ['sensitive', Atspi.StateType.SENSITIVE],
               ['checked', Atspi.StateType.CHECKED],
               ['selected', Atspi.StateType.SELECTED], ['expanded', Atspi.StateType.EXPANDED],
               ['editable', Atspi.StateType.EDITABLE]];
    for (let i = 0; i < M.length; i++) if (set.contains(M[i][1])) s.push(M[i][0]);
  } catch (e) {}
  return s;
}
function extents(n, type) {
  try { const r = n.get_extents(type); return [r.x, r.y, r.width, r.height]; }
  catch (e) { return null; }
}
function actions(n) {
  const a = [];
  try { const c = n.get_n_actions(); for (let i = 0; i < c && i < 6; i++) a.push(n.get_action_name(i)); }
  catch (e) {}
  return a;
}
function value(n) {
  try {
    const t = n.get_text_iface();
    if (!t) return '';
    const len = t.get_character_count();
    if (!len) return '';
    var s = t.get_text(0, Math.min(len, 200));
    // MEASURED (WI-40906): on a GTK label this returns an OBJECT, not a string, and it
    // serialises as an empty JSON object -- which reaches the consumer as a value that
    // is not null and explodes on .trim(). Coerce at the source; the parse boundary
    // guards the same class again for whatever the next toolkit returns.
    // (No backticks in this comment: the whole program is a template literal.)
    return typeof s === 'string' ? s : '';
  } catch (e) { return ''; }
}
function walk(n, path, depth) {
  if (depth > MAX_DEPTH || out.length >= MAX_NODES) { truncated = true; return; }
  let name = '', role = '?';
  try { name = n.get_name() || ''; } catch (e) {}
  try { role = n.get_role_name() || '?'; } catch (e) {}
  out.push({ p: path, r: role, n: name, s: states(n), e: extents(n, Atspi.CoordType.SCREEN),
             w: extents(n, Atspi.CoordType.WINDOW), a: actions(n), v: value(n) });
  let count = 0;
  try { count = n.get_child_count(); } catch (e) { return; }
  for (let i = 0; i < count; i++) {
    let c = null;
    try { c = n.get_child_at_index(i); } catch (e) { continue; }
    if (c) walk(c, path + '/' + i, depth + 1);
  }
}
let apps = 0;
try {
  const desktop = Atspi.get_desktop(0);
  apps = desktop.get_child_count();
  for (let i = 0; i < apps; i++) {
    const app = desktop.get_child_at_index(i);
    if (app) walk(app, String(i), 0);
  }
} catch (e) {
  print('${ATSPI_SENTINEL}' + JSON.stringify({ ok: false, error: String(e), init, apps: 0, nodes: [] }));
  imports.system.exit(0);
}
print('${ATSPI_SENTINEL}' + JSON.stringify({ ok: true, init, apps, truncated, nodes: out }));
`;

/**
 * The ACT program: resolve a `#ref` and fire its activating action.
 *
 * 🚨 WHY ACTIVATION AND NOT A PIXEL CLICK — measured, and it inverts the obvious design.
 * The natural implementation of "click this element" is to read its on-screen box and
 * drive `xdotool` to the centre. That is unusable on the toolkit P-007 is required to
 * verify against. Measured on GTK 4.14.5 (2026-08-23), for zenity's Cancel button:
 *
 *     SCREEN = (0,0 162x44)      <- x,y are ZERO, and are zero for EVERY node
 *     WINDOW = (14,231 162x44)   <- correct, but relative to the toplevel
 *
 * Every element in the dialog reports the same (0,0) origin with a different size, so
 * a centre computed from SCREEN extents sends every click to roughly the same wrong
 * place — while the screenshot still looks right, which makes it present as the model
 * misreading the screen rather than as a coordinate bug.
 *
 * `do_action` has no such dependency: it is a semantic invocation across the a11y bus.
 * Verified end-to-end the same day — firing `click` on Cancel returned true and the
 * dialog actually closed (the walk went from 1 application to 0).
 *
 * It is ALSO the more capable primitive: it activates an element that is scrolled out
 * of view or overlapped, which a pixel click structurally cannot do.
 */
export const ATSPI_ACTION_JS = `
imports.gi.versions.Atspi = '2.0';
const { Atspi } = imports.gi;
Atspi.init();
const wanted = ARGV[0] || '';
const preferred = (ARGV[1] || '').trim();
function emit(o) { print('${ATSPI_SENTINEL}' + JSON.stringify(o)); imports.system.exit(0); }
if (!wanted) emit({ ok: false, error: 'no ref' });
let node = null;
try {
  const parts = wanted.split('/');
  node = Atspi.get_desktop(0).get_child_at_index(parseInt(parts[0], 10));
  for (let i = 1; i < parts.length; i++) node = node.get_child_at_index(parseInt(parts[i], 10));
} catch (e) { emit({ ok: false, error: 'ref ' + wanted + ' does not resolve: ' + e }); }
if (!node) emit({ ok: false, error: 'ref ' + wanted + ' does not resolve' });
let role = '?', name = '';
try { role = node.get_role_name(); } catch (e) {}
try { name = node.get_name() || ''; } catch (e) {}
const names = [];
try { const c = node.get_n_actions(); for (let i = 0; i < c; i++) names.push(node.get_action_name(i)); }
catch (e) { emit({ ok: false, role, name, actions: [], error: 'element exposes no Action interface' }); }
if (names.length === 0) emit({ ok: false, role, name, actions: [], error: 'element exposes no actions' });
let index = 0;
if (preferred) {
  index = names.indexOf(preferred);
  if (index < 0) emit({ ok: false, role, name, actions: names, error: 'no action named ' + preferred });
}
let result = false;
try { result = node.do_action(index); }
catch (e) { emit({ ok: false, role, name, actions: names, error: String(e) }); }
emit({ ok: result === true, role, name, actions: names, performed: names[index], result });
`;

export interface A11yActionResult {
  ok: boolean;
  role?: string;
  name?: string;
  actions?: string[];
  performed?: string;
  result?: boolean;
  error?: string;
}

/**
 * The invocation that activates one element. Same two rails as `walkerCommand`:
 * sandbox-only display, explicitly pinned a11y bus.
 */
export function actionCommand(
  display: string,
  busAddress: string,
  ref: string,
  action?: string,
): { bin: string; args: string[]; env: Record<string, string> } {
  const cleanRef = (ref ?? '').trim().replace(/^#/, '');
  if (!/^\d+(\/\d+)*$/.test(cleanRef)) {
    throw new Error(
      `computer:click_element — "${ref}" is not an element ref. Refs look like #0/0/2/1 and come from ` +
        'computer:observe; call that first and pass a ref it printed.',
    );
  }
  const base = walkerCommand(display, busAddress);
  return { bin: 'gjs', args: ['-c', ATSPI_ACTION_JS, cleanRef, action ?? ''], env: base.env };
}

/** One node exactly as the walker emitted it. */
export interface RawA11yNode {
  /** Child-index path from the a11y desktop, e.g. "0/2/1". THE ref. */
  p: string;
  /** AT-SPI role name, e.g. "push button". */
  r: string;
  /** Accessible name. */
  n: string;
  /** The subset of states the walker reports. */
  s: string[];
  /** [x, y, w, h] in SCREEN (display) pixels, or null when unobtainable.
   *  ⚠ Zeroed origins on GTK4/X11 — see `screenBoundsAreTrustworthy`. */
  e: [number, number, number, number] | null;
  /** [x, y, w, h] relative to the TOPLEVEL. Correct on GTK4 where `e` is not. */
  w?: [number, number, number, number] | null;
  /** Action names exposed by the Action interface. */
  a: string[];
  /** Text content for nodes implementing the Text interface (capped at 200 chars). */
  v: string;
}

export interface A11yWalkResult {
  ok: boolean;
  /** `Atspi.init()` return code. */
  init: number;
  /** How many applications were registered on the a11y bus. */
  apps: number;
  truncated?: boolean;
  error?: string;
  nodes: RawA11yNode[];
}

/** A node after the raw list is rebuilt into a tree. */
export interface A11yNode {
  /** The stable, STATELESS reference — the child-index path. */
  ref: string;
  role: string;
  name: string;
  states: string[];
  /** [x, y, w, h] in DISPLAY-space pixels (never capture space — see `elementClickPoint`). */
  bounds: [number, number, number, number] | null;
  /** [x, y, w, h] relative to the toplevel — correct where `bounds` is zeroed. */
  windowBounds?: [number, number, number, number] | null;
  actions: string[];
  value: string;
  children: A11yNode[];
  /** Set by compression when sibling capping dropped nodes after this one. */
  omittedSiblings?: number;
}

/**
 * Find the walker's one result line among the toolkit's noise and parse it.
 *
 * Returns null when no sentinel line is present, which is a REAL and distinct
 * outcome from an empty tree: it means the walker never ran (no gjs, no a11y bus,
 * a crash) and the caller must not report "nothing on screen".
 */
/**
 * Find and parse the sentinel line both programs print. Shape validation is the
 * CALLER's, because the two programs emit different payloads on the same sentinel
 * and only the caller knows which one it asked for.
 */
function parseSentinelPayload(stdout: string): Record<string, unknown> | null {
  const lines = (stdout ?? '').split('\n');
  // Scan from the END, and take the LAST sentinel line. Both programs print theirs as
  // the final thing they do, while the toolkit's own chatter (Gtk-CRITICAL, a11y bus
  // warnings) is emitted BEFORE it, during init — so the last one is ours.
  //
  // The honest limit: anything printing a quoted sentinel AFTER us would win. Nothing
  // does, because our programs exit immediately afterwards, and preferring the last
  // line is what makes init noise harmless — which is the failure that actually occurs.
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i]!.indexOf(ATSPI_SENTINEL);
    if (at < 0) continue;
    const json = lines[i]!.slice(at + ATSPI_SENTINEL.length).trim();
    try {
      const parsed: unknown = JSON.parse(json);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseWalkerOutput(stdout: string): A11yWalkResult | null {
  const parsed = parseSentinelPayload(stdout);
  if (!parsed || !Array.isArray(parsed.nodes)) return null;
  return parsed as unknown as A11yWalkResult;
}

/**
 * Parse the ACTIVATION program's sentinel line.
 *
 * This exists because its absence was a live bug (WI-40906): the two programs share a
 * sentinel, so reaching for `parseWalkerOutput` here type-checks behind a cast and is
 * always wrong — that function REQUIRES a `nodes` array, which an action payload never
 * has, so it returned null for every successful activation and `computer:click_element`
 * reported failure unconditionally. The cast is what hid it, which is why this returns a
 * real type and no caller needs one.
 *
 * The two shapes are validated on disjoint required fields, so neither payload can be
 * mistaken for the other in either direction.
 */
export function parseA11yActionOutput(stdout: string): A11yActionResult | null {
  const parsed = parseSentinelPayload(stdout);
  if (!parsed || typeof parsed.ok !== 'boolean') return null;
  return parsed as unknown as A11yActionResult;
}

/**
 * Coerce a walker field to the string the type says it is.
 *
 * This is a PARSE BOUNDARY: the input is JSON from a separate gjs process driving a
 * C library through introspection, so a field's type is a claim, not a guarantee.
 * `?? ''` guards only null and undefined and cheerfully admits anything else —
 * which is how an empty object reached `A11yNode.value` and every later `.trim()`
 * (WI-40906). Measured: a GTK label's text interface returns an object here.
 *
 * The fix belongs at the boundary as well as at the walker, because the walker is
 * the one part of this file that runs under a toolkit we do not control and cannot
 * typecheck — the next surprising return type should be absorbed here, not crash a
 * consumer three call-frames away.
 */
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Rebuild the flat, path-ordered node list into a forest (one root per application).
 *
 * The walker emits parents before children, so a single pass with a path->node map
 * is sufficient; a node whose parent path is missing (it was truncated away) becomes
 * a root rather than being dropped, so truncation degrades the SHAPE and never the
 * CONTENT.
 */
export function buildA11yTree(nodes: readonly RawA11yNode[]): A11yNode[] {
  const byPath = new Map<string, A11yNode>();
  const roots: A11yNode[] = [];
  for (const raw of nodes) {
    // A path that is not a string cannot be a ref: the parent lookup below indexes by
    // it, so admitting one would put a node in the tree that nothing can address.
    if (typeof raw.p !== 'string') continue;
    const node: A11yNode = {
      ref: raw.p,
      role: str(raw.r, '?'),
      name: str(raw.n, ''),
      states: Array.isArray(raw.s) ? raw.s.filter((s: unknown) => typeof s === 'string') : [],
      bounds: raw.e ?? null,
      windowBounds: raw.w ?? null,
      actions: Array.isArray(raw.a) ? raw.a.filter((a: unknown) => typeof a === 'string') : [],
      value: str(raw.v, ''),
      children: [],
    };
    byPath.set(node.ref, node);
    const slash = node.ref.lastIndexOf('/');
    const parent = slash < 0 ? undefined : byPath.get(node.ref.slice(0, slash));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Roles that are pure layout scaffolding — they carry no meaning of their own. */
const SCAFFOLD_ROLES = new Set(['filler', 'panel', 'separator', 'redundant object', 'section', 'grouping']);

/**
 * Roles that CONTAIN the UI rather than being an element of it. A toplevel is
 * focusable and exports `window.close` / `default.activate`, so without this set it
 * would be reported as a clickable element — and "click the dialog" is not an action
 * a model should be offered when what it wants is a button inside the dialog.
 */
const CONTAINER_ROLES = new Set([
  'window', 'frame', 'dialog', 'alert', 'file chooser', 'application', 'panel', 'filler',
]);

/**
 * Actions that ACTIVATE an element, as opposed to merely operating on its text.
 *
 * ⚠ Exact-match against this set, NEVER `actions.length > 0`. Measured on GTK4
 * (zenity 4.x, 2026-08-23): every static `label` in a dialog exports EIGHT actions —
 * `clipboard.copy`, `clipboard.cut`, `clipboard.paste`, `selection.delete`,
 * `selection.select-all`, `link.open`, `link.copy`, `menu.popup`. A length test
 * therefore marks every caption in the UI as clickable, which both spends a `#ref`
 * on each one and invites the model to "click" text. Conversely a `dialog` exports
 * `window.close` / `default.activate`, which must not make the whole dialog a
 * clickable element either — hence exact match rather than prefix match.
 */
const ACTIVATING_ACTIONS = new Set([
  'click', 'press', 'activate', 'toggle', 'jump', 'expand', 'collapse', 'select', 'open',
]);

/**
 * Roles a model would plausibly ACT on. Used for two things: deciding which nodes
 * keep their ref in the rendering, and refusing to compress away something clickable.
 *
 * Kept as a role test alongside the action test because `actions` is unreliable in
 * BOTH directions across toolkits: GTK3 exports a focusable, obviously-clickable
 * button with an EMPTY action list, while GTK4 exports eight actions on a static
 * label. Neither signal alone is sufficient.
 */
const INTERACTIVE_ROLES = new Set([
  'push button', 'button', 'toggle button', 'check box', 'radio button', 'link',
  'menu item', 'check menu item', 'radio menu item', 'menu', 'combo box', 'list item',
  'entry', 'text', 'password text', 'spin button', 'slider', 'page tab', 'tree item',
  'table cell', 'color chooser', 'calendar', 'switch',
]);

export function isInteractive(node: A11yNode): boolean {
  if (node.states.includes('editable')) return true;
  if (node.actions.some((a) => ACTIVATING_ACTIONS.has(a))) return true;
  if (CONTAINER_ROLES.has(node.role)) return false;
  if (node.states.includes('focusable')) return true;
  return INTERACTIVE_ROLES.has(node.role);
}

export interface CompressOptions {
  /** Hard cap on nodes kept. Default 200. */
  maxNodes?: number;
  /** Deepest level rendered, 0-based from the application. Default 12. */
  maxDepth?: number;
  /** Keep at most this many same-role siblings under one parent. Default 12. */
  maxSiblingsPerRole?: number;
  /** Truncate names/values to this many characters. Default 80. */
  maxNameChars?: number;
  /** Keep nodes the toolkit reports as not showing. Default false. */
  includeHidden?: boolean;
}

export interface CompressStats {
  /** Nodes the walker returned. */
  rawNodes: number;
  /** Nodes surviving compression. */
  keptNodes: number;
  /** True when a cap (nodes/depth/siblings) dropped something. */
  truncated: boolean;
}

/**
 * Squeeze the raw tree down to what a model can act on.
 *
 * The ordering of these passes is the whole design, because they are not
 * commutative: pruning must happen BOTTOM-UP (a scaffolding panel is only
 * droppable once we know whether anything under it survived), and collapsing must
 * happen AFTER pruning (a 1-child chain is usually only a 1-child chain once the
 * hidden siblings are gone). Running them the other way around keeps whole
 * subtrees of empty GTK boxes — which is exactly the noise this exists to remove.
 *
 * THE INVARIANT, stated precisely because the sloppy version of it is wrong in a
 * dangerous direction: **a node the toolkit reports as SHOWING and that
 * `isInteractive` is never dropped** — not for being unnamed, not for being
 * zero-area, not for being deeply nested. A compression that can hide a live button
 * is worse than no compression, because the model cannot distinguish "there is no
 * Save button" from "the Save button was compressed away" and will confidently
 * report the former.
 *
 * What that invariant does NOT promise, deliberately: a NOT-showing interactive node
 * IS dropped. A GTK menubar carries its entire unopened menu as a live, fully
 * populated, not-showing subtree; rendering those items would invite the model to
 * click things that are not on screen — a worse failure than omitting them, because
 * the click silently lands on whatever IS at those coordinates.
 */
export function compressA11yTree(
  roots: readonly A11yNode[],
  opts: CompressOptions = {},
): { roots: A11yNode[]; stats: CompressStats } {
  const maxNodes = opts.maxNodes ?? 200;
  const maxDepth = opts.maxDepth ?? 12;
  const maxSiblings = opts.maxSiblingsPerRole ?? 12;
  const maxChars = opts.maxNameChars ?? 80;
  const includeHidden = opts.includeHidden ?? false;

  let rawNodes = 0;
  let truncated = false;

  const clip = (s: string): string => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);

  /**
   * Pass 1+2: bottom-up prune, then splice.
   *
   * Returns a LIST, not a node, because the dominant GTK compression is not
   * "drop this node" but "lift this node's children into its parent": a dialog
   * arrives as frame > filler > panel > box > [the real widgets], and only the
   * list-returning shape can remove those three intermediate boxes while keeping
   * every widget. A node-returning version can only collapse a 1-child chain,
   * which leaves every multi-child box in place — the majority of the noise.
   */
  const prune = (node: A11yNode, depth: number): A11yNode[] => {
    rawNodes += 1;
    if (depth > maxDepth) {
      truncated = true;
      return [];
    }
    const kids: A11yNode[] = [];
    for (const child of node.children) kids.push(...prune(child, depth + 1));

    // Sibling capping, per role, so a 500-row list costs a line and a count rather
    // than 500 lines. Applied here (post-prune) so the cap counts nodes that SURVIVED.
    const capped: A11yNode[] = [];
    const perRole = new Map<string, number>();
    let dropped = 0;
    for (const child of kids) {
      const seen = perRole.get(child.role) ?? 0;
      if (seen >= maxSiblings) {
        dropped += 1;
        truncated = true;
        continue;
      }
      perRole.set(child.role, seen + 1);
      capped.push(child);
    }
    if (dropped > 0 && capped.length > 0) capped[capped.length - 1]!.omittedSiblings = dropped;

    const keep = (): A11yNode[] => [
      { ...node, name: clip(node.name), value: clip(node.value), children: capped },
    ];

    // An application root is always kept: it is the census the caller needs in order
    // to tell "no apps on the a11y bus" from "apps present, nothing interesting".
    if (depth === 0) return keep();

    const interactive = isInteractive(node);
    const named = node.name.trim().length > 0;
    const hasText = node.value.trim().length > 0;

    // NOT-SHOWING nodes go, unless something under them survived.
    //
    // ⚠ `showing`, deliberately NOT `showing || visible`. In AT-SPI the two are
    // different questions: VISIBLE is "the object is marked visible" and SHOWING is
    // "it is actually rendered on screen". A GTK menubar reports its unopened menus
    // as visible-but-not-showing, so accepting `visible` here readmits the entire
    // closed-menu subtree — items the model would then be invited to click, at
    // coordinates occupied by something else entirely.
    if (!includeHidden && capped.length === 0 && !node.states.includes('showing')) return [];

    // Scaffolding: an unnamed, non-interactive layout box contributes no meaning, so
    // its children are LIFTED into its parent. This is the pass that actually shrinks
    // a GTK tree — see the doc on `prune`'s return type.
    if (SCAFFOLD_ROLES.has(node.role) && !named && !interactive) return capped;

    // A leaf carrying nothing: no children, nothing to click, no name, no text.
    if (capped.length === 0 && !interactive && !named && !hasText) return [];

    // A zero-area leaf is present in the tree but not on screen.
    if (capped.length === 0 && !interactive) {
      const area = node.bounds ? node.bounds[2] * node.bounds[3] : 0;
      if (area <= 0) return [];
    }

    return keep();
  };

  const pruned: A11yNode[] = [];
  for (const root of roots) pruned.push(...prune(root, 0));

  // Pass 3: the global node cap, applied depth-first so the cut is a suffix of the
  // rendering rather than a hole in the middle of it.
  let budget = maxNodes;
  const capTree = (node: A11yNode): A11yNode | null => {
    if (budget <= 0) {
      truncated = true;
      return null;
    }
    budget -= 1;
    const kids: A11yNode[] = [];
    for (const child of node.children) {
      const kept = capTree(child);
      if (kept) kids.push(kept);
    }
    return { ...node, children: kids };
  };
  const out: A11yNode[] = [];
  for (const root of pruned) {
    const kept = capTree(root);
    if (kept) out.push(kept);
  }

  let keptNodes = 0;
  const count = (n: A11yNode): void => {
    keptNodes += 1;
    n.children.forEach(count);
  };
  out.forEach(count);

  return { roots: out, stats: { rawNodes, keptNodes, truncated } };
}

/** State flags worth a byte in the rendering. `showing`/`visible` are the norm, so
 *  rendering them would spend tokens saying "normal" on nearly every line. */
const RENDERED_STATES = ['focused', 'checked', 'selected', 'expanded', 'editable'] as const;

export interface RenderOptions {
  /** Include [x,y w×h] bounds on every node. Default false — the ref makes them
   *  unnecessary for clicking, and they are ~12 tokens per line. */
  includeBounds?: boolean;
}

/**
 * Render the tree as the text the model reads.
 *
 * Format is one node per line, indented by depth:
 *
 *     zenity
 *       frame "Probe Form"
 *         label "Sign in"
 *         entry "Username" #0/0/0/1 [editable]
 *
 * A `#ref` is emitted ONLY for interactive nodes. That is a deliberate token trade:
 * refs exist to be passed back to `computer:click_element`, and a ref on a static
 * label is a token spent on something nobody will ever click. Static nodes still
 * appear — they are the context that makes the interactive ones legible.
 */
export function renderA11yTree(roots: readonly A11yNode[], opts: RenderOptions = {}): string {
  const lines: string[] = [];
  const emit = (node: A11yNode, depth: number): void => {
    const pad = '  '.repeat(depth);
    let line = `${pad}${node.role}`;
    if (node.name) line += ` "${node.name}"`;
    if (node.value && node.value !== node.name) line += ` = "${node.value}"`;
    if (isInteractive(node)) line += ` #${node.ref}`;
    const flags: string[] = RENDERED_STATES.filter((s) => node.states.includes(s));
    // `disabled` is the absence of BOTH enabled and sensitive, and only where the
    // absence is meaningful (an interactive node; scaffolding reports neither).
    //
    // ⚠ Both states, not just ENABLED. GTK4 sets SENSITIVE and does NOT set ENABLED
    // (measured on 4.14.5: a live, clickable Cancel button reports
    // `[showing, visible, sensitive, focusable]`). Testing ENABLED alone therefore
    // labels every widget in a GTK4 app `disabled` — an observation that is not just
    // noisy but actively false, and would stop the model from even trying.
    const usable = node.states.includes('enabled') || node.states.includes('sensitive');
    if (!usable && isInteractive(node)) flags.push('disabled');
    if (flags.length) line += ` [${flags.join(' ')}]`;
    if (opts.includeBounds && node.bounds) {
      const [x, y, w, h] = node.bounds;
      line += ` (${x},${y} ${w}x${h})`;
    }
    lines.push(line);
    for (const child of node.children) emit(child, depth + 1);
    if (node.omittedSiblings) lines.push(`${pad}… +${node.omittedSiblings} more`);
  };
  for (const root of roots) emit(root, 0);
  return lines.join('\n');
}

/**
 * Can this tree's SCREEN extents be used to compute a click point?
 *
 * The falsifier is a tree-level pattern, not a per-node heuristic, because a single
 * element legitimately sitting at the origin is common while a whole UI of
 * differently-sized elements ALL at (0,0) is impossible. That is exactly the GTK4/X11
 * signature: every node reports x=0, y=0 with its own real width/height.
 *
 * Answering this at tree level rather than per node is what keeps the coordinate
 * fallback honest — a per-node check would pass for most nodes of a broken tree and
 * hand back confident, wrong coordinates.
 */
export function screenBoundsAreTrustworthy(roots: readonly A11yNode[]): boolean {
  let withBounds = 0;
  let atOrigin = 0;
  const visit = (n: A11yNode): void => {
    if (n.bounds && (n.bounds[2] > 0 || n.bounds[3] > 0)) {
      withBounds += 1;
      if (n.bounds[0] === 0 && n.bounds[1] === 0) atOrigin += 1;
    }
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  // Below three measurable nodes there is no pattern to detect; treat as trustworthy
  // and let `elementClickPoint`'s own zero-area guard catch the degenerate cases.
  if (withBounds < 3) return true;
  return atOrigin < withBounds;
}

/** Resolve a `#ref` (a child-index path) back to its node. */
export function findByRef(roots: readonly A11yNode[], ref: string): A11yNode | null {
  const wanted = (ref ?? '').trim().replace(/^#/, '');
  if (!wanted) return null;
  const stack: A11yNode[] = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.ref === wanted) return node;
    for (const child of node.children) stack.push(child);
  }
  return null;
}

/**
 * The point `computer:click_element` drives the pointer to — the CENTRE of the
 * element, in DISPLAY space, clamped to the display.
 *
 * ⚠ DISPLAY space, NOT capture space, and that asymmetry with `capability:computer`
 * is the point rather than an oversight. AT-SPI reports `SCREEN` extents in real X
 * pixels, so an element click is structurally immune to the D-006 downscale that
 * every pixel-coordinate click has to be mapped through. It is also why an element
 * click stays correct when the capture geometry changes underneath it.
 */
export function elementClickPoint(
  node: A11yNode,
  display: { width: number; height: number },
): [number, number] {
  if (!node.bounds) throw new Error(`computer:click_element — element #${node.ref} reports no on-screen bounds`);
  const [x, y, w, h] = node.bounds;
  if (!(w > 0) || !(h > 0)) {
    throw new Error(
      `computer:click_element — element #${node.ref} (${node.role}${node.name ? ` "${node.name}"` : ''}) ` +
        `has a zero-area box (${w}x${h}); it is present in the tree but not on screen.`,
    );
  }
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  return [
    Math.max(0, Math.min(cx, display.width - 1)),
    Math.max(0, Math.min(cy, display.height - 1)),
  ];
}

/**
 * Env keys that bind a process to the operator's own D-Bus / accessibility session.
 *
 * 🚨 THE LEAK THIS CLOSES, measured on the box 2026-08-23 and NOT hypothetical.
 * Binding `DISPLAY` to a sandbox is sufficient for `xdotool` and `import`, so it is
 * natural to assume it is sufficient for the a11y walker too. It is not.
 * `atspi_init()` resolves its bus in a LADDER: `AT_SPI_BUS_ADDRESS`, then the
 * `AT_SPI_BUS` property on the X root window, and finally the ambient session bus at
 * `$XDG_RUNTIME_DIR/bus`. A sandbox desktop with no a11y bus of its own has no root
 * property, so the ladder falls all the way through to the LAST rung — the
 * operator's real login session.
 *
 * Observed: a walk bound to sandbox display `:119`, whose only app was one zenity
 * dialog, returned **69 applications** — the owner's actual desktop. It did not warn,
 * error, or return empty. It returned a rich, plausible, completely wrong tree, which
 * is the worst possible failure mode: the model would have read the operator's real
 * screen and had no way to know.
 *
 * The fix is therefore NOT to strip these and hope. Stripping alone still leaves the
 * `$XDG_RUNTIME_DIR/bus` rung reachable — which is exactly the configuration that
 * produced the 69-app walk. The bus must be named EXPLICITLY (`requireA11yBus`).
 */
export const HOST_BUS_ENV_KEYS: readonly string[] = Object.freeze([
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'DBUS_STARTER_ADDRESS',
  'DBUS_STARTER_BUS_TYPE',
]);

/**
 * PRIMARY: ask a desktop's OWN session bus for its accessibility bus address.
 *
 * `org.a11y.Bus` is a D-Bus ACTIVATABLE service, so this single call both starts
 * `at-spi-bus-launcher` (if it is not already up) and returns the address it chose.
 * That two-in-one is why this is the primary probe rather than the root-window read:
 *
 *  - Hand-launching `at-spi-bus-launcher` does NOT work — it races the service
 *    activation and dies with `Failed to launch bus: Bus exited with code 0`
 *    (measured 2026-08-23 on :121).
 *  - The `AT_SPI_BUS` root-window property is NOT reliably set. It was present on
 *    :114/:120 (bus started by an app) and ABSENT on :122 where the very same
 *    `GetAddress` call returned a perfectly good `…/at-spi/bus_122`. A probe that
 *    only reads the root property therefore reports "no accessibility here" for a
 *    desktop that has it.
 *
 * Isolation holds because BOTH keys are per-desktop: the session bus is this
 * desktop's own `dbus-daemon`, and at-spi names its bus after the display
 * (`bus_122` for `:122`).
 */
export function a11yBusCommand(sessionBusAddress: string): { bin: string; args: string[]; env: Record<string, string> } {
  const addr = (sessionBusAddress ?? '').trim();
  if (!addr) throw new Error('computer:observe — a11yBusCommand requires the desktop\'s session bus address');
  return {
    bin: 'gdbus',
    args: [
      'call', '--session',
      '--dest', 'org.a11y.Bus',
      '--object-path', '/org/a11y/bus',
      '--method', 'org.a11y.Bus.GetAddress',
    ],
    // Only the bus address — this call needs no display, and passing none means it
    // cannot accidentally be steered by an inherited host DISPLAY.
    env: { DBUS_SESSION_BUS_ADDRESS: addr },
  };
}

/**
 * SECONDARY: read the bus a display advertises on its root window.
 *
 * For a desktop this process did not provision (a frame slot, a guest) there is no
 * recorded session-bus address, and the root property is then the only handle. It is
 * a strictly weaker probe — see `a11yBusCommand` for the measurement showing it can
 * be absent on a desktop that HAS a bus — so it is the fallback, never the primary.
 */
export function a11yBusFromRootCommand(display: string): { bin: string; args: string[]; env: Record<string, string> } {
  return { bin: 'xprop', args: ['-display', display, '-root', 'AT_SPI_BUS'], env: sandboxXEnv(display) };
}

/**
 * Parse a bus address out of either probe's output.
 *
 * One parser for both shapes on purpose: the two probes answer the SAME question and
 * a caller that falls back from one to the other should not also have to switch
 * parsers. Accepts gdbus's tuple (`('unix:path=…',)`), xprop's property line, and a
 * bare address; returns null for xprop's `no such atom on any window.` — which is a
 * real answer meaning "no accessibility bus here", and is exactly the condition that
 * must refuse rather than fall through to the host's.
 */
export function parseA11yBusAddress(stdout: string): string | null {
  const raw = (stdout ?? '').trim();
  if (!raw) return null;
  const tuple = /^\(\s*'([^']+)'\s*,?\s*\)$/.exec(raw);
  if (tuple) return tuple[1]!.trim() || null;
  const prop = /AT_SPI_BUS\s*\(STRING\)\s*=\s*"([^"]+)"/.exec(raw);
  if (prop) return prop[1]!.trim() || null;
  if (/^unix:(path|abstract)=/.test(raw)) return raw;
  return null;
}

/**
 * The refusal, and — the part that took an investigation to get right — a remedy
 * that names the cause this state ACTUALLY has instead of the one it is easiest
 * to write down.
 *
 * ⚠ THE REMEDY USED TO ASSERT AN UNMEASURED CAUSE. It said "provision the desktop
 * with accessibility enabled (it needs at-spi2-core + gjs …)", which reads as *your
 * host is missing packages*. Measured on this box while triaging EI-22074168424155872:
 * `xprop`, `gdbus`, `dbus-daemon`, `gjs` and `/usr/share/dbus-1/services/org.a11y.Bus.service`
 * were ALL present, a desktop stood up through `computer:provision_desktop` got
 * `/run/user/1000/at-spi/bus_118` and its root-window property within seconds, and
 * `computer:observe` read it fine. The reported failure was on `:111` — a display
 * NOT in the desktop registry, in the range `scripts/verify-tauri-headless.sh`
 * auto-picks (>=90). So the guard was right and the prescription was wrong, and an
 * agent following it would have gone to install packages it already had.
 *
 * The real discriminator is WHO CREATED THE DISPLAY. `startA11yBus` runs only in
 * `provisionSandboxDesktop`, and only it publishes `AT_SPI_BUS` on the root window
 * (at-spi-bus-launcher does NOT set the property itself — measured on a throwaway
 * `:198`: `GetAddress` returned a good `bus_198` while the root window still had no
 * such atom). A hand-rolled `Xvfb :N` therefore CANNOT be observed, by construction
 * and forever, no matter what the host has installed. Lead with that.
 */
export class NoAccessibilityBusError extends Error {
  constructor(display: string) {
    super(
      `computer:observe — display ${display} advertises no accessibility bus (no AT_SPI_BUS property on its root window). ` +
        'REFUSING to fall back to the ambient session bus: that fallback resolves to the OPERATOR\'S OWN desktop and ' +
        'returns a rich, plausible, completely wrong tree (measured: 69 host applications for a sandbox running one dialog). ' +
        'MOST LIKELY CAUSE: this display was not created by computer:provision_desktop. Only that path starts a ' +
        'per-display at-spi bus and publishes it on the root window, so a hand-rolled Xvfb (e.g. one from ' +
        'scripts/verify-tauri-headless.sh, which auto-picks displays >=90) has no bus to find and never will. ' +
        'Check with computer:list_desktops — a registry-backed desktop reports capabilities.a11y — and drive a ' +
        'provisioned desktop, or use capability:computer screenshot on this one. ' +
        `Only if this display WAS provisioned is the host itself suspect (it needs ${A11Y_APT_PACKAGES.join(' + ')} ` +
        'plus /usr/share/dbus-1/services/org.a11y.Bus.service).',
    );
    this.name = 'NoAccessibilityBusError';
  }
}

/**
 * The walker invocation for a display, PINNED to that display's own a11y bus.
 *
 * Two rails, and both are load-bearing:
 *  1. `sandboxXEnv` — the same deny-by-default guard every input action passes, so the
 *     walker can never be pointed at `:0`. A tree read is the one desktop operation
 *     passive enough to feel like it does not need the guard, and a tree of the
 *     operator's session is a straight exfiltration of the fleet's terminals.
 *  2. `busAddress` is REQUIRED and the host bus keys are stripped — see
 *     `HOST_BUS_ENV_KEYS` for the measured leak this exists to stop.
 */
export function walkerCommand(
  display: string,
  busAddress: string,
): { bin: string; args: string[]; env: Record<string, string> } {
  if (!busAddress || !busAddress.trim()) throw new NoAccessibilityBusError(display);
  const env = sandboxXEnv(display);
  for (const key of HOST_BUS_ENV_KEYS) delete env[key];
  env.AT_SPI_BUS_ADDRESS = busAddress.trim();
  return { bin: 'gjs', args: ['-c', ATSPI_WALKER_JS], env };
}

/**
 * ~Tokens for a piece of observation text, and for an image of a given size, using
 * ONE stated method so the P-007 comparison is apples-to-apples.
 *
 * Image: Claude meters at roughly (w*h)/750 — the same constant D-006's measurement
 * used, kept here so the two numbers remain comparable.
 * Text: ~4 characters per token, the standard English approximation.
 *
 * Both are ESTIMATES and are labelled as such wherever they surface. The comparison
 * they support is a ratio between two observations of the SAME screen, which is
 * robust to the constant being a few percent off in either direction; an absolute
 * token count from this function is not evidence of anything.
 */
export function estimateImageTokens(width: number, height: number): number {
  return Math.round((width * height) / 750);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}
