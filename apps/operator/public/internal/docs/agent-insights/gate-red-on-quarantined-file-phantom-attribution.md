# Gate red on a QUARANTINED file — suspect phantom workspace attribution, not the quarantine
URL: /internal/docs/agent-insights/gate-red-on-quarantined-file-phantom-attribution

A green-checkpoint red whose only failing test is quarantined is a parser-attribution bug signature, not proof that per-file quarantine entries don't work. Diagnosis recipe + the 2026-07-17 fix.

**Per-file quarantine entries (`<workspace>::<file-glob>`) DO gate the v1 verdict.**
If a green-checkpoint run reds while its only failing test is covered by a
`quarantine.txt` per-file entry, do NOT conclude "per-file quarantine is
informational only" — that folk belief circulated in fleet memory and was this
bug observed without a root cause.

## The signature (incident 2026-07-17, run d945e8e3)

* Verdict JSON: `green:false`, `failingTests: []` (emptied!), and the summary
  carries `Quarantined out of v1 gate verdict: <the file>`.
* Re-triage says `unknown — no named failing tests — cannot re-run at tip`
  with `autoRefire:false` — the self-heal path is dead in the same breath.
* The gate log names ONE failing test, and it matches a `quarantine.txt`
  per-file glob (e.g. `@papercusp/operator-core::lib/sync/hyperbee/**`).

## Root cause

The affected-runner's gate path (`AFFECTED_RETRY_FAILED`, `scripts/affected-tests.mjs`)
captures each task's stdout/stderr and block-flushes them after exit. Vitest's
"Failed Tests" epilogue (` FAIL <file> > <case>` rows) can therefore land in the
merged log AFTER a LATER workspace's `>>> <ws> :: npm run` header.
`parseFailingFilesByWorkspace` (apps/operator/lib/release/green-checkpoint.ts)
attributed such a displaced row to the foreign header — a **phantom
`{workspace, file}` pair**. Quarantine matching is workspace-scoped, so the
phantom escaped the glob, `quarantinedLabels.length !== failingFiles.length`,
`allFailuresQuarantined` stayed false, and the run held red on a failure the
gate is explicitly configured to ignore (main sat 111 commits behind).

## The fix (2026-07-17, EI-13381)

`parseFailingFilesByWorkspace` now pre-scans `❯` rollup rows — child stdout
printed inside the child's own section, so their attribution is trustworthy —
and a bare `FAIL` row may only INTRODUCE a file the rollups never named (the
genuine transform/setup-error case, which emits no rollup). It can never
re-attribute a rollup-named file to whatever section its displaced epilogue
landed in. Regression tests: `green-checkpoint.test.ts` ("does NOT re-attribute
a rollup-named file via a displaced FAIL epilogue row…").

## Diagnosis recipe for the next weird gate red

Replay the exact run log through the real parsers — takes seconds and removes
all guesswork:

```bash
npx tsx -e "
import { parseFailingFilesByWorkspace, extractFailingTests, parseTestQuarantine, applyTestQuarantine } from './apps/operator/lib/release/green-checkpoint.ts';
import { readFileSync } from 'node:fs';
const out = readFileSync('<newest ~/.papercusp/checkpoint-logs/*.log>','utf8');
console.log(parseFailingFilesByWorkspace(out));
console.log(applyTestQuarantine(out, extractFailingTests(out), parseTestQuarantine(readFileSync('quarantine.txt','utf8'))));
"
```

A file attributed to a workspace that doesn't contain it = phantom attribution.
Related: [gate-red-break-window-triage](/internal/docs/agent-insights/gate-red-break-window-triage)
(stale-candidate reds), the quiet-cut note there for which commit a run judges.
