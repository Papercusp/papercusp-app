/**
 * Background immutable dependency-generation producer (P-004 / WI-305952).
 *
 * Git-sync calls this after its publication legs settle.  The expensive
 * dependency-tree walk/copy stays in the existing dependency-generation.sh
 * store; this module only adds orchestration around that store:
 *
 *   candidate commit -> cheap immutable input fingerprint -> atomic attempt
 *   marker on the existing git-sync routine -> existing publisher -> ready or
 *   failed marker + awaitable event.
 *
 * The marker is deliberately latest-state metadata on the existing routine,
 * not a second cache or scheduler.  The generation store's .inputs index remains
 * the durable many-key cache.  A gate whose exact marker has already rotated out
 * falls back to that index and therefore remains correct across version skew.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import { createTextCollector } from '../child-output';
import { emitAwaitedEvent } from '../events/await/engine';
import { createNotifyBus } from '../pg-notify-bus';

export const DEPENDENCY_PREBUILD_NOTIFY_CHANNEL = 'papercusp_dependency_prebuild_changed';
export const DEPENDENCY_PREBUILD_EVENT_PREFIX = 'dependency-generation:prebuild';
export const DEPENDENCY_PREBUILD_IDLE_TIMEOUT_MS = 30 * 60_000;
export const DEPENDENCY_PREBUILD_HARD_TIMEOUT_MS = 90 * 60_000;
export const DEPENDENCY_PREBUILD_RETRY_COOLDOWN_MS = 5 * 60_000;
export const DEPENDENCY_PREBUILD_WAIT_MS = 30_000;
export const DEPENDENCY_PREBUILD_RECONCILE_MS = 1_000;

const FULL_COMMIT_RE = /^[0-9a-f]{40,64}$/i;
const INPUT_FINGERPRINT_RE = /^[0-9a-f]{64}$/i;
const GENERATION_ID_RE = /^v1-[0-9a-f]{64}$/i;

export interface DependencyPrebuildTarget {
  workspaceId: string;
  installSlug: string;
}

interface DependencyPrebuildBase {
  schema: 1;
  key: string;
  candidate: string;
  inputFingerprint: string;
  attemptId: string;
  queuedAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  producerPid: number;
  childPid: number | null;
}

export interface DependencyPrebuildBuildingState extends DependencyPrebuildBase {
  status: 'building';
  completedAtMs: null;
}

/**
 * One `PHASE schema=1 phase=… outcome=… duration_ms=…` record as the publisher
 * itself emitted it. The publisher is the only clock that can time its own
 * phases, so these are copied through verbatim rather than re-derived here.
 */
export interface DependencyPrebuildPhaseRecord {
  phase: string;
  outcome: string;
  durationMs: number;
}

/**
 * Writer-emitted phase telemetry for the publisher invocation this state
 * recorded.
 *
 * The publisher writes PHASE/SUMMARY records to stderr, and until this field
 * existed the producer kept that stream ONLY on the failure path
 * (`boundedFailure`). A successful build therefore threw its own timings away,
 * which made the plan's own completion bar — writer-backed phase timings, not
 * timings inferred by a caller or read off file mtimes — unobtainable from
 * exactly the runs that mattered. Persisted here, on the existing routine-row
 * marker, so no second store is introduced.
 *
 * Absent means "no publisher invocation produced telemetry for this state" (a
 * re-keyed generation ran none), never "the build emitted none".
 */
export interface DependencyPrebuildTelemetry {
  schema: 1;
  phases: DependencyPrebuildPhaseRecord[];
  result?: string;
  predecessor?: string;
  treesTotal?: number;
  treesReused?: number;
  treesCopied?: number;
  treesRemoved?: number;
  totalMs?: number;
}

export interface DependencyPrebuildReadyState extends DependencyPrebuildBase {
  status: 'ready';
  completedAtMs: number;
  identity: string;
  token: string;
  reused: boolean;
  /**
   * The generation store the publisher actually wrote `identity` into, resolved
   * exactly as dependency-generation.sh resolves it. The identity is only
   * meaningful INSIDE this root: when PAPERCUSP_DEPENDENCY_GENERATION_ROOT moves
   * (WI-10004797), a consumer whose env points at a different store must treat
   * the marker as a miss, never hand setup an identity that store lacks
   * (that surfaced as exit 74 "disappeared before it could be leased").
   * Absent on states written before this field existed.
   */
  generationRoot?: string;
  telemetry?: DependencyPrebuildTelemetry;
}

/**
 * Where dependency-generation.sh records the env-named store for an integration
 * root, so env-less callers (a manual `systemd-run --unit` gate run, install:safe,
 * an agent's hand prewarm) resolve the same store as bg-host (WI-10005159).
 */
export function dependencyGenerationRootRecord(integrationRoot: string): string {
  return join(integrationRoot, '.papercusp/dependency-generation-root');
}

function readRecordedDependencyGenerationRoot(integrationRoot: string): string | null {
  let text: string;
  try {
    text = readFileSync(dependencyGenerationRootRecord(integrationRoot), 'utf8');
  } catch {
    return null;
  }
  // bash `IFS= read -r` takes the first line verbatim; only an absolute path counts.
  const recorded = text.split('\n', 1)[0] ?? '';
  return isAbsolute(recorded) ? recorded : null;
}

/**
 * Effective dependency-generation store for an integration root — the TS mirror
 * of `dependency_generation_resolve_root` in dependency-generation.sh: env, then
 * the root recorded under the integration root, then the tree-local store (bash
 * `:-` treats an empty value as unset, hence `||`).
 */
export function resolveDependencyGenerationRoot(
  integrationRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT?.trim();
  return resolve(
    configured ||
      readRecordedDependencyGenerationRoot(integrationRoot) ||
      join(integrationRoot, '.papercusp/dependency-generations'),
  );
}

export interface DependencyPrebuildFailedState extends DependencyPrebuildBase {
  status: 'failed';
  completedAtMs: number;
  error: string;
  telemetry?: DependencyPrebuildTelemetry;
}

export type DependencyPrebuildState =
  | DependencyPrebuildQueuedState
  | DependencyPrebuildBuildingState
  | DependencyPrebuildReadyState
  | DependencyPrebuildFailedState;

export interface DependencyPrebuildRequest extends DependencyPrebuildTarget {
  candidate: string;
  integrationRoot: string;
  toolingRoot: string;
  queuedAtMs?: number;
}

/**
 * Crash-safe handoff written before candidate fingerprinting starts. The
 * fingerprint is intentionally absent here: deriving it is the first child
 * process, and that process is exactly where a cancelled git-sync fire used to
 * lose the candidate before any durable state existed.
 */
export interface DependencyPrebuildQueuedState {
  schema: 1;
  status: 'queued';
  candidate: string;
  queuedAtMs: number;
  updatedAtMs: number;
  producerPid: number;
  integrationRoot: string;
  toolingRoot: string;
}

export interface DependencyPrebuildCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
}

export interface DependencyPrebuildCommandOptions {
  cwd: string;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  onSpawn?: (pid: number) => void;
  onProgress?: () => void;
}

export type DependencyPrebuildCommand = (
  command: string,
  args: string[],
  options: DependencyPrebuildCommandOptions,
) => Promise<DependencyPrebuildCommandResult>;

export interface DependencyPrebuildDeps {
  command?: DependencyPrebuildCommand;
  readState?: (target: DependencyPrebuildTarget) => Promise<DependencyPrebuildState | null>;
  claimState?: (target: DependencyPrebuildTarget, state: DependencyPrebuildBuildingState) => Promise<boolean>;
  heartbeatState?: (target: DependencyPrebuildTarget, state: DependencyPrebuildBuildingState) => Promise<boolean>;
  settleState?: (
    target: DependencyPrebuildTarget,
    state: DependencyPrebuildReadyState | DependencyPrebuildFailedState,
  ) => Promise<boolean>;
  emitTerminal?: (
    target: DependencyPrebuildTarget,
    state: DependencyPrebuildReadyState | DependencyPrebuildFailedState,
  ) => Promise<void>;
  now?: () => number;
  attemptId?: () => string;
}

export type DependencyPrebuildRunOutcome =
  | 'ready'
  | 'failed'
  | 'deduped-building'
  | 'deduped-ready'
  | 'deduped-failed'
  | 'superseded';

function db(sql?: Sql): Sql {
  return sql ?? (getOrgPg().sql as unknown as Sql);
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = finiteInt(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function absolutePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[\0\r\n\t]/.test(trimmed) || !isAbsolute(trimmed)) return null;
  return trimmed;
}

export function dependencyPrebuildKey(candidate: string, inputFingerprint: string): string {
  return `${candidate.toLowerCase()}:${inputFingerprint.toLowerCase()}`;
}

/** Strictly decode routine metadata. Malformed state is absence, never readiness. */
export function parseDependencyPrebuildState(value: unknown): DependencyPrebuildState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  // The queued handoff has no input fingerprint yet: deriving that key is the
  // first child process, and this state protects the candidate across a process
  // exit before that child returns. Keep the shape strict; malformed metadata is
  // absence, never readiness.
  if (raw.status === 'queued') {
    const candidate = typeof raw.candidate === 'string' ? raw.candidate : '';
    const queuedAtMs = finiteInt(raw.queuedAtMs);
    const updatedAtMs = finiteInt(raw.updatedAtMs);
    const producerPid = positiveInt(raw.producerPid);
    const integrationRoot = absolutePath(raw.integrationRoot);
    const toolingRoot = absolutePath(raw.toolingRoot);
    if (
      raw.schema !== 1 ||
      !FULL_COMMIT_RE.test(candidate) ||
      queuedAtMs === null ||
      updatedAtMs === null ||
      producerPid === null ||
      updatedAtMs < queuedAtMs ||
      integrationRoot === null ||
      toolingRoot === null
    ) {
      return null;
    }
    return {
      schema: 1,
      status: 'queued',
      candidate,
      queuedAtMs,
      updatedAtMs,
      producerPid,
      integrationRoot,
      toolingRoot,
    };
  }

  const candidate = typeof raw.candidate === 'string' ? raw.candidate : '';
  const inputFingerprint = typeof raw.inputFingerprint === 'string' ? raw.inputFingerprint : '';
  const key = typeof raw.key === 'string' ? raw.key : '';
  const attemptId = typeof raw.attemptId === 'string' ? raw.attemptId : '';
  const queuedAtMs = finiteInt(raw.queuedAtMs);
  const startedAtMs = finiteInt(raw.startedAtMs);
  const updatedAtMs = finiteInt(raw.updatedAtMs);
  const producerPid = positiveInt(raw.producerPid);
  const hasChildPid = Object.prototype.hasOwnProperty.call(raw, 'childPid');
  const childPid = raw.childPid === null ? null : positiveInt(raw.childPid);
  if (
    raw.schema !== 1 ||
    !FULL_COMMIT_RE.test(candidate) ||
    !INPUT_FINGERPRINT_RE.test(inputFingerprint) ||
    key !== dependencyPrebuildKey(candidate, inputFingerprint) ||
    !attemptId ||
    queuedAtMs === null ||
    startedAtMs === null ||
    updatedAtMs === null ||
    producerPid === null ||
    !hasChildPid
  ) {
    return null;
  }
  if (startedAtMs < queuedAtMs || updatedAtMs < startedAtMs) return null;
  const base: DependencyPrebuildBase = {
    schema: 1,
    key,
    candidate,
    inputFingerprint,
    attemptId,
    queuedAtMs,
    startedAtMs,
    updatedAtMs,
    producerPid,
    childPid,
  };
  if (raw.status === 'building' && raw.completedAtMs === null) {
    return { ...base, status: 'building', completedAtMs: null };
  }
  const completedAtMs = finiteInt(raw.completedAtMs);
  if (completedAtMs === null) return null;
  if (completedAtMs < startedAtMs) return null;
  // Telemetry is diagnostic, never a readiness or correctness input, so
  // malformed telemetry degrades to absence instead of voiding a usable state.
  const telemetry = parseDependencyPrebuildTelemetry(raw.telemetry);
  if (raw.status === 'ready') {
    const identity = typeof raw.identity === 'string' ? raw.identity : '';
    const token = typeof raw.token === 'string' ? raw.token : '';
    if (!GENERATION_ID_RE.test(identity) || !token) return null;
    // Optional for back-compat with pre-WI-10004797 states; a present but
    // malformed root is malformed state (absence), never "unknown root".
    const hasGenerationRoot = raw.generationRoot !== undefined && raw.generationRoot !== null;
    const generationRoot = hasGenerationRoot ? absolutePath(raw.generationRoot) : null;
    if (hasGenerationRoot && generationRoot === null) return null;
    return {
      ...base,
      status: 'ready',
      completedAtMs,
      identity,
      token,
      reused: raw.reused === true,
      ...(generationRoot ? { generationRoot } : {}),
      ...(telemetry ? { telemetry } : {}),
    };
  }
  if (raw.status === 'failed') {
    const error = typeof raw.error === 'string' ? raw.error.trim() : '';
    if (!error) return null;
    return { ...base, status: 'failed', completedAtMs, error, ...(telemetry ? { telemetry } : {}) };
  }
  return null;
}

export async function readDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  sql?: Sql,
): Promise<DependencyPrebuildState | null> {
  const rows = await db(sql)<{ state: unknown }[]>`
    SELECT metadata->'dependency_prebuild' AS state
      FROM harness_shared.routines
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return parseDependencyPrebuildState(rows[0]?.state ?? null);
}

/**
 * Persist a candidate handoff before any expensive fingerprint/copy work. The
 * write is newest-queued-at-wins and never downgrades a ready/building marker
 * for the same candidate. It deliberately extends the existing routine-row
 * metadata instead of introducing another queue or cache.
 */
export async function enqueueDependencyPrebuild(request: DependencyPrebuildRequest, sql?: Sql): Promise<boolean> {
  const candidate = request.candidate.trim().toLowerCase();
  if (!FULL_COMMIT_RE.test(candidate)) {
    throw new Error(`dependency prebuild candidate is not a full commit: ${request.candidate}`);
  }
  const integrationRoot = absolutePath(request.integrationRoot);
  const toolingRoot = absolutePath(request.toolingRoot);
  if (integrationRoot === null || toolingRoot === null) {
    throw new Error('dependency prebuild handoff requires integrationRoot and toolingRoot');
  }
  const queuedAtMs = request.queuedAtMs ?? Date.now();
  if (!Number.isSafeInteger(queuedAtMs) || queuedAtMs < 0) {
    throw new Error(`dependency prebuild handoff queuedAtMs is invalid: ${queuedAtMs}`);
  }
  const state: DependencyPrebuildQueuedState = {
    schema: 1,
    status: 'queued',
    candidate,
    queuedAtMs,
    updatedAtMs: queuedAtMs,
    producerPid: process.pid,
    integrationRoot,
    toolingRoot,
  };
  const rows = await db(sql)<{ queued: boolean }[]>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dependency_prebuild', ${JSON.stringify(state)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${request.workspaceId}
       AND install_slug = ${request.installSlug}
       AND target_role = 'system:git-sync'
       AND (
         metadata->'dependency_prebuild' IS NULL
         OR (
           CASE
             WHEN COALESCE(metadata->'dependency_prebuild'->>'queuedAtMs', '') ~ '^[0-9]+$'
               THEN (metadata->'dependency_prebuild'->>'queuedAtMs')::bigint
             WHEN COALESCE(metadata->'dependency_prebuild'->>'startedAtMs', '') ~ '^[0-9]+$'
               THEN (metadata->'dependency_prebuild'->>'startedAtMs')::bigint
             WHEN COALESCE(metadata->'dependency_prebuild'->>'completedAtMs', '') ~ '^[0-9]+$'
               THEN (metadata->'dependency_prebuild'->>'completedAtMs')::bigint
             ELSE 0
           END <= ${queuedAtMs}
           AND (
             metadata->'dependency_prebuild'->>'candidate' IS DISTINCT FROM ${candidate}
             OR metadata->'dependency_prebuild'->>'schema' IS DISTINCT FROM '1'
             OR COALESCE(metadata->'dependency_prebuild'->>'status', '') NOT IN
               ('queued', 'building', 'ready', 'failed')
           )
         )
       )
    RETURNING true AS queued
  `;
  const queued = rows.length > 0;
  if (queued) await notifyDependencyPrebuildChange(request, state, sql);
  return queued;
}

/** Reconstruct a runnable producer request from a persisted queued handoff. */
export function dependencyPrebuildRequestFromQueuedState(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildQueuedState,
): DependencyPrebuildRequest {
  return {
    workspaceId: target.workspaceId,
    installSlug: target.installSlug,
    candidate: state.candidate,
    integrationRoot: state.integrationRoot,
    toolingRoot: state.toolingRoot,
    queuedAtMs: state.queuedAtMs,
  };
}

export interface DependencyPrebuildRecoveryDeps {
  readState?: (target: DependencyPrebuildTarget) => Promise<DependencyPrebuildState | null>;
  run?: (request: DependencyPrebuildRequest) => Promise<DependencyPrebuildRunOutcome>;
}

/**
 * Recover the handoff left by a cancelled producer process. The read is
 * authoritative and the queued payload carries every path needed to restart;
 * no ambient environment is consulted. Claiming/building remains in
 * `runDependencyGenerationPrebuild`, so two ticks recovering the same marker
 * are harmless and only one can publish the candidate.
 */
export async function recoverQueuedDependencyPrebuild(
  target: DependencyPrebuildTarget,
  deps: DependencyPrebuildRecoveryDeps = {},
): Promise<DependencyPrebuildRunOutcome | 'none'> {
  const readState = deps.readState ?? readDependencyPrebuildState;
  const state = await readState(target);
  if (state?.status !== 'queued') return 'none';
  const request = dependencyPrebuildRequestFromQueuedState(target, state);
  return (deps.run ?? runDependencyGenerationPrebuild)(request);
}

async function notifyDependencyPrebuildChange(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildState,
  sql?: Sql,
): Promise<void> {
  const payload = JSON.stringify({
    workspaceId: target.workspaceId,
    installSlug: target.installSlug,
    candidate: state.candidate,
    ...(state.status !== 'queued' ? { inputFingerprint: state.inputFingerprint } : {}),
    status: state.status,
  });
  try {
    await db(sql)`SELECT pg_notify(${DEPENDENCY_PREBUILD_NOTIFY_CHANNEL}, ${payload})`;
  } catch (error) {
    console.warn(
      `[dependency-prebuild] PG notify failed for ${target.installSlug}/${state.candidate.slice(0, 12)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Atomic cross-process dedupe claim on candidate+input identity. */
export async function claimDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildBuildingState,
  sql?: Sql,
): Promise<boolean> {
  const staleBeforeMs = state.startedAtMs - DEPENDENCY_PREBUILD_HARD_TIMEOUT_MS;
  const retryBeforeMs = state.startedAtMs - DEPENDENCY_PREBUILD_RETRY_COOLDOWN_MS;
  const rows = await db(sql)<{ claimed: boolean }[]>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dependency_prebuild', ${JSON.stringify(state)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND target_role = 'system:git-sync'
       AND CASE
             WHEN COALESCE(metadata->'dependency_prebuild'->>'queuedAtMs', '') ~ '^[0-9]+$'
               THEN (metadata->'dependency_prebuild'->>'queuedAtMs')::bigint
             ELSE 0
           END <= ${state.queuedAtMs}
       AND (
         metadata->'dependency_prebuild' IS NULL
         OR metadata->'dependency_prebuild'->>'key' IS DISTINCT FROM ${state.key}
         OR metadata->'dependency_prebuild'->>'status' NOT IN ('building', 'ready', 'failed')
         OR (
           metadata->'dependency_prebuild'->>'status' = 'building'
           AND CASE
                 WHEN COALESCE(metadata->'dependency_prebuild'->>'updatedAtMs', '') ~ '^[0-9]+$'
                   THEN (metadata->'dependency_prebuild'->>'updatedAtMs')::bigint
                 ELSE 0
               END < ${staleBeforeMs}
         )
         OR (
           metadata->'dependency_prebuild'->>'status' = 'failed'
           AND CASE
                 WHEN COALESCE(metadata->'dependency_prebuild'->>'completedAtMs', '') ~ '^[0-9]+$'
                   THEN (metadata->'dependency_prebuild'->>'completedAtMs')::bigint
                 ELSE 0
               END < ${retryBeforeMs}
         )
       )
    RETURNING true AS claimed
  `;
  const claimed = rows.length > 0;
  if (claimed) await notifyDependencyPrebuildChange(target, state, sql);
  return claimed;
}

export async function heartbeatDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildBuildingState,
  sql?: Sql,
): Promise<boolean> {
  const rows = await db(sql)<{ updated: boolean }[]>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dependency_prebuild', ${JSON.stringify(state)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND target_role = 'system:git-sync'
       AND metadata->'dependency_prebuild'->>'attemptId' = ${state.attemptId}
       AND metadata->'dependency_prebuild'->>'key' = ${state.key}
       AND metadata->'dependency_prebuild'->>'status' = 'building'
    RETURNING true AS updated
  `;
  return rows.length > 0;
}

export async function settleDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildReadyState | DependencyPrebuildFailedState,
  sql?: Sql,
): Promise<boolean> {
  const rows = await db(sql)<{ updated: boolean }[]>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dependency_prebuild', ${JSON.stringify(state)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND target_role = 'system:git-sync'
       AND metadata->'dependency_prebuild'->>'attemptId' = ${state.attemptId}
       AND metadata->'dependency_prebuild'->>'key' = ${state.key}
       AND metadata->'dependency_prebuild'->>'status' = 'building'
    RETURNING true AS updated
  `;
  const updated = rows.length > 0;
  if (updated) await notifyDependencyPrebuildChange(target, state, sql);
  return updated;
}

export async function emitDependencyPrebuildTerminal(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildReadyState | DependencyPrebuildFailedState,
): Promise<void> {
  const payload = {
    workspaceId: target.workspaceId,
    installSlug: target.installSlug,
    candidate: state.candidate,
    inputFingerprint: state.inputFingerprint,
    status: state.status,
    ...(state.status === 'ready' ? { identity: state.identity } : { error: state.error }),
  };
  const summary =
    state.status === 'ready'
      ? `dependency generation ${state.identity} ready for ${state.candidate.slice(0, 12)}`
      : `dependency generation prebuild failed for ${state.candidate.slice(0, 12)}: ${state.error.slice(0, 240)}`;
  await Promise.all([
    emitAwaitedEvent({
      key: `${DEPENDENCY_PREBUILD_EVENT_PREFIX}:${state.status}`,
      workspaceId: target.workspaceId,
      summary,
      payload,
      source: 'git-sync:dependency-prebuild',
    }),
    emitAwaitedEvent({
      key: `${DEPENDENCY_PREBUILD_EVENT_PREFIX}:${state.status}:${state.candidate}:${state.inputFingerprint}`,
      workspaceId: target.workspaceId,
      summary,
      payload,
      source: 'git-sync:dependency-prebuild',
    }),
  ]).then(() => undefined);
}

function terminateProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // It already exited between the timer and the kill.
    }
  }
}

export const runDependencyPrebuildCommand: DependencyPrebuildCommand = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = createTextCollector(child.stdout);
    const stderr = createTextCollector(child.stderr);
    let settled = false;
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const finish = (code: number, signal: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        signal,
        timedOut,
      });
    };
    const terminate = (reason: string) => {
      if (settled || timedOut) return;
      timedOut = true;
      stderr.append(`${stderr.peek() ? '\n' : ''}${reason}`);
      if (child.pid) {
        terminateProcessGroup(child.pid, 'SIGTERM');
        setTimeout(() => terminateProcessGroup(child.pid!, 'SIGKILL'), 10_000).unref?.();
      }
      setTimeout(() => finish(-1), 20_000).unref?.();
    };
    const progress = () => {
      options.onProgress?.();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => terminate(`dependency prebuild made no output progress for ${options.idleTimeoutMs}ms`),
        options.idleTimeoutMs,
      );
      idleTimer.unref?.();
    };
    child.stdout?.on('data', progress);
    child.stderr?.on('data', progress);
    if (child.pid) options.onSpawn?.(child.pid);
    progress();
    hardTimer = setTimeout(
      () => terminate(`dependency prebuild exceeded ${options.hardTimeoutMs}ms hard ceiling`),
      options.hardTimeoutMs,
    );
    hardTimer.unref?.();
    child.on('error', (error) => {
      stderr.append(`${stderr.peek() ? '\n' : ''}${String(error)}`);
      finish(-1);
    });
    child.on('close', (code, signal) => finish(code ?? -1, signal));
  });

export function parseDependencyInputFingerprintResult(output: string, expectedCandidate: string): string | null {
  const match = /DEPENDENCY_INPUT_FINGERPRINT\s+schema=1\s+candidate=([0-9a-f]{40,64})\s+input=([0-9a-f]{64})\b/i.exec(
    output,
  );
  if (!match || match[1].toLowerCase() !== expectedCandidate.toLowerCase()) return null;
  return match[2].toLowerCase();
}

/**
 * Bound on retained phase records. Real invocations emit a handful; the cap
 * exists so a pathological publisher cannot grow the routine row without limit.
 */
export const DEPENDENCY_PREBUILD_TELEMETRY_PHASE_CAP = 64;

const telemetryInt = (line: string, field: string): number | undefined => {
  const raw = new RegExp(`\\b${field}=(\\d+)\\b`).exec(line)?.[1];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const telemetryWord = (line: string, field: string): string | undefined => {
  const raw = new RegExp(`\\b${field}=([^\\s]+)`).exec(line)?.[1];
  return raw ? raw.slice(0, 200) : undefined;
};

/**
 * Lift the publisher's own PHASE/SUMMARY records out of its combined output.
 *
 * Only the writer can time its own phases, so nothing here re-derives a
 * duration: a malformed record is skipped rather than repaired, and no records
 * at all returns null so "the publisher emitted none" stays distinguishable
 * from "the producer recorded none".
 */
export function parseDependencyGenerationTelemetry(output: string): DependencyPrebuildTelemetry | null {
  const phases: DependencyPrebuildPhaseRecord[] = [];
  let summary: Omit<DependencyPrebuildTelemetry, 'schema' | 'phases'> | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (/\bPHASE\s+schema=1\b/.test(line)) {
      const phase = telemetryWord(line, 'phase');
      const outcome = telemetryWord(line, 'outcome');
      const durationMs = telemetryInt(line, 'duration_ms');
      if (!phase || !outcome || durationMs === undefined) continue;
      if (phases.length < DEPENDENCY_PREBUILD_TELEMETRY_PHASE_CAP) {
        phases.push({ phase, outcome, durationMs });
      }
      continue;
    }
    if (!/\bSUMMARY\s+schema=1\b/.test(line)) continue;
    // A later SUMMARY supersedes an earlier one: the last record the publisher
    // wrote is the one describing the generation it actually published.
    summary = {
      result: telemetryWord(line, 'result'),
      predecessor: telemetryWord(line, 'predecessor'),
      treesTotal: telemetryInt(line, 'trees_total'),
      treesReused: telemetryInt(line, 'trees_reused'),
      treesCopied: telemetryInt(line, 'trees_copied'),
      treesRemoved: telemetryInt(line, 'trees_removed'),
      totalMs: telemetryInt(line, 'total_ms'),
    };
  }
  if (!phases.length && !summary) return null;
  const telemetry: DependencyPrebuildTelemetry = { schema: 1, phases };
  if (summary) {
    if (summary.result !== undefined) telemetry.result = summary.result;
    if (summary.predecessor !== undefined) telemetry.predecessor = summary.predecessor;
    if (summary.treesTotal !== undefined) telemetry.treesTotal = summary.treesTotal;
    if (summary.treesReused !== undefined) telemetry.treesReused = summary.treesReused;
    if (summary.treesCopied !== undefined) telemetry.treesCopied = summary.treesCopied;
    if (summary.treesRemoved !== undefined) telemetry.treesRemoved = summary.treesRemoved;
    if (summary.totalMs !== undefined) telemetry.totalMs = summary.totalMs;
  }
  return telemetry;
}

/** Strictly decode persisted telemetry. Malformed telemetry is absence, never a fabricated timing. */
export function parseDependencyPrebuildTelemetry(value: unknown): DependencyPrebuildTelemetry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 1 || !Array.isArray(raw.phases)) return undefined;
  const phases: DependencyPrebuildPhaseRecord[] = [];
  for (const entry of raw.phases.slice(0, DEPENDENCY_PREBUILD_TELEMETRY_PHASE_CAP)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    const durationMs = finiteInt(record.durationMs);
    if (
      typeof record.phase !== 'string' ||
      !record.phase ||
      typeof record.outcome !== 'string' ||
      !record.outcome ||
      durationMs === null ||
      durationMs < 0
    ) {
      return undefined;
    }
    phases.push({ phase: record.phase, outcome: record.outcome, durationMs });
  }
  const telemetry: DependencyPrebuildTelemetry = { schema: 1, phases };
  for (const field of ['result', 'predecessor'] as const) {
    if (typeof raw[field] === 'string' && raw[field]) telemetry[field] = raw[field] as string;
  }
  for (const field of ['treesTotal', 'treesReused', 'treesCopied', 'treesRemoved', 'totalMs'] as const) {
    const value = finiteInt(raw[field]);
    if (value !== null && value >= 0) telemetry[field] = value;
  }
  return telemetry;
}

export function parseDependencyGenerationReadyResult(
  output: string,
  expectedInputFingerprint: string,
): Pick<DependencyPrebuildReadyState, 'identity' | 'token' | 'reused'> | null {
  const line = output.split(/\r?\n/).find((entry) => /DEPENDENCY_GENERATION_RESULT\s+schema=1\b/.test(entry));
  if (!line) return null;
  const identity = /\bidentity=([^\s]+)/.exec(line)?.[1] ?? '';
  const token = /\btoken=([^\s]+)/.exec(line)?.[1] ?? '';
  const inputFingerprint = /\binput=([0-9a-f]{64})\b/i.exec(line)?.[1] ?? '';
  if (
    !GENERATION_ID_RE.test(identity) ||
    !token ||
    inputFingerprint.toLowerCase() !== expectedInputFingerprint.toLowerCase()
  ) {
    return null;
  }
  return {
    identity,
    token,
    reused: /\breused=true\b/.test(line),
  };
}

function boundedFailure(result: DependencyPrebuildCommandResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  const suffix = detail.slice(-4_000);
  const termination = result.timedOut
    ? 'timed out'
    : result.signal
      ? `terminated by ${result.signal}`
      : `exited ${result.code}`;
  return suffix ? `${termination}: ${suffix}` : termination;
}

/** Run one candidate producer. Cross-process dedupe is the routine-state claim. */
export async function runDependencyGenerationPrebuild(
  request: DependencyPrebuildRequest,
  deps: DependencyPrebuildDeps = {},
): Promise<DependencyPrebuildRunOutcome> {
  const command = deps.command ?? runDependencyPrebuildCommand;
  const readState = deps.readState ?? readDependencyPrebuildState;
  const claimState = deps.claimState ?? claimDependencyPrebuildState;
  const heartbeatState = deps.heartbeatState ?? heartbeatDependencyPrebuildState;
  const settleState = deps.settleState ?? settleDependencyPrebuildState;
  const emitTerminal = deps.emitTerminal ?? emitDependencyPrebuildTerminal;
  const now = deps.now ?? Date.now;
  const target: DependencyPrebuildTarget = {
    workspaceId: request.workspaceId,
    installSlug: request.installSlug,
  };
  const candidate = request.candidate.toLowerCase();
  if (!FULL_COMMIT_RE.test(candidate)) {
    throw new Error(`dependency prebuild candidate is not a full commit: ${request.candidate}`);
  }
  const generationScript = join(request.toolingRoot, 'apps/operator/bin/release/dependency-generation.sh');
  const fingerprintResult = await command(
    'bash',
    [generationScript, '--integration', request.integrationRoot, '--fingerprint-ref', candidate],
    {
      cwd: request.toolingRoot,
      idleTimeoutMs: 2 * 60_000,
      hardTimeoutMs: 5 * 60_000,
    },
  );
  const inputFingerprint = parseDependencyInputFingerprintResult(
    fingerprintResult.stdout + fingerprintResult.stderr,
    candidate,
  );
  if (fingerprintResult.code !== 0 || !inputFingerprint) {
    throw new Error(`dependency prebuild could not derive exact candidate input: ${boundedFailure(fingerprintResult)}`);
  }

  const queuedAtMs = request.queuedAtMs ?? now();
  const startedAtMs = now();
  const key = dependencyPrebuildKey(candidate, inputFingerprint);
  const current = await readState(target).catch(() => null);
  if (current?.status !== 'queued' && current?.key === key) {
    if (current.status === 'ready') return 'deduped-ready';
    if (current.status === 'building' && startedAtMs - current.updatedAtMs < DEPENDENCY_PREBUILD_HARD_TIMEOUT_MS) {
      return 'deduped-building';
    }
    if (current.status === 'failed' && startedAtMs - current.completedAtMs < DEPENDENCY_PREBUILD_RETRY_COOLDOWN_MS) {
      return 'deduped-failed';
    }
  }

  let building: DependencyPrebuildBuildingState = {
    schema: 1,
    status: 'building',
    key,
    candidate,
    inputFingerprint,
    attemptId: (deps.attemptId ?? randomUUID)(),
    queuedAtMs,
    startedAtMs,
    updatedAtMs: startedAtMs,
    completedAtMs: null,
    producerPid: process.pid,
    childPid: null,
  };
  if (!(await claimState(target, building))) return 'superseded';

  // A ready selector for the same immutable inputs can be re-keyed to this
  // candidate without running the publisher. The setup consumer validates the
  // transported token again before copying.
  if (current?.status === 'ready' && current.inputFingerprint === inputFingerprint) {
    const completedAtMs = now();
    const ready: DependencyPrebuildReadyState = {
      ...building,
      status: 'ready',
      completedAtMs,
      updatedAtMs: completedAtMs,
      identity: current.identity,
      token: current.token,
      reused: true,
    };
    if (await settleState(target, ready)) await emitTerminal(target, ready);
    return 'ready';
  }

  let lastHeartbeatAtMs = building.updatedAtMs;
  const heartbeat = (patch: Partial<Pick<DependencyPrebuildBuildingState, 'childPid'>> = {}) => {
    const at = now();
    if (!patch.childPid && at - lastHeartbeatAtMs < 30_000) return;
    lastHeartbeatAtMs = at;
    building = { ...building, ...patch, updatedAtMs: at };
    void heartbeatState(target, building).catch(() => {});
  };
  const installSafeScript = join(request.toolingRoot, 'scripts/npm-install-safe.mjs');
  const result = await command(
    process.execPath,
    [
      installSafeScript,
      '--repo-root',
      request.integrationRoot,
      '--exec-under-lock',
      '--',
      'bash',
      generationScript,
      '--integration',
      request.integrationRoot,
      '--ensure-ref',
      candidate,
    ],
    {
      cwd: request.toolingRoot,
      idleTimeoutMs: DEPENDENCY_PREBUILD_IDLE_TIMEOUT_MS,
      hardTimeoutMs: DEPENDENCY_PREBUILD_HARD_TIMEOUT_MS,
      onSpawn: (pid) => heartbeat({ childPid: pid }),
      onProgress: () => heartbeat(),
    },
  );
  const completedAtMs = now();
  const publisherOutput = result.stdout + result.stderr;
  const parsed = parseDependencyGenerationReadyResult(publisherOutput, inputFingerprint);
  // The publisher's PHASE/SUMMARY records used to survive only on the failure
  // path, so a SUCCESSFUL build discarded the one timing source that can speak
  // for its own phases. Capture them on both terminal branches.
  const telemetry = parseDependencyGenerationTelemetry(publisherOutput);
  if (result.code === 0 && parsed) {
    const ready: DependencyPrebuildReadyState = {
      ...building,
      status: 'ready',
      completedAtMs,
      updatedAtMs: completedAtMs,
      ...parsed,
      // The publisher child inherits this process's env, so this is the store
      // it wrote into (WI-10004797).
      generationRoot: resolveDependencyGenerationRoot(request.integrationRoot),
      ...(telemetry ? { telemetry } : {}),
    };
    if (await settleState(target, ready)) await emitTerminal(target, ready);
    return 'ready';
  }
  const failed: DependencyPrebuildFailedState = {
    ...building,
    status: 'failed',
    completedAtMs,
    updatedAtMs: completedAtMs,
    error:
      result.code === 0 ? 'publisher completed without a matching immutable generation result' : boundedFailure(result),
    ...(telemetry ? { telemetry } : {}),
  };
  if (await settleState(target, failed)) await emitTerminal(target, failed);
  return 'failed';
}

const notifyState = pinModuleState('@papercusp/operator-core.dependency-prebuild-notify-bus', () => ({
  bus: createNotifyBus(DEPENDENCY_PREBUILD_NOTIFY_CHANNEL, 'dependency-prebuild'),
}));

export interface AwaitDependencyPrebuildOptions {
  timeoutMs?: number;
  reconcileMs?: number;
}

export interface AwaitDependencyPrebuildDeps {
  readState?: (target: DependencyPrebuildTarget) => Promise<DependencyPrebuildState | null>;
  subscribe?: (handler: (payload: string) => void) => () => void;
  now?: () => number;
}

/**
 * Push-first cross-process wait with a one-second state reconciliation backstop.
 * Subscribe-before-read closes the lost-wake window; the sweep covers a failed
 * LISTEN and keeps state (not notification delivery) authoritative.
 */
export async function awaitDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  candidate: string,
  inputFingerprint: string,
  options: AwaitDependencyPrebuildOptions = {},
  deps: AwaitDependencyPrebuildDeps = {},
): Promise<DependencyPrebuildState | null> {
  const key = dependencyPrebuildKey(candidate, inputFingerprint);
  const readState = deps.readState ?? readDependencyPrebuildState;
  const subscribe = deps.subscribe ?? ((handler) => notifyState.bus.subscribe(handler));
  const now = deps.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_PREBUILD_WAIT_MS;
  const reconcileMs = options.reconcileMs ?? DEPENDENCY_PREBUILD_RECONCILE_MS;
  const deadline = now() + timeoutMs;
  let wake: (() => void) | null = null;
  const unsubscribe = subscribe((payload) => {
    try {
      const parsed = JSON.parse(payload) as Partial<DependencyPrebuildTarget> & {
        candidate?: string;
        inputFingerprint?: string;
      };
      if (
        parsed.workspaceId !== target.workspaceId ||
        parsed.installSlug !== target.installSlug ||
        parsed.candidate?.toLowerCase() !== candidate.toLowerCase() ||
        parsed.inputFingerprint?.toLowerCase() !== inputFingerprint.toLowerCase()
      ) {
        return;
      }
    } catch {
      // An empty/legacy payload is still a valid edge: re-read authoritative state.
    }
    wake?.();
  });
  try {
    while (true) {
      const current = await readState(target);
      const currentKey = current && current.status !== 'queued' ? current.key : null;
      if (!current || currentKey !== key || current.status !== 'building') {
        return currentKey === key ? current : null;
      }
      const remaining = deadline - now();
      if (remaining <= 0) return current;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        wake = finish;
        const timer = setTimeout(finish, Math.min(reconcileMs, remaining));
        timer.unref?.();
      });
    }
  } finally {
    wake = null;
    unsubscribe();
  }
}
