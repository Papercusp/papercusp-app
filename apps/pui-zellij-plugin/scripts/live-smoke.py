#!/usr/bin/env python3
"""Live duplex smoke for the pui companion zellij plugin (SP-TUI P-004 / D-008).

Verifies the FULL `zellij pipe` duplex end-to-end against a real zellij session —
the part the offline `cargo test` can't cover (the brief's gate). It stands in
for `pui`'s companion.rs: opens the long-lived `zellij pipe` child, speaks the
`pui-companion-proto` JSON-line protocol, and asserts:

  • plugin handshake (hello) over the pipe
  • live workbench topology (tabs + panes)
  • open_command_pane on command → a pane appears in the live topology
  • focus_pane → focus follows
  • close_pane → a discrete pane_closed event
  • a command pane's natural exit → pane_exited carrying the real exit code

Run after `scripts/build-install.sh`:
    python3 scripts/live-smoke.py
Exit 0 = all checks passed.

ISOLATION (never touches your real zellij/session/config):
  • a fresh, uniquely-named session in its OWN XDG_* dirs under a temp dir;
  • a pre-seeded plugin-permission cache so there's no interactive prompt.

PERMISSION-CACHE GOTCHA (verified against zellij 0.44.3): the cache key in
permissions.kdl is the BARE wasm PATH (no `file:` prefix), even though the
plugin's data-cache dir uses the `file:` URL. And open_command_pane is gated by
`RunCommands`, NOT `ChangeApplicationState`. Both are reflected below.
"""
import json, os, pty, queue, shutil, subprocess, sys, tempfile, threading, time
import fcntl, termios, struct

WASM = os.environ.get("PUI_COMPANION_WASM",
                      os.path.expanduser("~/.papercusp/pui-companion.wasm"))
ZELLIJ = shutil.which("zellij") or os.path.expanduser("~/.cargo/bin/zellij")
SESSION = f"pui-smoke-{os.getpid()}"

if not os.path.exists(WASM):
    sys.exit(f"plugin wasm not found at {WASM} — run scripts/build-install.sh first")
if not (ZELLIJ and os.path.exists(ZELLIJ)):
    sys.exit("zellij not found on PATH")

spike = tempfile.mkdtemp(prefix="pui-smoke-")
for d in ("cache/zellij", "config", "data", "run", "tmp"):
    os.makedirs(os.path.join(spike, d), exist_ok=True)
os.chmod(os.path.join(spike, "run"), 0o700)
# Pre-seed the plugin permission cache. KEY = the BARE wasm path (no file:).
with open(os.path.join(spike, "cache/zellij/permissions.kdl"), "w") as f:
    f.write(f'"{WASM}" {{\n    ReadApplicationState\n    ChangeApplicationState\n'
            f'    RunCommands\n    ReadCliPipes\n}}\n')

ENV = dict(os.environ)
ENV.update(XDG_CACHE_HOME=f"{spike}/cache", XDG_CONFIG_HOME=f"{spike}/config",
           XDG_DATA_HOME=f"{spike}/data", XDG_RUNTIME_DIR=f"{spike}/run", TMPDIR=f"{spike}/tmp")
LOC = f"file:{WASM}"
log = lambda m: print(f"[smoke] {m}", flush=True)
fails = []
def check(cond, msg):
    log(("PASS" if cond else "FAIL") + ": " + msg)
    if not cond:
        fails.append(msg)

# ── start an isolated zellij session attached to a pty (headless) ────────────
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
server = subprocess.Popen([ZELLIJ, "--session", SESSION], stdin=slave, stdout=slave,
                          stderr=slave, env=ENV, preexec_fn=os.setsid, close_fds=True)
os.close(slave)
def drain():
    try:
        while True:
            if not os.read(master, 65536):
                break
    except OSError:
        pass  # pty closed at teardown — expected
threading.Thread(target=drain, daemon=True).start()

def list_sessions():
    r = subprocess.run([ZELLIJ, "list-sessions", "-s"], env=ENV, capture_output=True, text=True)
    return r.stdout + r.stderr

ready = any(SESSION in list_sessions() or time.sleep(0.5) for _ in range(60))
check(ready, f"isolated session {SESSION} is up")

def cleanup():
    subprocess.run([ZELLIJ, "--session", SESSION, "kill-session", SESSION], env=ENV, capture_output=True)
    subprocess.run([ZELLIJ, "delete-session", SESSION, "-f"], env=ENV, capture_output=True)
    try: os.killpg(os.getpgid(server.pid), 9)
    except Exception: pass
    shutil.rmtree(spike, ignore_errors=True)

if not ready:
    cleanup(); sys.exit(1)
time.sleep(1.0)

# ── open the duplex pipe = the companion link ────────────────────────────────
pipe = subprocess.Popen([ZELLIJ, "--session", SESSION, "pipe", "--name", "pui", "--plugin", LOC],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, env=ENV, text=True, bufsize=1)
events = queue.Queue()
def reader():
    for line in pipe.stdout:
        line = line.strip()
        if line:
            try: events.put(json.loads(line))
            except json.JSONDecodeError: pass
threading.Thread(target=reader, daemon=True).start()

lock = threading.Lock()
def send(obj):
    with lock:
        pipe.stdin.write(json.dumps(obj) + "\n"); pipe.stdin.flush()

# Heartbeat (mirrors companion.rs) so async events flush while we're idle.
stop = threading.Event()
def heartbeat():
    while not stop.is_set():
        try: send({"cmd": "ping"})
        except Exception: return
        stop.wait(0.5)
threading.Thread(target=heartbeat, daemon=True).start()

def wait_for(pred, timeout, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try: ev = events.get(timeout=0.25)
        except queue.Empty: continue
        if pred(ev): return ev
    log(f"timeout waiting for {what}")
    return None

# ── assertions ───────────────────────────────────────────────────────────────
send({"cmd": "hello"})
hello = wait_for(lambda e: e.get("ev") == "hello", 30, "hello ack")
check(hello is not None, "plugin handshake (hello) received over the pipe")

topo = wait_for(lambda e: e.get("ev") == "topology", 15, "baseline topology")
check(topo is not None, "live topology snapshot received")
if topo:
    log(f"baseline: {len(topo['tabs'])} tab(s), {len(topo['panes'])} pane(s)")

send({"cmd": "open_command_pane", "command": "bash", "args": ["-c", "sleep 30"], "title": "pui-watch"})
opened = wait_for(lambda e: e.get("ev") == "topology"
                  and any("sleep 30" in (p.get("command") or "") for p in e["panes"]),
                  15, "opened pane in topology")
check(opened is not None, "open_command_pane command opened a pane (seen in topology)")
sleep_pane = next((p for p in opened["panes"] if "sleep 30" in (p.get("command") or "")),
                  None) if opened else None

if sleep_pane:
    send({"cmd": "focus_pane", "pane_id": sleep_pane["id"]})
    foc = wait_for(lambda e: e.get("ev") == "topology"
                   and any(p["id"] == sleep_pane["id"] and p["focused"] for p in e["panes"]),
                   10, "focus to follow")
    check(foc is not None, "focus_pane command moved focus (reflected in topology)")

    send({"cmd": "close_pane", "pane_id": sleep_pane["id"]})
    closed = wait_for(lambda e: e.get("ev") == "pane_closed" and e.get("pane_id") == sleep_pane["id"],
                      10, "pane_closed event")
    check(closed is not None, "close_pane command closed the pane (pane_closed event)")

# Natural exit — match exit_code 7 specifically (a killed/closed pane fires its
# own pane_exited(None), which we ignore here).
send({"cmd": "open_command_pane", "command": "bash", "args": ["-c", "exit 7"]})
exited = wait_for(lambda e: e.get("ev") == "pane_exited" and e.get("exit_code") == 7,
                  15, "pane_exited(exit_code=7)")
check(exited is not None, "command-pane natural exit detected with real exit code (7)")

# ── teardown ─────────────────────────────────────────────────────────────────
stop.set()
try: pipe.stdin.close()
except Exception: pass
pipe.terminate()
cleanup()

print()
if fails:
    log(f"RESULT: {len(fails)} FAILURE(S): {fails}")
    sys.exit(1)
log("RESULT: ALL LIVE CHECKS PASSED")
