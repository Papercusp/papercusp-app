# A 200 proves liveness, not provenance — port probes pass for the wrong process
URL: /internal/docs/agent-insights/a-200-proves-liveness-not-provenance

An acceptance gate that probes curl :PORT/api/health for 200 measures that SOMETHING is listening, not that the artifact under test is what is listening. The two diverge exactly when a human or agent has been debugging on the machine — so the check is least trustworthy when it is most used. Includes the measured near-miss (a hand-launched host would have reported a defective DMG as PASS), why pkill -f 'papercusp-desktop' spares the very processes that contaminate the measurement, and the three assertions that make the gate fail for the right reason.

## The shape

You are proving a shipped artifact works. The gate is a port probe:

```bash
curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:3270/api/health   # 200 → PASS
```

That check cannot fail for the right reason. `200` says **something is listening on
that port**. It does not say **the artifact under test is what is listening** — and the
two diverge precisely when a human or an agent has been debugging on the machine, which
is every hands-on verification session. The probe is least trustworthy exactly when it
is most used.

This is the false-POSITIVE twin of
[“It never bound” usually means you asked the wrong port](/internal/docs/agent-insights/a-process-that-never-bound-may-be-bound-elsewhere).
That one is about absence (nothing answers, so you file a hang; the process was healthy
on another port). This one is about presence: something answers, so you file a PASS.
Same instrument, opposite errors, and neither is evidence about the artifact.

## The measured near-miss

The mac dogfood gate was “all 5 env buttons work”, verified by probing `:3270` (dev) and
`:3055` (local). During root-cause work the verifying agent had **hand-launched** both
listeners and hand-patched the extracted source tree. Measured immediately before the
“clean” run:

```
:3270 -> node 74768 (LISTEN)     # hand-launched
:3055 -> node 83703 (LISTEN)     # hand-launched
```

The harness would have printed `:3270 = 200`, `:3055 = 200` and reported the gate green —
attributing a human's manual intervention to the shipped DMG. That DMG demonstrably
carried the defect. A well-formed, confidently-stated, entirely wrong PASS.

## Why the harness's own cleanup did not save it

Step 0 ran `pkill -f 'papercusp-desktop'`. The env operators do not match that pattern —
they run as:

```
/Applications/Papercusp Server.app/Contents/Resources/sidecar/bin/node …
```

which contains no substring `papercusp-desktop`. The kill silently spared exactly the
processes capable of contaminating the measurement. The pattern *looks* comprehensive
(“kill everything papercusp”) and is not. This is the match-the-surface-not-the-process
error, and a sibling of the repo's standing **never kill by name or pattern** rule —
there the hazard is killing too much, here it is killing too little, and both come from
treating a substring as if it were an identity.

## The compounding hazard: a restored stale tree

`apps/operator/lib/dev-source-extract.ts` stamps the extracted tree with
`{size,mtimeMs}` of `source.tar.zst`; on mismatch it moves the tree aside, re-extracts,
and **on failure restores the old tree** (“LOUD: upgrade extract FAILED — restored the
previous (OUTDATED) tree”). So a hand-patched or stale tree can be resurrected by the
failure handler and keep `dev` working for a reason the artifact does not contain — a
second, independent route to the same false PASS. Two independent contamination routes
into one green is why the fix has to assert provenance rather than add another probe.

## The fix — assert provenance, not response

Three cheap assertions. The first alone kills the class:

1. **Pre-gate: the ports must be DARK before install, else ABORT.** Refusing to measure a
   contaminated machine is strictly better than measuring it and interpreting the result.
2. **Attribute ownership on every probe.** Resolve the listening pid, read its command
   line, and require it to live under the installed app bundle. A `200` from anything else
   is reported `CONTAMINATED`, never `PASS`.
3. **Check the artifact, not the symptom.** Assert the extracted tree actually contains
   the shipped fix, and that no hand-patch residue (`*.bak`) exists. This distinguishes
   “the shipped code is correct” from “this machine happens to work”.

```bash
# 2. ownership attribution — the minimum viable version
PID=$(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN | head -1)
[ -n "$PID" ] || { echo "DARK"; exit 1; }
CMD=$(ps -o command= -p "$PID")
case "$CMD" in
  /Applications/Papercusp*) echo "OWNED  $PORT pid=$PID" ;;
  *) echo "CONTAMINATED $PORT pid=$PID cmd=$CMD"; exit 1 ;;   # never PASS
esac
```

And kill by app-bundle path and workspace path, never by the `papercusp-desktop`
substring.

## The general rule

**A verification step must be able to fail for the right reason.** If the only way the
check can go green is indistinguishable from a stray process, a hand patch, or a restored
stale tree, it is not evidence about the artifact — it is evidence about the machine.

The repo already documents two instances of this same reasoning error, and they are worth
recognising as one family:

* `positions.deployed` read as “the running process executes my code” — the real signal is
  `serving.startedSinceCodeChange`. A git fact cannot state a process conclusion.
* A clean `git status` read as “this file was untouched”, on a tree a scheduled sweep
  commits for you.

Before trusting any “is it working” gate that reduces to a port probe, ask what else could
produce that exact green. If you can name something, the gate is measuring the machine.

## Scope note

The agent-facing launcher `scripts/verify-tauri-headless.sh` already defends its *own*
port against a squatter (`port_lost_to_squatter()`), which is the same reasoning applied to
the launch path. That mechanism protects the agent's own instance; it does not make an
acceptance gate over a *shipped artifact* trustworthy. The three assertions above are what
that second case needs.
