"""
P-028 OpenHands competitor arm — the closest external analog to the Queen+fleet (async sub-agent delegation;
cf. OpenHands CAID, arXiv 2603.21489). Uses the OpenHands SDK (v1.27) one-shot: LLM + Agent + default tools
(terminal + file editor) with sub-agents ENABLED (the async-delegation coordination MAST measures), driven over
a LocalWorkspace at the cloned repo. Run in ~/.papercusp/competitors/openhands-venv (openhands-ai).

NOTE: the fine-grained event→CoordEvent mapping (per-delegation hand-offs from conversation.state.events) is
intentionally COARSE here — the SDK event-object schema is verified against a REAL run at the gated pilot, when
the events can be inspected. The structural spawn/complete + token/turn telemetry is exact now.
"""
import os

import _common as C


def _build(inp: dict):
    from openhands.sdk import LLM, Agent, Conversation
    from openhands.tools import get_default_tools

    model = C.configure_anthropic_env(inp)
    budget, max_tokens = C.thinking_config(inp)
    llm_kwargs = {"model": C.litellm_model(model), "usage_id": "competitor-openhands", "max_output_tokens": max_tokens}
    if os.environ.get("ANTHROPIC_API_KEY"):
        llm_kwargs["api_key"] = os.environ["ANTHROPIC_API_KEY"]
    if os.environ.get("ANTHROPIC_BASE_URL"):
        llm_kwargs["base_url"] = os.environ["ANTHROPIC_BASE_URL"]
    if budget > 0:
        llm_kwargs["extended_thinking_budget"] = budget  # the xhigh effort realization (OpenHands SDK field)
    llm = LLM(**llm_kwargs)

    # Browser off (no GUI in the bench sandbox); sub-agents ON = the async-delegation arm.
    tools = get_default_tools(enable_browser=False, enable_sub_agents=True)
    agent = Agent(llm=llm, tools=tools)
    conversation = Conversation(agent=agent, workspace=inp["repoDir"])
    return conversation


def _usage(conversation) -> tuple[int, int]:
    """Read accumulated prompt/completion tokens defensively across SDK shape variants."""
    for getter in (
        lambda: conversation.conversation_stats.get_combined_metrics(),
        lambda: conversation.conversation_stats,
        lambda: conversation.state.stats,
    ):
        try:
            m = getter()
            usage = getattr(m, "accumulated_token_usage", None) or m
            tin = getattr(usage, "prompt_tokens", None)
            tout = getattr(usage, "completion_tokens", None)
            if tin is not None or tout is not None:
                return int(tin or 0), int(tout or 0)
        except Exception:  # noqa: BLE001
            continue
    return 0, 0


def _turns(conversation) -> int:
    try:
        return len(list(conversation.state.events))
    except Exception:  # noqa: BLE001
        return 0


def run(inp: dict) -> dict:
    log = C.EventLog()
    conversation = _build(inp)
    log.add(C.KIND_SPAWN, "openhands-agent")

    if inp.get("selfcheck"):
        return C.ok_result(stop_reason="done", events=log.events, extra={"selfcheck": True})

    problem = inp.get("problemStatement", "")
    conversation.send_message(
        "Resolve this issue in the repository at the workspace root. Make the minimal correct change and verify "
        f"with the repo's tests if present.\n\nISSUE:\n{problem}"
    )
    conversation.run()
    tin, tout = _usage(conversation)
    log.add(C.KIND_COMPLETE, "openhands-agent")
    return C.ok_result(tokens_in=tin, tokens_out=tout, turns=_turns(conversation), stop_reason="done", events=log.events)


if __name__ == "__main__":
    C.main(run)
