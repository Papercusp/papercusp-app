/**
 * dev:pipeline_position — "where is my change, and is it live?" in one read
 * (git-sync-dx-hardening-2026-06-17 P-002 / EI-1164).
 *
 * Pass a repo-relative `path` (its latest commit) or a `sha`; returns whether it
 * is committed → on `origin/staging` → in `origin/main` (passed the green gate)
 * → reached the live `:3070` operator (the deployed sha), plus the
 * green-checkpoint stall context + a one-line summary. READ-ONLY (no fetch).
 */

import { z } from 'zod';
import { defineTool, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import { gitPipelinePosition, type PipelinePosition } from '../../git-pipeline-position';
import { buildKey } from '../../events/await/catalog';
import { CELL_READ_SPAWN_ID } from '../../cell-read';
import { canonicalHarnessSlug, operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { statePlaneForDoor } from '../state-plane-door';
import { CURRENT_BUILD_TEST_CLASSES, currentBuildTestRoute } from '../../serving-runtimes';

const TOOL_NAME = 'dev:pipeline_position';

/**
 * Keep the domain payload below the result door before the generic serializer gets
 * a chance to clip it. The generic door can spill a large response, but the spill
 * pointer is not useful to a caller that needs the pipeline verdict in this turn.
 * Leave room below the ~6000-character result door for its envelope and guidance.
 */
export const PIPELINE_POSITION_RESPONSE_BUDGET_CHARS = 5_000;
const PIPELINE_POSITION_TEXT_CHARS = 360;
const PIPELINE_POSITION_TIGHT_TEXT_CHARS = 180;
const PIPELINE_POSITION_ARRAY_LIMIT = 8;
const PIPELINE_POSITION_TIGHT_ARRAY_LIMIT = 3;

type JsonRecord = Record<string, unknown>;

function serializedChars(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized.length : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function clipPipelineText(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string' || value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  const suffix = `…[truncated +${omitted} chars]`;
  return value.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

function compactPipelineValue(
  value: unknown,
  opts: { textChars: number; arrayLimit: number; depth?: number },
): unknown {
  const depth = opts.depth ?? 0;
  if (typeof value === 'string') return clipPipelineText(value, opts.textChars);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[nested detail omitted; use fullRead]';
  if (Array.isArray(value)) {
    return value.slice(0, opts.arrayLimit).map((entry) => compactPipelineValue(entry, { ...opts, depth: depth + 1 }));
  }
  const record = value as JsonRecord;
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(record).slice(0, 24)) {
    out[key] = compactPipelineValue(entry, { ...opts, depth: depth + 1 });
  }
  return out;
}

function pickPipelineFields(
  value: unknown,
  fields: readonly string[],
  opts: { textChars: number; arrayLimit: number },
): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as JsonRecord;
  const out: JsonRecord = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      out[field] = compactPipelineValue(source[field], opts);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function compactPipelineOwnership(
  value: unknown,
  opts: { textChars: number; arrayLimit: number },
): JsonRecord | undefined {
  // `thread` is intentionally excluded: it is the unbounded advisory payload that
  // caused this door to overflow. The claim/liveness fields are the actual verdict.
  return pickPipelineFields(
    value,
    [
      'eventKey',
      'workItem',
      'claimState',
      'unknown',
      'takenBy',
      'takenAt',
      'expiresAt',
      'holderSessionState',
      'duplicates',
    ],
    opts,
  );
}

/**
 * The gate fields this door projects, as a NAMED EXPORT so the pin test below can
 * compare it against the resolver's own struct (WI-2140908).
 *
 * ⚠ This list is code-describing metadata — a second copy of a truth
 * `GitPipelinePosition['gate']` already owns — and it has now drifted TWICE:
 * EI-20687018966071866 (the sibling `gate.greenCheckpoint.candidate` cell) and
 * WI-2140908 (`candidateFailures`). Both presented identically and misleadingly: the
 * field is absent from the projection, so `readCell` finds the declared path missing
 * and reports "the cell's declared path and its resolver's shape have drifted apart"
 * — blaming the RESOLVER, which is correct, for a defect in THIS list.
 *
 * `gate-projection-pin.test.ts` now fails when a gate field is neither projected here
 * nor listed in `PIPELINE_GATE_FIELDS_NOT_PROJECTED`, so the next added field forces
 * an explicit decision instead of vanishing silently.
 */
export const PIPELINE_GATE_PROJECTED_FIELDS = [
  'stalled',
  'consecutiveReds',
  'lastGreenAtMs',
  'fireStale',
  'fireStaleReason',
  'pause',
  'verdictStale',
  'verdictStaleReason',
  'verdictStaleReasonCode',
  'candidateAgeMs',
  'commitsBehindTip',
  'observedCandidate',
  'inconclusive',
  'repairQueue',
  // P-025 / WI-2146319. `repairQueue` is intentionally nullable for compatibility, so
  // project the persisted read disposition too: a present newer-schema row must not be
  // rendered as an absent queue at this projection boundary.
  'repairQueueRead',
  // WI-2140908. The frozen-candidate failure set. `pickPipelineFields` emits a field
  // whose value is `null` (it skips only `undefined`), so the no-repair-queue case
  // reaches the caller as an explicit `null` rather than a missing key.
  'candidateFailures',
  // gate-audit-hardening-2026-08-31 P-001. The composed owner brief is the registered
  // cell's one-read contract. `compactPipelineValue` bounds its prose, arrays and
  // nested detail at this door, while preserving the declared assessment/evidence
  // leaves so a bounded response cannot masquerade as resolver drift.
  'ownerBrief',
  // main-green-status-visible-2026-09-03 P-004 (`convergence`, `freezeDisposition`) and
  // P-009 (`retriage`): each is the payload of a registered state cell —
  // `gate.greenCheckpoint.convergence` / `.freezeDisposition` / `.retriage` in
  // `cell-registrations.ts` — whose `readVia.tool` is THIS door, so dropping any of them
  // reproduces the WI-2140908 presentation exactly (readCell blames the resolver for a
  // missing declared path). All three are bounded projections emitted UNCONDITIONALLY by
  // their resolvers (null-leaved when unmeasured, never absent), which is what makes them
  // safe to pick flat: `compactPipelineValue` clips their prose (`reason`, `summary`) to
  // the door's text budget and caps `shrinkPerRound` / `abandonedFailingFiles` at
  // `arrayLimit`, so none of them can carry the unbounded shape that blew this door before.
  'convergence',
  'freezeDisposition',
  'retriage',
] as const;

/** Projected by their own bounded helpers below, not by the flat pick. */
export const PIPELINE_GATE_SEPARATELY_PROJECTED = ['ownership', 'checkpointRunInFlight'] as const;

/**
 * Gate fields DELIBERATELY not projected, each with the reason. Being on this list is a
 * decision; being on neither list is the drift the pin test catches.
 *
 * The budget is real, not notional — `PIPELINE_POSITION_RESPONSE_BUDGET_CHARS` is 5000
 * and this door has already overflowed twice in the field (EI-20245527109472763,
 * EI-20241802258714011), which is why the remedy here is "classify every field",
 * not "project them all".
 */
export const PIPELINE_GATE_FIELDS_NOT_PROJECTED = [
  // The full failing-test list is the largest single field on the struct and the one most
  // likely to blow the door; `repairQueue` + `candidateFailures` carry the counts a caller
  // needs. ⚠ `failingTestsMeasured` is omitted WITH it deliberately: emitting the
  // "was this measured" qualifier without the list it qualifies invites reading an absent
  // list as "nothing is failing", which is the vacuous-green error this door must not create.
  // `failingTestsProvenance` (P-005: measured | carried | not-measured | unknown) is the
  // same qualifier with a finer vocabulary, and is omitted for the same reason — a bare
  // `'measured'` beside no list reads as a measured all-clear. Its consumer through this
  // resolver is `ownerBrief` (`gate-owner-brief.ts`), which carries the list's meaning with
  // it; no cell in `cell-registrations.ts` declares a path on it.
  'failingTests',
  'failingTestsMeasured',
  'failingTestsProvenance',
  // Checkpoint qualification state — a nested struct whose verdict is already implied by
  // `verdictStale` / `inconclusive` for this door's "where is my change" question.
  'qualification',
  // Raw observation timestamp; `candidateAgeMs` + `verdictStale` express the same staleness
  // in the terms a caller acts on.
  'verdictObservedAtMs',
  // A 7-field nested struct carrying a prose `reason` — this door's budget has already
  // blown twice, so the raw record remains deliberately omitted.
  //
  // The drift harm the pin test guards does NOT apply to it today: that harm is a state
  // CELL declaring a path this projection drops, and no cell in `cell-registrations.ts`
  // reads `gate.freezeAndConverge`. The cell that answers "is the freeze on, and if not
  // why" — `gate.greenCheckpoint.freezeDisposition` (P-004) — reads the DERIVED
  // `gate.freezeDisposition` projected above, which the resolver computes from this record
  // (`projectFreezeDispositionCell`), so the raw record has no cell reader. Its documented
  // readers are OTHER doors that project it from the snapshot directly —
  // `gate_health.freezeAndConverge` and `release:deploy` status
  // (`agent-tools/release/deploy.ts`) — so projecting it here would spend this door's
  // budget on a second copy nobody reads through it.
  //
  // ⚠ FLIP THIS DECISION the moment a cell IS registered on `gate.freezeAndConverge`:
  // at that point `readCell` finds the declared path missing and blames the RESOLVER for
  // a defect in this list, which is exactly how the two prior drifts presented.
  'freezeAndConverge',
] as const;

function compactPipelineGate(value: unknown, opts: { textChars: number; arrayLimit: number }): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as JsonRecord;
  const gate = pickPipelineFields(source, PIPELINE_GATE_PROJECTED_FIELDS, opts) ?? {};
  const ownership = compactPipelineOwnership(source.ownership, opts);
  if (ownership) gate.ownership = ownership;
  const inFlight = pickPipelineFields(
    source.checkpointRunInFlight,
    [
      'active',
      'activeSource',
      'processAuthority',
      'candidate',
      'candidateSource',
      'initialCandidate',
      'refireObserved',
      'inRetriageWindow',
      'fromCandidate',
      'refireAttempt',
      'maxRefires',
      'totalRefires',
      'absoluteCeiling',
      'startedAtMs',
      'progressAtMs',
      'currentPhase',
      'elapsedSec',
      'asOfAgeMs',
    ],
    opts,
  );
  if (inFlight) gate.checkpointRunInFlight = inFlight;
  return Object.keys(gate).length > 0 ? gate : undefined;
}

function compactPipelineRuntime(
  value: unknown,
  opts: { textChars: number; arrayLimit: number },
): JsonRecord | undefined {
  return pickPipelineFields(value, ['host', 'releasePipelineApplies', 'restartTarget', 'activation'], opts);
}

/**
 * acceptance-runtime-plane P-001: one compact row per serving runtime. At most seven rows
 * exist (the runtime catalog), so this ignores `arrayLimit` on purpose — truncating the
 * list could drop exactly the runtime where the change is already live.
 */
function compactServingRuntimes(
  value: unknown,
  opts: { textChars: number; arrayLimit: number },
): JsonRecord[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map(
    (entry) =>
      pickPipelineFields(
        entry,
        ['runtime', 'role', 'buildSha', 'buildShaSource', 'containsChange', 'method', 'instances', 'unknownReason'],
        opts,
      ) ?? {},
  );
}

/**
 * EI-20742070351584478 — THE SUBJECT STAMP. `gitPipelinePosition` reads the
 * operator-home integration tree, green-checkpoint and deployed :3070 state. It
 * cannot answer a SideStage (or any other harness's) release question, but the
 * old response carried no subject, so its correct Papercusp numbers looked like
 * an answer about the caller's own pipeline.
 *
 * Keep this as disclosure rather than a selector: the resolver has one pipeline
 * by design. A concrete foreign caller gets a loud warning beside the values,
 * while wildcard/unknown callers still receive the subject without an invented
 * mismatch claim.
 */
function pipelineSubjectStamp(ctx: { harnessSlug?: string | null }, integrationRoot: string) {
  const home = canonicalHarnessSlug(operatorHomeHarnessSlug());
  const subject = {
    harness: home,
    scope: 'operator-home-release-pipeline' as const,
    integrationRoot,
    note:
      `Every sha, gate verdict and deploy position in this reply describes the \`${home}\` operator release pipeline ONLY. ` +
      'Other harnesses run their own green-checkpoint and promotion — this reply is not evidence about them.',
  };

  const raw = ctx?.harnessSlug?.trim();
  const caller = raw && raw !== '*' ? canonicalHarnessSlug(raw) : null;
  if (!caller || caller === home) return { subject };

  return {
    subject,
    harnessMismatch: {
      callerHarness: caller,
      reportedHarness: home,
      warning:
        `⚠ CROSS-HARNESS READ — you called from harness \`${caller}\`, but dev:pipeline_position reports the \`${home}\` operator pipeline. ` +
        `These SHAs, gate reds and deploy positions are NOT \`${caller}\`'s and must not be quoted as its release truth: ` +
        `\`${caller}\` promotes on its OWN green-checkpoint. This tool has no \`${caller}\` mode; use that harness's own release surface.`,
    },
  };
}

function compactPipelineResult(
  result: PipelinePosition,
  extras: JsonRecord,
  opts: { textChars: number; arrayLimit: number },
): JsonRecord {
  const out: JsonRecord = {};
  const source = result as unknown as JsonRecord;

  for (const field of [
    'input',
    'submodule',
    'submodulePin',
    'targetSha',
    'targetShortSha',
    'targetSubject',
    'dirtyUncommitted',
    'positions',
    'assessments',
    'positionsUnknown',
    'positionsMarker',
    'positionsNewerCommit',
    'deployedSha',
    'verdictUnknown',
    'gitSyncLastStatus',
    'blockedOn',
  ]) {
    if (source[field] !== undefined) out[field] = compactPipelineValue(source[field], opts);
  }

  const gate = compactPipelineGate(source.gate, opts);
  if (gate) out.gate = gate;
  for (const [field, fields] of [
    [
      'verdictProvenance',
      [
        'lastGreenSha',
        'lastGreenShortSha',
        'lastGreenAgeMs',
        'mainFastForwarded',
        'mainBehindStaging',
        'stagingBufferAgeMs',
        'deployedBehindGreenPin',
        'deployOrigin',
      ],
    ],
    [
      'serving',
      [
        'host',
        'unit',
        'pid',
        'startedAtMs',
        'codeAsOfMs',
        'codeAsOfSource',
        'startedSinceCodeChange',
        'behindMin',
        'restartLever',
        'restartSupersededBy',
        'unknownReason',
      ],
    ],
    [
      'changeInCandidate',
      [
        'judgingSha',
        'judgingShaSource',
        'judgingContainsPath',
        'nextCandidateSha',
        'nextContainsPath',
        'missingReason',
        'markerJudging',
        'markerNext',
        'detail',
      ],
    ],
    ['sweepExposure', ['exposed', 'dirtyPathCount', 'dirtyPathSample', 'nextSweepInMs', 'detail']],
  ] as const) {
    const picked = pickPipelineFields(source[field], fields, opts);
    if (picked) out[field] = picked;
  }

  const gitSync = pickPipelineFields(
    source.gitSync,
    [
      'status',
      'lastSyncedAtMs',
      'syncAgeMs',
      'consecutiveErrorTicks',
      'skippedPaths',
      'pushedRepos',
      'mergedRepos',
      'conflicts',
      'errors',
      'pushMode',
      'ownHeadPublish',
    ],
    opts,
  );
  if (gitSync) out.gitSync = gitSync;

  const runtime = compactPipelineRuntime(source.runtime, opts);
  if (runtime) out.runtime = runtime;
  if (Array.isArray(source.runtimes)) {
    out.runtimes = source.runtimes.slice(0, opts.arrayLimit).map((entry) => compactPipelineRuntime(entry, opts) ?? {});
  }
  if (Array.isArray(source.runtimeGenerations)) {
    out.runtimeGenerations = source.runtimeGenerations
      .slice(0, opts.arrayLimit)
      .map(
        (entry) =>
          pickPipelineFields(
            entry,
            [
              'unit',
              'label',
              'pid',
              'startedAtMs',
              'codeAsOfMs',
              'codeAsOfSource',
              'runningYourCode',
              'behindMin',
              'loadedIdentity',
              'loadedIdentityUnknown',
              'activationLever',
              'unknownReason',
            ],
            opts,
          ) ?? {},
      );
  }
  const servingRuntimes = compactServingRuntimes(source.servingRuntimes, opts);
  if (servingRuntimes) out.servingRuntimes = servingRuntimes;
  if (Array.isArray(source.stages)) {
    out.stages = source.stages
      .slice(0, opts.arrayLimit)
      .map((entry) => pickPipelineFields(entry, ['name', 'position', 'health', 'detail', 'lever'], opts) ?? {});
  }

  for (const field of ['nextAction', 'summary', 'notes']) {
    if (source[field] !== undefined) {
      out[field] = compactPipelineValue(source[field], { ...opts, depth: 0 });
    }
  }
  Object.assign(out, compactPipelineValue(extras, opts) as JsonRecord);
  return out;
}

function minimalPipelineResult(
  result: PipelinePosition,
  extras: JsonRecord,
  opts: { textChars: number; arrayLimit: number },
): JsonRecord {
  const source = result as unknown as JsonRecord;
  const out: JsonRecord = {};
  for (const field of [
    'input',
    'targetSha',
    'targetShortSha',
    'dirtyUncommitted',
    'positions',
    'assessments',
    'deployedSha',
    'verdictUnknown',
    'blockedOn',
  ]) {
    if (source[field] !== undefined) out[field] = compactPipelineValue(source[field], opts);
  }
  const serving = pickPipelineFields(
    source.serving,
    [
      'host',
      'unit',
      'pid',
      'startedAtMs',
      'codeAsOfMs',
      'codeAsOfSource',
      'startedSinceCodeChange',
      'behindMin',
      'restartLever',
      'restartSupersededBy',
      'unknownReason',
    ],
    opts,
  );
  if (serving) out.serving = serving;
  // acceptance-runtime-plane P-001: kept at EVERY tier — it is the answer to "where is my
  // change running", and dropping it under budget pressure re-creates the runtime-blind
  // read this field exists to replace.
  const servingRuntimes = compactServingRuntimes(source.servingRuntimes, opts);
  if (servingRuntimes) out.servingRuntimes = servingRuntimes;
  const gate = compactPipelineGate(source.gate, opts);
  if (gate) out.gate = gate;
  for (const field of ['verdictProvenance', 'changeInCandidate']) {
    const picked = pickPipelineFields(
      source[field],
      field === 'verdictProvenance'
        ? ['lastGreenShortSha', 'mainFastForwarded', 'mainBehindStaging', 'deployedBehindGreenPin', 'deployOrigin']
        : [
            'judgingSha',
            'judgingShaSource',
            'judgingContainsPath',
            'nextCandidateSha',
            'nextContainsPath',
            'missingReason',
          ],
      opts,
    );
    if (picked) out[field] = picked;
  }
  for (const field of ['nextAction', 'summary']) {
    if (source[field] !== undefined) out[field] = clipPipelineText(source[field], opts.textChars);
  }
  Object.assign(out, compactPipelineValue(extras, opts) as JsonRecord);
  return out;
}

/**
 * Shape the full pipeline read before it reaches the generic result door. The
 * identity fast-path preserves the historical response byte-for-byte; only an
 * oversized payload receives the explicit, recoverable projection marker.
 */
export function shapePipelinePosition(
  result: PipelinePosition,
  extras: JsonRecord = {},
  rereadArgs: { path?: string; sha?: string; marker?: string; testClass?: string } = {},
  opts: { unbounded?: boolean } = {},
): JsonRecord | PipelinePosition {
  const original = { ...(result as unknown as JsonRecord), ...extras };
  const originalChars = serializedChars(original);
  /**
   * WI-38266 — the budget is skipped for a MACHINE consumer that asked for the whole
   * payload. Not a bypass: `readCell` projects two or three declared paths and returns
   * only those, so nothing unbounded reaches an agent's context by this route.
   *
   * It is skipped because the shaping was ACTIVELY WRONG for that caller. `readCell`
   * walks the payload for its headline, its hoist and its falsifier; when the shaping
   * dropped `serving`/`verdictUnknown` to fit this budget, the cell reported the absence
   * as `drifted` and told agents to read it "as a registration defect in the resolver" —
   * about a resolver that had emitted both fields with an enumerated `not-applicable`
   * reason. The falsifier CLAUDE.md relies on to separate "deployed sha X" from "the
   * process is EXECUTING X" stopped arriving entirely, which is the one misreading
   * `DEPLOYED_SHA_CELL` exists to kill.
   */
  if (opts.unbounded) return original;
  if (originalChars <= PIPELINE_POSITION_RESPONSE_BUDGET_CHARS) return original;

  const omittedFields = Object.keys(result as unknown as JsonRecord).filter(
    (field) =>
      !(
        field in
        compactPipelineResult(result, extras, {
          textChars: PIPELINE_POSITION_TEXT_CHARS,
          arrayLimit: PIPELINE_POSITION_ARRAY_LIMIT,
        })
      ),
  );
  if ('gate' in (result as unknown as JsonRecord) && !omittedFields.includes('gate.ownership.thread')) {
    omittedFields.push('gate.ownership.thread');
  }
  if ('repoRoot' in (result as unknown as JsonRecord)) omittedFields.push('repoRoot');

  const fullRead = {
    tool: TOOL_NAME,
    args: Object.fromEntries(Object.entries(rereadArgs).filter(([, value]) => value !== undefined)),
  };
  const projection = {
    kind: 'bounded',
    truncated: true,
    originalChars,
    returnedChars: 0,
    omittedFields: [...new Set(omittedFields)],
    fullRead,
  };
  const note = `Response was bounded from ${originalChars} to fit the ${PIPELINE_POSITION_RESPONSE_BUDGET_CHARS}-character pipeline read budget; omitted fields are listed in \`projection.omittedFields\`. Re-call \`${TOOL_NAME}\` with \`projection: { pick: [...] }\` or the args in \`projection.fullRead\` for the complete payload.`;

  const withProjection = (candidate: JsonRecord): JsonRecord => {
    const shaped = { ...candidate, projection: { ...projection }, projectionNote: note };
    for (let i = 0; i < 4; i++) {
      shaped.projection = { ...projection, returnedChars: serializedChars(shaped) };
    }
    return shaped;
  };

  let shaped = withProjection(
    compactPipelineResult(result, extras, {
      textChars: PIPELINE_POSITION_TEXT_CHARS,
      arrayLimit: PIPELINE_POSITION_ARRAY_LIMIT,
    }),
  );
  if (serializedChars(shaped) > PIPELINE_POSITION_RESPONSE_BUDGET_CHARS) {
    shaped = withProjection(
      compactPipelineResult(result, extras, {
        textChars: PIPELINE_POSITION_TIGHT_TEXT_CHARS,
        arrayLimit: PIPELINE_POSITION_TIGHT_ARRAY_LIMIT,
      }),
    );
  }
  if (serializedChars(shaped) > PIPELINE_POSITION_RESPONSE_BUDGET_CHARS) {
    shaped = withProjection(
      minimalPipelineResult(result, extras, {
        textChars: PIPELINE_POSITION_TIGHT_TEXT_CHARS,
        arrayLimit: PIPELINE_POSITION_TIGHT_ARRAY_LIMIT,
      }),
    );
  }
  return shaped;
}

/**
 * state-plane-adoption-2026-08-02 P-010 — EMIT the plane instead of competing with it.
 *
 * P-002 (the `seeAlso` below) POINTS at the plane and names one cell. That is promotion,
 * and promotion asymptotes: measured ACT/QUOTE adoption is 1.7% (D-030). This stamps every
 * volatile value in the answer with the cell that re-answers it, so a caller about to quote
 * one is already holding the reference and never has to know to switch tools.
 *
 * The door→cell map is not maintained here — it is each cell's own `changeSignal`
 * declaration, filtered by this tool's name (see state-plane-stamp.ts).
 *
 * TOTAL BY CONSTRUCTION. This decorates a read-only probe that agents depend on, so it
 * degrades to "no block" rather than failing the call: `resolveAgentIdentity` throws on a
 * malformed principal (this tool is `requirePrincipal: false`, so that is reachable), and
 * an enrichment that can fail the operation it enriches is the defect cell-read.ts already
 * documents. A reader we could not resolve keeps its roles empty, which under `canReadCell`
 * admits workspace-visible cells only — under-advertising, never over-advertising.
 */
export default defineTool({
  name: 'dev:pipeline_position',
  profile: 'engineer',
  description:
    '"Is my edit live YET — and what actually makes it live?" Read-only. Pass a repo-relative `path` (preferred) or a `sha`: returns committed/on-staging/in-main/deployed + the green-gate stall context + a one-line summary — AND, from the path, WHICH PROCESS RUNS THAT CODE. That second half matters: the gateway (:8788), bg-host (routines/DBOS) and embed-sidecar all run tsx STRAIGHT FROM THE STAGING TREE, so a deploy NEVER carries their code — the edit is already on their disk and a `dev:restart { target }` is what loads it. For those paths this returns an `activation` block (the exact restart call) and deliberately does NOT tell you to wait on the deploy. A few paths have 2 consumers on different routes — those return `activations` (plural) instead.',
  // @cell-lens git.pipelinePosition
  // This tool is the RESOLVER behind all five registered cells (git.pipelinePosition,
  // gate.greenCheckpoint.verdict/.candidate, deploy.3070.sha, git.mainBehindStaging) —
  // see packages/operator-core/lib/cell-registrations.ts. It already satisfies D-038
  // axis 5: those cells project this one derivation rather than recomputing it, and a
  // no-arg call is legal precisely so the three GLOBAL cells resolve (P-007 / D-067).
  //
  // EI-20261626591106746 / EI-18803497769946984: this handler's work is SUBPROCESS work
  // (git status/rev-list/ls-remote, the release + systemd probes) and it never reads
  // ctx.tx — `ctx` is used only for role/harnessSlug in planeFor(). Holding the ambient
  // workspace transaction idle across those awaits trips Postgres's
  // idle_in_transaction_session_timeout (60s), which reaches the caller as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432` naming neither this tool nor this cause —
  // and, because this tool RESOLVES five registered cells, every one of them degrades to
  // status:'unknown' at the same moment. Measured 2026-08-12 while Postgres (232/253 conns
  // idle, zero ungranted locks), the host (load 38/128 cores, PSI ~0) and git (all ops
  // sub-second) were ALL healthy: the hang was this idle transaction, not contention.
  // See ProjectedTool.skipWorkspaceTx; same declaration as dev:restart and capability:git.
  skipWorkspaceTx: true,
  capability: 'intel:read',
  guidance: {
    when: 'After leaving an edit, pass `path` to measure which runtime loaded it. For a functional test, add `testClass` (e.g. operator-api, background-federation, desktop-native, multi-machine-p2p-git) to get the maintained current-build route, isolation boundary and prerequisites before waiting on main. A route marked gap is NOT ready.',
    notWhen: 'To PAUSE sync (use locks:acquire_resource on git-sync:<slug>). For the whole-pipeline dashboard use the /admin Git tab; this is the targeted per-path/sha probe.',
    chaining: 'Edit → dev:pipeline_position{path,testClass} → inspect currentBuildTestRoute.readiness, prerequisites and servingRuntimes containment → run matching current-build route; use deploy:await only for explicit final-release evidence.',
    // EI-21631524117377159 (`work_item`), EI-21717329651353280 (`harness`),
    // EI-21690472537735874 (`harness` + `workspace`) — one shape: a caller forwards the
    // scope they are holding (a work-item id, their harness, their workspace) to a probe
    // whose selectors are `path` / `sha` / `marker` / `testClass`. The rejection lists them
    // and stops there, which is why `work_item` was re-filed after a caller "retried with
    // sha only" (EI-21052251222436407): they dropped the semantics rather than
    // translating them, and a bare sha cannot answer "which process runs this code".
    //
    // `work_item` is the load-bearing one. This tool answers about a FILE, and a
    // work-item's changed files are exactly the bridge — but nothing in the rejection
    // says so, and the `marker` arg (which is what makes the answer definitive when a
    // peer commit has moved the path) is invisible from there.
    //
    // Corrective-call form throughout: none of these keys has a local destination a
    // VALUE could be relocated onto, so a `path — …` string would render "pass it as
    // `path` instead" over a work-item id or a harness slug and be rejected again.
    argRedirects: {
      work_item: {
        tool: 'dev:pipeline_position',
        args: { path: '<a repo-relative file the work-item changed>', marker: '<a literal string that change introduced>' },
        note:
          'this probe addresses a FILE, not a work-item — there is no work_item selector. Read the item\'s changed files (work_items:get → completion.filesChanged, or its checkpoint) and pass ONE of them as `path`. Do NOT fall back to `sha` alone: git-sync commits the whole tree under one identity, so no commit is identifiably "yours", and a path resolves to its NEWEST commit — which any peer edit to the same file breaks. `marker` (a literal string YOUR change introduced) is what makes the verdict definitive in that case',
      },
      workItem: {
        tool: 'dev:pipeline_position',
        args: { path: '<a repo-relative file the work-item changed>', marker: '<a literal string that change introduced>' },
        note:
          'same as `work_item`: this probe addresses a FILE. Translate the item to one of its changed paths and pass `path` (+ `marker` for a definitive verdict); there is no work-item selector',
      },
      harness: {
        tool: 'dev:pipeline_position',
        args: { path: '<repo-relative path>' },
        note:
          'DROP the key — the repo is derived from `path` itself (a submodule path is resolved submodule-aware), so a harness cannot narrow this and passing one never could. ⚠ If your path lives in a SIBLING checkout, that is not a harness argument either: the reply reports it as `harnessMismatch`, and the state-plane cells it points at are audience-filtered to the reported harness',
      },
      workspace: {
        tool: 'dev:pipeline_position',
        args: { path: '<repo-relative path>' },
        note:
          'DROP the key — this probe reads git, systemd and the release checkout on THIS host; there is no workspace partition to select. Pass `path` (preferred — it also tells you WHICH PROCESS runs that code) or `sha`',
      },
    },
    /**
     * state-plane-adoption-2026-08-02 P-002: route this incumbent door at the state
     * plane. Deliberately a `seeAlso` and NOT a `chaining` line, for two independent
     * reasons — the second is the real one:
     *
     *  1. WEIGHT. `chaining` is prompt-resident, and this tool projects at 1411 against
     *     the 1500 budget — 89 chars of headroom. Its siblings are worse (dev:restart
     *     1491, release:deploy 1472). The prompt-time route is effectively closed across
     *     this whole family, so "add a pointer to the guidance" does not scale here.
     *  2. TIMING. The plane's entire claim is "RE-READ this value at the moment you ACT
     *     on it, don't transcribe it" (CLAUDE.md). The moment to say that is when the
     *     value is in the caller's hand — not at catalog-selection time, minutes earlier.
     *     A result-time pointer also self-gates, so it names the ONE cell that re-answers
     *     the question this caller demonstrably already has.
     */
    seeAlso: (result) => {
      const j = readJsonResult<{
        blockedOn?: string | null;
        harnessMismatch?: { callerHarness?: string; reportedHarness?: string };
      }>(result);
      // seeAlso runs on the SERIALIZED result — on the MCP transport the {data} envelope
      // may be TOON, so readJsonResult returns undefined and a JSON-only gate would
      // silently never fire. Same regex fallback coord:presence uses; fail open.
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const raw = j?.blockedOn ?? /\bblockedOn\b["']?\s*:\s*["']?([a-z]+)/i.exec(text)?.[1] ?? null;
      // Validate against the real StageName union — this also rejects a rendered
      // `blockedOn: null` (the change is live), which a bare [a-z]+ would capture.
      const blockedOn =
        raw && ['committed', 'pushed', 'gate', 'main', 'deployed', 'serving'].includes(raw)
          ? raw
          : null;

      // EI-21515547059659539: a CROSS-HARNESS caller cannot reach these cells — the
      // state plane is audience-filtered and its cell_absent error is deliberately
      // indistinguishable from "does not exist". The reply already knows (the
      // harnessMismatch block in the payload), so QUALIFY the pointers instead of
      // letting them send a hive caller into two doomed calls. Option (b) from the
      // report: teach the audience boundary rather than hide it.
      const mismatch =
        j?.harnessMismatch ??
        (/harnessMismatch/.test(text)
          ? {
              callerHarness:
                /callerHarness"?\s*[:=]\s*"?([a-z0-9-]+)/i.exec(text)?.[1] ?? 'your harness',
              reportedHarness:
                /reportedHarness"?\s*[:=]\s*"?([a-z0-9-]+)/i.exec(text)?.[1] ?? 'the reported harness',
            }
          : undefined);
      const audienceNote = mismatch
        ? ` — AUDIENCE: these cells live in the '${mismatch.reportedHarness}' state-plane audience; called from '${mismatch.callerHarness}' they return cell_absent (deliberately indistinguishable from nonexistent)`
        : '';

      const out: SeeAlsoEntry[] = [
        'dev:restart (loads an edit into gateway / bg-host / embed-sidecar / :3170 — what `activation` points at)',
        'dev:build_status (deploy / build status)',
        'release:deploy (force or inspect the deploy)',
      ];

      const cell =
        blockedOn === 'gate'
          ? 'gate.greenCheckpoint.verdict'
          : blockedOn === 'main'
            ? 'git.mainBehindStaging'
            : blockedOn === 'deployed' || blockedOn === 'serving'
              ? 'deploy.3070.sha'
              : 'git.pipelinePosition';
      out.push({
        tool: 'state:read',
        selector: `{ cell: '${cell}' }`,
        reason:
          'these values drift mid-turn — re-read before you ACT on one or quote it into a plan/message, never transcribe it' +
          audienceNote,
      });

      // Only where it is not a SECOND door for a wait that already has one: the deploy
      // leg already gets `awaitable`/deploy:await from the handler below, and shipping
      // both is the "two contradictory instructions in one payload" failure this file
      // warns about. The gate is the genuine gap — blockedOn:'gate' with nextAction null
      // is this tool's own documented "waiting is correct, and there is NO lever" verdict,
      // which is exactly the case that cost a live session ~26min of silence (WI-6595).
      if (blockedOn === 'gate') {
        out.push({
          tool: 'state:subscribe',
          selector: `{ cell: 'gate.greenCheckpoint.verdict' }`,
          reason:
            'wait for the verdict to CHANGE instead of re-polling this tool' + audienceNote,
        });
      }
      return out;
    },
  },
  requirePrincipal: false,
  // Read-only (intel:read) "where is my change + is the gate stalled" probe. Available to
  // EVERY execution/judgment role — the shared DEPLOY_PIPELINE_NOTE tells all of them to reach
  // for it instead of polling :3070, so the allowlist must cover them all (deploy-pipeline-legibility-2026-06-18 P-005).
  agentRoles: [
    'operator', 'mug', 'architect', 'worker', 'scoper', 'validator', 'reviewer',
    'debugger', 'documenter', 'curator', 'cup', 'papercup', 'papercup-deep', 'kettle',
    'release-fixer', 'merge-resolver', 'content-fixer', 'release-manager',
  ],
  args: z.object({
    path: z.string().min(1).max(400).optional(),
    sha: z.string().min(4).max(64).optional(),
    testClass: z.string().min(1).max(100).optional()
      .describe('Select a maintained pre-release test class route. Unknown values fail closed with the supported class ids; `gap` is not executable and final-release remains release-only.'),
    /**
     * EI-18797292094433710. Kept OPTIONAL rather than folded into `path` because it is a
     * different KIND of input — the caller's own change, which nothing on this box can
     * derive: git-sync commits the whole shared tree under one identity, so there is no
     * commit that is identifiably "yours" to test ancestry against.
     */
    marker: z
      .string()
      .min(3)
      .max(200)
      // Refused rather than silently ignored: a caller that named a marker is asking for
      // a DEFINITIVE verdict, so quietly handing back the ambiguous one is the worse
      // failure. (min(3) alone admits "   ", which would match indentation everywhere.)
      .refine((s) => s.trim().length >= 3, {
        message: 'marker must contain at least 3 non-whitespace characters — a blank marker matches everywhere.',
      })
      .optional()
      .describe(
        'A distinctive LITERAL string YOUR CHANGE INTRODUCED (a new function name, an added error message, an id) — ' +
          'NEVER a pre-existing identifier, table/type name, or symbol the file already contained: a marker that was ' +
          'already present before your edit proves nothing (EI-19325915429897280/EI-19325709344484737), so a leg only ' +
          'gets corrected on a STRICT net-new occurrence count against the pre-change baseline, not bare presence. ' +
          'Answers "is MY change there?" definitively where the default checks CANNOT: they resolve a path to its NEWEST commit, ' +
          'so any peer commit to the same file breaks them permanently. Settles BOTH `changeInCandidate` (the commit the gate judges) ' +
          'AND the `positions.inMain` / `positions.deployed` legs, correcting them in either direction. ' +
          'Use it whenever you see missingReason:"newer-commit" or a leg named in `positionsNewerCommit`.',
      ),
  }),
  async handler(args, ctx) {
    const testRoute = args.testClass ? currentBuildTestRoute(args.testClass) : null;
    if (args.testClass && !testRoute) {
      return { data: {
        error: 'unknown_test_class',
        supportedClasses: CURRENT_BUILD_TEST_CLASSES.map(({ id }) => id),
      } };
    }
    const routeHint = testRoute ? { currentBuildTestRoute: testRoute } : {};
    /**
     * unified-agent-state-plane-2026-07-27 P-007: a NO-ARG call is now legal and returns
     * the PIPELINE-WIDE legs (`gate`, `deployedSha`, `verdictProvenance`) with the
     * per-path legs reported as unmeasured.
     *
     * It used to return `{ error: 'Provide a path or a sha.' }`, which was reasonable
     * while every caller was asking a per-path question. It stopped being reasonable
     * when the cell registry began serving `gate.greenCheckpoint.verdict`,
     * `deploy.3070.sha` and `git.mainBehindStaging` — cells whose `callerRelativity` is
     * GLOBAL, precisely because the gate's red streak and the deployed sha are not
     * relative to anyone's path. `readCell` dispatches a global cell with `{}` (see
     * argsForRelativity), so the guard made those three cells resolve to an error
     * payload: registered, and dead. A registration that reads as an error is worse than
     * no registration, because the registry is supposed to be the trustworthy surface.
     *
     * The resolver already handled a null path correctly — it notes 'Provide a path or a
     * sha' and computes every global leg — so this is the removal of a wrapper-level
     * guard, not a new code path. Callers who omit both args still get told, in `notes`,
     * that the per-path legs are unanswerable; they simply also get the facts that do
     * not depend on a path.
     */
    const result = await gitPipelinePosition({ path: args.path, sha: args.sha, marker: args.marker });
    const subjectStamp = pipelineSubjectStamp(ctx as { harnessSlug?: string | null }, result.repoRoot);

    // P-010. Computed ONCE and spread into every return below — this handler has three
    // exits (multi-consumer, non-release runtime, default), and stamping only the default
    // would drop the plane for exactly the paths with unusual activation routes, which are
    // the ones whose readers are most likely to be reasoning about staleness.
    const plane = statePlaneForDoor(
      result,
      TOOL_NAME,
      // The subject for a caller-relative cell. Keyed by the PARAM NAME the spec
      // declares, never positionally — `path` here, `ownerId` for coord:goal.
      { path: args.path, sha: args.sha },
      ctx,
    );
    const rereadArgs = { path: args.path, sha: args.sha, marker: args.marker, testClass: args.testClass };

    /**
     * WI-38266 — `readCell` is a machine consumer walking declared paths, not an agent
     * spending context, and shaping its payload made this door's own cells
     * (`deploy.3070.sha`, `gate.greenCheckpoint.*`, `git.pipelinePosition`) report their
     * blameless resolver as defective. Keyed on the shared constant rather than a local
     * literal so the tag and the exemption cannot drift apart.
     */
    const shapeOpts = { unbounded: ctx.spawnId === CELL_READ_SPAWN_ID };

    // WI-5440: a path can have MORE THAN ONE consumer on DIFFERENT activation
    // routes (e.g. a file read by both a bg-host-only routine and an
    // operator-served MCP tool) — collapsing to a single `activation` block
    // confidently routes the activation decision the WRONG way for whichever
    // consumer isn't named. When `runtimes` has more than one entry, return
    // one activation per consumer instead of picking one.
    const runtimes = result.runtimes;
    if (runtimes && runtimes.length > 1) {
      const anyReleaseCarried = runtimes.some((r) => r.releasePipelineApplies);
      return {
        data: shapePipelinePosition(
          result,
          {
            ...subjectStamp,
            ...routeHint,
            ...(plane ? { plane } : {}),
            activations: runtimes.map((r) => ({
              hint: r.activation,
              host: r.host,
              releasePipelineApplies: r.releasePipelineApplies,
              ...(r.restartTarget
                ? {
                    tool: 'dev:restart',
                    args: { target: r.restartTarget, confirm: true, authorize: true, reason: 'load the edit' },
                  }
                : {}),
            })),
            note: anyReleaseCarried
              ? `This path has ${runtimes.length} distinct consumers on different activation routes (${runtimes
                  .map((r) => r.host)
                  .join(' + ')}) — at least one of them (${runtimes
                  .filter((r) => r.releasePipelineApplies)
                  .map((r) => r.host)
                  .join(
                    ', ',
                  )}) genuinely needs the deploy pipeline, so do NOT blanket-skip deploy:await; check each entry in \`activations\` against which consumer you actually care about before picking a route.`
              : `This path has ${runtimes.length} distinct consumers on different activation routes (${runtimes
                  .map((r) => r.host)
                  .join(
                    ' + ',
                  )}), none carried by the release pipeline — do NOT deploy:await; pick the restart matching the consumer you care about from \`activations\`.`,
          },
          rereadArgs,
          shapeOpts,
        ),
      };
    }

    // EI-10895: the `awaitable` below is only TRUE ADVICE for code the release
    // pipeline actually carries. For a staging-tree host (gateway / bg-host /
    // embed-sidecar — tsx, or a bundle the unit rebuilds at each start) or the Tauri
    // shell, a deploy is a NO-OP — telling the agent to
    // sleep on `deploy:await` sends it to wait forever for an event that will land
    // and change nothing. Emit the real activation lever instead.
    const runtime = result.runtime;
    if (runtime && !runtime.releasePipelineApplies) {
      return {
        data: shapePipelinePosition(
          result,
          {
            ...subjectStamp,
            ...routeHint,
            ...(plane ? { plane } : {}),
            activation: {
              hint: runtime.activation,
              host: runtime.host,
              releasePipelineApplies: false,
              ...(runtime.restartTarget
                ? {
                    tool: 'dev:restart',
                    args: { target: runtime.restartTarget, confirm: true, authorize: true, reason: 'load the edit' },
                  }
                : {}),
              note: 'Do NOT deploy:await this path — the process that runs it never reads the release checkout. The `positions.deployed` flag below is about the operator, not about this code being live.',
            },
          },
          rereadArgs,
          shapeOpts,
        ),
      };
    }

    // event-await-discoverability P-001: this is the #1 poll site the leader hit
    // repeatedly this session while `release:deployed` already fired. Advertise the
    // awaitable so the answer to "is it live yet?" is a sleep, not a re-poll. Point
    // at the GLOBAL key (fires on every deploy, always live) — deploy:await refines
    // it to the per-sha key. Only when the change isn't deployed yet is a wait useful.
    const deployed = result.positions?.deployed === true;
    // P-005 coherence: "sleep on the deploy" is only true advice when the deploy is what
    // the change is actually waiting for. If an EARLIER stage owns the next move — the work
    // is uncommitted, the push leg is faulted, the gate is red or judging a candidate
    // without this change — then sleeping on `release:deployed` waits for an event that
    // will land and carry someone else's code, while the thing that would actually help
    // goes undone. Two contradictory instructions in one payload is worse than one, so the
    // awaitable defers to `nextAction` whenever there IS one.
    //
    // ⚠ `nextAction` ALONE IS NOT ENOUGH, and the gap cost a live session ~26 minutes of
    // silence on 2026-07-28 (WI-6595). The paragraph above names "the gate is red" as a case
    // this must suppress — but a red gate with a run ALREADY IN FLIGHT has NO lever, so
    // `nextAction` is correctly null (blockedOn set + nextAction null is this tool's own
    // documented "waiting is correct" verdict). The guard therefore did not fire, the agent
    // was told to sleep on `release:deployed`, and the gate then went red: no deploy was ever
    // attempted, so NEITHER `release:deployed` NOR `release:deploy-failed` could fire (the
    // latter means an attempted deploy failed, not a gate that went red). Because a session
    // sleeping on an await has its monitor-loop fires suppressed, that advice also silenced
    // the agent's own 60s heartbeat — it had to be woken by hand.
    //
    // So gate the advice on WHERE THE CHANGE ACTUALLY SITS, not on whether a lever exists.
    // `blockedOn` is the first pending stage; `release:deployed` is only the event that
    // decides this change's fate once it has cleared everything before the deploy. Anything
    // earlier (committed / pushed / gate / main) is decided by a DIFFERENT event, and the
    // deploy that eventually fires would carry someone else's code.
    const blockedOn = result.blockedOn;
    const waitingOnTheDeployItself = blockedOn === 'deployed' || blockedOn === 'serving';
    const awaitable =
      deployed || result.nextAction || !waitingOnTheDeployItself
        ? undefined
        : {
            hint:
              'Not live yet — instead of re-polling, sleep on the deploy: deploy:await (or events:await the key below), ' +
              'then END YOUR TURN. You are re-invoked when it lands. ' +
              '⚠ PASS AN EXPLICIT timeout_sec (600 is a good default here) AND TREAT IT AS THE REAL GUARANTEE: an await ' +
              'SUPPRESSES your monitor-loop fires while you sleep, so if the event never comes the wait takes your own ' +
              'heartbeat down with it and the timeout is the ONLY thing that wakes you. It defaults to 1800s — i.e. 30 ' +
              'minutes dark. On the deadline you are re-invoked with a TIMEOUT marker, which is your cue to RE-READ this ' +
              'tool rather than re-arm the same wait. See events:catalog for all awaitable keys.',
            event: buildKey('deploy'), // global `release:deployed` — check payload.sha on wake
            sugar: 'deploy:await',
            // Concrete + copy-pasteable: the bound is the part agents omit, and the schema
            // default (1800) is far too long to be a safe fallback for a wait that also
            // silences the monitor loop (WI-6604).
            sugarArgs: { timeout_sec: 600 },
          };
    return {
      data: shapePipelinePosition(
        result,
        {
          ...subjectStamp,
          ...routeHint,
          ...(plane ? { plane } : {}),
          ...(awaitable ? { awaitable } : {}),
        },
        rereadArgs,
        shapeOpts,
      ),
    };
  },
});
