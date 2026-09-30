/** Runtime authority for one Codex session's automatic file-lock hook. */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CodexLockMode = 'automatic' | 'manual';
export type CodexLockHookHealth = 'verified' | 'configured-unverified' | 'unhealthy' | 'stale' | 'missing';

export interface CodexLockRuntimeVerdict {
  lockMode: CodexLockMode;
  hookHealth: CodexLockHookHealth;
  runtimeProbed: boolean;
  ownerId: string;
  hooksConfigured: boolean;
  lastDecisionAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  generation: number;
  reason: string;
  effectiveInstruction: string;
}

type Marker = Record<string, unknown>;
const DEFAULT_FRESH_MS = 24 * 60 * 60 * 1_000;

export function codexLockOwnerMarkerName(ownerId: string, kind: 'decision' | 'success' | 'error'): string {
  const safe = ownerId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'unknown';
  return `owner-${safe}-last-${kind}.json`;
}

function readMarker(path: string): Marker | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Marker) : null;
  } catch {
    return null;
  }
}

function markerTs(marker: Marker | null): { iso: string | null; ms: number } {
  const iso = typeof marker?.ts === 'string' ? marker.ts : null;
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return { iso, ms: Number.isFinite(ms) ? ms : 0 };
}

/**
 * Fail closed: hooks merely existing on disk is not runtime proof. Automatic mode
 * requires an owner-scoped successful decision from the hook, newer than any
 * owner-scoped error, and still fresh. Until then the session uses explicit locks.
 */
export function readCodexLockRuntimeVerdict(input: {
  ownerId: string;
  hooksConfigured: boolean;
  cacheDir?: string;
  nowMs?: number;
  freshMs?: number;
}): CodexLockRuntimeVerdict {
  const cacheDir = input.cacheDir ?? process.env.PAPERCUSP_LOCKS_CACHE_DIR ?? join(homedir(), '.papercusp/locks-cache');
  const decision = readMarker(join(cacheDir, codexLockOwnerMarkerName(input.ownerId, 'decision')));
  const success = readMarker(join(cacheDir, codexLockOwnerMarkerName(input.ownerId, 'success')));
  const error = readMarker(join(cacheDir, codexLockOwnerMarkerName(input.ownerId, 'error')));
  const decisionTs = markerTs(decision);
  const successTs = markerTs(success);
  const errorTs = markerTs(error);
  const nowMs = input.nowMs ?? Date.now();
  const freshMs = input.freshMs ?? DEFAULT_FRESH_MS;
  const decisionOwner = typeof decision?.owner === 'string' ? decision.owner : null;
  const decisionMatches = decisionOwner === input.ownerId && decisionTs.ms > 0;
  const successAfterError = successTs.ms > 0 && successTs.ms >= errorTs.ms;
  const fresh = decisionTs.ms > 0 && nowMs - decisionTs.ms <= freshMs;
  const runtimeProbed = decisionMatches && successAfterError;

  let hookHealth: CodexLockHookHealth;
  if (!input.hooksConfigured) hookHealth = 'missing';
  else if (errorTs.ms > successTs.ms) hookHealth = 'unhealthy';
  else if (!runtimeProbed) hookHealth = 'configured-unverified';
  else if (!fresh) hookHealth = 'stale';
  else hookHealth = 'verified';

  const lockMode: CodexLockMode = hookHealth === 'verified' ? 'automatic' : 'manual';
  const reason =
    hookHealth === 'verified'
      ? 'This exact Codex owner has a fresh successful automatic lock decision newer than its last hook error.'
      : hookHealth === 'missing'
        ? 'This Codex home has no managed lock-hook configuration.'
        : hookHealth === 'unhealthy'
          ? 'This owner’s latest lock-hook error is newer than its latest success.'
          : hookHealth === 'stale'
            ? 'This owner’s last successful automatic lock decision is stale.'
            : 'Hooks are configured, but this exact Codex owner has not produced a successful runtime decision yet.';
  const effectiveInstruction =
    lockMode === 'automatic'
      ? 'Do not acquire per-edit file locks manually; the verified PreToolUse hook acquires/releases them. Use locks:acquire only for a deliberate multi-file hold.'
      : 'Before every file edit, explicitly call locks:acquire and release the returned lock after the atomic edit; do not assume a hook covered it.';
  const generation = Math.max(decisionTs.ms, successTs.ms, errorTs.ms, existsSync(cacheDir) ? 1 : 0);

  return {
    lockMode,
    hookHealth,
    runtimeProbed,
    ownerId: input.ownerId,
    hooksConfigured: input.hooksConfigured,
    lastDecisionAt: decisionTs.iso,
    lastSuccessAt: successTs.iso,
    lastErrorAt: errorTs.iso,
    generation,
    reason,
    effectiveInstruction,
  };
}
