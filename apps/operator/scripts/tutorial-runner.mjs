#!/usr/bin/env node
/**
 * tutorial-runner.mjs — the unified Papercusp **Tutorial | Setup** shell
 * (deterministic-onboarding-tutorial-2026-07-04 P-004/P-005;
 *  tutorial-polish-and-docs-search-2026-07-04 #1/#2/#4;
 *  tutorial-setup-batch-2026-07-04 #4 — the tabbed shell).
 *
 * Two always-visible tabs — **Tutorial** (the deterministic tour) and **Setup**
 * (the concierge folded into a re-entrant checklist) — with GLOBAL hotkeys live on
 * every screen: Tab ⇄ switch tab · ^S/"/" search · "#" jump to chapter · "?" ask.
 * Interactively driven by a custom @inquirer/core keypress prompt (shellScreen); the
 * high-level select can't intercept those keys. Non-TTY (piped/CI) degrades to the
 * legacy sequential typed walk. Both `papercusp tutorial` and `papercusp setup` open
 * this shell (different default tab); the first-run linear concierge (onboard-launcher)
 * hands off here at graduation.
 *
 * The tutorial used to be 100% agent-driven: an LLM read a prompt + content pack and
 * "figured out" how to print each section, interpret [1]/[2], drive the GUI tabs, and
 * checkpoint. That is wasteful (an inference per section) and non-deterministic (it can
 * paraphrase / reorder / hallucinate). This runner replaces that spine with a SCRIPT:
 *
 *   - It fetches the whole tutorial in ONE call (GET /api/desktop/tutorial-script).
 *   - It prints each section's `## Brief` VERBATIM (with a friendly reveal).
 *   - Each section ends with an ARROW-KEY menu (Continue / More details / Search /
 *     Ask a question / Jump to a chapter / Finish) — like the Claude TUI.
 *   - It can SEARCH the whole tutorial (type-to-filter) and jump to any section.
 *   - It checkpoints progress, narrates the finale GUI tour, and graduates — all
 *     deterministically.
 *   - An LLM is invoked ONLY when the user asks a free-form QUESTION, and even
 *     then NOT here: the runner POSTs to the operator's /api/desktop/docs-agent-ask,
 *     which LAUNCHES a visible agent terminal (or injects a follow-up into the
 *     already-open one via coord) so the user watches the answer being worked
 *     (owner redesign 2026-07-06). No CLI is spawned by this script.
 *
 * Rendering uses chalk (truecolor, auto-degrades to plain when the terminal has no
 * color / isn't a TTY) plus hand-rolled gradient/typewriter/progress touches and an
 * ora spinner. Every animation is gated on `process.stdout.isTTY` and can be disabled
 * with PAPERCUSP_TUTORIAL_NO_ANIM=1, so piped / CI runs degrade to plain text.
 *
 * Sibling of onboard-launcher.mjs (the setup concierge) — same repo location so
 * `@inquirer/prompts` / chalk / ora resolve from the operator's node_modules, same
 * chat-styled rendering so the whole experience reads as one continuous conversation.
 *
 * Interactive:  papercusp tutorial            (also: node tutorial-runner.mjs --tutorial)
 * First-run:    launched by the concierge at handoff (deterministic tutorial)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { createPrompt, isEnterKey, useKeypress, useState } from '@inquirer/core';
import { discoverOperatorUrl, resolveOperatorBase, fetchResilient } from './operator-discovery.mjs';

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ───────────────────────────────────────────────────────────────────────────

/** Parse argv. Pure. */
export function parseArgs(argv) {
  const out = { tutorial: false, operatorUrl: null, agent: null, tab: null };
  for (const a of argv) {
    if (a === '--tutorial') out.tutorial = true;
    else if (a.startsWith('--operator-url=')) out.operatorUrl = a.slice('--operator-url='.length);
    else if (a.startsWith('--agent=')) out.agent = a.slice('--agent='.length);
    // --tab=setup|tutorial: which tab the unified shell opens on (#4). Bare `papercusp
    // setup` passes --tab=setup; `papercusp tutorial` passes --tutorial (tutorial tab).
    else if (a.startsWith('--tab=')) out.tab = a.slice('--tab='.length);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Unified Tutorial|Setup shell — tab model + global hotkeys (owner batch #4 + B2-#1).
// These are PURE (no chalk) so the tab/keymap/checklist logic is unit-tested.
// ───────────────────────────────────────────────────────────────────────────

/** The two always-visible tabs, in bar order — Setup first, Tutorial second
 *  (owner 2026-07-06). renderTabBar + nextTab both derive their order from this. */
export const SHELL_TABS = ['setup', 'tutorial'];

/** Toggle to the other tab (Tab key), order-driven off SHELL_TABS. Pure. */
export function nextTab(active) {
  const i = SHELL_TABS.indexOf(active);
  return SHELL_TABS[(i + 1) % SHELL_TABS.length];
}

/**
 * Which tab the shell opens on (owner 2026-07-06: "THE SETUP PAGE SHOULD BE THE FIRST
 * THING, NOT THE TUTORIAL. when i do papercusp tutorial it takes me to the tutorial
 * instead of the setup screen"). Setup is the first thing. The shell opens on Setup when:
 *   - required setup (agent + sign-in + mem0 key) is UNFINISHED — a new user can never be
 *     dropped into the tour with setup incomplete; or
 *   - the user ran `papercusp setup` (`--tab=setup`); or
 *   - the user ran `papercusp tutorial` (`--tutorial`) — per the owner it must show the
 *     Setup screen first even on a set-up box (the tour is one Tab away, and the Setup tab
 *     just reads all ✓).
 * The first-run concierge handoff now passes `--tab=setup` (owner 2026-07-07:
 * "onboarding should take them to our tutorial & setup cli … on the setup tab"),
 * so onboarding also opens Setup-first. The Tutorial-tab fall-through below is only
 * reached by a bare runner invocation on an already-set-up box (no `--tab` /
 * `--tutorial`) — no production entry point lands there anymore. Pure.
 */
export function defaultTab(args, { setupComplete = false } = {}) {
  if (!setupComplete) return 'setup';
  if (args?.tab === 'setup') return 'setup';
  if (args?.tutorial) return 'setup';
  return 'tutorial';
}

/**
 * Map a raw keypress (readline key object) to a GLOBAL shell action, or null when the
 * key isn't a global shortcut (the screen then handles it locally — arrows/enter).
 * Live on EVERY screen (B2-#1). Pure — tested with synthetic key objects.
 *   Tab           → 'tab'    (switch tab)
 *   Ctrl+S or '/' → 'search' ('/' because some terminals swallow Ctrl+S as XOFF)
 *   '#'           → 'jump'   (jump to a chapter)
 *   '?'           → 'ask'    (ask a question)
 */
export function resolveShellKey(key) {
  if (!key) return null;
  if (key.name === 'tab') return 'tab';
  if (key.ctrl && key.name === 's') return 'search';
  const seq = key.sequence;
  if (seq === '/') return 'search';
  if (seq === '#') return 'jump';
  if (seq === '?') return 'ask';
  return null;
}

/**
 * The Setup-tab checklist derived from the onboarding-status `snapshot` (#4). Pure —
 * returns ordered steps { key, label, status: 'done'|'todo'|'optional', required, detail }.
 * The Setup tab renders these (grouped Required vs Optional) + offers the incomplete ones
 * as actions. Drives the SAME stage machine the first-run concierge uses (stage-resolver),
 * so the two never drift.
 *
 * REQUIRED = an agent backend (claude / codex / oh-my-pi), signed in, and the mem0
 * embeddings key (owner 2026-07-06 — memory is a required step, skippable-with-a-warning
 * but the setup reads INCOMPLETE until it's added). OPTIONAL = the `optionalItems`
 * (git identity, GitHub, backups, more keys) — surfaced so the user sees they exist.
 */
export function setupChecklist(snapshot, labels = {}, optionalItems = [], decidedKeys = []) {
  const s = snapshot ?? {};
  const decided = new Set(decidedKeys ?? []);
  const installed =
    Boolean(s.claudeInstalled) || Boolean(s.codexInstalled) || Boolean(s.ompInstalled);
  const signedIn =
    (s.claudeInstalled && s.claudeSignedIn) ||
    (s.codexInstalled && s.codexSignedIn) ||
    (s.ompInstalled && s.ompSignedIn);
  const which = s.claudeInstalled
    ? labels.claude ?? 'Claude'
    : s.codexInstalled
      ? labels.codex ?? 'Codex'
      : s.ompInstalled
        ? labels.omp ?? 'oh-my-pi'
        : null;
  const required = [
    {
      key: 'framework',
      label: 'Agent framework',
      status: installed ? 'done' : 'todo',
      required: true,
      detail: which ? `${which} installed` : 'none installed yet (Claude, Codex, or oh-my-pi)',
    },
    {
      key: 'signin',
      label: 'Sign in',
      status: signedIn ? 'done' : 'todo',
      required: true,
      detail: signedIn ? 'signed in' : 'not signed in',
    },
    {
      key: 'embeddings',
      label: 'Memory (mem0) — embeddings key',
      status: s.embeddingsKeyPresent ? 'done' : 'todo',
      required: true,
      detail: s.embeddingsKeyPresent
        ? 'OpenAI key saved — memory enabled'
        : 'required — OpenAI key powers agent memory & search',
    },
  ];
  // Optional-setup items. A `required:true` item (e.g. telemetry consent — owner
  // 2026-07-10) is REQUIRED but answerable-either-way: it renders under Required with a
  // done/todo status driven by `decidedKeys` (the items already answered, per setup-status),
  // exactly like the core steps. Items with no `required` field stay `optional` (skippable).
  const optional = (optionalItems ?? []).map((item) => {
    const isRequired = item.required === true;
    return {
      key: `opt-${item.key}`,
      itemKey: item.key,
      label: item.label,
      status: isRequired ? (decided.has(item.key) ? 'done' : 'todo') : 'optional',
      required: isRequired,
      detail: item.why,
    };
  });
  return [...required, ...optional];
}

/**
 * Map an optional-setup item key → the `/desktop/setup-status` StepId that proves it
 * decided. Mirrors statusStepForItemKey in onboarding/optional-setup-items.ts (the two
 * onboarding surfaces derive "is this required item decided?" from ONE status probe, so
 * the deterministic runner and the setup:complete gate can't disagree). Pure.
 */
export function statusStepForItemKey(key) {
  const MAP = {
    telemetry: 'telemetry',
    'mobile-pairing': 'mobile-pairing',
    'update-channel': 'auto-update',
    'git-identity': 'git',
  };
  return MAP[key] ?? key;
}

/**
 * The `required` optional-setup items NOT yet decided, given a setup-status `statuses`
 * map ({ telemetry: 'ok'|'needs-attention', … }). "Decided" = the item's status step is
 * 'ok' (telemetry flips to ok on either a yes OR a no). An item whose step is absent from
 * the map is treated as undecided (fail-safe toward asking). Pure — powers the graduation
 * gate in both runOptionalSetup and finishUp. */
export function undecidedRequiredItems(items, statuses) {
  const st = statuses ?? {};
  return (items ?? []).filter((i) => {
    if (i?.required !== true) return false;
    const step = statusStepForItemKey(i.key);
    return !(step in st) || st[step] !== 'ok';
  });
}

/**
 * Interpret a typed reply to the option line. Deterministic — NO LLM decides this.
 * Retained for the NON-TTY text fallback (when @inquirer's arrow-key select can't run,
 * e.g. a piped/headless stdin) and for tests. The interactive TTY path uses the
 * arrow-key select built from sectionChoices() instead.
 * Anything that isn't a recognized command IS a question for the agent.
 */
export function interpretReply(raw) {
  const t = (raw ?? '').trim();
  const lower = t.toLowerCase();
  if (t === '' || t === '1' || lower === 'continue' || lower === 'next' || lower === 'c') {
    return { kind: 'continue' };
  }
  if (t === '2' || lower === 'more' || lower === 'details' || lower === 'd') {
    return { kind: 'details' };
  }
  if (lower === 's' || lower === 'search') return { kind: 'search' };
  if (lower === 'm' || lower === 'menu') return { kind: 'menu' };
  if (lower === 'f' || lower === 'finish' || lower === 'done' || lower === 'quit' || lower === 'exit') {
    return { kind: 'finish' };
  }
  return { kind: 'question', text: t };
}

/** The one option line the NON-TTY text fallback ends with. */
export const OPTION_LINE =
  '[1] Continue · [2] More details · [s] Search · [m] Menu · [f] Finish · or just type your question';

/** Per-chapter emoji (pure). Falls back to a generic book. */
export const CHAPTER_EMOJI = { 1: '🧭', 2: '🎯', 3: '☕', 4: '🧠', 5: '🏗️', 6: '🚧' };
export function chapterEmoji(n) {
  return CHAPTER_EMOJI[n] ?? '📘';
}

/**
 * Build the arrow-key menu choices for a section (pure — the interactive #1 menu).
 * "More details" is omitted when the section has none. Emoji + value/name pairs the
 * @inquirer select renders; the runner acts on `value`.
 */
export function sectionChoices(section) {
  const choices = [{ value: 'continue', name: '➡️  Continue' }];
  if (section?.details) choices.push({ value: 'details', name: '📖 More details' });
  choices.push(
    { value: 'search', name: '🔍 Search the tutorial' },
    { value: 'question', name: '💬 Ask a question' },
    { value: 'menu', name: '📚 Jump to a chapter' },
    { value: 'finish', name: '🏁 Finish' },
  );
  return choices;
}

/**
 * Rank tutorial sections against a search query (pure — powers #4). Case-insensitive
 * token match: a title hit weighs 3, a brief hit 1. Empty query → every section (so an
 * empty search box lists everything). Returns [{ idx, section, score }] best-first.
 */
export function searchSections(sections, query) {
  const q = (query ?? '').trim().toLowerCase();
  const list = sections ?? [];
  if (!q) return list.map((section, idx) => ({ idx, section, score: 0 }));
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  list.forEach((section, idx) => {
    const title = (section.title ?? '').toLowerCase();
    const brief = (section.brief ?? '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      if (brief.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ idx, section, score });
  });
  return scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
}

/** Render a text progress bar, e.g. "▓▓▓░░░ 50%". Pure. */
export function renderProgressBar(current, total, width = 12) {
  const t = Math.max(1, total);
  const frac = Math.max(0, Math.min(1, current / t));
  const filled = Math.round(frac * width);
  return `${'▓'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))} ${Math.round(frac * 100)}%`;
}

// Q&A launch + tracking + coord inject now live SERVER-SIDE in the operator's
// /api/desktop/docs-agent-ask endpoint — the runner no longer probes for a
// user-installed CLI or builds the prompt. See answerQuestion below.

/** First section index of a chapter number (or -1). Pure. */
export function firstIndexOfChapter(sections, chapter) {
  return sections.findIndex((s) => s.chapter === chapter);
}

/** Resume index: the section AFTER the last delivered one (or 0). Pure. */
export function resumeIndex(sections, progress) {
  const last = progress?.last_section_id;
  if (!last) return 0;
  const i = sections.findIndex((s) => s.id === last);
  return i >= 0 ? Math.min(i + 1, sections.length) : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering (chalk auto-degrades to plain when !isTTY / NO_COLOR; animations are
// additionally gated on animOn()).
// ───────────────────────────────────────────────────────────────────────────
const dim = (s) => chalk.dim(s);
const bold = (s) => chalk.bold(s);
const accent = (s) => chalk.cyan(s);
const ok = (s) => chalk.green(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Animations on? Only in a real TTY, and never when explicitly disabled. */
function animOn() {
  return Boolean(process.stdout.isTTY) && process.env.PAPERCUSP_TUTORIAL_NO_ANIM !== '1';
}

/**
 * The always-visible tab bar + shortcut hints (owner batch #4 + B2-#1). The active tab
 * is bracketed `[ Setup ]` (the owner-chosen mockup) so it reads even without color; the
 * bar order follows SHELL_TABS (Setup first, Tutorial second — owner 2026-07-06).
 *
 * The Tab-to-switch affordance is deliberately LOUD (owner 2026-07-06: "make the tab
 * switch … impossible for the user to miss"): a non-dim, accent-bold call-to-action on
 * its OWN line that NAMES the tab you'd land on ("Press Tab ⇄ switch to Setup"), instead
 * of the old dim inline "Tab ⇄ switch" that blended into the other shortcut hints. Uses
 * chalk (auto-degrades to plain). The `[ … ]` marker + the CTA text are what tests key off.
 */
export function renderTabBar(activeTab, { setupComplete = false } = {}) {
  const labelFor = (key) => {
    const base = key === 'setup' ? 'Setup' : 'Tutorial';
    return key === 'setup' && setupComplete ? `${base} ✓` : base;
  };
  const tab = (key) =>
    activeTab === key ? accent(bold(`[ ${labelFor(key)} ]`)) : dim(`  ${labelFor(key)}  `);
  const bar = SHELL_TABS.map(tab).join(' ');
  // Name the DESTINATION tab in a loud, non-dim CTA so the switch is unmissable.
  const dest = labelFor(nextTab(activeTab));
  const switchCta = accent(bold(`↹  Press Tab ⇄ switch to ${dest}`));
  const hints = dim('· ^S 🔍 search · # 📖 chapters · ? 💬 ask');
  return `${bar}\n${switchCta}  ${hints}`;
}

/** Render the Setup-tab checklist grouped into Required / Optional, a status glyph
 *  per step so it's clear which parts are mandatory. Uses chalk. */
function renderChecklist(steps) {
  const glyph = { done: ok('✓'), todo: accent('○'), optional: dim('◍') };
  const row = (st) => `  ${glyph[st.status] ?? '·'} ${bold(st.label)} ${dim(`— ${st.detail}`)}`;
  const req = steps.filter((s) => s.required !== false);
  const opt = steps.filter((s) => s.required === false);
  const lines = [dim('Required'), ...req.map(row)];
  if (opt.length) lines.push('', dim('Optional'), ...opt.map(row));
  return lines.join('\n');
}

/**
 * Step the menu cursor for an ↑/↓ keypress (wrap-around). Pure — exported for tests.
 * Extracted after the 2026-07-05 freeze: the step used to be passed to
 * @inquirer/core's setState as a React-style functional updater, which that
 * library does NOT support (it stores the function AS the value), so the menu
 * never moved. Keeping the arithmetic pure keeps the call site a plain number.
 */
export function stepCursor(cursor, keyName, length) {
  if (length <= 0) return cursor;
  if (keyName === 'up') return (cursor - 1 + length) % length;
  if (keyName === 'down') return (cursor + 1) % length;
  return cursor;
}

/**
 * The unified-shell SCREEN: a pinned header (tab bar + hints) above an arrow-selectable
 * menu, with the GLOBAL hotkeys (resolveShellKey) live on EVERY screen (#4 + B2-#1).
 * Resolves to an action the shell loop dispatches on:
 *   { key: 'tab' | 'search' | 'jump' | 'ask' }   a global shortcut fired
 *   { key: 'select', value }                      a menu item was chosen (↑/↓ + ⏎)
 * Custom @inquirer/core prompt because the high-level `select` can't intercept Tab/^S.
 */
const shellScreen = createPrompt((config, done) => {
  const choices = config.choices ?? [];
  const [cursor, setCursor] = useState(0);
  useKeypress((key) => {
    const global = resolveShellKey(key);
    if (global) {
      done({ key: global });
      return;
    }
    if (isEnterKey(key)) {
      done({ key: 'select', value: choices[cursor]?.value });
      return;
    }
    // ⚠ @inquirer/core's useState setter does NOT take a React-style functional
    // updater — setState(fn) stores the FUNCTION as the value (only the INITIAL
    // value may be a factory). Passing `(c) => …` here froze the menu: cursor
    // became a function, no row ever matched `i === cursor`, and ⏎ selected
    // undefined (owner repro 2026-07-05: "can't go up and down"). Compute the
    // next index as a NUMBER from the closure's `cursor` (fresh each render).
    setCursor(stepCursor(cursor, key.name, choices.length));
  });
  const menu = choices
    .map((c, i) => `${i === cursor ? accent('❯ ') : '  '}${c.name}`)
    .join('\n');
  return `${config.header}\n\n${menu}`;
});

/**
 * "Press any key" gate — reuses the same @inquirer/core keypress infra as
 * shellScreen so it works in the interactive TTY. Resolves on the first key.
 * Used for the no-agent-installed → Setup handoff (owner spec 2026-07-05).
 */
const pressAnyKeyPrompt = createPrompt((config, done) => {
  useKeypress(() => done(true));
  return config.message ?? '';
});

/** Linear RGB gradient across a string (violet → cyan by default). Pure-ish (uses chalk). */
function gradient(text, from = [139, 92, 246], to = [34, 211, 238]) {
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  return chars
    .map((ch, i) => {
      const r = Math.round(from[0] + (to[0] - from[0]) * (i / n));
      const g = Math.round(from[1] + (to[1] - from[1]) * (i / n));
      const b = Math.round(from[2] + (to[2] - from[2]) * (i / n));
      return chalk.rgb(r, g, b)(ch);
    })
    .join('');
}

function say(msg) {
  process.stdout.write(`\n${msg}\n`);
}

/** Reveal text with a fast, skippable-feeling typewriter. Degrades to a plain write. */
async function typeOut(text, cps = 900) {
  if (!animOn()) {
    process.stdout.write(`${text}\n`);
    return;
  }
  const delay = 1000 / cps;
  for (const ch of text) {
    process.stdout.write(ch);
    if (ch !== '\n' && ch !== ' ') await sleep(delay);
  }
  process.stdout.write('\n');
}

/** One-time animated gradient welcome banner (settles to a static gradient). */
async function welcomeBanner() {
  const title = 'P A P E R C U S P';
  const tagline = 'your multi-agent coding platform';
  if (!animOn()) {
    say(bold(title));
    process.stdout.write(`${dim(tagline)}\n`);
    return;
  }
  process.stdout.write('\n  ');
  // A left→right "shine": one bright position sweeps across the gradient title.
  const chars = [...title];
  for (let pos = 0; pos <= chars.length; pos++) {
    const line = chars
      .map((ch, i) => {
        if (i === pos) return chalk.whiteBright.bold(ch);
        const n = Math.max(1, chars.length - 1);
        const r = Math.round(139 + (34 - 139) * (i / n));
        const g = Math.round(92 + (211 - 92) * (i / n));
        const b = Math.round(246 + (238 - 246) * (i / n));
        return chalk.rgb(r, g, b)(ch);
      })
      .join('');
    process.stdout.write(`\r  ${line}`);
    await sleep(45);
  }
  process.stdout.write(`\r  ${gradient(title)}\n`);
  process.stdout.write(`  ${dim(tagline)}\n`);
}

function operatorUrlFrom(args, env = process.env) {
  // arg → env → ~/.papercusp/operator.json (packaged installs run the operator
  // on a per-boot dynamic port; :3070 is dev-box-only) → dev fallback.
  return resolveOperatorBase(args, env);
}

/** WI-3283: set when a mid-run operator restart moved the port (rediscovery
 *  followed it) — every later call prefers this over the spawn-time base. */
let liveBase = null;

async function api(base, path, init, opts) {
  // Resilient (WI-3141): ride through the operator's first-boot / recycle window
  // instead of hard-failing on the first connection-refused (the "3 attempts
  // before the tutorial showed up" report). opts threads onRetry/timeouts.
  // Rediscovery (WI-3283): the spawn-time --operator-url pin goes stale when the
  // operator restarts onto a new port — follow the move via operator.json.
  const r = await fetchResilient(`${liveBase ?? base}/api${path}`, init, {
    ...(opts ?? {}),
    rediscover: discoverOperatorUrl,
    onRebase: (b) => {
      liveBase = b;
    },
  });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

// ───────────────────────────────────────────────────────────────────────────
// Server IO
// ───────────────────────────────────────────────────────────────────────────
async function fetchScript(base, tutorial, opts) {
  return api(base, `/desktop/tutorial-script${tutorial ? '?tutorial=1' : ''}`, undefined, opts);
}

async function saveProgress(base, lastSectionId, completedIds) {
  try {
    await api(base, '/desktop/setup-wizard-state', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorial_progress: { last_section_id: lastSectionId, completed_ids: completedIds },
      }),
    });
  } catch {
    /* progress is best-effort — a failed checkpoint must never break the tutorial */
  }
}

/** Graduate: stamp finished_at (idempotent — matches setup:complete). First-run only. */
async function graduate(base) {
  try {
    const state = await api(base, '/desktop/setup-wizard-state');
    if (state?.finished_at) return { alreadyFinished: true };
    await api(base, '/desktop/setup-wizard-state', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ finished_at: new Date().toISOString() }),
    });
    return { alreadyFinished: false };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

/** Read the auto-detected setup-status map ({ telemetry: 'ok'|'needs-attention', … }).
 *  Best-effort: on any error return {} so a required-item check fails toward asking. */
async function fetchSetupStatuses(base) {
  try {
    const r = await api(base, '/desktop/setup-status');
    return r?.statuses ?? {};
  } catch {
    return {};
  }
}

/** Record the telemetry consent decision — the SAME merge-write the setup:set_telemetry
 *  tool and the wizard PATCH perform (telemetry_enabled: true|false; both count as decided). */
async function setTelemetry(base, enabled) {
  await api(base, '/desktop/setup-wizard-state', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ telemetry_enabled: Boolean(enabled) }),
  });
}

/** Run a SpawnSpec inheriting this terminal (interactive install/login flows). */
function runSpec(spec) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd || process.cwd(),
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Q&A — the operator LAUNCHES a visible agent terminal (or injects a follow-up
// into the already-open one via coord) so the user watches the answer being
// worked (owner redesign 2026-07-06). The runner just POSTs the question to
// /api/desktop/docs-agent-ask; no LLM/CLI is spawned by this script.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Ask an agent a question. Owner redesign (2026-07-06): instead of streaming a
 * hidden background answer, this LAUNCHES a full, VISIBLE agent session in a real
 * terminal (or, if one is already open, injects the follow-up into that SAME live
 * agent via the coordination system). POSTs to /api/desktop/docs-agent-ask; the
 * server owns the launch + tracking + coord inject. Returns 'needs_backend'
 * (caller routes to Setup), 'launched' (a new agent terminal opened), 'reused'
 * (sent to the open agent), or 'fallback'. The tutorial NEVER stalls on a failed ask.
 */
async function answerQuestion(base, section, question) {
  // section is unused now (the agent finds its own docs via docs:search) — kept
  // in the signature for the caller + tests.
  void section;
  let resp = null;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), 30_000);
  try {
    // A brief connect budget rides through an operator mid-recycle blip. This is a
    // quick JSON POST (the server spawns the terminal / sends the coord message and
    // returns) — no streaming, so no long client deadline is needed.
    const r = await fetchResilient(`${liveBase ?? base}/api/desktop/docs-agent-ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: ac.signal,
    }, {
      connectBudgetMs: 8_000,
      rediscover: discoverOperatorUrl,
      onRebase: (b) => {
        liveBase = b;
      },
    });
    if (r.ok) resp = await r.json().catch(() => null);
  } catch {
    resp = null;
  } finally {
    clearTimeout(deadline);
  }

  const status = resp && typeof resp.status === 'string' ? resp.status : null;

  if (status === 'needs_backend') {
    // The caller owns the no-agent UX: a clear message + "press ⏎ → Setup" handoff.
    return 'needs_backend';
  }
  if (status === 'launched') {
    say(
      ok('🚀 Opened an agent in a new terminal — ') +
        'your question is being answered there. ' +
        dim('Ask again here and the follow-up goes to that same agent (keep its window open).'),
    );
    return 'launched';
  }
  if (status === 'reused') {
    // woken:0 = the agent is mid-answer/busy; it still sees the follow-up when it's free.
    const note = resp.woken > 0 ? '' : dim(' (it will pick this up as soon as it finishes the current answer)');
    say(ok('→ Sent to your open agent terminal.') + note);
    return 'reused';
  }
  // Graceful fallback — the tutorial NEVER stalls on a failed ask.
  const docs = section?.docSlugs?.length
    ? ` In the meantime, see ${section.docSlugs.map((d) => `/internal/docs/${d}`).join(' or ')}.`
    : '';
  const why = resp && typeof resp.error === 'string' ? ` (${resp.error})` : '';
  say(
    `I couldn't open an agent for that just now.${why}${docs} ` +
      dim('Pick “More details”, or Continue.'),
  );
  return 'fallback';
}

// ───────────────────────────────────────────────────────────────────────────
// Phase A — optional setup (deterministic; the not-ready items are already
// filtered out server-side unless the preview flag is on).
// ───────────────────────────────────────────────────────────────────────────
/**
 * Ask + apply ONE required optional-setup item (owner 2026-07-10). Required means the
 * user MUST answer, but either answer satisfies it — a "no" is recorded and completes the
 * step. Returns true when a decision was recorded. Today only telemetry is required; an
 * unrecognized required item (no wired write) returns false so the gate keeps surfacing it.
 */
async function askRequiredItem(base, item, prompts) {
  const { confirm } = prompts;
  if (item.key === 'telemetry') {
    say(`${bold(item.label)} — ${dim(item.why)}`);
    const yes = await confirm({
      message: 'Share anonymized diagnostics + crash reports to help improve Papercusp? (it is fine to say no)',
      default: false,
    });
    try {
      await setTelemetry(base, yes);
      say(yes ? ok('Thanks — diagnostics are ON. ✓') : ok('No problem — diagnostics stay OFF. ✓'));
      return true;
    } catch (e) {
      say(dim(`(couldn't save your telemetry choice: ${e?.message ?? e} — you can set it later in Settings)`));
      return false;
    }
  }
  say(dim(`${item.label}: configure this in Settings to finish setup.`));
  return false;
}

/**
 * Collect every UNDECIDED required optional-setup item (telemetry today). Reads the live
 * setup-status so an already-answered item is never re-asked (re-entrant: `papercusp setup`
 * won't re-nag). Returns the count still undecided AFTER the pass (0 = graduation unblocked).
 */
async function collectRequiredSetup(base, items, prompts) {
  const statuses = await fetchSetupStatuses(base);
  const todo = undecidedRequiredItems(items, statuses);
  let remaining = todo.length;
  for (const item of todo) {
    if (await askRequiredItem(base, item, prompts)) remaining -= 1;
  }
  return remaining;
}

async function runOptionalSetup(base, items, prompts) {
  const { confirm, input } = prompts;
  if (!items?.length) return;
  // Required items (telemetry consent) are collected FIRST and unconditionally — the
  // "want optional?" gate below only covers the truly skippable items, so a user who
  // skips the optional batch has still answered every required step.
  await collectRequiredSetup(base, items, prompts);
  const optionalOnly = items.filter((i) => i.required !== true);
  if (!optionalOnly.length) return;
  const want = await confirm({
    message: 'Want to run through a few optional setup items now? (~2 min — or skip to the tour)',
    default: false,
  });
  if (!want) {
    say(dim('Skipped — you can set these later in Settings.'));
    return;
  }
  for (const item of optionalOnly) {
    say(`${bold(item.label)} — ${dim(item.why)}`);
    if (item.key === 'git-identity') {
      const doIt = await confirm({ message: 'Set your git name/email now?', default: true });
      if (!doIt) continue;
      const name = await input({ message: 'Git name:' });
      const email = await input({ message: 'Git email:' });
      if (name?.trim() && email?.trim()) {
        try {
          await api(base, '/desktop/git-identity', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name.trim(), email: email.trim() }),
          });
          say(ok('Saved. ✓'));
        } catch (e) {
          say(dim(`(couldn't save git identity: ${e?.message ?? e} — set it later in Settings)`));
        }
      }
    } else if (item.key === 'github') {
      const doIt = await confirm({ message: 'Sign in to GitHub now?', default: false });
      if (!doIt) continue;
      try {
        const cmds = await api(base, '/desktop/setup-pty-commands');
        if (cmds.loginGithub) await runSpec(cmds.loginGithub);
      } catch (e) {
        say(dim(`(couldn't start GitHub sign-in: ${e?.message ?? e})`));
      }
    } else {
      // Informational items (backups, more API keys, and any preview items when the
      // flag is on) — the runner points, it doesn't half-wire a write.
      say(dim('You can configure this any time in Settings.'));
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Menus + search
// ───────────────────────────────────────────────────────────────────────────
async function chapterMenu(script, prompts, includeResume, resumeChapterTitle) {
  const { select } = prompts;
  const choices = [];
  if (includeResume && resumeChapterTitle) {
    choices.push({ value: '__resume', name: `↩️  Resume where you left off (${resumeChapterTitle})` });
  }
  choices.push({ value: '__begin', name: '⏮️  Start from the beginning' });
  for (const ch of script.chapters) {
    choices.push({ value: String(ch.number), name: `${chapterEmoji(ch.number)} Chapter ${ch.number} — ${ch.title}` });
  }
  choices.push({ value: '__finish', name: '🏁 Finish the tutorial' });
  return select({ message: 'Where would you like to go?', choices });
}

/**
 * Search the whole tutorial (#4) with @inquirer's type-to-filter `search` prompt.
 * Returns the chosen section index, or null if the user backed out.
 */
async function searchTutorial(script, prompts) {
  const { search } = prompts;
  const sections = script.sections ?? [];
  try {
    const idx = await search({
      message: '🔍 Search the tutorial (type to filter):',
      source: async (term) => {
        const hits = searchSections(sections, term ?? '');
        return hits.slice(0, 12).map(({ idx, section }) => ({
          name: `${chapterEmoji(section.chapter)} Ch${section.chapter} — ${section.title}`,
          value: idx,
          description: (section.brief ?? '').split('\n')[0].slice(0, 80),
        }));
      },
    });
    return typeof idx === 'number' ? idx : null;
  } catch (e) {
    if (e?.name === 'ExitPromptError') return null; // Ctrl+C out of search → back to the section
    throw e;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Finale — the GUI walkthrough (narrated deterministically).
// ───────────────────────────────────────────────────────────────────────────
function runFinale(script) {
  say(
    bold('The GUI — your inspection surface') +
      '\n' +
      'Now the last piece is the GUI. While you direct Papercusp from the terminal (like ' +
      'this), the GUI is useful for adjusting settings and for browsing the state and ' +
      'history of the app. Here is a walkthrough of the tabs, left to right — open the ' +
      bold('Papercusp') +
      ' GUI icon to follow along.',
  );
  let n = 1;
  for (const tab of script.guiTabTour ?? []) {
    say(`${bold(`${chapterEmoji(0)} ${n}. ${tab.label}`)} — ${tab.blurb}`);
    n += 1;
  }
  say(
    dim(
      'The strip may show fewer tabs than this — per-project tabs hide on "All Pots", and ' +
        'some are feature-flag-gated. That is expected.',
    ),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Setup tab (#4) — the concierge folded into a re-entrant tab. Drives the SAME
// server-side stage machine (GET /desktop/onboarding-status → stage-resolver) and
// pty specs (/desktop/setup-pty-commands) the first-run concierge uses, so the two
// setup surfaces can never drift.
// ───────────────────────────────────────────────────────────────────────────

/** Friendly label for the actionable stage (the Setup tab's "continue" button). */
const SETUP_STEP_LABEL = {
  pick: 'choose & install a framework',
  install: 'install your framework',
  login: 'sign in',
  embeddings: 'add your required memory (mem0) embeddings key',
};

/** One onboarding-status poll, threading the session's picked framework so the
 *  resolver can advance past pick/login (it returns `pick` for an installed-but-
 *  not-signed-in framework unless `chosen` is set — see stage-resolver). */
async function fetchOnboardingStatus(base, session = {}) {
  const q = new URLSearchParams();
  if (session.chosen) q.set('chosen', session.chosen);
  if (session.forcePick) q.set('forcePick', '1');
  if (session.embeddingsSkipped) q.set('embeddingsSkipped', '1');
  const qs = q.toString();
  return api(base, `/desktop/onboarding-status${qs ? `?${qs}` : ''}`);
}

/** Whether EVERY required setup step (agent backend + sign-in + mem0 key) is done —
 *  decides the shell's opening tab (setup-first until complete; owner 2026-07-06).
 *  Best-effort: on any error, returns false so the shell opens on Setup (erring toward
 *  showing setup is the safe default). Mirrors runSetupTab's completeness check + the
 *  server-side requiredSetupComplete, computed off the SAME setupChecklist. */
async function fetchSetupComplete(base) {
  try {
    const status = await fetchOnboardingStatus(base, {});
    const steps = setupChecklist(status?.snapshot, status?.labels, []);
    return steps.filter((s) => s.required).every((s) => s.status === 'done');
  } catch {
    return false;
  }
}

/** Run ONE setup step for the current stage (reuses the concierge's pty specs).
 *  Mutates `session` (chosen / embeddingsSkipped) so the next poll advances. */
async function runSetupStep(base, status, prompts, session) {
  const { select, confirm, password } = prompts;
  const { stage, labels } = status;
  switch (stage.stage) {
    case 'pick': {
      const detected = new Set(stage.detected ?? []);
      const chosen = await select({
        message: 'Which agent framework do you want to install?',
        choices: (stage.frameworks ?? []).map((f) => ({
          value: f,
          name:
            `${labels[f] ?? f}${detected.has(f) ? dim('  (already installed)') : ''}` +
            (f === 'claude' ? dim('  — recommended, simplest') : ''),
        })),
      });
      session.chosen = chosen;
      const cmds = await api(base, '/desktop/setup-pty-commands');
      const spec = cmds.installFramework?.[chosen];
      if (spec) {
        say(`Installing ${bold(labels[chosen] ?? chosen)} — streaming the installer here.`);
        await runSpec(spec);
      } else {
        say(dim(`No installer for ${labels[chosen] ?? chosen} on this OS — try another framework.`));
        session.chosen = null;
      }
      return;
    }
    case 'install': {
      say(`Installing ${bold(labels[stage.framework] ?? stage.framework)} — streaming the installer here.`);
      const cmds = await api(base, '/desktop/setup-pty-commands');
      const spec = cmds.installFramework?.[stage.framework];
      if (spec) await runSpec(spec);
      else say(dim('No installer available on this OS.'));
      return;
    }
    case 'login': {
      say(`${bold(labels[stage.framework] ?? stage.framework)} is installed — let's sign you in.`);
      const cmds = await api(base, '/desktop/setup-pty-commands');
      const specKey = { claude: 'loginClaude', codex: 'loginCodex', omp: 'loginOmp' }[stage.framework];
      if (cmds[specKey]) await runSpec(cmds[specKey]);
      return;
    }
    case 'embeddings': {
      say(
        bold('Required — Memory (mem0): an OpenAI embeddings key.') +
          dim(' Powers agent memory & semantic search. Skippable, but memory stays OFF and setup is incomplete until you add one.'),
      );
      const wants = await confirm({
        message: 'Add your OpenAI embeddings key now? (recommended)',
        default: true,
      });
      if (!wants) {
        session.embeddingsSkipped = true;
        say(dim('⚠ Skipped — ') + bold('memory is DISABLED and setup is INCOMPLETE.') + dim(' Add a key here any time.'));
        return;
      }
      const key = await password({ message: 'Paste your OpenAI API key (hidden):', mask: '*' });
      if (!key?.trim()) {
        session.embeddingsSkipped = true;
        say(dim('⚠ No key entered — ') + bold('memory stays DISABLED and setup is INCOMPLETE.'));
        return;
      }
      try {
        await api(base, '/credentials', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ openai_api_key: key.trim() }),
        });
        say(ok('Saved. ✓ ') + dim('Memory (mem0) is now enabled.'));
      } catch (e) {
        say(dim(`(couldn't save the key: ${e?.message ?? e})`));
      }
      return;
    }
    default:
      return; // handoff/done — nothing to run
  }
}

/**
 * The Setup tab loop. Renders the checklist + the next actionable step; runs it; re-polls.
 * Returns { switchTo:'tutorial' } on Tab / any tutorial-global key / "go to tutorial",
 * or { exit:true } on Finish.
 */
async function runSetupTab(shell) {
  const { base, prompts, interactive } = shell;
  const st = shell.setup;
  if (!st.entered) {
    st.entered = true;
    say(bold('Setup — finish or adjust your Papercusp setup any time.'));
  }
  for (;;) {
    let status;
    try {
      status = await fetchOnboardingStatus(base, st.session);
    } catch (e) {
      say(dim(`(can't reach the server for setup status: ${e?.message ?? e})`));
      return { switchTo: 'tutorial' };
    }
    const optionalItems = shell.script?.optionalSetup ?? [];
    // Which required optional-setup items (telemetry consent) are already decided, per the
    // live setup-status probe — so the checklist row and the completeness gate read the
    // SAME truth the setup:complete graduation gate does.
    const statuses = await fetchSetupStatuses(base);
    const undecidedRequired = undecidedRequiredItems(optionalItems, statuses);
    const decidedKeys = optionalItems
      .filter((i) => i.required === true && !undecidedRequired.includes(i))
      .map((i) => i.key);
    const steps = setupChecklist(status.snapshot, status.labels, optionalItems, decidedKeys);
    // CORE required setup = agent + sign-in + mem0 key (the non-optional steps). FULL
    // required completeness ALSO needs every required optional item (telemetry) decided —
    // that is what gates graduation + the "go to Tutorial" affordance.
    const coreComplete = steps
      .filter((s) => s.required && !String(s.key).startsWith('opt-'))
      .every((s) => s.status === 'done');
    shell.setupComplete = steps.filter((s) => s.required).every((s) => s.status === 'done');
    const stageName = status.stage?.stage;
    const actionable = ['pick', 'install', 'login', 'embeddings'].includes(stageName);

    const header =
      renderTabBar('setup', { setupComplete: shell.setupComplete }) +
      '\n\n' +
      renderChecklist(steps) +
      '\n' +
      dim('What next?');

    const choices = [];
    if (actionable) {
      choices.push({ value: 'step', name: accent(`▶ Continue setup — ${SETUP_STEP_LABEL[stageName]}`) });
    } else if (!coreComplete) {
      // A CORE required step remains (the mem0 key was skipped this session), but the
      // stage machine isn't surfacing it right now — offer to re-open it.
      choices.push({
        value: 'embeddings',
        name: accent('▶ Add your required memory (mem0) key to finish setup'),
      });
    }
    // Required optional items (telemetry consent) still needing a decision — a "no" counts.
    if (undecidedRequired.length) {
      choices.push({
        value: 'required',
        name: accent(`▶ Answer required — ${undecidedRequired.map((i) => i.label).join(', ')}`),
      });
    }
    if (coreComplete && shell.setupComplete) {
      choices.push({ value: 'tutorial', name: ok('✓ Required setup complete — go to the Tutorial') });
    }
    if (optionalItems.some((i) => i.required !== true)) {
      choices.push({ value: 'optional', name: '⚙️  Optional items (git identity, GitHub, backups, …)' });
    }
    choices.push({ value: 'tutorial', name: '📘 Go to the Tutorial tab' });
    choices.push({ value: 'finish', name: '🏁 Finish' });

    let action;
    if (interactive) {
      const r = await shellScreen({ header, choices });
      // Tab or any tutorial-global shortcut on the Setup tab → hop to the Tutorial tab
      // (those actions — search/jump/ask — are section-scoped and live there).
      if (r.key === 'tab' || r.key === 'search' || r.key === 'jump' || r.key === 'ask') {
        return { switchTo: 'tutorial' };
      }
      action = r.value;
    } else {
      action = actionable ? 'step' : 'finish';
    }

    if (action === 'step') {
      await runSetupStep(base, status, prompts, st.session);
      continue;
    }
    if (action === 'embeddings') {
      // Re-open the required mem0 key step the user skipped earlier this session.
      st.session.embeddingsSkipped = false;
      continue;
    }
    if (action === 'required') {
      // Collect the undecided required optional-setup items (telemetry consent).
      await collectRequiredSetup(base, optionalItems, prompts);
      continue;
    }
    if (action === 'optional') {
      await runOptionalSetup(base, optionalItems, prompts);
      continue;
    }
    if (action === 'tutorial') return { switchTo: 'tutorial' };
    if (action === 'finish') {
      await finishUp(base, shell.script, shell.args, false, prompts);
      return { exit: true };
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tutorial tab — the deterministic section walk, now driven by the keypress
// shellScreen so the global shortcuts (search/jump/ask/tab) work on every screen.
// ───────────────────────────────────────────────────────────────────────────

/** Handle ONE tutorial-section screen. Returns { switchTo } / { exit } / {} (stayed). */
async function tutorialSectionAction(shell, s) {
  const { prompts, base, script, sections, interactive } = shell;
  const t = shell.tut;
  let action;
  let typedQuestion = null;
  if (interactive) {
    const header =
      renderTabBar('tutorial', { setupComplete: shell.setupComplete }) + '\n' + dim('What next?');
    const r = await shellScreen({ header, choices: sectionChoices(s) });
    if (r.key === 'tab') return { switchTo: 'setup' };
    if (r.key === 'search') action = 'search';
    else if (r.key === 'jump') action = 'menu';
    else if (r.key === 'ask') action = 'question';
    else action = r.value; // menu select
  } else {
    const reply = interpretReply(await prompts.input({ message: OPTION_LINE }));
    action = reply.kind;
    if (reply.kind === 'question') typedQuestion = reply.text;
  }

  if (action === 'continue') {
    t.completed.add(s.id);
    await saveProgress(base, s.id, [...t.completed]);
    t.idx += 1;
    return {};
  }
  if (action === 'details') {
    say(s.details || dim('(no extra details for this section — ask a question if you like)'));
    return {};
  }
  if (action === 'search') {
    const target = await searchTutorial(script, prompts);
    if (typeof target === 'number' && target >= 0) {
      t.idx = target;
      t.lastChapter = null; // re-print the chapter header on the jump
    }
    return {};
  }
  if (action === 'question') {
    const q = typedQuestion ?? (await prompts.input({ message: '💬 Your question:' }))?.trim();
    if (q) {
      const result = await answerQuestion(base, s, q);
      // No agent installed/signed-in → you can't ask a question yet. Tell the
      // user plainly, wait for a keypress, THEN hand off to the Setup tab so they
      // can install/sign in an agent (owner spec 2026-07-05: "if no agent cli is
      // installed it should just tell them … press any key to be taken to setup").
      if (result === 'needs_backend') {
        say(
          'You need to install an agent backend first (Claude, Codex, or OMP) — ' +
            'that agent is what reads the docs and answers your question.\n' +
            'Want to do that now? ' +
            dim('Press ⏎ to open Setup…'),
        );
        if (interactive) {
          try {
            await pressAnyKeyPrompt({ message: '' });
          } catch {
            /* Ctrl+C during the gate — fall through to Setup anyway */
          }
        }
        return { switchTo: 'setup' };
      }
    }
    return {};
  }
  if (action === 'menu') {
    const choice = await chapterMenu(script, prompts, false, null);
    if (choice === '__finish') {
      await finishUp(base, script, shell.args, false, prompts);
      return { exit: true };
    }
    t.idx = choice === '__begin' ? 0 : Math.max(0, firstIndexOfChapter(sections, Number(choice)));
    t.lastChapter = null;
    return {};
  }
  if (action === 'finish') {
    await finishUp(base, script, shell.args, false, prompts);
    return { exit: true };
  }
  return {};
}

/** The Tutorial tab loop. Returns { switchTo:'setup' } on Tab, { exit:true } at the end. */
async function runTutorialTab(shell) {
  const { script, sections, prompts, base, args, interactive } = shell;
  const t = shell.tut;
  const totalChapters = script.chapters?.length ?? 0;

  // First entry only: greeting + the resume/chapter menu (re-entry or prior progress).
  if (!t.entered) {
    t.entered = true;
    say(
      args.tutorial
        ? bold('The Papercusp tutorial — welcome back.')
        : bold("You're set up. Here's a quick tour of Papercusp — about 10 minutes."),
    );
    const hasProgress =
      Boolean(script.progress?.last_section_id) && t.idx > 0 && t.idx < sections.length;
    if (args.tutorial || hasProgress) {
      const resumeCh = hasProgress
        ? script.chapters.find((c) => c.number === sections[t.idx].chapter)
        : null;
      const choice = await chapterMenu(
        script,
        prompts,
        hasProgress,
        resumeCh ? `Chapter ${resumeCh.number} — ${resumeCh.title}` : null,
      );
      if (choice === '__finish') {
        await finishUp(base, script, args, false, prompts);
        return { exit: true };
      }
      if (choice === '__begin') t.idx = 0;
      else if (choice === '__resume') {
        /* keep computed idx */
      } else {
        const ci = firstIndexOfChapter(sections, Number(choice));
        t.idx = ci >= 0 ? ci : 0;
      }
    }
  }

  while (t.idx < sections.length) {
    const s = sections[t.idx];
    if (s.chapter !== t.lastChapter) {
      const ch = script.chapters.find((c) => c.number === s.chapter);
      const bar = totalChapters ? dim(`  ${renderProgressBar(s.chapter, totalChapters, 12)}`) : '';
      say(
        accent(bold(`${chapterEmoji(s.chapter)}  Chapter ${s.chapter}${ch ? ` — ${ch.title}` : ''}`)) +
          bar,
      );
      t.lastChapter = s.chapter;
    }
    // Print the Brief VERBATIM once per visit (not re-typed when the user stays on a
    // section for details/search/ask). A jump resets t.shownIdx via idx change.
    if (t.shownIdx !== t.idx) {
      process.stdout.write(`\n${bold(s.title)}\n`);
      // Instant (no typewriter) when we just landed here from a tab switch — the
      // animation would otherwise be a window where a follow-up Tab press is dropped.
      if (t.instantReprint) {
        process.stdout.write(`${s.brief}\n`);
        t.instantReprint = false;
      } else {
        await typeOut(s.brief);
      }
      t.shownIdx = t.idx;
    }

    const res = await tutorialSectionAction(shell, s);
    if (res.switchTo) return { switchTo: res.switchTo };
    if (res.exit) return { exit: true };
  }

  // Reached the natural end → the finale, then graduate.
  runFinale(script);
  await finishUp(base, script, args, /* skipFinale */ true, prompts);
  return { exit: true };
}

/** The top-level unified-shell loop: run the active tab until it hands control back. */
async function runShell(shell) {
  for (;;) {
    const result =
      shell.activeTab === 'tutorial' ? await runTutorialTab(shell) : await runSetupTab(shell);
    if (result?.exit) return 0;
    if (result?.switchTo) {
      shell.activeTab = result.switchTo;
      // IMMEDIATE, unmissable switch feedback (owner 2026-07-06: "pressing tab doesn't
      // switch … reliably"). The key was never lost — the perceived unreliability was
      // LATENCY: the Setup tab does a status fetch and the Tutorial tab re-typewrites its
      // brief BEFORE the destination screen appears, so a switch you'd already made looked
      // like "nothing happened" and you pressed Tab again, cancelling it (the earlier "Tab
      // only worked once" report). Print the destination the instant the switch is handled
      // — before any fetch/animation — so every press visibly registers.
      say(accent(bold(`↹  ${result.switchTo === 'setup' ? 'Setup' : 'Tutorial'}`)));
      if (result.switchTo === 'tutorial') {
        // Re-print the current section header + brief on the hop back (else it's a silent
        // bare menu), but print it INSTANTLY (skip the typewriter) so there's no animation
        // window where a follow-up Tab press is dropped.
        shell.tut.lastChapter = null;
        shell.tut.shownIdx = -1;
        shell.tut.instantReprint = true;
      }
      continue;
    }
    return 0;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = operatorUrlFrom(args);
  // Kick off the network fetch IMMEDIATELY so it overlaps the dynamic import + the
  // welcome-banner animation below, instead of blocking the user before anything
  // shows (perf #1). Settle-wrap so an early rejection can't trip an unhandled
  // rejection while we're mid-import / mid-animation.
  let scriptSettled = false;
  const scriptResult = fetchScript(base, args.tutorial).then(
    (value) => { scriptSettled = true; return { ok: true, value }; },
    (error) => { scriptSettled = true; return { ok: false, error }; },
  );

  const prompts = await import('@inquirer/prompts');
  const interactive = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

  // Setup-first (owner 2026-07-06): fetch setup completeness so the shell can open on
  // Setup until it's finished. Kicked off here to overlap the banner + script settle
  // (no added latency); interactive-only (the non-TTY walk never picks a tab).
  const setupCompleteP = interactive ? fetchSetupComplete(base) : Promise.resolve(false);

  // The banner animates (~0.8s) while the fetch is in flight — the fetch latency is
  // hidden under work we'd do anyway rather than added in front of it.
  await welcomeBanner();

  // WI-3141: on a fresh app open the operator is often still booting (embedded-PG
  // + migrations). fetchResilient rides through that instead of hard-failing, but
  // that means the fetch can take several seconds — so once the banner is done, if
  // the script hasn't arrived yet, tell the user we're waiting rather than showing
  // a silent gap that reads as a hang. Printed AFTER the banner to avoid garbling it.
  if (!scriptSettled) {
    say(dim('Getting things ready — waiting for the Papercusp server to finish starting…'));
  }

  const settled = await scriptResult;
  if (!settled.ok) {
    const e = settled.error;
    say(
      `I can't reach the Papercusp server at ${base} (${e?.message ?? e}).\n` +
        dim('Make sure the desktop app / server is running, then try again.'),
    );
    return 1;
  }
  const script = settled.value;

  const sections = script.sections ?? [];
  if (!sections.length) {
    say('No tutorial content is installed on this build. ' + dim('Nothing to run.'));
    return 0;
  }
  // Q&A launches/reuses a visible agent terminal server-side (POST
  // /api/desktop/docs-agent-ask) — no per-session CLI backend to choose here.

  const setupComplete = await setupCompleteP;

  // ── Unified Tutorial | Setup shell (#4) ──
  // Shared, MUTABLE state so a Tab-switch preserves tutorial position + progress
  // across tabs (you resume the same section you left).
  const shell = {
    base,
    args,
    prompts,
    interactive,
    script,
    sections,
    setupComplete,
    activeTab: defaultTab(args, { setupComplete }),
    tut: {
      idx: resumeIndex(sections, script.progress),
      completed: new Set(script.progress?.completed_ids ?? []),
      lastChapter: null,
      shownIdx: -1,
      instantReprint: false,
      entered: false,
    },
    setup: {
      entered: false,
      // The Setup tab's own concierge session; seed the picked framework from --agent
      // so a first-run handoff doesn't re-ask which framework. omp is no longer an
      // onboarding framework (only claude/codex) — an omp agent falls back to the picker.
      session: {
        chosen: args.agent === 'omp' ? null : args.agent || null,
        forcePick: false,
        embeddingsSkipped: false,
      },
    },
  };

  // Interactive: the full tabbed shell with global hotkeys (Tab / ^S / # / ?).
  // Non-TTY (piped / CI — no raw keypresses): the legacy sequential walk — optional
  // setup then the Tutorial via the typed fallback; the Setup tab is TTY-only.
  if (interactive) return runShell(shell);
  if (!args.tutorial) await runOptionalSetup(base, script.optionalSetup, prompts);
  await runTutorialTab(shell);
  return 0;
}

/** Finale (unless already shown) + graduation + close. On a FIRST-RUN graduation, any
 *  undecided `required` optional-setup item (telemetry consent) is collected BEFORE the
 *  finished_at stamp — the deterministic-runner mirror of the setup:complete gate, so a
 *  user can't graduate the runner without having been asked. `prompts` is threaded from the
 *  caller (the shell has it); a re-run tutorial (args.tutorial) neither graduates nor gates. */
async function finishUp(base, script, args, skipFinale = false, prompts = null) {
  if (!skipFinale) runFinale(script);
  if (!args.tutorial) {
    if (prompts) {
      try {
        await collectRequiredSetup(base, script?.optionalSetup ?? [], prompts);
      } catch {
        /* asking is best-effort — never trap the user at the finish line on a prompt error */
      }
    }
    const res = await graduate(base);
    if (res.error) say(dim(`(couldn't mark onboarding finished: ${res.error} — you can ignore this)`));
  }
  say(
    ok(bold("That's the tour.")) +
      ' Start an agent session any time with ' +
      bold('psu') +
      ', and re-open this any time from the ' +
      bold('Papercusp Tutorial & Setup') +
      ' icon, or ' +
      bold('papercusp tutorial') +
      ' / ' +
      bold('papercusp setup') +
      '.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      if (err?.name === 'ExitPromptError') process.exit(130); // Ctrl+C in a prompt — clean.
      console.error(`[tutorial] ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
