# MCP tools vanished mid-session — client transport death, self-diagnosis + the auto-heal
URL: /internal/docs/agent-insights/mcp-transport-death-self-diagnosis

A Claude Code self-re-exec (auto-update relaunch / TUI fullscreen switch) severs the session's papercusp-su HTTP-MCP transport while the SERVER stays healthy — tools vanish, and the armed loop's events:await registration + every MCP carry surface (loop:checkpoint, facts:assert) die with it. Diagnose with a bash curl of the :9071 initialize handshake; park state in FILES; the fix is client-side (/mcp reconnect or the P-005 auto-heal), never a server restart.

## The failure shape (su-39f07, 2026-07-13 — 5h dark)

Mid-session, every `mcp__papercusp*` tool disappears ("MCP server disconnected").
The instinct is "the operator is down" — **verify before concluding**, because in
this class the server is fine and the CLIENT died:

```bash
curl -s -m 8 -o /dev/null -w "HTTP %{http_code}\n" -X POST \
  "http://127.0.0.1:9071/api/mcp?superuser=1" \
  -H "Authorization: Bearer <your .claude.json papercusp-su token>" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"0"}}}'
```

HTTP 200 with a serverInfo body ⇒ **the server is healthy; your session's
transport is severed** — typically by a Claude Code self-re-exec (auto-update
relaunch or TUI fullscreen switch; the launcher now sets `DISABLE_AUTOUPDATER=1`
to kill the main trigger). Restarting the operator or the :9071 proxy will NOT
fix it and needlessly blips every healthy session.

## The blast radius is bigger than "tools gone"

Everything registered on the dead transport dies silently with it:

* your **armed loop** — the `events:await` inbox-wake re-registration is an MCP
  call, so the loop stops firing (the routine row stays `active`, which is
  exactly the signal the watchdog keys on);
* your **carry surfaces** — `loop:checkpoint`, `facts:assert`,
  `work_items:checkpoint`, `memory:remember` are all MCP. **Park state in FILES**
  (your memory directory / scratchpad) until the transport is back;
* your **coord presence** — peers see you going stale; you cannot read your own
  inbox.

## What heals it

1. **The auto-heal (mcp-transport-resilience P-005)**: the mcp-dark watchdog's
   interactive sweep detects "live psu-pty host + frozen tool-call presence
   beat" within \~1–2 sweep intervals and injects the host-side `/mcp` dialog
   macro (`mode:'mcp-reconnect'`) — your terminal and context survive. After a
   confirmed heal you get ONE wake telling you to re-arm your loop and re-park
   state — **do both**.
2. **Manual**: the owner types `/mcp` in the session's terminal → reconnect
   `papercusp-su`. (An agent cannot run `/mcp` on itself — the client owns the
   transport.)
3. **Headless sessions** only: kill + `psu --resume` — the transport
   re-initializes at launch. Never the first resort for a headed session
   (owner directive, 2026-07-13).

## While dark, an agent should

1. Diagnose (the curl above) — do not blame the server without it.
2. Park all in-flight state in files; note the transcript survives on disk and
   is recoverable after reconnect.
3. Surface plainly to the owner: "MCP transport dead client-side; server
   verified healthy; `/mcp` reconnect fixes it" — then keep doing whatever
   file/bash-only work remains useful.
