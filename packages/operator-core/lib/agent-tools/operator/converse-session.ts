/**
 * Per-conversation claude-code brain session registry (WI-5071).
 *
 * WHY: operator:converse cold-spawns a fresh claude-code process for EVERY
 * chat turn. Measured live (spawn-timings, 2026-07-16): firstEvent 21.1s =
 * buildPrompt 4.8s + prep 0.4s + spawn 1.5s + 14.4s inside claude-code (MCP
 * init over the ~50-tool surface + opus TTFT on a full uncached prompt).
 * Reusing ONE claude session per conversation lets turns 2+ send only a
 * DELTA prompt (the new trigger/utterance) while the session carries the
 * verbatim history — and keeps the Anthropic prompt-cache prefix (system +
 * tools + prior turns) warm, which is where most of the 14.4s goes.
 *
 * MECHANICS: a claude session lives in claude's on-disk store under its
 * CLAUDE_CONFIG_DIR, keyed by spawn cwd. runAgentChat's `isolateDir` gives a
 * spawn a STABLE config dir (= stable cwd), so `--session-id <uuid>`
 * (create-or-resume) lands on the same session every turn. This module owns
 * the (conversationId → dir + session uuid + system-prompt hash) mapping.
 *
 * STORAGE: a `session.json` marker INSIDE the session's own directory —
 * deliberately a file, not PG (storage-policy exception, stated): the marker
 * DESCRIBES local-disk state (claude's session store in the same dir) and
 * must live-and-die with it. dir gone ⇒ marker gone ⇒ clean cold start; a PG
 * row could outlive the dir and claim a session that no longer exists.
 *
 * INVALIDATION (any ⇒ discard dir, fresh session):
 *   - system-prompt hash changed (persona/catalog/prefs edits);
 *   - marker older than MAX_SESSION_AGE_MS or more than MAX_SESSION_TURNS
 *     turns (bound context growth inside the session);
 *   - a resumed attempt produced nothing (converse's blank-turn retry calls
 *     `invalidateChatBrainSession` and re-runs cold with the full prompt).
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Re-key ~daily so a long-lived conversation doesn't pin one session forever. */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
/** Re-key after this many turns — bounds claude-side context growth. */
const MAX_SESSION_TURNS = 40;

const ROOT = () => join(homedir(), '.papercusp', 'chat-brains');

export interface ChatBrainSession {
  /** The claude `--session-id` uuid (create-or-resume). */
  sessionId: string;
  /** Stable isolate dir for runAgentChat (`isolateDir`). */
  dir: string;
  /**
   * True when the claude session already holds ≥1 completed turn — the
   * caller may send a DELTA prompt. False on a brand-new session: the first
   * turn must carry the FULL prompt (history included).
   */
  resumed: boolean;
}

interface Marker {
  sessionId: string;
  systemHash: string;
  createdAt: number;
  lastTurnAt: number;
  turnCount: number;
}

export function hashSystemPrompt(systemPromptText: string): string {
  return createHash('sha256').update(systemPromptText).digest('hex').slice(0, 32);
}

/**
 * Whether a converse turn may RESUME or MINT a reusable brain session at all
 * (before the feature flag is consulted). A reused session keeps the turn's
 * verbatim history in claude's on-disk store, and a dir is only reclaimed when
 * the SAME conversation takes another turn — so a one-off conversation's
 * content outlives the turn indefinitely. A caller whose content carries its
 * own retention policy (a phone call under D-022's 30-day rule) passes
 * `retainSession: false`, and then nothing is resumed or written regardless
 * of backend or flag (WI-10006465). Omitted ⇒ unchanged behavior.
 *
 * `isClaudeCodeBackend` is a thunk so the backend is only resolved for a turn
 * that could reuse at all (same short-circuit order as before this gate).
 */
export function brainSessionReuseEligible(input: {
  conversationId: string | null;
  isClaudeCodeBackend: () => boolean;
  retainSession?: boolean;
}): boolean {
  return Boolean(input.conversationId) && input.retainSession !== false && input.isClaudeCodeBackend();
}

/** The only dir names `dirFor` ever produces — the sweep touches nothing else. */
const SESSION_DIR_NAME = /^[0-9a-f]{24}$/;

function dirFor(conversationId: string): string {
  // Conversation ids are external input — key the dir by a hash, never the
  // raw id (path-safety).
  return join(ROOT(), createHash('sha256').update(conversationId).digest('hex').slice(0, 24));
}

function markerPath(dir: string): string {
  return join(dir, 'session.json');
}

function readMarker(dir: string): Marker | null {
  try {
    const raw = JSON.parse(readFileSync(markerPath(dir), 'utf8')) as Partial<Marker>;
    if (
      typeof raw.sessionId === 'string' &&
      typeof raw.systemHash === 'string' &&
      typeof raw.createdAt === 'number' &&
      typeof raw.lastTurnAt === 'number' &&
      typeof raw.turnCount === 'number'
    ) {
      return raw as Marker;
    }
  } catch {
    /* missing/corrupt marker ⇒ cold start */
  }
  return null;
}

function writeMarker(dir: string, marker: Marker): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath(dir), JSON.stringify(marker), 'utf8');
  } catch (err) {
    console.warn('[converse-session] marker write failed (session will cold-start next turn):', err);
  }
}

/**
 * Resolve the brain session for a conversation turn. Returns an existing,
 * still-valid session (`resumed: true` ⇒ delta prompt OK) or mints a fresh
 * one (`resumed: false` ⇒ send the full prompt this turn). Never throws.
 */
export function getChatBrainSession(conversationId: string, systemHash: string): ChatBrainSession {
  const dir = dirFor(conversationId);
  const marker = readMarker(dir);
  const now = Date.now();
  if (
    marker &&
    marker.systemHash === systemHash &&
    now - marker.createdAt < MAX_SESSION_AGE_MS &&
    marker.turnCount < MAX_SESSION_TURNS &&
    marker.turnCount > 0
  ) {
    return { sessionId: marker.sessionId, dir, resumed: true };
  }
  // Anything else — no marker, hash drift, expiry, turn cap, or a session
  // that never completed a turn — starts clean. Drop the old dir so claude's
  // store can't accumulate dead sessions.
  if (marker) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  const fresh: Marker = {
    sessionId: randomUUID(),
    systemHash,
    createdAt: now,
    lastTurnAt: now,
    turnCount: 0,
  };
  writeMarker(dir, fresh);
  return { sessionId: fresh.sessionId, dir, resumed: false };
}

/** Record a successfully completed turn (output committed) on the session. */
export function recordChatBrainTurn(conversationId: string): void {
  const dir = dirFor(conversationId);
  const marker = readMarker(dir);
  if (!marker) return;
  writeMarker(dir, { ...marker, lastTurnAt: Date.now(), turnCount: marker.turnCount + 1 });
}

/**
 * Discard the session (resume failure / blank resumed turn / caller-side
 * history reset). The next turn cold-starts with a full prompt.
 */
export function invalidateChatBrainSession(conversationId: string, reason: string): void {
  const dir = dirFor(conversationId);
  if (existsSync(dir)) {
    console.log(`[converse-session] invalidating brain session for conversation (${reason})`);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Margin past MAX_SESSION_AGE_MS before the sweep may remove a dir. A session
 * that expires while a turn is still running in it must not lose its store
 * mid-turn; one hour is far longer than any converse turn.
 */
export const CHAT_BRAIN_SWEEP_GRACE_MS = 60 * 60 * 1000;

export interface ChatBrainSweepResult {
  scanned: number;
  removed: string[];
  kept: number;
  errors: Array<{ dir: string; error: string }>;
  dryRun: boolean;
}

/**
 * Remove brain-session dirs that can never be resumed again (WI-10006551).
 *
 * `getChatBrainSession` only drops an expired dir when the SAME conversation
 * takes another turn, so a conversation that never returns keeps its
 * verbatim history on disk forever (measured: 18 dirs, oldest 81 days). A dir
 * is collectible once its marker's `createdAt` is past MAX_SESSION_AGE_MS plus
 * the grace margin: from then on `getChatBrainSession` would discard it
 * anyway, so removing it changes nothing a later turn can observe. A dir with
 * no readable marker is judged by its own mtime with the same bound. Only
 * entries named like `dirFor` output are considered.
 *
 * Driven by the hourly filesystem janitor (`dbos/periodic-workflows.ts`,
 * `sessionDirGc`). Never throws.
 */
export function sweepExpiredChatBrainSessions(opts: { now?: number; dryRun?: boolean; root?: string } = {}): ChatBrainSweepResult {
  const now = opts.now ?? Date.now();
  const root = opts.root ?? ROOT();
  const dryRun = opts.dryRun === true;
  const result: ChatBrainSweepResult = { scanned: 0, removed: [], kept: 0, errors: [], dryRun };
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return result; // no root yet ⇒ nothing to sweep
  }
  const cutoff = now - (MAX_SESSION_AGE_MS + CHAT_BRAIN_SWEEP_GRACE_MS);
  for (const name of names) {
    if (!SESSION_DIR_NAME.test(name)) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      result.scanned += 1;
      const marker = readMarker(dir);
      const startedAt = marker ? marker.createdAt : statSync(dir).mtimeMs;
      if (startedAt > cutoff) {
        result.kept += 1;
        continue;
      }
      if (!dryRun) rmSync(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch (err) {
      result.errors.push({ dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
