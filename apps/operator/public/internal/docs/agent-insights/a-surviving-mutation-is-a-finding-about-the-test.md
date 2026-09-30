# A surviving mutation is a finding about the test, not a pass — and the discriminator that fixes it is itself a rot risk
URL: /internal/docs/agent-insights/a-surviving-mutation-is-a-finding-about-the-test

A mutation that stays green has told you the assertion is satisfied by a DIFFERENT code path than the one under test. The usual mechanism is a wrapper error that quotes the inner error's text, so a positive toContain on the shared substring passes via the fallback. The fix — assert the other path's signature is ABSENT — lands you in the negative-literal rot class, and is a real guard only because lint:vacuous-negatives gates the DRIFTED case. Includes the four pot-git instances, why instance 4 is a different class from 1-3, and how to record a non-vacuity check without mutating the swept shared tree.

A mutation you expected to go red, and which stayed green, has not told you "the
code is covered twice". It has told you **the assertion is being satisfied by a
different code path than the one under test**. That is a measurement, and the
only correct response is to find out which path satisfied it.

The reflex this replaces — restore the mutation, shrug, "belt-and-braces, the
other test covers it" — is what let four separate vacuities accumulate in a
single pot-git area, each with a different mechanism, and every one of them
producing a *fast green* indistinguishable from a real pass.

## The rule

> **A mutation that does not go red is a RESULT to investigate, never a pass to
> shrug off.** Find which path satisfies the assertion, and pin it out.

## The mechanism behind most of them: a wrapper quotes the inner error

The common shape in this repo is an error message that embeds another error's
text. The inner text then propagates into every wrapper, so a positive
`toContain` on the *inner* substring is satisfied by any of them.

The live instance (2026-07-27, `fetch-transport.ts`): `serveUploadPack` reports
a failure reason via `onFailure`. Deleting the timeout path's own report left
the suite 9/9 GREEN, because the nonzero-exit fallback builds its message as
`upload-pack exited <code>: <stderr>` — and stderr *quotes* the idle text. So

```ts
expect(reason).toContain('300ms idle');   // satisfied by the FALLBACK
```

passed via a path that was not the contract. Both paths produce a string
containing the substring; only one of them is what the test claims to pin.

The fix is to assert the other path's signature is **absent**:

```ts
expect(failure).toContain('timed out after 300ms idle');
expect(failure).not.toContain('upload-pack exited');   // <- the discriminator
```

Re-running the same mutation now fails correctly. The discriminator is live in
`fetch-transport-idle-ceiling.test.ts`.

## ⚠ The discriminator is itself a negative-literal assertion — know what keeps it alive

This is the part that is easy to get wrong, because the fix above lands you
directly in a *second* documented failure class:
[a negative assertion pinned to a literal rots
silently](/internal/docs/agent-insights/negative-assertions-rot-silently). A
positive assertion pinning a literal is self-healing — reword the string and it
fails loudly. A negative one is the inverse: rewording makes it *more* likely to
pass, silently and permanently, as a direct consequence of doing the rename
correctly.

So `not.toContain('upload-pack exited')` is a real guard **only for as long as
`upload-pack exited` is still something the system can emit.** The two rules are
compatible, and the reason is mechanical rather than a matter of care:

* `npm run lint:vacuous-negatives` gates the decisive case. Its **DRIFTED**
  verdict fires when a long contiguous fragment of the literal *is* in the
  source — dead guard, live emitter — which is exactly what a reword of the
  fallback message would produce.
* The literal here is genuinely emittable: `fetch-transport.ts` builds
  `` `upload-pack exited ${code ?? -1}: ...` ``. That is why the assertion is
  not flagged today, and why a future reword *would* be.

Two consequences worth carrying:

1. **Prefer the distinctive prefix/shape of the path under test** over a shared
   inner substring. `toContain('timed out after 300ms idle')` pins more than
   `toContain('300ms idle')` does, before any negative is added.
2. A discriminator whose literal is *not* emittable anywhere is not a guard at
   all — it is an always-passing line. If you deliberately want a historical
   ratchet, say so with `// vacuous-negative-ok: <reason>`.

## Record the non-vacuity check where the next reader will see it

The strongest version of this discipline is to state, in the test file's header,
what you mutated and what happened. `serve-wiring.test.ts` does exactly that:

> *Confirmed non-vacuous: stubbing `noteSessionHighWater` to a no-op fails the
> "fires" and "new high-water" cases below.*

That one sentence converts an invisible property of the suite into something the
next reader can re-run and trust. Note also what it asserts *on* and why — the
same header explains that `potGitLog` is a deliberate no-op under vitest, so the
warn is unobservable in-process and the high-water bookkeeping is the observable
proxy written on the same branch.

⚠ **Do not prove this by mutating the shared tree.** The checkout is swept by
git-sync on a schedule, so a probe that holds a file mutated for the duration of
a suite can have the mutant committed even when nothing goes wrong and no
handler fails. Use `scripts/mutation-probe.sh`, which implements the copy-out
and historical modes; see the "Proving a guard is falsifiable" rules in the
project guide. When the assertion pins a string literal your own fix introduced,
there is a cheaper proof available: `grep` showing the token exists at exactly
one site means a pre-fix tree could not emit it, so the test is falsifiable by
construction and needs no mutation at all.

## The four instances, and why 4 is a different class from 1–3

All four produced a fast green. The first three never ran the code under test:

1. the serve guard rejected a tmpdir path pre-spawn → `timedOut:false` in \~30ms
   (needs `allowOutsideRoot`);
2. upload-pack was handed a worktree root instead of a bare repo → exits \~30ms;
3. a single `PassThrough` as the peer duplex looped the server's own
   `000eversion 2` banner into its own stdin → `fatal: unknown capability` in
   \~20ms.

Those are setup faults, and they are documented in the test file's header.
**Instance 4 is the one worth internalising: the test RAN the right code and
still did not pin it.** No amount of checking that the fixture is well-formed
would have caught it — only the mutation did, and only because its survival was
treated as a result instead of a relief.
