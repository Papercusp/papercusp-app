# A flag default graduating OFF→ON silently breaks legacy tests that assert the OFF contract
URL: /internal/docs/agent-insights/flag-graduation-breaks-legacy-off-contract-tests

When a feature flag's DEFAULT flips to ON, legacy unit tests that assert the OFF/legacy behavior WITHOUT pinning the flag silently start exercising the ON path — their assertions break and red the green-checkpoint gate. Fix = pin the flag explicitly in the legacy test. Symptom + fix + check.

**Symptom signature.** The green-checkpoint gate goes RED — for *hours*, across
multiple candidates — on a handful of unit tests in a package you didn't think
you touched. Each failing test asserts a *legacy* behavior contract
(`expect(...).toBe(false)`, "is per (workspace, install)", "defaults installSlug
to 'op'") and reproduces deterministically in isolation. Re-running doesn't fix
it. On 2026-06-24 this red the gate \~8h and pulled in 3 agents before the cause
was named.

**Why.** A flag-gated re-key ships dark, then its **default graduates to ON**
(the repo's normal end-state — finished work never ships dark). The NEW behavior
gets its own `*-workspace-scope.test.ts` sibling that drives the flag ON
deterministically. But the **pre-existing** unit tests still assert the OLD
(flag-OFF) contract and **never pinned the flag** — they relied on the default
being OFF. The moment the default flips, those tests silently exercise the ON
path and their assertions break. Nothing about the flip touches the test file,
so the red looks like it came from nowhere.

Concrete case (workspace-scoped-coordination, `WORKSPACE_COORDINATION`): the
brain re-key (`workspace-brain-scope.ts`) collapses per-(workspace,install) state
to one row per workspace when ON. `control-state.test.ts` ("is per (workspace,
install)") and `scout-cycle.test.ts` ("defaults installSlug to 'op'") asserted
the per-pot OFF contract → broke on graduation.

**The fix (per failing legacy test).** Pin the flag to its OFF value so the test
deterministically exercises the legacy/kill-switch path it was written for —
independent of the production default. Mock the flag-gate helper, not PostHog:

```ts
// Pin WORKSPACE_COORDINATION OFF so these unit tests exercise the per-(ws,install)
// keying path they were written for — independent of the production default,
// which graduated to ON. The ON path is covered by *-workspace-scope.test.ts.
vi.mock('../../workspace-brain-scope.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isWorkspaceCoordinationOn: () => Promise.resolve(false) };
});
```

This is correct, not gaming: the OFF path is the reversible kill-switch and must
stay tested. The ON path lives in the sibling `*-workspace-scope.test.ts`.

**Check before you graduate a flag default to ON.** Grep every test that touches
the flag-gated code path; any that asserts the OFF-behavior contract WITHOUT
explicitly pinning the flag will break on the flip. Pin them OFF (or move the
assertion to the ON contract) in the SAME change that flips the default — don't
let the green gate discover it for you. This is the contract-break cousin of
[default-on-flag-glue-vs-hermetic-unit-tests](/internal/docs/agent-insights/default-on-flag-glue-vs-hermetic-unit-tests)
(that one is the live-PG-write hazard; this one is the assertion break).
