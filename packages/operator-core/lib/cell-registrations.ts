/**
 * cell-registrations.ts — the built-in cell registrations
 * (unified-agent-state-plane-2026-07-27 P-006, and P-007 extends this file).
 *
 * P-006's point is NOT to have a first cell. It is to run the D-038 contract
 * against SHIPPED code rather than a greenfield example, on the theory that a
 * contract derived from real cells should be registrable by one — and that if it
 * is not, we would rather learn it from the flagship cell than from the fifth.
 *
 * It did not pass first time, and the failure was worth the exercise. Recorded
 * here because the next author will hit the same wall:
 *
 * ── WHAT THE FIRST REGISTRATION ATTEMPT EXPOSED ─────────────────────────────
 *
 * `positions.*` were BARE BOOLEANS built by `refContains`, which returned
 * `contained === '0'` over a `GitRunner` that yields `null` on any failure. So a
 * FAILED git read produced `false` — byte-identical to the honest "your change
 * genuinely has not reached this stage". An agent reads `onStaging: false` and
 * waits for a stage it may already have passed.
 *
 * That is the same defect class as `systemctl is-active` printing `inactive` for
 * a unit that does not exist, sitting in the headline leg of the very cell we
 * intended to register as the contract's exemplar.
 *
 * The registry could not have caught it. Declaring `nullable: false` — which was
 * LITERALLY TRUE of the shipped type — passed the gate with zero rejections,
 * because axis 2's enforcement rests on a self-declared boolean no validator can
 * verify against the resolver's behaviour. Note the incentive that creates: an
 * author who admits their value can be unknown is asked for a hoist, while one who
 * ships a bare boolean sails through. The gate rewarded the weaker cell.
 *
 * So the fix was in the RESOLVER, not the declaration: `refContains` now returns
 * `boolean | null`, and an unreadable leg is named in `positionsUnknown` (the
 * D-039 result-level hoist, modelled on `unitsUnknown[]`). Only then could this
 * cell be registered honestly, which is what the declaration below now is.
 */

import { registerCell, type CellSpec } from './cell-registry';
import { AGENT_GOAL_CELL_ID } from './agent-goal-ref';
import { AUTHORITATIVE_JUDGING_SHA_SOURCES } from './judging-sha-source';

/* ═══════════════════════════════════════════════════════════════════════════════
 * cell-assessment-schema-and-falsifier-removal-2026-08-21 P-004/P-006 — EVERY CELL
 * DECLARES AN `assessment`, AND THE AXIS-1 FALSIFIER IT ONCE SAT BESIDE IS GONE.
 *
 * Each block below was translated BY HAND from the P-001 truth tables (D-009 for the
 * six pipeline/gate cells, D-010 for host/goal/testing), never derived from the
 * `kills` prose that used to sit beside it — D-011 rule 2. A `kills` sentence was a
 * NEGATIVE claim and a `safeAction` is a POSITIVE one, so mapping one onto the other
 * mechanically manufactures guidance nobody authored. That is also why P-006 could
 * DELETE the old field rather than translate it: where its INDEPENDENT measurement
 * still carried information, that measurement appears below as assessment EVIDENCE
 * (D-004) — a different job, substantiating the positive reading rather than refuting
 * a wrong one — and where it carried none, it left with the field.
 *
 * ── ⚠ WHY SOME OBVIOUS EVIDENCE PATHS ARE DELIBERATELY ABSENT ───────────────────
 *
 * MEASURED against the live door 2026-08-24, not inferred from the types: a
 * `dev:pipeline_position` response bounded to its own budget DROPS `serving.*`,
 * `positionsUnknown`, and `changeInCandidate.judgingShaSource`, and sets
 * `projection.truncated`. `assessmentFrom` (cell-read.ts) DOWNGRADES a resolved code
 * to `unavailable` when any declared evidence path did not arrive — so declaring
 * `serving.startedSinceCodeChange` as evidence here, however natural it reads, would
 * make `git.pipelinePosition` and `deploy.3070.sha` answer `unavailable` on the
 * ordinary path, forever. That is WI-38266 one field over, and it is exactly the trap
 * this file's own history warns about: the declaration that is LITERALLY TRUE of the
 * shipped type is not the one that survives contact with the door.
 *
 * So every evidence path below was checked against a real payload before it was
 * written, and the assessment CODE — computed inside the resolver, before any door —
 * is what carries the distinction those dropped legs used to make. That is the
 * contract earning its keep: an interpretation computed at the source survives
 * shaping that its raw inputs do not.
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * The release-pipeline resolvers below describe the operator HOME Pot's checkout,
 * gate, release process, and incident lease. Other harnesses in this workspace
 * have independent pipelines, so exposing these cells workspace-wide lets their
 * agents read Papercusp state as if it were their own (EI-20709429494940822).
 */
const OPERATOR_PIPELINE_VISIBILITY = { kind: 'harness', ref: 'papercusp' } as const;

/**
 * The pipeline-position cell. Owned by su-28464 per P-006 — registration does not
 * transfer ownership of the resolver.
 *
 * GRAIN NOTE (open, filed for P-003): `gitPipelinePosition()` is ONE resolver, which
 * satisfies axis 5, but it returns several independently addressable values
 * (`positions`, `stages`, `serving`, `changeInCandidate`, `gitSync`,
 * `sweepExposure`) with DIFFERENT independent checks and different caller-relativity.
 * "One resolver" therefore does not imply "one cell". This registers the composite
 * under its strongest such pairing; if the registry later grows a declared grain, this
 * spec should split rather than be stretched.
 */
export const GIT_PIPELINE_POSITION_CELL: CellSpec = {
  cell: 'git.pipelinePosition',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'positions.deployed',


  /**
   * D-009's ladder, first-match. The codes are ORDERED CLAIMS about one journey, so
   * the safe actions differ by LEVER rather than by urgency — and two of them tell
   * the reader to do nothing, which is the point: `awaiting-push` and
   * `awaiting-gate` are states agents routinely mistake for something to fix.
   *
   * ⚠ `live` vs `restart-required` is decided by `serving.startedSinceCodeChange`,
   * which the door drops (see the file header). The code below is the ONLY surviving
   * carrier of that distinction — which is precisely why it must not be re-derived
   * downstream from `positions.deployed`, the exact misreading CLAUDE.md has had
   * filed against it four separate times.
   */
  assessment: {
    path: 'assessments.pipelinePosition',
    codes: {
      live: {
        meaning:
          'The path is deployed AND the serving process started after that code last changed — the running process is executing it.',
        safeAction: 'Exercise the behaviour through the running service; no deploy or restart step is outstanding.',
      },
      'restart-required': {
        meaning:
          'The code is deployed, but the serving process has been running since BEFORE the code changed, so it is still executing the old bytes.',
        safeAction:
          'Restart the serving runtime named by `serving.restartLever` (dev:restart). A further deploy will not change what is running.',
      },
      uncommitted: {
        meaning: 'The edit exists only in the working tree — git-sync has not committed it yet.',
        safeAction:
          'Finish the atomic edit and leave it in the tree; the git-sync sweep commits it. Do not hand-commit, and do not stash or branch to isolate it.',
      },
      'awaiting-push': {
        meaning: 'Committed locally, not yet on origin/staging.',
        safeAction:
          'Nothing to fix — or fire `git-sync:run` if you specifically need it on the REMOTE now. Note the gate cuts its candidate from LOCAL staging, so this state does not block gate entry.',
      },
      'awaiting-gate': {
        meaning:
          'On staging, not yet fast-forwarded into main: no green-checkpoint verdict has promoted a candidate containing it.',
        safeAction:
          'Read `gate.greenCheckpoint.verdict` before you wait — a red or non-firing gate is a lever you can act on, not a queue to sit in.',
      },
      'awaiting-deploy': {
        meaning: 'In main, but the release checkout has not been moved onto it yet.',
        safeAction:
          "Wait for the release trigger, or expedite with release:deploy { op:'trigger', confirm:true } — which can only ship the already-green pin and refuses on a red gate.",
      },
    },
    evidence: ['dirtyUncommitted', 'positions.committedLocal', 'positions.onStaging', 'positions.inMain'],
  },

  /**
   * Axis 2. TRUE, and it is true because of what the first registration attempt
   * found — not as a formality. A leg whose git read fails is unknown, and saying
   * `false` for it is manufacturing a verdict from an absence.
   */
  nullable: true,
  unknownHoist: 'positionsUnknown',

  /**
   * Axis 3. Explicitly `parameter`, not `global`: this cell answers per-path, and
   * it is the cell that motivated the axis. Two different paths legitimately get
   * two different answers from the same repo state.
   */
  callerRelativity: { kind: 'parameter', param: 'path' },

  /** Axis 4. Live-exercised — and this cell is the reason that rule exists: its
   *  `realGit` defect (a `stdout.trim()` eating a leading space) was invisible to
   *  every fixture and only ever surfaced against the real repo. */
  provenance: {
    obtainedBy:
      'git rev-list/rev-parse/ls-remote against the live repo, plus a live systemd probe for the serving leg',
    liveExercised: true,
    evidence:
      'gitPipelinePosition() run against the real repo 2026-07-27 for both a real path and a sha-only probe; the sha-only branch returned the enumerated not-applicable unknown and the prose surface rendered unchanged.',
  },

  /** Axis 5. ONE resolver; dev:pipeline_position PROJECTS it and never re-derives. */
  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  /**
   * P-019 (a)/(b). Harness-visible: pipeline position is about the operator HOME
   * Pot's shared tree. Other harnesses in this workspace have independent trees and
   * gates, so showing them this value would answer "did my commit land" about the
   * wrong checkout.
   *
   * `local` despite that: the positions are relative to THIS hive's checkout and
   * serving process, so the value is not merely uninteresting to a foreign hive, it
   * would be actively misread there as a statement about their own pipeline.
   */
  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },

  /** Poll rides predicate_watches — deliberately NOT a second subscription mechanism. */
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },

  shape:
    '{ positions, positionsUnknown[], stages[], serving, changeInCandidate, gitSync, sweepExposure, summary }',

  /**
   * Axis 6. This cell is one of the few that legitimately claims an order — which is
   * itself decent evidence that demoting `ordered` to OPTIONAL was right, rather than
   * it being contract-level. Most cells have no sequence at all.
   */
  ordered: { stages: ['committedLocal', 'onStaging', 'inMain', 'deployed', 'serving'] },
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * P-007 — THE FOUR VERDICT CELLS
 *
 * These are the values agents were demonstrably hand-COPYING out of pipeline reads
 * and into prose, where they went stale and were then acted on. The point is not to
 * format them better (D-032/D-034 settled that presentation proves nothing); it is
 * that a cell is RE-DERIVED at the moment of acting.
 *
 * ── GRAIN: #D-065 ───────────────────────────────────────────────────────────────
 * Four SIBLING cells over the ONE `gitPipelinePosition()` resolver, which is also
 * `git.pipelinePosition`'s resolver. That is axis 5 SATISFIED, not stretched: axis 5
 * demands exactly one resolver per cell and explicitly blesses surfaces that PROJECT
 * or subset a derivation ("one derivation, many lenses"); what it forbids is
 * RE-deriving. Each cell below is a lens. The alternative — telling agents to read
 * the composite `git.pipelinePosition` — would defeat the item's entire purpose,
 * since the observed behaviour is agents copying these four values SPECIFICALLY.
 * This also discharges the GRAIN NOTE above: the registry now has a declared grain,
 * and the composite spec SPLIT rather than being stretched, exactly as it asked.
 *
 * ── WHAT REGISTERING THEM HONESTLY COST (read this before editing a spec) ────────
 * Three of the four headlines turned out to be degradable, and NONE of them
 * degrades into an obvious error — each degrades into GOOD NEWS:
 *
 *   `gate.consecutiveReds`  → `0`, which reads as "the gate is passing"
 *   `deployedSha`           → `null`, which reads as "nothing is deployed"
 *   `mainFastForwarded`     → `null`, which reads as "no opinion"
 *   `judgingSha`            → `null`, which reads as "no run is in flight"
 *
 * The reds counter is the one worth dwelling on, because it is P-006's trap
 * reproduced exactly. `git-pipeline-stats.ts` had `num(gateHealth.consecutiveReds)
 * ?? 0`, so an ABSENT counter became a `0` indistinguishable from a measured green —
 * and the shipped type is `number`, so `nullable: false` was LITERALLY TRUE and would
 * have sailed through this gate with zero rejections. That is the incentive the
 * P-006 note above warns about, and the correct response was the same one: fix the
 * RESOLVER (capture the presence bit before the `?? 0` erases it, hoist it in
 * `verdictUnknown`), not the declaration.
 *
 * Two existing staleness models look like they already cover it and do not:
 * `fireStale` asks "is the routine FIRING?", and `verdictStale`'s own evaluator opens
 * with `if (consecutiveReds <= 0) return { stale: false }` — commented "a stale green
 * is inert". True of a stale green; FALSE of one that was never measured. The
 * short-circuit lands precisely on the case that needed naming.
 * ═══════════════════════════════════════════════════════════════════════════════ */

/** The result-level hoist all four share. Named once so a spec cannot drift from it. */
const VERDICT_HOIST = 'verdictUnknown';

/**
 * Cell 1 — what the gate's last verdict was.
 *
 * PAIRED WITH CELL 4 AS MUTUAL CHECKS, which is not a shortcut but the whole point: a
 * test-verdict TALLY and a git ANCESTRY check are two different apparatus answering
 * "is the pipeline healthy", so either can catch the other lying. The live exercise
 * caught exactly that (see `provenance.evidence`).
 */
export const GATE_VERDICT_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.verdict',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'gate.consecutiveReds',


  /**
   * D-009, first-match. THE ORDER IS THE CONTENT HERE: `inconclusive` and `red-stale`
   * both outrank the red counters they sit above, because in each of those states the
   * tally describes a run that is no longer the subject. An agent who branches on
   * `consecutiveReds` alone cannot see either, and both send them to fix failures that
   * belong to an abandoned candidate — the single most expensive misread on this fleet.
   *
   * Note `not-firing` carries a NONZERO safe action off a ZERO counter. That inversion
   * is the whole reason this cell needed an assessment: the healthy-looking number is
   * the one that needs an intervention.
   */
  assessment: {
    path: 'assessments.gateVerdict',
    codes: {
      inconclusive: {
        meaning:
          'The recorded tick ended with NO verdict (cancelled, timed out, or crashed before tests ran), so the red/green counters describe an OLDER run; the latched detail is not a live runner-status signal.',
        safeAction:
          'Read `gate.inconclusive.observedAtMs` and live `gate.checkpointRunInFlight` before acting. The detail describes that abort only; do NOT stop a currently active suite or treat its historical `no suite was run` text as current.',
      },
      // WI-10004092: a repair hold latches `gate.inconclusive` on every tick, so without this
      // code a verify that measured the repair head red read identically to a crash, and a
      // subscriber waiting for the verdict to CHANGE never woke.
      'repair-head-red': {
        meaning:
          'A frozen repair queue holds the gate, and a completed run measured its CURRENT repair head red. This is a code verdict on the lineage being repaired, not an abort; the red counters may still describe the run that froze the candidate.',
        safeAction:
          'Read `release:repair-queue { op: \'get\' }` for the failing legs and `gate.greenCheckpoint.ownership` for who holds the red. If a live owner holds it, do not duplicate the triage; otherwise fix the named legs on staging and land them with `release:repair-queue { op: \'admit\' }`, never `release:checkpoint-run`.',
      },
      'red-stale': {
        meaning:
          'Reds are on record, but the verdict is stale: it judged a candidate that has since been superseded.',
        safeAction:
          'Verify the CURRENT candidate before fixing anything — the named failures may belong to a run that has already been abandoned.',
      },
      'red-current': {
        meaning: 'The gate is red about the candidate it is judging now.',
        safeAction:
          'Fix the named failing tests, re-running each individually to confirm it is genuinely red at HEAD. A red gate freezes every agent\'s deploys, so this is yours to green regardless of lane.',
      },
      'not-firing': {
        meaning:
          'Zero reds — but the gate has not FIRED within its interval, so nothing is being judged at all.',
        safeAction:
          'Recover the green-checkpoint producer. A zero-red tally from a gate that never ran is not a pass, and waiting on it will never resolve.',
      },
      'passing-buffered': {
        meaning:
          'The gate is firing and green, and main sits behind staging — the ordinary steady state on this fleet.',
        safeAction:
          'Proceed. Do not read the buffer as a stall unless the separate buffer-stale evidence fires.',
      },
      'passing-current': {
        meaning: 'The gate is firing and green, and main is level with staging.',
        safeAction: 'Proceed; nothing is outstanding on the gate.',
      },
    },
    evidence: [
      'gate.inconclusive',
      'gate.repairQueue.verdictProvenance.repairHeadVerdict',
      'gate.verdictStale',
      'gate.fireStale',
      'verdictProvenance.mainBehindStaging',
    ],
    // P-012: the streak is a count; `verdictUnknown` names it when it was not measured.
    measuredBy: { 'gate.consecutiveReds': VERDICT_HOIST },
  },

  /**
   * TRUE, against the shipped type, and this is the honest answer rather than the
   * convenient one — see the block comment above on the `?? 0`.
   */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. GLOBAL, said out loud: the gate judges a candidate commit, not a caller's
   *  path. Every caller gets the same red streak — unlike `git.pipelinePosition`, whose
   *  whole subject is per-path. Two lenses on one resolver differing here is why axis 3
   *  is declared per-CELL and not per-resolver. */
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      'the green-checkpoint routine metadata (`gate_health`) via gitPipelineSnapshot, corrected by pinProvenGateCorrection',
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned gate.consecutiveReds=0 with fireStale=false — while verdictProvenance.mainFastForwarded=FALSE, deployedBehindGreenPin=19 and stages[main].health="stalled". THE INDEPENDENT CHECK FIRED IN THE REAL SYSTEM: the headline read as a passing gate while an independent git-ancestry measurement showed main 19 commits behind the pin and not fast-forwarded. The tool\'s own summary said "gate reports 0 reds, but main has NOT fast-forwarded — do not read this as fully healthy". RE-EXERCISED 09:2xZ with the P-007 hoist in place, against the real gate_health blob: countersUnknown=null and verdictUnknown=[] — i.e. the live counter IS measured and the hoist correctly stays SILENT. That negative result is the one worth recording: a hoist that fired on the healthy path would be one agents learn to ignore.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'gate.consecutiveReds' },
  doorProjections: [
    { tool: 'release:deploy', path: 'gate.consecutiveReds' },
    { tool: 'routines:list', path: 'health.gate_health.consecutiveReds' },
  ],

  /**
   * P-006 — THE DISCOVERY LEG, and this cell is the primary reason the field exists.
   *
   * A red gate is the single most-read state on this fleet, and `consecutiveReds` is
   * where an agent lands. The question that follows a nonzero read is always the same —
   * *is anyone already on this?* — and until now nothing in this answer said that
   * question had a home. Measured while writing P-006: `dev:pipeline_position` carries
   * the whole ownership block, but `state:read { cell: 'gate.greenCheckpoint.verdict' }`
   * carried no ownership and no route to it, so an agent following this repo's own
   * re-read-the-cell guidance was strictly WORSE informed than one who called the tool.
   *
   * ⚠ THE `shape` STRING ABOVE ALREADY MENTIONED `ownership`, AND THAT IS EXACTLY WHY
   * THIS IS NOT REDUNDANT. `shape` is prose describing the RESOLVER'S payload; it named
   * a block without naming the cell that owns it, and a reader who noticed it had no id
   * to read next. Naming a field is not naming a door.
   *
   * NOT a second independent check (D-014). The mutual pairing with cell 4 documented
   * above is untouched; this adds no measurement and makes no claim of its own.
   */
  pointers: [
    {
      cell: 'gate.greenCheckpoint.ownership',
      when: 'the streak is nonzero (or `stalled`) — i.e. any time you are about to act on a red gate',
      answers:
        'WHO owns this red and whether that ownership is REAL — the owning work-item, its claim state, and the holder\'s live session state, which is the independent check that separates "someone is on it" from a lease held by an agent that died. Read it before you claim the incident yourself or conclude nobody has it.',
    },
  ],

  shape:
    '{ gate: { consecutiveReds, stalled, lastGreenAtMs, fireStale, fireStaleReason, ' +
    'ownership: { eventKey, workItem, claimState, takenBy, takenAt, lastProgressAt, expiresAt, duplicates[] } }, verdictUnknown[] }',
};

/**
 * Cell 2 — WHICH commit the gate is judging. The question that comes before "is it
 * red": a red about a candidate that does not contain your change reads as *your fix
 * did not work* instead of *your fix was not present*.
 */
export const GATE_CANDIDATE_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.candidate',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'changeInCandidate.judgingSha',


  /**
   * D-009, first-match. `no-active-run` is the code worth reading twice: it is a
   * MEASURED absence, and its safe action is deliberately not "wait". A null headline
   * here reads as "no run in flight" to anyone who branches on the sha, which is the
   * same reassuring-degradation trap the block comment above catalogues for the other
   * three headlines.
   *
   * ⚠ `inferred-candidate` is decided by `changeInCandidate.judgingShaSource`, which
   * the door drops (file header), so this code is its only surviving carrier. It is
   * also the one code here that refuses an action rather than granting one — firing a
   * manual re-run off an inferred candidate discards a live auto-refire rescue and
   * costs a full suite.
   */
  assessment: {
    path: 'assessments.gateCandidate',
    codes: {
      'no-active-run': {
        meaning: 'No gate run is in flight and no candidate is frozen — a measured absence, not a failed read.',
        safeAction:
          'Nothing to wait on. If you need a verdict now, fire release:checkpoint-run — but read gate.greenCheckpoint.freezeDisposition first: while a candidate is frozen (converging/held) the lever is release:repair-queue converge, never a re-cut at tip, and the verb also refuses on an in-flight re-triage by itself.',
      },
      // main-green-status-visible-2026-09-03 P-011 follow-up: the between-runs life of a
      // frozen repair queue, which used to read `no-active-run` and steer at a re-cut. The
      // judged sha is the queue's candidate (`judgingShaSource: 'repair-queue'`), so the
      // per-path containment verdict — including a submodule path — is real here.
      'frozen-candidate-contains-path': {
        meaning:
          'No run is in flight, but a repair queue is frozen: its candidate — the sha the recorded verdict was computed on and the sha the next run resumes — CONTAINS the path you asked about.',
        safeAction:
          'Treat the frozen candidate\'s red as being about YOUR change and own it: fix on the shared tree so the fix lands on the queue (release:repair-queue { op:\'converge\', paths:[<path>] } dry-run, then confirm:true). Do NOT fire release:checkpoint-run — that cuts a fresh candidate at tip and restarts the treadmill.',
      },
      'frozen-candidate-without-path': {
        meaning:
          'No run is in flight, but a repair queue is frozen: its candidate does NOT contain your path, so the recorded red is not a verdict on your change.',
        safeAction:
          'Do not fix the queue\'s failures as though they were yours. To get your change judged, converge it onto the queue (release:repair-queue { op:\'converge\', paths:[<path>] } — the dry-run reports whether repairHead already carries it; confirm:true only if not). Never cut a fresh candidate at tip while a queue is frozen.',
      },
      'candidate-not-yet-published': {
        meaning:
          'A gate run is authoritatively active, but setup has not published the candidate sha yet. This is a live pre-candidate phase, not an idle gate.',
        safeAction:
          'WAIT for this run to publish its candidate or verdict. Do NOT fire release:checkpoint-run: that would collide with or replace the live singleton.',
      },
      'judging-current-path': {
        meaning: 'A run is in flight and its candidate CONTAINS the path you asked about.',
        safeAction: 'Treat a red from this run as being about YOUR change, and own it.',
      },
      'judging-without-current-path': {
        meaning: 'A run is in flight and its candidate does NOT contain your path.',
        safeAction:
          'Do not fix this run\'s failures as though they were yours, and do not read its verdict as a judgement on your change. Wait for a candidate that contains your path.',
      },
      'inferred-candidate': {
        meaning:
          "A candidate sha is present, but it came from a non-authoritative probe rather than the run's own published marker — on a CRON run that degrades to the checkpoint checkout's live HEAD, an inference that can change between two reads.",
        safeAction:
          'Treat the sha as a hint only and re-read once marker-backed provenance is available. Do NOT fire a manual re-run off it.',
      },
    },
    evidence: [
      'changeInCandidate.missingReason',
      'changeInCandidate.nextCandidateSha',
    ],
  },

  /**
   * TRUE. Note which hoist this uses and why it is NOT `changeInCandidate.missingReason`,
   * which is the field that looks built for the job: `missingReason` answers "a
   * containment verdict came back FALSE — which lever fixes it", and is null where the
   * headline is genuinely UNMEASURABLE (a sha-only probe). That arrives as
   * `not-applicable` in the shared hoist — a FINAL answer with no lever, which must not
   * read as "no run in flight" and send a caller off to wait for a verdict that will
   * never mention it.
   *
   * P-011 (main-green-status-visible-2026-09-03): a path inside a SUBMODULE used to be
   * the second `not-applicable` case ("the gate sees only a gitlink"). It is now MEASURED
   * — the resolver reads the gitlink each candidate pins and compares blobs inside the
   * submodule — and `changeInCandidate.submodule` carries the pins, so `as:'<a path
   * inside a submodule>'` answers containment directly instead of pointing at a hand
   * recipe. An unreadable gitlink hoists `resolver-failed` on the containment leg.
   */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. PER-PATH: the candidate sha is global, but "does the candidate contain
   *  YOUR path" — the thing this cell exists to answer — is not. */
  callerRelativity: { kind: 'parameter', param: 'path' },

  provenance: {
    obtainedBy:
      'resolveGateCandidates (the in-flight + next candidate shas) plus a per-path blob containment check against each',
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z for packages/operator-core/lib/agent-tools/state/state-tools.test.ts returned judgingSha=null with missingReason=null (no run in flight — a MEASURED absence, verified in source as legitimate and NOT hoisted) while nextCandidateSha=8e997f9a with nextContainsPath=true. The live read is what established that a null headline with a null missingReason is a real state, which is why the not-applicable cases had to be hoisted separately rather than inferred from that pair.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'changeInCandidate.judgingSha' },
  // release:trace returns the same exact candidate under target.sha; keep that
  // alternate door tied to this cell instead of making callers transcribe it.
  doorProjections: [{ tool: 'release:trace', path: 'target.sha' }],

  /**
   * WI-36259 — THE RUNTIME PROVENANCE, and this cell is why the field exists.
   *
   * The headline can be reached two ways with very different trust, and until now the cell
   * could not say which one answered. Worse, it did not merely omit the label: the headline
   * itself was resolved from the marker-BLIND probe while the run's own published marker sat
   * loaded one field away, so during a re-triage window this cell served the ABANDONED
   * candidate while `checkpointRunInFlight.candidate` served the live one. Same subject, two
   * shas, one resolver. `reconcileGateCandidates` fixes the value; this declares its source.
   *
   * The distinction is exactly the one a triager needs and cannot otherwise get: a
   * 'run-probe' reading on a CRON run is the checkpoint checkout's live HEAD — an inference
   * that changes between two reads — and acting on it is how agents re-fire a gate that
   * already carries their fix.
   */
  headlineSource: {
    path: 'changeInCandidate.judgingShaSource',
    // Derived from the resolver's own list (judging-sha-source.ts), never hand-maintained:
    // this entry once named only 'retriage-marker' while the resolver already trusted
    // 'in-flight-candidate', so the door called an observation non-authoritative.
    authoritative: [...AUTHORITATIVE_JUDGING_SHA_SOURCES],
    why: "'retriage-marker' and 'in-flight-candidate' are the run's OWN published markers — observations of what it is judging. 'repair-queue' is the sha the frozen repair queue's CURRENT PHASE puts under the gate: the immutable frozen candidate while 'ready-to-test'/'awaiting-fixer' (the recorded verdict was computed on it and no suite re-runs), but the MOVABLE repairHead once a fix is admitted ('ready-to-verify'/'ready-to-promote'), because that is the ref the gate then materializes (P-011 follow-up; WI-10002104 — answering the frozen candidate for EVERY phase told callers a verify run was not judging their change when it was, and mis-measured judgingContainsPath the same way so the two agreed). Anything else is a probe: on a MANUAL run its /tmp unit log, but on a CRON run it degrades to the checkpoint checkout's live HEAD, which is an INFERENCE that can change between two reads and is only right while that checkout stays pinned. Do not fire a manual re-run off a non-authoritative reading.",
  },

  /**
   * P-021 — THE MATERIALITY THRESHOLD, and this cell is why the field exists.
   *
   * `judgingSha` follows the gate's in-flight candidate, which is drawn from the
   * staging tip: MEASURED at 335 commits in 24h on this fleet (`git rev-list
   * --count --since=24h staging`, 2026-07-27). A fact resting on this cell
   * therefore re-renders a stale-verdict paragraph into the orient fold dozens of
   * times a day — for every agent the fold reaches.
   *
   * But re-read what the cell is FOR, three doc-blocks up: "WHICH commit the gate
   * is judging… a red about a candidate that does not contain your change reads
   * as *your fix did not work* instead of *your fix was not present*". The
   * question is not which sha. It is WHETHER THE GATE IS JUDGING YOUR CHANGE —
   * and that is `judgingContainsPath`, which moves only when YOUR file lands, not
   * when the other 334 commits do.
   *
   * So this is the item's rule exactly: push what changed the SENDER'S OWN MODEL.
   * The candidate advancing A→B with your change in both is news about someone
   * else's work; the flip to a candidate that does NOT contain your path is news
   * about yours.
   *
   * ⚠ NOT declared on the other four cells, and that restraint is the point. The
   * P-020 verdict rule applies to its own author: add a knob where churn is REAL
   * and MEASURED, never everywhere it would fit. `deploy.3070.sha` moves 13×/24h
   * (release reflog, same date) and every move is genuinely material — a new
   * deployed sha IS the news. `positions.deployed` and `mainFastForwarded` are
   * booleans, where a change already IS a verdict flip. And
   * `gate.greenCheckpoint.verdict` genuinely wants one — `consecutiveReds` 1→2 is
   * a bump, 0→1 is a flip — but its resolver exposes no coarse verdict field to
   * name, and computing `reds >= 1` HERE would be the registry re-deriving a
   * verdict, which axis 5 forbids. Per this file's own twice-stated precedent the
   * fix there belongs in the RESOLVER, not the declaration; until it exposes one,
   * that cell correctly stays un-gated rather than gaining a threshold DSL.
   */
  materiality: {
    path: 'changeInCandidate.judgingContainsPath',
    why:
      'judgingSha follows the staging tip — measured 335 commits/24h (git rev-list --since=24h staging, 2026-07-27) — but the question this cell exists to answer is "is the gate judging MY change", which is judgingContainsPath and moves only when the subject path itself lands. Suppressing a candidate step A→B that contains the path in both cases withholds news about OTHER agents\' commits; a containment flip is still reported loudly.',
  },

  /**
   * P-006 — the same discovery leg as cell 1, and the pairing is the point rather than
   * duplication: these two ARE the pair an agent reads when the gate is red. Cell 1
   * answers "is it red", cell 2 "is it red about MY change" — and both leave the reader
   * one question short of knowing whether to pick the incident up.
   *
   * `when` is narrower here than on cell 1, and deliberately so. A caller reading this
   * cell about their own path has a containment answer, not a redness answer: the
   * pointer earns its line only once containment says the red IS about them. Firing it
   * on every candidate read would spend the channel on the healthy path — the noise
   * failure `pointer-when-missing` rejects at registration.
   */
  pointers: [
    {
      cell: 'gate.greenCheckpoint.ownership',
      when: 'IF `judgingContainsPath` is true — the gate is judging YOUR change, so the red is yours to answer for',
      answers:
        'WHO already owns this red, so you join the existing incident instead of opening a duplicate — including whether the recorded holder is still alive, which a claim row alone cannot tell you.',
    },
  ],

  shape:
    '{ changeInCandidate: { judgingSha, judgingContainsPath, nextCandidateSha, nextContainsPath, missingReason, ' +
    'submodule: { path, relPath, judgingPin, nextPin } | null, detail }, ' +
    'gate: { ownership: { eventKey, workItem, claimState, takenBy, takenAt, lastProgressAt, expiresAt, duplicates[] } }, verdictUnknown[] }',
};

/** P-007 — the durable logical qualification, not the mortal agent currently repairing it. */
export const GATE_QUALIFICATION_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.qualification',
  registeredOn: '2026-08-26',
  owner: 'su-11131e17-b752-4e4d-a996-ca86edf2a708',
  headline: 'gate.qualification.attemptId',
  assessment: {
    path: 'gate.qualification.safeNextAction.code',
    codes: {
      'launch-physical-run': {
        meaning: 'The logical attempt is ready and no physical runner holds its lease.',
        safeAction: 'Let the qualification routine launch the next physical runner under current release-control authority.',
      },
      'launch-preflight-runner': {
        meaning: 'Request-time predicates are clear, but fail-closed candidate preflights remain before the suite.',
        safeAction: 'Let the qualification routine launch its preflight runner; do not treat the checkpoint suite as ready yet.',
      },
      'await-blocker-events': {
        meaning: 'A typed pre-suite infrastructure blocker paused this logical attempt.',
        safeAction: 'Await the listed blocker-clear events; the same attempt resumes when they clear.',
      },
      'await-current-run': {
        meaning: 'One physical runner owns a live lease for this logical attempt.',
        safeAction: 'Await that runner; do not start a competing checkpoint.',
      },
      'inspect-runner-liveness': {
        meaning: 'The physical runner lease expired, but its process liveness is not yet proven.',
        safeAction: 'Inspect the exact runner before reclaiming its lease; age alone does not prove the runner is dead.',
      },
      'recover-expired-runner': {
        meaning: 'The recorded physical-run lease expired without a terminal result.',
        safeAction: 'Reconcile the expired runner and let the routine reserve a replacement for the same logical attempt.',
      },
      'repair-code': {
        meaning: 'A real red verdict terminated this logical attempt.',
        safeAction: 'Repair the named code failures; never auto-retry this terminal attempt.',
      },
      'inspect-terminal-evidence': {
        meaning: 'A terminal code outcome was inconclusive rather than retryable infrastructure.',
        safeAction: 'Inspect the recorded evidence before authoring any successor attempt.',
      },
      'read-release-control': {
        meaning: 'No qualification is running, or it completed green, or its record is unreadable.',
        safeAction: 'Read current serializer/manual-run and promotion authority before starting or shipping anything.',
      },
    },
    evidence: ['gate.qualification.phase', 'gate.qualification.lease', 'gate.qualification.blockers'],
    // P-012: an empty blocker list is only "no blockers" when the qualification was read.
    measuredBy: { 'gate.qualification.blockers': 'gate.qualification.unknown' },
  },
  nullable: true,
  unknownHoist: 'gate.qualification.unknown',
  callerRelativity: { kind: 'global' },
  provenance: {
    obtainedBy: 'the green-checkpoint routine metadata (`qualificationTransaction`) via gitPipelineSnapshot',
    liveExercised: true,
    evidence:
      'The live routine row was read during P-007 implementation on 2026-08-26; absence produced the typed no-attempt/read-release-control state rather than an inferred agent owner.',
  },
  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',
  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: {
    kind: 'poll',
    tool: 'dev:pipeline_position',
    path: 'gate.qualification.attemptId',
  },
  shape:
    '{ gate: { qualification: { status, attemptId, candidate, phase, outcome, owner, lease, blockers, phaseDurationsMs, consumedPhysicalRuns, safeNextAction, unknown } } }',
};

/**
 * Cell 2c — WHAT IS FAILING on the frozen candidate, and whether each failure is already
 * repaired at `repairHead`. WI-1702869.
 *
 * ── THE MEASURED GAP THIS CLOSES ────────────────────────────────────────────────
 * 2026-08-31, owner-escalated. Asked "how many tests are failing on the thing we're
 * promoting", an agent found that NO cell, tool or field returned it — so it hand-wrote
 * SQL against `test_runs` and reported "45 → 29 failing files", then "no full suite has
 * run". The true answer was ONE failing file whose fix was ALREADY in `repairHead`:
 * freeze-and-converge had worked and the instrument to see it did not exist.
 *
 * ── WHY IT IS ITS OWN CELL AND NOT A FIELD ON `verdict` ─────────────────────────
 * `gate.greenCheckpoint.verdict` headlines `gate.consecutiveReds` — a STREAK COUNTER
 * under the name "verdict", whose own assessment says those counters can describe an
 * OLDER run. An agent asking "what's the verdict" gets a number that looks like a
 * failure count and is not (it read 77 the morning this was filed). Hanging the real
 * failure count off that cell would make the collision worse, and a CellSpec describes
 * exactly ONE subject (D-014). This is a different subject: not "how bad is the streak"
 * but "what is on the repair queue right now, and how much of it is already done".
 *
 * ── THE HEADLINE IS THE STILL-BROKEN COUNT, DELIBERATELY ────────────────────────
 * Not `failingFileCount`. The whole finding is that a failing row on a FROZEN sha does
 * not mean the file is still broken — fixes land ON TOP of the candidate, so the
 * population splits into "already fixed, awaiting re-verification" and "actually still
 * broken". Only the second is work. Headlining the raw count would reproduce the exact
 * over-read this cell exists to end.
 */
export const GATE_CANDIDATE_FAILURES_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.candidateFailures',
  registeredOn: '2026-08-31',
  owner: 'su-062dd71e-fd88-4a36-a90d-3ba5963c9bb4',
  headline: 'gate.candidateFailures.stillBrokenCount',
  assessment: {
    path: 'gate.candidateFailures.assessment',
    codes: {
      'no-frozen-candidate': {
        meaning:
          'There is no frozen repair queue, so there is no candidate to report failures ON. This is a MEASURED ABSENCE of a subject, not a count of zero failures.',
        safeAction:
          'Do not read this as "nothing is failing". Read gate.greenCheckpoint.verdict for the gate\'s own state; if you need the judged sha, that is gate.greenCheckpoint.candidate.',
      },
      unmeasured: {
        meaning:
          'The candidate is frozen but its failing-file set could not be read (test_runs unreachable, or the refs did not resolve) — OR a non-test leg was last measured red at an OLDER repairHead and the cycle never admitted it, so nothing is known about that leg at the current head (WI-10005727: before this, that shape read `none-failing`).',
        safeAction:
          'Read `unavailable` for the reason. Do NOT substitute a raw test_runs query — that population mixes the full suite (commit_sha=NULL) and dirty-tree runs, which is the original defect. Retry, or state the answer is unknown.',
      },
      'all-fixes-contained': {
        meaning:
          'Everything that was red on the frozen candidate — every failing file, and every non-test leg the cycle admitted — already has a fix at repairHead (a differing blob, or a leg whose own re-run passed at `fixedAtHead`), awaiting re-verification.',
        safeAction:
          'Do NOT go fix these files again; they are already repaired. Let the queue re-test repairHead. This is what a WORKING freeze-and-converge looks like from the inside.',
      },
      'repairs-outstanding': {
        meaning:
          'One or more files are byte-identical at repairHead. That is a fact about THOSE FILES\' bytes, not proof they are unfixed: a fix landing in a non-test file the test exercises (a script it invokes, a helper, a fixture, a whole-repo scanner) leaves the test blob untouched and is invisible here. `stillBrokenNeedsRunCount` says how many of these are only PRESUMED broken; when it equals `stillBrokenCount`, nothing here is confirmed work yet.',
        safeAction:
          'Read each row\'s `reading` before fixing anything. A row saying nothing else moved is real work — fix it so the fix lands ON TOP of the frozen candidate. A row that hedges needs `testing:run` on that ONE file at repairHead FIRST; measured 2026-09-02, all 3 such rows were already fixed and re-fixing them was wasted work. Never cut a fresh candidate to "try again".',
      },
      'non-test-leg-failing': {
        meaning:
          'No test file is still broken, but a NON-TEST leg (lint / perf / desktop / delta) is red on this candidate and its fix has not landed — `nonTestLegs.outstanding` names it. Before P-007 (main-green-status-visible-2026-09-03) this shape rendered as `none-failing`: the verdict counted only test files, so a gate wedged on a lint leg read "nothing failing" on the one cell whose job is to say what is failing.',
        safeAction:
          'Repair the NAMED leg — make THAT LEG pass on top of the frozen candidate (a path match is not evidence about a leg, D-005). Read `nonTestLegs.perLeg[].reading` for each outstanding id; `stillBrokenCount: 0` beside this code is a fact about test files only, never an all-clear. Never cut a fresh candidate to "try again".',
      },
      'none-failing': {
        meaning:
          'No file failed in the radius the gate judged for this candidate, AND no measured non-test leg is red. ⚠ THE RADIUS IS NOT THE SUITE — see `scope`. And `nonTestLegsMeasured: "not-recorded"` beside this code means the legs were never LOOKED AT, which is not the same as "no legs failing" (P-012).',
        safeAction:
          'Do NOT report "the gate is green". Check `nonTestLegsMeasured` (was any leg measured at all?), `nonTestLegs.perLeg` (WHICH leg, by name) and the main fast-forward; a passing affected-tests leg is not a green gate.',
      },
    },
    evidence: [
      // EI-22260078732220798: `repairs-outstanding` INSTRUCTS the reader to compare this
      // against the headline ("when it equals `stillBrokenCount`, nothing here is confirmed
      // work yet") — so it has to be reachable as evidence, not just named in prose. It was
      // omitted, and because this cell's payload comes back force-trimmed the qualifier was
      // unreachable without paging a scratch spill: the bare `stillBrokenCount` headline read
      // as a confirmed repair queue, which is the exact misread the prose exists to prevent.
      'gate.candidateFailures.stillBrokenNeedsRunCount',
      'gate.candidateFailures.distinctFailingFiles',
      'gate.candidateFailures.filesJudged',
      'gate.candidateFailures.scope',
      'gate.candidateFailures.nonTestLegsMeasured',
      'gate.candidateFailures.nonTestLegs.perLeg',
      'gate.candidateFailures.nonTestLegs.outstanding',
    ],
    // P-012: THE ORIGINAL INSTANCE. `0 / none-failing` having judged zero files is what
    // this plan was written against. The file counts are unmeasured exactly when
    // `unavailable` names why; the per-leg list is unmeasured when `nonTestLegsMeasured`
    // says `not-recorded` — two flags with their own semantics, both hoisted beside
    // the counts they vouch for.
    measuredBy: {
      'gate.candidateFailures.stillBrokenCount': 'gate.candidateFailures.unavailable',
      // EI-22260078732220798: the qualifier is a COUNT, so P-012 applies to it exactly as it
      // does to the headline it qualifies — a 0 here is otherwise indistinguishable from "the
      // hedge was never computed", which would reinstate the same false-confidence read one
      // level down. Same flag as the count it modifies: both are unmeasured precisely when
      // `unavailable` names why the failing-file set could not be read.
      'gate.candidateFailures.stillBrokenNeedsRunCount': 'gate.candidateFailures.unavailable',
      'gate.candidateFailures.distinctFailingFiles': 'gate.candidateFailures.unavailable',
      'gate.candidateFailures.filesJudged': 'gate.candidateFailures.unavailable',
      'gate.candidateFailures.nonTestLegs.perLeg': 'gate.candidateFailures.nonTestLegsMeasured',
      'gate.candidateFailures.nonTestLegs.outstanding': 'gate.candidateFailures.nonTestLegsMeasured',
    },
  },
  nullable: true,
  unknownHoist: 'gate.candidateFailures.unavailable',
  callerRelativity: { kind: 'global' },
  provenance: {
    obtainedBy:
      "harness_shared.test_runs scoped to source='ci' AND worktree_dirty=false AND commit_sha=<frozen candidate>, joined per-file to a git blob (or gitlink) comparison against repairHead",
    liveExercised: true,
    evidence:
      'The method was run by hand against candidate adbf2753 on 2026-08-31: 223 files judged, 1 distinct failing file (LearningTab.lens-guard.test.tsx), blob ab5e43a6 at the candidate vs 36734ba9 at repairHead — i.e. already fixed. Re-running that blob on a clean tree passed 28/28.',
  },
  resolver: 'readGateCandidateFailures() @ packages/operator-core/lib/gate-candidate-failures.ts',
  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: {
    kind: 'poll',
    tool: 'dev:pipeline_position',
    path: 'gate.candidateFailures.stillBrokenCount',
  },
  shape:
    '{ gate: { candidateFailures: { candidateSha, repairHeadSha, filesJudged, distinctFailingFiles: [{ path, attempts, status, fixInRepairHead, comparison, candidateBlob, repairHeadBlob, reading }], failingFileCount, alreadyFixedCount, stillBrokenCount, stillBrokenNeedsRunCount, changedBetweenRefs: { count, sample }, nonTestLegsMeasured, nonTestLegs: { current, head, atMs, all: [{ id, status, durationMs }], failing: [...], reading, perLeg: [{ id, measuredNow, lifecycle, fixedAtHead, admittedRound, reading }], outstanding: [id], shrink: { measured, admittedLegs, fixedLegs, failingLegs, failingLegIds, fixedLegIds, shrinkTotal, regressedLegs, lastMeasuredAtMs, scope } }, scope, unavailable, truncated } } }',
};

/**
 * Cell 2d — THE OWNER'S FOUR-PART QUESTION, composed: is main green — if not, why not —
 * who owns it — and is remediation actually alive? gate-audit-hardening-2026-08-31 P-001.
 *
 * ── THE MEASURED GAP THIS CLOSES ────────────────────────────────────────────────
 * Audited 2026-08-31 (WI-1820224 + its correction comment) over the 11-day red that
 * began 2026-08-20T20:57Z: the owner's recurring experience was agents telling him
 * CONFLICTING things, and none of the conflicts were factual disagreement — every one
 * was a vintage or denominator mismatch between separately-read surfaces (a streak
 * counter quoted as a failure count; a holder claim quoted as live remediation hours
 * after the dispatched fixer died). Each leg already existed on `dev:pipeline_position`;
 * the COMPOSITION did not, so every agent composed by hand and each composed differently.
 *
 * ── ONE DERIVATION, VINTAGE ON EVERY LEG ────────────────────────────────────────
 * `composeGateOwnerBrief()` is a PURE function over values `gitPipelinePosition()`
 * already resolved for its gate block — no second I/O path that can disagree with the
 * first (the axis-5 doctrine; contrast `candidateFailures`, which owns real I/O and so
 * names its own resolver). Every leg carries `{ observedAtMs, ageMs, source }`, and
 * `vintageSpreadMs` names the worst-case spread between legs, so an answer that mixes
 * observations minutes apart says so instead of reading as one instant.
 */
export const GATE_OWNER_BRIEF_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.ownerBrief',
  registeredOn: '2026-08-31',
  owner: 'su-bea36045-b4c2-4717-b267-0fb6757c2d96',
  headline: 'gate.ownerBrief.answer',
  assessment: {
    // The resolver emits `{ assessment: { code, meaning, safeAction } }`; the
    // registry path must select the branchable code leaf, not the whole object.
    path: 'gate.ownerBrief.assessment.code',
    // Mirrors the closed `GateOwnerBriefAnswer` union — the composer embeds the same
    // meaning/safeAction in the payload so a reader without registry access still gets
    // the branchable reading (see ASSESSMENTS in gate-owner-brief.ts).
    codes: {
      green: {
        meaning:
          'The gate is green about what it last judged. Exact judged-SHA promotion and the independent staging relation are carried in the same brief; an ordinary staging buffer does not make this not-promoted.',
        safeAction:
          'Proceed on the green verdict. If unknownLegs names promotion.mainContainsJudgedSha, do not claim the judged SHA reached main until that exact ancestry read succeeds.',
      },
      'green-not-promoted': {
        meaning:
          'The gate is green about its last judged SHA, but exact ancestry says that SHA did not reach the writer-owned main pin. This is independent of whether staging has an ordinary buffer.',
        safeAction:
          'Resume the frozen-lineage promotion/absorption transaction after checking gate.greenCheckpoint.retriage; do not substitute a fresh staging-tip verdict or fast-forward main by hand.',
      },
      'red-owned-remediating': {
        meaning: 'The gate is red, a LIVE session owns the incident, and remediation shows signs of life.',
        safeAction:
          'Do not open a second lane and do not re-derive status by hand — quote THIS read (it is vintage-stamped) and coordinate with the holder for anything that must move.',
      },
      'red-owned-stalled': {
        meaning:
          'The gate is red and owned by a POSITIVELY LIVE holder, but the dispatched fixer is dead or the queue shows zero-attempt stall — remediation is NOT visibly progressing. This is the shape that once idled ~5h before a human noticed.',
        safeAction:
          'Tell the holder their fixer is dead (coord:send with this read attached). If the holder does not respond, escalate — a dead fixer never resumes by itself.',
      },
      'red-owned-unconfirmed': {
        meaning:
          "The gate is red, a claim exists, and remediation is NOT visibly progressing — but the holder's liveness is AMBIGUOUS (draining/suspect/unread), so the claim is not evidence anyone is working it. The hold is stranded until proven otherwise.",
        safeAction:
          'Send ONE required wake to the holder, then STOP waiting on it: a missed wake is not proof of death, but it is also not a reason to keep the whole fleet blocked. If no turn follows and remediation.fixerSpawnId is still null (nobody was ever dispatched), treat the hold as stranded — reclaim the incident and work it. Waiting is not the safe action here; the coordination rail already fails open for this liveness verdict.',
      },
      'red-unowned': {
        meaning: 'The gate is red and NO live session owns the incident — the every-agent-waits / 37-agent-pileup shape.',
        safeAction:
          "Read gate.greenCheckpoint.ownership and claim the incident (or wake whoever should) — an unowned red is everyone's blocker and no one's work.",
      },
      'no-verdict': {
        meaning:
          'The latest gate attempt rendered no verdict: an inconclusive hold stopped judgment, so zero new reds is NOT evidence of green.',
        safeAction:
          'Clear the condition named by whyNot.inconclusiveStatus, then run the gate again; do not chase carried failingLegs as though this attempt measured them.',
      },
      'not-judging': {
        meaning:
          'The gate has not fired within its interval — nothing is being judged, so red/green counters describe the past.',
        safeAction: 'Recover the green-checkpoint producer first; do not act on the counters beside this answer.',
      },
      unknown: {
        meaning: 'The verdict counters were not measured on this read — this answer says NOTHING about gate health.',
        safeAction:
          'Treat gate state as unknown; read unknownLegs for what was missing and retry or escalate the instrument.',
      },
    },
    evidence: [
      'gate.ownerBrief.mainGreen.value',
      'gate.ownerBrief.whyNot.failingLegs',
      // WI-2143266: `failingLegs: []` alone is indistinguishable from "nothing is
      // failing" — hoist the adjacent `measured` flag so a reader can tell a
      // labelled-unmeasured/carried-empty list apart from a confident empty
      // measurement (the false-green class this cell exists to prevent).
      'gate.ownerBrief.whyNot.measured',
      // P-005: measured:null still covers two opposite states. The named provenance
      // separates a carried list from a wholly unknown one without inference from []/length.
      'gate.ownerBrief.whyNot.provenance',
      // main-green-status-visible-2026-09-03 P-007: the NON-TEST legs, named. `failingLegs`
      // is test files only, so a gate red on a lint leg alone hoisted `failingLegs: []`
      // beside a red answer — a red explained by nothing. Paired below with its own
      // measured-ness flag, so an empty list is never read as "no legs failing".
      'gate.ownerBrief.whyNot.failingNonTestLegs',
      'gate.ownerBrief.whyNot.nonTestLegsMeasured',
      // D-013/P-011: exact judged-SHA promotion and the ordinary staging buffer are
      // orthogonal, and both are independently checkable in this SAME cell read.
      'gate.ownerBrief.promotion.mainContainsJudgedSha',
      'gate.ownerBrief.promotion.staging.bufferPresent',
      'gate.ownerBrief.promotion.staging.relation',
      'gate.ownerBrief.ownership.assessmentCode',
      'gate.ownerBrief.remediation.fixerAlive',
      'gate.ownerBrief.remediation.frozenCandidate',
      'gate.ownerBrief.remediation.repairHead',
      'gate.ownerBrief.remediation.frozenSinceAtMs',
      'gate.ownerBrief.remediation.admissions',
      'gate.ownerBrief.remediation.admissionsMeasured',
      'gate.ownerBrief.remediation.signature',
      'gate.ownerBrief.remediation.signatureMeasured',
      'gate.ownerBrief.remediation.legs',
      'gate.ownerBrief.remediation.legsMeasured',
      'gate.ownerBrief.remediation.blockedReason',
      'gate.ownerBrief.remediation.blockedReasonMeasured',
      'gate.ownerBrief.remediation.verdictProvenance',
      'gate.ownerBrief.vintageSpreadMs',
      // main-green-status-visible-2026-09-03 P-010: the spread alone says the legs
      // disagree about WHEN but never WHICH ONE IS OLD, which is the question a reader
      // must answer before deciding which half of a mixed brief to believe. `verdict`
      // hoists the interpretation (coherent / mixed / incoherent / not-knowable) and
      // `staleLegs` names the offenders, so a ~2h spread stops being a raw number the
      // reader has to convert and judge for themselves.
      'gate.ownerBrief.attestations.verdict',
      'gate.ownerBrief.attestations.staleLegs',
      'gate.ownerBrief.unknownLegs',
    ],
    // P-012: `failingLegs: []` is vouched for by `whyNot.measured` (WI-2143266 / D-002);
    // `staleLegs: []` only means "nothing stale" when the attestation verdict is
    // knowable — `not-knowable` beside an empty list is the same false-clear.
    measuredBy: {
      'gate.ownerBrief.whyNot.failingLegs': 'gate.ownerBrief.whyNot.measured',
      'gate.ownerBrief.whyNot.failingNonTestLegs': 'gate.ownerBrief.whyNot.nonTestLegsMeasured',
      'gate.ownerBrief.remediation.admissions': 'gate.ownerBrief.remediation.admissionsMeasured',
      'gate.ownerBrief.remediation.signature': 'gate.ownerBrief.remediation.signatureMeasured',
      'gate.ownerBrief.remediation.legs': 'gate.ownerBrief.remediation.legsMeasured',
      'gate.ownerBrief.remediation.blockedReason': 'gate.ownerBrief.remediation.blockedReasonMeasured',
      'gate.ownerBrief.attestations.staleLegs': 'gate.ownerBrief.attestations.verdict',
    },
  },
  nullable: true,
  unknownHoist: 'gate.ownerBrief.unknownLegs',
  callerRelativity: { kind: 'global' },
  provenance: {
    obtainedBy:
      'pure composition (composeGateOwnerBrief) over the gate_health snapshot, readGateOwnership(), and the frozen-repair-queue diagnostic — values gitPipelinePosition() already resolved for its gate block; deliberately NO second derivation',
    liveExercised: true,
    evidence:
      "Exercised 2026-08-31 by running the dev:pipeline_position resolver (gitPipelinePosition()) from the working tree: composed answer='red-owned-stalled' — verdict red (gate_health observedAtMs 1788189928130), ownership held-live by su-40d60b0c (WI-212675, resolved live at the read), remediation phase=awaiting-fixer with fixerSpawnId s-1788193507693-cf3a11a3 measured fixerAlive=false, vintageSpreadMs=6005534 (legs ~100min apart, visibly stamped). The exact dead-fixer shape the cell exists to surface, caught on its first live read.",
  },
  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',
  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: {
    kind: 'poll',
    tool: 'dev:pipeline_position',
    path: 'gate.ownerBrief.answer',
  },
  shape:
    '{ gate: { ownerBrief: { answer, assessment: { code, meaning, safeAction }, mainGreen: { value, vintage }, promotion: { judgedSha, mainPin, mainContainsJudgedSha, vintage, staging: { headSha, bufferPresent, relation, vintage } }, whyNot: { failingLegs, measured, provenance, failingNonTestLegs, nonTestLegsMeasured, inconclusiveStatus, vintage } | null, ownership: { claimState, holder, workItem, assessmentCode, vintage }, remediation: { frozenCandidate, repairHead, phase, frozenSinceAtMs, admissions, admissionsMeasured, signature: [{ status }], signatureMeasured, legs: [{ status }], legsMeasured, blockedReason, blockedReasonMeasured, verdictProvenance, attempts, fixerSpawnId, fixerAlive, zeroAttemptStalled, queueAgeMs, vintage } | null, lastGreen: { atMs, ageMs }, vintageSpreadMs, attestations: { legs: [{ leg, observedAtMs, ageMs, source, stale }], spreadMs, verdict, staleLegs, oldestLeg, summary }, unknownLegs } } }',
};

/**
 * Cell 2b — WHO owns the gate incident, and whether that ownership is real.
 *
 * A SEPARATE cell rather than a second independent check bolted onto cells 1/2. A
 * `CellSpec` describes exactly ONE subject, and the validator rejects any field that is
 * the headline wearing a hat. The plan's P-005 assumed a cell could carry a per-BLOCK
 * side-claim; it cannot, and the honest expression of "this block has its own headline
 * and its own independent check" is its own cell (see D-014).
 */
export const GATE_OWNERSHIP_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.ownership',
  registeredOn: '2026-08-03',
  owner: 'gate-ownership-condition-singleton-2026-08-03',
  headline: 'gate.ownership.claimState',

  /**
   * D-009, first-match. This table is where the holder-liveness correction history
   * (D-018, EI-20209536730887204 — see `ownershipContradicted` in coord/gate-ownership.ts,
   * which carries it in full) finally becomes BRANCHABLE: `held-live`,
   * `held-needs-confirmation` and
   * `held-by-ended-session` are the three readings that the single word `held` on a
   * claim row collapses into one, and each carries a DIFFERENT action — coordinate,
   * confirm, reclaim. D-018's sign-flip (treating `recorded` as dead) and the
   * ambiguous case that silently lost its stand-down protection were both errors of
   * INTERPRETATION over a correct field; a closed code map with a safe action per
   * entry is what stops that class recurring, because there is no interpretation left
   * for a caller to get wrong.
   */
  assessment: {
    path: 'assessments.gateOwnership',
    codes: {
      'duplicate-owners': {
        meaning: 'More than one work-item claims this condition.',
        safeAction:
          'Reconcile the duplicates to a single owning item before working it — two owners is how two agents each conclude the other has it.',
      },
      unowned: {
        meaning: 'No work-item exists for this condition yet.',
        safeAction: 'File the owning work-item and claim it before starting, so a peer can see the incident is taken.',
      },
      claimable: {
        meaning: 'An owning work-item exists and nobody holds it.',
        safeAction: 'Claim it, then work it.',
      },
      'hold-blocked': {
        meaning:
          'The owning work-item carries attributed claim-hold provenance, so the claim path deliberately refuses it with claim_hold_blocked.',
        safeAction:
          'Do not claim it. Coordinate with the recorded holder, or clear/unpark the hold (`work_items:hold_open { clear:true }` or `work_items:release { claimHold:false }`) before claiming it.',
      },
      'lease-expired': {
        meaning: "The claim's lease has lapsed.",
        safeAction: "Re-claim it — the previous holder's lease no longer protects their work.",
      },
      'held-live': {
        meaning: "Held, and the presence oracle positively says the holder's session is alive.",
        safeAction:
          'Do not take over or duplicate `LIVE_GATE_OPS` — current-verdict reruns, deploy actions, current-red triage, repair-queue mutation, or monitoring. Coordinate with the holder (`coord:send`) if that live lane needs to move. This ownership does not reserve independently registered `GATE_SYSTEM_DEV`; continue cache, instrumentation, selection, retention, alerting, test, doc, or refactor work under its own work-item/plan lane and file locks.',
      },
      'held-stalled': {
        meaning:
          'Held by a positively-live session, but the shared critical-claim progress lease has expired; presence alone is not evidence that this item is moving.',
        safeAction:
          'Use the checked claim/recovery path to take over this existing item after re-reading it. Do not stand down, file a duplicate owner, or start a parallel `LIVE_GATE_OPS` lane; the expired progress lease is the explicit stale-claim recovery signal.',
      },
      'held-needs-confirmation': {
        meaning:
          "Held by a session whose liveness is AMBIGUOUS — draining, suspect, or unresolved. This is not a live holder and not a dead one.",
        safeAction:
          'Send ONE required wake, then read `gate.greenCheckpoint.ownerBrief` — do NOT sit on this code waiting for the wake to be answered. A delivered wake proves a coordination-live peer; a missed one proves nothing either way, which is exactly why this code alone cannot end the question. The brief fuses this verdict with repair-queue liveness and terminates: `red-owned-unconfirmed` (ambiguous holder + nobody ever dispatched) says reclaim, `red-owned-remediating` says a fixer is actually running. Note "fail open" here means PROCEED, not wait — `shouldStandDownForLivePeer` already returns false for draining/suspect, so this verdict never reserves the lane on its own.',
      },
      'held-by-ended-session': {
        meaning:
          'Held by a session the oracle confirms has ENDED — the lease outlived its holder.',
        safeAction:
          'Reclaim it. This is the exact case a claim row alone reports as "someone is on it" indefinitely, suppressing the next agent who could have picked it up.',
      },
    },
    evidence: [
      'gate.ownership.eventKey',
      'gate.ownership.workItem',
      'gate.ownership.holderSessionState',
      'gate.ownership.takenBy',
      'gate.ownership.takenAt',
      'gate.ownership.lastProgressAt',
      'gate.ownership.duplicates',
      'gate.ownership.expiresAt',
    ],
    // P-012: an empty duplicates list is "no competing claim" only on a measured read.
    measuredBy: { 'gate.ownership.duplicates': VERDICT_HOIST },
  },

  /**
   * TRUE, and this is the field the cell contract earned its keep on. The block
   * originally shipped (P-004) with a non-null enum that degraded to `'no-object'`
   * whenever the store was unreachable — so an unreadable store and a genuinely
   * un-owned condition produced the identical value, and the failure rendered as
   * the reassuring one ("nobody owns this red"). Registering the cell forced axis
   * 2 to be answered out loud, which is what surfaced it.
   */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. GLOBAL: the gate's incident is one condition for the whole workspace —
   *  every caller asking "who owns this red" gets the same answer, unlike cell 2's
   *  per-path containment question. */
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      "findConditionObjects() over the work-item↔condition link for `green-stall:<harness>`, with the holder's liveness resolved separately through the shared presence oracle",
    liveExercised: true,
    evidence:
      'P-006 (thread fold) re-exercised UNMOCKED 2026-08-03T02:55Z, and the run CAUGHT A REAL DEFECT that every unit test had passed over: the window reader was dispatching issue-family reads to work-items.ts\'s coord store, which is pinned to the `default` workspace while live issue threads sit in `papercusp-workspace`. It matched zero rows and returned a confident `total: 0` — WI-6857, which has TEN posts, read back as 0/0, indistinguishable from an item nobody had commented on. Fixed by dispatching issue-family to issues-engineer\'s dynamically-scoped store (guarded by work-items-thread-window-family-dispatch.test.ts). Post-fix live reads: WI-6857 -> shown 3 / total 10, oldest-first, bodies 3,933/4,928/2,317 chars all correctly flagged truncated at 400; EI-19379911903391487 -> topic pointer `topic:papercusp-improvement` with since=incident-start, proving the tags leg is scoped correctly too (its empty counterpart on WI-6857 is a genuine absence, verified by contrast); WI-7282 (bridge-minted) -> a MEASURED silence, shown 0 / total 0 / unknown null, which is the default state of a fresh incident since threads are created on first post; a nonexistent id -> `resolver-failed`, never silence. ALSO: readGateOwnership() run UNMOCKED against the live store 2026-08-03T02:22Z. (a) `green-stall:papercusp` resolved to a MEASURED `no-object` — the condition is genuinely resolved right now (alarm 2026-08-02T15:00:02Z, recovery 15:45:03Z), and the run confirms the empty is measured rather than a swallowed failure, since the same call path returned a real row for another key. (b) The shared condition query returned `single-primary:no-primary -> WI-7282, claimState claimable, duplicates []` — a live non-empty proving the join resolves real rows and the singleton holds. (c) THE FALSIFIER APPARATUS, exercised on real owners: resolveSessionStates returned `su-4a6e2255… -> live/heartbeatFresh:true` and a nonexistent owner -> `ended`/**heartbeatFresh:true**. That second pair IS the premise this independent check rests on, observed live: heartbeat freshness reads TRUE for an owner the oracle calls ended, so a reader substituting heartbeatFresh for sessionState would report a dead holder as live. NOT yet covered live: a genuinely HELD lease contradicted by a dead holder — no agent has claimed this condition yet, so the held+ended path remains unit-only. THE RUN ALSO CAUGHT A REAL ERROR: it falsified the author\'s own recorded belief that the bridge was not yet running (it was — bg-host executes tsx straight from the staging tree, so no deploy is involved), which is precisely the confidently-wrong-resolver class this axis exists to catch.',
  },

  resolver: 'readGateOwnership() @ packages/operator-core/lib/coord/gate-ownership.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:gate_ownership', path: 'gate.ownership.claimState' },
  shape:
    '{ gate: { ownership: { eventKey, workItem, claimState, unknown, takenBy, takenAt, lastProgressAt, expiresAt, holderSessionState, duplicates[], ' +
    'thread: { recent[{ at, author, text, chars, truncated }], shown, total, topics[{ slug, ref, since }], unknown } } }, verdictUnknown[] }',
};

/**
 * Cell 3 — the sha :3070 is running.
 *
 * ⚠ Cites `serving.startedSinceCodeChange` as evidence, exactly as `git.pipelinePosition`
 * does. That is legal and deliberate, not copy-paste: the two cells have DIFFERENT
 * headlines (a position boolean vs the deployed sha), and the probe is independent of both. It is
 * also the pairing CLAUDE.md already states as a rule after the confusion was filed
 * four separate times, so re-pairing it here is the point rather than an oversight.
 */
export const DEPLOYED_SHA_CELL: CellSpec = {
  cell: 'deploy.3070.sha',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'deployedSha',


  /**
   * D-009, first-match. Three codes, and the third is the one that did not exist as a
   * readable state before: `process-unverified` says the serving probe itself did not
   * answer, which is neither "running your sha" nor "running an old one". Collapsing
   * it into either — the natural move when all you have is a sha and a boolean — is
   * how a deploy gets reported live off a probe that never returned.
   *
   * ⚠ A null `deployedSha` is NEVER a code here. It is a FAILED READ of the release
   * checkout's HEAD, not "nothing is deployed"; that inference is the one the resolver
   * used to make and P-007 corrected. Absence stays `unavailable`.
   */
  assessment: {
    path: 'assessments.deployedSha',
    codes: {
      executing: {
        meaning:
          'A sha is deployed and the serving process started after the code changed — the process is running that sha.',
        safeAction: 'Exercise the deployed behaviour; nothing is outstanding.',
      },
      'restart-required': {
        meaning: 'A sha is deployed, but the process predates it and is executing older code.',
        safeAction: 'Restart the serving runtime. Another deploy will not change what is running.',
      },
      'process-unverified': {
        meaning:
          'A sha is deployed, and the serving probe was ATTEMPTED but did not answer — whether it is EXECUTING that sha is unestablished.',
        safeAction:
          'Do not conclude the deploy is live. Re-probe the serving runtime before relying on the deployed behaviour.',
      },
      /**
       * WI-2141716. Split out of `process-unverified`, because the two prescribe OPPOSITE
       * actions and only one of them can ever succeed. `process-unverified` says a probe ran
       * and failed, so retry is the lever. This code says NO probe was attempted and none can
       * be: a bare `state:read { cell:'deploy.3070.sha' }` names no path, so there is no
       * serving process to identify, and every re-read returns the same answer forever.
       * Emitting the retry-shaped code here is a documented infinite-loop generator — it cost
       * one agent session a full day and ~10 near-duplicate filings (see the work-item).
       */
      'serving-not-probeable': {
        meaning:
          'A sha is deployed, but this read identifies NO serving process to ask about — a sha-only read (no path) or a path compiled into the desktop binary. Nothing was probed, and re-reading cannot change that.',
        safeAction:
          'Do not re-probe — ask a different question. For a sha-only read, name a path (`as: "<repo-relative path>"`) so a serving process can be identified, or read the running process directly (`curl :3070/api/health` self-reports the sha it is executing). `serving.unknownReason` carries which case this is.',
      },
    },
    evidence: ['positions.deployed', 'verdictUnknown'],
  },

  /**
   * TRUE — and the reason is worth stating because the code used to assert otherwise.
   * `deployedSha` is `commitRef(releaseRoot, 'HEAD')`, and dev-deploy-state pushes
   * 'could not resolve HEAD of release checkout …' onto `errors[]` whenever that comes
   * back null. So a null here is a FAILED READ, never "nothing is deployed" — a comment
   * in the resolver claimed the latter and derived a confident `positions.deployed:
   * false` from it, which P-007 corrected.
   */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. GLOBAL: one release checkout per host — every caller reads the same sha. */
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      "devDeployState()'s release-checkout HEAD (a single `git log -1`), plus a live systemd probe for the independent start-time evidence",
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned deployedSha="dab4a3d8d7471313bd704f2aadbd0910025a470d" with serving.startedSinceCodeChange=true, pid=1607181, codeAsOfSource="deploy" — the independent start-time probe agreed on this read, and deployOrigin="stale-behind-gate" showed the deployed sha trailing the green pin by 19 commits, which is the state this cell exists to make legible.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'deployedSha' },
  doorProjections: [{ tool: 'release:deploy', path: 'deploy.deployedSha' }],
  shape: '{ deployedSha, serving: { startedSinceCodeChange, unknownReason, pid, codeAsOfSource }, verdictUnknown[] }',
};

/**
 * Cell 4 — is main fast-forwarded to the newest green pin.
 *
 * NAMING — AND THE POLARITY BUG IT USED TO CARRY (EI-20046248345042252). The cell is
 * `git.mainBehindStaging` because that is the question agents ask and hand-copy. It
 * used to headline `verdictProvenance.mainFastForwarded`, which is the SAME measurement
 * in the OPPOSITE polarity — so the cell answered its own name backwards: measured
 * 2026-08-10, `state:read { cell: 'git.mainBehindStaging' }` returned `false` while main
 * sat 22 commits behind staging. Because `greenPinAtStagingHead` is false in the normal
 * steady state (staging outruns the ~hourly gate), the wrong answer was the STANDING
 * one, not an edge case.
 *
 * The fix belongs in the RESOLVER, not here: `headline` is a field path and axis 5
 * forbids a surface from re-deriving (negating) what it projects, so
 * `verdictProvenance.mainBehindStaging` is published already-negated from the same
 * single read. Do not repoint this back at `mainFastForwarded`.
 *
 * There is still deliberately NO raw main-behind-staging COUNT — grepped
 * git-pipeline-stats, none exists — and inventing one would be a second derivation of a
 * question already answered (axis 5). The negated boolean is a projection, not a
 * derivation: same read, same `null`, one negation.
 */
export const MAIN_BEHIND_STAGING_CELL: CellSpec = {
  cell: 'git.mainBehindStaging',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'verdictProvenance.mainBehindStaging',


  /**
   * D-009, first-match — and this is the table where the assessment contract most
   * obviously beats the boolean it wraps. `mainBehindStaging: true` carries TWO
   * opposite meanings that no amount of reading the boolean can separate:
   * `normal-buffer` (proceed, this is the steady state) and `gate-stalled` (recover
   * the producer). Only `gate.fireStale` tells them apart, which is why that
   * SCHEDULER-LIVENESS measurement — the green-checkpoint routine's own last-fire
   * timestamp against its fire interval, sharing no input with any commit-graph read —
   * is carried as evidence below rather than discarded with the retired axis-1 field.
   *
   * The safe action on `normal-buffer` is deliberately a REFUSAL to escalate. This is
   * the reading that made the deploy stage report degraded essentially always and
   * shadowed every real downstream cause (EI-11012).
   */
  assessment: {
    path: 'assessments.mainBehindStaging',
    codes: {
      'caught-up': {
        meaning: 'main is level with staging — there is no un-promoted buffer.',
        safeAction: 'Nothing outstanding on the promotion leg.',
      },
      'normal-buffer': {
        meaning:
          'main is behind staging while the gate is still FIRING — the ordinary steady state here, since git-sync commits continuously and the gate promotes only hourly and only when green.',
        safeAction:
          'Proceed. Do NOT report this as a stalled pipeline or open an incident for it: the lag alone is not a fault.',
      },
      'gate-stalled': {
        meaning: 'main is behind staging AND the gate is not firing — the buffer is not draining.',
        safeAction:
          'Recover the green-checkpoint producer. This is the reading a lag figure alone can never distinguish from the normal buffer.',
      },
    },
    evidence: ['gate.fireStale', 'verdictUnknown'],
  },

  /** TRUE: `greenPinAtStagingHead` is null whenever the green pin or the staging head
   *  failed to resolve, and `commitRef` returns null for both "ref absent" and "git
   *  failed". The hoist names which operand was missing. */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. GLOBAL: a property of two branch tips, identical for every caller. */
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      'the greenPinAtStagingHead leg of devDeployState() — a `rev-list --count` between the green pin (main) and staging HEAD, measured in the integration tree',
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned mainFastForwarded=FALSE with lastGreenSha="7ad7d26cf991…", deployedBehindGreenPin=19 and stages[main].health="stalled" / detail "main is not fast-forwarded to the newest green pin", while the independent check gate.fireStale=false and lastGreenAtMs=1785142161612 showed the gate WAS still firing — i.e. the live system was in exactly the state this cell must not misreport as a stall.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'verdictProvenance.mainBehindStaging' },
  shape:
    '{ verdictProvenance: { mainBehindStaging, mainFastForwarded, lastGreenSha, lastGreenAgeMs, deployedBehindGreenPin, deployOrigin }, verdictUnknown[] }',
};

/*
 * EI-20449419111876508 — HOST MEMORY-PRESSURE CELL.
 *
 * The infra-liveness alarm already had the authoritative derivation:
 * `readLatestPerfSignals()` → `evaluatePerfSignals()`. What it lacked was a
 * re-readable cell, leaving agents to reconstruct CURRENT pressure from old
 * fired/cleared messages. The resolver lens exposes `evaluateMemoryPressure()`,
 * which the full evaluator itself now consumes, so the pull surface and alarm
 * cannot drift into separate threshold implementations.
 */
export const HOST_MEMORY_PRESSURE_CELL: CellSpec = {
  cell: 'host.memoryPressure',
  registeredOn: '2026-08-14',
  owner: 'su-30c473f3-c5b8-43d0-bba2-8d6b40e1aabd',
  headline: 'memory.pressure',


  /**
   * D-010. `stable-low-free` is the code this table exists for: PSI says reclaim is
   * fine while free capacity is under the warning threshold, and BOTH halves of that
   * are true at once. The old boolean pairing could only report one of them, so a
   * reader got either a false alarm or a false all-clear depending on which field they
   * happened to read. Its `meaning` names the distinction and its `safeAction` closes
   * it with an explicit prohibition — reclaim capacity, but do NOT call this PSI
   * pressure, because escalating it as pressure is what teaches a fleet to discount
   * the real `warning`.
   *
   * ⚠ Single-purpose resolver, so the producer path is the bare `assessment` (D-008).
   */
  assessment: {
    path: 'assessment',
    codes: {
      critical: {
        meaning: 'PSI reports tasks stalling on memory reclaim at the critical threshold.',
        safeAction:
          'Stop adding load. Treat `memory.cgroupAttribution` reclaim counters as cumulative historical leads only; verify a current-window event or working-set delta before terminating a process, and do not restart blindly.',
      },
      warning: {
        meaning: 'PSI reports reclaim stalling at the warning threshold.',
        safeAction: 'Reduce or inspect load before starting anything new.',
      },
      'stable-low-free': {
        meaning:
          'Reclaim is STABLE, but immediately-free memory is below the declared capacity warning threshold. Both halves are true; they are different claims.',
        safeAction:
          'Reclaim capacity if you are about to allocate heavily — but do NOT report this as PSI memory pressure.',
      },
      stable: {
        meaning: 'Reclaim is stable and free capacity is above the warning threshold.',
        safeAction: 'No pressure action; proceed.',
      },
    },
    evidence: ['host.memFreePct', 'memory.stale', 'memory.unknown'],
    // P-012: the free-memory percentage is a measurement; `memory.unknown` names it when
    // the host snapshot did not arrive.
    measuredBy: { 'host.memFreePct': 'memory.unknown' },
  },

  /** Missing/stale inputs that cannot establish a band yield `pressure:null`.
   *  A measured threshold crossing may still establish a lower-bound warn/crit
   *  while the other missing leg stays hoisted in `memory.unknown`; absence is
   *  never collapsed to a healthy zero. */
  nullable: true,
  unknownHoist: 'memory.unknown',
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      'the newest perf-signals-v1 capture via readLatestPerfSignals(), evaluated by the same evaluateMemoryPressure() branch consumed by the infra-liveness perf verdict; free-memory evidence via getHostSnapshot()',
    liveExercised: true,
    evidence:
      'host:memory_pressure run against the live 2026-08-14 perf capture returned a timestamped memory verdict with both PSI units, the exact PERF_BUDGETS thresholds, and an independently-sampled host.memFreePct; cell-assessment-reality exercises the real handler so shape drift cannot hide behind fixtures.',
  },

  resolver:
    'evaluateMemoryPressure(readLatestPerfSignals()) @ packages/operator-core/lib/system-health/perf-budgets.ts',
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'host:memory_pressure', path: 'memory.pressure' },
  shape:
    '{ memory: { pressure: "ok"|"warn"|"crit"|null, measuredAt, ageMs, stale, psiMemorySome60, psiMemoryFull60, cgroupAttribution: { accounting, partial, largestCapturedCgroup: { path, memoryBytes }|null, top[{ path, memoryBytes, swapBytes, anonBytes, fileBytes, slabBytes, directPids, memoryShareOfLargestCapturedCgroup }], throttled: [{ path, memoryBytes, memoryShareOfLargestCapturedCgroup, highEventsCumulative, maxEventsCumulative, oomKillEventsCumulative, subtreeMaxEventsCumulative, subtreeOomKillEventsCumulative, subtreeOnly: true|false|null }]|null }|null, thresholds: { source, psiMemorySomeWarn, psiMemoryFullCrit, staleMs, blindMs }, reasons[], unknown[] }, host: { measuredAt, memFreePct, memTotalGb, psiMemSome60 } }',
};

/**
 * EI-21572281184148497 — the bounded cgroup owner projection carried by the
 * canonical memory-pressure resolver. This is a separate cell so the critical
 * pressure action can point agents at a value they can actually re-read.
 *
 * The resolver remains the same as `host.memoryPressure`; this cell only projects
 * its `memory.cgroupAttribution` lens. `memory.pressure` is the resolver's existing
 * contextual code path, while `memory.unknown` carries the same capture-health
 * qualification for both lenses.
 */
export const MEMORY_CGROUP_ATTRIBUTION_CELL: CellSpec = {
  cell: 'memory.cgroupAttribution',
  registeredOn: '2026-08-27',
  owner: 'su-30c473f3-c5b8-43d0-bba2-8d6b40e1aabd',
  headline: 'memory.cgroupAttribution',

  assessment: {
    path: 'memory.pressure',
    codes: {
      crit: {
        meaning: 'The same perf capture reports critical memory pressure; attribution rows provide bounded historical owner context, not current-window causal proof.',
        safeAction: 'Inspect cumulative reclaim counters as leads, then verify a current-window event or working-set delta before removing a process; never treat the largest cgroup as confirmed cause.',
      },
      warn: {
        meaning: 'The same perf capture reports sustained memory reclaim pressure; attribution rows provide bounded historical owner context.',
        safeAction: 'Reduce or inspect load, then verify a contemporaneous delta before identifying a producer from cumulative attribution rows.',
      },
      ok: {
        meaning: 'The same perf capture reports no PSI memory-pressure threshold crossing.',
        safeAction: 'Do not attribute a memory stall to this capture; treat a null attribution as unmeasured owner context.',
      },
    },
    evidence: ['memory.unknown'],
  },

  nullable: true,
  unknownHoist: 'memory.unknown',
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      'the `memory.cgroupAttribution` lens of the same evaluateMemoryPressure(readLatestPerfSignals()) result used by host.memoryPressure',
    liveExercised: true,
    evidence:
      'Live host:memory_pressure exercise 2026-08-27 confirmed the payload contains memory.cgroupAttribution alongside memory.pressure and memory.unknown; the reality and read sweeps walk all three paths through the real resolver result.',
  },

  resolver:
    'evaluateMemoryPressure(readLatestPerfSignals()) @ packages/operator-core/lib/system-health/perf-budgets.ts',
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'host:memory_pressure', path: 'memory.cgroupAttribution' },
  shape:
    '{ memory: { cgroupAttribution: { accounting, partial, largestCapturedCgroup: { path, memoryBytes }|null, throttled: [{ path, memoryBytes, memoryShareOfLargestCapturedCgroup, highEventsCumulative, maxEventsCumulative, oomKillEventsCumulative, subtreeMaxEventsCumulative, subtreeOomKillEventsCumulative, subtreeOnly: true|false|null }]|null, top[{ path, memoryBytes, swapBytes, anonBytes, fileBytes, slabBytes, directPids, memoryShareOfLargestCapturedCgroup }] }|null, pressure: "ok"|"warn"|"crit"|null, unknown[] } }',
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * P-016 — THE AGENT GOAL CELL
 *
 * The first cell on this registry that is about an AGENT rather than about the
 * tree, and the substrate D-051 and P-030 both wait on: "anything that can read a
 * cell can read a holder's goal", so eight holder-bearing surfaces each add a
 * LENS instead of each re-deriving a goal from their own columns.
 *
 * ⚠ IT IS THE CURRENT-STATE SURFACE, AND ITS SIBLING IS NOT. D-051 draws the line
 * this cell sits on: the DECLARATION (this) answers "what is this agent doing
 * right now" and belongs to presence/holder surfaces; the P-009 tool-call STAMP
 * answers "what was true when this call was made" and belongs to postmortems.
 * Deriving current state from the newest row of a historical log is a
 * re-derivation and a lossy one — it goes stale between calls and is silent for
 * an agent that has declared but not yet acted. Nothing here reads the stamp.
 * ══════════════════════════════════════════════════════════════════════════════ */
export const AGENT_GOAL_CELL: CellSpec = {
  // ⚠ THE ID IS IMPORTED, NEVER RETYPED. Every holder surface gates its goal read
  // on `getCell(AGENT_GOAL_CELL_ID, reader)`; a literal here that drifts from the
  // gate's literal there fails SILENTLY (getCell returns undefined and the surface
  // discloses nothing, forever). See the constant's own note.
  cell: AGENT_GOAL_CELL_ID,
  registeredOn: '2026-07-27',
  owner: 'unified-agent-state-plane-2026-07-27',
  headline: 'goalRef',


  /**
   * D-010. The three ref-bearing codes differ ONLY in how well-supported the ref is —
   * `corroborated` (a link-graph edge agrees), `sole` (one source, nothing agrees),
   * `divergent` (sources disagree or competing claims exist) — and they all return the
   * SAME `goalRef`. That is the point: a caller reading the ref alone cannot tell a
   * coin-flip from a corroborated answer, which is exactly the measured case (3 of 19
   * holders held two work-items at once).
   *
   * ⚠ EVERY EVIDENCE PATH IS FLAT, and that is not a style choice. `goal` is `null` for
   * an agent holding nothing, and `pathExists` stops at a null segment — so nesting any
   * of these under `goal.` would make the evidence absent, downgrading the assessment to
   * `unavailable` in THE SINGLE MOST ORDINARY CASE THERE IS. That is P-011's bug
   * verbatim, one field over: the headline was hoisted flat to avoid it and the
   * independent leg beside it was not. `coord:goal` hoists all three flat precisely so
   * this works.
   */
  assessment: {
    path: 'assessment',
    codes: {
      'nothing-held': {
        meaning:
          "The agent holds no work-item, plan-item claim or fleet mission — an honest \"nothing declared\", not a failed read.",
        safeAction: 'Treat the agent as unassigned. Do not infer a goal from its history or its last message.',
      },
      corroborated: {
        meaning:
          'A goal ref is held, an independent link-graph edge agrees it serves the claimed lane, and nothing competes with it.',
        safeAction: 'Act on the linked ref.',
      },
      sole: {
        meaning: 'A goal ref is held, but only one source names it — nothing corroborates it.',
        safeAction: 'Use the ref, and disclose that it rests on a single source whenever you rely on it.',
      },
      divergent: {
        meaning:
          'The sources disagree, or the agent holds competing claims naming different work, and precedence picked one of them arbitrarily.',
        safeAction:
          'Inspect ALL the refs in `goalCompeting` before coordinating. The returned ref may not be what the agent is actually doing.',
      },
    },
    evidence: ['goalAgreement', 'goalCompeting', 'goalUnknown'],
    // P-012: an empty competing-claims list is only "nothing competes" when the claim
    // sources were read; `goalUnknown` carries why they were not.
    measuredBy: { goalCompeting: 'goalUnknown' },
  },

  /**
   * Axis 2. TRUE — an agent holding nothing has no goal, and that is an honest
   * unknown rather than an empty string. `competing` is the hoist: a caller who
   * never inspects `agreement` still cannot miss that other claims exist, because
   * they are enumerated at the result level (D-039).
   */
  nullable: true,
  unknownHoist: 'goalUnknown',

  /** Axis 3. Relative to WHICH AGENT you are asking about — the cell cell-read.ts
   *  names as the motivating example for the `subject` parameter. */
  callerRelativity: { kind: 'parameter', param: 'ownerId' },

  /* ⚠ WHY THE HEADLINE IS TOP-LEVEL `goalRef` AND NOT `goal.ref`. `valueAtPath`
   * returns `undefined` as soon as any path segment is null, so a nested path
   * against a goal-less agent (`goal: null`) makes `readCell` answer
   * `insufficient-data` — a code whose message says the resolver's shape has
   * "drifted apart" from the cell. That would be a confidently WRONG diagnosis of
   * the most ordinary case there is: an agent holding nothing. Flattened, the same
   * case reads `value: null`, and `goalUnknown` carries the reason. */

  /**
   * Axis 4. Live-exercised against the real fleet BEFORE the resolver was
   * written, which is what produced the corroboration rule: the item's literal
   * "claimed work-item > plan item" precedence was measured to be
   * under-determined, and the edge is what resolves it.
   */
  provenance: {
    obtainedBy:
      'work_items.taken_by + plan_item_claims (live claims) + fleet_membership_events + an agent_facts override key, joined by coord_links `implements` edges',
    liveExercised: true,
    evidence:
      'Measured live 2026-07-27 across the whole fleet: 19 holders of a work-item, 4 also holding a plan-item claim, 0 holding a plan-item claim alone, 3 holding two work-items; the corroborating edges WI-6407→unified-agent-state-plane-2026-07-27#P-016 and WI-6390→learning-tab-surface-public-release-2026-07-27#P-007 were both confirmed present with their holders claiming exactly those plan items.',
  },

  /** Axis 5. ONE resolver. Every holder surface (P-025, P-030, the lock-block
   *  message) PROJECTS it through `getCell(cell, reader)` and never re-derives. */
  resolver: 'resolveOwnerGoal() @ packages/operator-core/lib/agent-tools/coordination/agent-goal-sources.ts',

  /**
   * P-019 (a). WORKSPACE-visible, and that is a decision rather than a default.
   * A narrower audience would make the cell useless for the thing it exists to
   * do — D-051's whole point is that a BLOCKED PEER reads the holder's goal to
   * decide whether to wait — and it would be a false promise of secrecy anyway:
   * `claim-holder.ts` records that a claim's goal is already disclosed
   * unconditionally to anyone who collides with it. The audience boundary here is
   * the claim read itself.
   *
   * P-019 (b). `local`: owner ids, `WI-` refs and plan slugs do not resolve in a
   * foreign hive, so the value would not merely be uninteresting there — it would
   * be actively misread as a statement about their own agents.
   */
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },

  changeSignal: { kind: 'poll', tool: 'coord:goal', path: 'goalRef' },

  shape:
    '{ ownerId, goalRef: string|null, goalUnknown: "nothing-held"|null, goal: { ref, source, declaredAt, corroboratedBy, competing[], agreement } | null }',

  /**
   * Axis 6 is deliberately ABSENT. A goal has no stage order — the four SOURCES
   * are a precedence, not a sequence, and declaring them as stages would invite a
   * reader to treat `fleet-mission` as "further along" than `work-item`. Absence
   * means "this cell has no opinion", which is the honest answer.
   */
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * deterministic-coverage-census-2026-08-17 P-005 — THE TWO COVERAGE CELLS
 *
 * A coverage number is the most transcribable value in this system: it is small,
 * it sounds like a fact, and it is quoted into plans, completion evidence and
 * status reports where nobody re-reads it. It is also one of the least stable —
 * it moves every time the census runs or a test is deleted.
 *
 * They are a PAIR, split along the line between a RATIO and a COUNT, because the
 * two have different honesty problems. The ratio has no answer over an empty
 * population (nullable). The population is a row count and always has one
 * (not nullable). Collapsing them into a single cell would force one of those
 * two truths to be stated wrongly.
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * WHY THE POPULATION IS A CELL AT ALL, and not just a field of the one below: it is
 * the independent check on the ratio, and a check a reader cannot independently
 * re-read is a promise rather than a check.
 */
export const TESTING_CENSUS_POPULATION_CELL: CellSpec = {
  cell: 'testing.census.population',
  registeredOn: '2026-08-18',
  owner: 'deterministic-coverage-census-2026-08-17',
  headline: 'census.surfaces',

  /**
   * D-010. Three of these four codes are reached with `surfaces === 0`, and they are
   * the reason this cell has an assessment at all: the number is identical in every
   * one, while the actions are register-a-provider, run-the-census, and trust-the-zero.
   * A count cannot carry that, and the day the whole feature sat inert (all four census
   * tables at 0 rows, cadence reporting healthy fires) is what a reader branching on
   * the count alone could not see.
   *
   * `empty-measured` is the code that had no name before: a census that RAN and honestly
   * found nothing. Without it, an accurate zero is indistinguishable from an unasked
   * question, and readers learn to discount both.
   */
  assessment: {
    path: 'assessments.censusPopulation',
    codes: {
      'no-providers': {
        meaning:
          'Zero surfaces AND zero registered providers — the census loop had nothing to iterate, so it could not have written a surface however healthy its fires look.',
        safeAction:
          "Register or enable a provider. Do NOT read the zero as \"this project has nothing to test\".",
      },
      'census-not-run': {
        meaning: 'Providers are registered, but no census run has ever written a surface row for this scope.',
        safeAction: 'Run or repair the census before quoting any population figure.',
      },
      'empty-measured': {
        meaning:
          'Providers are registered and a census HAS run — it enumerated zero matching surfaces. The zero is a measurement.',
        safeAction: 'Trust the zero. Widen the scope or filters if you expected rows.',
      },
      populated: {
        meaning: 'The census enumerated a non-empty surface population.',
        safeAction: 'Use the count together with its fidelity and basis, which qualify what it counted.',
      },
    },
    evidence: ['census.providersRegistered', 'census.lastCensusAt'],
  },

  /**
   * Axis 2. FALSE, deliberately, and the asymmetry with its sibling is the point:
   * this is a COUNT of rows, so 0 is a real measurement rather than an absent one.
   * Declaring it nullable would invent an unknown that cannot occur and teach
   * readers to discount an honest zero.
   */
  nullable: false,
  whyTotal:
    'the resolver runs two count(*) queries and returns their result or throws — there is no read that can fail into a default, so there is no path on which the headline is an unmeasured 0. A count is total by construction: 0 rows is a real measurement, not an absent one, and declaring it nullable would invent an unknown that cannot occur and teach readers to discount an honest zero.',
  callerRelativity: {
    kind: 'ambient',
    source:
      'the census scope — the operator home harness + active workspace, resolved by resolveCensusScope(); a cell reader cannot pass it',
  },

  provenance: {
    obtainedBy:
      'count(*) over harness_shared.testing_surface_depth for the scope, alongside a count over census_provider_registrations, via the testing:coverage handler',
    liveExercised: true,
    evidence:
      'Run live against the operator DB 2026-08-18T14:1xZ: 1105 surfaces (http-route 832, mcp-tool 49, sync-query 224), all fidelity=declared, providersRegistered=3, lastCensusAt=2026-08-18T13:57:07.645Z. Exercised in its ZERO state first — before the registrations were seeded the same handler returned surfaces=0 with the no-providers-registered hoist, which is the branch this falsifier exists for.',
  },

  resolver:
    'the testing:coverage handler (assembleCoverage over harness_shared.testing_surface_depth) @ packages/operator-core/lib/agent-tools/testing/coverage.ts',

  visibility: { kind: 'workspace' },
  /** `local`: a surface population is a statement about THIS pot's own code. In a
   *  foreign hive it would not merely be uninteresting, it would be read as a
   *  claim about their surfaces. */
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'testing:coverage', path: 'census.surfaces' },
  shape:
    '{ census: { surfaces, retired, lastCensusAt, ageMs, providersRegistered, providersEnabled, fidelity: { counts, weakest, declaredPct }, basis }, verdict, censusUnknown[]|null }',
};

/**
 * The ratio. Registered SECOND so its pointer target already exists in the file's
 * reading order (registration order does not matter to the validator — pointer
 * targets are resolved at read time — but the reader's order does).
 */
export const TESTING_COVERAGE_FLOOR_CELL: CellSpec = {
  cell: 'testing.coverage.floor',
  registeredOn: '2026-08-18',
  owner: 'deterministic-coverage-census-2026-08-17',
  headline: 'coverage.pct',

  /**
   * ⚠ `census.surfaces` IS THE DENOMINATOR, AND IT IS CARRIED AS EVIDENCE BELOW FOR A
   * MEASURED REASON. The headline ratio JOINS surfaces against coverage_evidence; the
   * surface table ALONE, with no join, can disagree with it in both directions (a
   * population with no evidence, evidence for retired surfaces). Two readings depend on
   * seeing it, and the second is the subtle one:
   *   - the vacuous ratio: 0 of 0 rendered as 0% or 100%.
   *   - the TRUNCATED population: a ratio computed over a world smaller than the real
   *     one, which always flatters, because a surface the census never enumerated
   *     cannot appear as a gap.
   *
   * ⚠ THE WORKED EXAMPLE THAT USED TO SIT HERE HAS BEEN DELETED RATHER THAN UPDATED, and
   * that is the durable lesson (P-008). It read that the mcp-tool population "censused as
   * 49 against 675 tool files on disk (WI-39812), so that kind's ratio was computed over
   * 7% of its world" — a hand-maintained measurement, unpinned by any check, load-bearing
   * enough that P-008 was written to re-verify it. By 2026-09-02 the census held 884 live
   * mcp-tool surfaces and no such truncation survived, but the prose still asserted it
   * with a date and a work-item id, which reads as corroboration. Replacing it with
   * today's number would only re-arm the same trap in fresher paint, so the STRUCTURAL
   * risk is what stays here and the number lives where it can be re-read:
   * `state:read { cell: 'testing.census.population' }`, whose own codes separate an empty
   * census from an unregistered provider.
   */
  /**
   * D-010, with the code RENAMED to `no-population` per D-012 — the truth table called
   * it `not-measured`, which is also a `CellUnknownCode`, and D-008 forbids a domain
   * code that collides with the read-health vocabulary. That collision was undetectable
   * until a cell actually declared an assessment; see the producer's own note in
   * coverage.ts for why the fix landed there rather than here.
   *
   * The rule is right, and this cell is its sharpest case. An empty census is a MEASURED
   * FINDING — the census ran and found no denominator — while read-health `not-measured`
   * means the apparatus produced nothing. One token for both is precisely the confusion
   * that lets "we never looked" be reported as "there is nothing there".
   *
   * ⚠ `coverage.pct` is the HEADLINE and appears nowhere below. D-010 is explicit that
   * pct is evidence only and never the branch condition: the aggregate decides the code,
   * so a limit-capped row list cannot move it.
   */
  assessment: {
    path: 'assessments.coverageFloor',
    codes: {
      'no-population': {
        meaning:
          'There is no denominator — the census enumerated zero surfaces, so a ratio would be vacuous. This is a measured state of the census, NOT a failed read.',
        safeAction:
          'Follow `censusUnknown` to repair the census. Do NOT report 0% or 100%; neither is a measurement anyone made.',
      },
      'meets-floor': {
        meaning: 'Every censused surface meets the floor, with no unwaived gaps.',
        safeAction: 'No gap action outstanding.',
      },
      'below-floor': {
        meaning: 'Surfaces sit below the floor without a waiver.',
        safeAction: 'Work the returned unwaived gap queue.',
      },
      'no-evidence': {
        meaning:
          'Surfaces sit below the floor, but NOTHING has ever been measured about them — `coverage.evidenced` is 0, so no observed traffic and no authored evidence has reached this scope. The shortfall is a fact about the apparatus, not about the tests.',
        safeAction:
          'Do NOT work the gap queue — every row in it is unactionable, and writing tests will not move this number. Repair the evidence path first: check that an observer is armed somewhere that can PERSIST into this scope, then re-read. `coverage.unobservable` says how much of the population no observer emits at all, which no arming can fix.',
      },
      'measured-with-waivers': {
        meaning:
          'Nothing is below the floor UNWAIVED, but surfaces ARE below it under live waivers — the apparent pass rests on accepted exceptions.',
        safeAction:
          'Record that the gaps are waived rather than covered, and re-check the waivers before relying on the floor as evidence.',
      },
    },
    evidence: [
      'census.surfaces',
      'coverage.below',
      'coverage.belowUnwaived',
      'verdict',
      /**
       * P-008. Carried so a reader can tell an ACTIONABLE shortfall from an unactionable
       * one without a second call: `evidenced` 0 means nothing ever measured this scope,
       * and `unobservable` is the slice no observer emits, which arming cannot fix.
       */
      'coverage.evidenced',
      'coverage.unobservable',
    ],
    // P-012: every count here is a ratio over the census; `censusUnknown` names the
    // reason when the census itself did not arrive, and a 0% or an empty gap queue
    // beside a non-null censusUnknown is not a measurement anyone made.
    measuredBy: {
      'coverage.pct': 'censusUnknown',
      'census.surfaces': 'censusUnknown',
      'coverage.below': 'censusUnknown',
      'coverage.belowUnwaived': 'censusUnknown',
      'coverage.evidenced': 'censusUnknown',
      'coverage.unobservable': 'censusUnknown',
    },
  },

  /**
   * Axis 2. TRUE — and this is the whole reason the cell exists. `pct` is `null`
   * whenever its denominator is 0, never 0 and never 100. `censusUnknown` is the
   * result-level hoist enumerating WHY (no-providers-registered |
   * census-has-not-run | no-surfaces-match-filters), so a caller who reads only
   * the headline gets a null and a caller who reads only the hoist gets prose.
   */
  nullable: true,
  unknownHoist: 'censusUnknown',
  callerRelativity: {
    kind: 'ambient',
    source:
      'the census scope — the operator home harness + active workspace, resolved by resolveCensusScope(); a cell reader cannot pass it',
  },

  provenance: {
    obtainedBy:
      "count(*) FILTER (WHERE meets_lN) over harness_shared.testing_surface_depth, divided by the matching population — the view's own rung FLAG, never depth >= N, because the rungs are not nested",
    liveExercised: true,
    evidence:
      'Run live against the operator DB 2026-08-18T14:1xZ at floor l1: meets=0, below=1105, pct=0 with verdict "measured" and censusUnknown null — a GENUINE zero (the census enumerated 1105 surfaces and no attribution evidence exists yet), which is the reading that must not be confused with the vacuous one. The same handler over the pre-seed empty census returned pct=null + verdict "not-measured".',
  },

  resolver:
    'the testing:coverage handler (assembleCoverage over harness_shared.testing_surface_depth) @ packages/operator-core/lib/agent-tools/testing/coverage.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'testing:coverage', path: 'coverage.pct' },

  /**
   * A coverage ratio moves on every census run as surfaces churn. The MATERIAL
   * change is whether the gap count moved — a percentage drifting because the
   * denominator grew by one route is not news, and a cell that woke a subscriber
   * for it would be unsubscribed within a day.
   */
  materiality: {
    path: 'coverage.below',
    why: 'the number of surfaces BELOW the floor is the actionable quantity — it is the gap queue\'s length. The ratio moves whenever the census adds or retires a surface, including when nothing about the testing changed; the gap count moves only when the set of unproven surfaces does.',
  },

  pointers: [
    {
      cell: 'testing.census.population',
      when: 'pct is null, or verdict reads "not-measured"',
      answers:
        'whether a census exists at all for this scope, and whether any provider was ever registered to produce one — the difference between "nothing is covered" and "nobody looked".',
    },
  ],

  shape:
    '{ verdict: "measured"|"not-measured", censusUnknown: string[]|null, coverage: { floor, floorMeans, surfaces, meets, below, waived, pct: number|null, fidelity, basis, byRung }, byKind[], census }',
};

const GOVERNOR_CELL_BASE = {
  registeredOn: '2026-08-27',
  owner: 'capless-adaptive-resource-governor-2026-08-26',
  nullable: true,
  unknownHoist: 'unknown',
  callerRelativity: { kind: 'global' } as const,
  provenance: {
    obtainedBy: 'one atomic GovernorStateSnapshotWriter publish into harness_shared.derived_read_snapshots',
    liveExercised: true,
    evidence:
      'P-010 real snapshot/tool tests publish the complete queue population, read it back through governor:state_snapshot, and verify bounded projections plus explicit unknowns.',
  },
  resolver: 'governor:state_snapshot → readGovernorStateSnapshot()',
  visibility: { kind: 'workspace' } as const,
  federation: { kind: 'local' } as const,
} as const;

function governorAssessment(path: string, codes: readonly string[]): NonNullable<CellSpec['assessment']> {
  return {
    path,
    codes: Object.fromEntries(codes.map((code) => [code, {
      meaning: `The canonical governor snapshot assessed this lens as ${code}.`,
      safeAction: code === 'unknown'
        ? 'Treat the value as unmeasured; inspect the snapshot freshness/writer before acting.'
        : 'Act on the bounded lens and follow its evidenceRef when detail is required.',
    }])),
    evidence: ['freshness', 'unknown'],
  };
}

export const GOVERNOR_HEALTH_CELL: CellSpec = {
  ...GOVERNOR_CELL_BASE,
  cell: 'governor.health',
  headline: 'health',
  assessment: governorAssessment('assessments.health', ['healthy', 'degraded', 'unknown']),
  changeSignal: { kind: 'poll', tool: 'governor:state_snapshot', path: 'health' },
  shape: '{ state, severity, actionable, confidence, evidenceRef }',
};

export const GOVERNOR_ADMISSION_CELL: CellSpec = {
  ...GOVERNOR_CELL_BASE,
  cell: 'governor.admission',
  headline: 'admission',
  assessment: governorAssessment('assessments.admission', ['open', 'constrained', 'paused', 'unknown']),
  changeSignal: { kind: 'poll', tool: 'governor:state_snapshot', path: 'admission' },
  shape: '{ state, reason, generation, constrainedClasses[], nextProbeAtMs, confidence }',
};

export const GOVERNOR_QUEUE_CELL: CellSpec = {
  ...GOVERNOR_CELL_BASE,
  cell: 'governor.queue',
  headline: 'queue',
  assessment: governorAssessment('assessments.queue', ['empty', 'draining', 'growing', 'unknown']),
  changeSignal: { kind: 'poll', tool: 'governor:state_snapshot', path: 'queue' },
  shape: '{ depth, oldestAgeMs, arrivalRatePerSec, drainRatePerSec, trend, byClass[], populationClasses, truncated }',
};

export const GOVERNOR_RESOURCES_CELL: CellSpec = {
  ...GOVERNOR_CELL_BASE,
  cell: 'governor.resources',
  headline: 'resources',
  assessment: governorAssessment('assessments.resources', ['unconstrained', 'constrained', 'unknown']),
  changeSignal: { kind: 'poll', tool: 'governor:state_snapshot', path: 'resources' },
  shape: '{ constrained[], byResource[], truncated }',
};

export const GOVERNOR_RECOVERY_CELL: CellSpec = {
  ...GOVERNOR_CELL_BASE,
  cell: 'governor.recovery',
  headline: 'recovery',
  assessment: governorAssessment('assessments.recovery', ['stable', 'recovering', 'stalled', 'unknown']),
  changeSignal: { kind: 'poll', tool: 'governor:state_snapshot', path: 'recovery' },
  shape: '{ state, completed, total, progress, nextProbeAtMs, evidenceRef, confidence }',
};

export const LSP_ADMISSION_CELL: CellSpec = {
  cell: 'lsp.admission',
  registeredOn: '2026-10-03',
  owner: 'lsp-fleet-scale-all-languages-2026-08-21',
  headline: 'admission',
  nullable: true,
  unknownHoist: 'unknown',
  callerRelativity: { kind: 'global' },
  provenance: {
    obtainedBy: 'daemon-owned LspAdmissionController.snapshot() over the existing Unix-socket RPC transport',
    liveExercised: true,
    evidence: 'code-intelligence/lsp-admission.test.ts exercises the real controller under pressure; state/lsp-admission.test.ts reads its actual snapshot and rejects unavailable/stale readback.',
  },
  resolver: 'lsp:admission_snapshot → readLspDaemonAdmission → LspAdmissionController.snapshot()',
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  assessment: {
    path: 'assessment',
    codes: {
      idle: { meaning: 'The daemon measured no active or waiting queries.', safeAction: 'Submit work through the daemon; the next request measures its own lane.' },
      active: { meaning: 'Queries are running with no observed pressure waiters.', safeAction: 'Use the class windows and actual in-flight counts when assessing execution.' },
      pressure: { meaning: 'Queries wait for class-specific service capacity.', safeAction: 'Inspect class queue age, caller deadlines and feedback; allow unrelated classes to proceed.' },
      'settlement-failed': { meaning: 'At least one durable receipt failed to settle.', safeAction: 'Inspect the named failed receipts and restore durable settlement before asserting the queue drained.' },
      unknown: { meaning: 'Daemon queue state could not be measured.', safeAction: 'Inspect the explicit daemon read failure; do not treat it as an empty queue.' },
    },
    evidence: ['measurement'],
  },
  changeSignal: { kind: 'poll', tool: 'lsp:admission_snapshot', path: 'admission' },
  shape: '{ queued, inFlight, classes[{ classKey, queued, pendingPersistence, oldestWaitMs, desiredWindow, effectiveWindow, health, feedback }], settlementFailures, measured, sampledAtMs, generation }',
};

/** Reuse the daemon lens; readiness is not inferred from an empty queue or process health. */
export const LSP_WARM_SERVERS_CELL: CellSpec = {
  ...LSP_ADMISSION_CELL,
  cell: 'lsp.warmServers',
  registeredOn: '2026-10-05',
  headline: 'runtime',
  unknownHoist: 'runtimeUnknown',
  provenance: {
    obtainedBy: 'daemon health RPC → lspHealth() → lspClientInventory(), including the owning PID and measurement timestamp',
    liveExercised: true,
    evidence: 'lsp-admission.pinned.integration.test.ts measures the real daemon health inventory at nine replay boundaries with migrated PG; state/lsp-admission.test.ts rejects stale/failed readback independently of the queue.',
  },
  resolver: 'lsp:admission_snapshot → readLspDaemonHealth → lspClientInventory()',
  assessment: {
    path: 'runtimeAssessment',
    codes: {
      healthy: { meaning: 'The measured server processes are healthy; this does not certify any query intent.', safeAction: 'Read lsp.readiness before interpreting absence or completeness.' },
      degraded: { meaning: 'At least one server process is degraded.', safeAction: 'Inspect its task identity and proof ledger.' },
      unhealthy: { meaning: 'At least one server process is unhealthy.', safeAction: 'Inspect its actual failure before relying on answers.' },
      unknown: { meaning: 'No enabled warm population could be established.', safeAction: 'Inspect runtimeUnknown and the enabled flag; do not infer zero servers.' },
    },
    evidence: ['runtimeMeasurement'],
  },
  changeSignal: { kind: 'poll', tool: 'lsp:admission_snapshot', path: 'runtime' },
  shape: '{ enabled, overall, pid, node, entry, sampledAtMs, servers[{ language, rootPath, taskId, pid, health, certifiedReadiness, unprovenReadiness, pendingProgress, progressGeneration }] }',
};

export const LSP_READINESS_CELL: CellSpec = {
  ...LSP_WARM_SERVERS_CELL,
  cell: 'lsp.readiness',
  headline: 'readiness',
  assessment: {
    path: 'readinessAssessment',
    codes: {
      reported: { meaning: 'The daemon reported its exact per-intent proof sets; missing intents are not certified.', safeAction: 'Use only the listed certified intents when interpreting absence.' },
      unproven: { meaning: 'At least one measured intent is unproven or its server is still indexing.', safeAction: 'Retain honest degraded answers and inspect the per-intent evidence.' },
      unknown: { meaning: 'An enabled server readiness population could not be established.', safeAction: 'Inspect runtimeUnknown; do not promote missing readiness into a proof.' },
    },
    evidence: ['runtimeMeasurement'],
    measuredBy: { readiness: 'runtimeMeasurement' },
  },
  changeSignal: { kind: 'poll', tool: 'lsp:admission_snapshot', path: 'readiness' },
  shape: '[{ language, rootPath, taskId, certified, unproven, quiescent, pendingProgress, progressGeneration }]; process health never promotes an intent proof',
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * goal-mode-drift-guards-2026-08-31 P-002 — IS THE STEWARD PLACING ANYTHING?
 *
 * ── THE GAP, MEASURED ──────────────────────────────────────────────────────────
 *
 * Every existing goal predicate reads HEALTHY for a steward that reads and reports
 * indefinitely while placing nothing. `holder.ts` says `held`. `activity.ts` says
 * active. The wedge leg says `has-produced-work` — and its own docblock explains
 * why it must: it "only fires on holders that have NEVER produced an agent-origin
 * call, so this is not 'idle for 15 minutes' — it is 'has never once worked'".
 *
 * So the first thing in the entire system to object to such a goal was the ROLLING
 * BUDGET CEILING, after 4+ hours and $109. That is the complaint this cell answers:
 * money is meant to be the last line of defence, not the first one to notice.
 *
 * ── WHY THE HEADLINE IS A DURATION AND NOT THE RATE ────────────────────────────
 *
 * P-002 names the measurement "portfolio acts per hour", and `actsPerHour` is on
 * the payload. It is NOT the headline, because the condition to be caught is
 * "throughput sat at ZERO for N minutes" — a statement about a SPAN, and a rate
 * sampled at an instant cannot express one. `state:subscribe` compares one poll's
 * reading with `eq`/`gt`/`changed`; there is no dwell operator, and adding one
 * would be the second subscription mechanism state-plane P-004 forbids outright.
 *
 * Headlining `idleMinutes` makes an ORDINARY threshold do the work: `{op:'gte',
 * value:20}` on this cell IS "zero for twenty minutes". The duration is answered
 * where this registry has twice recorded that it belongs — in the RESOLVER. A
 * registry computing `idleFor >= N` would be the registry deriving a verdict,
 * which axis 5 forbids one level up.
 *
 * ── ⚠ AND WHY MATERIALITY IS NOT OPTIONAL HERE ─────────────────────────────────
 *
 * `idleMinutes` is a CLOCK. Absent a materiality declaration every change is
 * material, so an operand-free subscription would fire on EVERY poll — sixty wakes
 * an hour, each announcing that a minute had passed. That is the exact churn P-021
 * was written for, in its purest form: the raw value moves continuously while the
 * question the cell exists to answer ("is this goal placing nothing?") moves twice
 * a day at most. `idle` is that question, so `idle` is the material path.
 * ═══════════════════════════════════════════════════════════════════════════════ */
export const GOAL_PORTFOLIO_THROUGHPUT_CELL: CellSpec = {
  cell: 'goal.portfolioThroughput',
  registeredOn: '2026-08-31',
  owner: 'goal-mode-drift-guards-2026-08-31',
  headline: 'portfolioThroughput.idleMinutes',
  assessment: {
    path: 'portfolioThroughput.assessment',
    codes: {
      placing: {
        meaning:
          'A live holder has placed portfolio work inside the idle threshold — created, placed or steered something.',
        safeAction:
          'Leave the goal alone. If you are deciding whether to wind it down, this is the reading that says do not.',
      },
      'within-grace': {
        meaning:
          'A live holder, no portfolio act yet, but the goal has been held for less than the idle threshold. Too young to have been expected to place anything.',
        safeAction:
          'Wait. Re-read after the threshold elapses rather than escalating now — this is what a healthy steward looks like in its first minutes.',
      },
      'idle-past-threshold': {
        meaning:
          'A live holder has placed NOTHING for longer than the idle threshold. It is present, it is producing tool calls, and none of them changed the portfolio.',
        safeAction:
          'Escalate to the goal owner, or wind the goal down. Do NOT respawn the holder — respawn treats a dead session, and this one is alive and working; a replacement would inherit the same instructions and do the same thing. Read `lastActTool` and `actsInWindow` for what it last actually placed.',
      },
      'not-held': {
        meaning:
          'Nobody alive holds this goal, so it places nothing trivially. This is an ABSENT steward, not an idle one.',
        safeAction:
          'Read holder liveness (unheld / lost) and repair THAT — a holder is what is missing. Reporting this as idleness would route a staffing problem to a wind-down conversation.',
      },
      'evidence-unavailable': {
        meaning:
          'Throughput could not be measured — no goal-mode row, an unresolved liveness oracle, or an unreadable ledger. See the `unavailable` hoist for which.',
        safeAction:
          'Treat as UNKNOWN and retry. Never read it as zero: an unmeasured goal and a measurably idle one are the same absence of acts and completely different facts.',
      },
    },
    evidence: [
      'portfolioThroughput.actsInWindow',
      'portfolioThroughput.lastActAtMs',
      'portfolioThroughput.lastActTool',
      'portfolioThroughput.measuredOwnerIds',
    ],
    // P-012: idle minutes, acts in window and the measured-owner list are all counts over
    // the ledger; `unavailable` names why the ledger was not read. "Never read it as
    // zero" (evidence-unavailable) is this pairing stated as a rule.
    measuredBy: {
      'portfolioThroughput.idleMinutes': 'portfolioThroughput.unavailable',
      'portfolioThroughput.actsInWindow': 'portfolioThroughput.unavailable',
      'portfolioThroughput.measuredOwnerIds': 'portfolioThroughput.unavailable',
    },
  },

  /**
   * Axis 2. TRUE. `idleMinutes` is null whenever the measurement could not be
   * made, and those cases are real rather than theoretical: a goal with no
   * goal-mode row at all, a liveness oracle that did not answer, an unreadable
   * ledger. `unavailable` is the D-039 result-level hoist naming which — a caller
   * who reads only the headline still cannot mistake "we could not look" for
   * "we looked and found nothing".
   */
  nullable: true,
  unknownHoist: 'portfolioThroughput.unavailable',

  /**
   * Axis 3. Relative to WHICH GOAL. `param: 'id'` is not a naming choice — it is
   * `goals:get`'s own argument name, and the subscription builds its resolver args
   * as `{ [param]: subject }`. A mismatch here would dispatch `goals:get` with no
   * id and answer about nothing.
   */
  callerRelativity: { kind: 'parameter', param: 'id' },

  /**
   * Axis 4. The resolver was exercised against the live ledger while P-002 was
   * written, and the exercise CHANGED the implementation rather than confirming
   * it: resolving the criterion's 16 named verbs against real tool declarations
   * showed that `goals:amend` and `goals:kill` do not exist anywhere in the tree
   * (the real door for both is `goals:update`), so the prose definition this cell
   * replaces was structurally blind to amendment and kill activity. That is
   * precisely the class of defect a fixture cannot catch: the query was fresh,
   * correctly-scoped and confidently wrong.
   */
  provenance: {
    obtainedBy:
      "harness_shared.tool_invocations filtered to status='ok' and portfolioActLedgerPredicate — tool_name = ANY(PORTFOLIO_ACT_TOOLS), OR a PORTFOLIO_CONDITIONAL_ACTS tool matching in one of two polarities: key PRESENCE (work_items:update { goal } / items[].goal — goal placement of existing backlog, WI-2140701) or key NOT-VALUE, where the act is the default and one value opts out (improvements:capture with lane <> 'observation' — a real filing mints a work-item, an observation is a turn-end reflection, WI-2142888) — scoped to the goal's holder identities from resolveGoalHolders (dead holders included, per spend-rollup's precedent)",
    liveExercised: true,
    evidence:
      'Run against the LIVE ledger 2026-08-31, over every goal in papercusp-workspace carrying a goal-mode row (9 goals), with a positive control on the same table/scope so a zero could not be a broken instrument. It reproduced the motivating case rather than merely agreeing with it: `work-on-everything-070565` — the goal that ran 4+ hours and $109 — measured ONE portfolio act in seven days, idle 4604 minutes, last act `plans:set-status`. Both branches were exercised on real rows: `shared-pot-p2p-is-ready-for-public-release-f` measured 50 acts in 7d with the most recent 53 minutes ago, i.e. non-zero in the hour window and still past the 20-minute idle threshold — the recency-not-window-total case. Five goals measured a true zero. Separately, all 16 verbs named by the prose criterion this cell replaces were resolved against their `name:` declarations: 14 resolved, `goals:amend` and `goals:kill` returned nothing, and a full enumeration of every registered `goals:*` tool confirmed `goals:update` as the only amend/kill door — so the set this cell counts is the corrected one.',
  },

  /** Axis 5. ONE derivation. The watchdog leg and every read project this resolver
   *  and none re-derive it; `goals:get` threads its already-resolved holders in so
   *  the liveness it reports and the verdict computed from it cannot disagree. */
  resolver:
    'readGoalPortfolioThroughput() @ packages/operator-core/lib/goals/portfolio-throughput.ts',

  /**
   * P-019 (a). WORKSPACE-visible, deliberately. The audience that most needs this
   * is not the holder — a steward cannot be relied upon to notice its own
   * idleness, which is the whole reason the condition ran four hours. It is
   * whoever is deciding whether to keep funding the goal.
   *
   * P-019 (b). `local`: goal ids and owner ids do not resolve in a foreign hive,
   * so the value would not merely be uninteresting there, it would be misread as a
   * statement about their own goals.
   */
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },

  /**
   * ⚠ NO `data.` PREFIX — and this is the one line of this spec that was WRONG as
   * shipped (EI-22089346495559937). `goals:get`'s handler does return
   * `{ data: { …, portfolioThroughput } }`, and every path here was declared against
   * that handler-level shape. But a cell never sees the handler's return value: the
   * projected-tool dispatcher `readCell` goes through unwraps the `{ data }` envelope
   * before `valueAtPath` runs, so the payload at the walker is
   * `{ id, title, …, portfolioThroughput }` — top level. Declared under `data.`, every
   * read answered `insufficient-data` ("declared path drifted") and every
   * `state:subscribe` on this cell was un-fireable, while the resolver worked
   * perfectly — the exact failure `goals:get`'s own comment warns about, one envelope
   * over. Measured live 2026-09-01 by dispatching `goals:get` through
   * `dispatchReadOnlyTool` and printing the top-level keys. The sibling cells on
   * `data:`-returning tools (gate.qualification → `gate.qualification.attemptId`) were
   * already declared envelope-free; this one now matches them, and
   * cell-registrations.test.ts pins the rule registry-wide.
   */
  changeSignal: {
    kind: 'poll',
    tool: 'goals:get',
    path: 'portfolioThroughput.idleMinutes',
  },

  /** P-021 — see the header. The clock churns every poll; the boolean is the question. */
  materiality: {
    path: 'portfolioThroughput.idle',
    why: 'idleMinutes is a CLOCK: it advances on every poll by construction, so treating its every change as material would wake a subscriber roughly sixty times an hour to report that a minute had passed. `idle` is the question the cell exists to answer and flips at most a couple of times in a goal\'s life.',
  },

  shape:
    '{ portfolioThroughput: { windowMinutes, actsInWindow, actsPerHour, lastActAtMs, lastActTool, lastActFacet, ' +
    'idleMinutes, idleAfterMinutes, measuredOwnerIds, holderLiveness, idle, reason, assessment, unavailable } } ' +
    '(the dispatcher-unwrapped payload — the handler\'s own `{ data: … }` envelope is stripped before any path is walked)',

  /**
   * Axis 6 is deliberately ABSENT. Placing work has no stage order — a steward
   * moves between placing and idle in both directions and neither is "further
   * along" than the other. Declaring stages would invite a reader to treat `idle`
   * as a terminal phase rather than a condition that a single act clears.
   */
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01 P-004 — "ARE WE AT
 * CAPACITY?" IS ONE READ, AND IT NAMES WHICH TERM BINDS.
 *
 * ── THE GAP, MEASURED ──────────────────────────────────────────────────────────
 *
 * The audit behind this plan found the question answered by four surfaces that could
 * not agree, because each saw one leg: `accounts:status` (quota), `gateway:status`
 * (admission), `fleet:capacity` (both, but publishing only THAT you are stuck), and
 * the burn governor (a PACING PROJECTION that reads exactly like a wall in prose).
 * A reader who got "at capacity" could not tell whether to WAIT for a provider reset,
 * RAISE a self-imposed clamp, CHANGE a pacing policy, or look at the box — four
 * different actions, three of them wasted.
 *
 * `capacityVerdict.binding` is the answer, and this cell is its one canonical door.
 *
 * ── WHY THE HEADLINE IS NULLABLE WHEN ITS TYPE IS `boolean` ────────────────────
 *
 * `atCapacity` is never literally null. It is declared nullable anyway, for exactly
 * the reason this file's opening docblock gives about `positions.deployed`: the
 * resolver CAN fail into a default. A gateway that did not answer, or a pool whose
 * readings are all stale, yields `atCapacity: false` — byte-identical to an honest
 * "nothing is binding". Type totality is not the question axis 2 asks. So every
 * unmeasured leg is named in `capacityUnknown`, and that is the hoist.
 *
 * ── ⚠ WHY `host` IS NOT IN THE CODE MAP ───────────────────────────────────────
 *
 * `CapacityBinding` has five members and this cell declares FOUR. The resolver reads
 * the account pool and the gateway; neither measures CPU/memory/PSI, so it can never
 * honestly emit `host`. Declaring the fifth code would advertise semantics the read
 * can never deliver — the same emptiness `assessment-codes-empty` rejects, one member
 * at a time. The host question is carried by a POINTER to `host.memoryPressure`
 * instead, which is what a pointer is for: not a claim about this cell's reading, just
 * "the question you are about to ask next is answered THERE".
 */
export const CAPACITY_VERDICT_CELL: CellSpec = {
  cell: 'capacity.verdict',
  registeredOn: '2026-09-01',
  owner: 'capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01',

  headline: 'capacityVerdict.atCapacity',

  /** Axis 3. PER-PROVIDER: a claude wall is not evidence about codex, which is the
   *  interleaving defect P-002 fixed one level down. Read with `as: 'claude' | 'codex'`. */
  callerRelativity: { kind: 'parameter', param: 'provider' },

  nullable: true,
  unknownHoist: 'capacityUnknown',

  assessment: {
    path: 'capacityVerdict.binding',
    codes: {
      'usage-wall': {
        meaning:
          'A PROVIDER wall: usage windows are exhausted (or accounts are rate-paused) and no account can serve on a fresh reading. Check atCapacity for whether every reading was fresh — when it is false, some rows are stale and could still serve.',
        safeAction:
          'HOLD placements and wait for a usage window to reset, or route to another provider. Do NOT raise admission and do NOT change pacing — neither can relieve a provider wall. If atCapacity is false, run accounts:probe-capacity before declaring the pool exhausted or escalating.',
      },
      'admission-concurrency': {
        meaning:
          'OUR OWN door: the gateway is holding the lane at zero spare dispatch slots while the accounts themselves can serve. Nothing is walled — we are limiting ourselves.',
        safeAction:
          'Raise the admission window, or wait for in-flight work to drain and re-read — this clears on its own as requests complete. Do NOT wait for a provider reset and do NOT escalate to the owner; there is no provider fault here.',
      },
      'pacing-policy': {
        meaning:
          "This system pacing ITSELF off the burn governor's projected exhaustion. NOTHING is measurably walled, and no provider reset is coming because there is nothing to reset.",
        safeAction:
          'Decide whether to accept the burn or change the pacing policy. Do NOT wait it out and do NOT report a provider wall — treating a pacing projection as a measured wall is the specific error this cell exists to prevent.',
      },
      none: {
        meaning:
          'No term is measurably binding this provider. ⚠ Read capacityUnknown before acting: when it is non-empty this means "no measured blocker", NOT "measured clear".',
        safeAction:
          'Place work when capacityUnknown is empty. When it is not, treat the read as partial — refresh the named leg (accounts:probe-capacity for the pool, re-read for the gateway) before relying on it to size a launch.',
      },
    },
    evidence: ['capacityVerdict.evidence', 'capacityVerdict.reason', 'capacityUnknown'],
  },

  provenance: {
    obtainedBy:
      'deriveCapacityVerdict() merging the P-002 per-provider account rollup (poolVerdictByProvider) with the gateway admission snapshot (buildCapacityReport), both already resolved inside one fleet:capacity dispatch',
    liveExercised: true,
    evidence:
      "Exercised end-to-end through fleet:capacity on the staging operator (:3170, restarted onto current source) against the live claude pool at 2026-09-01T05:07Z, and THE LIVE READ CAUGHT A REAL DEFECT that fixtures had not. The pool read serviceable=0, walledFresh=6, pacing=1, unknown=1 of 7 with dispatchBudget=6. The first implementation gated its wall branch on `pool.atCapacity && binding==='usage-wall'`; atCapacity was correctly false (one stale row could still serve), so it fell through every branch and answered binding:'none' — \"no term is measurably binding\" — with six accounts measurably walled. That is the exact false-green this plan exists to remove. The fix separates the two questions (binding = which term, atCapacity = fully measured or not) and the live reading is pinned as the first case in capacity-verdict.test.ts so it cannot regress. Re-verified: the FIXED derivation run against those same measured inputs returns binding:'usage-wall' with atCapacity:false and a reason that names the stale row and says to refresh before declaring the pool exhausted.",
  },

  resolver: 'deriveCapacityVerdict() @ packages/operator-core/lib/fleet/capacity-verdict.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'fleet:capacity', path: 'capacityVerdict.atCapacity' },

  /**
   * P-021 — the raw headline flips on every transient admission zero (in-flight work
   * draining moves dispatchBudget through 0 routinely), but the question this cell exists
   * to answer is WHICH TERM BINDS, and that moves only when the situation actually changes
   * kind — a pool going walled, a clamp taking over, pacing engaging. Subscribers want the
   * kind-change, not every flap of the boolean.
   */
  materiality: {
    path: 'capacityVerdict.binding',
    why: 'atCapacity flips whenever in-flight work transiently fills the admission window, which on a busy fleet is constant churn carrying no news. The binding term changes only when the REMEDY changes — which is the whole reason to be woken.',
  },

  pointers: [
    {
      cell: 'host.memoryPressure',
      when: 'binding is "none" (or the clamp is not explained by the provider) and placements are still failing or slow',
      answers:
        'whether the BOX is the constraint. This cell reads the account pool and the gateway only; it never measures CPU/memory/PSI, so it can neither report nor rule out a host bottleneck — it is the one member of the CapacityBinding vocabulary this resolver deliberately cannot emit.',
    },
  ],

  shape:
    '{ capacityVerdict: { provider, atCapacity: boolean, binding: "usage-wall"|"admission-concurrency"|"pacing-policy"|"none", evidence: [{ signal, value, writer, means }], reason, unknown: string[] }, capacityUnknown: string[] }',
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * role-model-one-answer-2026-09-03 P-004 — WHAT WILL THIS ROLE LAUNCH AS?
 *
 * ── THE GAP, MEASURED ──────────────────────────────────────────────────────────
 *
 * On 2026-09-03 (00:32Z→01:27Z) nine consecutive release-fixers spawned onto a
 * usage-walled codex account and died instantly, while `models['release-fixer']`
 * = 'claude-opus-5:xhigh' and `roleBackends['release-fixer']` = 'claude-code'
 * were BOTH already set correctly. The launch path never consulted `models[role]`,
 * so the explicit answer was inert — and nothing in the system could be asked what
 * a role resolved to. Establishing it took hand-writing a tsx probe against an
 * internal test seam; with this cell it is one read.
 *
 * ── WHY THE HEADLINE IS `conflicts` AND NOT THE MODEL ──────────────────────────
 *
 * The obvious headline is the model spec, and it is the wrong one. A spec is a
 * STRING a reader must adjudicate — is `claude-opus-5:xhigh` beside backend
 * `codex` right or catastrophic? — and adjudicating it is precisely the step that
 * did not happen. `conflicts` is the adjudicated measurement: the roles whose
 * configured backend the resolved model overrules, i.e. the roles about to launch
 * somewhere the owner did not choose. It is a LIST, so an ordinary threshold
 * subscription (`gt 0`) expresses "tell me when a role starts launching wrong",
 * and the per-role `{ model, backend, source, why }` rows sit on the payload for
 * the reader who then needs specifics.
 *
 * `verdict` is the ASSESSMENT of that measurement, not a re-projection of it: it
 * folds in the second failure mode (`undetermined` — no backend could be
 * determined at all), which a conflict count cannot express. `conflicted`
 * outranks `undetermined` deliberately: a contradiction is a launch that will run
 * somewhere the owner did not choose, while an undetermined backend merely
 * inherits the host's agent command — the pre-existing default.
 * ═══════════════════════════════════════════════════════════════════════════════ */
export const ROLE_LAUNCH_CELL: CellSpec = {
  cell: 'agent.roleLaunch',
  registeredOn: '2026-09-03',
  owner: 'role-model-one-answer-2026-09-03',
  headline: 'conflicts',

  assessment: {
    path: 'verdict',
    codes: {
      consistent: {
        meaning:
          'Every reported role resolves to a model AND a backend that agree — no configured roleBackends entry is being overruled.',
        safeAction: 'Launch. The resolved pair is what the spawn will carry.',
      },
      conflicted: {
        meaning:
          "At least one role's configured roleBackends value disagrees with the backend its model implies. The MODEL wins downstream (WI-4640), so the configured backend is ignored and that role launches on a CLI the owner did not pick.",
        safeAction:
          "Read `conflicts` for the affected roles and each row's `conflict.note`, then align models[role] and roleBackends[role] in /settings/agent. Do NOT invert the precedence — pairing a Codex model with the claude binary is fatal at launch.",
      },
      undetermined: {
        meaning:
          "At least one role's backend could not be determined from its model or its configuration, so that launch inherits the host's agent command rather than a chosen CLI.",
        safeAction:
          'Read `backendUndetermined`. Inheriting is the pre-existing default and is often fine; set roleBackends[role] when the host command is not the CLI that model needs.',
      },
    },
    evidence: ['roles', 'backendUndetermined'],
  },

  /**
   * Axis 2. FALSE. `conflicts` is a materialised array on every path — a role with
   * no configuration at all resolves `source: 'committed-default'` and contributes
   * no row, giving `[]`. There is no read that can fail into an empty list:
   * `readAgentConfig` either returns a config or throws, and a throw surfaces as
   * `resolver-failed`, never as a silently-empty conflict set. The distinction
   * matters here more than usual — an empty list is exactly the reading an owner
   * treats as "all clear", so it must not double as "could not measure".
   */
  nullable: false,
  whyTotal:
    'resolveRoleLaunch() is pure and total over the roles enumerated from config, and the only I/O — readAgentConfig — either returns a config or throws (→ resolver-failed). There is no branch that yields [] from a failed read, so an empty `conflicts` is always a measured all-clear.',

  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      'resolveRoleLaunch() over the LIVE stored agent-config + owner steering — the same pure function the launch path itself calls, so the readout cannot disagree with the launch',
    liveExercised: true,
    evidence:
      "Exercised against the live workspace config 2026-09-03 with all 8 launch roles pinned to claude-opus-5:xhigh + roleBackends claude-code: every row resolved source='per-role', backend='claude-code' (model-shape), conflicts=[] — the reading that was unavailable during the release-fixer incident hours earlier.",
  },

  resolver:
    'the config:role-launch handler (resolveRoleLaunch over readAgentConfig + getOwnerSteering) @ packages/operator-core/lib/agent-tools/config/role-launch.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  // No `materiality`: every change to `conflicts` IS material — the set only moves
  // when a role starts or stops launching somewhere the owner did not choose. This
  // is precisely why the headline is the conflict list and not a model string,
  // which churns on every ordinary menu edit and would wake a subscriber for nothing.
  changeSignal: { kind: 'poll', tool: 'config:role-launch', path: 'conflicts' },

  shape:
    '{ verdict: "consistent"|"conflicted"|"undetermined", population: "configured"|"requested", populationNote, roles: [{ role, model, backend, source, backendSource, spawnModel, why, conflict }], conflicts: string[], backendUndetermined: string[] }',
};

/** Every built-in cell, in registration order. */
/**
 * Cell 2f — IS THE FROZEN QUEUE CONVERGING, and how long has it been at it?
 * main-green-status-visible-2026-09-03 P-004 (audit questions #17 and #18).
 *
 * ── THE MEASURED GAP THIS CLOSES ────────────────────────────────────────────────
 * freeze-and-converge's entire promise is that repairs LAND ON a held candidate instead of
 * each red re-cutting at tip. Whether that promise is being kept is a question about a
 * TREND — is the failing set shrinking, round over round — and until now no instrument
 * reported it. `buildFrozenRepairConvergenceGateHealth` had been DERIVING and persisting
 * the whole summary on every queue write since D-007, and it was simply never projected,
 * so the one question the mechanism exists to answer was answerable only by grepping
 * per-run checkpoint logs. Measured 2026-09-03: 17 distinct candidates judged by CI in 30h
 * with none re-judged — the tip-re-cut signature — while every surface an agent could read
 * showed only an undifferentiated red.
 *
 * ── WHY `no-attempts` IS ITS OWN CODE ───────────────────────────────────────────
 * Earned 2026-09-03. A queue can sit at `attempts: 0` for hours — tick after tick withheld
 * by a provider wall or a dispatch reservation — while `consecutiveReds` climbs (103 that
 * morning) and `failingTests` stays frozen at whatever the last tick that ACTUALLY RAN
 * measured. From outside, that is indistinguishable from a live regression, and the
 * natural response is to go hunting for the commit that broke it. There is no commit. It
 * is a DISPATCH fact, not a code fact, so it must not be folded into the trend codes.
 *
 * ── THE TRI-STATE IS LOAD-BEARING ───────────────────────────────────────────────
 * `not-yet-knowable` (fewer than two recorded rounds) is NOT `not-converging`. Collapsing
 * them calls a healthy new freeze a treadmill, and "the freeze is a treadmill" is the
 * belief that gets the mechanism switched off — which is the outage D-007 was written
 * after.
 */
export const GATE_CONVERGENCE_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.convergence',
  registeredOn: '2026-09-03',
  owner: 'su-4342525e-2b14-4780-bf1b-3b413480030d',
  headline: 'gate.convergence.shrinkTotal',
  assessment: {
    path: 'gate.convergence.code',
    codes: {
      'no-cycle-recorded': {
        meaning:
          'No readable convergence record. This is a MEASURED ABSENCE of the subject — it says nothing about whether a queue is healthy, and nothing about whether one is stuck.',
        safeAction:
          'Do NOT read the null fields beside this as zeros; a `shrinkTotal` of null is not "not shrinking". Read gate.greenCheckpoint.freezeDisposition for whether a freeze exists at all, then release:repair-queue { op: "get" } for the live queue.',
      },
      'no-attempts': {
        meaning:
          'A cycle is open but NO fixer has ever run on it (attempts 0), so nothing has been measured to converge. The reds beside this describe the last tick that actually ran, not the current candidate.',
        safeAction:
          'Read this as a DISPATCH problem, not a code problem — do not go hunting for the commit that broke it. Check freezeDisposition.reason for what withheld dispatch (a provider wall, a reservation held by another checkpoint). Do NOT fire release:checkpoint-run: it cuts a fresh candidate at tip and restarts the treadmill.',
      },
      'not-yet-knowable': {
        meaning:
          'Fewer than two rounds are recorded, so there is no trend yet. NOT a verdict of failure — a healthy new cycle looks exactly like this.',
        safeAction:
          'Wait for the next round rather than concluding anything. Reporting this as "not converging" is what gets a working freeze switched off.',
      },
      converging: {
        meaning:
          'Every recorded round is no larger than the one before AND the failing set actually shrank. The mechanism is doing its job.',
        safeAction:
          'Let it run. Land further fixes ON TOP of the frozen candidate so they join this lineage; never cut a fresh candidate to "try again".',
      },
      'not-converging': {
        meaning:
          'Rounds are recorded and the failing set is NOT shrinking. This is the treadmill the freeze exists to prevent, and it is a real finding rather than an artefact.',
        safeAction:
          'Read shrinkPerRound to see where it stalled, and check whether new breakage is being imported faster than fixes land. Escalate on the work-item that owns the red — do NOT retire the queue on this code alone.',
      },
    },
    evidence: [
      'gate.convergence.unmeasured',
      'gate.convergence.attempts',
      'gate.convergence.admissionRounds',
      'gate.convergence.shrinkPerRound',
      'gate.convergence.ageMs',
    ],
    // P-012: "a `shrinkTotal` of null is not 'not shrinking'" (no-cycle-recorded) — every
    // count in this cell is vouched for by `unmeasured`, which is also its unknownHoist.
    measuredBy: {
      'gate.convergence.shrinkTotal': 'gate.convergence.unmeasured',
      'gate.convergence.attempts': 'gate.convergence.unmeasured',
      'gate.convergence.admissionRounds': 'gate.convergence.unmeasured',
      'gate.convergence.shrinkPerRound': 'gate.convergence.unmeasured',
    },
  },
  nullable: true,
  unknownHoist: 'gate.convergence.unmeasured',
  callerRelativity: { kind: 'global' },
  provenance: {
    obtainedBy:
      "gate_health.convergence — DERIVED by buildFrozenRepairConvergenceGateHealth() in the same statement that persists repair_queue (rung 1 of the derived-truth ladder), shape-checked back by parseFrozenRepairConvergence() and projected by projectFrozenRepairConvergenceCell()",
    liveExercised: true,
    evidence:
      'Read live 2026-09-03T11:38Z against frozen candidate 79c50b5b7b78: openedAtMs 1788427425483 (09:23:45Z), repairHead d19af1bd60d8, attempts 0, convergenceRounds [{ round 1, failingCount 1 }], failingTests ["lint:tsc"] — i.e. exactly the `no-attempts` shape, on a queue whose reds had been read as a code regression for over two hours.',
  },
  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',
  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: {
    kind: 'poll',
    tool: 'dev:pipeline_position',
    path: 'gate.convergence.shrinkTotal',
  },
  shape:
    '{ gate: { convergence: { code, unmeasured, openedAtMs, ageMs, attempts, admissionRounds, failingFirst, failingNow, shrinkTotal, shrinkPerRound: [{ round, failingCount, delta }], converging, candidate, repairHead, phase, observedAtMs, scope: { population, subject, admittedAtOrBeforeMs, admittedAtOrAfterMs, notComparableTo: [{ reading, why }], summary } } } }',
};

/**
 * Cell 2g — IS FREEZE-AND-CONVERGE ON RIGHT NOW, AND IF NOT WHY?
 * main-green-status-visible-2026-09-03 P-004 (audit question #19), over the record P-008 landed.
 *
 * ── THE MEASURED GAP THIS CLOSES ────────────────────────────────────────────────
 * `repairQueue: null` is three different facts wearing one value: "the owner switched the
 * freeze off", "the gate just retired a frozen candidate", and "nothing is frozen, all is
 * well". That ambiguity let freeze-and-converge sit off fleet-wide for a full day — 20
 * frozen candidates retired, 0 resumed — while looking like an ordinary week (WI-2141736).
 * A retire CLEARS the queue row, so `repairQueue` reads null exactly when it matters most.
 *
 * ── WHY THIS IS A SEPARATE CELL FROM `convergence` ──────────────────────────────
 * Different subjects, and a CellSpec describes exactly one (D-014). This answers "is the
 * mechanism ACTING"; the sibling answers "is that action WORKING". They dissociate in both
 * directions — `state: 'converging'` with `code: 'no-attempts'` is precisely the live
 * reading on 2026-09-03, and it is the combination that reads healthy and is not.
 *
 * ── THE TWO CODES THE STORED UNION CANNOT EXPRESS ───────────────────────────────
 * `not-measured` and `stale`. A caller branching on the raw `state` has to invent a default
 * for an absent record, and both plausible defaults (`none`, `off`) are wrong and calm. And
 * a `retired` observed hours ago describes HISTORY — read as current it is the false-green
 * class applied to the freeze, which is why staleness outranks the state it qualifies.
 *
 * ⚠ `off` and `none` are NOT synonyms. `off` = the owner's switch is off, reds do not
 * freeze at all. `none` = the mechanism is ON and simply had no frozen candidate this tick,
 * which is a green gate's normal state. Conflating them IS the original outage.
 */
export const GATE_FREEZE_DISPOSITION_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.freezeDisposition',
  registeredOn: '2026-09-03',
  owner: 'su-4342525e-2b14-4780-bf1b-3b413480030d',
  headline: 'gate.freezeDisposition.state',
  assessment: {
    path: 'gate.freezeDisposition.code',
    codes: {
      'no-disposition-recorded': {
        meaning:
          'The routine row carries no readable disposition. NOT "the freeze is healthy" and NOT "nothing is frozen" — the gate simply never told us.',
        safeAction:
          'Do not infer a state from the null fields beside this. Read release:repair-queue { op: "get" } for the live queue, and treat the freeze as unverified until a tick reports one.',
      },
      stale: {
        meaning:
          'A disposition exists but was observed longer ago than the freshness window, so it describes HISTORY. The gate has not reported since.',
        safeAction:
          'Read `observedAtMs`/`ageMs` and treat the state as a past reading, not current. A `retired` or `converging` from hours ago is exactly the value that reads as live and is not — re-read after the next tick before acting on it.',
      },
      off: {
        meaning:
          "The owner-visible switch is OFF: reds do NOT freeze a candidate at all, and the gate re-cuts at tip. This is the pre-D-001 treadmill, deliberately enabled.",
        safeAction:
          'If this is not intentional, that is the finding — report it. Do not "fix" it by firing checkpoint-run, which is the same behaviour by hand. The switch is FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT via /admin/features.',
      },
      none: {
        meaning:
          'The mechanism is ON and simply had no frozen candidate this tick. This is a GREEN gate\'s normal state — nothing to hold, nothing to retire.',
        safeAction:
          'Nothing to do. Do NOT read this as "the freeze is off"; that conflation is the outage this cell was built after.',
      },
      held: {
        meaning:
          'A frozen candidate is being HELD: no verdict this tick, no queue mutation, re-measured next tick. Repairs are expected to land on it meanwhile.',
        safeAction:
          'Read `holdUntilMs` for when the hold gives up, and `reason` for what it is waiting on. Land fixes ON TOP of the frozen candidate so they join the judged lineage; do not cut a fresh one.',
      },
      retired: {
        meaning:
          'A frozen candidate was RETIRED this tick and the gate falls through to a fresher candidate. Every repair that had accumulated on it is no longer being judged.',
        safeAction:
          'Read `reason` — a retire on anything other than provable unreachable-green is the D-007 treadmill re-entering, and it is worth a work-item. Check whether the reds it carried were already fixed at the old repairHead before accepting it.',
      },
      converging: {
        meaning:
          'A frozen candidate is live and being repaired — a fixer is dispatched, or repairHead is advancing.',
        safeAction:
          'Confirm the action is REAL before relying on it: read gate.greenCheckpoint.convergence, whose `no-attempts` code means zero fixer runs have happened despite this state. `converging` + `no-attempts` together is the combination that reads healthy and is not.',
      },
    },
    evidence: [
      'gate.freezeDisposition.unmeasured',
      'gate.freezeDisposition.reason',
      'gate.freezeDisposition.enabled',
      'gate.freezeDisposition.observedAtMs',
      'gate.freezeDisposition.stale',
    ],
    // main-green-status-visible-2026-09-03 P-007: caught by the per-cell drift test
    // (main-green-status-visible-cell-drift.test.ts) on the UNMEASURED projection — `stale`
    // is null there, and a null at that leaf with no pairing is indistinguishable from a
    // measured "not stale" (P-012). `unmeasured` is the flag that says why it is null.
    measuredBy: {
      'gate.freezeDisposition.stale': 'gate.freezeDisposition.unmeasured',
    },
  },
  nullable: true,
  unknownHoist: 'gate.freezeDisposition.unmeasured',
  callerRelativity: { kind: 'global' },
  provenance: {
    obtainedBy:
      'gate_health.freezeAndConverge — written by the checkpoint tick via buildFrozenAndConvergeGateHealth(), shape-checked back by readFreezeAndConverge() and projected with its vintage by projectFreezeDispositionCell()',
    liveExercised: true,
    evidence:
      'Read live 2026-09-03T11:38Z: state "converging", enabled true, candidate 79c50b5b7b78, reason "frozen repair fixer dispatch is reserved by another checkpoint until 1788435139988; candidate d19af1bd remains serialized and no suite was run" — the sentence that previously existed only inside a per-run log, and the one that explained a 103-red streak nobody could account for.',
  },
  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',
  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: {
    kind: 'poll',
    tool: 'dev:pipeline_position',
    path: 'gate.freezeDisposition.state',
  },
  shape:
    '{ gate: { freezeDisposition: { code, unmeasured, state, reason, enabled, candidate, holdUntilMs, capacityRetryAtMs, observedAtMs, ageMs, stale, summary } } }',
};

/**
 * Cell 2h — IS AN AUTO-REFIRE / RE-TRIAGE IN FLIGHT, AND MUST I STAND DOWN?
 * main-green-status-visible-2026-09-03 P-009 (audit question #21).
 *
 * ── THE MEASURED GAP THIS CLOSES ────────────────────────────────────────────────
 * The two ways to learn you were inside the re-triage window both arrived AFTER the
 * decision to act: provoke `release:checkpoint-run`'s refusal, or hand-dig
 * `retriageDetail` / `inFlightCandidate` / `verdictlessRefire` out of routine metadata.
 * CLAUDE.md gives the rule its own 🚨 alarm block — firing into the window "discards the
 * rescue and costs a full suite" — and an alarm block is the tell that a question is
 * expensive and repeatedly got wrong. A rule whose only enforcement is a refusal you must
 * provoke is not readable in advance; this cell makes it one.
 *
 * ── WHY THIS IS A SEPARATE CELL FROM `candidate` ────────────────────────────────
 * Different subjects (D-014). `gate.greenCheckpoint.candidate` answers WHICH sha is being
 * judged and how much to trust that reading; this answers WHETHER A DESTRUCTIVE ACTION IS
 * SAFE RIGHT NOW. They dissociate: a perfectly authoritative `retriage-marker` candidate is
 * exactly the reading you get while a refire is in flight, so trusting the sha says nothing
 * about whether you may act on it.
 *
 * ── UNKNOWN HOLDS YOU, IT DOES NOT RELEASE YOU ──────────────────────────────────
 * `standDown` is TRUE on `not-measured`. This is the one asymmetry in the whole family and
 * it is deliberate: every other cell's unknown means "do not conclude", while this one's
 * also means "do not act". Collapsing an unmeasured liveness reading to "nothing in flight"
 * hands out precisely the green-light that costs a ~55min suite, and the stand-down advice
 * is cheap and correct either way — the claim that nothing is in flight is not.
 */
export const GATE_RETRIAGE_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.retriage',
  registeredOn: '2026-09-03',
  owner: 'su-4342525e-2b14-4780-bf1b-3b413480030d',
  headline: 'gate.retriage.inFlight',
  assessment: {
    path: 'gate.retriage.code',
    codes: {
      // NOT `not-measured`: that literal is reserved by the read-health vocabulary
      // (CELL_UNKNOWN_CODES), and D-008 keeps read-health and domain meaning in separate
      // vocabularies so a caller can tell "the cell could not answer" from "the cell
      // answered, and the answer is that the RUN could not be read".
      'no-run-reading': {
        meaning:
          'Neither the run lock nor the cached run reading answered, so whether a refire is in flight is UNKNOWN. This is NOT "no refire in flight".',
        safeAction:
          'STAND DOWN anyway — unknown holds you. Do NOT fire release:checkpoint-run on this reading: if a rescue is in flight it is discarded and a full suite is lost. Re-read after the next tick, or read release:checkpoint-run\'s own refusal, which takes the same marker.',
      },
      'no-run': {
        meaning:
          'No checkpoint run is active at all, so no auto-refire can be in flight. A measured negative, not an absence.',
        safeAction:
          'Nothing to stand down for on THIS axis. Every other gate rule still applies — in particular, a manual run cuts a FRESH candidate at tip and restarts the treadmill, so read gate.greenCheckpoint.freezeDisposition before firing one.',
      },
      'no-refire': {
        meaning:
          'A checkpoint run IS active but no auto-refire is in flight — there is no rescue to discard.',
        safeAction:
          'A manual release:checkpoint-run would still be refused as `already_running`, so firing one buys nothing. Let the active run reach a verdict.',
      },
      'in-flight': {
        meaning:
          'An auto-refire IS in flight: this run judged a red stale and re-fired onto a newer candidate, and is re-verifying it now. The red you are reasoning about may belong to a candidate this run has ALREADY discarded.',
        safeAction:
          'STAND DOWN. Firing release:checkpoint-run now discards the rescue and costs a full suite (green-checkpoint.ts\'s own words). Read `abandonedFailingFiles` before fixing anything — those are the files the discarded red named. Wait for the verdict.',
      },
      'in-flight-at-cap': {
        meaning:
          'A refire is in flight AND the rescue budget is exhausted — by the charged counter, the absolute ceiling, or a disabled cap. The NEXT red STICKS.',
        safeAction:
          'STAND DOWN for this refire, and prepare for the red to be real: read `budgetLabel` for which bound is spent. This is the point at which a human lever starts to matter — but interrupting the in-flight run still costs the suite without changing the outcome.',
      },
    },
    evidence: [
      'gate.retriage.unmeasured',
      'gate.retriage.standDown',
      'gate.retriage.fromCandidate',
      'gate.retriage.refiringCandidate',
      'gate.retriage.abandonedFailingFiles',
      'gate.retriage.budgetLabel',
      'gate.retriage.summary',
    ],
    // P-012: the abandoned-files list is null when no re-fire is in flight AND when the
    // marker could not be read; `unmeasured` is what tells those apart.
    measuredBy: { 'gate.retriage.abandonedFailingFiles': 'gate.retriage.unmeasured' },
  },
  nullable: true,
  unknownHoist: 'gate.retriage.unmeasured',
  callerRelativity: { kind: 'global' },
  provenance: {
    obtainedBy:
      "gate.checkpointRunInFlight — the leg gitPipelinePosition() already maps via mapCheckpointRunInFlight() from the live run-lock, the cached run reading and gate_health.inFlightRetriage (parseInFlightRetriage); projected by projectRetriageCell(), which re-reads nothing and consults the raw marker only for `failingFiles`, and only once in-flight is settled",
    liveExercised: true,
    evidence:
      'Read live 2026-09-03T12:2xZ against the frozen candidate 79c50b5b7b78 / repairHead d19af1bd60d8: no refire in flight (the gate was serialized behind another checkpoint\'s fixer-dispatch reservation, attempts 0), i.e. the `no-run`/`no-refire` arm — the reading an agent watching a 103-red streak most needs, because it is the one under which firing a manual run looks harmless and is not.',
  },
  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',
  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: {
    kind: 'poll',
    tool: 'dev:pipeline_position',
    path: 'gate.retriage.inFlight',
  },
  shape:
    '{ gate: { retriage: { code, unmeasured, inFlight, runActive, standDown, fromCandidate, refiringCandidate, abandonedFailingFiles, budgetLabel, atCap, refireAttempt, maxRefires, totalRefires, absoluteCeiling, observedAtMs, ageMs, asOfAgeMs, summary } } }',
};

/**
 * workspace.workScope — WI-2145092 (plan workspace-work-scope-policy-2026-09-04, the D-003
 * residue). "Is this workspace confined to an allow-list of harnesses right now, and which?"
 * The headline is the stored MODE; the assessment folds mode + allow-list through the SAME
 * predicate every dispatch gate uses (isWorkScopeEnforced), so a reader branches on exactly
 * what the gates enforce: `enforce` (out-of-scope work is refused with scope_denied), `off` (a
 * row exists but confines nothing — mode 'off', or an enforce row with an empty allow-list),
 * `absent` (no row: byte-identical to before the policy shipped, D-001).
 *
 * Resolved through the READ-ONLY lens `workspace:work_scope_status`, not the control tool
 * `workspace:work_scope` — the cell dispatcher refuses a write-capable resolver by contract.
 */
export const WORK_SCOPE_CELL: CellSpec = {
  cell: 'workspace.workScope',
  registeredOn: '2026-09-05',
  owner: 'workspace-work-scope-policy-2026-09-04',
  headline: 'mode',

  assessment: {
    path: 'assessments.policy',
    codes: {
      enforce: {
        meaning:
          'A policy row is stored with mode enforce and a non-empty allow-list: every dispatch seam (claim, claim_next, plan-item claim, scheduler pull, launch-agent, launch-on-plan, goals:attach-pot, git-sync fixer dispatch, release-fixer) refuses a harness outside it with scope_denied and ledgers the refusal; the admission promoter and drain sweeps hold out-of-scope rows.',
        safeAction:
          'Work only the listed harnesses — an out-of-scope claim or launch is refused, never queued. If the confinement is wrong, widen it with workspace:work_scope { op:"set" } (audited) or lift it with { op:"clear" }.',
      },
      off: {
        meaning:
          'A policy row exists but confines nothing — mode off, or an enforce row whose allow-list is empty — so every gate is inert (fail-open, byte-identical to no policy).',
        safeAction:
          'Nothing is being refused. If confinement was intended, re-set the policy with mode enforce and a non-empty allow-list.',
      },
      absent: {
        meaning:
          'No policy row is stored: every gate is one cached read returning allowed — byte-identical to before the policy shipped (D-001).',
        safeAction:
          'Nothing to do unless the owner wants agents confined — then workspace:work_scope { op:"set", mode:"enforce", allowHarnesses:[…], reason }.',
      },
    },
    evidence: ['enforced', 'allowHarnesses'],
  },

  nullable: false,
  whyTotal:
    'readWorkScopePolicy() returns a value or throws: a missing or malformed row is coerced to null by the same coercePolicy every gate uses and read as `absent` — a MEASURED state, never a default standing in for a failed read — while a thrown read surfaces on the dispatch as resolver-failed, not as a code.',

  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      "readWorkScopePolicy() — the operator_pot_control_policy row's `workScope` key, the one store every dispatch gate reads through the pot-control cache — projected by buildWorkScopeStatusPayload()",
    liveExercised: true,
    evidence:
      "workspace:work_scope { op:'get' } on :3170 at 2026-09-05T02:41Z returned mode enforce / allowHarnesses ['papercusp'] / ledger denied≥1 rehomed 5, and the independent acceptance grade EI-22392650507748189 re-read the same row live (ledger denied 3). The cell itself: state:read { cell:'workspace.workScope' } on :3170 at 2026-09-05T14:52Z (WI-2145092) returned value 'enforce', assessment enforce with evidence enforced=true / allowHarnesses=['papercusp'], and workspace:work_scope_status on the same host returned ledger denied 4 / held 0 / rehomed 5.",
  },

  resolver:
    'buildWorkScopeStatusPayload(readWorkScopePolicy()) @ packages/operator-core/lib/work-scope-policy.ts — via workspace:work_scope_status (agent-tools/pot/work-scope-status.ts)',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'workspace:work_scope_status', path: 'mode' },
  shape:
    '{ mode, enforced, allowHarnesses[], exceptions, setBy, reason, updatedAt, ledger: { counts: { denied, held, rehomed }, recent[] }, assessments: { policy } }',
};

/**
 * `owner.directive.status` — P-007 of directive-visibility-and-ownership-2026-09-22.
 *
 * WHY THIS CELL EXISTS, ON A NARROWER RATIONALE THAN FIRST WRITTEN. The turn-start
 * Orientation banner re-runs `populate()` every turn, so it does NOT need a cell for
 * freshness — the banner is already current when it renders. What the banner cannot
 * do is answer the question that arises LATER IN THE SAME TURN: you read "unclaimed,
 * addressed to another session" at turn start, spent several minutes deciding, and
 * are now about to act. Has a peer claimed it in between? That mid-turn ACTION-time
 * re-read is the whole job here, and it is exactly the class of value CLAUDE.md warns
 * against transcribing: one that changes under you inside a single turn.
 *
 * ONE DERIVATION, TWO DOORS. The resolver is `orders:get`, which calls the SAME
 * `deriveDirectiveStatus(row, linkedWorkItems)` the renderer calls. Registering a
 * second derivation here would reintroduce precisely the defect P-006 removed: two
 * independently-tracked readings of one directive that nothing reconciles.
 */
export const OWNER_DIRECTIVE_STATUS_CELL: CellSpec = {
  cell: 'owner.directive.status',
  registeredOn: '2026-09-22',
  owner: 'su-9390fc63-26a0-46a9-95d1-805705cc5e2d',
  headline: 'directive.status.kind',

  /**
   * D-038: the assessment must say what the measurement MEANS, so its path is
   * DELIBERATELY NOT the headline. These four codes are exactly the distinctions
   * the bare `kind` cannot make, and each one changes what the reader does next.
   * 'worked-awaiting-disposition' is the measured D-007 shape that must not render
   * as an imperative: worked-but-never-dispositioned work reads as "nobody started
   * this". (A fifth code, 'settled-capture-lagging', was retired with the capture
   * triage by owner-directive-delivery-redesign-2026-09-22.)
   */
  assessment: {
    path: 'assessments.directiveStatus',
    codes: {
      'open-unworked': {
        meaning:
          'Unclaimed with NO linked work-item ever. The DEFAULT at capture and the most important bucket to render (D-005) — never a degenerate case.',
        safeAction:
          'Addressed to you ⇒ carry it out. Addressed to another session ⇒ yours to SEE, not to resolve: take it by binding a work-item first, work_items:create { directiveRef } or work_items:claim { directiveRef }.',
      },
      'worked-awaiting-disposition': {
        meaning:
          'Still `unclaimed`, but ONLY because every linked work-item is terminal and no disposition was ever recorded. Work happened; nobody closed the loop.',
        safeAction:
          'Do NOT re-do the work — read the terminal items in `activeWorkItemIds`\'s siblings first. The honest next step is orders:disposition, not a fresh attempt.',
      },
      'in-flight': {
        meaning:
          'A non-terminal work-item carrying this directive_ref is held. `holders` names who, `activeWorkItemIds` names which.',
        safeAction:
          'Awareness only — do NOT start parallel work. If you are not in `holders`, coordinate through the named work-item instead of re-deriving the task.',
      },
      settled: {
        meaning: 'Terminal: a disposition (done or declined) was recorded.',
        safeAction: 'Nothing is owed. Render it in NO imperative bucket.',
      },
    },
    evidence: ['directiveUnknown'],
  },

  /** TRUE: `orders:get` answers `ok:false, error:'not_found'` for an id that does not
   *  exist in this workspace, so the declared headline path is genuinely absent. The
   *  hoist is what stops that absence reading as "this directive has no status". */
  nullable: true,
  unknownHoist: 'directiveUnknown',

  /** Axis 3. Relative to WHICH DIRECTIVE you are asking about. The VERDICT itself is
   *  workspace-global — two sessions reading the same id get the same kind — but
   *  `holders` is what makes it actionable, and that is only meaningful per-id. */
  callerRelativity: { kind: 'parameter', param: 'id' },

  provenance: {
    obtainedBy:
      "the orders:get handler — deriveDirectiveStatus(row, listWorkItemsByDirective(workspaceId, [id])) @ packages/operator-core/lib/owner-directive-status.ts, the same pure function the turn-start renderer calls",
    liveExercised: true,
    evidence:
      'Measured 2026-09-22 on the author\'s own queue (D-007): directives #86 and #87 carried dispositionStatus=done AND captureStatus=pending simultaneously, and kept rendering "[DUE] … promote or dismiss" indefinitely because the two inputs were tracked independently. This derivation is what reconciles them.',
  },

  resolver: 'deriveDirectiveStatus() @ packages/operator-core/lib/owner-directive-status.ts, via the orders:get handler',

  /** Directives are owner speech recorded per workspace; every coord reader in the
   *  workspace already sees them through orders:list (D-004 — LABEL, never filter). */
  visibility: { kind: 'workspace' } as const,
  federation: { kind: 'local' },

  changeSignal: { kind: 'poll', tool: 'orders:get', path: 'directive.status.kind' },

  shape:
    '{ kind: unclaimed|claimed|done|declined, claimedBy?, holders[], activeWorkItemIds[], workedButUndispositioned }',
};

export const BUILTIN_CELLS: CellSpec[] = [
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  GATE_CANDIDATE_FAILURES_CELL,
  GATE_CONVERGENCE_CELL,
  GATE_FREEZE_DISPOSITION_CELL,
  GATE_OWNER_BRIEF_CELL,
  GATE_QUALIFICATION_CELL,
  GATE_RETRIAGE_CELL,
  GATE_OWNERSHIP_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
  HOST_MEMORY_PRESSURE_CELL,
  MEMORY_CGROUP_ATTRIBUTION_CELL,
  AGENT_GOAL_CELL,
  GOAL_PORTFOLIO_THROUGHPUT_CELL,
  TESTING_CENSUS_POPULATION_CELL,
  TESTING_COVERAGE_FLOOR_CELL,
  GOVERNOR_HEALTH_CELL,
  GOVERNOR_ADMISSION_CELL,
  GOVERNOR_QUEUE_CELL,
  GOVERNOR_RESOURCES_CELL,
  GOVERNOR_RECOVERY_CELL,
  LSP_ADMISSION_CELL,
  LSP_WARM_SERVERS_CELL,
  LSP_READINESS_CELL,
  CAPACITY_VERDICT_CELL,
  ROLE_LAUNCH_CELL,
  WORK_SCOPE_CELL,
  OWNER_DIRECTIVE_STATUS_CELL,
];

/** Register every built-in cell. Idempotent — safe to call from more than one entry
 *  point, since re-registering an identical resolver is a no-op in the registry. */
export function registerBuiltinCells(): void {
  for (const spec of BUILTIN_CELLS) registerCell(spec);
}
