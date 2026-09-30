"""
P-028 LangGraph competitor arm. A planner→worker graph: a planner agent (one LLM call) decomposes the issue,
then a ReAct worker agent (langgraph.prebuilt.create_react_agent) with file/shell tools edits the repo. The
graph topology IS the coordination MAST measures. Run in ~/.papercusp/competitors/venv (langgraph + langchain-anthropic).
"""
import _common as C


def _llm(model: str, budget: int, max_tokens: int):
    from langchain_anthropic import ChatAnthropic

    # ChatAnthropic reads ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL from env (set by configure_anthropic_env).
    kwargs = dict(model=C.bare_model(model), max_tokens=max_tokens, timeout=600)
    if budget > 0:
        # Extended thinking = the xhigh effort realization; Anthropic requires temperature=1 with thinking on.
        kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
        kwargs["temperature"] = 1
    return ChatAnthropic(**kwargs)


def _tools(repo_dir: str, log: "C.EventLog"):
    from langchain_core.tools import StructuredTool

    fns = C.make_file_tools(repo_dir, log, agent="worker")
    return [
        StructuredTool.from_function(fns["read_file"], name="read_file", description="Read a file (path relative to repo root)."),
        StructuredTool.from_function(fns["write_file"], name="write_file", description="Write/overwrite a file with full new content."),
        StructuredTool.from_function(fns["list_dir"], name="list_dir", description="List a directory (relative to repo root)."),
        StructuredTool.from_function(fns["run_shell"], name="run_shell", description="Run a shell command in the repo (tests, grep, build)."),
    ]


def _usage(msgs) -> tuple[int, int, int]:
    tin = tout = turns = 0
    for m in msgs:
        um = getattr(m, "usage_metadata", None)
        if um:
            tin += um.get("input_tokens", 0)
            tout += um.get("output_tokens", 0)
        if getattr(m, "type", "") == "ai":
            turns += 1
    return tin, tout, turns


def run(inp: dict) -> dict:
    model = C.configure_anthropic_env(inp)
    budget, max_tokens = C.thinking_config(inp)
    repo_dir = inp["repoDir"]
    problem = inp.get("problemStatement", "")
    max_iter = int(inp.get("maxIterations") or 40)
    log = C.EventLog()

    llm = _llm(model, budget, max_tokens)
    tools = _tools(repo_dir, log)

    from langgraph.prebuilt import create_react_agent

    worker = create_react_agent(llm, tools)

    if inp.get("selfcheck"):
        log.add(C.KIND_SPAWN, "planner")
        log.add(C.KIND_SPAWN, "worker")
        return C.ok_result(turns=0, stop_reason="done", events=log.events, extra={"selfcheck": True})

    log.add(C.KIND_SPAWN, "planner")
    plan_msg = llm.invoke(
        f"You are the PLANNER for a coding task. Produce a short, concrete plan (numbered steps) to resolve "
        f"this issue in the repository. Do not write code yet.\n\nISSUE:\n{problem}"
    )
    tin, tout, _ = _usage([plan_msg])
    plan = plan_msg.content if isinstance(plan_msg.content, str) else str(plan_msg.content)
    log.add(C.KIND_HANDOFF, "planner", detail="plan -> worker")
    log.add(C.KIND_SPAWN, "worker")

    prompt = (
        "You are the WORKER. Implement the fix in the repository using the tools (read_file/write_file/"
        "list_dir/run_shell). Make the minimal correct change; verify with the repo's tests if present. "
        f"\n\nISSUE:\n{problem}\n\nPLAN:\n{plan}"
    )
    stop_reason = "done"
    try:
        result = worker.invoke(
            {"messages": [("user", prompt)]},
            config={"recursion_limit": max_iter},
        )
        msgs = result.get("messages", [])
    except Exception as e:  # recursion/other → still grade whatever was written
        if "recursion" in str(e).lower():
            stop_reason = "max-turns"
            msgs = []
        else:
            raise
    wtin, wtout, turns = _usage(msgs)
    log.add(C.KIND_COMPLETE, "worker")
    return C.ok_result(
        tokens_in=tin + wtin, tokens_out=tout + wtout, turns=turns + 1, stop_reason=stop_reason, events=log.events
    )


if __name__ == "__main__":
    C.main(run)
