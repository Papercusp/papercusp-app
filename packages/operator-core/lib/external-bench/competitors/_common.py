"""
Shared contract for the P-028 competitor-orchestrator runners (impartial-benchmark-suite-2026-06-15, D-010).

Each `run_<framework>.py` is invoked by the TS live driver (competitor-live.ts) via execFile against the
framework's own venv (~/.papercusp/competitors/{,openhands-}venv). Protocol — ONE JSON object in on stdin,
ONE result JSON out on stdout (sentinel-delimited so framework banners/logs on stdout don't corrupt it):

  IN : {"repoDir","instanceId","problemStatement","model","baseUrl"?,"apiKeyEnv"?,"maxIterations"?,"selfcheck"?}
  OUT: <SENTINEL>{"ok",bool, "tokensIn",int,"tokensOut",int,"costUsd",float,"turns",int,
                  "stopReason","done|max-turns|error","events":[{ts,kind,agent,taskId,detail}],"error":str|null}

The runner MUTATES repoDir in place (edits files to address problemStatement); the DIFF is extracted by the
TS driver via `git diff` against the base commit — identical to every other arm, so grading is byte-fair.
`selfcheck:true` constructs the agent/tools but makes NO LLM call (validates wiring with zero Opus spend).
"""
import json
import os
import subprocess
import sys
import time

RESULT_SENTINEL = "@@COMPETITOR_RESULT@@"

# MAST-convertible coordination event kinds (a subset of bench-metrics CoordEventKind).
KIND_SPAWN = "spawn"
KIND_HANDOFF = "handoff"
KIND_MESSAGE = "message"
KIND_EDIT = "edit"
KIND_COMPLETE = "complete"
KIND_ERROR = "error"


def read_input() -> dict:
    return json.loads(sys.stdin.read() or "{}")


class EventLog:
    """Records the MAST coordination trace; ts = ms since run start (clock-portable)."""

    def __init__(self) -> None:
        self._t0 = time.monotonic()
        self.events: list[dict] = []

    def add(self, kind: str, agent: str, task_id=None, detail=None) -> None:
        self.events.append(
            {
                "ts": int((time.monotonic() - self._t0) * 1000),
                "kind": kind,
                "agent": agent,
                "taskId": task_id,
                "detail": (detail[:500] if isinstance(detail, str) else detail),
            }
        )


def emit(result: dict) -> None:
    """Write the single result record, sentinel-prefixed, and flush."""
    sys.stdout.write("\n" + RESULT_SENTINEL + json.dumps(result) + "\n")
    sys.stdout.flush()


def ok_result(*, tokens_in=0, tokens_out=0, cost_usd=0.0, turns=0, stop_reason="done", events=None, extra=None) -> dict:
    r = {
        "ok": True,
        "tokensIn": int(tokens_in),
        "tokensOut": int(tokens_out),
        "costUsd": float(cost_usd),
        "turns": int(turns),
        "stopReason": stop_reason,
        "events": events or [],
        "error": None,
    }
    if extra:
        r.update(extra)
    return r


def error_result(msg: str, events=None) -> dict:
    return {
        "ok": False,
        "tokensIn": 0,
        "tokensOut": 0,
        "costUsd": 0.0,
        "turns": 0,
        "stopReason": "error",
        "events": events or [],
        "error": str(msg)[:1000],
    }


def configure_anthropic_env(inp: dict) -> str:
    """
    Resolve the Anthropic creds the framework's LLM layer will read. Returns the model string. baseUrl points
    every arm at the SAME inference gateway (fair routing + shared accounts + counted cost — the bees' path);
    the gateway STRIPS + reinjects the real OAuth, so the key need only be SET (any value) for the SDKs not to
    error. Sets BOTH ANTHROPIC_BASE_URL (anthropic SDK / langchain) AND ANTHROPIC_API_BASE (litellm / crewai)
    so every framework routes through the gateway uniformly.
    """
    base_url = inp.get("baseUrl")
    if base_url:
        os.environ["ANTHROPIC_BASE_URL"] = base_url
        os.environ["ANTHROPIC_API_BASE"] = base_url  # litellm (crewai) reads this, NOT ANTHROPIC_BASE_URL
    key_env = inp.get("apiKeyEnv") or "ANTHROPIC_API_KEY"
    key = os.environ.get(key_env) or ("sk-gateway-routed" if base_url else "")
    if key:
        os.environ["ANTHROPIC_API_KEY"] = key
    return inp.get("model") or "claude-opus-4-8"


def thinking_config(inp: dict) -> tuple[int, int]:
    """
    The xhigh extended-thinking realization: returns (budget_tokens, max_tokens). Every arm runs
    claude-opus-4-8 @ xhigh; for the raw-API frameworks that means extended thinking at `budget_tokens`
    (the `--effort xhigh` equivalent — the claude CLI owns the canonical mapping, so the budget is supplied
    by the TS driver and confirmed with the owner). max_tokens must exceed the thinking budget.
    """
    budget = int(inp.get("thinkingBudgetTokens") or 0)
    max_tokens = int(inp.get("maxTokens") or 0)
    if budget > 0 and max_tokens <= budget:
        max_tokens = budget + 16384
    if max_tokens <= 0:
        max_tokens = 16384
    return budget, max_tokens


def litellm_model(model: str) -> str:
    """litellm/crewai needs the provider-prefixed id (anthropic/<model>)."""
    return model if "/" in model else f"anthropic/{model}"


def bare_model(model: str) -> str:
    """langchain ChatAnthropic / the anthropic SDK want the bare id (no provider prefix)."""
    return model.split("/", 1)[1] if model.startswith("anthropic/") else model


def make_file_tools(repo_dir: str, log: EventLog, agent: str):
    """
    Minimal, framework-agnostic file/shell tools bound to repo_dir, each emitting a coordination event. Returns
    plain python callables; each framework wraps them in its own tool type. Paths are confined to repo_dir.
    """

    def _safe(path: str) -> str:
        full = os.path.realpath(os.path.join(repo_dir, path))
        if not (full == os.path.realpath(repo_dir) or full.startswith(os.path.realpath(repo_dir) + os.sep)):
            raise ValueError(f"path escapes repo: {path}")
        return full

    def read_file(path: str) -> str:
        with open(_safe(path), "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    def write_file(path: str, content: str) -> str:
        full = _safe(path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
        log.add(KIND_EDIT, agent, detail=path)
        return f"wrote {len(content)} bytes to {path}"

    def list_dir(path: str = ".") -> str:
        return "\n".join(sorted(os.listdir(_safe(path))))

    def run_shell(command: str) -> str:
        log.add(KIND_MESSAGE, agent, detail=f"$ {command}")
        try:
            out = subprocess.run(
                command, shell=True, cwd=repo_dir, capture_output=True, text=True, timeout=300
            )
            return (out.stdout + out.stderr)[-4000:]
        except subprocess.TimeoutExpired:
            return "command timed out after 300s"

    return {"read_file": read_file, "write_file": write_file, "list_dir": list_dir, "run_shell": run_shell}


def main(run_fn) -> None:
    """Shared entrypoint: parse input, run the framework fn, emit the result, never crash uncaught."""
    try:
        inp = read_input()
    except Exception as e:  # noqa: BLE001
        emit(error_result(f"bad input json: {e}"))
        return
    try:
        result = run_fn(inp)
    except Exception as e:  # noqa: BLE001
        import traceback

        emit(error_result(f"{e}\n{traceback.format_exc()[-1500:]}"))
        return
    emit(result)
