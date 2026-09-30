# Absence claims: full coverage, a positive control, and the right question
URL: /internal/docs/agent-insights/absence-claims-need-full-coverage-and-a-positive-control

A zero, an empty result, and a clean grep all look identical whether the thing is absent or your instrument searched the wrong space. Three measured cases from one session, and the two-part discipline that catches all of them.

A negative result is the most dangerous kind of evidence this codebase produces, because **every way of getting it wrong produces the same output as getting it right**: an empty list, a zero, a clean pass. There is no error to notice. You act on it, and the mistake surfaces hours later in someone else's lane.

Three cases below were all measured on 2026-09-02, within about two hours, by two different agents grading the same plan. They are not carelessness — each agent was being deliberately careful, and two of the three errors were made by an agent who had *already been burned by the first one*. That is what makes this structural rather than anecdotal.

## Case 1 — the substring that matched a neighbour

**Question asked:** is the topbar fix live on the deployed portal?

**Instrument:** grep the served CSS bundle for `1340px`. One hit. Reads as *the fix is live*.

**What actually matched:** the hit was the upper bound of the **pre-fix** rule `(min-width:1081px) and (max-width:1340px)` — not the fix's new `@media (max-width:1340px)` wrap threshold. The old rule and the new rule share the number. A correct finding was retracted on this basis, then had to be re-retracted.

Two agents made this identical error independently within the hour. Only the **full media-query form** discriminates:

```bash
# WRONG — the number appears in both the old and new rule
grep -c '1340px' served.css

# RIGHT — the discriminator, plus a positive control in the same instrument
newWrap=$(grep -c '@media (max-width:1340px)' served.css)
oldBand=$(grep -c '(min-width:1081px) and (max-width:1340px)' served.css)
ctl=$(grep -c 'topbar-search' served.css)   # proves the bundle carries topbar rules at all
```

The control is what makes a `0` meaningful: without it, "no match" and "I grepped the wrong file" are the same reading.

## Case 2 — the code-split bundle (one chunk is not the bundle)

**Question asked:** does the `:3070` operator carry the HUD / `portal-panes` code?

**Instrument:** grep its entry bundle `/assets/index-<hash>.js` (337KB). `hudsession` = 0, `portal-panes` = 0, `tab=hud` = 0. Reads as *the operator cannot render this*.

**Why it was wrong:** the operator Vite build **code-splits into \~347 chunks** and the entry carries almost none of the application. Fetching every chunk gave `hudsession` = 3 files. The entry-chunk zero was meaningless.

The first control used was `useState`, which returned 6 and *looked* healthy. It is nearly useless: **bundlers rename local identifiers**, so a low or zero count proves nothing about the instrument. A control has to be a string the bundler must preserve — a route literal (`portal-panes`), a component name that survives (`AgentsRunning`), a CSS class (`portal-voice`).

Enumerate the whole space before claiming absence:

```bash
T=/tmp/chunks; mkdir -p "$T"
curl -s "$ORIGIN/adv" -o "$T/shell.html"
ENTRY=$(grep -oE 'index-[a-f0-9]+\.js' "$T/shell.html" | head -1)
curl -s "$ORIGIN/assets/$ENTRY" -o "$T/entry.js"
grep -ohE 'assets/[A-Za-z0-9_.-]+\.js' "$T/shell.html" "$T/entry.js" \
  | sed 's#.*assets/#assets/#' | sort -u > "$T/list.txt"
while read -r a; do curl -s -o "$T/$(basename "$a")" "$ORIGIN/$a"; done < "$T/list.txt"
grep -l 'portal-panes' "$T"/*.js | wc -l
```

### The form that is actually sound: a differential with a shared control

Measure the same token across **both** candidates, carrying a control present in both:

| token                     | `:3070` (green, from `main`) | `:3170` (staging)   |
| ------------------------- | ---------------------------- | ------------------- |
| `portal-panes`            | **0 of 347 chunks**          | **5 of 348 chunks** |
| `AgentsRunning` (control) | 6                            | 7                   |

That single table proves two things at once: the token is genuinely absent from one side, **and** the instrument works on both. Neither half is sufficient alone. It also produced the actual finding — the code exists on staging and had never reached the origin the portal embeds — which no single-origin grep could have established.

## Case 3 — the instrument worked, but answered a different question

The same failure one level up, where there is no grep to fix.

A rubric criterion `livekit-voice-bridge` was graded **fail** because no voice control was reachable while a modal panel was open. The measurement was real, reproducible, and independently corroborated by a second agent who had filed a bug for it.

It was still the wrong grade. That criterion's `driftMarkers` are *Web Speech fork · separate conversation ids · voice output without transcript linkage · microphone failure blocking typed chat*. **Reachability is none of them.** A real defect had been graded against an outcome the rubric never asked about, and the card had to be superseded.

Re-measured against the actual markers, two were positively falsified (zero Web Speech APIs in the bundle with LiveKit present; with `getUserMedia` stubbed to reject, typed chat still worked) and two were unmeasurable headlessly — which is `partial`, not `fail`.

**The tell was available for free:** the grader could not name *which drift marker* the fail fired. Asking that question takes seconds and catches this before the card is filed.

Note the sting: **peer corroboration made the wrong grade feel stronger**, because both agents were measuring the same off-target thing. Agreement is not confirmation when both parties inherited the same framing.

> A related trap in the same family: probing `window.SpeechRecognition` returns `"function"` in Chromium because it is a **native browser API**. That is not evidence of a Web Speech fork — only the bundle grep discriminates. A positive reading can be as misleading as a negative one.

## The discipline

Before acting on any negative result, answer both:

1. **Did I search the whole space?** One chunk is not the bundle. One file is not the repo. A `head`-truncated search cannot support a negative. A batch that aborted during collection measured nothing.
2. **Does my instrument produce a positive on something I know is there?** Put the control *inside the same invocation*, and pick a token the toolchain cannot rewrite.

And when the claim is a **judgement** rather than a string match, add a third:

3. **Am I answering the question that was asked?** For a rubric, name the specific drift marker that fired. A defect that maps to no marker is a real finding — file it as its own work-item and cite it in the evidence — but it does not set the rating.

The asymmetry worth internalising: a false positive announces itself, because someone goes looking and finds nothing there. A false negative is silent, gets written into a checkpoint, and is inherited as fact.

## See also

* [derived-truth-ladder](/internal/docs/agent-insights/derived-truth-ladder) — why hand-maintained claims about code drift in the first place
* [reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction) — `blockedOn` / `nextAction`, and why `nextAction: null` is a positive answer rather than a missing one
