/**
 * High-level role-prompt assembly given a registered harness slug.
 *
 * This is the single source of truth that both autonomous dispatches and
 * chat sessions should use to assemble a role's prompt. It wraps
 * `resolvePromptFile` + `buildPrompt` with the slug → projectDir → config
 * lookup steps, so callers don't repeat that wiring.
 *
 * Today only the chat endpoint calls this directly — the autonomous loop
 * still goes through `run.sh` (which assembles inline). When the bash
 * `invoke()` is replaced by the TS orchestrator's `invoke.ts`, that path
 * should call `assembleRolePrompt` too, eliminating drift between the
 * autonomous and chat prompts.
 *
 * "Mode" is a small flag the prompt assembler can use to add chat-specific
 * runtime context (e.g., "you are responding to a user message; do not
 * commit; write to .papercusp/notes/<feature> if you want the autonomous
 * worker to act on something"). It does NOT swap out the role file —
 * chat-worker is the same agent as autonomous-worker, just talking.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { harnessRoot } from '@papercusp/harness/paths';
import { resolvePhase, configGet } from './config';
import { readEffectiveConfig, loadHarnessAcceptanceKind, loadHarnessLexicon, loadHarnessBlueprintId } from './effective-config';
import { buildPrompt } from './prompt-build';
import { resolvePromptFile, resolvePromptFiles } from './prompt-resolve';

// Re-export the friction trip-wire constant (self-learning-central P-001/A) so the
// operator-brain prompt base (operator-core's renderFrictionTripwire) can reuse the
// SAME string the spawned-bee base emits — the two bases can't desync. Owned by
// prompt-build.ts (where it's injected into buildPrompt); surfaced on this
// already-exported entry so operator-core can import it without a new subpath.
// YIELD_POLICY (turn-lifecycle-control P-017) rides the same already-exported
// entry for the same reason — operator-core's renderYieldPolicy reuses the SAME
// cooperative-yield clause the spawned-bee base emits. TESTING_STANDARD (the
// "write tests the project way" clause) rides it too — operator-core's
// renderTestingStandard reuses the SAME string the spawned-bee base emits.
// ACCOUNT_ROUTING_NOTE (the "inference is multi-account; a 'limit' is usually a
// routing bug" clause) rides it too — operator-core's renderAccountRoutingNote
// reuses the SAME string the spawned-bee base emits.
// DEPLOY_PIPELINE_NOTE (the "deploy pipeline is async; don't babysit your own change, but a RED
// gate is everyone's job to FIX (no owner-ask)" clause) rides it too — operator-core's renderDeployPipelineNote
// reuses the SAME string the spawned-bee base emits.
// REUSE_FIRST_NUDGE (the soft "extend, don't fork" clause) rides it too — operator-core's
// renderReuseFirstNudge reuses the SAME string the spawned-bee base emits.
// OBSERVATION_RUBRIC_NUDGE (the "check rubrics:list before filing an observation; grade
// structured if one fits" clause) rides it too — operator-core's renderObservationRubricNudge
// reuses the SAME string the spawned-bee base emits.
// CONCURRENCY_FIRST_NOTE (the "never wait for a 'calm window'; a non-resource block is a BUG to
// fix, not wait out; massive concurrency is the design" clause) rides it too — operator-core's
// renderConcurrencyFirstNote reuses the SAME string the spawned-bee base emits.
// CODE_RUN_NUDGE (the "collapse a multi-step tool flow into ONE code:run instead of a round-trip
// per call" clause) rides it too — operator-core's renderCodeRunNudge reuses the SAME string the
// spawned-bee base emits.
// FINISH_THE_ROLLOUT_NOTE (the "a capability built then left gated OFF is INCOMPLETE, not done; turn
// the gate on" clause) rides it too — operator-core's renderFinishTheRolloutNote reuses the SAME
// string the spawned-bee base emits.
// AGENT_ACTIVITY_TRUTH_NOTE (the "who's doing what is a LIVE derived truth, never a stale
// announcement" clause, agent-activity-liveness-truth P-004/P-006) rides it too — operator-core's
// renderAgentActivityTruthNote reuses the SAME string the spawned-bee base emits.
// WAIT_LOOP_NOTE (the "waiting on something? arm a self-wake LOOP — never sleep on an event that may
// never fire; re-check + FIX what's preventing it" clause, owner directive 2026-06-23) rides it too —
// operator-core's renderWaitLoopNote reuses the SAME string the spawned-bee base emits.
// PEER_WAKE_NOTE (the "you can WAKE a peer; a parked agent sleeps until something re-invokes it, so
// handing work off is not enough" clause, owner directive 2026-06-24) rides it too — operator-core's
// renderPeerWakeNote reuses the SAME string the spawned-bee base emits.
// PLAN_DISCIPLINE_NOTE (the "a plan is REQUIRED when work spans >=2 items / interdependent steps /
// outlives a session / sequences subsystems — not for a one-shot fix" bright-line,
// enforce-system-on-generic-work-2026-06-29 P-016) + OBSERVATION_CAPTURE_NOTE (the "capture what you
// notice the moment you notice it; route signal→improvements:capture / problem→issue / how-it-works→doc"
// clause, P-017) ride it too — operator-core's renderPlanDisciplineNote / renderObservationCaptureNote
// reuse the SAME strings the spawned-bee base emits.
export { FRICTION_TRIPWIRE, YIELD_POLICY, TESTING_STANDARD, VERIFICATION_STANDARD, ACCOUNT_ROUTING_NOTE, EVIDENCE_DISCIPLINE_NOTE, DEPLOY_PIPELINE_NOTE, REUSE_FIRST_NUDGE, WORK_RECORD_NOTE, WRITE_THROUGH_NOTE, PLAN_DISCIPLINE_NOTE, OBSERVATION_CAPTURE_NOTE, OBSERVATION_RUBRIC_NUDGE, CONCURRENCY_FIRST_NOTE, CODE_RUN_NUDGE, FINISH_THE_ROLLOUT_NOTE, AGENT_ACTIVITY_TRUTH_NOTE, WAIT_LOOP_NOTE, PEER_WAKE_NOTE, COUPLING_NOTE, STATE_PLANE_NOTE, PEER_REPLY_PRIORITY_NOTE } from './prompt-build';
// resolvePromptFile rides the same entry: operator-core's workspace-level
// (harness-less) role launch resolves the spawn persona directly
// (hive-agent-tabs P-003) without importing the heavy orchestrator root.
// resolvePromptFiles is the layered variant (base/<role>.md + concrete —
// audit P-019); prefer it wherever the CONTENT is being assembled.
export { resolvePromptFile, resolvePromptFiles, promptCandidates } from './prompt-resolve';
export type { PromptResolveContext } from './prompt-resolve';

export type RolePromptMode = 'autonomous' | 'chat' | 'discuss';

export interface AssembleRolePromptOptions {
  /** Registered harness slug (must exist in ~/.restart-harness-projects.json). */
  slug: string;
  /**
   * Pre-resolved project dir. When supplied, it is used verbatim and the
   * built-in `lookupProjectDir` (a workspace-BLIND HTTP-to-:3055-or-legacy
   * fallback) is skipped entirely. The operator is the workspace authority
   * and resolves this in-process per `workspaceId` — passing it here both
   * makes role launches workspace-correct AND avoids the host
   * synchronously curl-ing itself mid-request (which fails for harnesses
   * absent from the legacy registry, e.g. an active non-`default`
   * workspace). Omitted by the autonomous pipeline / CLI callers, which
   * fall back to `lookupProjectDir`.
   */
  projectDir?: string;
  /** Role name — must have a corresponding prompts/<role>.md (or a phase/dept variant). */
  role: string;
  /** Optional feature scope. Becomes a runtime-context bullet and a worktree cwd hint. */
  featureId?: string;
  /** 'autonomous' (default — the orchestrator dispatched it) or 'chat' (a user is talking). */
  mode?: RolePromptMode;
  /** Run id for traceability. Auto-generated if absent. */
  runId?: string;
  /** Extra runtime-context bullets the caller wants in the prompt (e.g. "MODE=replan"). */
  extras?: readonly string[];
  /**
   * Pre-resolved per-(workspace,harness,role) prompt override (D-7). The
   * operator-layer caller (which has PG + the active workspace) reads it from
   * the workspace store and supplies it; when set it takes precedence over the
   * config.json `promptOverrides.<role>` fallback. Keeps this module PG-free.
   */
  promptOverrideText?: string;
  /**
   * Plan context for a plan-derived feature: the origin plan's `## Now`
   * block + last 3 decisions. Fetched by the caller (operator or CLI
   * shim) so this module stays free of operator-layer PG imports.
   * Only meaningful for worker/validator/reviewer; callers are responsible
   * for filtering by role. Empty string / undefined disables injection.
   */
  planContext?: string;
  /**
   * Queen-authored brief for a bee: the situational overlay the bee is
   * MISSING (cross-bee context, watch-fors, why-this-priority, what-other-bees-are-doing),
   * NOT a restatement of the work-item. Passed by the Queen at placement time
   * (fresh spawn via prompt, or warm-inject via coord message).
   * P-060/061: the brief is the Queen's value-add. Empty string / undefined disables.
   */
  brief?: string;
  /**
   * The ONE bounded spawn/wake-hydration block (directed-wake-honesty P-021/P-012):
   * predecessor handoff + hive-roster snapshot + work-item carry-note, already
   * assembled + bounded + provenance-framed by assembleSpawnHydration (operator-core)
   * and carrying its own `## Handoff` heading. The interactive-launch counterpart of
   * the autonomous path's extraEnv.SPAWN_HANDOFF. Placed VERBATIM in the volatile
   * tail by buildPrompt. Empty / undefined disables (flag off or every source empty).
   */
  handoff?: string;
  /**
   * Project context to inject. Provided by the caller (which has DB access).
   * If non-empty, gets appended as a `## Project context (curated by Project
   * Manager)` section after `buildPrompt`'s output. Caller decides whether
   * the role should see it; this function just renders.
   */
  projectSpec?: {
    /** PROJ-XXX id; rendered in the section header. */
    projectId: string;
    /** The spec body; markdown. Empty string is treated as no-spec. */
    content: string;
    /** ISO timestamp of last update; rendered in the section header for staleness signaling. */
    updatedAt?: string;
  };
}

export interface AssembledPrompt {
  /** The full prompt text — feed this to claude as stdin or via --append-system-prompt. */
  text: string;
  /** Resolved metadata, useful for diagnostics and the chat transcript. */
  meta: {
    role: string;
    promptFile: string;
    projectDir: string;
    stateDir: string;
    harnessDir: string;
    runId: string;
    /**
     * The harness's own `blueprint.yaml` id used to resolve `promptFile`
     * (work-item-chat-context-modernize P-002) — `undefined` for a
     * blueprint-less harness (resolution fell back to the bare `[base]`
     * chain). Surfaced for diagnostics / ground-truth capture (P-001) and
     * for tests asserting blueprint-aware resolution (P-006).
     */
    blueprintId?: string;
  };
}

interface RegistryFile { projects?: Array<{ slug?: string; path?: string }> }

function homeDirPath(): string {
  return process.env.HOME ?? homedir();
}

/**
 * Resolve a slug to its registered project dir. Returns null if not found.
 *
 * Resolution order:
 *   1. Operator HTTP API (canonical — PG-backed harness_shared.harness_registry).
 *   2. Legacy ~/.restart-harness-projects.json (pre-workspace harnesses).
 */
export function lookupProjectDir(slug: string): string | null {
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  // 1. Operator HTTP API (sync via curl).
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('curl', [
      '-sf', '--max-time', '3', `${operatorBase}/api/harness/projects`,
    ], { encoding: 'utf8', timeout: 4000 });
    const data = JSON.parse(out) as RegistryFile;
    const hit = data.projects?.find((p) => p.slug === slug)?.path;
    if (hit) return hit;
  } catch { /* fall through to legacy */ }
  // 2. Legacy global registry (pre-workspace).
  const legacyPath = join(homeDirPath(), '.restart-harness-projects.json');
  if (!existsSync(legacyPath)) return null;
  try {
    const data = JSON.parse(readFileSync(legacyPath, 'utf8')) as RegistryFile;
    return data.projects?.find((p) => p.slug === slug)?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Assemble a role's prompt for a given harness install.
 *
 * Throws if the slug isn't registered or the role's prompt file can't be
 * resolved — both are programming errors at the caller, not user errors.
 */
export function assembleRolePrompt(opts: AssembleRolePromptOptions): AssembledPrompt {
  // Prefer a caller-supplied (workspace-aware, in-process) projectDir; only
  // fall back to the workspace-blind lookupProjectDir when none is given.
  const projectDir = opts.projectDir ?? lookupProjectDir(opts.slug);
  if (!projectDir) {
    throw new Error(`assembleRolePrompt: harness "${opts.slug}" not registered in any known registry (papercusp workspace registry.json or legacy ~/.restart-harness-projects.json)`);
  }
  const stateDir = join(projectDir, '.papercusp');
  const harnessDir = harnessRoot();

  const cfg = readEffectiveConfig(stateDir);
  const { phase } = resolvePhase(cfg);
  const dept = configGet<string>(cfg, 'dept', '');

  // work-item-chat-context-modernize P-002: resolve blueprint-aware, mirroring
  // invoke.ts's replacement-system-prompt fallback (`extras.BLUEPRINT_ID= || loadHarnessBlueprintId`) —
  // a "normal pipeline" autonomous spawn carries no BLUEPRINT_ID extra either, so
  // `loadHarnessBlueprintId(stateDir)` (this harness's OWN `blueprint.yaml` id) is the
  // correct default chat should walk too. Previously this call passed no blueprintId at
  // all, so EVERY chat — regardless of the harness's actual blueprint — resolved through
  // the bare `[base]` chain and got `blueprints/base/prompts/<role>.md` unconditionally
  // (e.g. the legacy coding-spine `worker.md`, SPEC.md-reading ritual and all) even for a
  // harness whose blueprint overrides that role with something else. A blueprint-less
  // harness (no `.papercusp/blueprint.yaml`, e.g. a flat non-hive coding harness) still
  // gets `undefined` here ⇒ chain=['base'] ⇒ byte-identical to before.
  const blueprintId = loadHarnessBlueprintId(stateDir);

  // Layered list (base/<role>.md first when present — audit P-019), the
  // concrete most-specific prompt last (kept as `promptFile` for meta).
  const promptFiles = resolvePromptFiles({ harnessDir, phase, dept, blueprintId }, opts.role);
  const promptFile = promptFiles[promptFiles.length - 1];
  if (!promptFile) {
    throw new Error(`assembleRolePrompt: no prompt file found for role "${opts.role}" (phase=${phase}, dept=${dept || 'none'}, blueprintId=${blueprintId ?? 'none'})`);
  }

  // Per-role specialization. The workspace-owned PG override (D-7) is the
  // source when the caller resolves + supplies it (`opts.promptOverrideText`) —
  // the operator/role-launch/agent-chat callers have PG + workspace context and
  // pass it, so this module stays free of operator-layer PG imports (same
  // pattern as projectDir/planContext/projectSpec). When NOT supplied (CLI /
  // autonomous callers without the override pre-resolved), fall back to the
  // config.json → promptOverrides.<role> file/inline logic (mirrors run.sh).
  let promptOverride = '';
  if (typeof opts.promptOverrideText === 'string' && opts.promptOverrideText.length > 0) {
    promptOverride = opts.promptOverrideText;
  } else {
    const ovRaw = configGet<string>(cfg, `promptOverrides.${opts.role}`, '');
    if (ovRaw) {
      if (ovRaw.startsWith('/')) {
        if (existsSync(ovRaw)) promptOverride = readFileSync(ovRaw, 'utf8');
      } else if (ovRaw.startsWith('./') || ovRaw.endsWith('.md') || ovRaw.endsWith('.txt')) {
        const p = join(stateDir, ovRaw.replace(/^\.\//, ''));
        if (existsSync(p)) promptOverride = readFileSync(p, 'utf8');
      } else {
        promptOverride = ovRaw;
      }
    }
  }

  const runId = opts.runId ?? `${Math.floor(Date.now() / 1000)}-${opts.role}${opts.featureId ? `-${opts.featureId}` : ''}`;
  const mode = opts.mode ?? 'autonomous';

  // Runtime-context extras. Mode is always present so the role prompt can
  // branch on it ("if MODE=chat, address the user; do not commit").
  const extras: string[] = [`MODE=${mode}`];
  if (opts.featureId) extras.push(`FEATURE_ID=${opts.featureId}`);
  if (mode === 'chat') {
    extras.push('CHAT=true (you are responding to a user message in real time; do not commit code; write supervisor-notes or .papercusp/notes/<feature>.md if you want the autonomous worker to act on something)');
  } else if (mode === 'discuss') {
    extras.push(
      'DISCUSS_MODE=true (your normal job is to IMPLEMENT this feature, but a human wants to talk it through FIRST — so do not implement or commit anything in this conversation. Help them think it through: read the feature + plan + relevant code, ask clarifying questions, lay out approach options and their tradeoffs, surface risks. When you align on a direction, write it as a supervisor-note / .papercusp/notes/<feature>.md so the autonomous worker can pick it up. You are advising, not executing.)',
    );
  }
  for (const e of opts.extras ?? []) extras.push(e);

  let text = buildPrompt({
    role: opts.role,
    promptFile,
    promptFiles,
    promptOverride,
    stateDir,
    harnessDir,
    projectDir,
    cwdOverride: '',         // chat doesn't run inside a worktree; no cwd hint
    featureId: opts.featureId ?? null,
    runId,
    // hive-blueprint-generalization P-008: same acceptance-driven preamble swap as
    // the autonomous spawn path (invoke.ts) — a generic-hive role launched here gets
    // VERIFICATION_STANDARD, a coding role keeps TESTING_STANDARD (undefined).
    acceptanceKind: loadHarnessAcceptanceKind(stateDir),
    // P-016: hive noun overrides → vocabulary reminder (absent for coding ⇒ no block).
    lexicon: loadHarnessLexicon(stateDir),
    extras,
    planContext: opts.planContext,
    brief: opts.brief,
    handoff: opts.handoff,
  });

  // Project-context injection. Curated by the Project Manager role; appended
  // after the buildPrompt output so it sits below memory + identity + runtime
  // context but above any caller-provided suffix (chat history, etc.).
  if (opts.projectSpec?.content && opts.projectSpec.content.trim()) {
    const updatedAtNote = opts.projectSpec.updatedAt
      ? ` · last curated ${opts.projectSpec.updatedAt}`
      : '';
    text += `\n\n---\n## Project context — ${opts.projectSpec.projectId} (curated by Project Manager${updatedAtNote})\n\n`;
    text += opts.projectSpec.content.trim();
    text += '\n';
  }

  return {
    text,
    meta: {
      role: opts.role,
      promptFile,
      projectDir,
      stateDir,
      harnessDir,
      runId,
      blueprintId,
    },
  };
}
