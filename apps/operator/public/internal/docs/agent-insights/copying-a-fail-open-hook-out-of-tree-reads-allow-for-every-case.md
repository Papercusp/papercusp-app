# Copying a fail-open cc hook out of its directory makes every probe case read ALLOW
URL: /internal/docs/agent-insights/copying-a-fail-open-hook-out-of-tree-reads-allow-for-every-case

A cc hook's contract is 'never fail, print nothing on allow', so a hook relocated without its sibling files crashes at import and returns byte-identical output to ALLOW. Use hook-probe.ts (whole-directory copy + positive control + CRASHED verdict) instead of cp-ing one file to /tmp.

## The trap

Every Claude Code hook under `apps/operator/scripts/hooks/cc/` honours a cardinal contract: **never exit non-zero, and print nothing on the allow path.** That is what makes them safe in production. It is also what makes them silently *unmeasurable* out of tree.

Most hooks resolve **sibling files** beside themselves (`pc_tty.py`, `mcp_response.py`, `import('./x.mjs')`). To A/B a pre-fix version the obvious move is `git show <sha>:<path> > /tmp/hook.sh` and run it. That looks like it works: exit 0, well-formed (empty) output, no visible error. What actually happens: the sibling import raises (`ModuleNotFoundError` / `ERR_MODULE_NOT_FOUND`), the hook honours fail-open, and the caller sees **empty stdout, which is exactly the encoding of ALLOW.** Every case reads ALLOW — including the one that must BLOCK — and the matrix reads as "the bug does not reproduce", which is the reading that makes you close an item wrongly.

For most subjects a crash is loud. For a hook whose whole contract is silence, a crash is byte-identical to a verdict.

## The fix (use the helper, don't re-derive it)

`apps/operator/scripts/hooks/cc/__tests__/hook-probe.ts` (beside `spawn-hook.ts`):

1. **`materializeHookDir({ hookFile, content? | gitRef? })`** — copies the WHOLE hooks directory to a temp dir and overwrites only the subject with the historical bytes, so siblings resolve. Pass a **SHA** for `gitRef`, never `HEAD`: git-sync commits this tree continuously, so `HEAD` is a moving baseline and the "pre-fix" arm silently becomes your own edit.
2. **`assertHookInstrument(hookPath, { positiveControl, negativeControl? })`** — run a case that MUST block against the SAME copy before believing any ALLOW from it. A uniformly-ALLOW matrix is the tell; a failing positive control means the *instrument* is broken, not the subject (`HookInstrumentError`).
3. **`classifyHookRun` / `runHookVerdict`** — three-valued `ALLOW | BLOCK | CRASHED`. A BLOCK is positive evidence the hook ran (a crash cannot print a decision); an ALLOW must be proven clean (exit 0, empty stderr), so a crash is `CRASHED`, never folded into ALLOW.

The suite `hook-probe.test.ts` reproduces the footgun with a hermetic fixture (single-file copy reads ALLOW, the control rejects it), runs a current-vs-historical A/B, reads the old arm from a temp git repo by SHA, and calibrates against a real shipped hook.

## Generalisation

A **copy-out probe is only valid if the subject has no directory-relative dependencies**, and nothing checks that by default. `scripts/mutation-probe.sh` closes it for guards in general with `--relocation overlay` (the mutant is bind-mounted over the subject's OWN path, so every sibling still resolves) and, in historical mode, `--subject-must-behave`. The in-Vitest hook suites spawn hooks directly, so they use `hook-probe.ts`. See also [mutation testing without touching the shared tree](/internal/docs/agent-insights/mutation-testing-without-touching-shared-tree) and [a surviving mutation is a finding about the test](/internal/docs/agent-insights/a-surviving-mutation-is-a-finding-about-the-test).

Origin: EI-23757282243623667 (caught during EI-23745075736001151 by a positive control that returned ALLOW against the same copy).
