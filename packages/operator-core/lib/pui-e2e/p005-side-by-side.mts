// P-005 side-by-side driver (pui-chat-first-ux-2026-09-28). Review evidence
// capture, not a test: drives a real CLI in a real PTY through the five review
// tasks and writes the rendered frames + timings to --out. The PUI leg of the
// same five tasks is recorded by agent-chat-pty.integration.test.ts
// ("P-005: the five side-by-side review tasks work in a fresh launch directory").
//   npx tsx packages/operator-core/lib/pui-e2e/p005-side-by-side.mts --cli claude|codex|pui --out DIR [--pui-bin PATH] [--pui-args "ARGS"] [--operator URL] [--battery p005|parity]
// --battery parity (P-022) records one probe per behaviour in the parity
// checklist instead: time to a usable prompt, "hi" frames at +150ms/+1s/+3s,
// streaming, a tool call, an approval, interrupt, the / menu, /model, ?,
// history (Up), multiline (Ctrl+J and a trailing backslash), bracketed paste,
// @ mention, status/context commands, an unknown command, Ctrl+C with a draft,
// and resume. Keys are the bytes a plain terminal sends (lone ESC, \n for
// Ctrl+J), so what each CLI does with them is the observation.
// --out must be OUTSIDE any git work tree: both CLIs read instruction files
// (CLAUDE.md / AGENTS.md) from every parent directory up to the repository root,
// so a project inside this repo would load the papercusp agent guide.
import { spawn, type IPty } from '@lydell/node-pty';
import { execFileSync } from 'node:child_process';
import xtermHeadless from '@xterm/headless';
import {
  CODEX_GREETING_EXPECTATION,
  codexHomeControlSocketPath,
  codexHomeFitsControlSocket,
  codexStartupAction,
  codexTaskCompleted,
  isCodexPromptReady,
  taskAnsweredAfterPrompt,
} from './p005-codex-readiness.js';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Terminal } = xtermHeadless as unknown as { Terminal: typeof import('@xterm/headless').Terminal };
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
/** A bare `--<name>` switch (no value). */
const flag = (name: string) => process.argv.includes(`--${name}`);
/** Extra pui launch arguments from `--pui-args "<a> <b>"`, split on whitespace. */
const puiArgs = () => (arg('pui-args') ?? '').split(/\s+/).filter(Boolean);
/**
 * Extra stock-CLI launch arguments from `--stock-args "<a> <b>"` (claude and
 * codex only), appended to both the launch and the resume argv. P-028 records
 * the stock approval prompts with `--stock-args "--permission-mode default"`
 * (Claude) and `--stock-args "-a untrusted"` (Codex): the 2026-10-05 run let
 * both CLIs pick their own mode, which was auto / full access, so neither
 * ever asked.
 */
const stockArgs = () => (arg('stock-args') ?? '').split(/\s+/).filter(Boolean);
/**
 * `--probes 10,11,12` runs only the parity probes whose label starts with one
 * of those numbers (the resume leg is probe 26). Omitted runs them all.
 */
const probeFilter = (arg('probes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const probeSelected = (label: string) => probeFilter.length === 0 || probeFilter.some((p) => label.startsWith(`${p}-`) || label === p);
/**
 * `--max-approvals N` (default 4): how many approval prompts one settle answers
 * with Yes. In ask mode on this dev box, Codex spent all four on commands it ran
 * for the global ~/.codex/AGENTS.md (papercusp file locks) before it reached the
 * edit (P-028, /tmp/pui-p028i-codex), so that leg needs a higher cap.
 */
const maxApprovals = Number(arg('max-approvals', '4'));
if (!Number.isInteger(maxApprovals) || maxApprovals < 0) throw new Error('--max-approvals must be a whole number');
/**
 * `--pui-backend claude|codex|omp` picks pui's engine the way a user does: the
 * `/backend` command's picker (app.rs open_backend_picker), whose rows are
 * Claude, Codex, OMP in that order.
 */
const PUI_BACKENDS = ['claude', 'codex', 'omp'] as const;
const puiBackend = arg('pui-backend');
if (puiBackend !== undefined && !PUI_BACKENDS.includes(puiBackend as (typeof PUI_BACKENDS)[number])) {
  throw new Error(`--pui-backend must be one of ${PUI_BACKENDS.join('|')}`);
}
const cliName =arg('cli') as 'claude' | 'codex' | 'pui';
const out = path.resolve(arg('out')!);
const cols = 120;
const rows = 40;

function enclosingGitTree(dir: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
const gitTree = enclosingGitTree(out);
if (gitTree) throw new Error(`--out ${out} is inside the git work tree ${gitTree}; pick a directory outside any repository`);

type Cli = {
  launch: string[];
  resume: string[];
  exit: string;
  busy: RegExp;
  approve: { when: RegExp; key: string };
  // First-run screens, answered in the way a careful user would: trust the
  // folder, keep approvals on, never self-update.
  startup: Array<{ when: RegExp; keys: string }>;
  // Unprompted promo/onboarding popups, declined the way a user who just wants
  // to work would decline them. Checked on every settle tick.
  dismiss?: Array<{ when: RegExp; keys: string }>;
  afterResume?: string[];
  env?: Record<string, string>;
  // Parity battery (P-022): the idle composer that accepts typing, the
  // commands that show status/context, and (pui only) the key that puts focus
  // back in the message box after an Esc left it.
  ready: RegExp;
  statusCmds: string[];
  refocus?: { unless: RegExp; key: string };
  // A screen that means no conversation can run (no operator, a refused
  // model). A probe that ends on it aborts the battery: before this, the
  // P-025 legs typed every prompt into pui's connection form and logged
  // each step as a normal 6s run.
  blocked?: RegExp;
};

// A stock Codex install reads its config, AGENTS.md, hooks, skills and MCP
// servers from CODEX_HOME (default ~/.codex). On this box ~/.codex/AGENTS.md is
// the papercusp-su playbook (EI-24675961097530755), so the Codex leg gets a fresh
// home of its own. Its auth.json is a SYMLINK to the real login, never a copy:
// ChatGPT refresh tokens are single-use and rotating, so a refresh inside a copy
// would invalidate ~/.codex/auth.json. If Codex replaces the link with a
// refreshed file, finishCodexHome() carries that login back.
const codexHome = cliName === 'codex'
  ? mkdtempSync(path.join(os.tmpdir(), 'p5c-'))
  : path.join(out, 'codex-home');
if (cliName === 'codex' && !codexHomeFitsControlSocket(codexHome)) {
  throw new Error(`CODEX_HOME is too long for the app-server socket: ${codexHomeControlSocketPath(codexHome)}`);
}
const realCodexAuth = path.join(process.env.CODEX_REAL_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
let realCodexAuthAtStart: Buffer | null = null;
function prepareCodexHome(): Record<string, string> {
  mkdirSync(codexHome, { recursive: true });
  realCodexAuthAtStart = readFileSync(realCodexAuth);
  symlinkSync(realCodexAuth, path.join(codexHome, 'auth.json'));
  return { CODEX_HOME: codexHome };
}
function finishCodexHome(): string {
  const linked = path.join(codexHome, 'auth.json');
  if (!existsSync(linked) || lstatSync(linked).isSymbolicLink()) return 'login-shared-through-link';
  if (!readFileSync(realCodexAuth).equals(realCodexAuthAtStart!)) {
    // Both sides moved: keep the real file and say so; the owner decides.
    return 'login-diverged-real-file-kept';
  }
  copyFileSync(linked, realCodexAuth);
  chmodSync(realCodexAuth, 0o600);
  return 'refreshed-login-carried-back';
}

const CLIS: Record<string, Cli> = {
  claude: {
    // User settings (papercusp hooks, plugins) and every configured MCP server are
    // this box's customisation, not what a new Claude Code user gets.
    launch: ['claude', '--setting-sources', 'project,local', '--strict-mcp-config', ...stockArgs()],
    resume: ['claude', '--setting-sources', 'project,local', '--strict-mcp-config', ...stockArgs(), '--continue'], exit: '/exit',
    busy: /esc to interrupt/i,
    // ONLY the tool-permission prompt. A bare `❯ 1. Yes` also matches Claude's
    // other select dialogs (measured: it accepted "Teach auto mode about your
    // environment?", which opens a shell-history scan).
    approve: { when: /Do you want to (make this edit|proceed|create)/, key: '\r' },
    startup: [{ when: /❯ No, exit\s*\n\s*Yes, I trust this folder/, keys: '\x1b[B\r' }],
    dismiss: [{ when: /Teach auto mode about your environment/, keys: '\x1b' }],
    // An update relaunch re-execs WITHOUT the launch argv, which would drop the
    // stock-install flags above mid-run.
    env: { DISABLE_AUTOUPDATER: '1' },
    ready: /\? for shortcuts|^\s*❯\s/m,
    statusCmds: ['/status', '/context'],
  },
  codex: {
    launch: ['codex', ...stockArgs()], resume: ['codex', ...stockArgs(), 'resume', '--last'], exit: '/quit',
    // "Waiting for startup · esc cancel" is a sent message Codex has not begun
    // (P-028 run 2026-10-06: read as idle, so probe 12 ended after 6 s unanswered).
    busy: /esc to interrupt|Working \(|Waiting for startup/i,
    approve: { when: /Would you like to (run|make)|Allow command|Yes, proceed/i, key: 'y' },
    startup: [],
    ready: /^\s*›\s/m,
    statusCmds: ['/status'],
  },
  // The battery grades the chat surface against Claude Code's and Codex's,
  // so it runs `pui --solo` (the same chat that is bare `pui`'s main pane,
  // P-030) full screen. `--pui-workbench` runs bare `pui` instead, to record
  // frames of the chat workbench with its side panes.
  // `--pui-args "--model opus:high --account auto"` launches pui on a chosen
  // engine and route (P-025/P-032: the 2026-10-05 leg ran on an account at its
  // weekly limit and so could not measure any model-backed row).
  pui: {
    launch: [arg('pui-bin', 'pui')!, ...(flag('pui-workbench') ? [] : ['--solo']), ...puiArgs()],
    resume: [arg('pui-bin', 'pui')!, ...(flag('pui-workbench') ? [] : ['--solo']), ...puiArgs()],
    exit: '/exit',
    // An open approval card ("Card — answer above") is a turn still running.
    busy: /Running — Enter queues|Starting|Connecting|esc to interrupt|Card — answer above/i,
    // D-028 approval card: 'Do you want to …?' over `❯ 1. Yes`, footer
    // 'Enter to select · ↑↓ to move · Esc to cancel' (P-028 frames, 2026-10-06).
    approve: { when: /Enter to select · ↑↓ to move · Esc to cancel/, key: '1' },
    startup: [],
    afterResume: ['/resume'],
    env: { PUI_OPERATOR: arg('operator', 'http://127.0.0.1:3170')! },
    ready: /Message — Enter send|Enter sends|\? for shortcuts/,
    statusCmds: ['/status'],
    // Esc with nothing running leaves pui's message box (app.rs, the composing
    // branch's `KeyCode::Esc => self.chat_composing = false`); `i` re-enters it.
    refocus: { unless: /Message — Enter send|Enter sends|\? for shortcuts/, key: 'i' },
    // An account wall or API refusal (P-025: a weekly-limit Claude account
    // answered every step in ~6s with the refusal) means no conversation ran.
    blocked: /Connection: Unavailable|Not connected · send a message|no longer available for this backend|is not available on this operator|no longer offered by the operator|hit your (?:weekly |daily |session |usage )?limit|⎿ API Error (?:40[0-3]|429)|without a usable reply/,
  },
};
const battery = (arg('battery', 'p005') ?? 'p005') as 'p005' | 'parity';
if (battery !== 'p005' && battery !== 'parity') throw new Error('--battery must be p005|parity');
const cli = CLIS[cliName];
if (!cli) throw new Error('--cli must be claude|codex|pui');

const proj = path.join(out, 'proj');
rmSync(out, { recursive: true, force: true });
mkdirSync(proj, { recursive: true });
if (cliName === 'codex') {
  symlinkSync(codexHome, path.join(out, 'codex-home'), 'dir');
  cli.env = { ...(cli.env ?? {}), ...prepareCodexHome() };
}
writeFileSync(path.join(proj, 'calc.js'), 'function add(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n');
writeFileSync(path.join(proj, 'calc.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add, mul } = require('./calc');\n\ntest('add', () => assert.strictEqual(add(2, 3), 5));\ntest('mul', () => assert.strictEqual(mul(2, 3), 6));\n");
writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'p005-proj', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n');

const log: Record<string, unknown>[] = [];
if (cliName === 'codex') log.push({ label: 'codex-home', path: codexHome, controlSocketPath: codexHomeControlSocketPath(codexHome), pathBytes: Buffer.byteLength(codexHomeControlSocketPath(codexHome)) });
let term!: InstanceType<typeof Terminal>;
let pty!: IPty;
let exited = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const screen = () => {
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < b.length; y += 1) lines.push(b.getLine(y)?.translateToString(true) ?? '');
  const visible = lines.slice(Math.max(0, b.baseY), b.baseY + rows);
  while (visible.length && !visible.at(-1)!.trim()) visible.pop();
  return visible.join('\n');
};
const scrollback = () => {
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < b.length; y += 1) lines.push(b.getLine(y)?.translateToString(true) ?? '');
  return lines.join('\n');
};
const frame = (name: string) => writeFileSync(path.join(out, `${name}.txt`), screen() + '\n');

// A stock user's environment: the driver runs inside an su session, and every
// PAPERCUSP_* / Claude-session variable it inherits makes the child act AS that
// session (measured 2026-09-29: an inherited PAPERCUSP_SID let the reviewed
// Claude re-declare the driver's intent and raise owner permission notices).
// `--claude-auth env` keeps ONLY the inference route (base URL, token, headers)
// so stock Claude Code can answer when the box's own login is at its usage
// limit (measured 2026-10-05: "You've hit your weekly limit"). The UI is still
// the stock install; only who pays for the tokens changes.
const keepClaudeRoute = cliName === 'claude' && arg('claude-auth') === 'env';
const CLAUDE_ROUTE_VARS = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']);
function stockEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (keepClaudeRoute && CLAUDE_ROUTE_VARS.has(k) && v) { env[k] = v; continue; }
    if (/^(PAPERCUSP_|PSU_|CLAUDECODE$|CLAUDE_CODE_|ANTHROPIC_|OPENAI_|CODEX_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function start(argv: string[]) {
  term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  exited = false;
  pty = spawn(argv[0], argv.slice(1), {
    name: 'xterm-256color', cols, rows, cwd: proj,
    env: { ...stockEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(cli.env ?? {}) } as Record<string, string>,
  });
  pty.onData((d) => term.write(d));
  pty.onExit(() => { exited = true; });
}

const puiInternalStateSeen = new Set<string>();
function assertStockScreen(label: string, now: string) {
  const contaminated = cliName === 'pui'
    ? /owner directive|Directive #\d|coord:(orient|send|declare)/i
    : /papercusp|coord:|owner directive|Directive #\d/i;
  if (cliName === 'pui' && contaminated.test(now)) {
    if (!puiInternalStateSeen.has(label)) { puiInternalStateSeen.add(label); frame(`${label}.FINDING-internal-state`); }
  } else if (contaminated.test(now)) {
    frame(`${label}.CONTAMINATED`);
    try { pty.kill(); } catch { /* gone */ }
    throw new Error(`${cliName} is not a stock install (papercusp vocabulary on screen during ${label})`);
  }
}

async function settle(label: string, maxMs: number, opts: { approve?: boolean; film?: boolean; tickMs?: number } = {}) {
  const t0 = Date.now();
  let last = screen();
  let stableSince = Date.now();
  let firstChangeMs: number | null = null;
  let approvals = 0;
  const base = last;
  // Every distinct screen, timestamped, so streaming and tool rows can be read
  // after the fact (parity battery only; capped so a runaway stays small).
  const film: Array<{ ms: number; screen: string }> = [];
  try {
    return await settleLoop();
  } finally {
    if (opts.film && film.length) {
      writeFileSync(path.join(out, `${label}.film.txt`), film.map((f) => `=== +${f.ms}ms ===\n${f.screen}`).join('\n') + '\n');
    }
  }
  async function settleLoop() {
  while (Date.now() - t0 < maxMs && !exited) {
    await sleep(opts.tickMs ?? 500);
    const now = screen();
    if (opts.film && now !== last && film.length < 160) film.push({ ms: Date.now() - t0, screen: now });
    assertStockScreen(label, now);
    const popup = cli.dismiss?.find((d) => d.when.test(now));
    if (popup) {
      frame(`${label}.dismissed`);
      pty.write(popup.keys);
      await sleep(1000);
      continue;
    }
    if (now !== last) { last = now; stableSince = Date.now(); }
    if (firstChangeMs === null && now !== base) firstChangeMs = Date.now() - t0;
    if (opts.approve && cli.approve.when.test(now) && approvals < maxApprovals) {
      approvals += 1;
      frame(`${label}.approval-${approvals}`);
      await sleep(300);
      pty.write(cli.approve.key);
      await sleep(1500);
      continue;
    }
    if (!cli.busy.test(now) && Date.now() - stableSince > 6000) break;
  }
  return { firstChangeMs, totalMs: Date.now() - t0, approvals, timedOut: Date.now() - t0 >= maxMs, film: film.map((f) => f.screen) };
  }
}

async function send(text: string) {
  pty.write(text);
  await sleep(400);
  pty.write('\r');
}

async function task(label: string, prompt: string, maxMs = 240_000, expected?: RegExp) {
  // A popup that arrived after the last settle would swallow the prompt text.
  for (let i = 0; i < 3; i += 1) {
    const popup = cli.dismiss?.find((d) => d.when.test(screen()));
    if (!popup) break;
    frame(`${label}.pre-dismissed`);
    pty.write(popup.keys);
    await sleep(1200);
  }
  await send(prompt);
  const r = await settle(label, maxMs, { approve: true });
  const finalScreen = screen();
  frame(label);
  // Every CLI is checked: before P-022 only Codex was, so a Claude/pui task logged
  // taskCompleted:true even when nothing answered (pui's resume recall did).
  const completed = !expected || (cliName === 'codex'
    ? codexTaskCompleted(finalScreen, prompt, expected)
    : taskAnsweredAfterPrompt(finalScreen, prompt, expected));
  log.push({ label, prompt, ...omitFilm(r), exited, ...(expected ? { taskCompleted: completed } : {}) });
  if (exited) throw new Error(`${cliName} exited during ${label}; see ${label}.txt`);
  if (cliName === 'codex' && expected && !completed) {
    throw new Error(`Codex did not complete ${label}; inspect ${label}.txt (the screen must show the prompt, expected answer, and idle composer)`);
  }
}

async function answerStartup(prefix: string) {
  for (let i = 1; i <= 4 && !exited; i += 1) {
    const hit = cli.startup.find((s) => s.when.test(screen()));
    if (!hit) return;
    frame(`${prefix}-startup-${i}`);
    log.push({ label: `${prefix}-startup-${i}`, prompt: hit.when.source });
    pty.write(hit.keys);
    await settle(`${prefix}-startup-${i}`, 30_000);
  }
}

async function waitForCodexPrompt(prefix: string, maxMs: number, allowFirstTask: boolean) {
  const t0 = Date.now();
  const actionCounts = new Map<string, number>();
  while (!exited && Date.now() - t0 < maxMs) {
    const now = screen();
    assertStockScreen(prefix, now);
    const startup = codexStartupAction(now, allowFirstTask);
    if (startup) {
      const count = (actionCounts.get(startup.kind) ?? 0) + 1;
      if (count > 4) throw new Error(`Codex repeated startup screen ${startup.kind}; see ${prefix}-startup-*.txt`);
      actionCounts.set(startup.kind, count);
      frame(`${prefix}-startup-${count}`);
      log.push({ label: `${prefix}-startup-${count}`, prompt: startup.kind });
      pty.write(startup.keys);
      await sleep(800);
      continue;
    }
    if (isCodexPromptReady(now)) return { firstChangeMs: Date.now() - t0, totalMs: Date.now() - t0, approvals: 0, timedOut: false };
    await sleep(500);
  }
  frame(`${prefix}.NOT_READY`);
  throw new Error(`Codex did not reach an interactive prompt within ${maxMs}ms; see ${prefix}.NOT_READY.txt`);
}

async function runP005() {
  start(cli.launch);
  const boot = cliName === 'codex'
    ? await waitForCodexPrompt('00', 90_000, true)
    : await settle('00-launch', 90_000);
  frame('00-launch');
  if (cliName !== 'codex') await answerStartup('00');
  frame('00-ready');
  log.push({ label: '00-launch', ...boot, exited });
  if (exited) throw new Error(`${cliName} exited during startup; see 00-*.txt`);

  await task('01-greeting', 'hi', 240_000, CODEX_GREETING_EXPECTATION);
  await task('02-read-explain', 'Read calc.js and explain what it does in two sentences.', 240_000, /calc\.js defines two functions|add\(a,\s*b\)|mul\(a,\s*b\)/i);
  await task('03-edit', 'Edit calc.js so that add() accepts an optional third number and adds it too.', 240_000, /add\(a,\s*b,\s*c\s*=\s*0\)|optional third number/i);
  if (cliName === 'codex' && !/function add\(a, b, c = 0\)/.test(readFileSync(path.join(proj, 'calc.js'), 'utf8'))) {
    frame('03-edit.FILE_ASSERTION_FAILED');
    throw new Error('Codex did not write the requested optional third argument to calc.js');
  }
  await task('04-run-tests', 'Run the tests with npm test and tell me whether they pass.', 240_000, /npm test passed|1 test passed|# pass\s+1/i);
  writeFileSync(path.join(out, 'scrollback-before-exit.txt'), scrollback());
  await send(cli.exit);
  const t = Date.now();
  while (!exited && Date.now() - t < 20_000) await sleep(250);
  if (!exited) { pty.write('\x03'); await sleep(500); pty.write('\x03'); await sleep(1500); }
  frame('05a-after-exit');
  log.push({ label: '05a-exit', exitedCleanly: exited, exitMs: Date.now() - t });
  try { pty.kill(); } catch { /* already gone */ }

  start(cli.resume);
  const rb = cliName === 'codex'
    ? await waitForCodexPrompt('05b', 90_000, false)
    : await settle('05b-relaunch', 90_000);
  if (cliName !== 'codex') await answerStartup('05b');
  frame('05b-relaunch');
  log.push({ label: '05b-relaunch', ...rb });
  for (const step of cli.afterResume ?? []) {
    await send(step);
    await settle('05c-resume-picker', 20_000);
    frame('05c-resume-picker');
    pty.write('\r');
    await settle('05c-resume-picked', 30_000);
    frame('05c-resume-picked');
  }
  await task('05-resume-recall', 'What change did we make to calc.js earlier in this conversation? One sentence.', 240_000, /optional third number|third parameter|c\s*=\s*0/i);
  await send(cli.exit);
  await sleep(3000);
  try { pty.kill(); } catch { /* gone */ }
}

// ---- P-022 parity battery ---------------------------------------------------
// Each probe records frames under --out and one log row in summary.json. The
// booleans below are first-pass readings for the checklist; the frames are the
// evidence, and a row is graded by reading them.
const INDICATOR = {
  elapsed: /\(\s*\d+s\b|\b\d+s\s*[·•)]|\b\d+m\s*\d+s\b/,
  tokens: /\btokens?\b|[↑↓]\s*[\d.]+k?\b/i,
  esc: /esc to interrupt/i,
};
const PARITY_PASTE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: the quick brown fox jumps over the lazy dog`).join('\n');

function omitFilm<T extends { film?: unknown }>(r: T): Omit<T, 'film'> {
  const { film: _film, ...rest } = r;
  return rest;
}

function indicatorIn(frames: string[]) {
  return {
    busy: frames.some((f) => cli.busy.test(f)),
    elapsed: frames.some((f) => INDICATOR.elapsed.test(f)),
    tokens: frames.some((f) => INDICATOR.tokens.test(f)),
    escHint: frames.some((f) => INDICATOR.esc.test(f)),
  };
}

// The highest bare count (1..40) on screen: streaming shows it climbing across
// frames, a reply that lands all at once shows one value.
function maxCount(f: string): number {
  let m = 0;
  for (const x of f.matchAll(/(?:^|[\s●•⏺])(\d{1,2})\s*$/gm)) {
    const n = Number(x[1]);
    if (n <= 40) m = Math.max(m, n);
  }
  return m;
}

// Time to the message box (promptMs) and to an idle one (idleMs). Claude's
// folder-trust screen is answered on the way and counted in startupScreens.
async function waitReady(prefix: string, maxMs: number) {
  const t0 = Date.now();
  if (cliName === 'codex') {
    const r = await waitForCodexPrompt(prefix, maxMs, prefix === '00');
    return { promptMs: Date.now() - t0, idleMs: Date.now() - t0, startupScreens: null, timedOut: r.timedOut };
  }
  let promptMs: number | null = null;
  let startupScreens = 0;
  while (!exited && Date.now() - t0 < maxMs) {
    const now = screen();
    assertStockScreen(prefix, now);
    const hit = cli.startup.find((s) => s.when.test(now));
    if (hit && startupScreens < 4) {
      startupScreens += 1;
      frame(`${prefix}-startup-${startupScreens}`);
      pty.write(hit.keys);
      await sleep(800);
      continue;
    }
    const popup = cli.dismiss?.find((d) => d.when.test(now));
    if (popup) { frame(`${prefix}.dismissed`); pty.write(popup.keys); await sleep(1000); continue; }
    if (promptMs === null && cli.ready.test(now)) promptMs = Date.now() - t0;
    if (cli.ready.test(now) && !cli.busy.test(now)) return { promptMs, idleMs: Date.now() - t0, startupScreens, timedOut: false };
    await sleep(100);
  }
  frame(`${prefix}.NOT_READY`);
  throw new Error(`${cliName} did not reach an idle prompt within ${maxMs}ms (exited=${exited}); see ${prefix}.NOT_READY.txt`);
}

async function snapAt(label: string, t0: number, offsets: number[]) {
  const shots: Record<string, string> = {};
  for (const ms of offsets) {
    const wait = t0 + ms - Date.now();
    if (wait > 0) await sleep(wait);
    shots[`t${ms}`] = screen();
    writeFileSync(path.join(out, `${label}.t${ms}.txt`), shots[`t${ms}`] + '\n');
  }
  return shots;
}

/** Type, pause like a person, press Enter; returns the instant of the Enter byte. */
async function enter(text: string) {
  pty.write(text);
  await sleep(400);
  const t0 = Date.now();
  pty.write('\r');
  return t0;
}

async function keys(bytes: string, waitMs = 900) {
  pty.write(bytes);
  await sleep(waitMs);
}

/** A lone ESC, spaced so two never land inside a double-Esc window. */
async function esc(label: string) {
  pty.write('\x1b');
  await sleep(1500);
  if (cli.refocus && !exited && !cli.refocus.unless.test(screen())) {
    frame(`${label}.after-esc-unfocused`);
    pty.write(cli.refocus.key);
    await sleep(600);
    return { escLeftMessageBox: true };
  }
  return { escLeftMessageBox: false };
}

async function clearComposer(label: string, n: number) {
  if (exited) return;
  pty.write('\x7f'.repeat(n));
  await sleep(900);
  frame(`${label}.cleared`);
}

async function drainIfBusy(label: string) {
  if (exited || !cli.busy.test(screen())) return false;
  await settle(`${label}.drain`, 180_000, { approve: true });
  return true;
}

async function relaunch(label: string) {
  log.push({ label: `${label}.relaunch`, reason: `${cliName} had exited before this probe` });
  try { pty.kill(); } catch { /* gone */ }
  start(cli.resume);
  log.push({ label: `${label}.relaunched`, ...(await waitReady(`${label}-relaunch`, 90_000)) });
}

async function probe(label: string, fn: () => Promise<Record<string, unknown>>) {
  if (!probeSelected(label)) return;
  if (exited) await relaunch(label);
  const t0 = Date.now();
  try {
    log.push({ label, ...(await fn()), probeMs: Date.now() - t0, exited });
    const blocked = cli.blocked && !exited ? screen().match(cli.blocked)?.[0] : undefined;
    if (blocked) {
      frame(`${label}.BLOCKED`);
      throw new Error(`BATTERY_BLOCKED: ${cliName} shows "${blocked}" after ${label}; no conversation ran. See ${label}.BLOCKED.txt`);
    }
  } catch (error) {
    if (String(error).includes('not a stock install') || String(error).includes('BATTERY_BLOCKED')) throw error;
    frame(`${label}.ERROR`);
    log.push({ label, error: String(error), probeMs: Date.now() - t0, exited });
  }
}

/** `/backend` opens the backend picker (chat-first Esc stays in the box); choose `backend`. */
async function pickPuiBackend(backend: string) {
  await enter('/backend');
  await sleep(1200);
  frame('00-backend-picker');
  const opened = /Backend — Enter select/.test(screen());
  await keys('\x1b[B'.repeat(PUI_BACKENDS.indexOf(backend as (typeof PUI_BACKENDS)[number])), 800);
  await keys('\r', 1200);
  frame('00-backend-picked');
  // D-027: chat-first confirms the pick with a toast; the footer names the engine.
  const picked = screen();
  const note = picked.match(/(?:starts an? |New conversation on |already runs on )(Claude|Codex|OMP)/)?.[1]
    ?? picked.match(/\b(Claude|Codex|OMP) · \//)?.[1] ?? null;
  if (cli.refocus && !cli.refocus.unless.test(screen())) await keys(cli.refocus.key, 800);
  frame('00-backend-ready');
  log.push({ label: '00-backend', backend, pickerOpened: opened, note });
  if (!opened || note?.toLowerCase() !== backend) {
    throw new Error(`pui backend pick did not land on ${backend} (pickerOpened=${opened}, note=${note}); see 00-backend-*.txt`);
  }
}

async function runParity() {
  try {
    log.push({ label: 'version', version: execFileSync(cli.launch[0], ['--version'], { encoding: 'utf8', env: stockEnv(), timeout: 20_000 }).trim() });
  } catch (error) {
    log.push({ label: 'version', error: String(error) });
  }
  if (cliName === 'pui') {
    // The staging operator restarts often; a leg run across a restart
    // measures pui's connection form, not the engine. Record which build
    // served the leg so a result can be tied to code.
    const operator = cli.env?.PUI_OPERATOR ?? 'http://127.0.0.1:3170';
    const health = await fetch(`${operator}/api/health`, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.json() as Promise<{ ok?: boolean; sha?: string }>)
      .catch((error) => ({ ok: false, error: String(error) }) as { ok?: boolean; sha?: string; error?: string });
    log.push({ label: 'operator', url: operator, ...health });
    if (!health.ok) throw new Error(`BATTERY_BLOCKED: operator ${operator} is not answering /api/health`);
  }
  start(cli.launch);
  log.push({ label: '00-ready', ...(await waitReady('00', 120_000)) });
  frame('00-ready');
  if (cliName === 'pui' && puiBackend) await pickPuiBackend(puiBackend);

  await probe('10-hi', async () => {
    const t0 = await enter('hi');
    const shots = await snapAt('10-hi', t0, [150, 1000, 3000]);
    const s = await settle('10-hi', 180_000, { approve: true, film: true, tickMs: 250 });
    frame('10-hi');
    return {
      ...omitFilm(s),
      indicatorAt150: indicatorIn([shots.t150]),
      indicatorAt1000: indicatorIn([shots.t1000]),
      indicatorAt3000: indicatorIn([shots.t3000]),
      indicatorAny: indicatorIn([...Object.values(shots), ...s.film]),
    };
  });
  await probe('11-stream', async () => {
    await enter('Count from 1 to 40, one number per line, and nothing else.');
    const s = await settle('11-stream', 180_000, { approve: true, film: true, tickMs: 250 });
    frame('11-stream');
    const counts = s.film.map(maxCount).filter((n) => n > 0);
    return { ...omitFilm(s), distinctCountsSeen: new Set(counts).size, countsSeen: counts.slice(0, 40), indicator: indicatorIn(s.film) };
  });
  await probe('12-tool', async () => {
    await enter('Read calc.js and tell me in one sentence what mul does.');
    const s = await settle('12-tool', 180_000, { approve: true, film: true });
    frame('12-tool');
    return omitFilm(s);
  });
  await probe('13-edit-approval', async () => {
    const before = readFileSync(path.join(proj, 'calc.js'), 'utf8');
    // `--pui-approvals-ask` (P-028): pui's Codex default lets in-workspace edits
    // through, as stock Codex's does, so its approval card is only seen in ask
    // mode. /approvals lists ask first and the picker clamps, so Up Up = ask.
    if (cliName === 'pui' && flag('pui-approvals-ask')) {
      await enter('/approvals');
      await keys('\x1b[A\x1b[A', 400);
      await keys('\r', 900);
      frame('13-edit-approval.approvals-ask');
    }
    await enter('Edit calc.js so that add() accepts an optional third number and adds it too.');
    const s = await settle('13-edit-approval', 240_000, { approve: true, film: true });
    frame('13-edit-approval');
    return { ...omitFilm(s), fileChanged: readFileSync(path.join(proj, 'calc.js'), 'utf8') !== before };
  });
  await probe('14-interrupt', async () => {
    const t0 = await enter('Write a 600-word story about a lighthouse keeper, in plain prose.');
    await snapAt('14-interrupt', t0, [1500, 4000]);
    const busyBeforeEsc = cli.busy.test(screen());
    const tEsc = Date.now();
    pty.write('\x1b');
    await snapAt('14-interrupt.esc', tEsc, [500, 2000]);
    let stoppedMs: number | null = null;
    while (Date.now() - tEsc < 15_000) {
      if (!cli.busy.test(screen())) { stoppedMs = Date.now() - tEsc; break; }
      await sleep(200);
    }
    const s = await settle('14-interrupt', 60_000);
    frame('14-interrupt');
    let escLeftMessageBox = false;
    if (cli.refocus && !cli.refocus.unless.test(screen())) {
      escLeftMessageBox = true;
      frame('14-interrupt.unfocused');
      pty.write(cli.refocus.key);
      await sleep(600);
    }
    await clearComposer('14-interrupt', 200);
    return { ...omitFilm(s), busyBeforeEsc, stoppedMs, escLeftMessageBox };
  });
  await probe('15-slash', async () => {
    await keys('/', 1500);
    frame('15-slash');
    await keys('mo', 1000);
    frame('15-slash.filtered');
    await clearComposer('15-slash', 10);
    return {};
  });
  await probe('16-model', async () => {
    const t0 = await enter('/model');
    await snapAt('16-model', t0, [2500]);
    const e = await esc('16-model');
    frame('16-model.closed');
    const drained = await drainIfBusy('16-model');
    await clearComposer('16-model', 20);
    return { ...e, startedATurn: drained };
  });
  await probe('17-shortcuts', async () => {
    await keys('?', 1500);
    frame('17-shortcuts');
    const e = await esc('17-shortcuts');
    frame('17-shortcuts.closed');
    await clearComposer('17-shortcuts', 5);
    return e;
  });
  await probe('18-history', async () => {
    await keys('\x1b[A', 1200);
    frame('18-history.up-1');
    await keys('\x1b[A', 900);
    frame('18-history.up-2');
    await clearComposer('18-history', 300);
    return {};
  });
  await probe('19-multiline', async () => {
    await keys('line one', 300);
    await keys('\n', 500);
    await keys('line two', 1200);
    frame('19-multiline.ctrl-j');
    const ctrlJSubmitted = await drainIfBusy('19-multiline.ctrl-j');
    await clearComposer('19-multiline.ctrl-j', 60);
    await keys('line one\\', 300);
    await keys('\r', 600);
    await keys('line two', 1200);
    frame('19-multiline.backslash');
    const backslashSubmitted = await drainIfBusy('19-multiline.backslash');
    await clearComposer('19-multiline.backslash', 60);
    return { ctrlJSubmitted, backslashSubmitted };
  });
  await probe('20-paste', async () => {
    pty.write(`\x1b[200~${PARITY_PASTE}\x1b[201~`);
    await sleep(2000);
    frame('20-paste');
    const submitted = await drainIfBusy('20-paste');
    await clearComposer('20-paste', PARITY_PASTE.length + 50);
    return { submitted, pastedChars: PARITY_PASTE.length, pastedLines: 40 };
  });
  await probe('21-mention', async () => {
    await keys('@cal', 1800);
    frame('21-mention');
    await keys('\t', 1000);
    frame('21-mention.tab');
    const e = await esc('21-mention');
    frame('21-mention.closed');
    await clearComposer('21-mention', 40);
    return e;
  });
  for (const cmd of cli.statusCmds) {
    const slug = cmd.replace(/\W+/g, '');
    await probe(`22-${slug}`, async () => {
      const t0 = await enter(cmd);
      await snapAt(`22-${slug}`, t0, [1500, 4000]);
      const e = await esc(`22-${slug}`);
      frame(`22-${slug}.closed`);
      const drained = await drainIfBusy(`22-${slug}`);
      await clearComposer(`22-${slug}`, 20);
      return { ...e, startedATurn: drained };
    });
  }
  await probe('23-unknown-command', async () => {
    const t0 = await enter('/notacommand');
    await snapAt('23-unknown-command', t0, [1500]);
    const drained = await drainIfBusy('23-unknown-command');
    const e = await esc('23-unknown-command');
    await clearComposer('23-unknown-command', 20);
    return { ...e, startedATurn: drained };
  });
  await probe('24-idle-footer', async () => {
    frame('24-idle-footer');
    return { lastLines: screen().split('\n').slice(-4) };
  });
  await probe('25-ctrl-c', async () => {
    await keys('draft text', 800);
    pty.write('\x03');
    await sleep(1200);
    frame('25-ctrl-c.with-draft');
    const exitedOnDraft = exited;
    let exitedOnSecond = false;
    let exitedOnThird = false;
    if (!exited) { pty.write('\x03'); await sleep(700); frame('25-ctrl-c.second'); exitedOnSecond = exited; }
    if (!exited) { pty.write('\x03'); await sleep(2000); frame('25-ctrl-c.third'); exitedOnThird = exited; }
    writeFileSync(path.join(out, 'scrollback-before-exit.txt'), scrollback());
    return { exitedOnDraft, exitedOnSecond, exitedOnThird };
  });
  if (!exited) {
    await send(cli.exit);
    const t = Date.now();
    while (!exited && Date.now() - t < 15_000) await sleep(250);
  }
  try { pty.kill(); } catch { /* gone */ }
  if (!probeSelected('26-resume')) return;

  start(cli.resume);
  log.push({ label: '26-resume-ready', ...(await waitReady('26-resume', 120_000)) });
  frame('26-resume');
  for (const step of cli.afterResume ?? []) {
    await send(step);
    await settle('26-resume-picker', 20_000);
    frame('26-resume-picker');
    pty.write('\r');
    await settle('26-resume-picked', 30_000);
    frame('26-resume-picked');
  }
  await probe('26-resume-recall', async () => {
    await task('26-resume-recall', 'What change did we make to calc.js earlier in this conversation? One sentence.', 240_000, /optional third number|third parameter|c\s*=\s*0/i);
    return {};
  });
  await send(cli.exit);
  await sleep(3000);
  try { pty.kill(); } catch { /* gone */ }
}

try {
  if (battery === 'parity') await runParity();
  else await runP005();
} catch (error) {
  log.push({ label: 'fatal', error: String(error) });
  throw error;
} finally {
  if (pty && !exited) {
    try { pty.kill(); } catch { /* already gone */ }
  }
  if (cliName === 'codex' && realCodexAuthAtStart) {
    const login = finishCodexHome();
    log.push({ label: 'codex-login', login });
    console.log('P005_CODEX_LOGIN', login);
  }
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ cli: cliName, battery, cols, rows, log }, null, 2) + '\n');
}
console.log(battery === 'parity' ? 'P022_DONE' : 'P005_DONE', cliName, JSON.stringify(log.map((l) => [l.label, l.firstChangeMs ?? null, l.totalMs ?? null, l.approvals ?? null, l.timedOut ?? null])));
process.exit(0);
