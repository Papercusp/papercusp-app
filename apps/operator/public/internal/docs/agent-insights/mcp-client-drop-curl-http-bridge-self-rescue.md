# MCP client dropped after /loop? Self-rescue via the curl HTTP-bridge (EI-1740)
URL: /internal/docs/agent-insights/mcp-client-drop-curl-http-bridge-self-rescue

Merged into agent-insights/mcp-client-drop-curl-recovery; retained as a historical redirect for existing links.

## Symptom

Mid-session, every `mcp__papercusp-su__*` tool vanishes — the harness emits
`480 deferred tools no longer available (MCP server disconnected): mcp__papercusp-su__*`
— and `ToolSearch` for them returns nothing. Observed to fire **right after a
`/loop` slash-command is processed** (EI-1740 / WI-260 / WI-258; corroborated
across ≥2 agents). It does **not** auto-reconnect (observed dark 5h+).

Key tell: the operator `:3070` stays **healthy** (`curl :3070/api/health` → 200)
**AND `/api/mcp` itself answers promptly** (a short-timeout `initialize` POST
returns, doesn't hang). Check both — `/api/health` alone is not enough: it
answers off a trivial path and stays fast even when the event loop is
saturated, so a 200 there does not by itself prove the MCP route is healthy
(EI-19420557240747274). If `/api/health` is 200 but `/api/mcp` **times out**,
that's server-side saturation, not a client drop — see
[surviving-an-operator-wedge-mcp-severance](/agent-insights/surviving-an-operator-wedge-mcp-severance/)
instead; the bridge below traverses the same wedged loop and won't rescue you
in that case. When both checks are healthy: this is a **client-side**
disconnect, not a backend outage. The MCP *server* is still up and serving
every other agent — only *your* client dropped.

## Self-rescue: drive the MCP server directly over HTTP

`papercusp-su` is an HTTP MCP server. Its endpoint + bearer live in your own
`~/.claude.json` (`mcpServers."papercusp-su"`). You can issue the exact same
`tools/call` the client would, via curl — this fully restores coord / plans /
work\_items. Drop-in helper:

```bash
cat > /tmp/psu.sh << 'SCRIPT'
#!/bin/bash
# psu.sh <tool> [args-json]  — call papercusp-su MCP over HTTP when the client is down
TOOL="$1"; ARGS="${2:-{}}"
# PIN to your SESSION su id — NOT $PAPERCUSP_SID (it drifts to a fresh per-shell id).
# Get the right one from coord:whoami output captured while the client was alive.
SID="su-XXXXXXXX-....."
BEARER=$(python3 -c "import json;print(json.load(open('$HOME/.claude.json'))['mcpServers']['papercusp-su']['headers']['Authorization'])")
URL="http://localhost:3070/api/mcp?superuser=1&client=${SID}&workspace=papercusp-workspace&profile="
for a in 1 2 3; do
  OUT=$(curl -s -m 45 -H "Authorization: $BEARER" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-06-18' \
    -X POST "$URL" --data "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}" 2>/dev/null \
    | grep '^data:' | sed 's/^data: //' | tail -1)
  [ -n "$OUT" ] && break; sleep 2
done
echo "$OUT" | python3 -c "import json,sys
raw=sys.stdin.read().strip()
if not raw: print('EMPTY-AFTER-RETRY'); sys.exit()
d=json.loads(raw); c=d.get('result',{}).get('content',[])
print(c[0]['text'] if c else json.dumps(d))"
SCRIPT
chmod +x /tmp/psu.sh
bash /tmp/psu.sh "coord:whoami"
bash /tmp/psu.sh "coord:inbox" '{"limit":6}'
bash /tmp/psu.sh "plans:set-status" '{"harness":"papercusp","slug":"<plan>","itemId":"P-001","status":"wip"}'
```

## Three gotchas that will bite you

1. **Server-side tool names are COLON form** — `coord:send`, `plans:set-status`,
   `work_items:claim` — NOT the underscore Claude-facing names (`coord_send`).
   Wrong form → `unknown_tool`. `tools/list` returns the exact names.
2. **PIN `client` to your SESSION su id.** `$PAPERCUSP_SID` in a Bash subprocess
   drifts to a *fresh per-shell* id (e.g. `su-d302a10b…`) while your real session
   identity (the `ownerId` from `coord:whoami` at session start, e.g.
   `su-7414d69e…`) is different. `superuser=1` echoes back whatever `client` you
   pass, so the wrong id silently fragments your presence / could impersonate a
   live peer. Capture your real id from the first `coord:inbox`/`whoami` of the run.

   Use your real id for BOTH reads and writes — both work. (A controlled
   back-to-back test on 2026-06-20 refuted an earlier guess that the *dropped*
   id's writes hang: identical writes under the dropped id AND a fresh id behaved
   the same — both succeed in a good wedge-window, both time out in a bad one.
   So **don't switch identities to "fix" a hanging write** — the cause is the
   operator wedge, not your id; see the limitation below.) One real id caveat:
   don't address a message `to:` the drifted `$PAPERCUSP_SID` value — it's not a
   registered recipient (`unknown_recipient`).
3. **`workspace=papercusp-workspace` is required** or you get
   `request_rejected: scoped_superuser_workspace_unresolved`.

## Known limitation — heavy WRITES vs the operator wedge

Light reads (`coord:whoami`, `work_items:get`, `plans:get`, `coord:inbox`) return
fast and reliably. But **bridge writes are best-effort under operator load** — they
mostly time out and only occasionally land in a good window. What's actually
*verified* (don't over-read it): (a) live peers on the normal client path landed
\~38 coord messages / 5 min while my bridge `coord:send`s (even a 1-char body)
mostly timed out; (b) a 1-char `coord:send` DID land in one window, so writes
aren't categorically broken; (c) heavy writes (`plans:set-status` — plan revision

* federation) time out across the board. The root cause is **not** isolated to the
  `superuser=1` path: the superuser auth/scoping in `_mcp-handler.ts` does no extra
  *write* work when you pass `?workspace=` (no `workspaceForCoordOwner` lookup), and
  the `coord:send` tool body is identical code for superuser and normal clients — so
  the likely cause is just the loaded write path (`coord_event_log`/federation) plus
  an intermittent fresh-curl client being disadvantaged vs persistent warm sessions,
  NOT a superuser-specific bug. (The non-superuser *instant reject*,
  `spawn_sig_missing_sig_required_mode`, only shows the early auth check differs — it
  does not prove the write path is faster there.) Practical takeaway: **reads are
  your reliable channel; for writes, send tiny single-recipient payloads, retry
  opportunistically, and put durable findings in a runbook** (git-sync, no coord
  write). `/api/health` staying 200 does NOT mean the write-path is free.

Observed write throughput under a *bad* wedge (2026-06-20): it FLUCTUATES — a
**tiny** single-recipient `coord:send` (body `"x"`) lands in `<1s` in a good
window yet times out in a bad one minutes later, a \~1KB-body `coord:send` times
out even in a fair window, and a heavy `plans:set-status` (plan revision +
federation) times out across the board. (This is the wedge, not your identity.)
So under a deep wedge you can only reliably push **trivial** writes —
send a one-line pointer ("see runbook X / details in plan Y") rather than a long
body, retry the substantive write opportunistically when the wedge clears, and
**don't pile retries onto a wedged loop** (you add to the very load blocking you).
Put durable findings in an `agent-insights` runbook (rides git-sync, needs no
coord write) instead of fighting the write-path.

## Don't

* Don't conclude the backend is down — check `/api/health` first (it's a *client* drop).
* Don't keep "working blind" assuming you have no coordination — the HTTP-bridge restores it.
* Don't use `$PAPERCUSP_SID` as the client id, or the underscore tool names.
