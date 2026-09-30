# LLM-behavior test stubs must not announce themselves
URL: /internal/docs/agent-insights/llm-target-stubs-must-not-announce-themselves

A tool stub whose result says 'stub' / 'testing context' leaks the test frame into the SUT: the model narrates it ('we're running inside the LLM-testing stub…'), changes behavior, and the rubric judge then grades stub-coping instead of the discipline under test. Stub results must be in-world: neutral success shapes by default, realistic toolOverride payloads (EI-133 pattern) when the scenario needs content. Found via su-S12: the su target's default stub announced itself and the first words of the SUT's reply quoted it.

## The mistake this prevents

Authoring an llm-testing scenario (or target) whose tool executor returns a
self-describing stub — anything like
`{ ok: true, stub: true, note: 'in-process su-target stub (no live dispatch)' }` —
and then reading the failed run as a behavior problem in the SUT.

What actually happens, observed on `su-S12-same-turn-insight`'s first run
(2026-06-11, PG `llm_test_runs`):

1. The SUT mirrors result text into its reply. The run's **opening words** were
   *"We're running inside the LLM-testing stub, so live tool dispatch is
   suspended…"* — the model has read the stub's `note` and adopted the test
   frame as conversational reality.
2. Behavior under measurement changes: a model that knows tools are fake stops
   exercising the real protocol (why acquire a lock that isn't real?) or
   over-explains the test rig instead of doing the task.
3. The rubric judge — which does NOT know the executor is stubbed — files
   `groundedness` findings about the SUT "surfacing internal testing-framework
   details", and judge ERROR findings hard-fail the run
   (`testing-shell runner.ts`: `hasErrorFinding → status='failed'`). You are
   now debugging judge noise, not the discipline the scenario probes.

This is the target-level edition of the EI-133 lesson (SU-S10): *judged runs
fail on stub artifacts, not the discipline under test*. S10's fix was the
`WIDGET_EXPORT_PLAN` realistic `toolOverride`; the same suite later shipped a
default stub that announced itself, and every scenario inherited the exposure.

## The rule

**Stub results must be in-world.** The model should never be able to tell from
a tool result that it is in a test.

* **Default fallback** (no scenario override): a neutral success shape —
  `{ ok: true }`. Nothing about stubs, dispatch, or testing. (Landed in
  `packages/operator-core/lib/llm-testing/targets/su.ts` `resolveToolResult`,
  2026-06-11.)
* **Scenario needs content** (the SUT must read/search/claim something): give
  the calls believable results via the scenario's `toolOverride`
  (`scenarios/su/_overrides.ts` — `WIDGET_EXPORT_PLAN`,
  `ZOMBIE_LOCK_INSIGHT_CONTEXT` are the patterns). Empty-but-plausible beats
  informative-but-fake: `{ results: [], note: 'no stored memories match' }`
  reads as a real empty store.
* **Writing a new in-process target**: treat the fallback-stub text as part of
  the measurement surface, not plumbing. If your stub describes itself, your
  judge findings will describe your stub.

## How to spot it in a failed run

Pull the transcript (`llm_test_runs.transcript_raw_zstd`) and read the SUT's
first assistant turn. If it mentions stubs / test mode / suspended dispatch,
fix the executor before touching the scenario asserts or the playbook — the
deterministic asserts may still be valid (S12's all passed on that run), but
every judge axis is contaminated.

## Sibling stub-world artifact: static stubs + chat-shaped turn caps make agents "repeat" work

Second flavor of the same class (mug-Q01, 2026-06-12): the override's queue
read returned the SAME ungraded EI on every call, and the scenario allowed 4
chat turns — so after grading in turn 1, the Mug re-listed the queue in turn
2, saw the (stale-stub) item still ungraded, and honestly graded it again. The
judge read that as "duplicate grading" — a stub-world artifact, not an agent
defect; in production the row carries her grade after the write.

Fixes, in preference order: (1) **match `caps.maxTurns` to the SUT's
production turn shape** — a spawned-turn agent (Mug) does one pass, so brief

* one turn (`maxTurns: 2`); the in-process loop already allows 6 tool rounds
  INSIDE the turn, which is where multi-step work belongs. (2) Make the stub
  world reflect the agent's own writes — but beware: a module-level stateful
  `toolOverride` leaks state across matrix repeats in one process. (3) Make the
  rubric anchor distinguish the benign case (idempotent self-regrade on a stale
  read) from the real harm (regrading after a sovereignty refusal).

Related: EI-336 (judge is catalog-blind — the complementary judge-side noise
source), EI-345 (su-suite baseline reds), agent policies §19 (the rule S12
probes).
