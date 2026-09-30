/**
 * Pure decision classifier for the durable feature pipeline
 * (`dbos-retire-legacy-orchestrator-2026-05-31` P-003).
 *
 * Maps a parsed orchestrator decision to a `PipelineAction` the durable
 * workflow loop acts on. Kept free of DBOS / I/O so it's directly unit-testable
 * — the workflow consumes its output, and the side-effectful work (agent runs,
 * finalization) happens behind injected seams.
 *
 * The per-feature `director` (director.md) emits only NEXT_WORKER / NEXT_ARCHITECT
 * / NEXT_VALIDATOR / DONE / ESCALATE, but we classify the FULL verb vocabulary so a
 * stray/legacy verb never dead-ends a pipeline:
 *   - per-feature lifecycle + quality verbs → `dispatch` (run the role, loop)
 *   - DONE/ESCALATE/IDLE/CHECKPOINT → `terminal` (finalize / stop)
 *   - benign global/phase verbs (CONVERTED/FEATURE_FREEZE/READY_FOR_PROD/RUN_TESTS)
 *     → `terminal idle` (stop cleanly; the dispatcher rescans)
 *   - genuinely global-only verbs (NEXT_HARNESS, CEO mode, parallel NEXT_WORKER
 *     N=k) → `unsupported` (warn + stop): lanes / cross-harness are the global
 *     orchestrator's job, deliberately cut from the per-feature model (D-001).
 */
import type { ParsedDecision } from '@papercusp/orchestrator';
// PipelineAction is defined once in the blueprint engine (the `deriveNext`
// interpreter that supersedes this switch in the live pipeline — P-004).
// `classifyDecision` is RETAINED as the golden-reference oracle that
// `derive-next-equivalence.test.ts` checks the `coding` blueprint against, so
// `coding.yaml` can never silently drift from the canonical switch. Imported +
// re-exported so any `./orchestrator-decide` consumer keeps resolving the type.
import type { PipelineAction } from '@papercusp/orchestrator/blueprint';
export type { PipelineAction };

/** Stop cleanly — nothing to do here; the dispatcher will re-scan this feature. */
const STOP_IDLE: PipelineAction = { kind: 'terminal', outcome: 'idle' };

export function classifyDecision(
  parsed: ParsedDecision | null,
  defaultFeature: string,
): PipelineAction {
  // Unparseable / empty decision → stop (the decide step already throws on a
  // truly failed/empty invoke; a non-null-but-unrecognized output lands here).
  if (!parsed) return STOP_IDLE;

  const arg = parsed.arg ?? null;
  const feature = arg ?? defaultFeature;

  switch (parsed.verb) {
    // ── terminal ────────────────────────────────────────────────────────────
    case 'DONE':
      return { kind: 'terminal', outcome: 'done' };
    case 'ESCALATE':
      return { kind: 'terminal', outcome: 'escalate', reason: arg ?? '' };
    case 'IDLE':
      return STOP_IDLE;
    case 'CHECKPOINT':
      // Deprecated — legacy main-loop treats it as ESCALATE (milestone gates are
      // now needs-human plan items).
      return { kind: 'terminal', outcome: 'escalate', reason: arg ?? 'checkpoint (deprecated)' };

    // ── per-feature lifecycle (carry FEATURE_ID, matching the legacy loop) ────
    case 'NEXT_WORKER':
      // Parallel lanes (N=k) are the global orchestrator's job — not per-feature.
      if (parsed.n != null) return { kind: 'unsupported', verb: `NEXT_WORKER N=${parsed.n}` };
      return { kind: 'dispatch', role: 'worker', feature, extras: [`FEATURE_ID=${feature}`] };
    case 'NEXT_VALIDATOR':
      return { kind: 'dispatch', role: 'validator', feature, extras: [`FEATURE_ID=${feature}`] };
    case 'NEXT_ARCHITECT':
      return { kind: 'dispatch', role: 'architect', feature, extras: [`FEATURE_ID=${feature}`] };
    case 'NEXT_SCOPER':
      return { kind: 'dispatch', role: 'scoper', feature, extras: [`FEATURE_ID=${feature}`] };

    // ── quality verbs (role names + extras match the legacy loop) ────
    case 'NEXT_TESTER':
      return { kind: 'dispatch', role: 'tester', feature, extras: [`VAL_ID=${arg ?? ''}`] };
    case 'NEXT_SECURITY':
      return { kind: 'dispatch', role: 'security-reviewer', feature, extras: [] };
    case 'GENERATE_TESTS':
      return { kind: 'dispatch', role: 'test-writer', feature, extras: [] };
    case 'NEXT_MONITOR':
      return { kind: 'dispatch', role: 'monitor', feature, extras: [] };
    // P-013/P-014 — opt-in quality gates. The classifier recognizes + dispatches
    // them; they are DORMANT by default because a harness's director only emits
    // them when it opts in (crosscheck: config-gated; ui-qa: config + a VAL-UI-*
    // claim on the feature). "Wiring ≠ forcing cost" — no consumer, no emission.
    case 'NEXT_CROSSCHECK':
      // A different-model second opinion after a validator PASS; on a `disagree`
      // verdict the feature is reverted passed→failing (handled by the director
      // next turn, per crosscheck.md).
      return { kind: 'dispatch', role: 'crosscheck', feature, extras: [`FEATURE_ID=${feature}`] };
    case 'NEXT_UI_QA':
      // A verdict-tool visual/interaction check on a UI feature (a VAL-UI-* claim).
      return { kind: 'dispatch', role: 'ui-qa', feature, extras: [`FEATURE_ID=${feature}`] };
    // ── benign global / phase verbs → stop this pipeline cleanly ──────────────
    case 'CONVERTED':
    case 'FEATURE_FREEZE':
    case 'READY_FOR_PROD':
    case 'RUN_TESTS':
      return STOP_IDLE;

    // ── global-only verbs the per-feature pipeline deliberately does not run ──
    case 'NEXT_HARNESS':
    case 'NEXT_WORKER_CEO_MODE':
      return { kind: 'unsupported', verb: parsed.verb };

    default: {
      const _exhaustive: never = parsed.verb;
      return { kind: 'unsupported', verb: String(_exhaustive) };
    }
  }
}
