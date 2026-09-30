"""
P-028 CrewAI competitor arm. A role crew — a planner agent + a coder agent (sequential process) with file/
shell tools editing the repo. The inter-role crew is the coordination MAST measures. Run in
~/.papercusp/competitors/venv (crewai). CrewAI's LLM layer (litellm) reads anthropic/<model> + ANTHROPIC_*.
"""
import _common as C


def _build(inp: dict, log: "C.EventLog"):
    from crewai import Agent, Crew, LLM, Process, Task
    from crewai.tools import tool

    model = C.configure_anthropic_env(inp)
    budget, max_tokens = C.thinking_config(inp)
    repo_dir = inp["repoDir"]
    problem = inp.get("problemStatement", "")
    fns = C.make_file_tools(repo_dir, log, agent="coder")

    @tool("read_file")
    def read_file(path: str) -> str:
        """Read a file (path relative to the repo root)."""
        return fns["read_file"](path)

    @tool("write_file")
    def write_file(path: str, content: str) -> str:
        """Write/overwrite a file with the full new content (path relative to the repo root)."""
        return fns["write_file"](path, content)

    @tool("list_dir")
    def list_dir(path: str = ".") -> str:
        """List a directory relative to the repo root."""
        return fns["list_dir"](path)

    @tool("run_shell")
    def run_shell(command: str) -> str:
        """Run a shell command in the repo (run tests, grep, build)."""
        return fns["run_shell"](command)

    # base_url/api_key resolved from ANTHROPIC_API_BASE/ANTHROPIC_API_KEY (litellm); extended thinking = xhigh.
    llm_kwargs = dict(model=C.litellm_model(model), max_tokens=max_tokens)
    if budget > 0:
        llm_kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
        llm_kwargs["temperature"] = 1
    llm = LLM(**llm_kwargs)
    planner = Agent(
        role="Planner",
        goal="Produce a concrete plan to resolve the issue in the repository.",
        backstory="A senior engineer who scopes the change before any code is written.",
        llm=llm,
        tools=[read_file, list_dir],
        allow_delegation=False,
        verbose=False,
    )
    coder = Agent(
        role="Coder",
        goal="Implement the minimal correct fix and verify it with the repo's tests.",
        backstory="An expert implementer who edits files via tools and checks the result.",
        llm=llm,
        tools=[read_file, write_file, list_dir, run_shell],
        allow_delegation=False,
        verbose=False,
    )
    plan_task = Task(
        description=f"Scope the fix for this issue. Output a short numbered plan.\n\nISSUE:\n{problem}",
        expected_output="A short numbered plan.",
        agent=planner,
    )
    code_task = Task(
        description=(
            "Using the plan, implement the fix in the repository with the tools. Make the minimal correct "
            f"change and verify with tests if present.\n\nISSUE:\n{problem}"
        ),
        expected_output="A summary of the files changed.",
        agent=coder,
        context=[plan_task],
    )
    crew = Crew(agents=[planner, coder], tasks=[plan_task, code_task], process=Process.sequential, verbose=False)
    return crew


def _usage(crew) -> tuple[int, int]:
    u = getattr(crew, "usage_metrics", None)
    if u is None:
        return 0, 0
    return int(getattr(u, "prompt_tokens", 0) or 0), int(getattr(u, "completion_tokens", 0) or 0)


def run(inp: dict) -> dict:
    log = C.EventLog()
    crew = _build(inp, log)
    log.add(C.KIND_SPAWN, "planner")
    log.add(C.KIND_SPAWN, "coder")

    if inp.get("selfcheck"):
        return C.ok_result(stop_reason="done", events=log.events, extra={"selfcheck": True})

    log.add(C.KIND_HANDOFF, "planner", detail="plan -> coder")
    crew.kickoff()
    tin, tout = _usage(crew)
    log.add(C.KIND_COMPLETE, "coder")
    return C.ok_result(tokens_in=tin, tokens_out=tout, turns=2, stop_reason="done", events=log.events)


if __name__ == "__main__":
    C.main(run)
