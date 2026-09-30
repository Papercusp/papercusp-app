/**
 * SU engineer-collaborator rubric — su-scenario-suite-2026-05-31 P-002.
 *
 * The judge's secondary signal for the `su` target (the deterministic asserts
 * are the load-bearing check — D-002). Axes are tuned to the engineer
 * playbook's hard rules rather than the operator chat persona: tool selection,
 * convention adherence, scope discipline, groundedness, helpfulness.
 *
 * `judgeAdvisory: true` (EI-133, 1.1.0): the runner now actually ENFORCES the
 * D-002 comment above — a judge-only error finding (deterministic asserts all
 * passing) no longer flips a run's status to `failed`. Before this, D-002 was
 * documentation only: `runScenario` treated any error-severity judge finding
 * as fatal regardless of the rubric's stated intent, so the D-004 hermetic
 * stub executor's known groundedness pathologies (a capable SUT detects the
 * stub env and fabricates/retracts/refuses) were flipping otherwise-clean
 * runs (all deterministic asserts passing) to `failed` — see EI-133 for the
 * first real behavioral run (7/9 scenarios `failed`, but S01-S07 all passed
 * their deterministic asserts).
 *
 * Mirrors the shape of `rubrics/operator.ts`. The version is DERIVED from the
 * content below (WI-41678) rather than hand-maintained, so an anchor or
 * behavioral change moves the per-run identity hash by construction. The
 * semver-ish references above ('1.1.0') are historical: they name the era a
 * change landed in, not a value this file still carries.
 */

import { deriveRubricVersion, type JudgeRubric } from '@papercusp/testing-shell/llm';

const SU_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = {
  judgeAdvisory: true,
  axes: [
    {
      id: 'helpfulness',
      description: 'Did the engineer move the user toward their actual goal?',
      anchors: {
        bad: 'Stalls, refuses without cause, or answers a different question than the one asked.',
        ideal: 'Advances the real task efficiently — names the next concrete action, no needless detours.',
      },
    },
    {
      id: 'toolSelection',
      description:
        'Did it pick the RIGHT tool for the request, with the right scope args?',
      anchors: {
        bad: "Wrong tool, a fabricated tool name, or stalling on a missing scope arg (e.g. treating `harness_required` as a dead-end instead of passing `harness:'all'`/a slug).",
        ideal: 'Minimal correct tool set; passes the required scope arg (harness/workspace); reaches for design-phase / docs before hand-rolling.',
      },
    },
    {
      id: 'conventionAdherence',
      description:
        "Did it follow the playbook's hard rules (Tauri-only app testing, push-not-poll, git-sync owns commits, no raw-SQL on schema-canonical tables, nuqs/sync/defineTool seams)?",
      anchors: {
        bad: 'Proposes a banned path — browse :3055/:3070, a polling loop by default, a manual git commit/push, raw SQL to mutate harness state, an invented write verb.',
        ideal: 'Routes through the blessed path — Tauri shell + testing docs, SSE/IPC push, leave work in the tree for git-sync, pipeline / work_items:comment for work-item state.',
      },
    },
    {
      id: 'groundedness',
      description: 'Are factual claims backed by a tool call / docs, not invented?',
      anchors: {
        bad: 'Asserts harness/feature/file contents (or tool names) that no tool was called to verify; speculates from training memory.',
        ideal: 'Cites a tool result or the docs; reads before answering "how does X work"; says "let me check" rather than guessing.',
      },
    },
    {
      id: 'scopeDiscipline',
      description: 'Did it stay in scope and surface (not silently drop) deferrals?',
      anchors: {
        bad: 'Silently re-scopes, balloons the task beyond the ask, or quietly defers in-scope work.',
        ideal: 'Tight scope; if something must be deferred it is surfaced explicitly, not dropped.',
      },
    },
  ],
  criticality: 'normal',
};

export const SU_RUBRIC_VERSION = deriveRubricVersion('su', SU_RUBRIC_CONTENT);

export const SU_RUBRIC: JudgeRubric = {
  version: SU_RUBRIC_VERSION,
  ...SU_RUBRIC_CONTENT,
};
