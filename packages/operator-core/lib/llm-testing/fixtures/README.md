# Fixtures

Version-controlled transcripts the framework can replay against the judge
without burning sim-user + SUT tokens. Plan §13.7.

## `operator/v8-baseline/`

SSE captures from the V8 active-mode-proactive testing pass on
2026-05-14. Migrated from `/tmp/v8-e2e-recordings/scenarios/` (the
pre-framework one-off harness).

Each scenario has two files:
- `<id>.sse`  — raw SSE event tape (one event per `event: name` / `data: …` block)
- `<id>.md`   — human-readable notes from the original run (which assertions were true, what the brain emitted)

Exports from a stored run also include `<id>.transcript.json`, a normalized
per-turn sidecar. It carries the simulated user's `userText`, `simKind`, and
`simThought` alongside the assistant turn so authorization/approval findings
remain auditable and replay preserves the user side of the conversation.

Currently 7 scenarios:
- `01-terminal-status-question` — terminal `?` followed by V8 auto-fire
- `02-multistep-list-then-summarize` — caught the V8 F1 bug (narrate without `<continue/>`)
- `03-user-says-ready` — explicit user_says_ready trigger
- `04-continue-trigger` — explicit continue trigger
- `05-open-canvas` — open_canvas / quiet_wait_resume
- `06-legacy-silence-after-question` — pre-V8 silence path (no Ready card)
- `07-quiet-wait-resume` — quiet_wait_resume directly

## Replay path (Phase 1.5 work)

The plan describes `pnpm llm-test replay --fixture <id>` that re-evaluates a
stored fixture's transcript against the current rubric. That verb isn't
implemented yet — these fixtures sit here as raw evidence until it lands.
Once it does, the `.sse` files feed straight into the judge as a
transcript without an LLM call to the SUT.
