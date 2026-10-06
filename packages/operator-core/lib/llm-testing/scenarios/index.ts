/**
 * Scenario registry — every scenario the framework knows about.
 *
 * Phase 1 ships S01, S02, S08. Phase 2 fills in S03–S12 per
 * plan §10.2. Some scenarios have caveats:
 *   - S04 (cap-time): ledger-assert only; brain time naturally
 *                     enforces the cap.
 *   - S07 (passive):  requires realWorkspace + the pref flipped.
 *   - S11 (voice):    text path with modality='voice'; a real voice
 *                     transport test is a future VoiceTarget.
 *   - S12 (errors):   natural error path (lookup of non-existent
 *                     entity). The deterministic-injection version
 *                     waits on brain-subprocess override plumbing.
 */

import type { Scenario } from '@papercusp/testing-shell/llm';
import { S01_STATUS_QUICK } from './operator/S01-status-quick';
import { S02_MULTISTEP_INVESTIGATION } from './operator/S02-multistep-investigation';
import { S03_CONTINUE_CAP_COUNT } from './operator/S03-continue-cap-count';
import { S04_CONTINUE_CAP_TIME } from './operator/S04-continue-cap-time';
import { S05_SLEEP_TAG } from './operator/S05-sleep-tag';
import { S06_SPAWN_WORKER } from './operator/S06-spawn-worker';
import { S07_PASSIVE_MODE } from './operator/S07-passive-mode';
import { S08_SILENCE_NUDGE_READY } from './operator/S08-silence-nudge-ready';
import { S09_GENERATE_IDEAS } from './operator/S09-generate-ideas';
import { S10_ASK_CHOICE } from './operator/S10-ask-choice';
import { S11_VOICE_CARD_ANSWER } from './operator/S11-voice-card-answer';
import { S12_TOOL_ERROR_RECOVERY } from './operator/S12-tool-error-recovery';
import { S12B_TOOL_ERROR_INJECTED } from './operator/S12b-tool-error-injected';
// S13–S16: voice-production-test-coverage-2026-06-01 (P-019, voice-mode brain behaviors)
import { S13_VOICE_TERSE_COMPLEX } from './operator/S13-voice-terse-complex';
import { S14_VOICE_NO_CODE } from './operator/S14-voice-no-code';
import { S15_VOICE_ERROR_RECOVERY } from './operator/S15-voice-error-recovery';
import { S16_VOICE_DISAMBIGUATION } from './operator/S16-voice-disambiguation';
// SN01–SN02: sentinel-as-claude-tui-2026-06-22 — the voice→Sentinel→Mug
// handoff path (role='sentinel' converse brain, `sentinel` target).
import { SN01_HANDOFF_PLANNING_ASK } from './papercup/SN01-handoff-planning-ask';
import { SN02_NO_HANDOFF_TRIVIAL } from './papercup/SN02-no-handoff-trivial';
import { mirrorForSentinel } from './papercup/_mirror';
// P2 hive-knowledge scenarios (sentinel-voice-flow-testing): real questions about
// the live papercusp hive, judged for grounded/tool-backed answers.
import { SN_H01_FLEET_STATUS } from './papercup/SN-H01-fleet-status';
import { SN_H02_PLANS_AND_BLOCKED } from './papercup/SN-H02-plans-and-blocked';
import { SN_H03_MUG_EXPLAINER } from './papercup/SN-H03-mug-explainer';
import { SN_H04_ASSIGN_TO_MUG } from './papercup/SN-H04-assign-to-mug';
// P3 handoff-depth scenarios (sentinel-voice-flow-testing).
import { SN_H05_URGENT_HANDOFF } from './papercup/SN-H05-urgent-handoff';
import { SN_H06_RESPECT_NO_HANDOFF } from './papercup/SN-H06-respect-no-handoff';
import { SN_H07_MULTI_ITEM_HANDOFF } from './papercup/SN-H07-multi-item-handoff';
// SN-D01–D02: voice-unified-sentinel-pipeline-2026-07-01 P-007 — the D-003
// three-way routing split (answer now / delegate_deep thinking / handoff work).
import { SN_D01_DELEGATE_HARD_THINKING } from './papercup/SN-D01-delegate-hard-thinking';
import { SN_D02_WORK_NOT_DELEGATED } from './papercup/SN-D02-work-not-delegated';
import { SN_D03_EXISTING_DELEGATION_STATUS } from './papercup/SN-D03-existing-delegation-status';
// M1–M12: operator-behavior-tests-2026-05-14 (brain-emission contracts)
import { M1_CONTINUE_PAIRED_WITH_SAY } from './operator/M1-continue-paired-with-say';
import { M2_MUTEX_CARD_VS_CONTINUE } from './operator/M2-mutex-card-vs-continue';
import { M3_OPENER_SUBSTANCE } from './operator/M3-opener-substance';
import { M4_ONE_QUESTION_PER_TURN } from './operator/M4-one-question-per-turn';
import { M5_SPAWN_WORKER_HAS_CHUNK } from './operator/M5-spawn-worker-has-chunk';
import { M6_SLEEP_NO_SAY } from './operator/M6-sleep-no-say';
import { M7_AFTER_SAYS_READY_OPTIONS } from './operator/M7-after-says-ready-options';
import { M8_FORMAT_UTTERANCE } from './operator/M8-format-utterance';
// (M9-panel-close-tool removed — the operator-card panel + panel_* verbs were
// retired with the scanner card stream, unify-agent-launches D-005.)
import { M10_IDEAS_NOT_OPERATORS } from './operator/M10-ideas-not-operators';
import { M11_NO_IMPLEMENTATION_ASKS } from './operator/M11-no-implementation-asks';
import { M12_NO_STACKED_QUESTIONS_PROSE } from './operator/M12-no-stacked-questions-prose';
import { O1_DOCS_QUESTION } from './oracle/O1-docs-question';
import { O2_REFUSE_SPECULATION } from './oracle/O2-refuse-speculation';
import { O3_HARNESS_QUESTION } from './oracle/O3-harness-question';
import { A1_CLARIFYING_QUESTIONS } from './architect/A1-clarifying-questions';
import { A2_SCOPE_PUSHBACK } from './architect/A2-scope-pushback';
import { A3_REJECT_THEN_REFINE } from './architect/A3-reject-then-refine';
import { A4_NO_HALLUCINATED_PLAN_ITEMS } from './architect/A4-no-hallucinated-plan-items';
import { A5_TRADEOFF_EXPLANATION } from './architect/A5-tradeoff-explanation';
import { A6_NO_SPEC_WITHOUT_READING } from './architect/A6-no-spec-without-reading';
import { O4_NO_TOOL_USE_FOR_SIMPLE_FACT } from './oracle/O4-no-tool-use-for-simple-fact';
import { O5_HARNESS_SCOPED_ANSWER } from './oracle/O5-harness-scoped-answer';
import { O6_GRACEFUL_NOT_FOUND } from './oracle/O6-graceful-not-found';
// MEM00–MEM10: T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009)
import { MEM00_CONTROL_UNSEEDED } from './memory/MEM00-control-unseeded';
import { MEM01_STAGING_PROBE_PORT } from './memory/MEM01-staging-probe-port';
import { MEM02_RELAY_SALT_ENV } from './memory/MEM02-relay-salt-env';
import { MEM03_MIGRATION_RANGE } from './memory/MEM03-migration-range';
import { MEM04_FLAKY_ISOLATE_FLAG } from './memory/MEM04-flaky-isolate-flag';
import { MEM05_SIGNALING_OWNER } from './memory/MEM05-signaling-owner';
import { MEM06_SHOP_CDN_CHECK } from './memory/MEM06-shop-cdn-check';
import { MEM07_COLUMN_RENAME } from './memory/MEM07-column-rename';
import { MEM08_TTS_ROTATION } from './memory/MEM08-tts-rotation';
import { MEM09_MIC_DEVICE } from './memory/MEM09-mic-device';
import { MEM10_EXPLICIT_SEARCH } from './memory/MEM10-explicit-search';
// SU-S01–S06: su-scenario-suite-2026-05-31 (engineer-collaborator playbook behavioral coverage)
import { SU_S01_HARNESS_SCOPE } from './su/S01-harness-scope';
import { SU_S02_TAURI_ONLY } from './su/S02-tauri-only';
import { SU_S03_PUSH_NOT_POLL } from './su/S03-push-not-poll';
import { SU_S04_DESIGN_FIRST } from './su/S04-design-first';
import { SU_S05_NO_INVENT_WRITE } from './su/S05-no-invent-write';
import { SU_S06_SHARED_TREE_GIT } from './su/S06-shared-tree-git';
// SU-S07: keyed lifecycle write after set_state terminal-evidence schema update;
// SU-S08: token-efficient-agent-io compact-read gate.
import { SU_S07_KEYED_WRITE } from './su/S07-keyed-write';
import { SU_S08_COMPACT_READ } from './su/S08-compact-read';
// SU-S09: token-efficient-coord-injection P-011 — positional [coord+N] read gate
import { SU_S09_COORD_INJECTION_READ } from './su/S09-coord-injection-read';
// SU-S10: claim-discipline-enforcement-2026-06-10 P-006 — claim-before-work gate
import { SU_S10_CLAIM_BEFORE_WORK } from './su/S10-claim-before-work';
// SU-S11: coord-system-e2e-testing-2026-06-10 P-011 — same-file lock-contention protocol gate
import { SU_S11_LOCK_CONTENTION_PROTOCOL } from './su/S11-lock-contention-protocol';
// SU-S12: same-turn insight capture (agent policies §19 timing rule; EI-328/EI-329)
import { SU_S12_SAME_TURN_INSIGHT } from './su/S12-same-turn-insight';
// SU-S13/S14: code-execution-tool-orchestration B-CX-3 — does the engineer REACH for code:run on a
// "do X for each of N" loop (S13), and NOT over-apply it to a single call (S14)?
import { SU_S13_CODE_RUN_BATCH } from './su/S13-code-run-batch';
import { SU_S14_CODE_RUN_NOT_FOR_SINGLE } from './su/S14-code-run-not-for-single';
import { SU_S15_CODE_RUN_SMALL_BATCH } from './su/S15-code-run-small-batch';
import { SU_S16_CODE_RUN_BATCH_WRITE } from './su/S16-code-run-batch-write';
// SU-S17–S20: tool-call-batching-wrappers-2026-06-21 P-008 — does the engineer REACH for the compound
// wrappers (coord:orient S17, harness:overview S19) and NOT over-apply them to a single call (S18/S20)?
import { SU_S17_ORIENT_BOOTSTRAP } from './su/S17-orient-bootstrap';
import { SU_S18_ORIENT_NOT_FOR_SINGLE } from './su/S18-orient-not-for-single';
import { SU_S19_OVERVIEW_STATE_OF_X } from './su/S19-overview-state-of-x';
import { SU_S20_OVERVIEW_NOT_FOR_SINGLE } from './su/S20-overview-not-for-single';
// SU-S21/S22: bulk-endpoint-standardization-2026-06-21 P-007 — does the engineer REACH for the
// dual-arity bulk READ arg on N items (S21: one work_items:get { ids:[…] } over a per-id loop)
// and NOT over-apply it on a single known id (S22: the n=1 scalar form, no queue browse)?
import { SU_S21_BULK_READ_NOT_HAND_LOOP } from './su/S21-bulk-read-not-hand-loop';
import { SU_S22_BULK_NOT_FOR_SINGLE } from './su/S22-bulk-not-for-single';
// SU-S23–S25: agent-tool-delta-protocol-2026-06-22 P-007 (Lane C de-risk gate) — the
// LLM-facing semantic-delta merge contract: correct merge with base present (S23),
// fallback to a full re-fetch when the base was compacted away (S24, uses the P-006
// compaction seam), and the silently-wrong-merge detector (S25). Gates the production flag flip.
import { SU_S23_DELTA_MERGE_BASE_PRESENT } from './su/S23-delta-merge-base-present';
import { SU_S24_DELTA_FALLBACK_COMPACTED } from './su/S24-delta-fallback-compacted';
import { SU_S25_DELTA_WRONG_MERGE_DETECTOR } from './su/S25-delta-wrong-merge-detector';
// SU-S26: behavioral test for the "never wait for a calm window / take charge" policy's
// STALLED-DEPENDENCY clause — the agent must FORCE a stalled git-sync/pipeline, not wait/punt.
import { SU_S26_TAKE_CHARGE_DONT_WAIT } from './su/S26-take-charge-dont-wait';
// SU-S27: fleet-dispatch-wake-clarity P-003 — a woken agent that finds a DIRECTED dispatch in its
// inbox must CLAIM + WORK the lane this turn, never read-and-repark (the su-6ef6 black-hole).
import { SU_S27_WOKE_TO_DISPATCH_CLAIMS } from './su/S27-woke-to-dispatch-claims';
// SU-S28/S29: su-ideate-learning-substrate-2026-07-10 P-015 — the IDEATE + GRADE mode-batteries.
// S28: an IDEATE pass runs CLOSED (ground on prior art → file lens-tagged → close with a tick).
// S29: a GRADE-mode low grade + critique on a (peer-authored) su idea wakes the originator (woken:1).
import { SU_S28_IDEATE_PASS_CLOSES_LOOP } from './su/S28-ideate-pass-closes-loop';
import { SU_S29_GRADE_LOW_WAKES_ORIGINATOR } from './su/S29-grade-low-wakes-originator';
// SU-S30: unconditional-bug-filing-prompt-hardening-2026-07-11 — a suspected bug (INCLUDING a
// false-alarm / self-recovered / "transient" signal) is FILED unconditionally, not a judgment call.
import { SU_S30_BUG_FILING_UNCONDITIONAL } from './su/S30-bug-filing-unconditional';
// SU-S32: audit-mode-2026-09-01 P-005 — "go into audit mode on <scope>" must produce a
// WHOLE-PROGRAM audit (lifecycle census, ledger cross-check, churn, liveness, mechanisms) and
// route remediation, not an item-by-item status read or a drive-by fix.
import { SU_S32_AUDIT_MODE_WHOLE_PICTURE } from './su/S32-audit-mode-whole-picture';
import { SU_S33_GOAL_AGENDA } from './su/S33-goal-agenda';
import { SU_S34_BEHAVIOR_GRADER } from './su/S34-behavior-grader-discipline';
import { SU_S35_COMPLETION_RESIDUE } from './su/S35-completion-residue-discipline';
import { SU_S36_DRAIN_CLAIMS_ONLY_AGENT_WORK } from './su/S36-drain-claims-only-agent-work';
import { SU_S37_CODE_SEARCH } from './su/S37-code-search-discipline';
import { WORKER_W01_CODE_SEARCH } from './worker/W01-code-search-discipline';
// SU-S31a/b/c: agent-protocol-authority-semantics-2026-07-26 P-011 — the information-asymmetry
// experiment. THREE matched arms over one identical task, differing only in how a peer's handoff
// conveys the same three facts: (a) control, status-quo Did/Left/Next; (b) prose-equal, same facts
// unstructured; (c) the labeled knownToMe / couldNotDetermine field. b-vs-c isolates the FIELD's
// structure (information held constant) — a two-arm a-vs-c test would only show that telling a
// successor more helps. Design + pre-registered decision rule: ./su/_S31-asymmetry-world.ts.
import { SU_S31A_ASYMMETRY_CONTROL } from './su/S31a-asymmetry-control';
import { SU_S31B_ASYMMETRY_PROSE } from './su/S31b-asymmetry-prose';
import { SU_S31C_ASYMMETRY_FIELD } from './su/S31c-asymmetry-field';
// SU-S31d: added after the A/B/C result, testing auto-derived provenance (`basedOn`) — a
// different MECHANISM from B/C, which both require the sender to curate. Not part of the
// pre-registered A/B/C rule; see ./su/S31d-asymmetry-provenance.ts.
import { SU_S31D_ASYMMETRY_PROVENANCE } from './su/S31d-asymmetry-provenance';
// QUEEN-Q01..Q04 (./mug) and BEE-B01/B02 (./cup) were HERE and are retired to
// `_retired/mug-kettle-deciders/…/llm-testing/scenarios/` — retire-mug-kettle-su-only-2026-08-09
// D-112, extending D-060. Each asserted a behavior of the Mug's or the cup's own spawn
// prompt (grade routed drafts on triage, decide the ranked queue, author a claim spec,
// pull via scheduler:get_next). That tier is permanently retired — MUG_KETTLE_SYSTEM is
// deleted and `mugKettleSystemEnabled()` is a constant false — so the personas under test
// cannot be spawned and their actuators refuse.
//
// The BEHAVIORS mostly did not die with the persona; they moved to su/Scout. If one of
// these is worth keeping, re-author it against the `su` target rather than restoring it
// here — a scenario aimed at an unreachable decision-maker cannot fail informatively.
// OVERWATCH-OW01/OW02: overwatch-role-2026-06-15 B-11 — the system-health
// supervisor's persona boundaries: NUDGE-not-replace (D-001) + OBSERVE-not-idea (D-003).
import { OVERWATCH_OW01_NUDGE_NOT_REPLACE } from './overwatch/OW01-nudge-not-replace';
import { OVERWATCH_OW02_OBSERVE_NOT_IDEA } from './overwatch/OW02-observe-not-idea';
// OT1–OT3: agent-first-onboarding-2026-07-03 P-008 — the onboarding tutor's
// launch-context behaviors: section protocol, checkpoint-as-you-go, detour return.
import { OT1_SECTION_PROTOCOL } from './onboarding-tutor/OT1-section-protocol';
import { OT2_PROGRESS_CHECKPOINT } from './onboarding-tutor/OT2-progress-checkpoint';
import { OT3_QUESTION_DETOUR } from './onboarding-tutor/OT3-question-detour';
// PUI-LOOP-P01: pui-remote-shared-substrate P-005 / R11 — the new prompt
// profile is a first-class llm-test target and uses its owned capability door.
import { PUI_LOOP_P01_OWNED_DOOR_READ } from './pui-loop/P01-owned-door-read';

export const SCENARIOS: ReadonlyArray<Scenario> = [
  // operator (S01–S12)
  S01_STATUS_QUICK,
  S02_MULTISTEP_INVESTIGATION,
  S03_CONTINUE_CAP_COUNT,
  S04_CONTINUE_CAP_TIME,
  S05_SLEEP_TAG,
  S06_SPAWN_WORKER,
  S07_PASSIVE_MODE,
  S08_SILENCE_NUDGE_READY,
  S09_GENERATE_IDEAS,
  S10_ASK_CHOICE,
  S11_VOICE_CARD_ANSWER,
  S12_TOOL_ERROR_RECOVERY,
  S12B_TOOL_ERROR_INJECTED,
  // operator voice-mode brain behaviors (S13–S16, P-019)
  S13_VOICE_TERSE_COMPLEX,
  S14_VOICE_NO_CODE,
  S15_VOICE_ERROR_RECOVERY,
  S16_VOICE_DISAMBIGUATION,
  // sentinel voice→Mug handoff path (SN01–SN02)
  SN01_HANDOFF_PLANNING_ASK,
  SN02_NO_HANDOFF_TRIVIAL,
  // sentinel P2 hive-knowledge (real questions about the live hive)
  SN_H01_FLEET_STATUS,
  SN_H02_PLANS_AND_BLOCKED,
  SN_H03_MUG_EXPLAINER,
  SN_H04_ASSIGN_TO_MUG,
  // sentinel P3 handoff-depth
  SN_H05_URGENT_HANDOFF,
  SN_H06_RESPECT_NO_HANDOFF,
  SN_H07_MULTI_ITEM_HANDOFF,
  // deep-delegation routing split (SN-D01–D02)
  SN_D01_DELEGATE_HARD_THINKING,
  SN_D02_WORK_NOT_DELEGATED,
  SN_D03_EXISTING_DELEGATION_STATUS,
  // Phase 1 (sentinel-voice-flow-testing): operator chat-hygiene contracts
  // mirrored onto the SENTINEL brain (same role-keyed converse) so the voice
  // front-door upholds the same voice/question/format discipline. Single source
  // — see ./sentinel/_mirror.
  ...[
    S10_ASK_CHOICE,
    S11_VOICE_CARD_ANSWER,
    S13_VOICE_TERSE_COMPLEX,
    S14_VOICE_NO_CODE,
    S15_VOICE_ERROR_RECOVERY,
    S16_VOICE_DISAMBIGUATION,
    M4_ONE_QUESTION_PER_TURN,
    M8_FORMAT_UTTERANCE,
  ].map(mirrorForSentinel),
  // operator brain-emission contracts (M1–M12)
  M1_CONTINUE_PAIRED_WITH_SAY,
  M2_MUTEX_CARD_VS_CONTINUE,
  M3_OPENER_SUBSTANCE,
  M4_ONE_QUESTION_PER_TURN,
  M5_SPAWN_WORKER_HAS_CHUNK,
  M6_SLEEP_NO_SAY,
  M7_AFTER_SAYS_READY_OPTIONS,
  M8_FORMAT_UTTERANCE,
  M10_IDEAS_NOT_OPERATORS,
  M11_NO_IMPLEMENTATION_ASKS,
  M12_NO_STACKED_QUESTIONS_PROSE,
  // oracle (O1–O6) — Phase 4 abstraction validation + P-027 expansion
  O1_DOCS_QUESTION,
  O2_REFUSE_SPECULATION,
  O3_HARNESS_QUESTION,
  O4_NO_TOOL_USE_FOR_SIMPLE_FACT,
  O5_HARNESS_SCOPED_ANSWER,
  O6_GRACEFUL_NOT_FOUND,
  // architect (A1–A6) — third target, harness-scoped + P-027 expansion
  A1_CLARIFYING_QUESTIONS,
  A2_SCOPE_PUSHBACK,
  A3_REJECT_THEN_REFINE,
  A4_NO_HALLUCINATED_PLAN_ITEMS,
  A5_TRADEOFF_EXPLANATION,
  A6_NO_SPEC_WITHOUT_READING,
  // operator T4 boot-recall tier (MEM00 control + MEM01–MEM10;
  // memory-backend-benchmark-2026-06-05 P-009)
  MEM00_CONTROL_UNSEEDED,
  MEM01_STAGING_PROBE_PORT,
  MEM02_RELAY_SALT_ENV,
  MEM03_MIGRATION_RANGE,
  MEM04_FLAKY_ISOLATE_FLAG,
  MEM05_SIGNALING_OWNER,
  MEM06_SHOP_CDN_CHECK,
  MEM07_COLUMN_RENAME,
  MEM08_TTS_ROTATION,
  MEM09_MIC_DEVICE,
  MEM10_EXPLICIT_SEARCH,
  // su engineer-collaborator playbook behavioral coverage (su-scenario-suite-2026-05-31)
  SU_S01_HARNESS_SCOPE,
  SU_S02_TAURI_ONLY,
  SU_S03_PUSH_NOT_POLL,
  SU_S04_DESIGN_FIRST,
  SU_S05_NO_INVENT_WRITE,
  SU_S06_SHARED_TREE_GIT,
  SU_S07_KEYED_WRITE,
  SU_S08_COMPACT_READ,
  SU_S09_COORD_INJECTION_READ,
  SU_S10_CLAIM_BEFORE_WORK,
  SU_S11_LOCK_CONTENTION_PROTOCOL,
  SU_S12_SAME_TURN_INSIGHT,
  SU_S13_CODE_RUN_BATCH,
  SU_S14_CODE_RUN_NOT_FOR_SINGLE,
  SU_S15_CODE_RUN_SMALL_BATCH,
  SU_S16_CODE_RUN_BATCH_WRITE,
  SU_S17_ORIENT_BOOTSTRAP,
  SU_S18_ORIENT_NOT_FOR_SINGLE,
  SU_S19_OVERVIEW_STATE_OF_X,
  SU_S20_OVERVIEW_NOT_FOR_SINGLE,
  SU_S21_BULK_READ_NOT_HAND_LOOP,
  SU_S22_BULK_NOT_FOR_SINGLE,
  // su delta-protocol Lane-C de-risk gate (agent-tool-delta-protocol-2026-06-22 P-007)
  SU_S23_DELTA_MERGE_BASE_PRESENT,
  SU_S24_DELTA_FALLBACK_COMPACTED,
  SU_S25_DELTA_WRONG_MERGE_DETECTOR,
  // behavioral test for the take-charge / never-wait-on-a-stalled-dependency policy
  SU_S26_TAKE_CHARGE_DONT_WAIT,
  SU_S27_WOKE_TO_DISPATCH_CLAIMS,
  // su-ideate learning-loop mode-batteries (su-ideate-learning-substrate-2026-07-10 P-015)
  SU_S28_IDEATE_PASS_CLOSES_LOOP,
  SU_S29_GRADE_LOW_WAKES_ORIGINATOR,
  // unconditional bug-filing hardening (unconditional-bug-filing-prompt-hardening-2026-07-11)
  SU_S30_BUG_FILING_UNCONDITIONAL,
  // AUDIT mode behaves as a whole-program audit (audit-mode-2026-09-01)
  SU_S32_AUDIT_MODE_WHOLE_PICTURE,
  ...SU_S33_GOAL_AGENDA,
  ...SU_S34_BEHAVIOR_GRADER,
  ...SU_S35_COMPLETION_RESIDUE,
  // P-012 (enterprise-data-sources-2026-10-01): a drain claims only agent work
  SU_S36_DRAIN_CLAIMS_ONLY_AGENT_WORK,
  // S37 / W01 code-search discipline (gitnexus-deterministic-integration-2026-10-05 P-015)
  ...SU_S37_CODE_SEARCH,
  ...WORKER_W01_CODE_SEARCH,
  SU_S31A_ASYMMETRY_CONTROL,
  SU_S31B_ASYMMETRY_PROSE,
  SU_S31C_ASYMMETRY_FIELD,
  SU_S31D_ASYMMETRY_PROVENANCE,
  // (QUEEN_Q01..Q04 + BEE_B01/B02 retired here — see the import block above, D-112.)
  // overwatch persona-boundary coverage (overwatch-role-2026-06-15 B-11)
  OVERWATCH_OW01_NUDGE_NOT_REPLACE,
  OVERWATCH_OW02_OBSERVE_NOT_IDEA,
  // onboarding-tutor launch-context coverage (agent-first-onboarding-2026-07-03 P-008)
  OT1_SECTION_PROTOCOL,
  OT2_PROGRESS_CHECKPOINT,
  OT3_QUESTION_DETOUR,
  // pui-loop profile behavioral smoke (R11)
  PUI_LOOP_P01_OWNED_DOOR_READ,
];

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((sc) => sc.id === id);
  if (!s) {
    throw new Error(
      `Unknown scenario id '${id}'. Available: ${SCENARIOS.map((sc) => sc.id).join(', ')}`,
    );
  }
  return s;
}

export function getScenariosForTarget(target: string): Scenario[] {
  return SCENARIOS.filter((s) => s.target === target);
}

export function listScenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}
