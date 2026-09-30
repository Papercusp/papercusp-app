# Stranded after your papercusp-su MCP tools vanished? Recover in seconds via curl
URL: /internal/docs/agent-insights/mcp-client-drop-curl-recovery

A papercusp-su MCP client can drop mid-session while the operator remains healthy. Probe both endpoints, then use the committed stateless curl helper or HTTP tools/call bridge with an explicit session identity; recognize operator wedges and avoid retry storms.

## Symptom

Your `mcp__papercusp-su__*` tools disappear mid-session: a system-reminder says the
MCP server disconnected, and `ToolSearch` returns **"No matching deferred tools"**
for every one. Seen after a `/loop` slash-command and when a `:3070` request
worker restarts/wedges. Hit ≥5 agents in one night (EI-1740, EI-1750).

The **server is healthy** — the drop is the Claude Code MCP *client*, which does
not re-handshake a dropped streamable-HTTP/SSE connection. A manual `/mcp`
reconnect (or session restart) fixes it — but in an unattended auto-mode loop you
can't run `/mcp`. So route around it.

## Symptom variant: an ECONNREFUSED on an unrelated local port, THEN a silent hang

EI-19384363493799969 (2026-08-02, ≥4th independent hit of this whole class):
before the familiar "tools vanish" symptom above, the FIRST `mcp__papercusp-su__*`
call of the session/wake can fail **instantly** with something like
`connect ECONNREFUSED 127.0.0.1:22060` — a port that matches **no** papercusp
service (`:3070` operator, `:9071` mcp-proxy, `:9073` gateway all confirmed up via
`ss -ltnp` in the same incident). Nothing on the host listens there; it reads as a
Claude-Code-internal per-session ephemeral bridge/sandbox-proxy port that had not
(re)established yet. A **second** identical call also refuses. Then, \~25s later,
the *same* tool transitions from instant-refuse to a **silent 300s+ hang** (no
response/progress) until the harness's own MCP idle timeout aborts it.

Throughout, a direct `curl` `tools/call` to the exact proxy URL in `~/.claude.json`
(see below / `scripts/mcp-call.mjs`) answers every call in well under 1.5s — so
this is confirmed the same class as the rest of this doc (a wedged **client**, not
a slow/down server), just with a distinguishing two-phase precursor
(instant-refuse-on-an-unrelated-port → then a full hang) instead of a clean
"tools vanish" drop. Recognizing this signature immediately — rather than
spending several minutes assuming "all my tools are broken" — is the entire value
of this addendum; the recovery is identical to the rest of this doc. The
ECONNREFUSED port itself is Claude-Code-CLI-internal (outside papercusp's
codebase), so there is no papercusp-side code fix for the underlying wedge — only
faster recognition + the curl/`mcp-call.mjs` route-around below.

## Verify the server is up (do this — it's not optional, it decides which runbook applies)

```bash
curl -s -i -m 8 -X POST 'http://localhost:3070/api/mcp?superuser=1&client=probe&workspace=papercusp-workspace' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

A 200 with a `serverInfo` SSE `data:` line in under a couple seconds = the
server is fine; only your client dropped — the recovery below applies.

**If this call itself times out (hangs, no response) rather than erroring
fast** — do NOT conclude "server down" and do NOT assume the curl recipes
below will save you. A prior `curl :3070/api/health` returning 200 does not
rule this out either: `/api/health` answers off a trivial path and stays fast
even when the event loop is saturated, while `/api/mcp` does real work and
queues behind the saturation (EI-19420557240747274). A hang here means the
operator's event loop is **wedged**, not that your client merely dropped —
this doc's bridge traverses the exact same wedged route your MCP client used,
so it will hang too. Go to
[surviving-an-operator-wedge-mcp-severance](/agent-insights/surviving-an-operator-wedge-mcp-severance/)
instead: back off, don't retry-storm, stage writes for the next open window.

## Fastest recovery: the committed helper

```bash
node scripts/mcp-call.mjs <ns:verb> '<jsonArgs>' --client <your-su-id> [--harness <h>]
# e.g.  node scripts/mcp-call.mjs work_items:claim '{"id":"EI-1234"}' --harness papercup --client su-abcd
```

`scripts/mcp-call.mjs` (also `npm run mcp:call`) wraps the recipe below — reads
the bearer, defaults `workspace=papercusp-workspace`, parses the SSE, prints the
result. Pass your OWN `--client` so coord/plan writes attribute to you. Prefer
this over hand-rolling a `/tmp` script (several agents collided on `/tmp/mcp.py`).

## Recovery: single-shot stateless `tools/call` via curl

The endpoint is **stateless** — no `initialize`/`Mcp-Session-Id` handshake needed
per call; `tools/call` works directly with the superuser bearer.

* URL: `http://localhost:3070/api/mcp?superuser=1&client=<your-su-id>&workspace=papercusp-workspace&harness=<h>`
* Headers: `Content-Type: application/json`, `Accept: application/json, text/event-stream`,
  **`Authorization: Bearer $(cat ~/.papercusp/superuser-token)`** — `superuser=1` ALONE
  returns `superuser_invalid_bearer`; the 31-char token is required.
* Body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<ns:verb>","arguments":{...}}}`
* Response is **SSE** — parse `^data:` lines; the JSON-RPC `result.content[0].text` is
  itself JSON.

Tool names use **colons**: `coord:whoami`, `coord:inbox`, `coord:send`,
`coord:declare-intent`, `plans:new` (`force:true` past `similar_exists`),
`plans:add-item`/`plans:set-status` (arg is **`itemId`**, not `item`),
`work_items:create`/`claim`/`comment`/`set_state`, `memory:remember`. Note:
`tools/list` returns empty in this mode, but `tools/call` reaches **every** tool.

Use your OWN `client=<su-id>` so coord/plan writes attribute to you (and pick a
**unique** temp path for any helper script — `/tmp/mcp.py` collides when several
auto-mode agents adopt this at once).

### Minimal Python driver

```python
import json, os, urllib.request, sys
TOK = open(os.path.expanduser('~/.papercusp/superuser-token')).read().strip()
URL = 'http://localhost:3070/api/mcp?superuser=1&client=<your-su-id>&workspace=papercusp-workspace&harness=papercup'
def mcp(tool, args=None):
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call",
                       "params":{"name":tool,"arguments":args or {}}}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        'Content-Type':'application/json','Accept':'application/json, text/event-stream',
        'Authorization':'Bearer '+TOK})
    raw = urllib.request.urlopen(req, timeout=60).read().decode()
    for ln in raw.splitlines():
        if ln.startswith('data:'):
            d = json.loads(ln[5:].strip())
            tx = d.get('result',{}).get('content',[{}])[0].get('text')
            return json.loads(tx) if tx else d
```

Proven (2026-06-20, EI-1750) to run a full work-queue session — materialize a plan,
claim/comment/resolve work items, `coord:send`, and `memory:remember` — entirely
through this path while the harness client stayed dropped.

## The proper fix (server side, in review)

EI-1750(a): a keepalive/heartbeat on the `/api/mcp` SSE stream so a brief worker
stall doesn't silently kill client sessions. MCP transport is sensitive — under
peer review before implementation. This runbook (EI-1750(b)) is the recover-now
stopgap. Related: \[\[/agent-insights/transient-signal-over-reaction]].

## Identity, continuity, and bridge gotchas

The bridge is stateless, but its writes still need a stable caller identity. Pass the su id for **this session** in `client=` (the id returned by `coord:whoami`), not a transient shell's `$PAPERCUSP_SID` if they differ. Confirm with `coord:whoami` before a critical write. A drifted or guessed id can fragment presence and attribution, even though the HTTP call itself succeeds.

The server's superuser identity precedence is now explicit: `x-papercusp-client` header, then `?client=`, then `Mcp-Session-Id`. An explicit per-launch SID therefore wins over a transport-session id after reconnects (EI-7066 / EI-1753). `Mcp-Session-Id` is only a fallback when no explicit SID was supplied.

If a shell was launched outside `psu`, the HTTP bridge still works, but writes may resolve to a shared fallback identity (`su-loopback` / `su-http-loopback`) when no `client` is supplied. Prefer an explicit session id; do not regenerate tokens or rewrite client configuration just to repair a dropped stream.

## When to use this bridge vs. wait

Use the bridge when `/api/health` is 200 **and** the `/api/mcp` initialize probe answers promptly: that combination identifies a dropped client stream while the operator is healthy. If `/api/mcp` times out, the operator event loop is saturated and this bridge traverses the same path; stop retrying and follow the operator-wedge runbook instead. If both endpoints fail, the operator itself is down and the bridge cannot help.

Light reads usually remain reliable during a wedge. Heavy writes can time out or land intermittently, so send small, single-recipient coordination messages and put durable details in the work-item or this runbook. Do not retry-storm a saturated operator.

## The server-side fix and scope

The curl bridge is a recover-now route-around for a client-side disconnect; it does not repair the underlying MCP stream lifecycle. Keepalive/reconnect work belongs in the MCP transport layer (EI-1750). The bridge remains useful for unattended loops because it can call the same stateless `tools/call` endpoint while the client is unavailable.

## Don't

* Don't infer an operator outage from a missing client tool; probe `/api/mcp`, not only `/api/health`.
* Don't use a guessed, drifted, or peer's `client` id for writes.
* Don't use underscore-form tool names; the HTTP endpoint expects colon-form names such as `coord:send` and `work_items:complete`.
* Don't keep polling or piling retries onto a wedged operator; stage durable work and recover when the MCP route is responsive.
