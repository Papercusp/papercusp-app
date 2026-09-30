/**
 * P-015 — hand-authored (rule, evidence) pairs, keyed by CONTENT (blockSha).
 *
 * These are the blocks whose rule and evidence share a clause, so no sentence
 * boundary separates them and only re-authoring can. Everything the segmenter
 * CAN cut losslessly is cut by `splitRuleEvidence` and never appears here — this
 * file is the irreducible remainder, deliberately kept as small as the segmenter
 * can make it.
 *
 * KEYED BY blockSha, NOT partKey OR LINE, for the reason D-011 re-anchored the
 * manifest: CLAUDE.md moves daily, and a pair keyed by position would be
 * silently reattached to whatever text drifted into that slot. Content-keying
 * gives the two behaviours we want and no third one:
 *   • a block that MOVES keeps its pair (sha unchanged),
 *   • a block that is EDITED loses it and returns to `needs-authoring`,
 *     which is correct — the pair was written against text that no longer exists.
 *
 * INVARIANT, enforced by the generator: every citation in the original block
 * (EI-/WI- ids, dates, clock times, backticked identifiers) must survive into
 * `rule` + `evidence`. Re-authoring that keeps every referent can still be a bad
 * paraphrase; re-authoring that loses one is wrong by construction, and that is
 * the failure worth making mechanical. `droppedCitations` reports violations and
 * the generator refuses to write on any.
 *
 * D-002 HOLDS: nothing here is deleted from CLAUDE.md. This is an additive
 * artifact; the projector is what will later consume it.
 */

/** @type {Record<string, { rule: string, evidence: string, note?: string }>} */
export const AUTHORED = {
  // ── Running / testing the desktop app ──────────────────────────────────────
  dd86c6c5de3e33e7: {
    rule:
      'Launch the desktop with `npm run dev` — never a bare `npm run tauri dev` / `cargo tauri dev`. ' +
      '`~/.cargo/config.toml` pins ONE shared Rust target dir for the whole box (`build.target-dir=~/.cargo-target`), ' +
      'so two concurrent desktop builds interleave writes to the GENERATED app-manifest and both die parsing it. ' +
      'Because `tauri dev` rebuilds on change, a second instance takes down the FIRST one too. Every `tauri dev` ' +
      'launched through npm claims a per-instance target-dir slot: a lone launch keeps the shared dir and its warm ' +
      'cache, a second one isolates automatically and says so. The claim lives at the `tauri` npm script ' +
      '(`bin/tauri-guarded`, which sources `bin/lib/claim-target-dir.sh` for the `dev` subcommand only) — a chokepoint ' +
      'every launcher already passes through, so `npm run dev`, `dev:hmr`, `bin/desktop-preview-prod` and ' +
      '`scripts/verify-tauri-headless.sh` are all covered. Still unprotected by construction: a `cargo tauri dev` ' +
      'that skips npm entirely. Don\'t.',
    evidence:
      'The shared target dir was set 2026-06-17 to stop per-checkout `target/` dirs bloating to ~150G. The collision ' +
      'surfaces as `build.rs:305 panicked: failed to run tauri_build with the app-command manifest (WI-1976): failed ' +
      'to parse JSON`. On 2026-08-02 an agent starting its own instance killed the owner\'s live desktop (WI-7101). ' +
      'It reads as a mystery because the malformed file is generated, not tracked — `git status` is clean and every ' +
      'checked-in `capabilities/*.json` parses fine. The claim used to be wired into `bin/desktop-dev-nohmr` alone, ' +
      'which left it a convention each new launcher had to remember, and three then forgot — including the ' +
      'headless-verify script this file tells you to use, so the documented safe practice was itself launching an ' +
      'unprotected build (EI-19369470572700441). `papercusp-desktop/test/tauri-dev-slot-chokepoint.test.js` fails if ' +
      'a launcher routes around it again.',
  },

  // ── Scheduler / timer visibility ───────────────────────────────────────────
  '7347d1d483bd1a29': {
    rule:
      'Federation of the timer inventory was necessary but NOT sufficient: a timer can be missing from the inventory ' +
      'of its OWN process when that process holds two instances of a shared registry package, each with its own ' +
      'module-level Map. Several ordinary seams produce this (tsx\'s CJS-preflight + ESM loader, bare-vs-relative ' +
      'specifiers, and symlinked `node_modules/@papercusp/*`). The registry\'s state is pinned to `globalThis` under ' +
      'a `Symbol.for` key, so it is single-instance regardless of the seam. Two general readings: a probe\'s negative ' +
      'covers only the conditions it reproduced, and unobservable is not empty. Full story: ' +
      '[schedule:inventory is per-process](/internal/docs/agent-insights/schedule-inventory-is-per-process).',
    evidence:
      'Until 2026-08-03, `dbos-executor-reaper` reaped every 2 min inside bg-host while absent from ' +
      '`/api/internal/managed-timers` served by that same pid, because the process held two instances of ' +
      '`@papercusp/scheduled-registry`. A tsx probe "falsified" the dual-instance theory and cost a wake. On the ' +
      'unobservable-is-not-empty half: `:3070` has no such route at all (verified: zero mentions of `managed-timers` ' +
      'anywhere in the release checkout), and a `.get(\'timers\', [])` parse turns its `{"error":"not_found"}` into a ' +
      'false `total 0`.',
  },

  '86f722ae4bb03cc1': {
    rule:
      'Absence from an inventory is evidence only when there is exactly one inventory. The surface responsible for ' +
      'reporting a problem can be the very surface the bug blinds, which is what makes this class expensive to find. ' +
      'Module duplications now ride on that route beside the timer list.',
    evidence:
      'Measured (EI-19451658870832332): `@papercusp/scheduled-registry` was evaluated twice in bg-host, so ' +
      '`dbos-executor-reaper` reaped every 2 minutes while ABSENT from `/api/internal/managed-timers` served by that ' +
      'same pid. It cost 6+ days and several sessions.',
  },

  // ── Retired surfaces ───────────────────────────────────────────────────────
  '58d885ee0a8a483c': {
    rule:
      '**What enforces this section.** `lint:no-retired` guards re-imports of `_retired/` modules as a repo-wide ' +
      'invariant guard (`scripts/affected-tests.mjs`), running on every changed TS/JS path, alongside ' +
      '`lint:no-retired-resurrection`. The CLAIMS IN THIS SECTION are themselves guarded by ' +
      '`packages/operator-core/lib/doc-claims/retired-surfaces.test.ts`: every path named here must resolve, and a ' +
      'surface listed as living in a `_retired/` directory must actually be there. That guard exists because the ' +
      'failure is silent in one direction — a doc that wrongly says LIVE self-corrects the first time someone greps, ' +
      'while one that wrongly says RETIRED just quietly diverts work away from shipping code.',
    evidence:
      'As of EI-19971915610840229 that enforcement is finally TRUE rather than aspirational: the `lint:no-retired` ' +
      'script existed but NOTHING invoked it for months, so the guarantee this section asserted was never actually ' +
      'checked.',
  },

  // ── Blockers ───────────────────────────────────────────────────────────────
  d13c7576dbc0c9e0: {
    rule:
      'Interactive (human-present) PSU sessions can still take a fast redirect from the owner, but the default is ' +
      'resolve-don\'t-relay.',
    evidence: 'The human-session specifics live in the PSU engineer playbook (EI-148).',
  },

  // ── Pipeline position ──────────────────────────────────────────────────────
  '30b49b47eb162a97': {
    rule:
      '**"Is my change live, and if not what is the ONE thing blocking it" is ONE call — `dev:pipeline_position ' +
      '{ path }` — never a hand-diff.** It answers three *different* questions that agents routinely conflate:',
    evidence:
      'Hand-resolving those three questions cost 11 tool calls and 4 `merge-base`/`git log` diffs on 2026-07-26 and ' +
      'still went wrong twice.',
  },

  d362d142d70c9160: {
    rule:
      'The block is derived from each cell\'s own `changeSignal` declaration, so it cannot drift from the registry — ' +
      'a cell added, renamed or re-pathed shows up (or stops showing up) on its own (`state-plane-stamp.ts`).',
    evidence: 'Landed under state-plane-adoption-2026-08-02 P-010.',
  },

  '581dc74b98270b5e': {
    rule:
      '⚠⚠ **Distrust any older note claiming this cell\'s sha was "already marker-preferred per WI-7035".** One ' +
      'resolver produced TWO shas for the same subject and they DISAGREED during a re-triage window. ' +
      '`reconcileGateCandidates` now makes the headline marker-preferred and labels it, so the two agree by ' +
      'construction. The transferable lesson: when a doc credits a fix to a field, verify the fix landed on THAT ' +
      'field — read the writer, not the citation.',
    evidence:
      'This passage asserted the OPPOSITE of the truth for six days, in three different ways (WI-36259, fixed ' +
      '2026-08-08). WI-7035 fixed `checkpointRunInFlight.candidate` ONLY — its own title says so — while the cell\'s ' +
      'headline, `changeInCandidate.judgingSha`, came from `checkActiveCheckpointRun`, which never reads the marker ' +
      'at all. So `checkpointRunInFlight` named the live candidate while the cell this file points triagers at named ' +
      'the ABANDONED one. The doc also sent readers to `changeInCandidate.candidateSource`, a field that never ' +
      'existed (it was on `checkpointRunInFlight`).',
  },

  '337410ab9c5553d7': {
    rule:
      '**Corroboration requires independent EVIDENCE, not independent recall.** Two agents agreeing is not ' +
      'confirmation when both merely inherited the same unstated convention. The claim in this box is pinned to the ' +
      'code by `packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts`, so a gate that legitimately starts ' +
      'reading a remote ref fails there and forces this text to be updated with it.',
    evidence:
      'This section documented containment in enormous detail for months while never stating the premise, and the ' +
      'cost landed on 2026-08-09 (WI-37590, EI-20022093720663793): two agents independently assumed `origin/staging`, ' +
      'and one broadcast gating advice built on it to three peers mid-incident before retracting it. Their ' +
      'independent agreement *felt* like corroboration.',
  },

  '905572c674904636': {
    rule:
      'It returns the judged sha (`changeInCandidate.judgingSha` — marker-preferred since WI-36259, see above), ' +
      '**its provenance (`source.authoritative` — check this before acting)**, the containment falsifier ' +
      '`judgingContainsPath` (*is the gate judging MY change*) with its own prose attached, a `verdictUnknown` hoist ' +
      'naming anything it could NOT determine, and the `resolver` that produced them. The cells and the doors read ' +
      'the SAME resolver (`gitPipelinePosition()`), so this is a re-read of the authority, never a second source of ' +
      'truth. **Everything below — the marker SQL, the log greps, the ancestry and blob archaeology — is the ' +
      'FALLBACK**: reach for it when the cell answers `unknown`, when `source.authoritative` is false and the ' +
      'distinction matters, or when you need a field the cell does not carry (the refire budget, a run\'s ' +
      'failing-file set).',
    evidence: 'Verified live 2026-08-08.',
  },

  '60250492788fcac9': {
    rule:
      '⚠ **Do not try to settle step 0 by reading a checkpoint worktree.** There are at least two and their names ' +
      'differ by one letter — `papercup-checkpoint` and `papercusp-checkpoint` — plus transient ' +
      '`papercusp-checkpoint-simtmp-*` dirs. A worktree HEAD is a *live* read of a tree that may be between runs, ' +
      'mid-reset, or simply not the one the gate is using.',
    evidence:
      '`papercup-checkpoint` had a HEAD dated 2026-07-02, a month stale. On 2026-08-02 neither worktree matched the ' +
      'candidate the tool was reporting, and reading the wrong one produced a confident wrong answer that went out to ' +
      '16 agents.',
  },

  e1af662ccab3c67b: {
    rule:
      '⚠ On that same `held_externally: true` (cron) reply the fields have **OPPOSITE** trustworthiness, so do not ' +
      'tar them with one brush:',
    evidence: 'This file used to tar them with one brush, and so discredited the only reliable one (WI-7041).',
  },

  ca43c68547dbee87: {
    rule:
      '**FALLBACK — the routines marker in Postgres (the CELL above comes first).** This is the RAW source the ' +
      'resolver itself reads through (WI-7035), so hand-querying it repeats work `state:read { cell: ' +
      '\'gate.greenCheckpoint.candidate\' }` has already done. Come here when the cell answers `unknown`, or for a ' +
      'field it does not carry: `consecutiveReds`, the refire budget, or a marker you need to age-check yourself. It ' +
      'is the only RAW read that answers step 0 for a SCHEDULER-fired run, and the raw authority for a LIVE one:',
    evidence: '',
    note: 'Rule-only in substance; the WI-7035 reference is a pointer to the resolver, not an incident citation.',
  },

  c41b95c6a3886a4c: {
    rule:
      '⚠ **Do not collapse that to a single `grep … *T*Z.log | tail -1`.** The glob expands sorted by the UNIT-NAME ' +
      'segment before the timestamp, so the alphabetically-last file is not the newest run. Select the file by mtime, ' +
      'then grep it.',
    evidence:
      'Measured 2026-08-02, the one-liner returned a candidate from a 2026-07-17 log belonging to a different unit.',
  },

  '3761d46f9c0383c1': {
    rule:
      'A run\'s log re-emits its candidate line once per candidate, so the LAST match is the sha being judged and the ' +
      'number of matches is how many candidates that run has had. The verdict\'s own persisted log independently ' +
      'names the candidate in its FILENAME ' +
      '(`~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-4961cfb8b3fc.log`), and those two sources are ' +
      'independent, so when they agree the candidate is settled. Note the persisted log is written at each pass\'s ' +
      'END, so during a live run it names the PREVIOUS pass — use the persisted filename to confirm a COMPLETED ' +
      'verdict, and for a run still in flight prefer the `inFlightRetriage` marker above (the `/tmp` unit log only ' +
      'exists if that run was fired MANUALLY).',
    evidence:
      'Measured 2026-08-02 on the live 08:37Z run: `14fb28da` at byte 177, `auto-refiring (attempt 1/2)`, then ' +
      '`4961cfb8` at byte 2281 — two candidates, one run, and the second is the real one.',
  },

  '5a5690739c04fb6e': {
    rule:
      '⚠ **Do NOT take the FIRST match, and do not trust `release:checkpoint-run`\'s `candidate` over this grep.** ' +
      'The field reports the LAST candidate and adds `initial_candidate` / `refire_observed`, so a candidate that ' +
      'legitimately MOVED says so instead of looking like corruption. Its `held_externally` sibling fails the ' +
      'opposite way: it reads the checkout\'s live HEAD, so it is CORRECT but silently changes between two reads. ' +
      'That opposite-direction pair is why two careful agents can observe contradictory things and both be right.',
    evidence:
      'Until EI-19327704778173646 that field came from a bare `.match()` on the log — the FIRST occurrence — so ' +
      'after a refire it reported the sha the run had already DISCARDED, while the reply\'s own prose said "verify ' +
      'your fix against THAT sha."',
  },

  e3108c7d3552e458: {
    rule:
      '⚠ Two traps specific to this grep: keep the `*T*Z.log` glob (bare `-manual-*.log` also matches the synthetic ' +
      'test logs), and note these shas are **8-hex** on purpose (`candidate.slice(0, 8)`), so the "ignore any sha ' +
      'that is not 40-hex" rule stated below applies to the displacement lines, *not* to `checkpointing candidate`.',
    evidence: 'The synthetic-test-log collision is EI-19326961954611487.',
  },

  '2871112e9809531a': {
    rule:
      'Blob identity answers "does this candidate carry my fix" and NOTHING else — it does NOT predict whether a ' +
      'test will appear in the next failing set, because `test:affected` selects suites from each candidate\'s OWN ' +
      'changed paths. This is the dangerous shape: rigorous method, real measurements, confident wrong answer.',
    evidence:
      'Measured 2026-08-03 (EI-19424058100380982): `apps/operator/app/_lints/css-tokens.test.ts` is byte-identical ' +
      'between candidate `3b70938b2a` (which red\'d on it) and `cf84126b` — and `cf84126b`\'s verdict ' +
      '(`coverage=complete fileCount=3`) does not contain it. An agent broadcast the prediction hive-wide off a ' +
      'correctly-run blob check and had to retract it.',
  },

  ff9dbad65884491e: {
    rule:
      'Use `git log -S… | tail -1`, never `-1`: `-S` lists count-changing commits NEWEST first, so `-1` returns the ' +
      'most recent rather than the INTRODUCING commit, and testing ancestry with the wrong one reports a false ' +
      'NOT-IN.',
    evidence:
      'Verified in this repo 2026-08-02 — `backingTables` in `sync-resolver/index.ts` has five count-changing ' +
      'commits, and against gate candidate `1ee32228` the two forms disagree:',
  },

  '1bfad109ddc70171': {
    rule:
      'Searching by a NAME you did not introduce needs `-G`, not `-S`: a commit that rewrites a line without ' +
      'changing occurrence counts is invisible to `-S`, so `--is-ancestor` then answers correctly about the WRONG ' +
      'commit.',
    evidence:
      'Verified in this repo 2026-08-02 on `apps/operator/lib/adv-roster-args.ts`. The gate-red fix `66908db5bf` ' +
      'changed `-export interface AdvRosterArgs {` → `+export type AdvRosterArgs = {`, leaving the count at 1:',
  },

  '203e6d3bd65dea44': {
    rule:
      '**Rule of thumb: searching by a name you did NOT introduce → `-G`; by a string you DID introduce → `-S`. When ' +
      'in doubt run both — they disagree only in the cases that matter.** Note that the BLOB-IDENTITY check above is ' +
      'immune to both this and the `tail -1` trap, which is why it is the primary and log archaeology is the ' +
      'fallback.',
    evidence:
      'Cost when it fired: an agent used `-S`, concluded a peer\'s correct root-cause attribution could not be ' +
      'corroborated, and broadcast that doubt hive-wide before retracting it (WI-7030).',
  },

  '51fca1dac01a6da7': {
    rule:
      '⚠ **This corrects two claims this section used to make.** Both were wrong, and together they pushed the fleet ' +
      'onto the unreliable path:',
    evidence:
      'Three agents independently hit the resulting false verdict inside ten minutes on 2026-08-02 ' +
      '(EI-19325709344484737, EI-19325915429897280).',
  },

  '77f6913ba2a01865': {
    rule:
      '⚠ **`reason: \'newer-commit\'` is the SECOND face of that same bug — and unlike `uncommitted` it fires on a ' +
      'fully-committed change.** The check appears to compare the path\'s *current* content (or its latest touching ' +
      'commit) rather than asking whether the commit that INTRODUCED your edit is an ancestor of the candidate. So ' +
      'on any file the fleet edits, a peer\'s commit landing after yours flips your file to `missing … reason: ' +
      '\'newer-commit\'` and *stays* there — the tip is always newer than the quiet-cut candidate. Two ways it ' +
      'actively misleads: `excludedCommitsTouchingYourFiles` names that **peer\'s** commit as the one "carrying your ' +
      'file", and the warning prescribes *"wait out the quiet window (~4 min) and re-fire"* — a fresh ~55min gate ' +
      'clock for a candidate that already contains your fix. **Neither reason code is evidence about your change — ' +
      'settle it with ancestry+blob above, and treat every containment field (`marker`, `changeInCandidate`, ' +
      '`callerEditsInCandidate`) as a hint that fails in the direction of arguing for a wasteful re-fire.**',
    evidence:
      'Observed 2026-08-02 08:00Z (EI-19326775809436764). Measured: `sync-resolver/index.ts` came back ' +
      '`missing`/`newer-commit` citing a peer\'s unrelated `readOutbox` change, while ' +
      '`git merge-base --is-ancestor 07d759d576 4a9b218b` said IN and a blob grep counted the fix present. Three ' +
      'agents had built a re-fire plan on that verdict before it was caught.',
  },

  a80149aab0210259: {
    rule:
      'The auto-refire mechanism makes true observations look mutually contradictory: ' +
      '`checkpointRunInFlight.candidate` advancing under an **identical `startedAtMs`** is not corruption — it is ' +
      'the auto-refire\'s signature. A `ps` showing ONE process across that window is simultaneously true and does ' +
      'not contradict it.',
    evidence:
      'This single unstated mechanism cost 5–6 agents ~2h and at least four public retractions on 2026-08-02; the ' +
      'advancing-candidate observation was retracted as impossible, and `ps` showed one process since 07:15Z.',
  },

  '213721f3ce9a76cf': {
    rule:
      '⚠ The ` candidate=` anchor is prophylactic here, not a fix for an observed break. Keep it anyway: this marker ' +
      'is the one whose **absence** carries the most meaning (see the next paragraph), and absence is precisely what ' +
      'a future impostor line would erase. The two markers that ARE currently defeated this way are `GATE_HELD_BY` ' +
      'and `AFFECTED_TESTS_RESULT`.',
    evidence: 'No test name embeds `GATE_PROMOTION` today (measured 2026-08-10). The defeated pair is tracked as WI-37636.',
  },

  f687b7b41747698f: {
    rule:
      'The missing datum in a gate-verdict dispute is rarely the VERDICT; it is whether the verdict COUNTED — which ' +
      'is why the promotion decision is emitted as its own trailer rather than inferred from a suite result.',
    evidence:
      'Why it exists (EI-20014356905761236): 2026-08-09 ~21:53Z, one question about candidate `33cd2bfebec8` drew ' +
      'three different answers from three authoritative surfaces — this log said `green=true`, `release:deploy` said ' +
      '`skipped-locked`, and gate_health\'s `observedCandidate` still named an older red. Six tool calls to ' +
      'reconcile, and `main` had not moved.',
  },

  '7df078897fc37db4': {
    rule:
      'Read **`coverage`** before `files`, because an empty list is ambiguous in the expensive direction. ' +
      '`complete` = every failed task was attributed. `partial` / `unattributed` = some (or all) failed tasks could ' +
      'NOT be named down to a file — a TTY run with no captured child output, a worker crash/OOM that printed no ' +
      'FAIL rows, or a non-vitest task like cargo — and each such task is listed with its reason. **`files=[]` never ' +
      'means "nothing failed"** unless `coverage=none`. `run=` is the same token as the `Full run log:` path, which ' +
      'is how you tell this run\'s break set from a fixture line in an interleaved verdict log.',
    evidence: 'The ambiguity was filed as EI-19395701908500754.',
  },

  '1d18a6f3ff88a7b1': {
    rule:
      'A parse failure in one module reds every test file that transitively imports it, so all of them attribute ' +
      'cleanly and the run stamps `coverage=complete` over a list of innocent CASUALTIES. Nothing in the output says ' +
      'the files share one cause.',
    evidence:
      'Measured 2026-08-09 (WI-37607): run `465313-5f9da4f2` reported `coverage=complete fileCount=21 ' +
      'unattributedCount=0` from ONE peer mid-write on ' +
      '`packages/operator-core/lib/sync/hyperbee/log-snapshot.ts:592`; the file was clean minutes later and a 3-file ' +
      're-run passed 69/69. The same shape had already reached the GATE — run `3993890-864b7768` from the ' +
      '`papercusp-checkpoint` checkout: 7 files, `coverage=complete`, one parse error in ' +
      '`lib/memory/corpus-recall-io.ts:58`.',
  },

  ad99342c423e745d: {
    rule:
      '**`GATE_HELD_BY` is the line to read** — banner text is prose, this is the verdict\'s own data. Leg banners ' +
      'are now conformed and ratcheted (`green-checkpoint-leg-banner-shape.test.ts`).',
    evidence:
      'Why this exists: candidate `dca4c291` (verdict 2026-08-03T17:27:30Z, part of the 6-red streak that held ' +
      '`main` at `5b898b7b` for ~4h) carried `AFFECTED_TESTS_RESULT status=passed tasks=58 failed=0`, **no** ' +
      '`AFFECTED_TESTS_FAILING_FILES` line at all, and **no** `FAILED (npm run …)` line — a genuine red whose cause ' +
      'appeared in neither place a triager looks. The real cause (`lint:no-control-bytes`) occurred twice in 12,562 ' +
      'lines, both inside the leg\'s own output block, because 3 of the 12 leg banners omitted the word FAILED that ' +
      'the other 9 use. (WI-9613)',
  },

  '2130881cdce5a4b3': {
    rule:
      '⚠ **A verdict log older than 2026-08-03 has no such line — and the fallback recipe this file used to give was ' +
      'itself a phantom-path generator.** `grep -oE \'FAIL +[^ ]+\\.test\\.ts\'` does not merely skip a `.tsx` ' +
      'suite: `\\.test\\.ts` matches the PREFIX of `…PreviewPanel.test.tsx`, so `-o` prints the truncated ' +
      '`app/adv/create/PreviewPanel.test.ts` — **a file that does not exist**. A reader then goes looking for a file ' +
      'that isn\'t there and doubts their tooling rather than the recipe. Match the full extension set, and both row ' +
      'shapes — vitest prints `FAIL` rows for only the first few failures but emits a `❯` rollup row for every ' +
      'failing file:',
    evidence:
      'Measured on the 060ea000f206 log: 11 paths out, one of them fabricated, and the real ' +
      '`app/adv/create/PreviewPanel.test.tsx` absent — the same symptom as mining fixture prose, from a different ' +
      'cause. The production parser, `scripts/lib/vitest-summary.mjs`\'s `VITEST_TEST_FILE_SOURCE`, always had the ' +
      'right shape; only this doc\'s hand-rolled copy was wrong.',
  },

  '38855efd6b674f62': {
    rule:
      '`skipped-locked` costs no verdict: the run that HOLDS the lock produces it. A fleet of agents firing manual ' +
      '`release:checkpoint-run` to green their own changes is the *documented normal cause* of these rows ' +
      '(`release-actions.ts:400-409`).',
    evidence:
      'Measured over a 36h window (2026-08-09): **8 of 8** completed skips were followed by a real verdict from the ' +
      'lock-holding run within 11–54 min — one of them naming the *same candidate* — and the 6 that could not be ' +
      'paired to a `/tmp` manual log each had a verdict land 29–55 min later. **Zero verdicts were lost.** The ' +
      'pattern dates from the 2026-07-16/17 stall, and the consequence that actually mattered — a manual run not ' +
      'dispatching a release-fixer — was already fixed by EI-13723.',
  },

  bafb8f043a1b35d5: {
    rule:
      '**On this fleet the tree outruns the gate, so treat every red as STALE until you have RUN each failing file ' +
      'at HEAD** (`npm run test:file -- <paths>`). A status derived from the log — yours or a peer\'s — is not a ' +
      'status at HEAD. That is the base rate, not a fluke.',
    evidence:
      'Measured 2026-08-03 on candidate `060ea000f2`: it printed that phrase while `loop:checkpoint`\'s prompt ' +
      'weight had already been trimmed 1589 → 1495 by `eb872e9ea8`, and `git log 060ea000f2..HEAD` on both budget ' +
      'test files was **empty**. All 11 of that red\'s files were already green at HEAD — 7 verified by running ' +
      'them. (EI-19394456914198611)',
  },

  e470e518549f64bb: {
    rule:
      '✅ **The wording is FIXED IN TREE — but the run-it-at-HEAD rule above stands unchanged, and the fix is NOT yet ' +
      'deployed**, so a live verdict can still emit the old sentence until the next green+deploy. The presumption ' +
      'now requires the RANGE to be empty rather than merely to exclude the failing test files, so you will start ' +
      'seeing a fourth outcome:',
    evidence: 'Fixed in tree as of 2026-08-03 (EI-19390159514676981).',
  },

  '035cd82fccacabd1': {
    rule:
      '⚠ **Do not glob `/tmp/papercup-green-checkpoint-manual-*.log` and take the newest.** Tests write synthetic ' +
      'placeholder shas into that same namespace, and `ls -t` routinely returns the TEST file first. Real run logs ' +
      'are `…-manual-<unit>-<ISO>.log`, so match **`/tmp/papercup-green-checkpoint-manual-*T*Z.log`** and ignore any ' +
      'line whose sha is not 40-hex.',
    evidence:
      'Filed as EI-19326961954611487. Observed 2026-08-02: the newest match was `…-manual-ryte5.log`, containing ' +
      'only `was judging 11111111 … superseded by 222222222222` — which reads as a real replaceStale displacement ' +
      'and is not.',
  },

  '804950dd37c9775c': {
    rule:
      '✅ **You no longer have to remember to check — the verb itself now refuses with the answer.** ' +
      '`release:checkpoint-run`\'s `already_running` reply reads the marker and, when a refire is in flight for THAT ' +
      'run, leads its `note` with `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN`, names both candidates (the one being ' +
      'judged **and** the one already discarded), lists the files the abandoned red named so you don\'t go fix them, ' +
      'and reports the budget via `in_flight_retriage.budget`/`at_cap`. Its containment check switches to the ' +
      'marker\'s candidate too, so `callerEditsInCandidate` answers about the sha actually being judged rather than ' +
      'the checkout HEAD inference. A marker written BEFORE that run started is deliberately NOT attributed to it ' +
      '(the run-lock is a singleton, so it belongs to an earlier run) and the pre-existing refusal is returned ' +
      'unchanged — `in_flight_retriage: null` means "no refire in flight", never "unknown".',
    evidence:
      'Shipped as EI-19343516395023183 and **LIVE** as of the 2026-08-03 02:30Z deploy (release `13d9c65db69c`, ' +
      'verified present in the running release checkout — it was staged-but-undeployed for the preceding 12-red ' +
      'streak).',
  },

  d908fbc2598db63e: {
    rule:
      '⚠⚠ **`systemctl --user is-active papercup-green-checkpoint-manual-1fxzuva` does NOT tell you that YOUR run is ' +
      'alive — that unit name is a FIXED string reused by every fire.** A peer\'s freshly-launched run therefore ' +
      'wears the byte-identical unit name, and `is-active` answers `active` *truthfully, about a different run*. ' +
      'This fails in the direction that wastes the most time: you keep waiting on a verdict that already landed, so ' +
      'nothing looks wrong — there is no error, just a true answer to a question you did not ask. **Compare ' +
      '`ExecMainPID` against the pid your own launch reported; it is the only field that separates one fire from the ' +
      'next:**',
    evidence: 'Filed twice, as EI-13624 and EI-6544.',
  },

  '0d34c7edbd65d8b9': {
    rule:
      'The `/tmp` log has the same recycled-identity defect: the `…-manual-1fxzuva.log` symlink is re-pointed on ' +
      'each fire, so it follows the newest run rather than yours — read the timestamped filename, or better, the ' +
      'verdict\'s own `~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-<sha>.log`, which names its candidate.',
    evidence:
      'Measured 2026-08-10T00:35Z: `ActiveState=active` with `ExecMainPID=3347263`, while the run that agent had ' +
      'launched was pid `953011` and had already recorded `green:false reason:not-green` **an hour earlier**. Its ' +
      'own carried note read *"my run is in flight — re-check with `is-active`"*, a check that stayed true, about ' +
      'the wrong subject, for the whole hour.',
  },

  '7c2c63a4925fceb3': {
    rule:
      '- **Schema = migrations only; NO runtime DDL.** ⚠ **Pick the migration number via the atomic allocator — ' +
      'NEVER `ls sql/ | tail` by eye.** On this heavily-parallel fleet, two agents racing an `ls`-then-write gap ' +
      'WILL pick the same NNN. Run `node scripts/next-migration.mjs --name <slug> --intent "..."` (or ' +
      '`npm run db:next-migration --`) FIRST — it reserves the number atomically under an advisory lock ' +
      '(`harness_shared.migration_reservations`) and prints a `.DRAFT`-suffixed path to write. **Write + iterate at ' +
      'that `.DRAFT` path, not the bare `.sql` name**: the runner only ever applies files matching `*.sql` (same ' +
      'mechanism as the pre-existing `NNN-*.sql.PENDING-CODE-DEPLOY` idiom), so a `.DRAFT` file is invisible to boot ' +
      'auto-apply / `db:migrate` / the green-checkpoint preflight while you edit it — including a deliberate ' +
      'temporary both-ways guard-test mutation, which otherwise races the operator\'s auto-apply and can execute ' +
      'half-finished SQL against the live DB. Once it\'s finished and tested, ARM it with the tool\'s printed ' +
      '`arm_command` (`mv <path>.DRAFT <path>`) at `libs/papercusp/libs/db/sql/<NNN>-…sql` (≥107), and run ' +
      '`node libs/papercusp/libs/db/scripts/pull-schema.mjs`. Never an `ensureXxx()` / inline `CREATE TABLE`. ' +
      '`000-baseline.sql` is frozen/generated.\n' +
      '- **Never hardcode `localhost:5432`** — resolve via `getHarnessAdminUrl()`. Embedded-pg is the ship target; ' +
      'the dev box runs native PG on `:5432`.\n' +
      '- **Reading PG-canonical state? Query PG — don\'t dump-and-jq a projection.** Plans, work-items, issues, ' +
      'observations (`engineer_issues`), `tool_invocations`, scorecards, recipes live in Postgres; the `*:list` ' +
      'tools and `docs/plans/*.md` files are *projections*. `dev:pg_query` is for **genuinely ad-hoc / analytic** ' +
      'reads (a one-off group-by, join, or recency slice you won\'t run repeatedly). A HOT read with a stable shape ' +
      'belongs behind a TOOL that wraps the canonical SQL so it can\'t drift — e.g. "what\'s claimable" is ' +
      '`work_items:claimable`, NOT a raw floor query (see the claimability note below). **Before you write `SELECT`, ' +
      'check this table** — these are the reads agents most often hand-write, and each already has a tool that ' +
      'scopes + applies the real semantics for you:',
    evidence:
      'The duplicate-number race is EI-6843 — it cost a rename plus every in-code reference plus a re-verify when ' +
      'caught. The `.DRAFT` mechanism is EI-19366138707071397.',
  },

  '4f2e5f8d46afcfb8': {
    rule:
      '**The Bash tool\'s own description says "the working directory persists between commands" — that is only ' +
      'true while you stay INSIDE this repo tree.** `cd /tmp/some-scratch-dir` succeeds and holds for the REST of ' +
      'that one call, but the *next* Bash call starts back at this repo\'s root, with a post-hoc `Shell cwd was ' +
      'reset to <repo root>` note on the PRIOR call\'s result — no warning before it runs, just after. `cd` to a ' +
      'path still *inside* the tree (e.g. a package subdir) genuinely persists across calls with no reset. So the ' +
      'boundary is exactly "inside vs. outside this tree", not "cd never persists".',
    evidence: 'Verified live (EI-19409936180303618, 2026-08-03).',
  },

  ffff959586dce219: {
    rule:
      'Background mode has its own deadline default/ceiling, and the deadline sends SIGTERM before SIGKILL so the ' +
      'job\'s `trap`/`finally` cleanup actually runs. **If you are reading a pre-2026-08-02 note that says a ' +
      'backgrounded job "died at exactly 120s" or "vanished with no cause", that was a bug — not your command.**',
    evidence:
      '⚠⚠ That deadline **used to be 2 minutes** — the background mode inherited the FOREGROUND default, so the ' +
      'remedy this very section prescribes SIGKILLed precisely the jobs it recommends it for, unless you happened to ' +
      'also pass `timeout` (WI-6677). Fixed 2026-08-02. The old SIGKILL skipped cleanup, stranding a 489MB checkout ' +
      'and a 4.9GB deb extract in two separate incidents.',
  },

  '3f1b752321c68ef0': {
    rule:
      '⚠ **A background command\'s own reported exit code is the LAST statement\'s, not the one you care about — ' +
      'never trust it for a compound command, native OR `capability:bash`.** The natural idiom for capturing a ' +
      'verdict — `timeout 900 <cmd> > log 2>&1; echo "EXIT=$?" >> log` run with `run_in_background: true` — silently ' +
      'defeats itself: when `<cmd>` is killed by `timeout` (exit 124) or fails, the trailing `echo` still runs and ' +
      'exits 0, so the **native** Bash tool\'s own completion notification reports "completed (exit code 0)" for a ' +
      'run that never finished. That notification is Claude Code\'s own bookkeeping (the shell process\'s exit ' +
      'status, not `<cmd>`\'s) — there is nothing in papercusp to patch here; treat it as untrustworthy for any `;`- ' +
      'or `&&`-chained command and grep the log\'s own `EXIT=` line instead (it reads `$?` immediately after ' +
      '`<cmd>`, so it IS accurate). **`capability:bash` does not need this idiom at all** — its background job ' +
      'registry (`bash-jobs.ts`) tracks the real child process\'s exit code natively (not from a caller\'s echo) and ' +
      '`capability:bash_output` returns it as `exit_code`; trust that field directly. It also already applies ' +
      '`-o pipefail` so a piped command (`cmd | tail -60`) reports the pipeline\'s real exit code, not the last ' +
      'stage\'s — the same masking bug, different shell construct. If you find yourself appending ' +
      '`; echo "EXIT=$?"` to a `capability:bash` command, that is a sign you\'re hand-rolling something the tool ' +
      'already gives you for free.',
    evidence: 'EI-19314565734665863, hit twice in one session on 2026-08-02. The pipefail half is EI-13414.',
  },

  '5e1bca1a7df7dedb': {
    rule:
      '⚠ **Never wait on a process-table pattern you typed yourself.** `until ! pgrep -f \'<pat>\'; do sleep 5; ' +
      'done` can NEVER exit from an agent shell: `pgrep -f` matches the FULL command line, and your own `bash -c` ' +
      'argv contains the literal pattern, so the poll matches ITSELF and the condition stays true forever — the same ' +
      'self-match class as the documented `pkill -f` trap. `ps … | grep <pat>` loop conditions share the defect, and ' +
      '`grep -v grep` does NOT save you (the `bash -c` wrapper still matches). The PreToolUse gate now denies the ' +
      'loop form. Wait on the PID instead (`tail --pid=<pid> -f /dev/null`, or `kill -0 <pid>` in the loop) — or, if ' +
      'you genuinely must pattern-poll, bracket the first character so the pattern cannot match its own argv: ' +
      '`pgrep -f \'[l]int-tsc\'`.',
    evidence: 'A peer burned 27 silent minutes exactly here (EI-19312699396945642).',
  },

  '143dc7b8bb9a5f84': {
    rule:
      'Treat `top -n1` as usable here; the two-sample `/proc` recipe is still the one to reach for, because it needs ' +
      'no column-index guess (`%CPU` is field **9** in `-H` output, not 8 — field 8 is the state column, and ' +
      'misreading it yields a whole column of `S` that looks like data).',
    evidence:
      '⚠ EI-20017779937060288 reports that `top -b -n1 -H` prints **0.0% for every thread** (a first-iteration ' +
      'artifact). **That did NOT reproduce** — re-measured 2026-08-10 against the same pid at the same load, ' +
      '`top -b -n1 -H` reported 99.9% on exactly the 2 hot threads of 13 and 0.0% on the idle ones, agreeing with ' +
      'the `/proc` delta above.',
  },

  '0c123901804f11e4': {
    rule:
      '⚠ **Waiting on the right PID isn\'t enough for an `npm run <target>` you launched detached — the PID you can ' +
      'grab immediately is usually the WRAPPER, not the real work, and a wrapper-PID wait returns exit 0 while the ' +
      'job is still running.** `npm run build` here is a chain (`build` → `docs-build-singleflight` → `build:inner` ' +
      '→ `astro build`, and similarly for other package scripts); `pgrep -f \'npm run <target>\'` matches the outer ' +
      '`npm` process, which forks the leaf and can exit/return well before the leaf finishes. A ' +
      '`tail --pid=<that PID> -f /dev/null` wait then comes back in seconds while the build is still printing its ' +
      'first few lines — reading exactly like "the job finished successfully," which is worse than an obvious ' +
      'failure because nothing looks wrong. Resolve the **leaf** process before waiting (e.g. ' +
      '`pgrep -f \'[a]stro build\'` for an Astro target — bracket the first character per the self-match rule ' +
      'above), or don\'t rely on wait-exit alone: also grep the job\'s own log for a terminal marker (`Complete!`, ' +
      '`EXIT=`) before concluding it\'s done. Treat wait-exit as necessary but not sufficient.',
    evidence: 'Filed as EI-19340089056227272.',
  },

  '3081f67c74f4b6c9': {
    rule:
      '⛔ **The dark allowlist is SHRINK-ONLY — never reconstruct or grow it, and never build a parallel one.** ' +
      '`KNOWN_DARK_FLAGS` exists ONLY to express the small set of genuinely-not-ready exceptions above (incomplete ' +
      'code / would-break-the-running-fleet / owner-authority / staged-cutover) — it is **NOT a parking lot for ' +
      'finished work**. `DarkCase` splits the set into two populations governed differently: the ' +
      '`DARK_FLAGS_HIGH_WATERMARK` size ceiling in `libs/flags/src/types.ts` (imported by ' +
      '`production-defaults.test.ts`) governs ONLY the **`parked`/`incomplete`** subset ' +
      '(`DARK_FLAGS_PARKING_COUNT`) — the actual parking-lot abuse; it **fails the build if THAT subset grows**, not ' +
      'the aggregate `DARK_FLAGS.size`. `owner-authority` / `cutover` entries (permanent or staged safety ' +
      'kill-switches) are **not rationed** by the watermark at all — they are governed only by the ' +
      '`DARK_FLAGS_REVIEW_BY` re-review date, so a legitimate new safety flag never has to fight a parking-lot ' +
      'budget. So: flipping a `parked`/`incomplete` flag ON *removes* its allowlist entry (the parking subset ' +
      'shrinks ✓); shipping a NEW genuinely-incomplete flag dark requires first **graduating an existing ' +
      'parked/incomplete dark flag** to make room (net-zero) or **explicit owner sign-off** to raise the watermark — ' +
      'never a quiet append. **Do NOT route around this guard** by re-introducing a second dark allowlist, a ' +
      'per-flag `process.env.PAPERCUSP_*` gate, a `darkReason` side-table, or any other parking-lot for ' +
      'finished-but-scary work: the temptation to park it dark "to verify later" is *exactly* the abuse this exists ' +
      'to stop — flipping it on and watching it work IS the task.',
    evidence:
      'Owner mandate 2026-06-23; the allowlist was being abused as a parking lot. The two-population split is ' +
      'WI-4495 — a single aggregate ceiling used to penalize adding a legitimate safety kill-switch exactly as hard ' +
      'as parking finished work, which is why the watermark kept getting silently raised 22→24→25→26 for the SAME ' +
      'bug class every time.',
  },

  '697a35614c18dc09': {
    rule:
      '> ✅ **Editing `apps/operator` — including `lib/release/green-checkpoint.ts` — use ' +
      '`npm run lint:tsc:operator -- --files=<the files you edited>`.** It is the same per-file baseline gate as ' +
      '`lint:tsc` (`scripts/lint-tsc-operator.mjs` + `apps/operator/.tsc-baseline.json`, ratchet-only-down), and it ' +
      'attributes correctly — it reports which of a file\'s errors PRE-DATE your change rather than blaming you for ' +
      'the standing baseline.\n>\n' +
      '> ✅ **You no longer have to know which gate to pick — name your files at ANY `lint:tsc*` gate and it routes ' +
      'you.** A gate that cannot judge the files you named resolves them against its SIBLINGS and prints the command ' +
      'that can: `RUN THIS to check them:  npm run lint:tsc:operator`. Coverage is read from each sibling\'s own ' +
      'exported declaration, so a new `lint:tsc:*` script is picked up the moment it lands.\n>\n' +
      '> ⚠ **It used to assert the opposite, so distrust any older note repeating it.**\n>\n' +
      '> **The transferable rule, which the fix itself had to obey:** a tool asserting a UNIVERSAL ("no X exists", ' +
      '"nothing will ever") is making a claim about a scope it usually cannot see — verify an absence against the ' +
      'registry/manifest (here, one `grep lint:tsc package.json`), never against one tool\'s refusal. The banner now ' +
      'says *"No typecheck gate FOUND"* and, when any gate\'s coverage could not be resolved, adds *"the search was ' +
      'INCOMPLETE, so this is \'none found\', NOT \'none exists\'"* — naming each gate it could not read. Replacing ' +
      'one confident universal with a better-informed confident universal would have been the same defect in a ' +
      'bigger hat.',
    evidence:
      '`lint:tsc:operator` was added 2026-08-02; the sibling routing is EI-19461218392796337, fixed + verified live ' +
      '2026-08-03 (these are scripts run from the working tree, so there is no deploy to wait for). The refusal it ' +
      'replaced read *"NO typecheck gate covers these — nothing local will ever catch a type error here"* — a ' +
      'UNIVERSAL concluded from two facts that do not imply it (the file is outside MY project; its workspace ' +
      'declares no `typecheck` script), never consulting the sibling gates. Being covered by a sibling while ' +
      'declaring no workspace script is the NORMAL arrangement here, so it was wrong in the common case. Measured ' +
      '2026-08-03: an agent trusted that sentence, fell back to hand-grepping a raw ' +
      '`tsc -p apps/operator/tsconfig.json` against a 579-error baseline, concluded 5 type errors it had just ' +
      'introduced into `green-checkpoint.test.ts` were "pre-existing", and shipped them — `lint:tsc:operator` ' +
      'flagged them instantly (`18 of this file\'s 23 error(s) PRE-DATE your change`, `exit=1 regressed`). The file ' +
      'it wrongly declared uncoverable implements the fleet\'s release gate.',
  },

  '40311cdd1b01ddbe': {
    rule:
      '> ⚠ **Do NOT reach for `npm run --workspace <dir> typecheck` as the fallback — most workspaces have no such ' +
      'script and it dead-ends with `npm error Missing script: "typecheck"`.** The trap is the READING, not the ' +
      'error: "Missing script" invites the conclusion *"this workspace has no typecheck, so there is nothing to ' +
      'run"*, which is wrong — the code is perfectly checkable, nothing was checked, and you proceed believing you ' +
      'verified it. The command that always works is the tsconfig directly:\n>\n' +
      '> ```bash\n> npx tsc --noEmit -p libs/generic/<pkg>/tsconfig.json\n> ```\n>\n' +
      '> ✅ **`libs/generic/*` is no longer on the uncovered list above** — `lint:tsc:workspaces` (a ' +
      'green-checkpoint leg) now gates a package on having a **tsconfig.json**, not on having remembered to declare ' +
      'a script, so all 54 are checked routinely and a new package is covered the moment it has a tsconfig. ' +
      '`apps/*` and other `packages/*` are still script-only and remain report-only: promotion requires measuring a ' +
      'root first (`PROMOTE_ROOTS` in `scripts/lint-tsc-workspaces.mjs` says why, and the run prints every directory ' +
      'still unreachable).',
    evidence:
      'Measured 2026-08-03: of 53 `libs/generic/*` packages with a tsconfig, only 7 declared a `typecheck` script. ' +
      'Filed as EI-19409185011887864.',
  },

  '3e0a7eb255eca08d': {
    rule:
      '> ✅ **`--files=` no longer lies about this.** Naming a path outside the project a gate compiles used to scope ' +
      'the VERDICT to files that compile never saw, so the run printed a clean result having typechecked **none of ' +
      'them** — a green indistinguishable from a real pass. Now the gate checks coverage BEFORE the ~150s compile: ' +
      'if *every* named file is outside, it exits **1 in ~0.15s** and names the command that does cover them (prefer ' +
      '`npx tsc --noEmit -p <workspace>/tsconfig.json` — see the Missing-script warning above); if only some are, it ' +
      'warns loudly and still reports the covered verdict. Coverage is derived from each CLI\'s own `-p` operand, so ' +
      'all four per-project gates (`lint:tsc`, `lint:tsc:operator-vite`, `lint:tsc:orchestrator`, ' +
      '`lint:tsc:papercusp-libs`) inherit it. It fails OPEN on an unparseable command — never a red it cannot ' +
      'substantiate.',
    evidence:
      'Filed as EI-19341572300046923. The false green is how two operator-vite reds reached the fleet gate on ' +
      '2026-08-02.',
  },

  c1a57a19187b8bff: {
    rule:
      '> ⚠⚠ **The same false green also arrives via a CRASH, which the zero-file guards above cannot see — a ' +
      'hand-run `tsc` on operator-core OOMs and is killed BEFORE printing one diagnostic.** The program is ~9k files ' +
      'and overflows node\'s default ~4GB old-space:\n>\n' +
      '> ```\n> FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory\n' +
      '> Aborted (core dumped)          # exit 134\n> ```\n>\n' +
      '> A dead run emits **zero** `error TS####` lines, so every probe you would naturally reach for reads exactly ' +
      'as it would on a clean compile — `grep -c "error TS"` → `0`, `grep <my-changed-file>` → nothing.\n>\n' +
      '> **Never conclude "clean" from an absence of matches — read the run\'s exit status.** The tools now do it ' +
      'for you: `npm run lint:tsc`, `build:typecheck` and `capability:inspect { check:\'typecheck\' }` all pin the ' +
      'heap (`PAPERCUSP_TSC_HEAP_MB`, default 8192) so the OOM does not happen, and all three refuse a ' +
      'nonzero-exit-with-no-diagnostics run rather than reporting it as a pass. If you must hand-run tsc, set ' +
      '`NODE_OPTIONS=--max-old-space-size=8192` and check `EXIT=` — never the grep alone.',
    evidence:
      'EI-20019651513530828 / EI-20013137550825704, both measured 2026-08-09. One agent got to within a step of ' +
      'recording "operator-core typechecks clean with the new required field", on precisely the required-field ' +
      'question the next paragraph flags as the classic silent breaker.',
  },

  '696c41418fa6d887': {
    rule:
      '**Don\'t do that by hand — `npm run lint:required-field-strands`** AST-diffs your change against `HEAD` and ' +
      'names every exported type that gained a required field, nested paths included. It also catches a field ' +
      'TIGHTENED from optional to required, which strands sites just as hard. It is ADVISORY by design — adding a ' +
      'required field is usually correct, so the mere addition is never a failure; `--typecheck` runs `lint:tsc` and ' +
      'exits non-zero only on real stranded sites. Finding the sites was never the hard part — `tsc` already does ' +
      'that perfectly; the gap this closes is *knowing to run it*. ⚠ Do NOT "fix" the errors by making the new field ' +
      'optional: that silently reintroduces whatever under-reporting the required field was added to prevent.',
    evidence:
      'Shipped as WI-6814. The 2026-08-02 case lived one level down, inside `excluded: {}`, where a top-level scan ' +
      'reports nothing and reads exactly like "no trap here". Making the field optional again is exactly the ' +
      'WI-6409 claim-floor bug.',
  },

  '753269b6f7e24b96': {
    rule:
      '⚠ **A `-t <pattern>` that matches ZERO tests is a run that measured NOTHING — and it used to report ' +
      '`status=passed`.** Vitest merely SKIPS every test and exits 0. Same shape as the two zero-work false-greens ' +
      'documented above (`tsc -p .`, `test:affected`), and it fires in the most expensive direction: the canonical ' +
      'reason to pass `-t` is to confirm a **pre-fix RED**, and a false green there reads as "the defect isn\'t ' +
      'real", so the natural next move is to stop — having verified nothing. The router now refuses it ' +
      '(`TEST_FILE_NAME_FILTER_NO_MATCH`, exit 2 = NOT MEASURED per the `scripts/lib/test-file-exit-codes.mjs` ' +
      'contract — it was exit 1, the genuine-red code, until EI-21884126680256710 — and deliberately NO ' +
      '`TEST_FILE_RESULT` line, since its presence is ' +
      'what callers grep to mean "tests ran"), and `testing:run` refuses the same via ' +
      '`error: \'name_filter_no_match\'`.',
    evidence:
      'Filed as EI-19425177453558152: `Tests 625 skipped (625)` sat one line above ' +
      '`TEST_FILE_RESULT … status=passed`.',
  },

  '0c7b4511eae63346': {
    rule:
      '**`npm install`/`npm ci` on this shared tree is a mutation every OTHER concurrent agent can see mid-flight — ' +
      'serialize it, never run it bare.** `node_modules` is unsynchronized global mutable state: one agent\'s ' +
      'install rewrites `node_modules/.bin` out from under every other agent\'s test run (`vitest: not found` / a ' +
      'bare `ERR_MODULE_NOT_FOUND` into `node_modules` — neither error names the real cause), and two OVERLAPPING ' +
      'installs can leave a package durably HALF-WRITTEN (e.g. a `dist/` with only `.d.ts` files, zero `.js` — not a ' +
      'version-resolution problem, does not self-heal). Always run **`npm run install:safe`** (passes through to ' +
      '`npm install` by default; `node scripts/npm-install-safe.mjs ci` / `... install --legacy-peer-deps` for other ' +
      'subcommands) instead of a bare `npm install`/`npm ci` — it serializes concurrent installs across every agent ' +
      'process on the host via a filesystem mutex (`scripts/lib/fs-mutex.mjs`, keyed off the repo root\'s ' +
      'real/symlink-resolved path) before the rest of the tree ever sees a rewrite. If a test run ever fails with ' +
      'the signature above, another agent is very likely mid-install right now — `npm run test:file` detects it and ' +
      'prints a `TEST_FILE_MID_INSTALL_SUSPECTED` hint instead of leaving you to chase a phantom bug; wait for it to ' +
      'finish (or check `ps aux | grep \'npm install\'`) and retry.',
    evidence: 'The half-written-package corruption is EI-18662389554660036.',
  },

  '61a96076f8d15924': {
    rule:
      '⚠ **Hit a confusing "cannot find module" / Rolldown "failed to resolve" for a package that IS in ' +
      '`package.json`? Run `npm run doctor:deps` BEFORE you suspect a code bug.** Concurrent installs can leave ' +
      'npm\'s reify bookkeeping believing a dependency is resolved (it\'s in `package-lock.json`, and ' +
      '`node_modules/.package-lock.json` is newer) while the tarball was never extracted — so `npm install` prints ' +
      '"up to date", exits 0, and the first symptom is an unrelated build/gate failure 10+ minutes later. ' +
      '`doctor:deps` (`scripts/check-declared-deps-extracted.mjs`) checks in ~0.2s that every directly-declared ' +
      'dependency of every workspace actually resolves on disk, and `install:safe` now runs the same check ' +
      'automatically after a successful install (repairing once with a full `npm install --legacy-peer-deps`, then ' +
      'failing loudly) so the corruption surfaces at the install, not in someone else\'s build.',
    evidence:
      'EI-18666853411437489: 8 declared `mem0ai` peers missing on disk blocked a gate; two agents each mis-diagnosed ' +
      'it as a code bug first.',
  },

  '3c6daf2c989e9206': {
    rule:
      'A mutation probe that mutates the shared tree can be committed by the sweep even when nothing goes wrong and ' +
      'no handler fails. `git status` cannot warn you either: on a swept tree a clean status means the sweep ran, ' +
      'not that the file is unmodified.',
    evidence:
      'Both failure modes fired for real (EI-19450431506682666): `db6d7b02b1` committed a mutant of ' +
      '`scripts/verify-tauri-headless.sh` in which the fix\'s function was DEFINED but never CALLED — inert, ' +
      '`bash -n`-clean, and shaped exactly like a finished change. Had green-checkpoint cut a candidate from it, the ' +
      'recurrence guard written minutes earlier would have red-pinned the whole fleet on a mutation nobody meant to ' +
      'commit.',
  },

  '434cf3c3e6dc98ad': {
    rule:
      '⚠ **A `trap` alone does NOT restore promptly — bash will not run a trap handler while waiting on a FOREGROUND ' +
      'child.** The harness sends SIGTERM *then* SIGKILL, so a deferred handler is frequently never a handler at ' +
      'all. Run the guard in the background and `wait` on it (`wait` IS interruptible); `mutation-probe.sh` already ' +
      'does this, and kills the guard\'s whole descendant tree by pid rather than by name.',
    evidence:
      'Measured 2026-08-03: a SIGTERM during a 25s guard restored the file only after 23s, i.e. when the child ' +
      'happened to exit — which is exactly how the original mutant survived.',
  },
};
