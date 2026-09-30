#!/usr/bin/env python3
"""Live e2e for the dockview dock-verbs (Brief 50 / dockview-workbench-2026-06-05).

The sibling of `live-smoke.py`: it drives the FULL companion wire path that the
offline `cargo test` can't — proto `Command` → plugin → real zellij — for the
dockview additions, against the actual workbench swap-layout presets:

  • the session opens on the `stacked` preset (TabNode.swap_layout over the wire)
  • open_command_pane {stack:true} → the new pane lands in the work STACK
    (dump-layout shows it inside `stacked=true`, NOT splitting the HUD)
  • stack_panes [ids] → the named panes are gathered into one stack
  • select_swap_layout "grid"/"split"/"stacked-left" → the active preset follows
  • next_swap_layout / prev_swap_layout → the active preset cycles
  • toggle_pane_float → a work pane floats, then re-embeds to its slot

Run after `scripts/build-install.sh`:
    python3 scripts/dock-verbs-smoke.py
Exit 0 = all checks passed.

ISOLATION is identical to live-smoke.py: a uniquely-named session in its own
XDG_* temp dirs with a pre-seeded permission cache — it never touches your real
zellij/session/config/pui. The session is launched WITH the real workbench KDL
(the `pui hud` command swapped for a harmless sleeper so the smoke needs no
operator) so the swap presets are present.
"""
import json, os, re, queue, shutil, subprocess, sys, tempfile, threading, time
import fcntl, termios, struct

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
LAYOUT_RS = os.path.join(REPO, "apps", "tui", "src", "layout.rs")
WASM = os.environ.get("PUI_COMPANION_WASM",
                      os.path.expanduser("~/.papercusp/pui-companion.wasm"))
ZELLIJ = shutil.which("zellij") or os.path.expanduser("~/.cargo/bin/zellij")
SESSION = f"pui-dock-{os.getpid()}"

if not os.path.exists(WASM):
    sys.exit(f"plugin wasm not found at {WASM} — run scripts/build-install.sh first")
if not (ZELLIJ and os.path.exists(ZELLIJ)):
    sys.exit("zellij not found on PATH")

# Extract WORKBENCH_KDL from layout.rs (single source of truth) and swap the
# `pui hud` command for a sleeper so the smoke needs no operator.
src = open(LAYOUT_RS).read()
m = re.search(r'pub const WORKBENCH_KDL: &str = r#"(.*?)"#;', src, re.S)
if not m:
    sys.exit("could not find WORKBENCH_KDL in layout.rs")
kdl = m.group(1).replace('command "pui"', 'command "sleep"').replace('args "hud"', 'args "100000"')

spike = tempfile.mkdtemp(prefix="pui-dock-")
for d in ("cache/zellij", "config", "data", "run", "tmp"):
    os.makedirs(os.path.join(spike, d), exist_ok=True)
os.chmod(os.path.join(spike, "run"), 0o700)
with open(os.path.join(spike, "cache/zellij/permissions.kdl"), "w") as f:
    f.write(f'"{WASM}" {{\n    ReadApplicationState\n    ChangeApplicationState\n'
            f'    RunCommands\n    ReadCliPipes\n}}\n')
LAYOUT_PATH = os.path.join(spike, "workbench.kdl")
open(LAYOUT_PATH, "w").write(kdl)

ENV = dict(os.environ)
ENV.update(XDG_CACHE_HOME=f"{spike}/cache", XDG_CONFIG_HOME=f"{spike}/config",
           XDG_DATA_HOME=f"{spike}/data", XDG_RUNTIME_DIR=f"{spike}/run", TMPDIR=f"{spike}/tmp")
LOC = f"file:{WASM}"
log = lambda m: print(f"[dock] {m}", flush=True)
fails = []
def check(cond, msg):
    log(("PASS" if cond else "FAIL") + ": " + msg)
    if not cond:
        fails.append(msg)

# ── isolated zellij session, started WITH the workbench layout ───────────────
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
server = subprocess.Popen(
    [ZELLIJ, "--session", SESSION, "--new-session-with-layout", LAYOUT_PATH],
    stdin=slave, stdout=slave, stderr=slave, env=ENV, preexec_fn=os.setsid, close_fds=True)
os.close(slave)
def drain():
    try:
        while os.read(master, 65536):
            pass
    except OSError:
        pass
threading.Thread(target=drain, daemon=True).start()

def list_sessions():
    r = subprocess.run([ZELLIJ, "list-sessions", "-s"], env=ENV, capture_output=True, text=True)
    return r.stdout + r.stderr
ready = any(SESSION in list_sessions() or time.sleep(0.5) for _ in range(60))
check(ready, f"isolated session {SESSION} is up on the workbench layout")

def dump():
    r = subprocess.run([ZELLIJ, "--session", SESSION, "action", "dump-layout"],
                       env=ENV, capture_output=True, text=True)
    return r.stdout

def wait_dump(pred, timeout, what):
    """Poll the real layout until a mutation converges or a bounded deadline expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        layout = dump()
        if pred(layout):
            return layout
        time.sleep(0.25)
    log(f"timeout waiting for {what}")
    return None

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

def active_swap(ev):
    for t in ev.get("tabs", []):
        if t.get("active"):
            return t.get("swap_layout")
    return None

def wait_swap(name, timeout=10):
    return wait_for(lambda e: e.get("ev") == "topology" and active_swap(e) == name,
                    timeout, f"active swap preset = {name}")

def floating_section(d):
    """The body of the tab's `floating_panes { ... }` block (or '')."""
    m = re.search(r'floating_panes\s*\{(.*?)\n        \}', d, re.S)
    return m.group(1) if m else ""

# ── assertions ───────────────────────────────────────────────────────────────
send({"cmd": "hello"})
check(wait_for(lambda e: e.get("ev") == "hello", 30, "hello") is not None,
      "plugin handshake over the pipe")

# 1. Baseline topology arrives over the wire (tabs + panes). The active swap
# preset is asserted below, once we've driven it to a named target — zellij
# leaves the base arrangement's preset name unset until the first swap.
topo = wait_for(lambda e: e.get("ev") == "topology" and e.get("tabs"), 15, "baseline topology")
check(topo is not None, "baseline topology (tabs + panes) received over the wire")

# 2. stack-on-open: two stacked launches → both land in the work STACK.
send({"cmd": "open_command_pane", "command": "bash", "args": ["-c", "echo A1; sleep 300"],
      "title": "a1", "stack": True})
send({"cmd": "open_command_pane", "command": "bash", "args": ["-c", "echo A2; sleep 300"],
      "title": "a2", "stack": True})
appeared = wait_for(lambda e: e.get("ev") == "topology"
                    and sum("sleep 300" in (p.get("command") or "") for p in e["panes"]) >= 2,
                    15, "two launched panes in topology")
check(appeared is not None, "two stack:true launches opened panes (seen in topology)")
# Both agent panes sit inside a `stacked=true` group — the HUD was NOT split.
d = wait_dump(lambda layout: "stacked=true" in layout and layout.count("echo A") >= 2,
              15, "both launched agents in a stacked group")
check(d is not None,
      "stack-on-open: launched agents are in a stacked group (dump-layout)")
# The HUD pane (`name="pui"`, from the workbench KDL) keeps its OWN sized slot
# beside the stack — it wasn't absorbed (an absorbed pane loses its `size=`).
hud_layout = wait_dump(lambda layout: re.search(r'name="pui" size="\d+%"', layout) is not None,
                       15, "HUD in its own sized slot")
check(hud_layout is not None,
      "HUD pane survived in its own sized slot beside the stack")

# 3. select_swap_layout drives the active preset to a named target (the
# `:dock`/`:layout <name>` path) — each of the four presets is reachable by name.
send({"cmd": "select_swap_layout", "name": "grid"})
check(wait_swap("grid", 12) is not None, "select_swap_layout grid → active preset = grid")
send({"cmd": "select_swap_layout", "name": "split"})
check(wait_swap("split", 12) is not None, "select_swap_layout split → active preset = split")
send({"cmd": "select_swap_layout", "name": "stacked"})  # = `:dock right`
check(wait_swap("stacked", 12) is not None, "select_swap_layout stacked (:dock right) → active preset = stacked")
send({"cmd": "select_swap_layout", "name": "stacked-left"})  # = `:dock left`
check(wait_swap("stacked-left", 12) is not None, "select_swap_layout stacked-left (:dock left) → active preset follows")

# 4. next / prev swap-layout cycle the preset.
before = None
t0 = wait_for(lambda e: e.get("ev") == "topology", 5, "topology pre-cycle")
if t0: before = active_swap(t0)
send({"cmd": "next_swap_layout"})
nxt = wait_for(lambda e: e.get("ev") == "topology" and active_swap(e) != before, 10, "next preset")
check(nxt is not None and active_swap(nxt) != before, "next_swap_layout cycled the active preset")
send({"cmd": "prev_swap_layout"})
back = wait_swap(before, 10) if before else None
check(back is not None, "prev_swap_layout cycled back")

# 5. stack_panes by id gathers a named set (use the two agent pane ids).
send({"cmd": "select_swap_layout", "name": "grid"})
wait_swap("grid", 12)
time.sleep(1.0)
gtopo = wait_for(lambda e: e.get("ev") == "topology", 5, "grid topology")
agent_ids = [p["id"] for p in (gtopo["panes"] if gtopo else [])
             if "sleep 300" in (p.get("command") or "")]
if len(agent_ids) >= 2:
    send({"cmd": "stack_panes", "pane_ids": agent_ids})
    stacked_layout = wait_dump(lambda layout: "stacked=true" in layout,
                               15, "explicit stack_panes layout convergence")
    check(stacked_layout is not None, "stack_panes [ids] gathered the panes into a stack")
else:
    check(False, "stack_panes: could not resolve >=2 agent pane ids")

# 6. toggle_pane_float floats a work pane, then re-embeds it. (Scope the check to
# the AGENT pane — zellij's own about/tip pane also lives in floating_panes.)
if agent_ids:
    send({"cmd": "toggle_pane_float", "pane_id": agent_ids[0]})
    floated_layout = wait_dump(lambda layout: "sleep 300" in floating_section(layout),
                               15, "agent pane to enter floating_panes")
    check(floated_layout is not None,
          "toggle_pane_float floated the agent pane (in floating_panes)")
    send({"cmd": "toggle_pane_float", "pane_id": agent_ids[0]})
    embedded_layout = wait_dump(lambda layout: "sleep 300" not in floating_section(layout),
                                15, "agent pane to leave floating_panes")
    check(embedded_layout is not None,
          "toggle_pane_float re-embedded the agent pane")

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
log("RESULT: ALL DOCK-VERB LIVE CHECKS PASSED")
