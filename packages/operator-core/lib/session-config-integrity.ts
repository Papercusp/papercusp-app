/**
 * session-config-integrity.ts — WI-4562 (+ WI-4617 client-awareness).
 *
 * Claude Code persists its OWN config (/model, /effort, theme, the dangerous-mode
 * prompt) by REWRITING the session's `settings.json` from its in-memory keys — and
 * the rewrite drops every key it does not own. The same class of rewrite drops
 * `mcpServers` from the session's `.claude.json`. A psu session therefore silently
 * loses, mid-flight and permanently for the life of the process:
 *
 *   - PreToolUse  pretooluse-locks-acquire.sh   → edits on the FLEET-SHARED tree take NO lock
 *   - PostToolUse posttooluse-activity-report.sh → directed peer messages are never delivered
 *     (mid-turn coord:inbox delivery is folded into this hook since EI-11405 —
 *     coordination-hook-rpc-fanout-collapse-2026-07-16; it was posttooluse-coord-inbox.sh)
 *   - UserPromptSubmit userpromptsubmit-memory.sh     → no turn-start memory recall
 *   - UserPromptSubmit userpromptsubmit-provenance.sh → no owner-vs-agent turn-provenance stamps
 *   - SessionStart (the recover hook)           → no post-compaction epoch bump, so the dedup
 *                                                 ledger keeps SUPPRESSING memories for a context
 *                                                 that no longer contains them (re-prime dead)
 *   - mcpServers['papercusp-su']                → the coordination MCP is simply gone
 *
 * WHY THIS MODULE EXISTS RATHER THAN A SELF-HEAL IN THE HOOK. Two self-heals already
 * existed (selfHealSettings / selfHealMcpConfig in interactive-claude-config.ts) and
 * repaired exactly this — but they are invoked from INSIDE the generated SessionStart
 * hook, and the damage they repair INCLUDES the deletion of that hook's own
 * registration. Once `hooks` is wiped the hook never fires again, so neither self-heal
 * can ever run: a self-heal that requires the thing it heals to be alive. It cannot be
 * fixed in place; the detector has to live somewhere that does not depend on hooks.
 * That is the operator (see coord:orient's `configIntegrity` block).
 *
 * WHAT A REPAIR ACTUALLY DOES — measured, not assumed. I first wrote that hooks are read
 * only at startup and so could not be restored in-process. That was WRONG, and the live
 * repair disproved it: rewriting settings.json re-registered the hooks for the RUNNING
 * session, and su-5d6764f9's coord inbox immediately delivered a 40+ message backlog that
 * had been silently dropped for 27h. So a repair heals the live session, not just its
 * next boot. Two things it cannot undo: a SessionStart that already passed never fires
 * again (compactions that already happened never got their memory epoch bump, so their
 * dedup ledger stays un-re-primed), and the MCP server entry is bound at connect time, so
 * papercusp-su may need a reconnect.
 *
 * The DETECTION half is still the load-bearing one: the failure is silent and
 * self-latching, and an agent that does not know it is running without edit locks, without
 * an inbox, and without recall cannot act on any of it. Silence is the actual bug.
 *
 * The global ~/.claude/settings.json is the canonical hook block (writeSessionSettings
 * copies it in at materialize). We diff the session against it rather than hard-coding a
 * hook list — a hand-copied list is exactly what rotted in EI-10793.
 *
 * WI-4617 — CLIENT AWARENESS. The failure mode above is a CLAUDE-CODE-SPECIFIC bug
 * (Claude persists its config by rewriting a Claude-shaped settings.json). Codex has
 * a totally different config surface: a per-session `$CODEX_HOME/config.toml`, and
 * `hooks.json` alongside it (see `role-codex-home.ts`). A Codex session materialized
 * by psu therefore has NO `~/.papercusp/session-claude/<ownerId>/` directory at all —
 * both `settings.json` and `.claude.json` reads return null, and the Claude-shaped
 * checker (globalSettings-hook-events minus sessionSettings-hook-events) reported
 * EVERY globally-defined hook missing plus the PSU MCP server absent. The result: a
 * healthy Codex session got a red configIntegrity block claiming its edit-locks,
 * coord inbox, and coord MCP were all dead — a spurious diagnosis of a bug that
 * cannot affect it. The client-neutral caller now gates this checker with the
 * authoritative `adv_sessions.agent` value. A recorded Codex/OMP session skips the
 * Claude-shaped check even if stale Claude files remain; a recorded Claude session
 * is still diagnosed if its whole config directory was deleted.
 *
 * WI-38349 — WHERE THE DOCUMENTS ARE IS AN OBSERVATION, NOT A FORMULA. This module
 * used to resolve the session's dir as `session-claude/<coordOwnerId>/` and read
 * two nulls out of a directory that had never existed on the dominant launch path
 * (which keys the dir by SPAWN id). Two nulls are also exactly what a wipe looks
 * like, so a healthy session — hooks firing, inbox delivering, edit-locks taking —
 * was told it was "RUNNING DE-ENROLLED … treat every edit as unprotected". Measured
 * blast radius: 78 of 98 owner ids active in a 6h window. The dir is now RESOLVED
 * (session-config-dir.ts) and an unresolvable dir yields an explicit UNKNOWN
 * verdict with no consequences — because an alarm that fires on the healthy
 * majority is how a real de-enrollment stops being believed.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSessionConfigDir,
  type SessionConfigDirResolution,
  type SessionConfigDirSource,
} from './session-config-dir';

/** The psu-owned MCP server. `playwright` is deliberately NOT restored (P-020 prunes it). */
export const PSU_MCP_SERVER = 'papercusp-su';

/** The recorded CLI that materialized a session. Unknown/legacy rows are nullable. */
export type SessionConfigClient = 'claude' | 'codex' | 'omp' | string | null | undefined;

export interface SessionConfigState {
  /** The session's CLAUDE_CONFIG_DIR settings.json (null = unreadable/absent). */
  settings: Record<string, unknown> | null;
  /** The session's .claude.json (null = unreadable/absent). */
  claudeJson: Record<string, unknown> | null;
  /** The user's global ~/.claude/settings.json — the canonical hook block. */
  globalSettings: Record<string, unknown> | null;
  /** The user's global ~/.claude.json — the canonical MCP server definitions. */
  globalClaudeJson: Record<string, unknown> | null;
  /**
   * WI-38349 — the directory `settings`/`claudeJson` were read FROM, and how it was
   * found. `null` means the session's real config dir could not be OBSERVED, so the
   * two null session documents above say nothing about the session: they are the
   * signature of reading a path that was never the session's, not of a wipe.
   */
  configDir: string | null;
  configDirSource: SessionConfigDirSource | null;
  /** Why the dir could not be observed. Non-null exactly when `configDir` is null. */
  configDirUnresolvedReason: string | null;
}

export interface ConfigIntegrityVerdict {
  /**
   * True when the check RAN and found nothing psu-owned missing.
   *
   * ⚠ `ok:false` is not the same claim in both directions: read it together with
   * `unknown`. `unknown:true` means the check could not run at all (the config dir
   * was not observable), and its `consequences` are deliberately EMPTY — an
   * un-run check must never be rendered as a de-enrollment (WI-38349).
   */
  ok: boolean;
  /** The check did not run: the session's real config dir could not be observed. */
  unknown: boolean;
  /** Why the check could not run. Non-null exactly when `unknown` is true. */
  unknownReason: string | null;
  /** Hook events present in the global block but MISSING from the session (e.g. ['PreToolUse']). */
  missingHookEvents: string[];
  /** The papercusp-su MCP server is absent from the session's .claude.json. */
  mcpServerMissing: boolean;
  /** permissions.defaultMode is no longer the bypassPermissions grant psu materialized with. */
  permissionsDowngraded: boolean;
  /** Plain-language consequences, ordered worst-first — what is ACTUALLY broken right now. */
  consequences: string[];
}

type HookMap = Record<string, unknown>;

function hooksOf(cfg: Record<string, unknown> | null): HookMap {
  const h = cfg && typeof cfg.hooks === 'object' && cfg.hooks ? (cfg.hooks as HookMap) : {};
  return h;
}

/** A hook event counts as PRESENT only if it carries at least one group (an empty array is a wipe). */
function hasHookEvent(hooks: HookMap, event: string): boolean {
  const groups = hooks[event];
  return Array.isArray(groups) && groups.length > 0;
}

/**
 * Which psu-owned pieces of a session's config have been wiped by a Claude Code
 * config rewrite. Pure — the caller supplies the four documents.
 *
 * A session whose GLOBAL settings carry no hooks at all is reported ok: there is no
 * canonical block to be missing, and we must never invent one.
 *
 * WI-38349 — a state whose `configDir` could not be observed short-circuits to an
 * UNKNOWN verdict with no consequences. Without that guard the two null session
 * documents are indistinguishable from a wipe, and the checker confidently reports
 * a healthy session as de-enrolled: "no directory at the path I assumed" is not
 * evidence about the session, only about the assumption.
 *
 * This is deliberately the Claude-shaped checker. Call
 * `checkSessionConfigIntegrityForClient` at client-neutral boundaries.
 */
export function checkSessionConfigIntegrity(state: SessionConfigState): ConfigIntegrityVerdict {
  if (state.configDir === null) {
    return {
      ok: false,
      unknown: true,
      unknownReason:
        state.configDirUnresolvedReason ??
        'the session config dir could not be observed, so nothing was checked',
      missingHookEvents: [],
      mcpServerMissing: false,
      permissionsDowngraded: false,
      consequences: [],
    };
  }
  const globalHooks = hooksOf(state.globalSettings);
  const sessionHooks = hooksOf(state.settings);

  const missingHookEvents = Object.keys(globalHooks)
    .filter((event) => hasHookEvent(globalHooks, event))
    .filter((event) => !hasHookEvent(sessionHooks, event))
    .sort();

  const globalServers =
    state.globalClaudeJson && typeof state.globalClaudeJson.mcpServers === 'object'
      ? ((state.globalClaudeJson.mcpServers as Record<string, unknown>) ?? {})
      : {};
  const sessionServers =
    state.claudeJson && typeof state.claudeJson.mcpServers === 'object'
      ? ((state.claudeJson.mcpServers as Record<string, unknown>) ?? {})
      : {};
  // Only a concern when the global actually defines it — otherwise there is nothing to restore.
  const mcpServerMissing = Boolean(globalServers[PSU_MCP_SERVER]) && !sessionServers[PSU_MCP_SERVER];

  const perms =
    state.settings && typeof state.settings.permissions === 'object'
      ? ((state.settings.permissions as Record<string, unknown>) ?? {})
      : {};
  const permissionsDowngraded = state.settings !== null && perms.defaultMode !== 'bypassPermissions';

  const consequences: string[] = [];
  // Worst first: the shared-tree lock is a DATA-LOSS hazard, not an inconvenience.
  if (missingHookEvents.includes('PreToolUse')) {
    consequences.push(
      'NO EDIT LOCKS: pretooluse-locks-acquire.sh is not registered, so your Edit/Write calls take no lock on a tree the whole fleet edits concurrently. Treat every edit as unprotected.',
    );
  }
  if (missingHookEvents.includes('PostToolUse')) {
    consequences.push(
      'NO COORD INBOX: directed peer messages are not being delivered to you. Poll them explicitly (coord:orient / coord:inbox) — do not assume silence means nobody wrote.',
    );
  }
  if (missingHookEvents.includes('UserPromptSubmit')) {
    consequences.push(
      'NO TURN-START RECALL + NO TURN-PROVENANCE: memories are not injected at turn start, and turns carry no OWNER-vs-AGENT provenance stamp (so a claimed owner directive cannot be mechanically verified).',
    );
  }
  if (missingHookEvents.includes('SessionStart')) {
    consequences.push(
      'NO POST-COMPACTION RE-PRIME: the session epoch never bumps, so the dedup ledger keeps SUPPRESSING memories already marked surfaced — for a context that no longer contains them. Recall is silently dead across compactions.',
    );
  }
  if (mcpServerMissing) {
    consequences.push(
      `NO COORDINATION MCP: mcpServers['${PSU_MCP_SERVER}'] is missing from this session's .claude.json — papercusp-su tools are unavailable in-process.`,
    );
  }
  if (permissionsDowngraded) {
    consequences.push(
      'PERMISSIONS DOWNGRADED: the bypassPermissions grant this session was materialized with is gone.',
    );
  }

  return {
    ok: missingHookEvents.length === 0 && !mcpServerMissing && !permissionsDowngraded,
    unknown: false,
    unknownReason: null,
    missingHookEvents,
    mcpServerMissing,
    permissionsDowngraded,
    consequences,
  };
}

/**
 * Gate the Claude-only integrity detector by the authoritative recorded client.
 * A positive non-Claude identity always skips, even when a stale Claude config
 * directory happens to remain on disk. Legacy/unrecorded sessions are checked
 * only when at least one Claude-shaped session document exists.
 */
export function checkSessionConfigIntegrityForClient(
  state: SessionConfigState,
  client: SessionConfigClient,
): ConfigIntegrityVerdict | null {
  if (client != null && client !== 'claude') return null;
  if (client == null && state.settings === null && state.claudeJson === null) return null;
  return checkSessionConfigIntegrity(state);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What `loadSessionConfigState` needs to LOCATE the session's config dir (WI-38349). */
export interface SessionConfigLocator {
  /** A pid that is, or parents, the session's `claude` process (`coord_presence.pid`). */
  pidHint?: number | null;
  /** The claude native session id (`adv_sessions.session_id`) — the transcript-scan key. */
  sessionId?: string | null;
  /** Injectable `/proc` root (tests). */
  procRoot?: string;
  /** Pre-resolved dir, when the caller already resolved it (skips re-resolution). */
  resolution?: SessionConfigDirResolution;
}

/**
 * Load the four documents for a psu session id from disk. Fail-soft: an unreadable
 * document reads as null. The client-aware caller decides whether null session
 * documents mean a damaged Claude session or an expected non-Claude layout.
 *
 * WI-38349 — the session's config dir is RESOLVED (see session-config-dir.ts), not
 * assumed to be `~/.papercusp/session-claude/<ownerId>/`. That formula is right on
 * the console launch path and wrong on the ones that key the dir by spawn id, and
 * assuming it turned "I looked in the wrong place" into a confident de-enrollment
 * verdict for ~80% of active sessions. When no dir can be observed the session
 * documents are left null AND `configDir` is null, which the checker renders as
 * UNKNOWN rather than as damage.
 *
 * Client identity is intentionally NOT inferred here from directory existence:
 * a deleted Claude directory is itself damage, while a stale directory can
 * survive a later Codex launch. The caller supplies the recorded session client.
 */
export function loadSessionConfigState(
  ownerId: string,
  home?: string,
  locator: SessionConfigLocator = {},
): SessionConfigState {
  const realHome = home ?? homedir();
  const resolution =
    locator.resolution ??
    resolveSessionConfigDir({
      ownerId,
      home,
      pidHint: locator.pidHint,
      sessionId: locator.sessionId,
      procRoot: locator.procRoot,
    });
  const dir = resolution.dir;
  return {
    settings: dir ? readJson(join(dir, 'settings.json')) : null,
    claudeJson: dir ? readJson(join(dir, '.claude.json')) : null,
    globalSettings: readJson(join(realHome, '.claude', 'settings.json')),
    globalClaudeJson: readJson(join(realHome, '.claude.json')),
    configDir: dir,
    configDirSource: resolution.source,
    configDirUnresolvedReason: resolution.unresolvedReason,
  };
}

export interface SessionConfigRepair {
  /** The repaired settings.json, or null when no change is needed. */
  settings: Record<string, unknown> | null;
  /** The repaired .claude.json, or null when no change is needed. */
  claudeJson: Record<string, unknown> | null;
  /** What was restored, e.g. ['hooks.PreToolUse', 'mcpServers.papercusp-su']. */
  fixed: string[];
}

/**
 * Compute the non-destructive repair: re-merge the psu-owned keys from the global
 * documents, PRESERVING every foreign key (model, theme, effortLevel, … — the keys
 * Claude Code legitimately owns). Pure; the caller writes the files.
 *
 * Restores the FULL canonical hook block, not just the SessionStart entry the old
 * in-hook self-heal knew about — a partial restore leaves the locks/inbox/memory hooks
 * dead while looking repaired.
 */
export function computeSessionConfigRepair(state: SessionConfigState): SessionConfigRepair {
  const verdict = checkSessionConfigIntegrity(state);
  if (verdict.ok) return { settings: null, claudeJson: null, fixed: [] };

  const fixed: string[] = [];
  let settings: Record<string, unknown> | null = null;
  let claudeJson: Record<string, unknown> | null = null;

  if (state.settings && (verdict.missingHookEvents.length > 0 || verdict.permissionsDowngraded)) {
    const globalHooks = hooksOf(state.globalSettings);
    const nextHooks: HookMap = { ...hooksOf(state.settings) };
    for (const event of verdict.missingHookEvents) {
      nextHooks[event] = globalHooks[event];
      fixed.push(`hooks.${event}`);
    }
    settings = { ...state.settings };
    if (verdict.missingHookEvents.length > 0) settings.hooks = nextHooks;
    if (verdict.permissionsDowngraded) {
      const perms =
        typeof state.settings.permissions === 'object' && state.settings.permissions
          ? (state.settings.permissions as Record<string, unknown>)
          : {};
      settings.permissions = { ...perms, defaultMode: 'bypassPermissions' };
      fixed.push('permissions.defaultMode');
    }
    // enableAllProjectMcpServers / statusLine are psu-materialized too; restore from
    // global only when the global HAS them (never invent a foreign statusLine).
    const g = state.globalSettings;
    if (g && settings.enableAllProjectMcpServers === undefined && g.enableAllProjectMcpServers !== undefined) {
      settings.enableAllProjectMcpServers = g.enableAllProjectMcpServers;
      fixed.push('enableAllProjectMcpServers');
    }
    if (g && settings.statusLine === undefined && g.statusLine !== undefined) {
      settings.statusLine = g.statusLine;
      fixed.push('statusLine');
    }
  }

  if (state.claudeJson && verdict.mcpServerMissing) {
    const globalServers = (state.globalClaudeJson?.mcpServers ?? {}) as Record<string, unknown>;
    const sessionServers =
      typeof state.claudeJson.mcpServers === 'object' && state.claudeJson.mcpServers
        ? (state.claudeJson.mcpServers as Record<string, unknown>)
        : {};
    claudeJson = {
      ...state.claudeJson,
      // ONLY the psu server — never re-add `playwright`, which P-020 prunes on purpose.
      mcpServers: { ...sessionServers, [PSU_MCP_SERVER]: globalServers[PSU_MCP_SERVER] },
    };
    fixed.push(`mcpServers.${PSU_MCP_SERVER}`);
  }

  return { settings, claudeJson, fixed };
}

export interface SessionConfigRepairResult {
  /** True when a broken config was detected AND at least one file was rewritten. */
  repaired: boolean;
  /** What was restored — the same slugs as SessionConfigRepair.fixed (e.g. ['hooks.PreToolUse']). */
  fixed: string[];
  /** File basenames rewritten on disk (e.g. ['settings.json', '.claude.json']). */
  wrote: string[];
  /** Anything the RE-READ still reports broken — should be empty on a clean repair; non-empty means the write did not take. */
  stillBroken: string[];
  /**
   * WI-38349 — why the repair did not RUN, when it did not. `repaired:false` with an
   * empty `stillBroken` is otherwise ambiguous, and the caller's warning said "see
   * stillBroken" while pointing at an empty list. Null means the repair ran.
   */
  skipped: string | null;
  /**
   * The two things a disk write genuinely cannot undo, surfaced so the caller never
   * over-claims a full heal: a SessionStart that already passed never re-fires (so
   * compactions that already happened never got their epoch bump), and the MCP entry
   * is bound at connect time (papercusp-su may need a reconnect). Present only when
   * the corresponding piece was among what we just restored.
   */
  residualCaveats: string[];
}

/**
 * The fs-write half of the repair: load the four documents, compute the non-destructive
 * repair, write only the files that changed (keeping the clobbered original as a
 * `*.pre-wi4562.bak`), then RE-READ and re-check so the result reflects disk truth rather
 * than intent. Fail-soft: a write error is caught and reported as stillBroken, never thrown
 * — a config repair must not be able to break the orientation call that invokes it.
 *
 * This is what makes coord:orient auto-repair rather than only warn. It is safe to call on a
 * healthy session (returns repaired:false, writes nothing) and is idempotent.
 */
export function repairSessionConfigOnDisk(
  ownerId: string,
  home?: string,
  client?: SessionConfigClient,
  locator: SessionConfigLocator = {},
): SessionConfigRepairResult {
  const state = loadSessionConfigState(ownerId, home, locator);
  const noop = (skipped: string): SessionConfigRepairResult => ({
    repaired: false,
    fixed: [],
    wrote: [],
    stillBroken: [],
    residualCaveats: [],
    skipped,
  });

  const verdict = checkSessionConfigIntegrityForClient(state, client);
  if (verdict === null) {
    return noop('not diagnosable for this client (recorded non-Claude, or a legacy session with no Claude-shaped documents)');
  }
  // WI-38349: a repair may only ever write into an OBSERVED directory. Writing to the
  // conventional path when nothing was found there does not heal anything — it
  // materializes a `su-<coordOwnerId>/` directory no process reads, while the session's
  // real dir stays untouched. Refuse, and say so.
  const dir = state.configDir;
  if (dir === null) {
    return noop(`config dir not observable — ${state.configDirUnresolvedReason ?? 'unresolved'}`);
  }
  if (verdict.ok) return noop('nothing broken');
  const repair = computeSessionConfigRepair(state);

  if (repair.fixed.length === 0) {
    return noop(
      'nothing repairable on disk: the session documents themselves are missing, so there is no file to re-merge psu keys into',
    );
  }

  const wrote: string[] = [];
  const stillBroken: string[] = [];
  const targets: Array<[string, Record<string, unknown> | null]> = [
    ['settings.json', repair.settings],
    ['.claude.json', repair.claudeJson],
  ];
  for (const [name, next] of targets) {
    if (!next) continue;
    const path = join(dir, name);
    try {
      if (existsSync(path)) copyFileSync(path, `${path}.pre-wi4562.bak`); // keep the clobbered original
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
      wrote.push(name);
    } catch (err) {
      stillBroken.push(`${name}: ${(err as Error).message}`);
    }
  }

  // Disk truth, not intent: re-read and re-check — from the SAME resolved dir, so the
  // re-read cannot silently answer about a different directory than the write touched.
  const after = checkSessionConfigIntegrityForClient(
    loadSessionConfigState(ownerId, home, { ...locator, resolution: { dir, source: state.configDirSource, tried: [], unresolvedReason: null } }),
    client,
  );
  if (after && !after.ok) {
    for (const ev of after.missingHookEvents) stillBroken.push(`hooks.${ev}`);
    if (after.mcpServerMissing) stillBroken.push(`mcpServers.${PSU_MCP_SERVER}`);
    if (after.permissionsDowngraded) stillBroken.push('permissions.defaultMode');
  }

  const residualCaveats: string[] = [];
  if (repair.fixed.includes('hooks.SessionStart')) {
    residualCaveats.push(
      'A SessionStart that already passed cannot be re-fired: any compaction that already happened never got its memory epoch bump, so that context stays un-re-primed. Future compactions will re-prime normally now.',
    );
  }
  if (repair.fixed.includes(`mcpServers.${PSU_MCP_SERVER}`)) {
    residualCaveats.push(
      `mcpServers.${PSU_MCP_SERVER} is restored on disk, but the MCP connection is bound at connect time — it may need a reconnect to become available in-process.`,
    );
  }

  return { repaired: wrote.length > 0, fixed: repair.fixed, wrote, stillBroken, residualCaveats, skipped: null };
}
