/**
 * role-codex-home.ts — materialize a per-session CODEX_HOME for an
 * INTERACTIVE codex role session (psu --role=<role> --agent=codex).
 *
 * codex has no `--append-system-prompt` / `--mcp-config` flags: its system
 * prompt is `$CODEX_HOME/AGENTS.md` and its MCP servers are declared in
 * `$CODEX_HOME/config.toml`. So a codex role session needs a dedicated
 * CODEX_HOME, exactly like the `codex-su` wrapper uses for the SU playbook
 * (install-standalone-mcp.sh §4f) — but per-session and role-scoped.
 *
 * This mirrors the orchestrator's `writeSignedSpawnCodexHome`
 * (libs/papercusp/.../spawn-mcp.ts) with one deliberate difference: it
 * consumes an ALREADY-SIGNED url (from `buildRoleLaunchSpec`, the same
 * signed role-scoped url claude/omp role sessions get) instead of signing
 * its own params. All three backends therefore share one signed url per
 * session — the dispatch layer enforces the role allowlist identically
 * (D-001).
 *
 * Layout:
 *   $CODEX_HOME/AGENTS.md     — the role prompt (codex's instruction file)
 *   $CODEX_HOME/config.toml   — [mcp_servers.papercusp] url = "<signed>"
 *                               (sig-auth; no bearer, unlike codex-su)
 *   $CODEX_HOME/auth.json     — symlink → ~/.codex/auth.json (shared
 *                               ChatGPT OAuth; a SYMLINK so token rotation
 *                               happens in-place and never diverges from
 *                               the real login — copying would risk a
 *                               single-use refresh-token logout).
 *
 * KNOWN GAP (D-002, owner-inbox-single-pane-2026-07-17): codex's hook
 * surface is PreToolUse/PostToolUse ONLY — there is no turn_end/Stop
 * equivalent event today (an upstream `notify` turn-complete channel is
 * reportedly available but UNVERIFIED against our pin). That means the
 * su convention "an owner-directed question must ride a durable channel"
 * (coord:escalate w/ options, or an `<ask>` block at minimum) cannot be
 * enforced or even soft-nudged for a Codex role session the way Claude's
 * Stop-bounce or OMP's turn_end capture+followUp can — it is
 * convention-only here, backstopped only by the transcript watcher (P-002)
 * detecting a pending owner-gate after the fact. This is a RECORDED
 * decision, not a bug to file later — see
 * /internal/docs/agent-insights/su-owner-ask-capability-matrix for the full
 * per-client matrix. Re-evaluate if codex ever ships a genuine turn-end hook.
 *
 * Server-only.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  codexHomeForSessionKey,
  codexSqliteHomeForSessionKey,
} from '@papercusp/orchestrator/session-launch-dirs';
import {
  codexGatewayConfigToml,
  codexManagedFeaturesToml,
  tomlEscape,
} from '@papercusp/orchestrator/codex-gateway-config';
import { readCodexLockRuntimeVerdict, type CodexLockRuntimeVerdict } from './codex-lock-runtime';
import { lintInstructionText, type InstructionLintReport, type InstructionRuntimeContext } from './instruction-lint';
import {
  codexContextConfigToml,
  codexModelConfigToml,
  resolveCodexModel,
} from './model-context-budget.mjs';

import { dirname as __esmDirname } from 'node:path';
import { fileURLToPath as __esmFileURLToPath } from 'node:url';

// ESM-safe __dirname (plugin-host-runtime.ts pattern): bare __dirname is
// UNDEFINED under tsx file-mode in this type:module package — referencing it
// throws at import (top-level) or call time. This class of bug killed DBOS
// routines fleet-wide on the 2026-06-12 05:30 deploy (change-ledger-scan).
const __dirname = __esmDirname(__esmFileURLToPath(import.meta.url));

export interface RoleCodexHome {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** Fast, session-keyed directory configured as Codex's `sqlite_home`. */
  sqliteHome: string;
  /** The AGENTS.md (role prompt) path — diagnostics. */
  agentsPath: string;
  /** The config.toml (role-scoped MCP) path — diagnostics. */
  configPath: string;
  /** Lint of the exact AGENTS.md written after runtime lock-mode resolution. */
  instructionLint: InstructionLintReport;
}

// ── Shared codex-home internals (role + su) ───────────────────────────

/** codex's file-edit tool is `apply_patch` (canonical); `Edit`/`Write` are
 *  documented matcher aliases. (developers.openai.com/codex/hooks, PR #18391) */
const CODEX_LOCK_PRE_MATCHER = 'apply_patch|Edit|Write';
/** EI-211603: a failed code-mode `apply_patch` can omit its nested
 *  PostToolUse event. The parent code-mode call still completes, so the
 *  release hook also observes its canonical/compatibility aliases and can
 *  recover only the cached lock paths named in that parent's source. */
const CODEX_LOCK_POST_MATCHER = `^(?:${CODEX_LOCK_PRE_MATCHER}|exec|functions\\.exec|functions__exec)$`;
/** The shared content guard understands both Codex's raw apply_patch payload and
 * the Claude-compatible edit/write aliases projected by MCP servers. */
const CODEX_CONTROL_BYTES_PRE_MATCHER =
  '^(?:apply_patch|Edit|Write|MultiEdit|mcp__.*__capability_(?:edit|write|multi_?edit))$';
/** Full Write/capability:write inputs carry the complete requested content, so
 * the shared PostToolUse guard can compare exact UTF-8 bytes on disk. */
const CODEX_WRITE_BYTE_INTEGRITY_MATCHER = '^(?:Write|mcp__.*__capability_write)$';

/**
 * TOML preamble baked into EVERY per-session codex home (psu-isolation P-004 /
 * D-001) — isolate a psu codex session from the launching user's project doc +
 * codex's native memory, so it is steered ONLY by the home's AGENTS.md (the psu
 * playbook + the P-001 project-guide splice) and uses the hybrid `memory:*` MCP.
 *
 *  - `project_doc_max_bytes = 0` — codex otherwise reads `<cwd>/AGENTS.md` (on the
 *    papercup tree that's a symlink to `CLAUDE.md` = the project guide) and merges
 *    it into instructions. Now redundant: the guide reaches the session via the
 *    home's AGENTS.md. Capping at 0 drops the cwd read — a single delivery path,
 *    consistent with the claude/omp isolation.
 *  - `[features] memories = false` — disable codex's native memory tool so the
 *    agent doesn't read/write the native `memories_*.sqlite` store and instead uses
 *    `memory:*`. (Cross-session that store is ALSO neutralized by `freshCodexHome`
 *    wiping the home each launch; this stops within-session use.) The flag was
 *    `memory_tool` through codex 0.137; codex 0.142 renamed it to `memories` and
 *    `memory_tool` is now a deprecated legacy alias that prints a boot warning
 *    (`codex doctor`: "legacy alias memory_tool -> memories"). We write the modern
 *    `memories` key — verified valid under `codex --strict-config` on 0.142.5.
 *  - `[features] remote_compaction_v2 = false` — Codex 0.147 enables native
 *    remote compaction by default. Papercusp owns the semantic stopping point,
 *    carry note, and session restart, so a native cut would bypass the durable
 *    handoff and must not race the managed path (agent-managed-compaction D-011).
 *
 * Must precede any `[table]` (TOML top-level keys before tables); the `[mcp_servers]`
 * table each writer appends comes after.
 */
function codexIsolationPreamble(headless = false): string {
  return [
    '# psu prompt isolation (P-004 / D-001): no cwd AGENTS.md read; native memory off.',
    'project_doc_max_bytes = 0',
    '',
    ...codexManagedFeaturesToml({ headless }),
  ].join('\n');
}

const CODEX_LOCK_GUIDANCE_RE =
  /<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-START -->[\s\S]*?<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-END -->/g;

function codexLockEnforcementNote(verdict: CodexLockRuntimeVerdict): string {
  const marker = verdict.lockMode === 'automatic' ? 'automatic-hooks' : 'explicit-manual';
  return [
    '---',
    '## Codex Lock Enforcement Status',
    '',
    `<!-- papercusp-rule:file-locking=${marker} -->`,
    `- **Effective lockMode:** \`${verdict.lockMode}\` (hook health: \`${verdict.hookHealth}\`; runtimeProbed: \`${verdict.runtimeProbed}\`; generation: \`${verdict.generation}\`).`,
    `- **Effective instruction:** ${verdict.effectiveInstruction}`,
    `- **Why:** ${verdict.reason}`,
    '- **Resync:** `coord:orient.codexLocks` is authoritative after launch. Replace this snapshot when its generation changes; never merge automatic and manual instructions.',
    '',
  ].join('\n');
}

// The gateway config-TOML builder + tomlEscape are SHARED with the spawned-agent path
// (orchestrator's spawn-mcp.ts writeSignedSpawnCodexHome) via the package's
// `@papercusp/orchestrator/codex-gateway-config` subpath export (imported above) — WI-3645:
// the two local copies had drifted (this one still REQUIRED an account pin, which is why
// interactive `auto` stayed unwired for codex). One builder, one behavior: a pin renders the
// x-papercusp-account header; `gatewayOn` without a pin renders the SAME provider block with
// the header omitted (the gateway auto-selects); neither renders nothing.

/** Single-quote a value for a shell command (env prefix). */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Workspace root the lock hooks scope to — the parent of the harness
 *  worktrees. Honors PAPERCUSP_WORKSPACE_ROOT (matches the installer's
 *  explicit set); else 4 dirs up from this module (apps/operator/lib →
 *  …/papercupai-workspace), which is also the hook script's own default. */
function resolveWorkspaceRoot(): string {
  return process.env.PAPERCUSP_WORKSPACE_ROOT || resolve(__dirname, '..', '..', '..', '..');
}

/** Rebuild a per-session codex home dir fresh + share the ChatGPT OAuth
 *  login via a SYMLINK (never a copy — a copied single-use refresh token
 *  can log the user out). Returns the home path. */
function freshCodexHome(codexHome: string): string {
  rmSync(codexHome, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });
  inheritUserCodexHome(codexHome);
  ensureCodexSkillWatchRoots({ codexHome });
  return codexHome;
}

/** Rebuild the disposable/high-write SQLite companion for a fresh launch. */
function freshCodexSqliteHome(sessionKey: string | number): string {
  const sqliteHome = codexSqliteHomeForSessionKey(sessionKey);
  rmSync(sqliteHome, { recursive: true, force: true });
  mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  return sqliteHome;
}

/** The system skills root Codex reads. Creating it needs root, so host setup provisions it. */
export const CODEX_SYSTEM_SKILLS_DIR = '/etc/codex/skills';

export interface CodexSkillWatchRoots {
  /** `<CODEX_HOME>/skills` — a symlink to ~/.codex/skills when that exists, else an empty dir. */
  codexHomeSkillsDir: string;
  codexHomeSkillsReady: boolean;
  /** `~/.agents/skills` — user-writable, created here. */
  userSkillsDir: string;
  userSkillsReady: boolean;
  /** `/etc/codex/skills` — only reported; a missing one makes every Codex session watch /etc. */
  systemSkillsDir: string;
  systemSkillsReady: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * EI-21417256075155406 (measured 2026-10-01, codex-cli 0.159.3): Codex's skills watcher
 * watches each skills root, and for a MISSING root it watches the nearest existing ancestor
 * with an inotify mask that includes IN_OPEN. A missing /etc/codex/skills therefore puts a
 * watch on /etc, and every process start anywhere on the host (each opens /etc/ld.so.cache)
 * wakes every Codex session; a missing ~/.agents/skills or <CODEX_HOME>/skills does the same
 * for $HOME / the busy Codex home. On a 128-core agent host this held idle sessions at
 * ~1/3 core each; creating the roots dropped them to ~0.1%. Creating the roots as empty
 * directories pins the watches onto quiet directories. Best-effort and never throws.
 */
export function ensureCodexSkillWatchRoots(
  opts: { codexHome?: string; home?: string; systemSkillsDir?: string } = {},
): CodexSkillWatchRoots {
  const codexHomeSkillsDir = join(opts.codexHome ?? join(opts.home ?? homedir(), '.codex'), 'skills');
  const userSkillsDir = join(opts.home ?? homedir(), '.agents', 'skills');
  const systemSkillsDir = opts.systemSkillsDir ?? CODEX_SYSTEM_SKILLS_DIR;
  for (const dir of [codexHomeSkillsDir, userSkillsDir]) {
    if (isDirectory(dir)) continue;
    try {
      // A dangling inherited symlink would make mkdir fail; replace it with a real dir.
      if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(dir);
      mkdirSync(dir, { recursive: true });
    } catch {
      /* reported below as not ready */
    }
  }
  return {
    codexHomeSkillsDir,
    codexHomeSkillsReady: isDirectory(codexHomeSkillsDir),
    userSkillsDir,
    userSkillsReady: isDirectory(userSkillsDir),
    systemSkillsDir,
    systemSkillsReady: isDirectory(systemSkillsDir),
  };
}

/** EI-11366: the sid `writeSuCodexHome` last stamped at this codexHome path
 *  (its `.owner-sid` sentinel), or null when absent/unreadable — an old home
 *  written before this guard existed, a `writeRoleCodexHome` home (no
 *  sentinel), or a path that doesn't exist yet. Pure fs read, never throws. */
function existingCodexHomeOwnerSid(codexHome: string): string | null {
  try {
    const p = join(codexHome, '.owner-sid');
    if (!existsSync(p)) return null;
    const v = readFileSync(p, 'utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Normalize a session key to the numeric adv_sessions id used by Codex homes.
 * Temporary session-port keys are UUIDs and must not be baked into lifecycle
 * hooks as if they were durable row ids. */
function numericAdvSessionId(value: string | number | null | undefined): string | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

/**
 * Move an already-materialized isolated Codex home from a temporary launch
 * key to the durable adv-session id used by every native resume path.
 *
 * Session ports deliberately create all fallible launch artifacts before
 * recording their pending target row. Once that row exists, the home must be
 * re-keyed instead of rebuilt: rebuilding would discard prompts/hooks already
 * materialized into the home, while leaving it under the port UUID makes
 * `psu --resume=<adv id>` look in a different directory. Refuse to overwrite a
 * destination so this helper can never erase another session's native state.
 */
export function rekeyCodexHome(sourceSessionKey: string | number, targetSessionKey: string | number): string {
  const source = codexHomeForSessionKey(sourceSessionKey);
  const target = codexHomeForSessionKey(targetSessionKey);
  const sourceSqlite = codexSqliteHomeForSessionKey(sourceSessionKey);
  const targetSqlite = codexSqliteHomeForSessionKey(targetSessionKey);
  if (source === target) return target;
  if (!existsSync(source)) throw new Error(`temporary Codex home does not exist: ${source}`);
  if (existsSync(target)) throw new Error(`target Codex home already exists: ${target}`);
  if (existsSync(targetSqlite)) throw new Error(`target Codex sqlite home already exists: ${targetSqlite}`);
  const movedSqlite = existsSync(sourceSqlite);
  if (movedSqlite) renameSync(sourceSqlite, targetSqlite);
  try {
    renameSync(source, target);
  } catch (error) {
    if (movedSqlite) renameSync(targetSqlite, sourceSqlite);
    throw error;
  }
  const configPath = join(target, 'config.toml');
  try {
    const config = readFileSync(configPath, 'utf8');
    const next = config.replace(
      `sqlite_home = "${tomlEscape(sourceSqlite)}"`,
      `sqlite_home = "${tomlEscape(targetSqlite)}"`,
    );
    if (next !== config) writeFileSync(configPath, next, { mode: 0o600 });
  } catch {
    // The normal launch path writes this file before rekey. If a legacy home
    // lacks it, the resume repair path renders the canonical target path.
  }
  return target;
}

const CODEX_HOME_INHERIT_DIRS = ['skills', 'plugins', 'prompts'] as const;
const CODEX_HOME_INHERIT_FILES = ['auth.json'] as const;

/**
 * Carry user-installed Codex capabilities into an isolated per-session home
 * without copying volatile session state. Symlinks are intentional: auth token
 * rotation and skill/plugin updates stay live, and the per-session home remains
 * small enough to recreate every launch.
 */
function inheritUserCodexHome(codexHome: string): void {
  const realHome = join(homedir(), '.codex');
  try {
    if (!existsSync(realHome)) return;
    for (const name of CODEX_HOME_INHERIT_FILES) {
      const src = join(realHome, name);
      const dst = join(codexHome, name);
      if (existsSync(src)) symlinkSync(src, dst);
    }
    for (const name of CODEX_HOME_INHERIT_DIRS) {
      const src = join(realHome, name);
      const dst = join(codexHome, name);
      if (existsSync(src) && lstatSync(src).isDirectory()) symlinkSync(src, dst, 'dir');
    }
  } catch {
    /* best-effort — codex surfaces missing auth/config issues itself */
  }
}

/**
 * tui-status-parity-single-source-2026-07-05 follow-up (live-window verify):
 * codex's TUI writes its OWN OSC-0 terminal title every turn (default items
 * `["activity","project"]`), which CLOBBERS the display.title our
 * posttooluse-objective-title.sh hook writes — verified live 2026-07-05: a
 * hook/manual title was reset to the project name within one turn. An EMPTY
 * `tui.terminal_title` item list stops codex writing titles entirely
 * (verified: a pre-set sentinel title survived boot + a full turn), so the
 * hook owns the title — same single-source display.title as claude/omp.
 */
// codex `[tui]` table. One emission point (TOML forbids duplicate
// table headers):
//  - terminal_title = [] — the objective-title hook owns the title
//    (single-source display.title); an empty item list stops codex writing its
//    OWN OSC-0 title each turn (see the doc comment above).
//  - alternate_screen = "never" — Codex 0.157 enables mouse reporting in its
//    alternate screen. GNOME Terminal then sends right-clicks to Codex instead
//    of opening the Paste context menu. Keeping normal scrollback also keeps
//    the terminal's right-click menu usable (WI-10003121).
//  - status_line — gives codex a native BOTTOM status pane (tui-status-parity
//    stopgap D, 2026-07-06). codex 0.142.5 has NO command-backed status item
//    (openai/codex#17827 is unmerged) so we can't render the papercusp fleet
//    chips here — these are codex's OWN native items instead: run-state
//    (Ready/Working/Thinking) · model+reasoning · context% remaining · git
//    branch. All are canonical rust-v0.142.5 StatusLineItem IDs; an unknown id
//    only warns-once + is ignored (codex `doctor` validates TOML structure, not
//    item membership), so a bad id can never break boot. NOT true fleet parity
//    — that needs the upstream command-item PR (B).
const CODEX_TUI_TOML = [
  '# The papercusp objective-title hook owns the terminal title (coord:glance',
  '# display.title); an empty item list stops codex clobbering it each turn.',
  '# status_line: a native bottom status pane (codex-own items — codex 0.142 has',
  '# no command-backed status item, openai/codex#17827; stopgap, not fleet chips).',
  '[tui]',
  'terminal_title = []',
  'alternate_screen = "never"',
  'status_line = ["run-state", "model-with-reasoning", "context-remaining", "git-branch"]',
  '',
] as const;

// WI-3278: bake the approvals/sandbox bypass into config.toml so it survives any
// codex relaunch that drops the CLI flags (the claude twin lost its ENTIRE argv
// to a 2.1.20x self-re-exec on the Windows VM — same argv-proofing here). The
// launcher's --dangerously-bypass-approvals-and-sandbox stays as the fast path.
// ROOT-LEVEL keys — must be emitted before the first [table] header.
const CODEX_DANGER_TOML = [
  '# psu/role sessions run with full approvals/sandbox bypass (owner mandate:',
  '# psu-launched agents get the most dangerous permissions — WI-3278). Config-',
  '# level so the grant survives a relaunch that drops the CLI flags.',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
] as const;

/** Trust state for the generated home's config.toml.
 *
 *  Two sources, one emission point (TOML forbids duplicate table headers):
 *  1. INHERITED — the user's real ~/.codex/config.toml trust tables. Modern
 *     codex records directory trust as `[projects."<path>"] trust_level`
 *     (ProjectConfig); `[trusted_workspaces]` is the legacy shape we used to
 *     inherit EXCLUSIVELY — which silently became a no-op once codex moved to
 *     `projects.*`, so every fresh per-session home booted untrusted and the
 *     TUI blocked on "Do you trust the contents of this directory?"
 *     (live-caught 2026-07-05, psu codex session-10753).
 *     The SAME failure class recurred 2026-08-09 one prompt over: a fresh home
 *     carries no `[tui.model_availability_nux]` state, so codex fires its
 *     model-availability nudge ("Switch to <newer model>? / Keep current /
 *     never show again") and blocks the TUI on it. That is merely annoying in a
 *     visible terminal and FATAL headless, where the launch hands codex
 *     fd0=/dev/null: the modal can never be answered, so the session wedges
 *     forever while staying ALIVE — burning a slot, emitting nothing, detected
 *     by no watchdog (EI-19988517595776254). Inheriting the nudge state carries
 *     the user's existing dismissals forward, which is why that table is kept.
 *     ⚠ This REDUCES recurrence; it does not cure it. A nudge for a model the
 *     user has never been offered has no inherited entry to carry, and any
 *     FUTURE codex modal wedges headless the same way. The structural fix is a
 *     headless codex that cannot block on a modal (or that dies loudly instead
 *     of hanging); until then, prefer a VISIBLE launch when the session must be
 *     trusted to make progress.
 *  2. SEEDED — `trustDir`, the directory the operator is launching the agent
 *     into. A psu/role launch is trusted by definition (the launcher already
 *     passes --dangerously-bypass-hook-trust + YOLO permissions), and a fresh
 *     CODEX_HOME never carries an answer forward — without the seed, every
 *     scripted codex launch hangs at the trust prompt.
 */
function inheritedCodexTrustToml(trustDir?: string | null): string[] {
  const source = join(homedir(), '.codex', 'config.toml');
  const out: string[] = [];
  if (existsSync(source)) {
    let keep = false;
    for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
      const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (table) {
        keep =
          table[1] === 'trusted_workspaces' ||
          table[1].startsWith('trusted_workspaces.') ||
          table[1] === 'projects' ||
          table[1].startsWith('projects.') ||
          // Nudge-dismissal state — see the model-availability note above.
          table[1] === 'tui.model_availability_nux' ||
          table[1].startsWith('tui.model_availability_nux.') ||
          // EI-19988517595776254 follow-up: `[notice]` carries the SAME class of
          // interactive-nudge suppression as model_availability_nux (e.g.
          // `hide_rate_limit_model_nudge = true`, `hide_gpt5_1_migration_prompt =
          // true`) — a separate TUI notice family that can equally block a
          // headless session's unanswerable fd0=/dev/null modal. `[notice.
          // model_migrations]` is the deprecated->replacement model map codex
          // consults when deciding whether to show the migration prompt at all,
          // so it travels with the hide_* flags rather than being left to default.
          // Inheriting whatever the user's real ~/.codex/config.toml already has
          // set (opt-in only — nothing is forced true here) further reduces, but
          // — like model_availability_nux — does not by itself cure, the class of
          // wedge this whole function exists to mitigate.
          table[1] === 'notice' ||
          table[1].startsWith('notice.');
      }
      if (keep) out.push(line);
    }
  }
  const inherited = out.length > 0 ? ['# Inherited trust state from ~/.codex/config.toml.', ...out, ''] : [];
  if (trustDir) {
    const header = `[projects."${tomlEscape(trustDir)}"]`;
    const alreadyInherited = inherited.some((l) => l.trim() === header);
    if (!alreadyInherited) {
      inherited.push(
        '# Launch-dir trust seeded by the operator (a psu/role launch is trusted by',
        '# definition) — a fresh CODEX_HOME otherwise blocks on the trust prompt.',
        header,
        'trust_level = "trusted"',
        '',
      );
    }
  }
  return inherited;
}

function copyInheritedCodexPrompts(codexHome: string): boolean {
  const prompts = join(codexHome, 'prompts');
  if (!existsSync(prompts)) return false;
  try {
    if (lstatSync(prompts).isSymbolicLink()) {
      const managed = join(codexHome, 'prompts.user');
      unlinkSync(prompts);
      cpSync(join(homedir(), '.codex', 'prompts'), managed, { recursive: true, force: true, dereference: true });
      symlinkSync(managed, prompts, 'dir');
      return true;
    }
  } catch {
    /* saved-prompt materialization can recreate prompts if inheritance fails */
  }
  return false;
}

/**
 * Write a fresh `hooks.json` into a per-session CODEX_HOME carrying the managed
 * SU hooks (locks, content integrity, activity, lifecycle, and injection). The
 * home is recreated each launch, so there is nothing to merge. No-op
 * (returns false) when the shared hook scripts aren't installed at
 * `~/.papercusp/hooks/cc/`. The launcher must exec codex with
 * `--dangerously-bypass-hook-trust` (the only hooks here are ours).
 *
 * FILE NAME (D-010): codex discovers hooks at `$CODEX_HOME/hooks.json` or
 * `config.toml [[hooks.PreToolUse]]` — NOT `settings.json` (the Claude path
 * the installer §4f + an earlier version of this wrote, which codex silently
 * ignored). We write `hooks.json`.
 *
 * ⚠ CORRECTED 2026-08-09 (codex-context-injection-parity-2026-08-09 D-004).
 * This comment used to read: "codex fires ONLY PreToolUse/PostToolUse — no
 * UserPromptSubmit-equivalent event exists in its hooks.json". That is FALSE
 * and was load-bearing for two plans. MEASURED, live, codex-cli 0.146.0: a
 * `$CODEX_HOME/hooks.json` carrying a `UserPromptSubmit` MatcherGroup FIRES —
 * codex's own log prints `hook: UserPromptSubmit` / `... Completed` and the
 * hook's stdin carries { prompt, cwd, session_id, turn_id, model, ... }.
 * The turn-start port is therefore REACHABLE on codex via THIS file.
 *
 * TURN PROVENANCE + OWNER-DIRECTIVE CAPTURE: Codex's UserPromptSubmit hook
 * carries the same prompt/session/turn identity the shared provenance script
 * needs. Register that script beside the context-injection dispatcher below;
 * it verifies Papercusp's nonce ledger, stamps the turn, and captures only an
 * interactive owner prompt. Keep both entries behind the session identity and
 * the provenance script's installed-file check.
 *
 * ⚠ TRUST IS SILENT (D-004, measured): an UNTRUSTED codex hook does not fire
 * and does not warn — no error, no log line, exit 0, session otherwise normal.
 * Every hook registered here therefore depends on the launcher passing
 * `--dangerously-bypass-hook-trust` (psu-launcher.mjs does, on all four codex
 * paths). If that flag is ever dropped, EVERY hook in this file — locks,
 * activity, objective-title AND injection — silently stops, with no signal.
 * That is precisely the failure class the P-005 injection-coverage detector
 * exists to catch; keep them wired together.
 *
 * LOCK HOOKS: current Codex discovers this per-session `hooks.json` and fires
 * PreToolUse/PostToolUse for `apply_patch` (plus the Edit/Write aliases) and
 * shell/MCP tool names. The launcher passes `--dangerously-bypass-hook-trust`
 * because this home contains only Papercusp-managed hooks.
 *
 * ACTIVITY HOOK (su + role), COORD-FOLDING for SU — NOT inert when
 * `activitySid` is given. The codex leg of the cross-CLI ACTIVITY BRIDGE
 * (papercusp-worker-integration-2026-06-04, D-002/D-003): every PostToolUse
 * mirrors the worker's native tool call into harness_shared.agent_activity →
 * the pui fleet view + curator. codex's PostToolUse fires for edits + Bash +
 * MCP, so this is reliable on codex. We BAKE PAPERCUSP_SID=<activitySid> +
 * PAPERCUSP_AGENT=codex because codex hands hooks a minimal env (the same
 * reason the lock hooks bake their values). Fires for BOTH su AND role
 * sessions — role sessions ARE workers, so their activity belongs in the
 * fleet view.
 *
 * Since EI-11405 (coordination-hook-rpc-fanout-collapse-2026-07-16) this SAME
 * hook ALSO carries the coord:inbox PUSH that used to be a separate
 * posttooluse-coord-inbox.sh entry: the script sends a delta-aware
 * `hook_bundle` cursor on `activity:report` and folds any NEW coord:inbox
 * messages into the SAME response (packages/operator-core/lib/agent-tools/
 * activity/hook-bundle.ts) — one round trip instead of two, mid-turn delivery
 * parity with the Claude global-settings coord entry. When `coordSid` is
 * given (SU sessions only) the fold stays ON (the script's default). Role
 * sessions get NO coord fold — they coordinate via messages:feature_*, not
 * the SU coord bus — so a role-only registration (activitySid without
 * coordSid) bakes PAPERCUSP_COORD_FOLD=0, which keeps that session on the
 * original detached, zero-added-latency report-only path (no hook_bundle
 * built, no synchronous wait).
 *
 * OBJECTIVE-TITLE HOOK (su + role) — NOT inert when `objectiveSid` is given. The
 * codex leg of the SESSION-OBJECTIVE DISPLAY (session-objective-display-2026-06-22,
 * P-003): codex has no statusline, but it owns a tty, so each PostToolUse sets the
 * terminal TITLE to this session's `coord:glance` self.objective via an OSC-0
 * escape — the same objective the Claude statusline renders as its leading 🔭
 * segment. Fires for su AND role (both want their tab/window title to say what
 * they're doing). PAPERCUSP_SID=<objectiveSid> is baked (codex's minimal hook env).
 *
 * LIFECYCLE HOOK (su + role) — Codex 0.149 exposes SessionStart/SessionEnd in
 * hooks.json, but the managed home used to omit both. That made an owner-visible
 * "end session" invisible to Papercusp: no lifecycle row, no lease cleanup, and
 * — most importantly — no handoff to the managed-host teardown path, so `psu
 * --resume` correctly found the old host still alive and refused a double host.
 * Register the SAME lifecycle-report.sh used by Claude. SessionEnd runs
 * synchronously because the script first asks activity:report whether this is a
 * genuine terminal end or a carry/reset continuation, then reuses the audited
 * admin fleet:kill route only for the terminal verdict (WI-41305).
 */
export function writeCodexLockHooks(
  codexHome: string,
  opts: {
    lockSid?: string;
    coordSid?: string;
    activitySid?: string;
    /** Durable adv_sessions row id for exact lifecycle re-anchors. */
    advSessionId?: string | number;
    objectiveSid?: string;
    /** codex-context-injection-parity-2026-08-09 P-004: session id baked into
     *  the context-injection dispatcher invocation. Absent ⇒ no injection hooks
     *  (the dispatcher's own invariant 3 would exit 0 silently anyway). */
    injectSid?: string;
    agentSession?: boolean;
    /** Exact per-session MCP URL. The managed PreCompact hook reuses this
     * route verbatim so role/workspace/harness/signature boundaries survive. */
    mcpUrl?: string;
    /** Superuser homes authenticate with the same on-disk bearer as their MCP
     * config; role homes keep their signed no-bearer route. */
    mcpUsesSuperuserToken?: boolean;
  } = {},
): boolean {
  const dir = join(homedir(), '.papercusp', 'hooks', 'cc');
  const pre = join(dir, 'pretooluse-locks-acquire.sh');
  const post = join(dir, 'posttooluse-locks-release.sh');
  if (!existsSync(pre) || !existsSync(post)) return false;
  const root = shellSingleQuote(resolveWorkspaceRoot());
  // Codex gives hook commands a minimal/stale environment. The lock hooks MUST
  // use the exact same per-session owner as the MCP URL; otherwise an explicit
  // multi-file claim by this session blocks its own automatic per-edit acquire.
  const lockIdentity = opts.lockSid
    ? ` PAPERCUSP_LOCK_SID=${shellSingleQuote(opts.lockSid)} PAPERCUSP_SID=${shellSingleQuote(opts.lockSid)}`
    : '';

  type CodexHook = {
    matcher: string;
    hooks: { type: 'command'; command: string; timeout?: number }[];
  };
  const postToolUse: CodexHook[] = [
    {
      matcher: CODEX_LOCK_POST_MATCHER,
      hooks: [{ type: 'command', command: `PAPERCUSP_WORKSPACE_ROOT=${root}${lockIdentity} ${post}` }],
    },
  ];

  // EI-21220966892195714: full writes are the only edit shape whose input
  // contains enough content for an exact post-write byte comparison. Keep this
  // separate from the lock-release matcher so apply_patch/parent exec calls do
  // not invoke a guard that cannot reconstruct their resulting file.
  const writeByteIntegrity = join(dir, 'posttooluse-write-byte-integrity-guard.mjs');
  if (existsSync(writeByteIntegrity)) {
    postToolUse.push({
      matcher: CODEX_WRITE_BYTE_INTEGRITY_MATCHER,
      hooks: [{ type: 'command', command: writeByteIntegrity }],
    });
  }

  // Activity-bridge hook (matcher `.*`), coord-folding when `coordSid` is ALSO
  // given (SU sessions only — see the header doc for the EI-11405 merge).
  // Baked PAPERCUSP_SID = the session's identity (the activity owner/pane key
  // AND the coord identity when folding) + PAPERCUSP_AGENT=codex.
  const activity = join(dir, 'posttooluse-activity-report.sh');
  if (opts.activitySid && existsSync(activity)) {
    const coordFold = opts.coordSid ? '' : ' PAPERCUSP_COORD_FOLD=0';
    postToolUse.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_AGENT=codex PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)}${coordFold} ${activity}`,
        },
      ],
    });
  }

  // Objective-title hook (matcher `.*`): set the terminal title to this session's
  // coord:glance self.objective (session-objective-display-2026-06-22). Baked
  // PAPERCUSP_SID = the session's coord identity (the glance read keys off it).
  const objective = join(dir, 'posttooluse-objective-title.sh');
  if (opts.objectiveSid && existsSync(objective)) {
    postToolUse.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_SID=${shellSingleQuote(opts.objectiveSid)} ${objective}`,
        },
      ],
    });
  }

  const lifecycle = join(dir, 'lifecycle-report.sh');
  const sessionStart: CodexHook[] = [];
  const sessionEnd: CodexHook[] = [];
  if (opts.activitySid && existsSync(lifecycle)) {
    const lifecycleIdentity =
      `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_AGENT=codex ` +
      `PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)}` +
      (numericAdvSessionId(opts.advSessionId)
        ? ` PAPERCUSP_ADV_SESSION_ID=${shellSingleQuote(numericAdvSessionId(opts.advSessionId)!)}`
        : '');
    sessionStart.push({
      matcher: '.*',
      hooks: [{ type: 'command', command: `${lifecycleIdentity} ${lifecycle}` }],
    });
    sessionEnd.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `${lifecycleIdentity} PAPERCUSP_ACTIVITY_SYNC=1 ${lifecycle}`,
        },
      ],
    });
  }

  // CONTEXT-INJECTION hooks (codex-context-injection-parity-2026-08-09 P-004).
  // Both ports go through the ONE shared dispatcher (D-001) — never a codex-
  // specific copy of the transport. The dispatcher is installed BESIDE the cc
  // hooks at ~/.papercusp/hooks/inject/ (installInjectionHooks in
  // desktop-install/papercusp-files.ts), so it is gated on its OWN existence,
  // not on the cc lock-hook gate above.
  //
  // PAPERCUSP_SID IS BAKED, and that is load-bearing: codex hands hook commands
  // a minimal env, and the dispatcher treats a missing PAPERCUSP_SID as "not a
  // psu session" and exits 0 with no output (D-001 invariant 3). An un-baked
  // sid would therefore produce a hook that runs, succeeds, and injects nothing
  // — indistinguishable from a hook that never fired.
  //
  // EVENT NAMES: PascalCase, matching the payload's own hook_event_name and the
  // codex adapter's portForEvent. UserPromptSubmit -> turn-start,
  // PostToolUse -> mid-turn (PER CALL on codex — it has no batch event; D-002
  // §5 explains why the frozen array interface absorbs that).
  const injectDispatcher = join(homedir(), '.papercusp', 'hooks', 'inject', 'index.mjs');
  const userPromptSubmit: CodexHook[] = [];
  const provenance = join(dir, 'userpromptsubmit-provenance.sh');
  if (opts.injectSid && existsSync(provenance)) {
    userPromptSubmit.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_SID=${shellSingleQuote(opts.injectSid)} PAPERCUSP_AGENT=codex ${provenance}`,
        },
      ],
    });
  }
  if (opts.injectSid && existsSync(injectDispatcher)) {
    const injectIdentity = `PAPERCUSP_SID=${shellSingleQuote(opts.injectSid)} PAPERCUSP_AGENT=codex`;
    userPromptSubmit.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `${injectIdentity} ${injectDispatcher} --client=codex --event=UserPromptSubmit`,
        },
      ],
    });
    postToolUse.push({
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: `${injectIdentity} ${injectDispatcher} --client=codex --event=PostToolUse`,
        },
      ],
    });
  }

  // managed-carry-lifecycle-enforcement P-002: Codex native AUTO compaction
  // bypasses the deterministic carry/checkpoint/lifecycle path. Official Codex
  // PreCompact semantics make this the synchronous veto seam: the hook asks the
  // existing session:request-compaction tool to queue the managed boundary and
  // returns continue:false regardless of outcome, so a refusal/transport fault
  // leaves the current session intact instead of falling through to native
  // compaction. Use the exact MCP route already baked into config.toml — role
  // signatures and SU authority must not be widened by the hook.
  const preCompact: CodexHook[] = [];
  const managedPreCompact = join(dir, 'precompact-managed-carry.mjs');
  if (opts.activitySid && opts.mcpUrl && existsSync(managedPreCompact)) {
    let harnessSlug = '';
    try {
      harnessSlug = new URL(opts.mcpUrl).searchParams.get('harness')?.trim() ?? '';
    } catch {
      /* the existing config writer/test owns URL validation; empty is diagnostic only */
    }
    const identity =
      `PAPERCUSP_MCP_URL=${shellSingleQuote(opts.mcpUrl)} ` +
      `PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)} ` +
      `PAPERCUSP_HARNESS_SLUG=${shellSingleQuote(harnessSlug)}` +
      (opts.mcpUsesSuperuserToken ? ' PAPERCUSP_MCP_AUTH=superuser-token' : '');
    preCompact.push({
      matcher: '^auto$',
      hooks: [
        {
          type: 'command',
          command: `${identity} ${managedPreCompact}`,
          timeout: 600,
        },
      ],
    });
  }

  const preToolUse: CodexHook[] = [
    {
      matcher: CODEX_LOCK_PRE_MATCHER,
      hooks: [{ type: 'command', command: `PAPERCUSP_WORKSPACE_ROOT=${root}${lockIdentity} ${pre}` }],
    },
  ];

  // EI-18801362747285637: Claude already installed this guard globally, but
  // managed Codex homes carried only the lock hook. A Codex apply_patch could
  // therefore commit raw control bytes and first learn about them at the green
  // gate. Reuse the SAME policy-bearing script; it parses apply_patch added lines
  // and deliberately ignores deleted/context lines so repairing a dirty file is
  // never blocked by the byte being removed.
  const controlBytes = join(dir, 'pretooluse-control-bytes-content-guard.mjs');
  if (existsSync(controlBytes)) {
    preToolUse.push({
      matcher: CODEX_CONTROL_BYTES_PRE_MATCHER,
      hooks: [{ type: 'command', command: controlBytes }],
    });
  }

  // WI-41770: keep the policy-bearing generated-artifact guard identical across
  // Claude and managed Codex homes. The shared script understands Codex's raw or
  // wrapped apply_patch frame, so projected docs cannot be hand-edited through a
  // client whose tool payload has no top-level file_path.
  const generatedFiles = join(dir, 'pretooluse-generated-file-edit-guard.mjs');
  if (existsSync(generatedFiles)) {
    preToolUse.push({
      matcher: CODEX_CONTROL_BYTES_PRE_MATCHER,
      hooks: [{ type: 'command', command: generatedFiles }],
    });
  }

  // WI-10001350: use the same migration reservation policy for Codex's native
  // apply_patch payloads as the Claude hooks. This shared path matcher accepts
  // apply_patch plus Edit/Write/MCP writer inputs; baking the managed root lets
  // the guard resolve Codex's repository-relative patch targets safely.
  const migrationReservation = join(dir, 'pretooluse-unreserved-migration-guard.mjs');
  if (existsSync(migrationReservation)) {
    preToolUse.push({
      matcher: CODEX_CONTROL_BYTES_PRE_MATCHER,
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_WORKSPACE_ROOT=${root} ${migrationReservation}`,
        },
      ],
    });
  }

  // P-010 (fleet-friction-remediation-2026-08-21): an apply_patch envelope may
  // carry at most ONE operation per target path, and violating that rejects the
  // WHOLE patch — deterministically, before anything is written. The class was
  // filed independently five times (EI-21353344120350526, EI-21354846297369687,
  // EI-21565696681975825, EI-21573638140720842, EI-22346861820470210), the last
  // naming the gap exactly: deterministic validation "not surfaced before
  // submission". This is Codex-only by construction — Edit/Write carry a single
  // file_path and cannot express the collision — so it gets its own narrow
  // matcher rather than riding the shared content-guard one.
  const duplicateTarget = join(dir, 'pretooluse-apply-patch-duplicate-target-guard.mjs');
  if (existsSync(duplicateTarget)) {
    preToolUse.push({
      matcher: '^apply_patch$',
      hooks: [{ type: 'command', command: duplicateTarget }],
    });
  }

  // Native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010):
  // AGENT homes (role sessions — never the human su home, D-003) get the
  // bash-resource-gate with the agent marker BAKED (codex hands hooks a
  // minimal env, same reason the coord/activity hooks bake PAPERCUSP_SID), so
  // shell-created OS schedules (crontab/at/batch/systemd-run) are denied and
  // wakes can only live in the harness routines table.
  const gate = join(dir, 'pretooluse-bash-resource-gate.sh');
  if (opts.agentSession && existsSync(gate)) {
    preToolUse.push({
      matcher: 'Bash|exec_command|local_shell|shell',
      hooks: [
        {
          type: 'command',
          command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_AGENT_SESSION=1 ${gate}`,
        },
      ],
    });
  }

  // IDENTITY HOOK ports (portable-identity-packages-2026-09-26 P-011, D-023 §2):
  // a worn identity's pre-tool guards, stop rules and compaction rules, through
  // the same dispatcher and the same baked sid as the two context ports above.
  // Every matcher is '.*' — which tools a guard names, and which SessionStart
  // sources mean a fresh context, are decided by the operator and the adapter
  // (codex's schemas are read in adapters/codex.mjs). The guard renders only a
  // deny for the one pending call, so it can never auto-approve (D-027).
  const stop: CodexHook[] = [];
  if (opts.injectSid && existsSync(injectDispatcher)) {
    const injectIdentity = `PAPERCUSP_SID=${shellSingleQuote(opts.injectSid)} PAPERCUSP_AGENT=codex`;
    const identityHook = (event: string): CodexHook => ({
      matcher: '.*',
      hooks: [{ type: 'command', command: `${injectIdentity} ${injectDispatcher} --client=codex --event=${event}` }],
    });
    preToolUse.push(identityHook('PreToolUse'));
    stop.push(identityHook('Stop'));
    sessionStart.push(identityHook('SessionStart'));
  }

  // UserPromptSubmit is emitted ONLY when non-empty: an empty MatcherGroup array
  // is meaningless, and a key that is always present would make "is turn-start
  // registered on this home?" un-answerable by reading hooks.json.
  const hooks = {
    hooks: {
      PreToolUse: preToolUse,
      PostToolUse: postToolUse,
      ...(userPromptSubmit.length > 0 ? { UserPromptSubmit: userPromptSubmit } : {}),
      ...(stop.length > 0 ? { Stop: stop } : {}),
      ...(sessionStart.length > 0 ? { SessionStart: sessionStart } : {}),
      ...(sessionEnd.length > 0 ? { SessionEnd: sessionEnd } : {}),
      ...(preCompact.length > 0 ? { PreCompact: preCompact } : {}),
    },
  };
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify(hooks, null, 2), { mode: 0o600 });
  return true;
}

function writeCodexHomeDiagnostics(
  codexHome: string,
  opts: {
    hooksInstalled: boolean;
    inheritedPromptsCopied: boolean;
    lockOwnerSid?: string;
    lockRuntime: CodexLockRuntimeVerdict;
  },
): void {
  const body = {
    // One resolved mode only; coord:orient refreshes the runtime verdict after launch.
    lockEnforcement: opts.hooksInstalled ? 'hooks-configured' : 'hooks-missing',
    codexPreToolUseStatus: opts.lockRuntime.hookHealth,
    lockMode: opts.lockRuntime.lockMode,
    hookHealth: opts.lockRuntime.hookHealth,
    runtimeProbed: opts.lockRuntime.runtimeProbed,
    lockGeneration: opts.lockRuntime.generation,
    lockReason: opts.lockRuntime.reason,
    requiresExplicitPapercuspLocks: opts.lockRuntime.lockMode === 'manual',
    ...(opts.lockOwnerSid ? { lockOwnerSid: opts.lockOwnerSid } : {}),
    inheritedPromptsCopied: opts.inheritedPromptsCopied,
    // EI-21417256075155406: systemSkillsReady=false means every Codex session on this host
    // watches /etc and wakes on every process start — provision /etc/codex/skills.
    codexSkillWatchRoots: ensureCodexSkillWatchRoots({ codexHome }),
  };
  writeFileSync(join(codexHome, 'papercusp-diagnostics.json'), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Repair only the managed identity files of an EXISTING SU Codex home.
 *
 * A tracked resume intentionally preserves the home's `sessions/**` rollouts,
 * AGENTS.md, auth link, plugins and skills.  It may nevertheless resume that
 * home under a newer coord owner (for example after a cold successor adopts the
 * same adv-session row).  Before EI-211903 the launcher treated any config with
 * an MCP block as "ready", so `config.toml`, hooks.json and diagnostics could
 * keep the prior owner while PAPERCUSP_SID/ptool used the successor.  The lock
 * hook then acquired as the prior owner and reported the successor's deliberate
 * manual lock as foreign contention.
 *
 * This helper is deliberately narrower than `writeSuCodexHome`: it never
 * rebuilds the directory and never touches transcripts or prompts.  It rewrites
 * the canonical hooks, merges the current owner into diagnostics, and advances
 * the collision sentinel.  A same-owner home remains byte-identical.
 */
export function repairSuCodexHomeIdentity(
  codexHome: string,
  sid: string,
  advSessionId?: string | number,
  mcpUrl?: string,
): { repaired: boolean; hooksInstalled: boolean; reason?: 'no-home' } {
  if (!existsSync(codexHome)) return { repaired: false, hooksInstalled: false, reason: 'no-home' };

  const diagnosticsPath = join(codexHome, 'papercusp-diagnostics.json');
  const hooksPath = join(codexHome, 'hooks.json');
  let diagnostics: Record<string, unknown> = {};
  let hooksText = '';
  try {
    const parsed = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      diagnostics = parsed as Record<string, unknown>;
    }
  } catch {
    /* missing/malformed is a repair input */
  }
  try {
    hooksText = readFileSync(hooksPath, 'utf8');
  } catch {
    /* missing/unreadable is a repair input */
  }

  const hookOwners = Array.from(hooksText.matchAll(/PAPERCUSP_(?:LOCK_)?SID='([^']+)'/g), (match) => match[1]);
  const hooksExpected = diagnostics.lockEnforcement === 'hooks-configured' || existsSync(hooksPath);
  const expectedAdvSessionId = numericAdvSessionId(advSessionId);
  const hooksMatch = hooksExpected
    ? hookOwners.length > 0 && hookOwners.every((owner) => owner === sid)
    : hookOwners.length === 0;
  const diagnosticsMatch = diagnostics.lockOwnerSid === sid;
  const sentinelMatches = existingCodexHomeOwnerSid(codexHome) === sid;
  const lifecycleHooksMatch = (() => {
    if (!hooksExpected) return true;
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      return ['SessionStart', 'SessionEnd'].every((event) =>
        parsed.hooks?.[event]?.some((group) =>
          group.hooks?.some(
            (hook) =>
              hook.command?.includes('lifecycle-report.sh') &&
              hook.command.includes(`PAPERCUSP_SID='${sid}'`) &&
              (!expectedAdvSessionId || hook.command.includes(`PAPERCUSP_ADV_SESSION_ID='${expectedAdvSessionId}'`)),
          ),
        ),
      );
    } catch {
      return false;
    }
  })();
  const preCompactHookMatches = (() => {
    if (!hooksExpected || !mcpUrl) return true;
    try {
      const parsed = JSON.parse(hooksText) as {
        hooks?: Record<
          string,
          Array<{
            matcher?: string;
            hooks?: Array<{ command?: string; timeout?: number }>;
          }>
        >;
      };
      return parsed.hooks?.PreCompact?.some(
        (group) =>
          group.matcher === '^auto$' &&
          group.hooks?.some(
            (hook) =>
              hook.timeout === 600 &&
              hook.command?.includes('precompact-managed-carry.mjs') &&
              hook.command.includes(`PAPERCUSP_SID='${sid}'`) &&
              hook.command.includes(`PAPERCUSP_MCP_URL=${shellSingleQuote(mcpUrl)}`) &&
              hook.command.includes('PAPERCUSP_MCP_AUTH=superuser-token'),
          ),
      ) === true;
    } catch {
      return false;
    }
  })();
  if (
    hooksMatch &&
    diagnosticsMatch &&
    sentinelMatches &&
    lifecycleHooksMatch &&
    preCompactHookMatches
  ) {
    return { repaired: false, hooksInstalled: hooksExpected };
  }

  const hooksInstalled = writeCodexLockHooks(codexHome, {
    lockSid: sid,
    coordSid: sid,
    activitySid: sid,
    advSessionId,
    objectiveSid: sid,
    injectSid: sid,
    mcpUrl,
    mcpUsesSuperuserToken: true,
  });
  const lockRuntime = readCodexLockRuntimeVerdict({ ownerId: sid, hooksConfigured: hooksInstalled });
  const nextDiagnostics = {
    ...diagnostics,
    lockEnforcement: hooksInstalled ? 'hooks-configured' : 'hooks-missing',
    codexPreToolUseStatus: lockRuntime.hookHealth,
    lockMode: lockRuntime.lockMode,
    hookHealth: lockRuntime.hookHealth,
    runtimeProbed: lockRuntime.runtimeProbed,
    lockGeneration: lockRuntime.generation,
    lockReason: lockRuntime.reason,
    requiresExplicitPapercuspLocks: lockRuntime.lockMode === 'manual',
    lockOwnerSid: sid,
  };
  writeFileSync(diagnosticsPath, `${JSON.stringify(nextDiagnostics, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(codexHome, '.owner-sid'), sid, { mode: 0o600 });
  return { repaired: true, hooksInstalled };
}

function codexAgentsPrompt(promptText: string, lockRuntime: CodexLockRuntimeVerdict): string {
  const withoutStaticLockAdvice = promptText.replace(CODEX_LOCK_GUIDANCE_RE, '').replace(/\n{3,}/g, '\n\n');
  return `${withoutStaticLockAdvice.replace(/\n+$/, '')}\n\n${codexLockEnforcementNote(lockRuntime)}`;
}

/**
 * Build (or rebuild) a per-session CODEX_HOME under
 * `~/.papercusp/role-codex-homes/session-<key>`. Idempotent: the dir is
 * recreated fresh each launch so a re-launch can't inherit a stale prompt
 * or url.
 */
export function writeRoleCodexHome(opts: {
  sessionKey: string | number;
  /** Already-signed, role-scoped MCP url (from buildRoleLaunchSpec). */
  mcpUrl: string;
  /** The role prompt — becomes AGENTS.md. */
  promptText: string;
  /** Launch model. Extended-window models bake their canonical root keys into
   *  config.toml so a later model-less resume inherits the same window. */
  model?: string | null;
  /** The session's coordination identity (PAPERCUSP_SID = role-<uuid>). Baked
   *  into the activity-bridge hook so this worker's tool calls report under it.
   *  Omit → no activity hook (a role home without an identity). */
  sid?: string;
  /** Optional Codex account pin; writes a custom model provider that points Codex at the inference gateway. */
  codexGatewayAccountId?: string | null;
  /** Route through the gateway with NO pin (explicit-auto, WI-3645): writes the SAME provider
   *  block with the x-papercusp-account header omitted — the gateway auto-selects. Ignored
   *  when codexGatewayAccountId is set. */
  codexGatewayAuto?: boolean;
  /** Admission label written beside the owner header for a gateway-routed role home. */
  codexGatewayPriority?: string | null;
  /** Suppress optional interactive plugin authentication in an unattended TUI. */
  headless?: boolean;
  /** The directory the operator is launching this agent into (spec.cwd). Seeded
   *  as `[projects."<dir>"] trust_level = "trusted"` so a fresh CODEX_HOME does
   *  not block at codex's "Do you trust this directory?" boot prompt. */
  trustDir?: string | null;
}): RoleCodexHome {
  // ONE shared codex-home key (unify-launch-mechanics P-004): both role and su
  // codex sessions live under the SAME root the wake-executor resume leg reads
  // (`codexHomeForAdvSession` → `codexHomeForSessionKey`). Previously the role
  // path wrote to a separate `role-codex-homes/` root the resume leg never
  // looked in, so a woken codex role session resumed from nothing.
  const codexHome = freshCodexHome(codexHomeForSessionKey(opts.sessionKey));
  const sqliteHome = freshCodexSqliteHome(opts.sessionKey);
  const inheritedPromptsCopied = copyInheritedCodexPrompts(codexHome);

  // AGENTS.md = the role prompt. codex has no per-launch system-prompt
  // flag; its instruction file is $CODEX_HOME/AGENTS.md (same mechanism
  // codex-su uses for the engineer playbook).
  const agentsPath = join(codexHome, 'AGENTS.md');

  // config.toml: the role-scoped MCP server. The url is already signed
  // (sig-auth), so — unlike the codex-su home — there is no
  // bearer_token_env_var. codex does NOT env-expand config.toml, so the
  // url is baked verbatim.
  const configPath = join(codexHome, 'config.toml');
  const logDir = join(codexHome, 'log');
  mkdirSync(logDir, { recursive: true });
  const gatewayConfig = codexGatewayConfigToml(opts.codexGatewayAccountId, {
    gatewayOn: opts.codexGatewayAuto,
    ownerId: opts.sid,
    priority: opts.codexGatewayPriority,
  });
  // Resolve the model before writing the home.  A missing model MUST become an
  // explicit safe root key; otherwise Codex reads its installed cache on the
  // next model-less resume and can select the denied Spark entry.
  const resolvedModel = resolveCodexModel(opts.model);
  const modelConfig = codexModelConfigToml(resolvedModel);
  const contextConfig = codexContextConfigToml(resolvedModel, { codexHome }).trimEnd();
  const toml = [
    ...(contextConfig ? contextConfig.split('\n') : []),
    ...modelConfig,
    `sqlite_home = "${tomlEscape(sqliteHome)}"`,
    `log_dir = "${tomlEscape(logDir)}"`,
    ...gatewayConfig.root,
    ...CODEX_DANGER_TOML,
    codexIsolationPreamble(opts.headless),
    ...inheritedCodexTrustToml(opts.trustDir),
    ...gatewayConfig.tables,
    ...CODEX_TUI_TOML,
    '# Per-session codex role MCP config (managed by bootstrap-role / writeRoleCodexHome).',
    '[mcp_servers.papercusp]',
    `url = "${tomlEscape(opts.mcpUrl)}"`,
    '',
  ].join('\n');
  writeFileSync(configPath, toml, { mode: 0o600 });

  // P-030: a role codex session edits files too — install the same SU-locks
  // hooks so its edits are coordinated (the role home previously had none,
  // a silent gap). Launcher must pass --dangerously-bypass-hook-trust. A role
  // session is a WORKER, so it also reports to the activity bridge (under its
  // session identity); no coordSid → the merged hook's coord fold stays OFF
  // (PAPERCUSP_COORD_FOLD=0, roles don't ride the SU coord bus).
  const hooksInstalled = writeCodexLockHooks(codexHome, {
    lockSid: opts.sid,
    advSessionId: opts.sessionKey,
    activitySid: opts.sid,
    objectiveSid: opts.sid,
    injectSid: opts.sid,
    agentSession: true,
    mcpUrl: opts.mcpUrl,
  });
  const lockRuntime = readCodexLockRuntimeVerdict({
    ownerId: opts.sid ?? `role-${opts.sessionKey}`,
    hooksConfigured: hooksInstalled,
  });
  const agentsText = codexAgentsPrompt(opts.promptText, lockRuntime);
  const instructionLint = lintInstructionText(agentsText);
  writeFileSync(agentsPath, agentsText, { mode: 0o600 });
  writeCodexHomeDiagnostics(codexHome, {
    hooksInstalled,
    inheritedPromptsCopied,
    lockOwnerSid: opts.sid,
    lockRuntime,
  });

  return { codexHome, sqliteHome, agentsPath, configPath, instructionLint };
}

export interface SuCodexHome {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** Fast, session-keyed directory configured as Codex's `sqlite_home`. */
  sqliteHome: string;
  /** The AGENTS.md (engineer playbook) path — diagnostics. */
  agentsPath: string;
  /** The config.toml (superuser MCP) path — diagnostics. */
  configPath: string;
  /** Lint of the exact AGENTS.md written after runtime lock-mode resolution. */
  instructionLint: InstructionLintReport;
}

// Keep the public read API available for existing launch/config callers while
// allowing dossier consumers to import the reader without loading this writer.
export { readCodexHomeDiagnostics } from './codex-home-diagnostics';
export type { CodexHomeDiagnostics, CodexPapercuspDiagnostics } from './codex-home-diagnostics';

/**
 * Materialize a per-session CODEX_HOME for an interactive SUPERUSER (`su`)
 * codex session (psu su --agent=codex). The codex counterpart of the
 * claude/omp raw-CLI su launch — codex has no --mcp-config/-prompt flags,
 * so the engineer playbook is AGENTS.md and the superuser MCP is declared
 * in config.toml. Per-session port of install-standalone-mcp.sh §4f
 * (the static `codex-su` home), with two differences:
 *   - the `&client=<sid>` is baked per session (codex does NOT env-expand
 *     config.toml; the static wrapper overrode it via `-c` at launch).
 *   - the SU-locks hooks are written here (writeCodexLockHooks), so the
 *     home is self-contained.
 *
 * D-006 — the superuser bearer is baked into config.toml as
 * `http_headers = { Authorization = "Bearer <tok>" }`, NOT via
 * `bearer_token_env_var`. Verified on codex 0.135: the env-var form
 * connects but does NOT deliver a valid bearer for a streamable_http
 * server (→ `isSuperuser:false`), while the baked header works
 * (→ `isSuperuser:true`, the 217-tool superuser surface). The static
 * `codex-su` wrapper uses the env-var form and shares this latent bug.
 * Baking the token is acceptable: the home is mode-0600 + ephemeral
 * (rebuilt each launch), exactly like claude's `~/.claude.json` header.
 * Launcher execs codex with `--dangerously-bypass-hook-trust`.
 */
/** Inputs the su `config.toml` is rendered from — the subset of
 *  `writeSuCodexHome`'s options that end up IN the file. */
export interface SuCodexConfigInput {
  mcpUrl: string;
  sid: string;
  /** Absolute per-session directory Codex uses for its plaintext TUI log. */
  logDir?: string | null;
  /** Launch model. Omit/null resolves the managed Sol xhigh default, which keeps
   *  repair and model-less resume paths aligned with a fresh launch. */
  model?: string | null;
  /** Direct per-session CODEX_HOME whose model registry should seed context roots. */
  codexHome?: string | null;
  /** Fast session companion for Codex's high-write SQLite state. */
  sqliteHome?: string | null;
  token?: string | null;
  codexGatewayAccountId?: string | null;
  codexGatewayAuto?: boolean;
  codexGatewayPriority?: string | null;
  /** Suppress optional interactive plugin authentication in an unattended TUI. */
  headless?: boolean;
  trustDir?: string | null;
  /** Launch cwd for project-scoped external HTTP MCP servers. */
  projectDir?: string | null;
}

/** Claude stores project MCP choices in its user config. Carry HTTP entries
 * into the isolated Codex home so changing clients does not hide a connector.
 * The platform server remains session-scoped and always wins name collisions. */
function projectHttpMcpToml(projectDir: string | null | undefined): string[] {
  const lines = ['# BEGIN inherited project HTTP MCP', '# END inherited project HTTP MCP'];
  if (!projectDir) return lines;
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    const servers = config.projects?.[resolve(projectDir)]?.mcpServers ?? {};
    const entries: string[] = [];
    for (const [name, raw] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
      if (name === 'papercusp' || name === 'papercusp-su' || !raw || typeof raw !== 'object') continue;
      const server = raw as { type?: unknown; url?: unknown; headers?: unknown };
      if (server.type !== 'http' || typeof server.url !== 'string' || !/^https?:\/\//.test(server.url)) continue;
      entries.push(`[mcp_servers."${tomlEscape(name)}"]`, `url = "${tomlEscape(server.url)}"`);
      if (server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)) {
        const headers = Object.entries(server.headers)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([key, value]) => `"${tomlEscape(key)}" = "${tomlEscape(value)}"`);
        if (headers.length) entries.push(`http_headers = { ${headers.join(', ')} }`);
      }
    }
    return [lines[0], ...entries, lines[1]];
  } catch {
    return lines;
  }
}

/** Append the per-session MCP client exactly once without reserializing signed
 * role URLs (query order/encoding are part of their signature). */
function mcpUrlWithClient(mcpUrl: string, sid: string): string {
  if (/[?&]client=/.test(mcpUrl)) return mcpUrl;
  const sep = mcpUrl.includes('?') ? '&' : '?';
  return `${mcpUrl}${sep}client=${encodeURIComponent(sid)}`;
}

/**
 * The su `config.toml` body. ONE renderer, two callers: `writeSuCodexHome`
 * (fresh home) and `ensureSuCodexHomeConfig` (repair an existing home). Kept
 * as a shared function rather than copied into the repair path because a second
 * renderer that drifted would make a repaired home quietly differ from a freshly
 * launched one — the exact drift class the codex-gateway-config extraction was
 * done to end (WI-3645).
 *
 * The per-session client identity is baked into the url because codex cannot
 * env-expand config.toml, and the superuser bearer rides as an http_headers
 * Authorization (D-006 — the env-var form doesn't deliver on codex 0.135).
 * `env_http_headers` resolves CODEX_SESSION_ID at request time, independently
 * proving which native Codex incarnation is using the inherited coord owner.
 */
export function suCodexConfigToml(opts: SuCodexConfigInput): string {
  const url = mcpUrlWithClient(opts.mcpUrl, opts.sid);
  const gatewayConfig = codexGatewayConfigToml(opts.codexGatewayAccountId, {
    gatewayOn: opts.codexGatewayAuto,
    ownerId: opts.sid,
    priority: opts.codexGatewayPriority,
  });
  // Keep the effective model in the per-session root config so a resume that
  // has no CLI `-m` flag cannot fall through to CODEX_HOME/models_cache.json.
  const resolvedModel = resolveCodexModel(opts.model);
  const modelConfig = codexModelConfigToml(resolvedModel);
  const contextConfig = codexContextConfigToml(resolvedModel, {
    codexHome: opts.codexHome ?? undefined,
  }).trimEnd();
  return [
    ...(contextConfig ? contextConfig.split('\n') : []),
    ...modelConfig,
    ...(opts.sqliteHome ? [`sqlite_home = "${tomlEscape(opts.sqliteHome)}"`] : []),
    ...(opts.logDir ? [`log_dir = "${tomlEscape(opts.logDir)}"`] : []),
    ...gatewayConfig.root,
    ...CODEX_DANGER_TOML,
    codexIsolationPreamble(opts.headless),
    ...inheritedCodexTrustToml(opts.trustDir),
    ...gatewayConfig.tables,
    ...CODEX_TUI_TOML,
    '# Per-session codex SU home config (managed by bootstrap-su / writeSuCodexHome).',
    '[mcp_servers.papercusp-su]',
    `url = "${tomlEscape(url)}"`,
    ...(opts.token ? [`http_headers = { Authorization = "Bearer ${tomlEscape(opts.token)}" }`] : []),
    'env_http_headers = { "x-papercusp-native-session" = "CODEX_SESSION_ID" }',
    ...projectHttpMcpToml(opts.projectDir ?? opts.trustDir),
    '',
  ].join('\n');
}

/**
 * REPAIR an existing CODEX_HOME's `config.toml` in place — the resume-leg
 * counterpart to `writeSuCodexHome`, and deliberately NOT that function.
 *
 * `writeSuCodexHome` starts with `freshCodexHome`, which rm -rf's the directory.
 * That is right for preparing a session, and catastrophic for repairing one: the
 * home holds every `sessions/**​/rollout-*.jsonl` the resume is about to read, so
 * rebuilding it would destroy the very transcripts being resumed. This repairs
 * only managed launch files in place: config.toml plus identity-bearing hooks /
 * diagnostics when their owner has drifted. Rollouts, prompts and auth survive.
 *
 * WI-38706: the archiver had been unlinking these configs (it took the home's
 * shared state under one thread's session id), leaving codex to re-create an
 * 87-byte trust-only stub on the next launch — no MCP server, no approvals
 * bypass, no gateway provider — so the resume either died on the missing provider
 * or came up silently uncoordinated. `existsSync(home)` is required, not created:
 * a home that is not there has no rollouts to resume and must not be conjured.
 *
 * Idempotent: a home already carrying `[mcp_servers.papercusp-su]` AND the
 * context roots required by its recorded launch model is left byte-identical
 * and reported `repaired: false`. Older managed homes that predate the roots
 * (or carry superseded values) are rewritten from this canonical renderer so a
 * model-less resume cannot silently fall back to Codex's smaller native window.
 */
export function ensureSuCodexHomeConfig(opts: SuCodexConfigInput & {
  sessionKey: string | number;
  /** Canonical, current SU render; supplied by the operator repair route. */
  promptText?: string;
  /** A carry starts a fresh thread, so a GC-removed home can be recreated safely. */
  recoverMissingHome?: boolean;
}): {
  codexHome: string;
  sqliteHome: string;
  configPath: string;
  repaired: boolean;
  identityRepaired: boolean;
  promptRepaired: boolean;
  reason?: 'no-home';
} {
  const codexHome = codexHomeForSessionKey(opts.sessionKey);
  const sqliteHome = codexSqliteHomeForSessionKey(opts.sessionKey);
  const configPath = join(codexHome, 'config.toml');
  if (!existsSync(codexHome)) {
    if (!opts.recoverMissingHome || !opts.promptText?.trim()) {
      return { codexHome, sqliteHome, configPath, repaired: false, identityRepaired: false, promptRepaired: false, reason: 'no-home' };
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    inheritUserCodexHome(codexHome);
    ensureCodexSkillWatchRoots({ codexHome });
  }
  mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  const logDir = join(codexHome, 'log');
  mkdirSync(logDir, { recursive: true });
  const resolvedModel = resolveCodexModel(opts.model);
  const expectedModelConfig = codexModelConfigToml(resolvedModel).join('\n');
  const expectedContextConfig = codexContextConfigToml(resolvedModel, { codexHome });
  const expectedLogDir = `log_dir = "${tomlEscape(logDir)}"`;
  const expectedSqliteHome = `sqlite_home = "${tomlEscape(sqliteHome)}"`;
  const expectedClient = `client=${encodeURIComponent(opts.sid)}`;
  const expectedNativeSessionHeader = 'env_http_headers = { "x-papercusp-native-session" = "CODEX_SESSION_ID" }';
  const expectedSuMcpRoute =
    '[mcp_servers.papercusp-su]\nurl = "' +
    tomlEscape(mcpUrlWithClient(opts.mcpUrl, opts.sid)) +
    '"';
  const expectedGateway = codexGatewayConfigToml(opts.codexGatewayAccountId, {
    gatewayOn: opts.codexGatewayAuto,
    ownerId: opts.sid,
    priority: opts.codexGatewayPriority,
  });
  const expectedProjectMcp = projectHttpMcpToml(opts.projectDir ?? opts.trustDir).join('\n');
  let configReady = false;
  try {
    const current = readFileSync(configPath, 'utf8');
    const modelMatches = current.includes(expectedModelConfig);
    const contextMatches = modelMatches && (expectedContextConfig
      ? current.includes(expectedContextConfig.trimEnd())
      : !/^model_(?:context_window|auto_compact_token_limit)\s*=/m.test(current));
    const gatewayReady = expectedGateway.root.length
      ? current.includes(expectedGateway.root.join('\n')) && current.includes(expectedGateway.tables.join('\n'))
      : !current.includes('PAPERCUSP_CODEX_GATEWAY_ROOT') && !current.includes('PAPERCUSP_CODEX_GATEWAY_PROVIDER');
    const hasHeadlessPluginsPolicy = current.includes('plugins = false');
    const hasHeadlessAuthPolicy = current.includes('auth_elicitation = false');
    const headlessPolicyReady = opts.headless === true
      ? hasHeadlessPluginsPolicy && hasHeadlessAuthPolicy
      : !hasHeadlessPluginsPolicy && !hasHeadlessAuthPolicy;
    configReady =
      current.includes(expectedSuMcpRoute) &&
      current.includes(expectedProjectMcp) &&
      current.includes(expectedClient) &&
      current.includes(expectedNativeSessionHeader) &&
      contextMatches &&
      current.includes(expectedSqliteHome) &&
      current.includes(expectedLogDir) &&
      current.includes('[tui]\nterminal_title = []\nalternate_screen = "never"\n') &&
      gatewayReady &&
      headlessPolicyReady;
  } catch {
    /* absent or unreadable — that is precisely the repair case */
  }
  if (!configReady) {
    writeFileSync(configPath, suCodexConfigToml({ ...opts, logDir, codexHome, sqliteHome }), { mode: 0o600 });
  }
  const identity = repairSuCodexHomeIdentity(
    codexHome,
    opts.sid,
    opts.sessionKey,
    mcpUrlWithClient(opts.mcpUrl, opts.sid),
  );
  const agentsPath = join(codexHome, 'AGENTS.md');
  const carryBasePath = join(codexHome, '.papercusp-carry-base-AGENTS.md');
  const readBase = (path: string): string => {
    try {
      return readFileSync(path, 'utf8').split(/\n---\n## Managed carry checkpoint\b/)[0].trim();
    } catch {
      return '';
    }
  };
  // The carry minter prefers its base snapshot over AGENTS.md. Repair BOTH
  // whenever either is empty, otherwise a prior empty snapshot wins again.
  const agentsBase = readBase(agentsPath);
  const snapshotExists = existsSync(carryBasePath);
  const snapshotBase = snapshotExists ? readBase(carryBasePath) : agentsBase;
  const promptRepaired = !!opts.promptText?.trim() && (!agentsBase || !snapshotBase);
  if (promptRepaired) {
    const lockRuntime = readCodexLockRuntimeVerdict({
      ownerId: opts.sid,
      hooksConfigured: identity.hooksInstalled,
    });
    const canonicalPrompt = codexAgentsPrompt(opts.promptText!, lockRuntime);
    writeFileSync(agentsPath, canonicalPrompt, { mode: 0o600 });
    writeFileSync(carryBasePath, canonicalPrompt, { mode: 0o600 });
  }
  return {
    codexHome,
    sqliteHome,
    configPath,
    repaired: !configReady || identity.repaired || promptRepaired,
    identityRepaired: identity.repaired,
    promptRepaired,
  };
}

export function writeSuCodexHome(opts: {
  sessionKey: string | number;
  /** Superuser MCP url (?superuser=1&workspace=…) from buildLaunchSpec(su). */
  mcpUrl: string;
  /** The engineer playbook — becomes AGENTS.md. */
  promptText: string;
  /** Per-session coordination identity, baked into the url's &client=. */
  sid: string;
  /** Launch model. Extended-window models bake their canonical root keys into
   *  config.toml so model-less resumes retain the launch window. */
  model?: string | null;
  /** Superuser bearer token, baked as an http_headers Authorization (D-006).
   *  Omit only when no token is installed → a degraded non-superuser home. */
  token?: string | null;
  /** Optional Codex account pin; writes a custom model provider that points Codex at the inference gateway. */
  codexGatewayAccountId?: string | null;
  /** Route through the gateway with NO pin (explicit-auto, WI-3645): writes the SAME provider
   *  block with the x-papercusp-account header omitted — the gateway auto-selects. Ignored
   *  when codexGatewayAccountId is set. */
  codexGatewayAuto?: boolean;
  /** Gateway admission label; `su` for interactive SU homes. */
  codexGatewayPriority?: string | null;
  /** Suppress optional interactive plugin authentication in an unattended TUI. */
  headless?: boolean;
  /** The directory the operator is launching this SU session into (resolveSuLaunchCwd).
   *  Seeded as `[projects."<dir>"] trust_level = "trusted"` so a fresh CODEX_HOME
   *  does not block at codex's "Do you trust this directory?" boot prompt. */
  trustDir?: string | null;
  /** Canonical launch-time mode/route/scope state for the machine-readable
   * instruction precedence trace carried by the exact AGENTS.md lint. */
  instructionRuntime?: InstructionRuntimeContext;
  /** EI-11366 identity-split guard: liveness check for a PRIOR occupant of this
   *  sessionKey's home directory. Injected (not statically imported) so this
   *  module stays dependency-free/pure for its unit tests — the real production
   *  check is `findLiveHost` (psu-pty-discovery), wired by bootstrap-su.ts.
   *  Omitted ⇒ the collision check is skipped entirely (byte-identical to the
   *  pre-guard behavior — safe default for every existing caller/test). */
  isOwnerLive?: (sid: string) => boolean;
}): SuCodexHome {
  const targetHome = codexHomeForSessionKey(opts.sessionKey);
  // EI-11366: a live Codex psu host was once found split across two identities
  // — the physical host process/PAPERCUSP_SID/socket stayed with its ORIGINAL
  // sid while CODEX_HOME/hooks.json on disk had been silently regenerated for a
  // DIFFERENT sid. `freshCodexHome` below unconditionally rm -rf's + rebuilds
  // whatever is at `targetHome` (intentional — see the "rebuilds fresh" test —
  // for the ordinary case of re-preparing the SAME logical session). The gap is
  // that nothing ever checked whether the directory it is about to destroy is
  // still the ACTIVE home of a DIFFERENT, currently-live session. If a future
  // caller (a retry path, a sessionKey computed by different code, an operator
  // debug script) ever passes a sessionKey that collides with a still-live
  // OTHER sid's home, this converts a silent identity-split into a loud,
  // diagnosable refusal instead. Fails OPEN (proceeds, current behavior) unless
  // BOTH a differing prior owner AND a caller-supplied liveness check confirm
  // it is still live — never blocks a normal fresh/re-prepare launch.
  const priorSid = existingCodexHomeOwnerSid(targetHome);
  if (priorSid && priorSid !== opts.sid && opts.isOwnerLive?.(priorSid)) {
    throw new Error(
      `writeSuCodexHome: refusing to rebuild ${targetHome} — it is the LIVE Codex home of a ` +
        `different session (owner ${priorSid}); overwriting it would silently split that ` +
        `session's identity between its still-running process and a rewritten CODEX_HOME ` +
        `(EI-11366). Pass the SAME sid to re-prepare that session, or a sessionKey that does ` +
        `not collide with a live session's home.`,
    );
  }
  const codexHome = freshCodexHome(targetHome);
  const sqliteHome = freshCodexSqliteHome(opts.sessionKey);
  const inheritedPromptsCopied = copyInheritedCodexPrompts(codexHome);

  const agentsPath = join(codexHome, 'AGENTS.md');

  // Bake the per-session client identity into the url (codex can't env-expand
  // config.toml) + the superuser bearer as an http_headers Authorization
  // (D-006 — the env-var form doesn't deliver on codex 0.135).
  const configPath = join(codexHome, 'config.toml');
  const logDir = join(codexHome, 'log');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(configPath, suCodexConfigToml({ ...opts, logDir, codexHome: targetHome, sqliteHome }), { mode: 0o600 });

  // SU sessions pass coordSid so the merged activity hook's coord fold stays
  // ON (new coord:inbox messages folded into the SAME activity:report round
  // trip, parity with the Claude global-settings coord entry, EI-11405) — an
  // SU/engineer session is a worker too, so it gets the activity bridge either
  // way; both keyed to the session id.
  const hooksInstalled = writeCodexLockHooks(codexHome, {
    lockSid: opts.sid,
    coordSid: opts.sid,
    activitySid: opts.sid,
    advSessionId: opts.sessionKey,
    objectiveSid: opts.sid,
    injectSid: opts.sid,
    mcpUrl: mcpUrlWithClient(opts.mcpUrl, opts.sid),
    mcpUsesSuperuserToken: true,
  });
  const lockRuntime = readCodexLockRuntimeVerdict({ ownerId: opts.sid, hooksConfigured: hooksInstalled });
  const agentsText = codexAgentsPrompt(opts.promptText, lockRuntime);
  const instructionLint = lintInstructionText(agentsText, 20, opts.instructionRuntime);
  writeFileSync(agentsPath, agentsText, { mode: 0o600 });
  writeCodexHomeDiagnostics(codexHome, {
    hooksInstalled,
    inheritedPromptsCopied,
    lockOwnerSid: opts.sid,
    lockRuntime,
  });
  // EI-11366: stamp the sentinel the collision guard above reads on the NEXT
  // write to this sessionKey's home. Best-effort — a write failure here must
  // never fail the launch (mirrors every other diagnostics write in this fn).
  try {
    writeFileSync(join(codexHome, '.owner-sid'), opts.sid, { mode: 0o600 });
  } catch {
    /* non-fatal: the collision guard simply skips on the next write */
  }

  return { codexHome, sqliteHome, agentsPath, configPath, instructionLint };
}

const PAPERCUSP_SU_TABLE_RE = /^mcp_servers\.(?:papercusp-su|"papercusp-su")(?:\.|$)/;

/**
 * The SU `config.toml` minus what makes it an SU session: the papercusp-su MCP
 * table (and any of its sub-tables) and the psu cap on the project's AGENTS.md.
 * Every other key and table, the project's own MCP servers included, is kept.
 */
export function codingAssistantCodexConfigToml(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split('\n')) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) skipping = PAPERCUSP_SU_TABLE_RE.test(header[1].replace(/\s+/g, ''));
    if (skipping) continue;
    if (/^\s*project_doc_max_bytes\s*=\s*0\s*(?:#.*)?$/.test(line)) continue;
    if (line.startsWith('# psu prompt isolation')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * pui-chat-first-ux-2026-09-28 P-016 (D-004/D-005 for Codex): a PUI chat opened
 * outside every registered checkout runs Codex's own identity. This strips the
 * SU pieces from its already-written per-session home IN PLACE, so rollouts,
 * auth and the project's own MCP servers survive: the papercusp-su MCP server,
 * the cap that stops Codex reading the project's AGENTS.md, the SU playbook
 * (replaced by a COPY of the user's own `~/.codex/AGENTS.md`, never a symlink,
 * because a later SU repair writes through that path), and the managed
 * hooks.json. Idempotent. Run it on every engine start: an exact resume first
 * repairs the home back to its SU configuration.
 */
export function makeCodingAssistantCodexHome(codexHome: string, home: string = homedir()): void {
  const configPath = join(codexHome, 'config.toml');
  if (existsSync(configPath)) {
    const current = readFileSync(configPath, 'utf8');
    const next = codingAssistantCodexConfigToml(current);
    if (next !== current) writeFileSync(configPath, next, { mode: 0o600 });
  }
  const agentsPath = join(codexHome, 'AGENTS.md');
  rmSync(agentsPath, { force: true });
  const userAgents = join(home, '.codex', 'AGENTS.md');
  if (existsSync(userAgents)) writeFileSync(agentsPath, readFileSync(userAgents), { mode: 0o600 });
  rmSync(join(codexHome, 'hooks.json'), { force: true });
}
