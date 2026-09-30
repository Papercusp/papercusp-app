#!/usr/bin/env bash
# Regenerate the pinned MCP tool manifest from the LIVE registry.
#
# Writes every currently-exposed tool name to the manifest file. After this,
# the operator serves that frozen set for tools/list (byte-stable across
# reconnects) so adding tools during development no longer busts a live
# session's prompt cache. Run this deliberately, when you want newly-added
# tools to become visible to agents — then restart the operator so it reloads
# the manifest.
#
# Requires the operator running (Tauri dev shell). Uses ?manifestBypass=1 so it
# captures the FULL set even when a manifest is already in effect.
#
#   packages/agent-mcp/snapshot-tools.sh             # write ~/.papercusp/tool-manifest.json
#   packages/agent-mcp/snapshot-tools.sh --print     # print names, don't write
#   AGENT_MCP_TOOL_MANIFEST=/path snapshot-tools.sh  # custom location
set -euo pipefail

BASE="${PAPERCUSP_MCP_BASE:-http://localhost:3070/api/mcp}"
TOKEN="$(cat "${PAPERCUSP_SUPERUSER_TOKEN:-$HOME/.papercusp/superuser-token}" 2>/dev/null || true)"
OUT="${AGENT_MCP_TOOL_MANIFEST:-$HOME/.papercusp/tool-manifest.json}"
[ -n "$TOKEN" ] || { echo "ERROR: no superuser token (~/.papercusp/superuser-token)"; exit 1; }

RESP="$(curl -s -X POST "${BASE}?superuser=1&manifestBypass=1" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"

python3 - "$RESP" "$OUT" "${1:-}" <<'PY'
import sys, json, re, os
resp, out, flag = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "")
# response may be SSE — pull the JSON-RPC object out
m = re.search(r'\{.*\}', resp, re.S)
if not m:
    print("ERROR: no JSON in response:", resp[:200]); sys.exit(1)
data = json.loads(m.group(0))
tools = data.get("result", {}).get("tools", [])
names = sorted({t["name"] for t in tools if "name" in t})
if not names:
    print("ERROR: tools/list returned no tools — is the operator up?"); sys.exit(1)
if flag == "--print":
    print("\n".join(names)); print(f"\n# {len(names)} tools (not written)"); sys.exit(0)
os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump({"tools": names}, open(out, "w"), indent=2)
print(f"wrote {len(names)} tool names -> {out}")
print("Restart the operator for the pinned manifest to take effect.")
print("To CURATE, hand-edit that file down to the tools you actually want exposed.")
PY
