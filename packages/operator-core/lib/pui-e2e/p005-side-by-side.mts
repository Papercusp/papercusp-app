// P-005 side-by-side driver (pui-chat-first-ux-2026-09-28). Review evidence
// capture, not a test: drives a real CLI in a real PTY through the five review
// tasks and writes the rendered frames + timings to --out. The PUI leg of the
// same five tasks is recorded by agent-chat-pty.integration.test.ts
// ("P-005: the five side-by-side review tasks work in a fresh launch directory").
//   npx tsx packages/operator-core/lib/pui-e2e/p005-side-by-side.mts --cli claude|codex|pui --out DIR [--pui-bin PATH] [--operator URL]
// --out must be OUTSIDE any git work tree: both CLIs read instruction files
// (CLAUDE.md / AGENTS.md) from every parent directory up to the repository root,
// so a project inside this repo would load the papercusp agent guide.
import { spawn, type IPty } from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Terminal } = xtermHeadless as unknown as { Terminal: typeof import('@xterm/headless').Terminal };
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const cliName = arg('cli') as 'claude' | 'codex' | 'pui';
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
};

// A stock Codex install reads its config, AGENTS.md, hooks, skills and MCP
// servers from CODEX_HOME (default ~/.codex). On this box ~/.codex/AGENTS.md is
// the papercusp-su playbook (EI-24675961097530755), so the Codex leg gets a fresh
// home of its own. Its auth.json is a SYMLINK to the real login, never a copy:
// ChatGPT refresh tokens are single-use and rotating, so a refresh inside a copy
// would invalidate ~/.codex/auth.json. If Codex replaces the link with a
// refreshed file, finishCodexHome() carries that login back.
const codexHome = path.join(out, 'codex-home');
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
    launch: ['claude', '--setting-sources', 'project,local', '--strict-mcp-config'],
    resume: ['claude', '--setting-sources', 'project,local', '--strict-mcp-config', '--continue'], exit: '/exit',
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
  },
  codex: {
    launch: ['codex'], resume: ['codex', 'resume', '--last'], exit: '/quit',
    busy: /esc to interrupt|Working \(/i,
    approve: { when: /Would you like to (run|make)|Allow command|Yes, proceed/i, key: 'y' },
    startup: [
      // Only the update DIALOG (Update now / Skip). codex-cli 0.159 also shows a
      // passive "Update available!" banner above the composer, which needs no answer.
      { when: /Update available[\s\S]*Skip/, keys: '\x1b[B\r' },
      { when: /(ask me to approve|Require approval)/i, keys: '\x1b[B\r' },
      // codex-cli 0.159 asks "Trust this folder?" with "1. Trust and continue" selected.
      { when: /allow Codex to work|Do you trust|Trust this folder\?/i, keys: '\r' },
    ],
  },
  pui: {
    launch: [arg('pui-bin', 'pui')!], resume: [arg('pui-bin', 'pui')!], exit: '/exit',
    busy: /Running — Enter queues|Starting|Connecting/i,
    approve: { when: /Approve.*Decline|1 Approve|\[1\] Approve/i, key: '1' },
    startup: [],
    afterResume: ['/resume'],
    env: { PUI_OPERATOR: arg('operator', 'http://127.0.0.1:3170')! },
  },
};
const cli = CLIS[cliName];
if (!cli) throw new Error('--cli must be claude|codex|pui');

const proj = path.join(out, 'proj');
rmSync(out, { recursive: true, force: true });
mkdirSync(proj, { recursive: true });
if (cliName === 'codex') cli.env = { ...(cli.env ?? {}), ...prepareCodexHome() };
writeFileSync(path.join(proj, 'calc.js'), 'function add(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n');
writeFileSync(path.join(proj, 'calc.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add, mul } = require('./calc');\n\ntest('add', () => assert.strictEqual(add(2, 3), 5));\ntest('mul', () => assert.strictEqual(mul(2, 3), 6));\n");
writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'p005-proj', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n');

const log: Record<string, unknown>[] = [];
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
function stockEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
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
async function settle(label: string, maxMs: number, opts: { approve?: boolean } = {}) {
  const t0 = Date.now();
  let last = screen();
  let stableSince = Date.now();
  let firstChangeMs: number | null = null;
  let approvals = 0;
  const base = last;
  while (Date.now() - t0 < maxMs && !exited) {
    await sleep(500);
    const now = screen();
    // Stock-install guard: any papercusp vocabulary on a reviewed CLI's screen
    // means it loaded this box's customisation, so its behaviour is not the
    // comparison we want and it may be acting on shared state. Stop at once.
    // The PUI legitimately shows its own brand, so it is held to the narrower
    // "an internal agent is acting on the workspace's owner directives" test —
    // on the PUI that is itself a finding, and the leg stops before the engine acts.
    const contaminated = cliName === 'pui'
      ? /owner directive|Directive #\d|coord:(orient|send|declare)/i
      : /papercusp|coord:|owner directive|Directive #\d/i;
    // On the PUI the engine is a fresh session of its own (not the driver's
    // identity), so the match is recorded as a finding and the leg continues.
    if (cliName === 'pui' && contaminated.test(now)) {
      if (!puiInternalStateSeen.has(label)) { puiInternalStateSeen.add(label); frame(`${label}.FINDING-internal-state`); }
    } else if (contaminated.test(now)) {
      frame(`${label}.CONTAMINATED`);
      try { pty.kill(); } catch { /* gone */ }
      throw new Error(`${cliName} is not a stock install (papercusp vocabulary on screen during ${label})`);
    }
    const popup = cli.dismiss?.find((d) => d.when.test(now));
    if (popup) {
      frame(`${label}.dismissed`);
      pty.write(popup.keys);
      await sleep(1000);
      continue;
    }
    if (now !== last) { last = now; stableSince = Date.now(); }
    if (firstChangeMs === null && now !== base) firstChangeMs = Date.now() - t0;
    if (opts.approve && cli.approve.when.test(now) && approvals < 4) {
      approvals += 1;
      frame(`${label}.approval-${approvals}`);
      await sleep(300);
      pty.write(cli.approve.key);
      await sleep(1500);
      continue;
    }
    if (!cli.busy.test(now) && Date.now() - stableSince > 6000) break;
  }
  return { firstChangeMs, totalMs: Date.now() - t0, approvals, timedOut: Date.now() - t0 >= maxMs };
}

async function send(text: string) {
  pty.write(text);
  await sleep(400);
  pty.write('\r');
}

async function task(label: string, prompt: string, maxMs = 240_000) {
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
  frame(label);
  log.push({ label, prompt, ...r, exited });
  if (exited) throw new Error(`${cliName} exited during ${label}; see ${label}.txt`);
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

try {
  start(cli.launch);
  const boot = await settle('00-launch', 90_000);
  frame('00-launch');
  await answerStartup('00');
  frame('00-ready');
  log.push({ label: '00-launch', ...boot, exited });
  if (exited) throw new Error(`${cliName} exited during startup; see 00-*.txt`);

  await task('01-greeting', 'hi');
  await task('02-read-explain', 'Read calc.js and explain what it does in two sentences.');
  await task('03-edit', 'Edit calc.js so that add() accepts an optional third number and adds it too.');
  await task('04-run-tests', 'Run the tests with npm test and tell me whether they pass.');
  writeFileSync(path.join(out, 'scrollback-before-exit.txt'), scrollback());
  await send(cli.exit);
  const t = Date.now();
  while (!exited && Date.now() - t < 20_000) await sleep(250);
  if (!exited) { pty.write('\x03'); await sleep(500); pty.write('\x03'); await sleep(1500); }
  frame('05a-after-exit');
  log.push({ label: '05a-exit', exitedCleanly: exited, exitMs: Date.now() - t });
  try { pty.kill(); } catch { /* already gone */ }

  start(cli.resume);
  const rb = await settle('05b-relaunch', 90_000);
  await answerStartup('05b');
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
  await task('05-resume-recall', 'What change did we make to calc.js earlier in this conversation? One sentence.');
  await send(cli.exit);
  await sleep(3000);
  try { pty.kill(); } catch { /* gone */ }
} finally {
  if (cliName === 'codex' && realCodexAuthAtStart) {
    const login = finishCodexHome();
    log.push({ label: 'codex-login', login });
    console.log('P005_CODEX_LOGIN', login);
  }
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ cli: cliName, cols, rows, log }, null, 2) + '\n');
}
console.log('P005_DONE', cliName, JSON.stringify(log.map((l) => [l.label, l.firstChangeMs ?? null, l.totalMs ?? null, l.approvals ?? null, l.timedOut ?? null])));
process.exit(0);
