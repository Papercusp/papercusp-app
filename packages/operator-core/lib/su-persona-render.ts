/**
 * The su persona RENDER — the prompt-assembly steps shared by the two paths that
 * must produce a byte-identical launch context: the fresh-launch bootstrap
 * (`bootstrap-su`) and the carry-respawn persona refresh
 * (`bootstrap-su-persona-refresh`).
 *
 * WHY THIS MODULE EXISTS (stale-prompt-render-in-live-sessions-2026-08-02, D-001).
 * A respawn rebuilds the child's argv from the ORIGINAL argv and copies
 * `--system-prompt-file` through verbatim, so a long-lived session runs the render
 * from launch #1 forever — 27 of 53 live sessions were up to 14 days stale when
 * this was measured. The fix re-renders at respawn; the hazard the fix introduces
 * is DRIFT: a second assembly that slowly diverges from the launch one would make
 * a "refreshed" prompt subtly different from a fresh one, which is worse than
 * staleness because nothing would report it. So every non-trivial assembly step
 * lives HERE and is called by both paths in the same order. Do not inline a copy
 * of any of these steps into a caller — the P-003 equality guard is only
 * meaningful while this is the single source.
 *
 * Deliberately NOT here: the mode-directive TEXT. `AUTO_MODE_DIRECTIVE` /
 * `DRAIN_MODE_DIRECTIVE` are shared with the turn-1 KICKOFF derivation and live
 * with it in `bootstrap-su`; callers compose the section there
 * (`composeModePromptSection`) and hand the finished string in. Importing them
 * here would make this module and that route mutually dependent for no gain.
 */
import { join } from 'node:path';
import { normalizeSuContextSize } from './su-context-size.mjs';
import {
  blockingInstructionConflicts,
  buildInstructionPrecedenceTrace,
  lintInstructionText,
  renderInstructionPrecedenceContext,
  type InstructionLintReport,
  type InstructionModeResolution,
  type InstructionRuntimeContext,
} from './instruction-lint';
import { launchContextDir } from './su-launch-context';
import {
  replayAgentSpecification,
  specificationPrompt,
  type ResolvedAgentSpecification,
} from '@papercusp/orchestrator/blueprint';
import {
  buildLaunchSpec,
  compileLaunchSpecificationArtifact,
  type LaunchArtifactResult,
  type LaunchSpec,
} from './role-launch-spec';

/** The plan context a launch bakes into its brief, resolved fresh per render. */
export interface SuPlanContext {
  planTitle: string | null;
  planNow: { state: string; next: string } | null;
}

/**
 * Read the bound plan's `## Now` + title for the launch-context addendum
 * (`buildLaunchSpec` composes the brief from these). Best-effort by design: plan
 * context is optional, and a plans-store hiccup must never fail a launch — or,
 * on the refresh path, cost a session its respawn.
 *
 * WI-1442 fix (a): any `su-*` agent-id mentioned in the echoed `Now` block is
 * decorated with its CURRENT coord:presence session state. This snapshot is baked
 * into the prompt once, so a stale "actively worked by su-X" claim has to
 * self-disclose right here or it silently misleads the whole session.
 */
export async function resolveSuPlanContext(opts: {
  planSlug: string | null;
  harnessSlug: string | null;
  workspaceId: string;
}): Promise<SuPlanContext> {
  const { planSlug, harnessSlug, workspaceId } = opts;
  if (!planSlug || !harnessSlug) return { planTitle: null, planNow: null };
  try {
    const { resolveHarnessPlansDir, readPlanBySlug } = await import('./agent-tools/plans/source');
    const resolved = await resolveHarnessPlansDir(harnessSlug, { workspaceId });
    const found = await readPlanBySlug(planSlug, {
      harnessSlug: resolved.harnessSlug,
      workspaceId: resolved.workspaceId,
    });
    if (!found) return { planTitle: null, planNow: null };
    const { decoratePlanNowBlock } = await import('./agent-tools/plans/liveness-decoration');
    return {
      planNow: await decoratePlanNowBlock(found.parsed.now),
      planTitle: found.parsed.frontmatter?.title ?? null,
    };
  } catch {
    // plan context is optional — proceed without it
    return { planTitle: null, planNow: null };
  }
}

/**
 * The launch-time mode/route/scope precedence context (P-022). Compiled into a
 * machine-readable trace in the prompt so the agent can see which generic
 * playbook clauses are SUPPRESSED right now, and how to full-resync when the
 * control watermark moves.
 */
export interface SuInstructionRuntimeOptions {
  ownerId: string;
  autoMode: boolean;
  drainMode: boolean;
  fleet: { slug: string | null; role: string | null } | null;
  workspaceId: string;
  harnessSlug: string | null;
  planSlug: string | null;
  /** Optional live mode rows. When omitted, derive the launch snapshot. */
  activeModes?: readonly string[];
  modeResolution?: InstructionModeResolution;
}

export function buildSuInstructionRuntime(opts: SuInstructionRuntimeOptions): InstructionRuntimeContext {
  const fleetSlug = opts.fleet?.slug ?? null;
  const modes = opts.activeModes
    ? [...new Set(opts.activeModes)]
    : opts.drainMode
      ? ['auto', 'drain']
      : opts.autoMode || fleetSlug
        ? ['auto']
        : [];
  return {
    source: 'bootstrap-su',
    ownerId: opts.ownerId,
    // Stamp the observation time ONCE, here, rather than letting the precedence
    // trace fall back to `new Date()` per render (instruction-lint.ts). That
    // fallback made applySuPromptOverlays impure: two renders from the same
    // runtime differed whenever they straddled a millisecond boundary, which is
    // flaky-by-construction — it passes on a fast machine and reds the gate under
    // load. `observedAt` describes when the RUNTIME was observed, so binding it to
    // runtime construction is also the more truthful reading, and it is what makes
    // the P-003 property ("a respawn's render equals a fresh render") checkable at
    // all — a byte-comparison against a moving timestamp can never hold. (WI-7185)
    observedAt: new Date().toISOString(),
    modes,
    modeResolution: opts.modeResolution ?? 'launch',
    route: fleetSlug
      ? { kind: 'fleet', fleet: fleetSlug, role: opts.fleet?.role ?? null }
      : { kind: 'self' },
    scope: {
      workspace: opts.workspaceId,
      harness: opts.harnessSlug,
      plan: opts.planSlug,
      items: [],
    },
  };
}

/**
 * Resolve launch/refresh precedence from the same live mode registry that
 * `mode:set` and `coord:orient` read. A failed read is retained as an explicit
 * `unavailable` resolution; callers must not mistake it for an empty registry.
 * The launch flags remain as a best-effort fallback for the prose mode section,
 * while the structured execution decision renders `unknown` until the registry
 * can be read.
 */
export async function resolveSuInstructionRuntime(
  opts: SuInstructionRuntimeOptions,
): Promise<InstructionRuntimeContext> {
  try {
    const { getModes } = await import('./modes/store');
    const rows = await getModes(opts.workspaceId, opts.ownerId);
    return buildSuInstructionRuntime({
      ...opts,
      activeModes: rows.map((row) => row.mode),
      modeResolution: 'registry',
    });
  } catch {
    return buildSuInstructionRuntime({ ...opts, modeResolution: 'unavailable' });
  }
}

/**
 * Layer the per-launch overlays onto the base playbook text, in the ONE canonical
 * order, and lint the result. `basePromptText` is `spec.promptText` from
 * `buildLaunchSpec`; everything appended here is launch-specific.
 *
 * Order is load-bearing (it is what a refreshed render must reproduce): codex
 * launch-context → launcher provenance → mode activation → instruction
 * precedence. The lint runs over the FINAL text, not the base spec, because the
 * overlays are exactly where generated-rule conflicts get introduced.
 */
export async function applySuPromptOverlays(opts: {
  basePromptText: string;
  agent: string;
  /** `--launch-context` brief text; only codex folds it into the prompt itself. */
  launchContextText?: string;
  /** Owner id of the agent that launched this session, when it was agent-launched. */
  launchedBy?: string | null;
  /** Pre-composed AUTO/DRAIN section (see `composeModePromptSection`), or ''. */
  modeSection?: string;
  instructionRuntime: InstructionRuntimeContext;
}): Promise<{ promptText: string; instructionLint: InstructionLintReport }> {
  let promptText = opts.basePromptText;

  if (opts.agent === 'codex' && opts.launchContextText) {
    const budgetModule = await import('./model-context-budget.mjs');
    promptText = budgetModule.appendCodexLaunchContextPrompt(promptText, opts.launchContextText);
  }

  // solo-launch-provenance: bake WHO launched this session into the assembled
  // system prompt, so the agent can always answer "who launched you / who
  // supervises this mission" — across compaction AND cold-loop resets. Found
  // 2026-07-03: su-8ab32510 described its launcher as "an observer who doesn't
  // assign or supervise my work" because NOTHING recorded the relationship.
  // (The matching owner-scoped standing FACT is asserted by the launch route —
  // it is a side effect, and a re-render must not re-fire it.)
  if (opts.launchedBy) {
    const fleetSlug =
      opts.instructionRuntime.route?.kind === 'fleet' ? opts.instructionRuntime.route.fleet : null;
    const endedLauncherFallback = fleetSlug
      ? `If that session ends, use coord:send with to: ["@fleet-leader:${fleetSlug}"] to reach the current ` +
        'fleet leader; this selector survives session retirement and leadership rotation.'
      : 'If that session ends, use coord:send with to: ["human"] to reach the owner; this owner surface survives session retirement.';
    const liveReportingGuidance = fleetSlug
      ? `They are your original LAUNCHER/SUPERVISOR for attribution. For live fleet coordination, report milestones, blockers, and anomalies with coord:send to ["@fleet-leader:${fleetSlug}"]; this selector resolves the current fleet leader across session retirement and leadership rotation. Treat the launcher ID above as attribution only, not as the live fleet recipient; answer the current fleet leader's messages before your own next step, and treat that leader's directives as steering.`
      : `They are your LAUNCHER/SUPERVISOR: report milestones, blockers, and anomalies to them (coord:send) while live, answer their messages before your own next step, and treat their directives as steering.`;
    promptText =
      `${promptText.replace(/\n+$/, '')}\n\n---\n## Provenance — who launched this session\n\n` +
      `You were launched by **${opts.launchedBy}**, the agent that chose this mission and its launch ` +
      `brief. ${liveReportingGuidance} If asked who launched you or whose work this is, the answer is ` +
      `${opts.launchedBy}. ${endedLauncherFallback}\n`;
  }

  if (opts.modeSection) {
    promptText = `${promptText.replace(/\n+$/, '')}\n\n${opts.modeSection}`;
  }

  const launchPrecedence = buildInstructionPrecedenceTrace(opts.instructionRuntime);
  promptText =
    `${promptText.replace(/\n+$/, '')}\n\n---\n## Effective instruction precedence\n\n` +
    `${renderInstructionPrecedenceContext(launchPrecedence)}\n`;

  return {
    promptText,
    instructionLint: lintInstructionText(promptText, 20, opts.instructionRuntime),
  };
}

/**
 * The resolved `buildLaunchSpec` inputs a launch persists on
 * `adv_sessions.launch_spec` (migration 738) so a respawn can replay them.
 *
 * These are the RESOLVED values, not the request body: re-deriving them from
 * `launch_argv` would duplicate ~400 lines of bootstrap resolution and is exactly
 * the fork this design refuses. Versioned so a shape change can be detected
 * rather than silently mis-read — an unrecognised `v` fail-softs to no refresh.
 */
export interface SuLaunchSpecRecord {
  v: 1;
  agent: string;
  workspaceId: string;
  harnessSlug: string | null;
  /** Loose on purpose, matching `BuildSuLaunchSpecInput.profile`: the playbook
   *  profile is validated at the HTTP boundary and narrowed inside
   *  `buildSuLaunchSpec` (any unrecognised value falls back to 'engineer'). Making
   *  it a union HERE would be stricter than the value's own source. */
  profile: string;
  contextSize: 'trimmed' | 'steward';
  personaTier: 'full' | 'fleet' | null;
  model: string | null;
  modelSource?: 'explicit' | 'inherited' | 'configured-default';
  planSlug: string | null;
  launchedBy: string | null;
  autoMode: boolean;
  drainMode: boolean;
  /** Whether the server's boot-time engine-loop auto-arm actually took — picks
   *  which AUTO activation the mode section carries. Never assume true. */
  loopArmed: boolean;
  /** Current launch posture. Optional for v1 rows written before this field existed. */
  headless?: boolean;
  fleet: { slug: string | null; role: string | null } | null;
  /** Resolved launch binding and the last artifact/state receipts (P-008). */
  stack?: string[];
  /** The picker root and exact selected closure. `stack` remains the expanded
   * component binding consumed by the live control plane. */
  selectedIdentity?: SelectedIdentityPin | null;
  specificationRevision?: string;
  stateRevision?: string;
  /** Authenticated principal at launch; stable across changes in worn identity. */
  principalId?: string;
  /** The immutable P-038 artifact itself — provenance/explain reads this, not a second registry. */
  specificationArtifact?: ResolvedAgentSpecification;
  /** Bounded prior receipts for explain/diff + rollback; still the same launch-spec store. */
  identityHistory?: SuLaunchArtifactHistoryEntry[];
}

export interface SelectedIdentityPin {
  ref: string;
  sourceRevision: string;
}

/** Recover only a verified, previously delivered prompt when a pinned source
 * has moved and a missing Codex home needs its instructions restored. No new
 * activation is implied by replaying the immutable launch artifact. */
export function pinnedSuRecoveryPrompt(record: SuLaunchSpecRecord): {
  promptText: string;
  specificationRevision: string;
} | null {
  if (!record.selectedIdentity || !record.specificationArtifact || !record.specificationRevision) return null;
  const artifact = replayAgentSpecification(record.specificationArtifact);
  if (artifact.specificationRevision !== record.specificationRevision) {
    throw new Error('pinned SU recovery artifact does not match the launch receipt');
  }
  return { promptText: specificationPrompt(artifact), specificationRevision: artifact.specificationRevision };
}

export interface SuLaunchArtifactHistoryEntry {
  stack: string[];
  selectedIdentity?: SelectedIdentityPin | null;
  specificationRevision: string;
  stateRevision: string;
  specificationArtifact: ResolvedAgentSpecification;
  recordedAt: string;
}

/**
 * The identity-receipt depth. ONE definition on purpose: the rebuild path in
 * `identity-management` and the control-activation carry below cap the SAME
 * history, so two limits would let one path silently evict the other's receipt.
 */
export const IDENTITY_HISTORY_LIMIT = 12;

/** Preserve stored receipts when a launch replaces its render. The applied
 * pair is only a retention pin: this never creates or acknowledges a receipt. */
export function retainSuLaunchIdentityHistory(previous: unknown, next: unknown, applied: unknown): unknown {
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  const before = object(previous);
  const after = object(next);
  if (!after) return next;
  const samePair = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    a.specificationRevision === b.specificationRevision && a.stateRevision === b.stateRevision;
  const candidates = [
    before,
    ...(Array.isArray(before?.identityHistory) ? before.identityHistory : []),
    ...(Array.isArray(after.identityHistory) ? after.identityHistory : []),
  ];
  const seen = new Set<string>();
  const history: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const entry = object(candidate);
    const artifact = object(entry?.specificationArtifact);
    if (!entry || !artifact || typeof entry.specificationRevision !== 'string' || !entry.specificationRevision ||
        typeof entry.stateRevision !== 'string' || !entry.stateRevision ||
        artifact.specificationRevision !== entry.specificationRevision || samePair(entry, after)) continue;
    const key = JSON.stringify([entry.specificationRevision, entry.stateRevision]);
    if (seen.has(key)) continue;
    seen.add(key);
    history.push({
      stack: Array.isArray(entry.stack) ? entry.stack : [],
      ...(entry.selectedIdentity !== undefined ? { selectedIdentity: entry.selectedIdentity } : {}),
      specificationRevision: entry.specificationRevision,
      stateRevision: entry.stateRevision,
      specificationArtifact: artifact,
      recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : new Date().toISOString(),
    });
  }
  const retained = history.slice(0, IDENTITY_HISTORY_LIMIT);
  const appliedPair = object(applied);
  const pinned = appliedPair && history.find((entry) => samePair(entry, appliedPair));
  if (pinned && !retained.includes(pinned)) retained[IDENTITY_HISTORY_LIMIT - 1] = pinned;
  return retained.length || Array.isArray(after.identityHistory)
    ? { ...after, identityHistory: retained } : next;
}

/**
 * P-009 (EI-23431478594488191): a CONTROL-source activation — a `mode:set` or
 * fleet-membership transition — advances the applied STATE revision while
 * holding the specification fixed, and never re-renders the launch artifact. So
 * no receipt can ever carry the new `stateRevision`, `appliedIdentityArtifact`
 * finds no exact match, and the kernel preflight denies EVERY tool as
 * `stale-artifact` — including the `coord:orient` the CTRL block itself
 * prescribes as the repair.
 *
 * Returns the `identityHistory` to persist so that exact-match lookup succeeds
 * on its own evidence, instead of leaning on the reader-side fallback in
 * `checkIdentityGrantKernel`. Returns null when nothing should be written.
 *
 * FAILS CLOSED. This carries an EXISTING artifact forward under a new revision
 * pair, so it must never do so unless that artifact is provably the applied
 * specification:
 *  - no artifact, or no current revision pair on the record → null;
 *  - the activation's `specificationRevision` DIFFERS from the record's → null.
 *    A differing specification means the record's artifact is not what was
 *    applied, and carrying it would forge a receipt for a specification — and
 *    therefore a `configuration.grants` — that nobody rendered. That is the one
 *    case where writing a receipt would GRANT authority rather than record it.
 *  - a receipt for this exact pair already exists → null, so a repeated
 *    transition cannot churn the history or evict older receipts.
 */
export function carryIdentityReceiptForControlActivation(
  record: SuLaunchSpecRecord | null | undefined,
  revision: { specificationRevision?: string; stateRevision?: string } | null | undefined,
): SuLaunchArtifactHistoryEntry[] | null {
  if (!record || !revision) return null;
  const artifact = record.specificationArtifact;
  if (!artifact || !record.specificationRevision || !record.stateRevision) return null;
  const { specificationRevision, stateRevision } = revision;
  if (!specificationRevision || !stateRevision) return null;
  // The control path preserves the specification by construction. A mismatch is
  // a specification this record cannot vouch for; refuse rather than carry it.
  if (specificationRevision !== record.specificationRevision) return null;
  const history = record.identityHistory ?? [];
  const alreadyReceipted =
    record.stateRevision === stateRevision ||
    history.some((entry) =>
      entry.specificationRevision === specificationRevision && entry.stateRevision === stateRevision);
  if (alreadyReceipted) return null;
  const carried: SuLaunchArtifactHistoryEntry = {
    stack: [...(record.stack ?? [])],
    ...(record.selectedIdentity !== undefined ? { selectedIdentity: record.selectedIdentity } : {}),
    specificationRevision,
    stateRevision,
    specificationArtifact: artifact,
    recordedAt: new Date().toISOString(),
  };
  const seen = new Set<string>();
  return [carried, ...history]
    .filter((entry) => {
      const key = `${entry.specificationRevision}:${entry.stateRevision}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, IDENTITY_HISTORY_LIMIT);
}

/** Narrow an `adv_sessions.launch_spec` jsonb blob to a usable record, or null. */
export function parseSuLaunchSpecRecord(raw: unknown): SuLaunchSpecRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.agent !== 'string' || !r.agent) return null;
  if (typeof r.workspaceId !== 'string' || !r.workspaceId) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const parseSelection = (value: unknown): SelectedIdentityPin | null | undefined => {
    if (value == null) return null;
    if (!value || typeof value !== 'object') return undefined;
    const pin = value as Record<string, unknown>;
    if (typeof pin.ref !== 'string' || !/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin.ref) ||
        typeof pin.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sourceRevision)) {
      return undefined;
    }
    return { ref: pin.ref, sourceRevision: pin.sourceRevision };
  };
  const selectedIdentity = parseSelection(r.selectedIdentity);
  if (selectedIdentity === undefined) return null;
  const normalizedContextSize = normalizeSuContextSize(r.contextSize);
  if (!normalizedContextSize.ok) return null;
  const modelSource =
    r.modelSource === 'explicit' || r.modelSource === 'inherited' || r.modelSource === 'configured-default'
      ? r.modelSource
      : null;
  const specificationRevision = str(r.specificationRevision);
  const artifact =
    r.specificationArtifact && typeof r.specificationArtifact === 'object' &&
    str((r.specificationArtifact as Record<string, unknown>).specificationRevision) === specificationRevision
      ? (r.specificationArtifact as ResolvedAgentSpecification)
      : null;
  const identityHistory = Array.isArray(r.identityHistory)
    ? r.identityHistory.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const entry = value as Record<string, unknown>;
        const revision = str(entry.specificationRevision);
        const stateRevision = str(entry.stateRevision);
        const recordedAt = str(entry.recordedAt);
        const priorArtifact = entry.specificationArtifact;
        const priorSelection = parseSelection(entry.selectedIdentity);
        if (
          !revision || !stateRevision || !recordedAt ||
          priorSelection === undefined ||
          !priorArtifact || typeof priorArtifact !== 'object' ||
          str((priorArtifact as Record<string, unknown>).specificationRevision) !== revision
        ) return [];
        return [{
          stack: Array.isArray(entry.stack)
            ? entry.stack.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 40)
            : [],
          ...(entry.selectedIdentity !== undefined ? { selectedIdentity: priorSelection } : {}),
          specificationRevision: revision,
          stateRevision,
          specificationArtifact: priorArtifact as ResolvedAgentSpecification,
          recordedAt,
        } satisfies SuLaunchArtifactHistoryEntry];
      }).slice(0, 12)
    : [];
  return {
    v: 1,
    agent: r.agent,
    workspaceId: r.workspaceId,
    harnessSlug: str(r.harnessSlug),
    profile: str(r.profile) ?? 'engineer',
    contextSize: normalizedContextSize.contextSize,
    personaTier: str(r.personaTier) as SuLaunchSpecRecord['personaTier'],
    model: str(r.model),
    ...(modelSource ? { modelSource } : {}),
    planSlug: str(r.planSlug),
    launchedBy: str(r.launchedBy),
    autoMode: r.autoMode === true,
    drainMode: r.drainMode === true,
    loopArmed: r.loopArmed === true,
    ...(typeof r.headless === 'boolean' ? { headless: r.headless } : {}),
    fleet:
      r.fleet && typeof r.fleet === 'object'
        ? {
            slug: str((r.fleet as Record<string, unknown>).slug),
            role: str((r.fleet as Record<string, unknown>).role),
          }
        : null,
    stack: Array.isArray(r.stack)
      ? r.stack.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, 40)
      : [],
    ...(r.selectedIdentity !== undefined ? { selectedIdentity } : {}),
    ...(specificationRevision ? { specificationRevision } : {}),
    ...(str(r.stateRevision) ? { stateRevision: str(r.stateRevision)! } : {}),
    ...(str(r.principalId) ? { principalId: str(r.principalId)! } : {}),
    ...(artifact ? { specificationArtifact: artifact } : {}),
    ...(identityHistory.length > 0 ? { identityHistory } : {}),
  };
}

export interface RebuildSuLaunchArtifactInput {
  ownerId: string;
  operatorBaseUrl: string;
  record: SuLaunchSpecRecord;
  /** Override only the explicit mutable stack. Derived mode/posture layers stay registry-owned. */
  stack?: readonly string[];
  /** An explicit mutation can clear or restore the picker root independently of
   * the expanded component stack. Omitted keeps the persisted selection. */
  selectedIdentity?: SelectedIdentityPin | null;
  /** Kept outside this module so bootstrap-su remains the one owner of mode-directive prose. */
  modeSection: string;
}

export interface RebuiltSuLaunchArtifact {
  spec: LaunchSpec;
  artifact: LaunchArtifactResult;
  promptText: string;
  instructionLint: InstructionLintReport;
  instructionRuntime: InstructionRuntimeContext;
}

/**
 * Rebuild the exact immutable launch artifact from one persisted SU launch record.
 *
 * Persona refresh and identity mutation both need this operation. Keeping it here
 * prevents the two paths from drifting on plan refresh, overlays, mutable-state
 * revision, or — critically — derived fleet/mode identity layers. `record.stack`
 * stores only explicit choices; live fleet posture and mode definitions are folded
 * into the full render from the registry-owned instruction runtime every time.
 */
export async function rebuildSuLaunchArtifact(
  input: RebuildSuLaunchArtifactInput,
): Promise<RebuiltSuLaunchArtifact> {
  const { ownerId, operatorBaseUrl, record } = input;
  const nextStack = input.stack ?? record.stack ?? [];
  const selectedIdentity = input.selectedIdentity !== undefined
    ? input.selectedIdentity
    : input.stack !== undefined && JSON.stringify(nextStack) !== JSON.stringify(record.stack ?? [])
      ? null : record.selectedIdentity ?? null;
  const plan = await resolveSuPlanContext({
    planSlug: record.planSlug,
    harnessSlug: record.harnessSlug,
    workspaceId: record.workspaceId,
  });
  const instructionRuntime = await resolveSuInstructionRuntime({
    ownerId,
    autoMode: record.autoMode,
    drainMode: record.drainMode,
    fleet: record.fleet,
    workspaceId: record.workspaceId,
    harnessSlug: record.harnessSlug,
    planSlug: record.planSlug,
  });
  const spec = await buildLaunchSpec({
    kind: 'su',
    agent: record.agent,
    workspaceId: record.workspaceId,
    operatorBaseUrl,
    harnessSlug: record.harnessSlug,
    profile: record.profile,
    contextSize: record.contextSize,
    personaTier: record.personaTier,
    model: record.model,
    planSlug: record.planSlug,
    stack: nextStack,
    planTitle: plan.planTitle,
    planNow: plan.planNow,
    fleetRole: record.fleet?.role ?? null,
    modes: instructionRuntime.modes,
  });
  const selectedResolution = selectedIdentity
    ? await (await import('./agent-identities/source')).resolvePinnedIdentityLaunchSelection({
        ...selectedIdentity, repoDir: spec.cwd, stack: spec.stack,
      })
    : null;
  // A single-slot picker revision names its root source file. Its inherited
  // layers are pinned by the immutable launch artifact already stored beside
  // this record. A rollback compares against the matching history receipt.
  if (selectedResolution && selectedIdentity && !selectedIdentity.ref.startsWith('composition:')) {
    const sameSelection = (pin: SelectedIdentityPin | null | undefined) =>
      pin?.ref === selectedIdentity.ref && pin.sourceRevision === selectedIdentity.sourceRevision;
    const priorArtifact = sameSelection(record.selectedIdentity)
      ? record.specificationArtifact
      : record.identityHistory?.find((entry) => sameSelection(entry.selectedIdentity))?.specificationArtifact;
    if (!priorArtifact || !selectedResolution.layers.every((layer) =>
      priorArtifact.inputs.some((entry) =>
        entry.kind === 'blueprint-layer' && entry.ref === layer.id &&
        entry.contentHash === layer.contentHash))) {
      throw new Error('selected identity inherited source revision changed before SU artifact rebuild');
    }
  }
  const overlaid = await applySuPromptOverlays({
    basePromptText: spec.promptText,
    agent: record.agent,
    launchContextText: '',
    launchedBy: record.launchedBy,
    modeSection: input.modeSection,
    instructionRuntime,
  });
  const blocking = blockingInstructionConflicts(overlaid.instructionLint);
  if (blocking.length > 0) {
    throw new Error(`compiled instructions contain ${blocking.length} blocking conflict(s)`);
  }
  const precedence = buildInstructionPrecedenceTrace(instructionRuntime);
  const artifact = await compileLaunchSpecificationArtifact({
    promptText: overlaid.promptText,
    promptFile: spec.promptFile,
    cwd: spec.cwd,
    workspaceId: record.workspaceId,
    harnessSlug: record.harnessSlug,
    role: 'su',
    stack: spec.stack,
    // WI-10004747: the rebuilt persona composes the su static layers; record them.
    impliedStack: 'su-static',
    compositionRootId: selectedResolution?.compositionRootId ?? null,
    stateRevision: precedence.watermark,
    state: {
      schemaVersion: 1,
      principal: { kind: 'su', role: 'su', profile: record.profile },
      policy: { mcp: 'superuser', contextSize: record.contextSize, personaTier: spec.personaTier ?? null },
      instructionPrecedence: precedence,
    },
  });
  if (selectedResolution && !selectedResolution.layers.every((layer) =>
    artifact.specificationArtifact.inputs.some((entry) =>
      entry.kind === 'blueprint-layer' && entry.ref === layer.id &&
      entry.contentHash === layer.contentHash))) {
    throw new Error('selected identity source revision changed during SU artifact rebuild');
  }
  return {
    spec,
    artifact,
    promptText: artifact.promptText,
    instructionLint: overlaid.instructionLint,
    instructionRuntime,
  };
}

/**
 * Where a REFRESHED render is written — one deterministic file per coord owner,
 * overwritten on every respawn.
 *
 * Deliberately NOT the launch render's own path. The refresh is fail-soft: on any
 * failure the respawn keeps the inherited `--system-prompt-file`, so that
 * inherited file must stay intact and known-good. Rewriting it in place would
 * destroy the fallback exactly when the fallback is needed, and a per-respawn
 * unique name would grow this directory without bound.
 */
export function suPersonaRefreshPathFor(ownerId: string): string {
  const key = String(ownerId || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200);
  return join(launchContextDir(), `session-refresh-${key}.md`);
}
