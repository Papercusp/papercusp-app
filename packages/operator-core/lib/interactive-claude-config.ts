/**
 * interactive-claude-config.ts — materialize a per-session `CLAUDE_CONFIG_DIR`
 * for an INTERACTIVE claude session (psu su / psu --role on the claude backend).
 *
 * The EI-155 fix, and the interactive-claude leg of the EI-153 per-session
 * conversation-store isolation (unify-launch-mechanics D-002). The orchestrator
 * bee path already isolates headless spawns via `writeSpawnClaudeConfig`
 * (spawn-mcp.ts) — but that mints a DELIBERATELY MINIMAL, plugin-free config dir
 * (creds symlink only): correct for a `-p` worker that must resolve ZERO plugins
 * (the plugin-checkout-into-cwd defect), wrong for a human at the keyboard.
 *
 * An interactive session is the user's FULL environment, so a creds-only dir is
 * unsafe — verified live on claude-code 2.1.169:
 *   - `CLAUDE_CONFIG_DIR` relocates ALL of `~/.claude` **and** the sibling
 *     `~/.claude.json` into it (the older invoke.ts note that "`.claude.json`
 *     stays at $HOME" is stale for current claude). A fresh dir therefore loses:
 *   - the user-level `papercusp-su` MCP server (lives in `~/.claude.json`) → an
 *     SU session with NO tools;
 *   - the file-lock + coord Pre/PostToolUse hooks (live in
 *     `~/.claude/settings.json`) → the shared-tree lock discipline silently off;
 *   - the user's plugins/skills (`~/.claude/plugins`), slash commands, themes;
 *   - the onboarding/trust state (`~/.claude.json`) → a re-onboarding flow
 *     (theme picker / trust prompt / login) that BLOCKS an interactive launch.
 *
 * So instead of a minimal dir we build a **symlink mirror** of `~/.claude` with
 * TWO things isolated: the conversation transcript store `projects/` (EI-153),
 * and the user's PERSONAL MEMORY files (psu-isolation P-002 / D-001 — below).
 * Every other top-level entry — `.credentials.json`, `settings.json`, `plugins/`,
 * `commands/`, … — is symlinked back to the real `~/.claude/<entry>` (writes pass
 * through for in-place writers), the sibling `~/.claude.json` is symlinked in,
 * and `projects/` is a fresh real directory.
 *
 * ⚠ CREDENTIALS DO NOT STAY SYMLINKED. claude rewrites `.credentials.json` by
 * REPLACING the file (temp + rename), so the first OAuth refresh / `/login`
 * inside a session swaps the symlink for a divergent real-file fork — and with
 * Anthropic's single-use rotating refresh tokens, forks mutually invalidate
 * (the every-terminal-relogin cascade; upstream anthropics/claude-code#48786).
 * The fix is NOT here: the operator's background reconciler
 * (`claude-credential-sync.ts`) converges every fork + the global file on the
 * newest bundle. This launcher's part is the reconcile-before-mirror call in
 * `writeInteractiveClaudeConfig`, so a NEW session symlinks a global file that
 * already holds the newest family member (seed-from-newest,
 * claude-credential-sync-2026-06-10 P-002).
 *
 * ── psu prompt isolation (P-002 / D-001) ──────────────────────────────────────
 * A psu session must be governed ONLY by the psu playbook (+ the P-001 project-
 * guide splice), NOT by the launching user's personal config. But a plain mirror
 * symlinks `~/.claude/CLAUDE.md` in, and claude auto-loads `$CLAUDE_CONFIG_DIR/
 * CLAUDE.md` as global memory (on this box `CLAUDE.md` = `@AGENTS.md`, the owner's
 * memory rules / prefs) — the exact leak the owner raised. So we DON'T link the
 * personal-memory entries (`CLAUDE.md` / `AGENTS.md` / `CLAUDE.local.md`); the
 * session then has no global memory file and is steered solely by psu.
 *
 * Why this (a non-inheriting CLAUDE_CONFIG_DIR) and NOT `--bare`: the plan's
 * primary was `claude --bare` (it drops CLAUDE.md auto-discovery wholesale). But
 * `--bare` on claude-code 2.1.169 ALSO refuses to read OAuth / keychain auth
 * (`--help`: "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper") —
 * and psu Claude sessions on this box authenticate ONLY via the Claude-Max OAuth
 * in `~/.claude/.credentials.json` (no ANTHROPIC_API_KEY). So `--bare` would make
 * every interactive psu Claude session unauthenticated — the dead-end P-002's
 * fallback anticipated. This config-dir approach keeps OAuth + the file-lock hooks
 * (`settings.json`) + the `papercusp-su` MCP (`~/.claude.json`) intact while
 * killing only the personal-memory leak — the same shape Codex already uses
 * (a dedicated CODEX_HOME). RESIDUAL: the cwd-discovered PROJECT `CLAUDE.md` (the
 * repo's own guide) still auto-loads for a repo-cwd session; that's benign (it's
 * the repo guide, also delivered by the P-001 splice for non-repo cwds / non-claude
 * clients), not personal leakage.
 *
 * The session is the user's environment for AUTH + TOOLS + HOOKS, but its
 * transcripts land under `<configDir>/projects/**` and it loads NO personal memory.
 *
 * That is exactly the isolation EI-153 needs:
 *   - `/resume` and the picker no longer surface peers' sessions (transcripts are
 *     scoped to this dir);
 *   - the dir is keyed by the session's coord-owner id (`PAPERCUSP_SID`) via the
 *     ONE shared `sessionClaudeConfigDir` helper, so the wake-executor resume leg
 *     (which sets `CLAUDE_CONFIG_DIR = sessionClaudeConfigDir(coordOwnerId)` when
 *     it exists) points the woken `claude --resume <uuid>` at the SAME dir the
 *     launch wrote to — launch and resume agree by construction, not by two
 *     string literals that can drift.
 *
 * The dir is PERSISTENT (the wake-executor reads it after the launch process
 * dies); like the bee path it is not cleaned up here.
 *
 * Server-only.
 */
import {
  lstatSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import {
  access as accessAsync,
  lstat as lstatAsync,
  mkdir as mkdirAsync,
  readFile as readFileAsync,
  readdir as readdirAsync,
  rename as renameAsync,
  rm as rmAsync,
  symlink as symlinkAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { reconcileClaudeCredentials } from './claude-credential-sync';
import { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } from './agent-tools/coordination/compaction-recovery';

const interactiveMaterializationQueue = new Map<string, Promise<unknown>>();
const claudeJsonMutationQueue = new Map<string, Promise<unknown>>();

function serializeByKey<T>(queue: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  queue.set(key, next);
  const cleanup = () => {
    if (queue.get(key) === next) queue.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}

export interface InteractiveClaudeConfig {
  /** Absolute path to set as the interactive session's `CLAUDE_CONFIG_DIR`. */
  configDir: string;
}

/** Top-level `~/.claude` entry that gets a fresh real dir (NOT a symlink) so the
 *  session's conversation transcripts are isolated from the shared store. */
const ISOLATED_ENTRY = 'projects';

/**
 * Top-level `~/.claude` entries that are the launching user's PERSONAL global
 * memory / instructions — deliberately NOT mirrored into a psu session's config
 * dir (psu-isolation P-002 / D-001). `CLAUDE.md` is claude's global-memory file
 * (here `@AGENTS.md`); skipping it (and its include target / local variant) means
 * the session loads no personal memory and is governed only by the psu playbook +
 * the P-001 project-guide splice. Auth/hooks/MCP/plugins still link through.
 */
const PERSONAL_MEMORY_ENTRIES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);

/**
 * context-trimming-tiers P-020: plugins whose tool schemas a FLEET member never
 * needs (github ~40 tools, cloudflare docs, firecrawl — ~10k+ tokens of schemas
 * per session). Matched on the plugin NAME half of `name@marketplace`. context7
 * + verdict + the LSP/review plugins stay. The playwright mcpServer (in
 * `.claude.json`) is pruned alongside.
 */
const FLEET_PRUNED_PLUGIN_NAMES = new Set(['github', 'cloudflare', 'firecrawl']);
const FLEET_PRUNED_MCP_SERVERS = new Set(['playwright']);

/**
 * WI-6603 [owner 2026-07-28] — Claude Code settings whose STOCK DEFAULTS are
 * wrong for a papercusp fleet. Baked into every psu session's settings.json so
 * each session inherits them; measured against claude 2.1.220.
 *
 * `includeGitInstructions: false` (CC default true) — the default injects a
 *   `# Git` block into every agent's Bash tool description, ending "Commit or
 *   push only when the user asks. If on the default branch, branch first."
 *   (verified verbatim in a live session's own prompt). That is the OPPOSITE of
 *   this repo's rule: git-sync owns commit+push, the shared tree stays on
 *   `staging`, and no agent branches. Also gates the gitStatus system-context
 *   block — an accepted loss, since `git status` on a tree ~130 agents edit
 *   concurrently reports every peer's uncommitted work as if it were yours.
 *
 * `showThinkingSummaries: true` (CC default false — `settings.showThinkingSummaries
 *   ?? false`) — with it off, CC sends no `display` on the thinking config and the
 *   API returns SIGNATURE-ONLY thinking blocks (`thinking: ''`). Measured over a
 *   7d corpus: 58,362 thinking blocks ingested to ZERO thinking parts, so no agent
 *   reasoning is recallable via sessions:search (see search/session-ingest.ts and
 *   plan session-turn-storage-2026-07-28 D-003/D-007). Ingest already accepts
 *   populated thinking parts with no schema change. NOTE the storage consequence:
 *   thinking parts were free while empty; populated they compete with the same
 *   PROSE cap as text (PART_TEXT_CAP_PROSE, derived from the pane's render
 *   budget — see lib/transcript-text-caps.ts) — revisit if the table grows.
 *
 * `fileCheckpointingEnabled: false` (CC default on — 650 MB / 19,451 files
 *   observed in ~/.claude/file-history) — /rewind restores files in place, and
 *   this checkout is edited concurrently by the whole fleet, so a rewind silently
 *   reverts peers' uncommitted work: the same hazard class as the tree-wide
 *   `git checkout .` the repo bans outright.
 *
 * These are POLICY DEFAULTS, not safety grants, which is why they are deliberately
 * NOT re-asserted by the session-recover hook's selfHealSettings() the way
 * permissions.defaultMode and skipDangerousModePermissionPrompt are. Claude's own
 * settings-save deep-MERGES (updateSettingsForSource merges prior content rather
 * than replacing it), so a `/effort` or `/model` save cannot drop them mid-session;
 * an operator who deliberately flips one in-session keeps it until the next launch
 * re-materializes the dir. Project/local settings still outrank this layer.
 */
const PAPERCUSP_SESSION_SETTING_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  includeGitInstructions: false,
  showThinkingSummaries: true,
  fileCheckpointingEnabled: false,
});

/**
 * WI-3280 (argv-proof playbook delivery) — file names inside the session
 * config dir. `RECOVER_HOOK` is a SessionStart hook script (registered in the
 * session settings.json by writeSessionSettings); `RECOVER_PLAYBOOK` /
 * `RECOVER_INTENT` are the parked playbook copy + launch metadata the hook
 * injects from when it detects that claude's self-re-exec dropped the argv.
 * Exported for the launcher-side writers and tests.
 */
export const RECOVER_HOOK = 'session-recover-hook.mjs';
export const RECOVER_PLAYBOOK = 'launch-playbook.md';
export const RECOVER_INTENT = 'launch-intent.json';

/**
 * The SessionStart recovery hook, written verbatim into every session config
 * dir. Dependency-free (node builtins only) so it runs under any node on the
 * box, including the WSL-mounted sidecar node on the Windows VM.
 *
 * Why it exists (WI-3278 → WI-3280, owner mandate): claude 2.1.x SELF-RE-EXECs
 * (TUI fullscreen switch / update relaunch — `relaunchInto()` → `vge()` in the
 * bundle) and the relaunch rebuilds argv as `[]` or `--resume <id>` via libc
 * execve — the original launch flags (`--system-prompt-file` playbook,
 * `--permission-mode`, `--session-id`, `--disallowedTools`) are NEVER
 * re-passed, and the binary has NO config-level system-prompt key to bake the
 * playbook into. Permissions survive via settings.json (WI-3278); this hook
 * recovers the PLAYBOOK: on every SessionStart it inspects the live claude
 * process's argv (the flag can only live there — the pty host passes args
 * in-process, never on its own argv) and, when no `*-system-prompt-file` flag
 * survives, injects the parked playbook copy as additionalContext. Silent
 * no-op when argv is intact (zero token cost) or when no playbook was parked.
 * `PSU_RECOVER_TEST_CHAIN` (JSON argv[][]) substitutes the ancestry walk for
 * tests. Errors always exit 0 — a broken hook must never block a session.
 *
 * The SAME hook also delivers the POST-COMPACTION CONTINUITY ANCHOR
 * (compaction-continuity-hardening-2026-07-07 P-004, implements WI-2537): on
 * `SessionStart[source=compact]` it injects (a) the marker-aware recovery
 * contract, (b) a volatile-claims
 * checklist — liveness/fleet counts, service states, and quantities in the
 * compaction summary are HYPOTHESES to re-verify, never facts — and (c) the
 * session's carry brief fetched LIVE from the operator
 * (`/api/agent-mcp/session-recovery-brief`, P-003's renderCarryBriefText).
 * The static parts (a)+(b) are baked into the hook so they deliver even with
 * the operator down; the fetch is fail-soft with a short abort. A COLD
 * reset/recycle wake gets the same brief via the wake-executor injection
 * (carry-brief consumer iii) — one render path, two boundaries.
 */
export const RECOVER_HOOK_SOURCE = `#!/usr/bin/env node
// session-recover-hook.mjs — WI-3280 argv-proof playbook delivery + P-004
// post-compaction continuity anchor + P-007 identity rebind (generated by
// interactive-claude-config.ts on every session materialize; do not edit).
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const dir = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = join(dir, ${JSON.stringify(RECOVER_PLAYBOOK)});
const INTENT = join(dir, ${JSON.stringify(RECOVER_INTENT)});
const FLAGS = ['--system-prompt-file', '--append-system-prompt-file'];
const MARKER_AWARE_RECOVERY = ${JSON.stringify(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION)};
// EI-13477: same layout psu-pty-host.mjs's appendHostEvent / sanitizeKey use —
// MUST match byte-for-byte so latestRespawnNativeId (psu-pty-discovery.ts)
// finds this event under the same per-owner log it already reads.
const PSU_PTY_DIR = join(homedir(), '.papercusp', 'psu-pty');
const RESPAWN_EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
function sanitizeOwnerKey(ownerId) {
  return String(ownerId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

function cmdlineOf(pid) {
  try {
    const argv = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\u0000').filter(Boolean);
    if (argv.length) return argv;
  } catch {}
  try {
    // macOS (no /proc). Whitespace-split degrades paths with spaces, but flag
    // TOKENS are whitespace-delimited either way, which is all we test for.
    const line = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (line) return line.split(/\\s+/);
  } catch {}
  return null;
}

function ppidOf(pid) {
  try {
    const m = /^PPid:\\s*(\\d+)/m.exec(readFileSync('/proc/' + pid + '/status', 'utf8'));
    if (m) return Number(m[1]);
  } catch {}
  try {
    const n = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    if (Number.isFinite(n)) return n;
  } catch {}
  return 0;
}

function argvIntact() {
  // Structured PUI engines deliver the full custom prompt through the Agent
  // SDK initialize channel, which deliberately has no argv flag. Treat that
  // explicit ownership marker as intact so this argv-recovery hook does not
  // persist a second full playbook into the native conversation on every
  // fresh start and exact resume. The compact continuity anchor below is
  // independent and still runs for source=compact.
  if (process.env.PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED === '1') return true;
  const chain = [];
  if (process.env.PSU_RECOVER_TEST_CHAIN) {
    try { chain.push(...JSON.parse(process.env.PSU_RECOVER_TEST_CHAIN)); } catch {}
  } else {
    let pid = process.ppid;
    for (let hop = 0; hop < 10 && pid > 1; hop++) {
      const argv = cmdlineOf(pid);
      if (argv) chain.push(argv);
      pid = ppidOf(pid);
    }
  }
  const isClaude = (argv) => (argv[0] ?? '').toLowerCase().includes('claude');
  const hasFlag = (argv) => argv.some((a) => FLAGS.some((f) => a === f || a.startsWith(f + '=')));
  // The nearest claude ancestor decides; if none is identifiable (unusual
  // argv[0], e.g. a bare versioned binary), fall back to any-flag-anywhere.
  const claude = chain.find(isClaude);
  return claude ? hasFlag(claude) : chain.some(hasFlag);
}

// The claude hook input JSON ({ session_id, source, ... }) arrives on stdin.
// Raced against a short timer so a never-closing stdin can't stall the start.
async function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const read = (async () => {
      let data = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) data += chunk;
      return data;
    })();
    const data = await Promise.race([read, new Promise((r) => setTimeout(r, 3000, ''))]);
    return data && data.trim() ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

// EI-22197250733115758: a Claude self-relaunch can leave the replacement
// process outside the managed psu-pty host. That simultaneously removes the
// direct wake-injection path and the host-driven carry-respawn path, but the
// recovery banner previously reported neither. Read the SAME owner-scoped
// discovery record as psu-pty-discovery.ts and report only what this hook can
// verify locally. Keep this dependency-free: the generated SessionStart hook
// must run even while the operator/MCP transport is down.
function ptyHostRecoveryLine(intent) {
  const ownerId = String(process.env.PAPERCUSP_SID || intent?.sid || '').trim();
  const verifyViaLoop = 'After confirming identity, run loop:status before relying on wake delivery or compaction.';
  if (!ownerId) {
    return '- ⚠ Managed psu-pty host state could not be checked because no owner id is available. ' + verifyViaLoop;
  }
  try {
    const metaPath = join(PSU_PTY_DIR, sanitizeOwnerKey(ownerId) + '.json');
    const host = JSON.parse(readFileSync(metaPath, 'utf8'));
    const pid = Number(host?.pid);
    const argv = Number.isInteger(pid) && pid > 1 ? cmdlineOf(pid) : null;
    const command = Array.isArray(argv) ? argv.join(' ') : '';
    const hostLive =
      host?.ownerId === ownerId &&
      typeof host?.sock === 'string' &&
      existsSync(host.sock) &&
      (command.includes('psu-launcher') || command.includes('psu-pty-host'));
    if (hostLive && Array.isArray(host?.caps) && host.caps.includes('carry-respawn')) {
      return '- Managed psu-pty host and carry-respawn capability are still verified after this relaunch.';
    }
    if (hostLive) {
      return (
        '- ⚠ The managed psu-pty host is live but does not advertise carry-respawn. Direct wake injection remains host-backed, but host-driven self-compaction is unavailable. ' +
        verifyViaLoop
      );
    }
  } catch {
    // Missing, stale, or partially-written discovery state is the unsafe case:
    // do not reassure the recovered process that either host-backed path exists.
  }
  return (
    '- ⚠ NO LIVE MANAGED PSU-PTY HOST could be verified after this relaunch. Direct wake injection and host-driven carry-respawn are unavailable; wakes may park until this process exits. ' +
    'An armed cold loop (or session:request-compaction retuning a warm loop) can still provide fresh-context continuation, and the compaction watchdog remains the fallback. ' +
    verifyViaLoop
  );
}

// EI-20273348458054257: the recovery banner used to assert, unconditionally,
// "coord/MCP identity is unaffected" — a claim about a thing it had not
// checked. A self-relaunch CAN fork the coord identity (measured: recorded
// su-9cf35961… → live su-c6e0a56f…, 12 ownerId-keyed surfaces stranded), and an
// agent told its identity is intact has no reason to look. rebindIdentityIfChanged()
// below detects the fork, but it is a separate async path this SYNC banner never
// consulted, so the two could — and did — disagree.
//
// The rule this encodes: report what was VERIFIED (the recorded sid vs the live
// env sid), never the reassuring conclusion. When they diverge, lead with the
// divergence and the one call that repairs it; when they agree, say only that
// they agree and name the read that would settle it authoritatively.
function identityLine(intent) {
  const recorded = ((intent && intent.sid) || '').trim();
  const live = (process.env.PAPERCUSP_SID || '').trim();
  if (recorded && live && recorded !== live) {
    return (
      '- ⚠ YOUR PAPERCUSP IDENTITY CHANGED ACROSS THIS RELAUNCH: recorded ' +
      recorded +
      ' → live ' +
      live +
      '. Every ownerId-keyed surface (armed loop, loop carry-note + walls, plan/work claims, claim-spec, standing awaits, fleet membership + leadership, owner facts, held file locks) may still be keyed to the OLD id. VERIFY FIRST with coord:whoami and coord:orient { afterCompaction: true }: confirm the predecessor is dead and no protected predecessor state remains. This mismatch alone does not authorize an identity rebind or a force override.'
    );
  }
  if (recorded && live) {
    return (
      '- Your papercusp identity is ' +
      recorded +
      ' (env PAPERCUSP_SID), which MATCHES the live env value — but that is the only thing checked here, not proof the coord/MCP session resolved to it. Confirm with coord:orient and compare self.ownerId; if it differs, coord:rebind-identity { from: "' +
      recorded +
      '" }.'
    );
  }
  if (recorded) {
    return '- A recorded PAPERCUSP_SID (' + recorded + ') exists, but no live PAPERCUSP_SID is available to compare. VERIFY FIRST with coord:whoami and coord:orient (self.ownerId) before trusting or changing any ownerId-keyed state.';
  }
  if (live) {
    return '- No recorded PAPERCUSP_SID to compare against (live env is ' + live + ') — VERIFY FIRST with coord:whoami and coord:orient (self.ownerId) before trusting any ownerId-keyed state.';
  }
  return '- No recorded or live PAPERCUSP_SID is available to compare — VERIFY FIRST with coord:whoami and coord:orient (self.ownerId) before trusting any ownerId-keyed state.';
}

// WI-3280: the argv-drop playbook recovery — returns the injection text, or
// null when argv is intact / no playbook was parked (the silent no-op).
function playbookRecovery(intent) {
  if (!existsSync(PLAYBOOK)) return null;
  if (argvIntact()) return null;
  const playbook = readFileSync(PLAYBOOK, 'utf8');
  const banner = [
    '⚠ SESSION RECOVERED — your launch system prompt was lost; it is re-delivered below.',
    'This claude process self-relaunched (an internal claude re-exec: TUI fullscreen switch or',
    'update relaunch) and claude rebuilds argv on relaunch WITHOUT the original launch flags:',
    'the --system-prompt-file playbook, --permission-mode, --session-id and any --disallowedTools',
    'were dropped. Permissions were separately restored via this session settings.json. Notes:',
    identityLine(intent),
    ptyHostRecoveryLine(intent),
    intent.nativeSessionId ? '- Your native claude session id may differ from the recorded one (' + intent.nativeSessionId + ') — psu resume/tracking of this conversation may be degraded; disclose this if coordination looks off.' : '- psu resume/tracking of this conversation may be degraded; disclose this if coordination looks off.',
    '- If the playbook below denies tools (subagents, native schedulers), honor it even though the CLI deny flags were lost.',
    '- The document below IS your operating playbook / system prompt. Follow it in full.',
  ].join('\\n');
  return banner + '\\n\\n' + playbook;
}

// EI-13477: report a same-pid self-relaunch's NEW native session id the same
// way a psu-host carry-respawn already does, so the SERVER-side context-gauge
// re-anchors instead of freezing on the dead pre-relaunch transcript forever.
//
// playbookRecovery() firing is the reliable signal that THIS SessionStart is a
// genuine self-relaunch (argv lost its -system-prompt-file flag, which only
// happens on claude's internal TUI-switch/update re-exec — never on a normal
// resume/clear/compact start). The claude hook input's own 'session_id' IS the
// freshly re-exec'd process's native id — psu never has to guess it.
//
// Rather than teach the compaction reader a SECOND reconciliation source, this
// appends the SAME 'respawned' event shape psu-pty-host.mjs's appendHostEvent
// writes for a wrapper-driven carry-respawn, into the SAME per-owner log file
// latestRespawnNativeId (psu-pty-discovery.ts) already reads — a live host's
// discovery file need not even exist for this to work, since a same-pid
// relaunch never restarts the pty host. Best-effort / fail-open: a write
// failure here must never block the session start.
function reportSelfRelaunchNativeId(ownerId, nativeId) {
  if (!ownerId || !nativeId) return;
  try {
    const p = join(PSU_PTY_DIR, sanitizeOwnerKey(ownerId) + '.events.jsonl');
    try {
      if (statSync(p).size > RESPAWN_EVENT_LOG_MAX_BYTES) {
        const tail = readFileSync(p, 'utf8');
        writeFileSync(p, tail.slice(Math.floor(tail.length / 2)).replace(/^[^\\n]*\\n/, ''), { mode: 0o600 });
      }
    } catch {}
    const row = JSON.stringify({ ts: new Date().toISOString(), kind: 'respawned', mode: 'self-relaunch', nativeId });
    appendFileSync(p, row + '\\n', { mode: 0o600 });
  } catch {
    /* fail-open — the banner still discloses the mismatch to the agent even if this write fails */
  }
}

// P-004: fetch the session's carry brief (P-003 renderCarryBriefText) from the
// local operator. Fail-soft: null on any failure — the static anchor still lands.
async function fetchCarryBrief(intent) {
  const owner = process.env.PAPERCUSP_SID || intent.sid;
  if (!owner) return null;
  const base = (process.env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070').replace(/\\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  try {
    const res = await fetch(base + '/api/agent-mcp/session-recovery-brief?owner=' + encodeURIComponent(owner), { signal: ctl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// P-005 (owner-directive-delivery-redesign-2026-09-22): every context wipe is a
// new delivery epoch, so the turn-start orientation — and the open owner
// directives in it — re-delivers in full instead of staying suppressed as
// "already told" for a context that never saw it. \`compact\` bumps it through
// the recovery brief; startup/resume/clear bump it here. Fail-soft, and bounded
// well under the hook's own budget.
async function bumpContextEpoch(intent, source) {
  const owner = process.env.PAPERCUSP_SID || intent.sid;
  if (!owner) return;
  const base = (process.env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070').replace(/\\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    await fetch(
      base + '/api/agent-mcp/context-epoch-bump?owner=' + encodeURIComponent(owner) + '&source=' + encodeURIComponent(source),
      { method: 'POST', signal: ctl.signal },
    );
  } catch {
    /* fail-soft — a missed bump degrades to the prior suppression, never a failed start */
  } finally {
    clearTimeout(timer);
  }
}

// P-007: identity durability across relaunch. When the LIVE PAPERCUSP_SID
// differs from the sid recorded at launch, every ownerId-keyed surface (armed
// loop, loop carry-note + walls, claims, claim-spec, standing awaits, fleet
// membership, open held work-items, owner facts) is stranded under the dead
// predecessor id. Auto-rebind via the local operator (idempotent server-side);
// on refusal/failure surface the one-call manual instruction instead. Returns
// { rebound, to, text } or null when identities agree / either id is unknown.
async function rebindIdentityIfChanged(intent) {
  const live = (process.env.PAPERCUSP_SID || '').trim();
  const recorded = ((intent && intent.sid) || '').trim();
  if (!live || !recorded || live === recorded) return null;
  const head = '⚠ IDENTITY CHANGED ACROSS RELAUNCH — recorded PAPERCUSP_SID ' + recorded + ' → live ' + live + '. Your armed loop, loop carry-note (+walls), claims, claim-spec, standing awaits, fleet membership and open held work-items were keyed under the OLD id.';
  const manual = 'VERIFY FIRST: use coord:whoami and coord:orient { afterCompaction: true } to confirm this successor, that the predecessor is dead, and that no protected predecessor state remains (claims, held work, presence, membership, or leadership). This banner does not authorize an identity rebind or a force override.';
  const base = (process.env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070').replace(/\\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  try {
    const res = await fetch(base + '/api/agent-mcp/rebind-identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: recorded, to: live }),
      signal: ctl.signal,
    });
    const body = res.ok ? await res.json() : null;
    if (body && body.ok) {
      const counts = (body.surfaces || [])
        .map((s) => ({ surface: s.surface, n: (s.moved || 0) + (s.dropped || 0) + (s.cancelled || 0) + (s.appended || 0) }))
        .filter((s) => s.n > 0)
        .map((s) => s.surface + ':' + s.n)
        .join(', ');
      return {
        rebound: true,
        to: live,
        text: head + ' AUTO-REBOUND to the live id just now: ' + (counts || 'nothing was keyed under the old id') + '. Verify with coord:orient { afterCompaction: true }.',
      };
    }
    if (body && body.refused === 'from_appears_live') {
      const st = body.fromSessionState ? ' as sessionState=' + body.fromSessionState : '';
      return { rebound: false, to: live, text: head + ' AUTO-REBIND REFUSED — the old id still resolves' + st + ' through the liveness oracle, so a DIFFERENT live session may hold it. ' + manual };
    }
    return { rebound: false, to: live, text: head + ' Auto-rebind did not complete. ' + manual };
  } catch {
    return { rebound: false, to: live, text: head + ' The operator was unreachable for auto-rebind. ' + manual };
  } finally {
    clearTimeout(timer);
  }
}

// P-004: the post-compaction continuity anchor. The mandate + volatile-claims
// checklist are static (deliver even with the operator down); the carry brief
// is the live part.
async function compactAnchor(intent) {
  const anchor = [
    '⚠ POST-COMPACTION CONTINUITY ANCHOR — injected by the SessionStart[source=compact] hook. Live reads below, not summary prose.',
    // turn-provenance-owner-vs-agent-2026-07-11 P-004: a NATIVE auto-compaction
    // continuation cannot be pre-tagged by any injector (Claude generates it
    // internally), so the compact-source hook is the one place that can stamp it.
    '⟦turn-provenance⟧ MACHINE-GENERATED CONTINUATION — this post-compaction turn (the summary above it and any continuation prompt) was produced by the compaction machinery, NOT typed by the human owner. Never attribute its text to the owner; owner directives must trace to a turn stamped OWNER (interactive) or to the pre-compaction verbatim transcript (sessions:search).',
    // EI-10942: the MCP tool schemas a Claude session loads are DEFERRED and do NOT
    // survive a compaction — so a post-compaction turn starts blind and re-discovers
    // the SAME core su tools one failed call at a time (measured: 11 ToolSearch calls in
    // one session, the same 5 core tools re-selected 4-5× each). Hand the successor the
    // exact single batched select up front so the whole core loads in ONE round-trip.
    // Deliberately the SHORT post-compaction-resume subset (not the full ~40-tool OMP
    // spine) — enough to orient, resume held items, reply, file, and batch, without
    // burning anchor context on tools this turn is unlikely to touch.
    'TOOL PRELOAD (do this FIRST — deferred MCP schemas were dropped by the compaction; re-load the core su set in ONE ToolSearch instead of rediscovering them call-by-call): ToolSearch { query: "select:mcp__papercusp-su__coord_orient,mcp__papercusp-su__coord_declare_intent,mcp__papercusp-su__work_items_get,mcp__papercusp-su__work_items_checkpoint,mcp__papercusp-su__work_items_complete,mcp__papercusp-su__improvements_capture,mcp__papercusp-su__coord_send,mcp__papercusp-su__code_run" }',
    'FIRST ACTION (after the preload): ' + MARKER_AWARE_RECOVERY,
    'VOLATILE-CLAIMS CHECKLIST — your compaction summary is a STALE SNAPSHOT of a live system. Treat these summary statements as HYPOTHESES to re-verify, never facts:',
    '- liveness / fleet counts ("N members alive/working") — re-read via coord:presence + fleet:status;',
    '- service up/down states (deploys, ports, restarts, wedged/fixed) — re-probe before acting on them;',
    '- quantities and totals (queue depths, item counts, test counts) — re-measure before repeating them.',
    "Anything the summary dropped is recoverable verbatim: sessions:search { session:'self', mode:'verbatim', query:'<what you remember>' }.",
  ].join('\\n');
  const brief = await fetchCarryBrief(intent);
  return brief
    ? anchor + '\\n\\nYour carry brief (read live from the carry surfaces just now):\\n\\n' + brief
    : anchor;
}

// WI-4275-adjacent (2026-07-12): SELF-HEAL the psu-managed settings.json keys.
// Claude Code's own settings-save (e.g. /model, /effort persisting defaults)
// can REWRITE the session settings.json with only its in-memory keys — wiping
// the statusLine (fleet title goes permanently stale: the "windows desktop
// leader" frozen-title incident), the bypassPermissions grant, AND this very
// hook's SessionStart registration. Re-assert all three, non-destructively
// (merge; never touch foreign values), on every session start. Fail-open: a
// repair hiccup never blocks the start.
function selfHealSettings() {
  try {
    const path = join(dir, 'settings.json');
    if (!existsSync(path)) return null;
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    if (!cfg || typeof cfg !== 'object') return null;
    const fixed = [];
    // (a) statusLine — copy from the global settings when ours is absent and
    // the global one is the papercusp fleet statusline (never install a
    // foreign/personal statusLine on the user's behalf).
    if (!cfg.statusLine) {
      try {
        const home = process.env.HOME || '';
        const g = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
        if (g && g.statusLine && String(g.statusLine.command || '').includes('statusline-fleet.sh')) {
          cfg.statusLine = g.statusLine;
          fixed.push('statusLine');
        }
      } catch {}
    }
    // (b) the bypassPermissions grant this session type was materialized with.
    const perms = cfg.permissions && typeof cfg.permissions === 'object' ? cfg.permissions : {};
    if (perms.defaultMode !== 'bypassPermissions') {
      cfg.permissions = Object.assign({}, perms, { defaultMode: 'bypassPermissions' });
      fixed.push('permissions.defaultMode');
    }
    // (b2) EI-12086: the claude 2.1.209+ skip-the-bypass-accept-prompt grant —
    // same settings-rewrite-damage class. A settings-save that drops it re-wedges
    // a headless member on the "Yes, I accept" prompt after a self-re-exec.
    if (cfg.skipDangerousModePermissionPrompt !== true) {
      cfg.skipDangerousModePermissionPrompt = true;
      fixed.push('skipDangerousModePermissionPrompt');
    }
    // (c) this hook's own SessionStart registration (without it, the next
    // relaunch loses playbook recovery AND this self-heal).
    const hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
    const groups = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const registered = JSON.stringify(groups).includes('session-recover-hook.mjs');
    if (!registered) {
      groups.push({
        hooks: [
          {
            type: 'command',
            command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(dir, 'session-recover-hook.mjs')),
            timeout: 30,
          },
        ],
      });
      hooks.SessionStart = groups;
      cfg.hooks = hooks;
      fixed.push('hooks.SessionStart');
    }
    if (!fixed.length) return null;
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    return fixed;
  } catch {
    return null;
  }
}

// Same rewrite-damage class, second victim: claude's .claude.json rewrites can
// drop the session's papercusp-su MCP server definition — the session then runs
// with NO coordination tools until someone notices (2026-07-12: hours of
// checkpoints/completions queued behind a "disconnected MCP" that was really a
// missing config entry). Re-assert it from the global ~/.claude.json when the
// session copy lacks it. Non-destructive; fail-open.
function selfHealMcpConfig() {
  try {
    const path = join(dir, '.claude.json');
    if (!existsSync(path)) return null;
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    if (!cfg || typeof cfg !== 'object') return null;
    const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
    if (servers['papercusp-su']) return null;
    const home = process.env.HOME || '';
    const g = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const src = g && g.mcpServers ? g.mcpServers['papercusp-su'] : null;
    if (!src) return null;
    servers['papercusp-su'] = src;
    cfg.mcpServers = servers;
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    return ['mcpServers.papercusp-su'];
  } catch {
    return null;
  }
}

try {
  const input = await readStdinJson();
  let intent = {};
  try { intent = JSON.parse(readFileSync(INTENT, 'utf8')); } catch {}
  const parts = [];
  try { selfHealSettings(); } catch {}
  try { selfHealMcpConfig(); } catch {}
  try {
    const p = playbookRecovery(intent);
    if (p) parts.push(p);
    if (p && input.session_id) {
      reportSelfRelaunchNativeId(process.env.PAPERCUSP_SID || intent.sid, input.session_id);
    }
  } catch {}
  try {
    const rb = await rebindIdentityIfChanged(intent);
    if (rb) {
      parts.push(rb.text);
      // A successful rebind retires the old sid: rewrite the parked intent so
      // subsequent SessionStarts don't re-fire (the rebind itself is idempotent).
      if (rb.rebound) {
        try { writeFileSync(INTENT, JSON.stringify({ ...intent, sid: rb.to }, null, 2), { mode: 0o600 }); } catch {}
      }
    }
  } catch {}
  const source = input.source || '';
  if (source === 'compact') {
    try {
      const a = await compactAnchor(intent);
      if (a) parts.push(a);
    } catch {}
  } else if (source === 'startup' || source === 'resume' || source === 'clear') {
    try { await bumpContextEpoch(intent, source); } catch {}
  }
  if (parts.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: parts.join('\\n\\n'),
      },
    }));
  }
  process.exit(0);
} catch {
  process.exit(0); // never block a session start
}
`;

/**
 * WI-3280: park the launch playbook + intent metadata in the config dir, and
 * (re)write the recovery hook script itself. The hook + settings entry are
 * written on EVERY materialize (inert without a parked playbook); the playbook
 * copy is written only when the caller supplies one — a resume-path
 * re-materialize without `recovery` deliberately KEEPS the original launch's
 * parked copy, so late re-execs (and raw `claude` launches in this config dir)
 * still recover the correct playbook. Best-effort throughout: a failed write
 * degrades to today's behavior (argv-only delivery), never a failed launch.
 */
async function writeRecoveryArtifacts(
  configDir: string,
  recovery?: { playbookPath?: string | null; nativeSessionId?: string | null; sid?: string },
): Promise<void> {
  try {
    await writeFileAsync(join(configDir, RECOVER_HOOK), RECOVER_HOOK_SOURCE, { mode: 0o700 });
  } catch {
    /* hook unwritable — argv delivery still stands */
  }
  if (!recovery?.playbookPath) return;
  try {
    const playbook = await readFileAsync(recovery.playbookPath, 'utf8');
    await writeFileAsync(join(configDir, RECOVER_PLAYBOOK), playbook, { mode: 0o600 });
    await writeFileAsync(
      join(configDir, RECOVER_INTENT),
      JSON.stringify(
        {
          sid: recovery.sid ?? null,
          nativeSessionId: recovery.nativeSessionId ?? null,
          playbookPath: recovery.playbookPath,
          writtenAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch {
    /* unreadable playbook — nothing to park; the hook stays inert */
  }
}

/**
 * ASSERT `hasCompletedOnboarding` in the global `~/.claude.json` before the
 * mirror symlinks it in. The mirror's whole premise (see the header note on the
 * onboarding/trust state) is that this file says onboarding is DONE — but it
 * only ever *assumed* that, and the flag is not stable:
 *
 * - When it reads `false`, claude boots into its first-run wizard (theme
 *   picker). A psu session then NEVER reaches a prompt, so the kickoff turn can
 *   never be delivered and the agent is dead on arrival — with no error, just a
 *   terminal parked on a menu forever. It breaks EVERY interactive psu launch
 *   (`capability:launch-agent`, `capability:terminal`, `fleet:launch-on-plan`,
 *   and every resume), not one caller.
 * - And it SELF-PROPAGATES: the session's `.claude.json` is a write-through
 *   SYMLINK, so a session wedged in that wizard writes its own
 *   not-yet-onboarded state straight back to the global file — one wedged
 *   session re-arms the trap for every launch that follows.
 *
 * Live-caught 2026-07-12 by the launch-agent live-verify: the flag had flipped
 * to `false` and killed the probe on boot, while every backup of the file going
 * back months has it `true`. So assert it here instead of assuming it — the
 * same self-heal shape `selfHealSettings` / `selfHealMcpConfig` already apply to
 * the other two files claude rewrites out from under us.
 *
 * Touches ONLY this key (never a foreign value); atomic (temp + rename — peers
 * rewrite this file constantly); idempotent (no write once true); fail-open (a
 * launch must never die on a repair hiccup). Note `theme` is deliberately NOT
 * seeded: the working backups have no theme key either, so it is not what gates
 * the wizard.
 *
 * WI-4431: a box with NO `~/.claude.json` at all (never run claude
 * interactively — plausible for a freshly provisioned headless fleet host) is
 * the SAME trap by a different door: the mirror only symlinks the file in
 * when one exists, so a missing file means the session gets none at all and
 * claude treats it as a genuine first-run user. Handled below by
 * materializing a minimal one rather than leaving that case as a no-op —
 * this function is only ever reached from an automated psu launch (never a
 * plain human `claude` invocation), so forcing onboarding-complete here is
 * always correct, not a UX shortcut taken on someone's behalf.
 */
export async function ensureOnboardingComplete(home: string): Promise<boolean> {
  const path = join(home, '.claude.json');
  return serializeByKey(claudeJsonMutationQueue, path, async () => {
    try {
    if (!(await existsAsync(path))) {
      // WI-4431: a box that has NEVER run claude interactively has nothing to
      // repair here, but the mirror below only symlinks `.claude.json` IN when
      // one already exists (`if (existsSync(srcJson))`) — with none, the session
      // gets no `.claude.json` at all and claude treats it as a true first-run
      // user, hitting the exact same theme-picker wedge this function exists to
      // prevent (observed live: a headless fleet member wedged forever with zero
      // error surfaced, because the operator's install-leg self-repair — a
      // SEPARATE, unrelated mechanism — was transiently unreachable and the box
      // had no prior global config to fall back on). Materialize a minimal one
      // instead of leaving a launch to gamble on a wizard. Deliberately bare: no
      // `mcpServers` (psu supplies MCP servers via `--mcp-config` argv, never
      // this file) and no `theme` key (see the doc comment above — the working
      // backups never carry one either, so it is not what gates the wizard).
      await writeFileAsync(path, JSON.stringify({ hasCompletedOnboarding: true }, null, 2), { mode: 0o600 });
      return true;
    }
    const cfg = JSON.parse(await readFileAsync(path, 'utf8')) as Record<string, unknown>;
    if (!cfg || typeof cfg !== 'object' || cfg.hasCompletedOnboarding === true) return false;
    cfg.hasCompletedOnboarding = true;
    const tmp = `${path}.psu-onboarding.${process.pid}.tmp`;
    await writeFileAsync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await renameAsync(tmp, path);
    return true;
    } catch {
      return false; // a wizard-blocked session is louder than a failed repair
    }
  });
}

/**
 * Ensure `~/.claude.json`'s per-PROJECT trust entry for `cwd` has every flag
 * that gates an INTERACTIVE prompt already pre-accepted, so a HEADLESS launch
 * into a cwd claude has never opened before cannot wedge on a TTY prompt
 * nobody is there to answer.
 *
 * EI-16574: a brand-new clone (`pot:create_from_repo` → a cwd claude has never
 * opened) has no `projects[cwd]` entry at all. The user-level CLAUDE.md's
 * external `@`-import (`@~/.papercusp/compaction-strategy.md`) then trips the
 * "Allow external CLAUDE.md file imports?" TTY prompt — gated behind
 * `hasClaudeMdExternalIncludesApproved` on that PROJECT'S entry, not the
 * GLOBAL `hasCompletedOnboarding` flag `ensureOnboardingComplete` above
 * already repairs (a genuinely separate gate, keyed per-cwd). A headless
 * member has nobody to answer it: it hangs FOREVER, holding a fleet slot,
 * with zero error surfaced — `fleet:launch-on-plan` reports the member as
 * launched (a durable join event is NOT liveness).
 *
 * Belt-and-braces: also pre-accept `hasTrustDialogAccepted` (the sibling
 * "Do you trust the files in this folder?" prompt) — any interactive-only
 * gate on a brand-new project directory is the same hang by a different
 * door, and this function is only ever reached from an automated psu launch
 * (never a plain human `claude` invocation), so pre-accepting every
 * per-project gate here is always correct, not a UX shortcut taken on
 * someone's behalf.
 *
 * Touches ONLY `projects[cwd]`'s trust keys — merges into whatever entry
 * already exists (never clobbers that project's `mcpServers`/history/metrics
 * on an already-trusted cwd); atomic (temp + rename — the file is hot, many
 * live sessions write it); idempotent (no-ops once every flag already reads
 * true); fail-open (a launch must never die on a repair hiccup).
 */
export async function ensureProjectTrust(home: string, cwd: string): Promise<boolean> {
  const path = join(home, '.claude.json');
  const trustFlags = {
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
    hasCompletedProjectOnboarding: true,
  };
  return serializeByKey(claudeJsonMutationQueue, path, async () => {
    try {
    if (!(await existsAsync(path))) {
      // Mirrors ensureOnboardingComplete's WI-4431 leg: a box with no global
      // config yet still needs THIS launch's cwd pre-trusted, not just the
      // global onboarding flag.
      await writeFileAsync(
        path,
        JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { ...trustFlags } } }, null, 2),
        { mode: 0o600 },
      );
      return true;
    }
    const cfg = JSON.parse(await readFileAsync(path, 'utf8')) as Record<string, unknown>;
    if (!cfg || typeof cfg !== 'object') return false;
    const projects = (cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}) as Record<
      string,
      unknown
    >;
    const existing = (projects[cwd] && typeof projects[cwd] === 'object' ? projects[cwd] : {}) as Record<
      string,
      unknown
    >;
    const alreadyTrusted =
      existing.hasTrustDialogAccepted === true &&
      existing.hasClaudeMdExternalIncludesApproved === true &&
      existing.hasClaudeMdExternalIncludesWarningShown === true &&
      existing.hasCompletedProjectOnboarding === true;
    if (alreadyTrusted) return false;
    projects[cwd] = { ...existing, ...trustFlags };
    cfg.projects = projects;
    const tmp = `${path}.psu-project-trust.${process.pid}.tmp`;
    await writeFileAsync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await renameAsync(tmp, path);
    return true;
    } catch {
      return false; // a wizard-blocked session is louder than a failed repair
    }
  });
}

/** True if a path already exists as a real file/dir OR as a (possibly dangling)
 *  symlink — `existsSync` returns false for a dangling link, but on resume we
 *  must still treat an existing link as "leave it". */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function linkInto(src: string, dest: string): void {
  if (present(dest)) return; // idempotent — a resume re-materialize must not double-link
  try {
    symlinkSync(src, dest);
  } catch {
    /* best-effort — claude surfaces a missing entry the same as a fresh user */
  }
}

async function existsAsync(path: string): Promise<boolean> {
  try {
    await accessAsync(path);
    return true;
  } catch {
    return false;
  }
}

async function presentAsync(path: string): Promise<boolean> {
  try {
    await lstatAsync(path);
    return true;
  } catch {
    return false;
  }
}

async function linkIntoAsync(src: string, dest: string): Promise<void> {
  if (await presentAsync(dest)) return;
  try {
    await symlinkAsync(src, dest);
  } catch {
    /* best-effort — claude surfaces a missing entry the same as a fresh user */
  }
}

/**
 * A PUI chat opened outside every registered checkout is Claude Code's own
 * agent, not the psu persona (pui-chat-first-ux-2026-09-28 P-007 / D-006), so
 * like stock `claude` it loads the user's personal global memory. `include`
 * links exactly the PERSONAL_MEMORY_ENTRIES the mirror skips; `!include`
 * removes those links again, so a session whose identity changed on resume
 * never keeps them under the psu persona. Only our own symlinks are removed.
 */
export function syncPersonalClaudeMemory(configDir: string, include: boolean, home = homedir()): void {
  for (const name of PERSONAL_MEMORY_ENTRIES) {
    const src = join(home, '.claude', name);
    const dest = join(configDir, name);
    if (include) {
      if (present(src)) linkInto(src, dest);
      continue;
    }
    try {
      if (lstatSync(dest).isSymbolicLink() && readlinkSync(dest) === src) rmSync(dest);
    } catch {
      /* absent — nothing to remove */
    }
  }
}

/**
 * Build (or re-ensure, idempotently) the per-session interactive
 * `CLAUDE_CONFIG_DIR` for `sid` and return its path. The caller exports it as
 * `CLAUDE_CONFIG_DIR` on the claude child's env.
 *
 * `home` is the source environment (defaults to `homedir()`); the user's
 * `<home>/.claude/*` + `<home>/.claude.json` are mirrored from there. A box with
 * no `~/.claude` yet simply yields a dir with a fresh `projects/` (the session
 * runs as a first-run user would) — never throws.
 */
export async function writeInteractiveClaudeConfig(opts: {
  /** Per-session coord-owner id (`PAPERCUSP_SID`). Keys the dir via the shared
   *  helper, so launch and the wake-executor resume leg resolve the same path. */
  sid: string;
  /** Source HOME (testability); defaults to the process home. */
  home?: string;
  /**
   * context-trimming-tiers P-020: prune the heavy plugin/MCP surface for a
   * FLEET-tier member — `plugins/installed_plugins.json` is materialized as a
   * FILTERED real file (github/cloudflare/firecrawl dropped; context7 etc.
   * kept) and `.claude.json` as a filtered real copy (the playwright
   * mcpServer dropped; papercusp-su kept). Costs those two files their
   * write-passthrough — fine for a spawned member; default off (symlinks,
   * byte-identical to today).
   */
  prunePlugins?: boolean;
  /**
   * WI-3280 (argv-proof playbook delivery): the launch playbook to PARK in the
   * config dir so the SessionStart recovery hook can re-deliver it when
   * claude's self-re-exec drops the argv (`--system-prompt-file` and all).
   * Omit on resume-path re-materializes — the original launch's parked copy is
   * kept. `nativeSessionId` is surfaced in the recovery banner so a recovered
   * session can disclose its degraded psu tracking.
   */
  recovery?: { playbookPath?: string | null; nativeSessionId?: string | null };
  /**
   * EI-16574: the cwd the claude child is about to launch in. When given,
   * `ensureProjectTrust` pre-accepts that cwd's per-project trust flags
   * (external-CLAUDE.md-imports + trust-dialog) BEFORE the mirror below
   * symlinks `.claude.json` in — otherwise a brand-new cwd (no prior
   * `projects[cwd]` entry) can wedge a HEADLESS launch forever on a TTY
   * prompt nobody is there to answer. Omit only for a launch whose cwd is
   * already known-trusted (e.g. a resume into an existing session's cwd).
   */
  cwd?: string;
}): Promise<InteractiveClaudeConfig> {
  const configDir = sessionClaudeConfigDir(opts.sid);
  return serializeByKey(interactiveMaterializationQueue, configDir, () =>
    materializeInteractiveClaudeConfig(opts, configDir),
  );
}

type InteractiveClaudeConfigOptions = Parameters<typeof writeInteractiveClaudeConfig>[0];

async function materializeInteractiveClaudeConfig(
  opts: InteractiveClaudeConfigOptions,
  configDir: string,
): Promise<InteractiveClaudeConfig> {
  const home = opts.home ?? homedir();
  await mkdirAsync(configDir, { recursive: true });

  // Seed-from-newest: converge the global file (and any forks) on the newest
  // OAuth bundle BEFORE mirroring, so the `.credentials.json` symlink below
  // points at a live token even when a peer session rotated it last.
  // Best-effort — a launch must never fail on credential reconciliation.
  // Skipped under vitest (same pattern as testing-run-store.ts): the bootstrap
  // route tests reach this with the REAL home + session root, and a unit test
  // must never rewrite the user's live credential files. The reconcile logic
  // has its own isolated tests in claude-credential-sync.test.ts.
  if (!process.env.VITEST) {
    try {
      // Ensure the global ~/.claude exists BEFORE reconciling. The credential
      // sync only PROMOTES a session-fork login to the global `.credentials.
      // json` when ~/.claude already exists (it deliberately won't materialize
      // the dir from its watcher path). On a FRESH box with no ~/.claude, a
      // `claude /login` done INSIDE a psu session writes a real `.credentials.
      // json` into the SESSION dir — and without this it is stranded there: the
      // next psu session gets a fresh dir whose `.credentials.json` symlink
      // dangles, so psu "launches logged out" even though the user logged in
      // once. Creating ~/.claude here lets reconcile lift that fork to the
      // global, so EVERY later psu session (default account) inherits the single
      // CLI login — on a fresh box too. Idempotent; an API-key-only box just
      // gets an empty dir claude would have created on first global use anyway.
      // (psu-login-inherit: fresh-box credential promotion.)
      await mkdirAsync(join(home, '.claude'), { recursive: true });
      // WI-10005186: awaited, async — this runs on the operator main thread
      // (bootstrap/resume request routes), and a propagating pass renames one
      // temp file per credential fork; synchronous, that froze the event loop
      // in ext4 journal waits.
      await reconcileClaudeCredentials({ home });
    } catch {
      /* claude surfaces a stale credential the same as before this existed */
    }
    // Same "claude rewrote a file we depend on" class as the credential fork
    // above: repair the onboarding flag the mirror is about to symlink in, or
    // this session boots into the first-run wizard and never reaches a prompt.
    await ensureOnboardingComplete(home);
    // EI-16574: also pre-trust THIS launch's cwd (see ensureProjectTrust) so a
    // brand-new project directory (no prior `projects[cwd]` entry) can't wedge
    // a headless member forever on the external-CLAUDE.md-imports / trust-dialog
    // prompts — a genuinely separate, per-cwd gate from the global onboarding
    // flag repaired just above.
    if (opts.cwd) await ensureProjectTrust(home, opts.cwd);
  }

  // Mirror every top-level `~/.claude` entry EXCEPT the transcript store.
  const srcClaude = join(home, '.claude');
  let entries: string[] = [];
  try {
    entries = await readdirAsync(srcClaude); // includes dotfiles (.credentials.json, …)
  } catch {
    /* no ~/.claude on this box — fall through to a fresh projects/ only */
  }
  for (const name of entries) {
    if (name === ISOLATED_ENTRY) continue;
    // psu-isolation P-002 / D-001: never mirror the user's personal global
    // memory — a psu session is steered only by the psu playbook + the P-001
    // project-guide splice, not the launching user's CLAUDE.md/AGENTS.md.
    if (PERSONAL_MEMORY_ENTRIES.has(name)) continue;
    // P-020 fleet plugin prune: `plugins` becomes a REAL dir whose children
    // symlink through, except installed_plugins.json which is a filtered copy.
    if (opts.prunePlugins && name === 'plugins') {
      await writePrunedPluginsDir(join(srcClaude, name), join(configDir, name));
      continue;
    }
    // WI-3278: settings.json is a REAL merged copy with the bypassPermissions
    // grant baked in — see writeSessionSettings.
    if (name === 'settings.json') {
      await writeSessionSettings(join(srcClaude, name), join(configDir, name));
      continue;
    }
    await linkIntoAsync(join(srcClaude, name), join(configDir, name));
  }
  // WI-3278: a box with no global settings.json (the fresh Windows VM) still
  // needs the session-level bypass grant.
  if (!entries.includes('settings.json')) {
    await writeSessionSettings(null, join(configDir, 'settings.json'));
  }

  // WI-3280: the SessionStart recovery hook (always) + the parked playbook
  // copy (when the caller supplies one) — see writeRecoveryArtifacts.
  await writeRecoveryArtifacts(configDir, { ...opts.recovery, sid: opts.sid });

  // The isolated conversation-transcript store — a REAL dir, never a symlink, so
  // `/resume` + `claude --resume <uuid>` see only this session's transcripts.
  // mkdir is idempotent and never clobbers an existing (resumed) transcript.
  await mkdirAsync(join(configDir, ISOLATED_ENTRY), { recursive: true });

  // The sibling `~/.claude.json` also relocates under CLAUDE_CONFIG_DIR on
  // current claude — symlink it so the session keeps the user-level MCP servers
  // (claude's `papercusp-su` lives here), onboarding-complete + per-project trust
  // (no re-onboarding), theme, and MCP approvals. Writes pass through to the real
  // file, exactly as a non-isolated session shares it today.
  const srcJson = join(home, '.claude.json');
  if (await existsAsync(srcJson)) {
    if (opts.prunePlugins) {
      // P-020: a filtered REAL copy — the playwright mcpServer dropped
      // (papercusp-su + everything else kept verbatim).
      await writePrunedClaudeJson(srcJson, join(configDir, '.claude.json'));
    } else {
      await linkIntoAsync(srcJson, join(configDir, '.claude.json'));
    }
  }

  return { configDir };
}

/**
 * Is `configDir` a LAUNCH-READY interactive config dir — i.e. did
 * `writeInteractiveClaudeConfig` build it — or is it merely transcript-bearing?
 *
 * The distinction exists because a session's `CLAUDE_CONFIG_DIR` can come into
 * being three ways, and only one of them is launch-ready:
 *   1. `writeInteractiveClaudeConfig` (fresh psu launch) — the full symlink
 *      mirror. READY.
 *   2. `writeSpawnClaudeConfig(persistentDir)` (orchestrator bee / plan-run) —
 *      a DELIBERATELY minimal dir: the `.credentials.json` symlink and nothing
 *      else. Correct for a headless `-p` worker, NOT launch-ready for a human.
 *   3. `rematerializeSession` (an archived session restored on resume) — the
 *      archive holds only the TRANSCRIPT, so the dir comes back with
 *      `projects/**` and nothing else.
 *
 * Cases 2+3 have no `.claude.json`, and that file — not `.credentials.json` —
 * is where claude keeps `oauthAccount` / `hasCompletedOnboarding` / per-project
 * trust. A valid credential symlink with no `.claude.json` therefore boots an
 * interactive resume into the FIRST-RUN wizard (a /login screen) despite a
 * perfectly healthy system login — the owner-reported psu-resume-relogin bug
 * (EI-12938, 2026-07-16; earlier legs WI-4159 + the 2026-07-12 route fix).
 *
 * The check keys on `.claude.json` because it is both the file that gates the
 * wizard and the one only the mirror provides:
 *   - a SYMLINK THAT RESOLVES ⇒ the mirror linked the user's real config in.
 *     READY. (A DANGLING one is not: `lstat` still reports a symlink, so the
 *     check must read THROUGH it — a link whose target was deleted/relocated
 *     gives claude nothing, which is the same wizard by a different door.)
 *   - a real file WITH `mcpServers` ⇒ a P-020 pruned fleet copy (filtered, but
 *     complete). READY — and reported ready deliberately, so a re-ensure never
 *     silently UN-prunes a context-trimmed member.
 *   - a real file WITHOUT `mcpServers` ⇒ the stub claude mints for ITSELF on a
 *     first-run boot. NOT ready: it carries an `oauthAccount` (so the *second*
 *     launch stops prompting — the "re-run it and it works" symptom) but no MCP
 *     servers and no hooks, i.e. a silently TOOL-LESS session on a shared tree.
 *     That is worse than the login prompt and must be repaired, not accepted.
 *   - absent/unreadable ⇒ NOT ready.
 * Pure + never throws — `home` is not needed (the dir speaks for itself).
 */
export async function isInteractiveClaudeConfigReady(configDir: string): Promise<boolean> {
  try {
    const path = join(configDir, '.claude.json');
    const entry = await lstatAsync(path); // throws when absent
    const cfg = JSON.parse(await readFileAsync(path, 'utf8')) as Record<string, unknown> | null; // throws when dangling
    if (!cfg || typeof cfg !== 'object') return false;
    return entry.isSymbolicLink() || cfg.mcpServers != null;
  } catch {
    return false; // absent, dangling, or corrupt — re-materialize over it
  }
}

/**
 * Make `sid`'s config dir launch-ready for an INTERACTIVE claude session,
 * repairing it only when it isn't (`isInteractiveClaudeConfigReady`).
 *
 * THE choke point for the psu-resume-relogin class. A FRESH launch has always
 * been fine — bootstrap-su calls `writeInteractiveClaudeConfig`. A RESUME does
 * no bootstrap POST, so every resume leg that points `CLAUDE_CONFIG_DIR` at a
 * dir it did not build has to re-ensure it here, or the human lands in the
 * first-run wizard (see `isInteractiveClaudeConfigReady`). Callers today:
 * `console-launcher` (the desktop Resume console), `POST /adv/sessions/
 * ensure-claude-config` (psu's resume leg — psu is plain node and cannot import
 * this module), and the rematerialize route.
 *
 * Deliberately NOT called from inside `rematerializeSession`: the wake-executor
 * restores into a headless bee's dir, whose plugin-free isolation is the whole
 * point of `writeSpawnClaudeConfig` (a full mirror there would re-introduce the
 * plugin-checkout-into-cwd defect). "Interactive" is the caller's claim to make.
 *
 * The ready-check is what keeps this cheap + non-destructive: a healthy dir is
 * left byte-identical (no re-link churn, no un-pruning) and pays one lstat.
 * Never throws — a launch must never fail on config repair; a failed repair
 * degrades to exactly today's behavior.
 */
export async function ensureInteractiveClaudeConfig(opts: {
  /** Per-session coord-owner id (`PAPERCUSP_SID`) — keys the dir. */
  sid: string;
  /** Source HOME (testability); defaults to the process home. */
  home?: string;
}): Promise<{ configDir: string; repaired: boolean }> {
  const configDir = sessionClaudeConfigDir(opts.sid);
  return serializeByKey(interactiveMaterializationQueue, configDir, async () => {
    if (await isInteractiveClaudeConfigReady(configDir)) return { configDir, repaired: false };
    try {
      // Clear the .claude.json we just judged NOT launch-ready, or the mirror
      // cannot replace it: linkIntoAsync is presentAsync-skipped (deliberately
      // — a re-materialize must not double-link), so claude's own first-run stub
      // would BLOCK its own repair and the dir would stay tool-less forever.
      // Only reached for a dir the ready-check rejected: a stub (claude's, not
      // the user's — losing its accrued state is the point), a dangling link,
      // or a corrupt file. A healthy or pruned dir returns above, untouched.
      await rmAsync(join(configDir, '.claude.json'), { force: true });
      await materializeInteractiveClaudeConfig({ sid: opts.sid, home: opts.home }, configDir);
      return { configDir, repaired: true };
    } catch {
      return { configDir, repaired: false };
    }
  });
}

/**
 * WI-3278: the session's `settings.json` is a REAL MERGED COPY of the user's
 * global settings with `permissions.defaultMode = 'bypassPermissions'` baked in
 * — NOT a symlink. psu grants a session its dangerous permissions via CLI argv
 * (`--permission-mode bypassPermissions` + `--dangerously-skip-permissions`),
 * but claude 2.1.20x can SELF-RE-EXEC (TUI fullscreen switch / update relaunch,
 * seen live on the Windows VM 2026-07-06: /proc showed a bare argv-less claude
 * under CLAUDE_CODE_TUI_JUST_SWITCHED=fullscreen while the psu-pty meta held
 * the full intended argv) and the re-exec DROPS the argv — the session reboots
 * in default mode and prompts for every papercusp-su call, with no playbook.
 * Settings are re-read from CLAUDE_CONFIG_DIR on every (re)boot, so the grant
 * survives here; the argv flags stay as the launch-time fast path. Costs this
 * file its write-passthrough: global hook edits reach the NEXT launch's merge,
 * not a live session — acceptable, the dir is re-materialized per launch.
 * Rewritten (not `present()`-skipped) on every materialize so resumes pick up
 * fresh global hooks; a pre-fix dir's SYMLINK is removed first so the write
 * lands in the session dir, never through the link into the user's real file.
 */
async function writeSessionSettings(srcSettings: string | null, dest: string): Promise<void> {
  let cfg: Record<string, unknown> = {};
  if (srcSettings) {
    try {
      cfg = JSON.parse(await readFileAsync(srcSettings, 'utf8')) as Record<string, unknown>;
    } catch {
      /* no/unparseable global settings — write the grant alone */
    }
  }
  const permissions = {
    ...(cfg.permissions as Record<string, unknown> | undefined),
    defaultMode: 'bypassPermissions',
  };
  // WI-3280: register the argv-drop recovery hook on SessionStart. APPENDED to
  // (never replacing) the user's global hook groups, and rebuilt from the
  // global file on every materialize, so it can't accumulate duplicates. The
  // node running the operator is the node the hook runs under (exists on every
  // box that can mint a session — the WSL-mounted sidecar node on the VM);
  // JSON.stringify-quoting keeps space-containing paths shell-safe.
  const hooks = { ...(cfg.hooks as Record<string, unknown> | undefined) };
  const sessionStart = Array.isArray(hooks.SessionStart) ? [...(hooks.SessionStart as unknown[])] : [];
  sessionStart.push({
    hooks: [
      {
        type: 'command',
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(dirname(dest), RECOVER_HOOK))}`,
        timeout: 30,
      },
    ],
  });
  hooks.SessionStart = sessionStart;
  try {
    if (await presentAsync(dest) && (await lstatAsync(dest)).isSymbolicLink()) await rmAsync(dest);
    // EI-12086: claude 2.1.209+ gates `--dangerously-skip-permissions` behind an
    // interactive "Bypass Permissions mode" accept prompt (❯ 1. No, exit / 2. Yes,
    // I accept) that a HEADLESS member can never answer — it wedges forever,
    // alive-but-idle, with no error. The prompt is skipped when
    // `skipDangerousModePermissionPrompt` is truthy in user/local settings —
    // claude's own gate is `!JG() && !accepted` where
    // `JG()=Cr("userSettings")?.skipDangerousModePermissionPrompt || Cr("localSettings")?…`,
    // so this key SHORT-CIRCUITS the whole check. (The sibling `.claude.json`
    // `bypassPermissionsModeAccepted` flag was NOT honored from the isolated
    // config dir — this settings key is the reliable lever.) Baked into the
    // session settings so it survives a claude self-re-exec and never depends on
    // the mutable global settings.json.
    // WI-6603: the fleet-policy setting defaults land AFTER `...cfg` so they win
    // over a stale/personal value in the user's global settings — see
    // PAPERCUSP_SESSION_SETTING_DEFAULTS for why each stock default is wrong here.
    await writeFileAsync(
      dest,
      JSON.stringify(
        {
          ...cfg,
          ...PAPERCUSP_SESSION_SETTING_DEFAULTS,
          permissions,
          hooks,
          skipDangerousModePermissionPrompt: true,
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort — argv still carries the grant on a non-re-exec launch */
  }
}

/** P-020: mirror `~/.claude/plugins` as a real dir — every child symlinked
 *  through except `installed_plugins.json`, which is written as a FILTERED
 *  real copy (FLEET_PRUNED_PLUGIN_NAMES dropped). Best-effort: any failure
 *  falls back to the plain symlink (a full plugin surface, never a broken one). */
async function writePrunedPluginsDir(srcPlugins: string, destPlugins: string): Promise<void> {
  if (await presentAsync(destPlugins)) return; // idempotent (resume)
  try {
    await mkdirAsync(destPlugins, { recursive: true });
    for (const child of await readdirAsync(srcPlugins)) {
      if (child === 'installed_plugins.json') continue;
      await linkIntoAsync(join(srcPlugins, child), join(destPlugins, child));
    }
    const regPath = join(srcPlugins, 'installed_plugins.json');
    if (await existsAsync(regPath)) {
      const reg = JSON.parse(await readFileAsync(regPath, 'utf8')) as {
        plugins?: Record<string, unknown>;
      };
      if (reg.plugins && typeof reg.plugins === 'object') {
        reg.plugins = Object.fromEntries(
          Object.entries(reg.plugins).filter(([key]) => {
            const name = key.split('@')[0] ?? key;
            return !FLEET_PRUNED_PLUGIN_NAMES.has(name);
          }),
        );
      }
      await writeFileAsync(join(destPlugins, 'installed_plugins.json'), JSON.stringify(reg, null, 1));
    }
  } catch {
    // Fall back to the full symlink — never a broken plugins dir.
    try {
      await rmAsync(destPlugins, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    await linkIntoAsync(srcPlugins, destPlugins);
  }
}

/** P-020: write a filtered real copy of `~/.claude.json` with the pruned
 *  mcpServers removed. Best-effort: any failure falls back to the symlink. */
async function writePrunedClaudeJson(srcJson: string, destJson: string): Promise<void> {
  if (await presentAsync(destJson)) return; // idempotent (resume)
  try {
    const j = JSON.parse(await readFileAsync(srcJson, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    if (j.mcpServers && typeof j.mcpServers === 'object') {
      j.mcpServers = Object.fromEntries(
        Object.entries(j.mcpServers).filter(([name]) => !FLEET_PRUNED_MCP_SERVERS.has(name)),
      );
    }
    await writeFileAsync(destJson, JSON.stringify(j, null, 1));
  } catch {
    await linkIntoAsync(srcJson, destJson);
  }
}
