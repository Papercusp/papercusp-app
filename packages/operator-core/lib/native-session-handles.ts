import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import type { TurnBackend } from '@papercusp/papercusp-shared/agent';
import type { AdvSessionRow } from './adv-sessions';
import { interactiveBackendFromSpawnBackend, type InteractiveBackend, type SpawnBackendLike } from './backend-feature-capabilities';
import { ompAgentHomeForSessionKey } from './session-transcript-resolvers';
import {
  resolveSessionConfigDir,
  type ResolveSessionConfigDirOptions,
  type SessionConfigDirResolution,
  type SessionConfigDirSource,
} from './session-config-dir';

export type NativeSessionSource = 'adv_sessions' | 'spawned_agents';

export interface ClaudeNativeSessionHandle {
  backend: 'claude';
  source: NativeSessionSource;
  ownerId: string | null;
  sessionId: string | null;
  /** The per-session CLAUDE_CONFIG_DIR the transcript ACTUALLY lives under, as
   *  OBSERVED by {@link resolveSessionConfigDir} (live process → transcript scan →
   *  a conventional path that exists). A bare `claude --resume <sessionId>` looks
   *  in the DEFAULT config dir and finds nothing — every attach (dock bee pane,
   *  hive tab) must run with CLAUDE_CONFIG_DIR set to THIS dir, mirroring what the
   *  codex handle's `codexHome` already carries.
   *
   *  ⚠ WI-38369: `null` means UNKNOWN — NOT "de-enrolled", and NOT an invitation to
   *  fall back to `sessionClaudeConfigDir(ownerId)`. That formula holds only on the
   *  console launch path; the orchestrator/hive path keys the dir by the minted
   *  SPAWN id and a carry-respawn keeps the original dir, so it was wrong for 82 of
   *  100 live sessions measured 2026-08-13. A consumer that cannot proceed without a
   *  dir must degrade (see `configDirUnresolvedReason`), never guess: writing to a
   *  guessed dir materializes a transcript the live process will never read. */
  configDir: string | null;
  /** Which strategy observed `configDir`; null exactly when `configDir` is null. */
  configDirSource: SessionConfigDirSource | null;
  /** Why `configDir` is unknown; non-null exactly when `configDir` is null. */
  configDirUnresolvedReason: string | null;
  exactResumeSupported: boolean;
  missingReason: string | null;
}

export interface CodexNativeSessionHandle {
  backend: 'codex';
  source: NativeSessionSource;
  ownerId: string | null;
  codexHome: string;
  rolloutId: string | null;
  exactResumeSupported: boolean;
  missingReason: string | null;
}

export interface OmpNativeSessionHandle {
  backend: 'omp';
  source: NativeSessionSource;
  ownerId: string | null;
  ompThreadId: string | null;
  agentHome: string | null;
  exactResumeSupported: boolean;
  missingReason: string | null;
}

export type NativeSessionHandle =
  | ClaudeNativeSessionHandle
  | CodexNativeSessionHandle
  | OmpNativeSessionHandle;

export interface NativeSessionDeps {
  codexHomeForSessionKey?: (sessionKey: string | number) => string;
  findCodexRolloutId?: (codexHome: string) => string | null;
  ompAgentHome?: (sessionKey: string | number) => string | null;
  /** WI-38369: injectable config-dir resolution (tests / a caller with a cached answer). */
  resolveConfigDir?: (opts: ResolveSessionConfigDirOptions) => SessionConfigDirResolution;
  /**
   * WI-38369: `coord_presence.pid` for this session, when the caller has it. Enables the
   * cheapest and most authoritative strategy (read `CLAUDE_CONFIG_DIR` off the live
   * process). Omitted is fine — the transcript scan resolves an ended session too.
   */
  pidHint?: number | null;
}

/**
 * WI-38369: the three `configDir*` fields of a claude handle, resolved by OBSERVATION.
 *
 * Replaces `configDir: sessionClaudeConfigDir(ownerId)` — a FORMULA that only the console
 * launch path follows. The orchestrator/hive path names the dir after the minted spawn id
 * and a carry-respawn keeps the original, so the formula named a never-existent directory
 * for 82 of 100 live sessions measured 2026-08-13. It did not merely mislead: the dossier's
 * rematerialize step passes this value as `targetRoot`, so a wrong dir got a transcript
 * WRITTEN into it that the live process never reads.
 *
 * `altOwnerIds` carries the spawn id because a spawned agent's two identities differ and
 * only one of them is a directory name — `ownerId` must stay the coord owner id so the
 * live-process strategy's `PAPERCUSP_SID` guard can still reject a recycled pid.
 */
function claudeConfigDirFields(
  args: { ownerId: string | null; sessionId: string | null; altOwnerIds?: (string | null | undefined)[] },
  deps: NativeSessionDeps,
): Pick<ClaudeNativeSessionHandle, 'configDir' | 'configDirSource' | 'configDirUnresolvedReason'> {
  if (!args.ownerId) {
    return {
      configDir: null,
      configDirSource: null,
      configDirUnresolvedReason: 'owner id is not recorded, so no config dir can be resolved',
    };
  }
  const resolution = (deps.resolveConfigDir ?? resolveSessionConfigDir)({
    ownerId: args.ownerId,
    sessionId: args.sessionId,
    pidHint: deps.pidHint,
    altOwnerIds: args.altOwnerIds,
  });
  return {
    configDir: resolution.dir,
    configDirSource: resolution.source,
    configDirUnresolvedReason: resolution.unresolvedReason,
  };
}

export function nativeSessionHandleForAdvSession(
  row: AdvSessionRow,
  deps: NativeSessionDeps = {},
): NativeSessionHandle | null {
  const ownerId = row.coordOwnerId;
  if (row.agent === 'claude') {
    return {
      backend: 'claude',
      source: 'adv_sessions',
      ownerId,
      sessionId: row.sessionId,
      ...claudeConfigDirFields({ ownerId, sessionId: row.sessionId }, deps),
      exactResumeSupported: Boolean(row.sessionId),
      missingReason: row.sessionId ? null : 'claude session_id is not recorded',
    };
  }
  if (row.agent === 'codex') {
    const home = (deps.codexHomeForSessionKey ?? codexHomeForSessionKey)(row.id);
    const rolloutId = deps.findCodexRolloutId?.(home) ?? null;
    return {
      backend: 'codex',
      source: 'adv_sessions',
      ownerId,
      codexHome: home,
      rolloutId,
      exactResumeSupported: Boolean(rolloutId),
      missingReason: rolloutId ? null : 'codex rollout id is not recorded under CODEX_HOME yet',
    };
  }
  if (row.agent === 'omp') {
    return {
      backend: 'omp',
      source: 'adv_sessions',
      ownerId,
      ompThreadId: row.ompThreadId,
      // Tracked OMP launches isolate their store by ADV ROW, not by the
      // ambient process's PI_CODING_AGENT_DIR. Using the shared default here
      // made the adapter search ~/.omp while the live session wrote under
      // ~/.papercusp/su-omp-homes/session-<row>/agent.
      agentHome: (deps.ompAgentHome ?? ompAgentHomeForSessionKey)(row.id),
      exactResumeSupported: Boolean(row.ompThreadId),
      missingReason: row.ompThreadId ? null : 'omp thread id is not linked yet',
    };
  }
  return null;
}

export interface SpawnedAgentNativeSessionInput {
  spawnId: string;
  sessionOwner?: string | null;
  backend: TurnBackend | SpawnBackendLike;
  sessionId?: string | null;
  codexHome?: string | null;
  rolloutId?: string | null;
  ompThreadId?: string | null;
  agentHome?: string | null;
}

function normalizeSpawnBackend(backend: TurnBackend | SpawnBackendLike): InteractiveBackend {
  return interactiveBackendFromSpawnBackend(backend === 'anthropic-direct' ? 'anthropic-direct' : backend);
}

export function nativeSessionHandleForSpawnedAgent(
  row: SpawnedAgentNativeSessionInput,
  deps: NativeSessionDeps = {},
): NativeSessionHandle {
  const ownerId = row.sessionOwner ?? row.spawnId;
  const backend = normalizeSpawnBackend(row.backend);
  if (backend === 'claude') {
    return {
      backend: 'claude',
      source: 'spawned_agents',
      ownerId,
      sessionId: row.sessionId ?? null,
      // The spawn id is the key the orchestrator actually names this dir by, and it
      // differs from `ownerId` exactly when `sessionOwner` is set — so pass it as an
      // alternate CONVENTIONAL key while `ownerId` stays the live-process sid guard.
      ...claudeConfigDirFields(
        { ownerId, sessionId: row.sessionId ?? null, altOwnerIds: [row.spawnId] },
        deps,
      ),
      exactResumeSupported: Boolean(row.sessionId),
      missingReason: row.sessionId ? null : 'spawned Claude agent has no session_id',
    };
  }
  if (backend === 'codex') {
    const codexHome = row.codexHome ?? '';
    return {
      backend: 'codex',
      source: 'spawned_agents',
      ownerId,
      codexHome,
      rolloutId: row.rolloutId ?? null,
      exactResumeSupported: Boolean(codexHome && row.rolloutId),
      missingReason:
        codexHome && row.rolloutId
          ? null
          : 'spawned Codex agent has no durable CODEX_HOME/rollout handle recorded',
    };
  }
  return {
    backend: 'omp',
    source: 'spawned_agents',
    ownerId,
    ompThreadId: row.ompThreadId ?? null,
    agentHome: row.agentHome ?? null,
    exactResumeSupported: Boolean(row.ompThreadId),
    missingReason: row.ompThreadId ? null : 'spawned OMP agent has no thread id recorded',
  };
}

/**
 * EI-308 gap 2 / WI-5226: an ENDED claude session's transcript is deleted by the
 * archive-at-death hook within ~15s of turn end (independent of session-dir-gc's
 * later whole-dir sweep) — so by the time a human opens the dossier and copies the
 * `claude --resume` command it hands back, the file the command needs is almost
 * always already gone, and the command ENOENTs despite the dossier claiming "exact
 * resume: supported". The async caller (adv-agent-detail.ts) checks the real disk
 * state and best-effort rematerializes from the archive BEFORE trusting the handle;
 * this is the PURE outcome-decision half of that (no I/O), kept separate so it is
 * unit-tested without a real fs/PG.
 *
 * Returns `handle` unchanged when the transcript is present on disk (either it
 * always was, or the rematerialize attempt just restored it); otherwise downgrades
 * `exactResumeSupported` so the UI never hands out a command that will ENOENT.
 */
export function claudeHandleAfterRematerializeAttempt(
  handle: ClaudeNativeSessionHandle,
  opts: { presentOnDisk: boolean; rematerialized: boolean; rematReason?: string },
): ClaudeNativeSessionHandle {
  if (opts.presentOnDisk || opts.rematerialized) return handle;
  return {
    ...handle,
    exactResumeSupported: false,
    missingReason:
      'session transcript was cleaned up and could not be restored' +
      (opts.rematReason ? ` (${opts.rematReason})` : ''),
  };
}
