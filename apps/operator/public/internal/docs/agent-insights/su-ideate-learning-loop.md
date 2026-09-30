# The su-ideate learning loop: file → grade → wake → revise → outcome → priming
URL: /internal/docs/agent-insights/su-ideate-learning-loop

How an su in IDEATE mode runs a CLOSED learning loop — the agent-driven twin of the automated Scout cycle. Each pass grounds on blender:ideation-feedback, files a lens-tagged idea, routes the broad ones via blender:route-idea, and closes with a ledgered blender:ideate-pass-record tick. Grading (blender:grade-idea) is the ACTIVE close: a low grade + critique WAKES the originator to revise — the tool refuses to grade a row you authored (no self-grading, D-012). This is the map from a filed idea to the priming that shapes the next pass.

# The su-ideate learning loop

The [Scout loop](/internal/docs/system/scout-loop/) is the Pot's **automated**
generative engine — a prompt-free cadence fires the cycle, the Mug gates, agents
build. **su in IDEATE mode is the agent-driven twin.** It runs the same learning
substrate over the same outcome-feedback ledger, but a human-collaborator agent
runs each pass *deliberately* — a closed loop, not a blank page. This runbook is
the map of that loop: from a filed idea, through grading, to the priming that
shapes the next pass.

The contract that binds su to this loop lives in `modes/registry.ts` (the IDEATE
and GRADE mode contracts) and is rendered into the full-tier operating-modes
clause by `operating-modes-policy.ts` (`renderModesPolicy('full')`). The **fleet
tier stays IDEATE-free**: grounding is a leader/interactive posture, not a
fleet-member one, so `renderModesPolicy('fleet')` omits the whole ritual.

## Why it is a LOOP, not a feed of one-off ideas

The failure mode this closes is *ideation as a blank page* — an agent invents in
a vacuum, files, and never learns whether the idea landed. A blank-page pass
repeats the same lens, re-proposes already-tried ideas, and gets no signal back.
The loop replaces that with a cycle whose every pass is **grounded in the last
one's outcomes**:

```
GROUND (ideation-feedback) → run one LENS → FILE lens-tagged
   → ROUTE the broad ones → CLOSE (ideate-pass-record tick)
        ↑                                              │
        └────────── grade → wake → revise ─────────────┘
                    (outcome → priming feeds the next GROUND)
```

## The five stages of a pass

Each su IDEATE pass mirrors the Scout cycle stage-for-stage, through the
agent-facing `blender:*` tools instead of the internal `scout/*` modules.

### 1. GROUND — `blender:ideation-feedback`

Open every pass by reading the feedback surface, not a blank prompt. It returns
the four grounding signals a fresh pass needs:

* **prior grades** — how earlier su-filed ideas scored;
* **realized outcomes** — which routed ideas actually panned out (via the change
  feed → the routed-idea ledger);
* **per-lens win-rates** — which creative lenses win *for this Pot*, so you can
  bias toward productive lenses without collapsing diversity;
* **the federated frontier read** — what peers are already exploring, so you
  leap toward open ground rather than re-treading.

This is the parity of Scout's corpus synthesis (`corpus-digest.ts`) — the
introspection a single reactive turn cannot do.

### 2. RUN ONE LENS — vary it across passes

Run the pass under **one** creative lens (analogical / first-principles /
reframing / constraint-removal), and **vary the lens across passes**. This is
the cheap-diversity parity of Scout's forced-diversity ideator roster (D-004):
one deliberate lens per pass, rotated, beats one undifferentiated "be creative"
prompt.

### 3. FILE — `improvements:capture { kind: 'feature' }`, lens-tagged

File the idea as a feature proposal, **tagged with the lens** you ran. When the
idea is a real bet (not just an observation), attach a **bet + a cheap,
falsifiable experiment** — the anti-bullshit gate that makes "bettable"
machine-checkable, mirroring Scout's required `cheapExperiment` (D-006).

**There is no quality gate and no quota — file freely.** Rubrics *enrich*
ideation (they tell you which lenses win); they never gate or suppress filing.
The owner reviews the history; the loop's job is to generate and learn, not to
pre-censor.

### 4. ROUTE — `blender:route-idea`

Route the **broad-scope** ideas onward — the ones that want a plan draft rather
than a single change. This is the parity of Scout's router (`router.ts`): broad
→ plan draft, the rest stay as captured features. Routing writes a routed-idea
ledger row, which is what later attributes outcomes back to the lens that
produced the idea.

### 5. CLOSE — `blender:ideate-pass-record`

Close the pass with a **ledgered tick** — a measurable su-ideate record (ideas
filed, lens used, routed count). The tick is what makes the loop *measurable*:
without it, a pass leaves no trace to ground the next one on. A pass that files
ideas but records no tick is an **open** loop — it forfeits the priming that
stage 1 reads back.

## The active close: grade → wake → revise

Scout's outcome feedback is **passive** — the change feed plus owner/Mug grades
weight lenses slowly, over many cycles. su's close is **active**, and this is the
heart of the loop:

* **Grade** — an agent in GRADE mode grades an su-filed idea with
  `blender:grade-idea`: a 1–5 grade **plus a critique**.
* **Wake** — a **low grade + critique WAKES the originating su to revise.** The
  critique is delivered as a wake signal to the idea's author. The grade is not a
  filing-cabinet score; it is the revision trigger.
* **Revise** — the woken originator revises the idea against the critique and
  re-files, closing *their* loop. The critique is the signal that turns a filed
  idea into a better one.

**No self-grading (D-012).** `blender:grade-idea` **refuses when you authored the
row.** A critique you write for your own idea is not an independent signal —
self-grading would let the loop congratulate itself. The guard is enforced at the
tool (see `grade-idea.ts`); it is not advisory. (This guard is the D-012 binding
decision; it was found missing and implemented — the loop is only closed *because*
the grade comes from another agent.)

## Outcome → priming: how the loop feeds itself

The tick, the routed-idea ledger, and the grades all flow back into the **next**
pass's GROUND step. The mechanics are shared with Scout:

* **Outcome feedback** (`outcome-feedback.ts`) — a present grade **dominates** the
  change-feed-derived outcome in the per-lens weighting. A graded idea steers the
  lens weights more than an ungraded one that merely shipped.
* **Priming** (`ideator-feedback-priming.ts`) — recently-graded ideas **prime**
  the next pass's ideation (Scout concatenates this priming below its gym
  stepping-stones). For su, this priming surfaces through
  `blender:ideation-feedback` at the top of the next pass — so the grade you
  received last pass literally shapes what you ideate on next.

That is the full circuit: **file → grade → wake → revise → outcome → priming →
(next) file**. The loop is *closed* precisely because each arrow is a real
mechanism, not a hope: the tick makes it measurable, the ledger makes it
attributable, and the cross-agent grade makes the revision signal honest.

## Common failure modes

* **Open loop (no tick).** Filing ideas without `blender:ideate-pass-record`
  leaves the pass untraceable — stage 1 of the next pass has nothing to ground on.
  Always close.
* **Blank-page relapse.** Skipping GROUND and inventing in a vacuum repeats lenses
  and re-proposes tried ideas. The feedback read is cheap; the repetition is not.
* **Self-grading attempt.** Grading your own row is refused (D-012). If you want
  your idea graded, it needs another agent in GRADE mode — the cross-agent grade
  is the whole point.
* **Gating filing on quality.** There is no quality gate; rubrics enrich, never
  suppress. Filing a weak idea and getting a low grade *is* the loop working — the
  low grade wakes you to revise.

## See also

* [The Scout loop](/internal/docs/system/scout-loop/) — the automated engine this
  loop is the agent-driven twin of; its **su-ideate parity** section maps the
  stages side by side.
* `modes/registry.ts` — the IDEATE + GRADE mode contracts (the binding text su
  reads on entering the mode).
* `operating-modes-policy.ts` — `renderModesPolicy('full')` renders the ritual
  into the full-tier operating-modes clause; the fleet tier omits it.
