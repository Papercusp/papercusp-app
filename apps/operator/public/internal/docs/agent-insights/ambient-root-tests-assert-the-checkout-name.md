# A test that asserts an ambient-root value is secretly asserting the CHECKOUT NAME — and the shared tree can never falsify it
URL: /internal/docs/agent-insights/ambient-root-tests-assert-the-checkout-name

Deleting an env var is not hermetic when the code's fallback for a missing value is a real path on the box: the assertion then holds only in the one checkout where the paths coincide, so it passes in /papercusp and red-pins green-checkpoint from /papercusp-checkpoint. Includes the zero-mutation reproduction (spoof HOME, not the sha).

## The one-line takeaway

**`delete process.env.X` is NOT hermetic when the code's fallback for a missing `X` is a real path on the machine.** Deleting does not isolate the test — it hands control to the environment. The assertion then holds only in the checkout where the ambient path happens to coincide with the expected one, which is why it passes in the shared tree and fails in the gate's.

This is the TEST-side face of a documented root cause. For the diagnostic-read and enforcement faces, see
[a lock coordination domain is a property of the READER](/internal/docs/agent-insights/lock-coordination-domain-is-per-checkout).

## The concrete case (WI-38311, 2026-08-12)

`fileLockCoordinationDomain()` resolves candidates in order; candidate 3 is
`<PAPERCUSP_WORKSPACE_ROOT | ~/papercupai-workspace>/papercusp`. A test that wanted to
exercise the TERMINAL fallback deleted `PAPERCUSP_WORKSPACE_ROOT` in `beforeEach` — so
candidate 3 resolved the **live shared tree**, a real repo, and the resolver never reached
the fallback being asserted:

```
expect(fileLockCoordinationDomain()).toBe(lockCoordinationDomain())
```

| where the suite runs                | left side     | right side               | verdict               |
| ----------------------------------- | ------------- | ------------------------ | --------------------- |
| `…/papercusp` (shared tree)         | `…/papercusp` | `…/papercusp`            | PASS — by coincidence |
| `…/papercusp-checkpoint` (the gate) | `…/papercusp` | `…/papercusp-checkpoint` | **FAIL**              |

It red-pinned green-checkpoint and held `main` 243 commits behind staging. The resolver was
CORRECT throughout — that split is exactly what WI-38252 built. Only the fixture was wrong.

**The fix is one line of intent: PIN, don't delete.**

```ts
// NOT hermetic — hands candidate 3 to the machine:
delete process.env.PAPERCUSP_WORKSPACE_ROOT;

// Hermetic — candidate 3 can never resolve; each test opts IN to a root it created:
process.env.PAPERCUSP_WORKSPACE_ROOT = join(tmpdir(), 'no-workspace-root');
```

Also assert the property that a coincidence cannot satisfy. `toBe(lockCoordinationDomain())`
alone is satisfiable by two paths happening to match; `expect(...).not.toBe(notARepo)` — a bare
directory must never become a lock namespace — is the claim actually being made.

## Reproducing it WITHOUT mutating the shared tree

Re-running the test in the shared tree **passes and proves nothing** — that tree is the single
location where the coincidence holds. Do not reach for a copy-out or an in-tree mutation probe
either. Spoof the **ambient input**, not the sha:

```bash
FH=<scratchpad>/fake-home
mkdir -p "$FH/papercupai-workspace/papercusp/.git"
printf 'ref: refs/heads/main\n' > "$FH/papercupai-workspace/papercusp/.git/HEAD"

# The gate's condition, reproduced inside the shared tree. Prints both operands:
HOME="$FH" npx tsx -e "import { fileLockCoordinationDomain, lockCoordinationDomain } from './lib/.../coordination-domain.ts';
  console.log('EQUAL?', fileLockCoordinationDomain() === lockCoordinationDomain());"
```

`EQUAL? false` **is** the old assertion failing. Then run the fixed test under the same
`HOME=` and it passes. That is a complete A/B — old fails, new passes — obtained without ever
touching a tracked file, so there is no sweep race and no restore to forget.

Generalize: the ambient input is whatever the fallback reads — `HOME`, `process.cwd()`, or the
env var itself. Spoof that.

## How to recognise it from a gate red

The tell is **same sha, opposite results, different checkout**. When that happens, suspect
LOCATION before flake, and do not re-run in the shared tree to "confirm".

Read the gate's own log first — `~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-<sha>.log`
(path from `release-config.ts` → `checkpointLogDir`). It prints the failing case name and BOTH
operands, which settles the diagnosis immediately:

```
FAIL … > ignores a candidate directory that is not a valid repo root
Expected: "/home/…/papercupai-workspace/papercusp-checkpoint"
Received: "/home/…/papercupai-workspace/papercusp"
```

In the incident above, `git status` on the subject files, a HEAD-vs-worktree blob comparison,
and a re-run inside the gate's checkout all came back clean or inconclusive first. Two lines of
the gate's log ended it.

⚠ One trap while doing that: the gate's checkout is not pinned to tip between runs. It can be
sitting at a sha that does not even contain the test file, so a manual re-run there reports
`requested test file does not exist` — which is not evidence about the test.

## Why grep will not find these for you

There is no lexical signature. The bug is the ABSENCE of a pin, in a file whose `beforeEach`
looks conscientious precisely because it is deleting env vars. The reviewable question is not
"does this test clean up its environment" but:

> For every env var this fixture clears — **what does the subject do when it is missing?**
> If the answer is "resolves a real path on this machine", the test is location-dependent.
