# A single green run cannot disprove a flake: load-sensitive races, and the soak lane that reddens them on purpose
URL: /internal/docs/agent-insights/load-sensitive-test-flakes-and-the-soak-lane

The MugTab flake was ~60% red under CPU pressure and 100% green in isolation — so re-running it once and seeing green 'cleared' it, twice, wrongly. The bug was a throttled nuqs URL flush racing a remount key; the real defect was the DETECTOR. How to reproduce a load-sensitive flake deterministically (taskset core-starvation), and how to prove your flake guard can actually catch one before you trust it.

## The failure, in one line

Two peers reported `MugTab.test.tsx` RED. I re-ran the file once, got 15/15 green,
and told them both it was a **false alarm**. It was not. The test was \~60% red
under CPU load and 100% green unthrottled — so my "disproof" was a coin flip I
happened to win.

**A single green run cannot disprove a flake.** It is not weak evidence; for a
load-sensitive race it is *no* evidence, because the condition that produces the
red (CPU starvation) is absent in the very run you use to clear it.

## The race itself (the shallow lesson)

`MugTab`'s reset path does two things that fight:

* `resetActivePane()` bumps `capacityResetVersion` — a **remount key** that
  discards local drafts. It applies **synchronously**.
* The models section's open flag is **nuqs-backed** (`?qModels`). nuqs applies a
  set **optimistically** but commits the URL write on a **throttle**.

A same-tick `expand → reset` therefore races: if the remount lands inside the
throttle window, the fresh hook re-reads a URL that never heard about the expand,
and the section comes back **collapsed**. Whether the remount or the flush wins is
pure CPU timing — on an idle box the remount always lost, so a synchronous
`getByLabelText('std model spec')` right after the reset always found the input.
Under load it won, and the test threw `Unable to find a label with the text of…`.

The fix is to stop depending on which side won a race the test was never trying
to test:

```tsx
// Re-open the section if the remount closed it, then assert the value.
const reExpand = screen.queryByRole('button', { name: 'Expand models' });
if (reExpand) fireEvent.click(reExpand);
const savedSpec = await screen.findByLabelText('std model spec');
expect((savedSpec as HTMLInputElement).value).toBe('sonnet');
```

Note what this is **not**: it is not a `waitFor` wrapped around the old assertion.
That was one of three wrong hypotheses (below), and it still failed — because the
input never comes back at all when the section is collapsed. Waiting longer for
something that will never appear is not a fix.

### Three wrong hypotheses, for calibration

Each looked plausible and each was disproved by actually reproducing the failure:

1. **"It's a timeout."** Bumped `findByLabelText`'s timeout. A **no-op** —
   `configure({ asyncUtilTimeout: 5_000 })` is already set globally in
   `libs/test-config/src/setup-testing-library-timeout.ts`, and the failure was
   *fast* (\~200ms), not a timeout.
2. **"It's a transient unmount."** Wrapped the assertion in `waitFor`. It then
   burned the full 5s and failed — **proving the input never returns**, which is
   what pointed at "collapsed", not "not yet rendered".
3. **"Wait for the expand to settle."** Awaited the `Collapse models` label flip.
   Still red \~3/6 — because the flipped label only proves nuqs' *optimistic* value
   applied, **not** that the throttled URL write committed. The optimistic value is
   exactly the thing the remount doesn't see.

The through-line: every hypothesis that treated the symptom as *slowness* failed.
The bug was a *lost write*, and only reproducing it under real starvation showed that.

## The actual defect: the detector

The race is a normal bug. The thing worth writing down is that **nothing in the
system could have caught it**, and the human process actively suppressed the
signal:

* CI/`test:affected` runs the suite **once**. A 60% flake passes 40% of the time.
* The natural "let me verify" reflex — re-run the file, alone, on an idle box — runs
  it in the exact configuration where it is **100% green**. The check is
  anti-correlated with the bug.
* So two independent peer RED reports were overridden by one green run. The
  evidence was pointing the right way and the detector pointed the other way.

This is the `prove-it-discriminates-before-it-acts` class wearing a testing hat: a
check that cannot separate the bad case from the good one is not a check.

## Reproducing a load-sensitive flake deterministically

The flake needs **CPU starvation**, not merely a busy box (which is unreliable and
unrepeatable). `scripts/flake-soak.sh` pins the whole parallel vitest run to a
small set of cores with `taskset`:

```bash
# soak a suspect suite 8x under 2-core starvation
scripts/flake-soak.sh --repeats 8 --cores 2 -- src/components/left-sidebar/MugTab.test.tsx
```

Pinning the *parallel* suite (many worker processes) to 2 of 128 cores makes the
workers timeshare hard: event loops congest, throttled timers (nuqs flushes, React
effect scheduling, RTL async) fire late, and same-tick races resolve the losing way.
That is precisely the mechanism above, so the flake reddens **on purpose**.

The lane aggregates and reports a **red-rate**, and exits non-zero if *any* repeat
failed — so "it passed once" can never again be mistaken for "it passes".

### Building the lane took three falsified theories — the log is the lesson

Every "obvious" way to induce the race failed, and each failed in the direction that
makes you *confident*. Measured against the real pre-fix `MugTab` fixture:

| config                                      | result             | verdict                        |
| ------------------------------------------- | ------------------ | ------------------------------ |
| fixture alone, 2 pinned cores               | 1/6 red            | too weak                       |
| fixture alone, **1** pinned core (harsher!) | **0/6** red        | harsher pinning = FEWER reds   |
| fixture + siblings, 2 pinned cores          | **0/6** red        | sibling contention didn't help |
| 12 competing hogs, nice 19, 4 cores         | **6/6 "red"**      | **FALSE — 0 tests ran**        |
| **8 cores, 8 hogs, nice 10**                | **1/10 red, real** | ships                          |

1. **"Starve it harder."** Falsified: pinning to *one* core reddened it **less**.
   Pinning gives a process *dedicated* (idle) cores — its workers timeshare fairly
   and every event loop still gets scheduled promptly. Pinning makes a run **slow**,
   not **preempted**.
2. **"The parallel workers are the load."** Also falsified: running the fixture with
   its whole directory on 2 cores was 0/6.
3. **What actually works: be low-priority *relative to competing work*.** The original
   repro was vitest **niced** (pc-heavy, +10) against a box at load 150–240. The race
   needs the runner's threads *preempted for long stretches* so the throttled nuqs URL
   flush lands after the remount. Reproduced with real competing CPU hogs at **normal**
   priority sharing the niced runner's cores.

### The trap that nearly shipped: a 6/6 red-rate with zero tests run

Turn that competing load up too far and vitest stops being slow and starts being
**broken**: `Failed to start forks worker` → `Timeout waiting for worker to respond` →
`Test Files  no tests`. A **non-zero exit in which no test ever executed.**

Scored naively that reads **6/6 red** — a detector reporting a 100% flake rate for a
test it never ran. It would have "proven" the lane worked. This is the same disease as
the original bug, one level up: **a check that cannot tell the failure it's looking for
from an unrelated failure.**

So `classify_run()` scores three outcomes, not two — `pass` / `red` / **`invalid`** — and
an infrastructure death is never counted as flake evidence. **A red is only trustworthy
if you read WHY it reddened**; the lane keeps the failing log so you can. The shipped
config's red is the real thing:

```
× resets Capacity without clearing Now or Work settings
TestingLibraryElementError: Unable to find a label with the text of: std model spec
Tests  1 failed | 14 passed (15)      ← tests actually RAN
```

### Sensitivity — an all-green soak is evidence, not proof

The lane reproduces the real flake at **\~10–17% per run**, against the \~60% the truly
loaded box produced: it recovers a synthetic *fraction* of ambient chaos. At p≈0.15,
**12 repeats ≈ 86% detection** (the default); 6 would be \~62%.

So quote the **red-rate** — "0/12 under load" — never "the soak passed, it's fine."
Collapsing a probabilistic result into a binary reassurance is the exact move that let
this flake survive two peer reports.

Deliberately **not** used: `systemd-run` / cgroup CPU quotas. The native-scheduler
lockout hook denies EVERY agent-session `systemd-run` invocation that asks for cgroup
resource control — `--user --scope -p CPUQuota=...` included, not just `--system`
(verified live 2026-07-26: both denied identically; WI-6116). It is an
AGENT-SESSION guard, not a host-wide one — a non-agent process (e.g.
green-checkpoint's own `isolate` path) runs outside it and can use `systemd-run --user` successfully — but this soak lane runs from an agent session, so it is
squarely in scope. `taskset` needs no scheduler, no root, and no daemon, so it works
unconditionally regardless of which side of that guard is invoking it.

> **Why not just `nice`?** `scripts/pc-heavy.sh` nices and holds a concurrency
> semaphore; under an *already busy* box that starves the run enough to expose this
> class, which is how the flake was originally caught. But it depends on ambient
> load, so it is not reproducible. Core-pinning is.

## Prove your flake guard can actually redden

A guard that only ever shows green has proven nothing — and a soak lane is *itself*
a detector, so it needs the same skepticism it exists to enforce.

`*.flakeproof.test.tsx` is a reserved scratch convention for exactly this:

* **gitignored** (`.gitignore`) — a deliberately-red fixture must never reach the
  tree, or CI goes red;
* **excluded from every normal run** (`apps/operator-vite/vitest.config.ts`) unless
  `FLAKE_SOAK_SELFTEST=1`, so it can't become a landmine in anyone's suite;
* run only by the lane's self-test, which **passes iff the fixture reddens**:

```bash
# drop a known-flaky fixture next to the code, then:
scripts/flake-soak.sh --self-test src/components/left-sidebar/MugTab.flakeproof.test.tsx
#   → exit 0  : the throttle induced the race. The lane discriminates.
#   → exit 1  : fixture stayed ALL-GREEN. The lane is NOT catching a known
#               load-flake — do not trust it until that is fixed.
```

The fixture used to validate this lane was not synthetic: it is the **real pre-fix
`MugTab.test.tsx`**, extracted straight from git (`git show <fix-commit>^:<path>`).
If the lane can redden the exact test that fooled three people, it can redden the
next one.

## The rule

* **Never clear a flake report with a single green run.** Soak it, and quote a
  red-rate over N runs. `0/8 under 2-core starvation` is a disproof; `1 green run`
  is not.
* **A flake that only reproduces under load is still a real red** — "it passes in
  isolation" is a description of the *detector's* blind spot, not a property of the
  test.
* **When a peer reports RED and you get green, believe the peer** until you have
  reproduced *their* conditions. The asymmetry is brutal: a false green costs the
  whole fleet, a false red costs one investigation.
