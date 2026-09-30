# Measuring per-keystroke input latency in the Tauri webview
URL: /internal/docs/agent-insights/measuring-per-keystroke-input-latency

The bar is 33ms, the only sound metric is a paired delta against an in-run sham, and arm order must be counterbalanced — every rule here was earned by a wrong result on WI-6502.

WI-6502 ("typing into the chat boxes is very laggy") burned several agent-days,
and most of that went to **measurements that produced confident wrong answers**
rather than to the fix. This is the runbook for the next person who has to
measure input latency here, written from what actually went wrong.

If you take one thing: **an unpaired number from this webview means nothing.**
The same unchanged arm has measured 76, 76 and 90 across three boots of identical
CSS, and 781 → 683 across five rounds of a single boot. Every conclusion must be
a *within-run difference against a control you ran in the same round*.

## The bar is 33ms per character, and it is not arbitrary

33ms is the **key auto-repeat interval**. It is the threshold because of what
happens on each side of it:

* Below it, a held key is serviced faster than it repeats — cost is invisible.
* Above it, keystrokes **queue without bound** while the key is held. That is the
  qualitative symptom the owner reported: "half a second for each next
  character", worsening the longer you hold.

So the question is never "is typing fast?" but "is per-character cost above or
below 33ms?" A per-char cost of 25ms is fine; 35ms is a visibly broken feature.

## The only sound metric: paired wall-delta against an in-run sham

Type N characters at 33ms intervals and measure wall time. In the **same round**,
run a **sham**: the identical chained-`setTimeout` loop with *no typing*. Only

```
(burst_wall − sham_wall) / N
```

is an app cost. This matters more than it sounds: 20 chained `setTimeout(33)`
take \~715ms on this box with **nothing typed** against a 660ms "ideal", so raw
drift-versus-ideal is mostly the probe, not the app.

### The sham is also a diagnostic: if it stalls too, typing is not your bug

Above, the sham is used to *subtract* probe overhead. It answers a second, more
important question for free, and missing it cost WI-6502 roughly 26 hypotheses of
CSS ablation: **compare the sham's main-thread stalls to the typing arm's.**

```
run51, 12 type + 12 sham arms interleaved in ONE run
  type  stallMax  median 50ms   mean 64.3ms
  sham  stallMax  median 56ms   mean 64.2ms     <- no keystrokes at all
```

The sham arms stalled *as hard as* the typing arms. Typing was not causing the
stalls — a periodic main-thread block was firing roughly once a second regardless,
and keystrokes were **queueing behind it**. The Event Timing API says the same
thing in one line: input **delay** 36–247ms against **processing** 3–5ms. The
handler was always cheap; the event just waited.

This distinction decides where you look next, and it is invisible to any
instrument that samples *only while typing* — such an instrument attributes the
periodic block to whichever keystroke happened to land on it, which reads exactly
like "typing is expensive" and sends you into the paint stack. WI-6502's handoff
brief confidently asserted "this is a PAINT problem, not a React problem" on
precisely that error; the real cause was a once-per-second cache serialisation
(`libs/generic/sync/src/persisted-cache.ts`) that had nothing to do with typing or
painting.

So make this the *first* question of any input-latency investigation, before any
ablation: **does the cost survive when nobody types?** If yes, stop measuring
typing and go find the periodic work.

## Schedule the burst on an ABSOLUTE timeline, or you cannot see the symptom

Read this before writing the loop above. It is the single most expensive mistake
on WI-6502: ten consecutive probes were **structurally incapable of observing the
reported symptom**, and each returned a confident, clean, wrong-shaped null.

The natural way to write the burst is the broken one:

```js
for (let i = 0; i < N; i++) { typeOneChar(); await sleep(33); }   // ✗
```

The sleep starts **after** the keystroke's work, so each iteration begins
`work + 33` after the previous one. The probe re-paces itself around the app:
however slow the app gets, the driver politely waits for it. A backlog is
arithmetically impossible to produce, so "no backlog" is a property of the
instrument, not a finding about the app.

Schedule against a fixed origin instead, the way key auto-repeat actually fires:

```js
const t0 = performance.now();                                     // ✓
for (let i = 0; i < N; i++) {
  const target = t0 + i * 33;                                     // absolute, never cumulative
  let d = target - performance.now();
  while (d > 1.5) { await new Promise(r => setTimeout(r, d)); d = target - performance.now(); }
  late.push(performance.now() - target);                          // THE measurement
  typeOneChar();
}
```

`late[i]` is lateness against a clock the app cannot slow down. That is the
quantity the owner is describing when they say "half a second for each next
character" — a **growing queue**, not a large mean.

**Be precise about what the self-paced version does and does not tell you.** It
does measure mean per-character *work*, and that number is real; if mean work is
comfortably under 33ms then a 33ms driver cannot accumulate either, so its
conclusion is often right. But it reaches that conclusion by **inference**, and it
is blind to the symptom's *shape*. Do not report a self-paced null as "no
backlog"; it is "mean per-char work is X", and the backlog question was never
asked.

### The discriminator is monotonicity, not a fitted slope

Once you have `late[]`, resist fitting a regression line to it. Under fleet load
(this box sits at 47–61) ambient jank moves the fit around far more than the
effect does, and a slope alone is unreadable.

Use the structural property instead: **a real queue cannot recover.** If the app
is falling behind the input clock, lateness rises and *stays* risen. Observed on
WI-6502: lateness climbed to 30–50ms and then fell back to 1–4ms, repeatedly —
ambient jank, not a queue. Quantify it as the fraction of steps that do not
decrease, and compare that fraction against the sham in the same round (0.96 for
the sham vs 0.74 while typing: the typing arm *recovered more often*, which no
backlog can do).

### The definitive version: real X11 key events

Every JS-driven probe — including `document.execCommand('insertText')`, which
does exercise WebKit's native editing path — still skips the real key pipeline:
no X11 event, no GTK key handling, no engine-level auto-repeat, no IME. If you
need to close that gap, `scripts/verify-tauri-headless.sh` gives your instance its
**own** Xvfb, so you can drive it from outside the app entirely:

```bash
DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool search --onlyvisible --name Papercusp | tail -1   # the window id
DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool windowactivate --sync "$WID"
DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool type --delay 33 'abcdefghij...'
```

⚠ **`xdotool type --delay N` does not give you an N-millisecond cadence.**
Measured on a bare Xvfb with no client attached: `--delay 33` sends 40 characters
in 683ms — **17.1ms per character**, about half what you asked for (`--delay 0`
gives 2.6ms/char, so the knob works, it just is not the per-character period).
Never assume the cadence you requested. **Time it externally once** — spin a
throwaway `Xvfb` and `date +%s%N` around the `type` — and compute your metrics
against the interval that was actually delivered. A whole run's lateness series
fitted to an assumed-but-wrong constant looks like a large, perfectly linear
drift and means nothing.

This also caught a near-miss worth repeating: the in-app inter-arrival gap came
out at 17.06ms, temptingly close to one 60Hz vsync (16.67ms), which reads as
"WebKit drains one key per frame." It is not — the external timing showed the
*sender* was already at 17.1ms. Do not accept a floor you have not decomposed,
even a plausible-sounding one.

An external driver cannot be re-paced by the app at all, which removes the whole
class of failure above. It also unlocks a measurement no synthetic event can
make: a **real** keydown carries a hardware `event.timeStamp`, so

```js
performance.now() - event.timeStamp      // inside the handler: TRUE input latency
```

is how long the event sat queued before the app serviced it. A synthetic event's
`timeStamp` is the moment JS created it, so that delta is \~0 by construction —
which is why no probe before this one could measure input latency at all, only
input *cost*. Assert `event.isTrusted` on every sample: it is what proves you
measured real keys and not your own synthetic ones. Never point this at
`DISPLAY=:0` — that is the owner's desktop.

### Metrics that are retired, and why

| metric                       | status           | why                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| single-keystroke worst frame | **retired**      | Had real power once (it resolved 43-55ms vs a 17ms sham and detected two CSS fixes at −11/−10ms). After those fixes it reads the vsync floor for *everything*, so any new ablation using it returns null trivially and proves nothing. Old eliminations made with it still stand; the metric does not. |
| `over33` (frames over 33ms)  | **not evidence** | The probe drives mutations at 33ms, so frames land at \~33ms+ε with zero work. It read 14/22 in *every* typing arm including the cheapest ones.                                                                                                                                                        |
| `max` frame                  | **not evidence** | The **sham** — no typing at all — produced max frames of 49–54ms in 2 of 12 rounds under fleet load. Long frames are ambient here, not typing-caused.                                                                                                                                                  |
| raw drift vs ideal           | **not evidence** | Dominated by the probe's own floor (see above).                                                                                                                                                                                                                                                        |

## Counterbalance arm order — this one invented a regression

Whichever arm runs **second** in a round is penalised. Measured on WI-6502 run19,
comparing the chat composer against a bare `<input>`:

```
bare-first rounds (chat ran 2nd):  +79, +47, +12   ->  "chat costs +46ms"
chat-first rounds (chat ran 1st):  +3,  -1,  -55   ->  "chat costs nothing"
```

The position penalty was +32ms/15 chars in one boot and +6ms in the next — **the
penalty itself is unstable**, so you cannot subtract a constant for it. Alternate
arm order on round parity and average the two orders. A fixed-order design here
would have reported a convincing chat-specific regression that does not exist,
and sent the next agent hunting it.

The same trap bites harder **across boots**: an A/B needing two boots (e.g. a
WebKit feature flag set via env) is confounded because *the arm that boots second
is slower whichever setting it carries* — measured both ways, each direction
"won" when it went second. Eight rounds inside one boot is n=8 on within-boot
noise and n=1 on the thing that varied.

## Reaching the surfaces

### The real chat composer

It is a plain `<input>` inside `.oracle-input-shell`
(`ChatConversation.tsx`), **not a textarea**. A probe that picks "the biggest
visible textarea" silently measures the Mug directive box
(`.pc-queen__directive`) instead — that mistake cost a whole run.

`SessionChatModal` is opened by the nuqs key `hudsession=<ownerId>`
(`HudView.tsx`), so:

```
/adv?tab=sessions&hudsession=<ownerId>
```

`HUD_TABS` is `['sessions','plans','items']`. Transcript rows are `.oracle-msg`
and are **virtualised** (`.oracle-virtual-container`), so expect \~10 rendered
rows regardless of session length.

`scripts/verify-tauri-headless.sh` has **no route/URL env knob**. Navigate from
inside an eval:

```js
window.__TSR_ROUTER__.navigate({ to: '/adv?tab=sessions&hudsession=' + id });
```

Have the probe **report whether it found the element** (`composerFound`,
`focused`) rather than assuming. An unfocused control already caused one
retraction on this item; a probe that can silently measure nothing eventually
will.

### Driving a React-controlled input

`el.value = x` is reverted by React's next render and measures nothing. Drive it
the way the browser does:

```js
const proto = el instanceof HTMLTextAreaElement
  ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

Clear the draft after each burst so you never leave text in a real composer.

## Budgets and harness notes

* **The bridge eval dies at \~5s.** Three arms × 6 rounds fits; five arms × 3
  rounds has no statistical power and is exactly where one attempt stalled. Drop
  N per burst before dropping rounds.
* **Launch detached**, with file redirects:
  `setsid nohup bash launchNN.sh > log 2>&1 < /dev/null &`. A long run launched
  as a child of a harness-tracked background task can die with "Bad file
  descriptor" on every write when that task's pipe closes — which looks exactly
  like a probe failure and is not.
* **A boot that dies before the bridge is often a peer's broken Rust**, not
  flakiness. The whole fleet edits `src-tauri` concurrently. The FATAL now names
  a compile error when there is one; if you are on an older checkout, grep the
  run's `tauri.log` for `error\[E` **before** retrying, because a blind retry
  costs another \~2min and fails identically.
* **Never drive the owner's window.** `tauri-agent-tools probe` lists bridges;
  the tty-attached pid is theirs. Boot your own.

## A CSS-ablation arm is invalid under damage-based compositing

This one generalises past input latency to **any** paint measurement in this app,
and it produces a *fake regression* rather than a null, which is why it is worth
knowing before you design the run.

The usual way to test "is property X expensive to paint?" is to toggle a
stylesheet that disables X and re-measure. That arm is sound under the shipping
config, where the compositor repaints fully anyway. It is **not** sound with
`UseDamagingInformationForCompositing` enabled
(`papercusp-desktop/src-tauri/src/webkit_render.rs`): under damage-based
compositing the act of toggling a stylesheet **dirties the whole viewport**, so
the probe's own mechanism costs more than the thing being measured, and a cheap
baseline reads as a regression. A \~37ms "regression" measured this way was an
artifact of the ablation, not of the property.

So: keep CSS-mutating arms for `PAPERCUSP_WEBKIT_DAMAGE_COMPOSITING=0` runs, and
when you must compare damage-on against damage-off, remember it is a *two-boot*
A/B and therefore subject to the boot-order confound above — bracket the odd arm
between two of the other (`ON / OFF / ON`) rather than running one of each.

Related: no timing probe can see the failure mode damage-based compositing
actually risks. Under-reported dirty rects leave **stale or torn pixels**, which
are invisible to every metric in this document — that needs a screenshot
comparison, not a stopwatch.

## An instrument bound to the wrong object reports a confident zero

Every wrong turn on WI-6502 — five of them — was the same failure: a probe silently
attached to something other than what it claimed to measure, then returned a clean,
confident **zero** that read as a finding.

| the probe                                   | why it read zero                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| react-query cache census                    | bound to a **decoy** `QueryClient` in the tree → `queries: 0`                          |
| `EventSource` wrapper                       | `SSEAdapter` builds its `EventSource` at boot, *before* the patch → undercounted \~10× |
| `fetch` wrapper                             | URL regex missed half the traffic                                                      |
| callback attribution keyed on a bundle hash | a rebuild changed `index-AZ22_Xh1` → `index-CilycHws`; the key matched nothing         |
| single-keystroke worst frame                | measured a programmatic `node.value=` set (44ms), not typing (16ms = sham)             |

A zero is the most dangerous reading an instrument can produce, because "the thing
I suspected isn't happening" and "I am not looking at the thing" are indistinguishable
from the output alone. Two defences, and you want both:

1. **Give every instrument a field that would contradict itself if it were misbound.**
   Not a status flag you set yourself — a value that *cannot* look right unless the
   binding is right. When run55's classifier reported 0 cache notifications during idle
   windows, its install-time readback (`nQueries: 42`, plus the exact `staleTime` and
   `notifyOnChangeProps` from `queryClient.ts`) proved it held the real client, and its
   typing arms proved it *could* record non-zero. Only then was the zero evidence.
2. **Cross-check against the app's own counters**, which cannot bind to the wrong
   object: `window.__sync_metrics__.snapshot()`. A number the app maintains for itself
   is immune to your patch being installed too late or on the wrong instance.

The corollary for verifying a *fix*: "the thing I removed no longer appears" is
also a confident zero. Confirm with a **behavioural side-effect only the new code
path can produce**. After the persisted-cache fix, `localStorage` key
`papercusp:sync-cache:v1` became *present* — pre-fix the oversize write threw and the
`catch` deleted the earlier snapshot, so the key was always absent. Only the fixed
path can leave it there, which no amount of "0 callbacks observed" could establish.

## Attributing a stall you cannot instrument: the MutationObserver bracket

Some of the most expensive main-thread work runs in a channel you cannot wrap.
React render/commit is the case here: `react-dom` constructs its Scheduler
`MessageChannel` at module init, long before any injected patch, so a
`window.MessageChannel` wrapper sees nothing and — per the section above — reports a
confident zero.

You can still attribute the stall, by bracketing it in time rather than wrapping it.
A `MutationObserver` callback is delivered as a **microtask at the end of the task
that performed the mutations**. So timestamp MO deliveries and compare them to each
stall's *end*:

* mutation batch delivered as the stall ends → the blocking task was **writing DOM**,
  which is what a React commit does
* no mutation batch → that task touched no DOM; React commit is **rejected** for
  that stall, look elsewhere

On WI-6502 this turned an unexplained residual into an attributed one: 77% of
unattributed >33ms stalls ended with a DOM batch, and most occurred in *sham* arms
with zero keystrokes. Bound-check first, always — the run delivered 772 MO batches
overall, without which every "no DOM" verdict would have been an artifact of an
observer that was never observing.

Reusable probes: `/tmp/wi6502-run54/` (the bracket) and `/tmp/wi6502-run55/` (a
QueryCache notification classifier + analyser).

## A static grep is not an exposure count

"42 `backdrop-filter` declarations in the stylesheet" was 2 actually on screen.
Before ablating a CSS property, count what is *rendered and visible*, not what is
declared. And do not accept a "platform floor" you have not decomposed — an
earlier unattributed \~18ms term was nearly written off as unfixable and turned
out to be our own background gradients.

That trap recurred at larger scale and is worth stating as a rule. A \~36ms
once-per-second block survived every CSS ablation and looked exactly like a
platform characteristic; it was `startSyncCachePersistence()` re-serialising the
whole \~3.2MB query cache on every cache event — and, on inspection, it had never
successfully persisted anything (the write threw, the key was absent), so it was
pure cost. Two readings generalise:

* **"Nothing I ablate changes it" is evidence you are ablating the wrong layer**,
  not evidence the term is irreducible. Decompose it by attribution (stacks, the
  bracket above) before declaring it a floor.
* **Check that the expensive thing is achieving its purpose at all.** A cache that
  never writes, a memo that never hits, a guard that never fires: the cost is
  measurable, the benefit is assumed. Measure the benefit too.
