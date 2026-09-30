#!/usr/bin/env node
/**
 * psupty — SPIKE / PROTOTYPE (not a finalized tool).
 *
 * Evaluates the "managed-PTY" route for making interactive psu sessions
 * programmatically wakeable (the open design question from the wake-watch
 * discussion). Today `psu` launches the agent with `stdio:'inherit'` straight
 * into your terminal — the operator doesn't own its stdin, so a wake can only
 * PARK + inbox-nudge. This spike instead launches the command attached to a
 * managed pty (the SAME @lydell/node-pty the operator's pty-bridge uses) and
 * bridges your real TTY <-> the pty, so the session can be INJECTED into live —
 * exactly what an operator wake would do.
 *
 * Use it to FEEL the difference vs a raw terminal before we commit to the
 * managed-pty route:
 *
 *   node apps/operator/scripts/psupty.mjs            # bridge your $SHELL
 *   node apps/operator/scripts/psupty.mjs claude     # bridge the claude TUI (the real test)
 *   node apps/operator/scripts/psupty.mjs omp         # bridge omp
 *
 * Then, from ANOTHER shell, simulate a wake landing in the live session:
 *
 *   node apps/operator/scripts/psupty.mjs inject                       # default demo turn
 *   node apps/operator/scripts/psupty.mjs inject "what is 2+2?"       # custom turn
 *   node apps/operator/scripts/psupty.mjs list                         # live sessions
 *
 * What to judge: does typing/scrollback/resize/colors feel identical to a raw
 * terminal? When `inject` fires, do you see the turn appear + submit live (the
 * wake), and how jarring is it if you were mid-keystroke? Those answers decide
 * whether the managed-pty route is worth the operator-lifecycle coupling.
 *
 * Deliberately standalone: NOT wired into psu / install-standalone-mcp / the
 * operator. Just a script you run by hand. Delete it freely.
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  chmodSync,
} from 'node:fs';
import net from 'node:net';

const require = createRequire(import.meta.url);
const SOCK_DIR = join(homedir(), '.papercusp', 'psupty');

const HELP = `psupty — SPIKE: run a command through a managed PTY (wake-inject demo)

  psupty [command [args...]]   bridge a command through a managed pty (default: $SHELL)
  psupty claude | omp          bridge the real agent TUI (the meaningful feel-test)
  psupty inject [text...]      inject a turn into the newest live session (a simulated wake)
  psupty inject --sock=PATH …  inject into a specific session socket
  psupty list                  list live/dead sessions
  psupty --help

While bridged, your keystrokes pass through the pty transparently; from another
shell, \`psupty inject\` writes a turn (+ Enter) into the live session — what an
operator wake does. Ctrl-C is forwarded to the child (quit the child to exit).`;

function ensureDir() {
  // Owner-only (0700). The control socket inside this dir lets a connector
  // inject keystrokes into a live agent — which runs with permissions bypassed,
  // so an injected line is effectively command execution as this user. 0700 on
  // the dir blocks any other local UID from even traversing to the socket;
  // chmodSync fixes a dir created before this hardening landed.
  mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(SOCK_DIR, 0o700);
  } catch {
    /* best-effort on a pre-existing dir */
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listSessions() {
  ensureDir();
  const out = [];
  for (const f of readdirSync(SOCK_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(SOCK_DIR, f), 'utf8'));
      meta.alive = pidAlive(meta.pid);
      meta.metaPath = join(SOCK_DIR, f);
      out.push(meta);
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Drop metadata/sockets for sessions whose host process is gone. */
function pruneDead() {
  for (const m of listSessions()) {
    if (m.alive) continue;
    try {
      if (existsSync(m.sock)) unlinkSync(m.sock);
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(m.metaPath)) unlinkSync(m.metaPath);
    } catch {
      /* ignore */
    }
  }
}

function cmdList() {
  const s = listSessions();
  if (!s.length) {
    console.log('psupty: no sessions');
    return;
  }
  for (const m of s) {
    const when = new Date(m.startedAt).toLocaleTimeString();
    console.log(
      `${m.alive ? '\x1b[32m●\x1b[0m live' : '\x1b[2m○ dead\x1b[0m'}  pid ${m.pid}  ${m.command} ${(m.args || []).join(' ')}  ·  ${when}  ·  ${m.sock}`,
    );
  }
}

function cmdInject(argv) {
  let sock = null;
  const words = [];
  for (const a of argv) {
    if (a.startsWith('--sock=')) sock = a.slice(7);
    else words.push(a);
  }
  const text = words.length
    ? words.join(' ')
    : "[psupty demo wake] you were just 'woken' — reply with a one-line hello and what you were doing.";

  if (!sock) {
    const live = listSessions().filter((m) => m.alive);
    if (!live.length) {
      console.error('psupty inject: no live sessions — start one with `psupty` (or `psupty claude`)');
      process.exit(1);
    }
    // WI-2141436 hole #3: this used to pick live[0].sock POSITIONALLY — the
    // "newest live session" by sort order, not by any identity the caller
    // named. With exactly one live session that's unambiguous; with more than
    // one it silently injects into whichever session happened to start last,
    // which is exactly the "positional binding is not an identity" shape the
    // umbrella bug calls out. Require --sock= to disambiguate instead of
    // guessing.
    if (live.length > 1) {
      console.error(
        `psupty inject: ${live.length} live sessions — ambiguous without --sock=PATH. Pick one:\n` +
          live.map((m) => `  --sock=${m.sock}  (pid ${m.pid}, ${m.command} ${(m.args || []).join(' ')})`).join('\n'),
      );
      process.exit(1);
    }
    sock = live[0].sock;
  }

  const c = net.connect(sock, () => {
    // text + carriage return = the agent submits it as a turn (the wake).
    c.write(`${text}\r`);
    c.end();
  });
  // EI-18683281603125383: the host (psu-pty-host.mjs, WI-5872/EI-18676244363359331)
  // now writes a JSON-line ACK/NACK back on this connection (allowHalfOpen:true)
  // BEFORE closing its own end. A client that never drains that data leaves its
  // Readable side PAUSED, so Node never advances it to 'end' — and therefore
  // 'close' never fires either — hanging this CLI command forever instead of
  // printing the confirmation below. Draining it (even via a no-op handler) is
  // enough to put the stream in flowing mode so 'close' fires normally; this
  // command only ever reported bare TCP settlement, never the ACK payload
  // itself, so discarding it here is the correct minimal fix.
  c.on('data', () => {});
  c.on('error', (e) => {
    console.error(`psupty inject: failed (${e.message}) — is the session still alive? \`psupty list\``);
    process.exit(1);
  });
  c.on('close', () => {
    console.error(`psupty: injected a turn → ${sock}`);
    process.exit(0);
  });
}

function cmdHost(argv) {
  let pty;
  try {
    pty = require('@lydell/node-pty');
  } catch (e) {
    console.error(`psupty: failed to load @lydell/node-pty (${e.message}). Run from the repo so node_modules resolves.`);
    process.exit(1);
  }

  const command = argv[0] || process.env.SHELL || 'bash';
  const args = argv.slice(1);
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  ensureDir();
  pruneDead();
  const sock = join(SOCK_DIR, `${process.pid}.sock`);
  const metaPath = join(SOCK_DIR, `${process.pid}.json`);
  try {
    if (existsSync(sock)) unlinkSync(sock);
  } catch {
    /* ignore */
  }

  let child;
  try {
    child = pty.spawn(command, args, {
      name: process.env.TERM || 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (e) {
    console.error(`psupty: failed to spawn '${command}': ${e.message}`);
    process.exit(127);
  }

  writeFileSync(
    metaPath,
    JSON.stringify({ pid: process.pid, ptyPid: child.pid, command, args, sock, startedAt: Date.now() }),
  );

  // Control socket — bytes written here are injected verbatim into the pty,
  // i.e. typed into the live session (the operator-wake stand-in).
  const server = net.createServer((conn) => {
    conn.on('data', (d) => {
      try {
        child.write(d.toString('utf8'));
      } catch {
        /* child may have exited */
      }
    });
    conn.on('error', () => {});
  });
  server.on('error', (e) => process.stderr.write(`psupty: control socket error: ${e.message}\n`));
  // Tight umask around bind so the socket node is never even briefly
  // world-accessible between creation and chmod, then pin it 0600 (owner-only).
  const prevUmask = process.umask(0o077);
  server.listen(sock, () => {
    try {
      chmodSync(sock, 0o600);
    } catch {
      /* best-effort */
    }
    process.umask(prevUmask);
  });

  // Brief banner (an alt-screen TUI like claude will clear it — `psupty list`
  // and the inject hint remain available from another shell).
  process.stderr.write(
    `\x1b[2mpsupty ▸ ${command} ${args.join(' ')}  ·  managed pty  ·  inject a wake from another shell:  psupty inject\x1b[0m\r\n`,
  );

  // pty → stdout
  child.onData((d) => process.stdout.write(d));

  // stdin (raw) → pty
  const stdin = process.stdin;
  const rawCapable = stdin.isTTY && typeof stdin.setRawMode === 'function';
  if (rawCapable) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (d) => {
    try {
      child.write(d.toString('utf8'));
    } catch {
      /* ignore */
    }
  });

  // terminal resize (SIGWINCH) → pty resize
  const onResize = () => {
    const c = process.stdout.columns;
    const r = process.stdout.rows;
    if (c && r) {
      try {
        child.resize(c, r);
      } catch {
        /* ignore */
      }
    }
  };
  process.stdout.on('resize', onResize);

  let cleaned = false;
  const cleanup = (code) => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (rawCapable) stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    try {
      stdin.pause();
    } catch {
      /* ignore */
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
    for (const p of [sock, metaPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    process.exit(code ?? 0);
  };

  child.onExit(({ exitCode }) => cleanup(exitCode));
  // Note: in raw mode the terminal does NOT generate SIGINT — Ctrl-C is a byte
  // forwarded to the child, which is what we want. Handle teardown signals only.
  process.on('SIGTERM', () => {
    try {
      child.kill();
    } catch {
      cleanup(0);
    }
  });
  process.on('SIGHUP', () => {
    try {
      child.kill();
    } catch {
      cleanup(0);
    }
  });
}

const [, , sub, ...rest] = process.argv;
if (sub === 'inject' || sub === '--inject') cmdInject(rest);
else if (sub === 'list' || sub === '--list') cmdList();
else if (sub === '-h' || sub === '--help') console.log(HELP);
else if (sub === '--') cmdHost(rest);
else cmdHost(sub ? [sub, ...rest] : []);
