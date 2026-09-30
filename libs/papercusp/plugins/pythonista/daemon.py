#!/usr/bin/env python3
"""
Pythonista — Batch I7 daemon smoke.

Reads newline-delimited JSON-RPC 2.0 from stdin, writes responses
to stdout (one JSON per line). Supports two methods:

  papercup.ping
    No params. Returns {"pong": true}. The supervisor's health-check
    loop calls this every healthInterval ms.

  papercup.invokeAction
    Params: { action, payloadB64 }
    For action="run-script": payload is a UTF-8 expression; we eval()
    it and return repr(result) base64-encoded. (Eval is intentionally
    sandboxed to a small builtin set — this is a smoke plugin, not a
    safe code-execution harness.)

Stderr is reserved for free-form logs the supervisor pipes to onLog.
"""
import base64
import json
import sys

SAFE_BUILTINS = {
    "abs": abs, "len": len, "min": min, "max": max, "sum": sum,
    "range": range, "list": list, "dict": dict, "tuple": tuple,
    "str": str, "int": int, "float": float, "bool": bool,
}

def reply(req_id, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

def main():
    sys.stderr.write("[pythonista] daemon ready\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"[pythonista] parse error: {e}\n")
            continue
        method = req.get("method")
        rid = req.get("id")
        params = req.get("params") or {}
        if method == "papercup.ping":
            reply(rid, result={"pong": True})
        elif method == "papercup.invokeAction":
            action = params.get("action")
            payload_b64 = params.get("payloadB64", "")
            try:
                payload = base64.b64decode(payload_b64).decode("utf-8")
            except Exception as e:
                reply(rid, error={"code": -32602, "message": f"invalid payloadB64: {e}"})
                continue
            if action != "run-script":
                reply(rid, error={"code": -32601, "message": f"unknown action: {action}"})
                continue
            try:
                result = eval(payload, {"__builtins__": SAFE_BUILTINS}, {})
                out = repr(result).encode("utf-8")
                reply(rid, result={"payloadB64": base64.b64encode(out).decode()})
            except Exception as e:
                reply(rid, error={"code": -32000, "message": f"eval error: {e}"})
        else:
            reply(rid, error={"code": -32601, "message": f"unknown method: {method}"})

if __name__ == "__main__":
    main()
