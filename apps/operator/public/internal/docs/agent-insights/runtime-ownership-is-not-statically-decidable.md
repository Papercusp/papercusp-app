# RUNTIME_OWNERS cannot be derived from the import graph — the edges that decide runtime ownership are mostly not static imports
URL: /internal/docs/agent-insights/runtime-ownership-is-not-statically-decidable

Measured negative result (WI-10671). The hand-maintained RUNTIME_OWNERS map in git-pipeline-position.ts looks like an obvious candidate for import-graph derivation. It is not: ownership-deciding edges are dynamic route imports, tsx CLI spawns, side-effect registry registrations and env-gated bootstraps, so a derived map mis-classifies operator-served code as bg-host-only — the dangerous direction. Includes the four false-positive classes and the measurement discipline that caught them.

## Who this is for

You are looking at `RUNTIME_OWNERS` in `packages/operator-core/lib/git-pipeline-position.ts`
and thinking: *this hand-maintained regex alternation is a smell — the import graph already
knows which host runs which module, so derive it.*

That is a reasonable inference, and it is wrong. This page is the measurement (WI-10671) so
you can decline the refactor in five minutes instead of rediscovering it in a session.

## Why the invitation is so strong

Three things point at derivation, and each is individually true:

1. Every dual-owner entry in the map was discovered **one at a time, at real cost** —
   WI-5440, WI-6961 (twice), WI-6659. That is the classic signature of a map that should
   not be hand-written.
2. `routines-dispatch-derivation.ts` **already removed the hand-edit for one class** (the
   sweeps `routinesTickImpl` dispatches directly) and argues the general case persuasively:
   *"the only fix robust to a skipped suite is one that needs no human action at all."*
3. `sharedHostCaveat` openly says *"we cannot know from the path alone which host the caller
   cares about"* — which reads like a TODO admitting defeat.

The derivation in (2) works because it derives from **the dispatcher's own source**, i.e. the
one place where the ownership fact is literally written down. Generalising from "this one
derivation worked" to "so derive the rest from imports" swaps that for a different and much
weaker source of truth.

## The finding

**Static import reachability cannot decide runtime ownership here.** Not because the module
graph is too densely connected — because *the edges that decide ownership are largely not
static import edges at all.* Four measured classes, each of which a static-graph walk gets
wrong:

| module                         | how it is really reached                                                                                                               | what a static walk concludes                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `session-port/service.ts`      | `import()` **inside an HTTP route** — `endpoint-route/routes/adv/sessions.ts:118`                                                      | "worker-only" — it is unambiguously operator-served                                            |
| `sync/hyperbee/perf/runner.ts` | **never imported**; spawned as a `tsx` CLI, `testing-domains-registry.ts:821`                                                          | picks a host — **neither** host owns it                                                        |
| `pr-host/poll-daemon.ts`       | bare **side-effect registration** into the system-action registry, `register-system-actions.ts:259`                                    | depends on which root you walk; **both** hosts load the registry                               |
| `dbos/routines-workflow.ts`    | the worker boundary itself is dynamic — `dbos/bootstrap.ts:289` `await import('./routines-workflow')`, gated on `BACKGROUND_WORKERS=1` | the operator's static graph and its real load set differ **exactly at the point that matters** |

## Why this confirms the current design instead of overturning it

The failure is asymmetric, and derivation fails in the bad direction.

* Today's `DEFAULT_OWNER` says *"the release pipeline applies"* for anything unmatched. When
  wrong, an agent waits for a deploy that will not activate their edit. Costly (this is
  WI-9974's measured hour) but **recoverable** — the code is still correct once restarted.
* A derived map's characteristic error is the opposite: classifying **operator-served code as
  bg-host-only**, telling an agent *"a deploy cannot activate your change"* when it is
  precisely what does. `routines-dispatch-derivation.ts` names this hazard explicitly and
  guards against it: *"It must never degrade to matching everything: that would tell an agent
  editing a shared operator file that a deploy cannot activate their change, which is the
  opposite lie."*

So `sharedHostCaveat`'s comment is **the correct position, not a TODO**. Runtime ownership is
not statically decidable in this codebase, and surfacing it as a *note* rather than a
*reclassification* is the honest encoding. Extend `RUNTIME_OWNERS` per incident, deliberately.

## The measurement discipline (the reusable part)

Four successive measurements of this one question were confidently wrong, each in a different
way. Every one produced a **well-formed, plausible number**; none announced itself; and each
was caught only by a *deliberate falsifier*, never by inspection.

1. **`worker-only = 0`.** Artifact: `routines-workflow.ts` was inside my own "operator
   closure" via the `bootstrap.ts` dynamic edge, so the difference set was empty **by
   construction**. → Caught by a **positive control**: *do modules the live classifier already
   calls bg-host-only land in my operator closure?* They did. The instrument was contaminated.
2. **`worker-only = 12`.** Artifact: the specifier regex missed **bare side-effect imports**
   (`import './locks/x';` — no `from`, no parens), and `agent-tools/index.ts` is built almost
   entirely from them, so the operator closure was missing the whole tool surface. → Caught by
   a **known-answer control**: `bash-substitution/fires.ts`, which the hand-map documents as
   dual-owner, came back "worker-only". A result that contradicts a documented fact is the
   instrument failing, not a discovery.
3. **`worker-only = 40+`.** Artifact: two of four operator roots **never resolved**
   (`bin/hono-host.ts` actually lives at `apps/operator/bin/`), silently under-rooting the safe
   side. → Caught by reading the `roots resolved: 2/4` line the script had printed and I had
   skimmed past. An unresolved root is not a smaller measurement, it is a different one.
4. **The survivors** were then each a distinct non-defect (the table above).

Three transferable rules:

* **Run the known-answer control first.** If your instrument cannot reproduce a fact already
  written down (here, a documented dual-owner entry), every *new* thing it tells you is
  unsupported. This is cheap and it fired immediately.
* **Ask which direction an error hurts, and over-approximate the safe side.** Here,
  over-approximating the *operator* closure under-counts traps (fails safe); under-approximating
  it manufactures the opposite lie. Choose the bias deliberately and write down why.
* **A negative result needs a falsifier as much as a positive one.** The first measurement said
  "no problem exists" and was empty by construction. `0` is exactly as capable of being an
  artifact as `40` — and it is likelier to be believed, because it asks nothing of you.

## See also

* [A watchdog signal keeps firing after its fix deployed](/internal/docs/agent-insights/deployed-watchdog-fix-still-fires-check-bg-host-restart) — the forward direction: a fix in `main`/`:3070` that is absent from the running routine.
* WI-9974 — the inverse: a fix absent from `:3070` that is already live in bg-host, and the hour it costs to wait on a deploy you do not need.
