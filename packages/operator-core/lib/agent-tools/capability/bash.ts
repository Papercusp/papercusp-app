/**
 * capability:bash — run a shell command. A THIN wrapper over a real `bash -c`
 * (D-004 — wraps real execution, no reimplementation), routed through the
 * shared endpoint dispatch so policy / capability-envelope / telemetry apply
 * (P-010, `agent-capability-confinement-2026-06-13`). It replicates the native
 * Bash tool's ergonomics: combined output streaming (the `output` event),
 * truncation/overflow-to-file, and durable jobs (`run_in_background`).
 *
 * Ordinary calls start one durable job and stream while waiting. Fast commands
 * return terminal output; a command that exceeds the bounded response window
 * returns that SAME job's `bash_id`/`task_id` without killing or restarting it.
 * `timeout` remains the independent execution deadline. Explicit background
 * mode returns the handles immediately; read
 * incremental output with `capability:bash_output` and stop it with
 * `processes:kill` — the way a 5-minute build is run without holding one
 * blocking request. The task id remains observable through the task ledger if
 * the operator restarts and its in-memory bash-job map is lost.
 *
 * BOTH modes have a deadline; they do NOT share one (WI-6677). The explicit-background
 * default is hours, not the ordinary call's two minutes, because a background job
 * is by definition meant to outlive the call — see the constants in
 * `bash-jobs.ts` for why inheriting the foreground pair was a trap.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import {
  CAPABILITY_BASH_FOREGROUND_ENV,
  CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  detectBufferingLastStage,
  detectSelfOutputRedirect,
  detectUntrackedShellBackgrounding,
  formatBufferingPipelineAdvice,
  formatSelfRedirectAdvice,
  formatUntrackedShellBackgroundAdvice,
  MAX_BACKGROUND_TIMEOUT_MS,
  snapshotJobResult,
  startBackground,
  waitForJobResponse,
} from './bash-jobs';
import { FOREGROUND_TIMEOUT_CEILING_MS } from './foreground-transport-cap';
import { typecheckHeapLaunchWarning } from './background-typecheck-verdict';
import { similarity } from '../../operator-fuzzy-dedup';
import { capabilityExecSandboxPolicy } from './exec-sandbox';
import { displayForHive } from '../computer/desktop-lease';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { realpathSoft, resolveCapabilityBaseDir } from './base-dir';
import { maskIntegrationKey, readIntegrationKey } from '../../integration-credentials';
import { RIPGREP_SCOPE_GUIDANCE } from '../../code-intelligence/contracts.ts';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveBashTaskProvenance } from './bash-task-provenance';
import { listLiveTasks } from '../../task-manager/store';
import { loopLaunchRefusal } from '../../verification-attempts/loop-gate';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { readFrozenCandidateRepairQueue } from '../../harness/routines/release-actions';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  classifyFrozenLineageShellCommand,
  evaluateFrozenLineageShellCommand,
  frozenLineageShellCommandViolationPayload,
} from '../../release/frozen-lineage-execution-policy';
import { repoHeadSha } from '../../harness/docs/git-runner';
import { resolveCapabilityIntegrationRoot } from './base-dir';
import { classifyCapabilityBashEffect, commandBase, splitClassifiableShell } from './bash-effect';

export { classifyCapabilityBashEffect } from './bash-effect';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTEGRATION_KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_INTEGRATION_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
]);

const MIN_TIMEOUT_MS = 1_000;
const MIN_TIMEOUT_ERROR =
  `timeout must be at least ${MIN_TIMEOUT_MS}ms (1 second); timeout is expressed in milliseconds — ` +
  `for 20 seconds, pass 20000`;

const GIT_HISTORY_SUBCOMMANDS = new Set(['log', 'rev-list']);
const GIT_HISTORY_EXPANSION_OPTIONS = new Set(['--all', '--reflog', '--walk-reflogs']);

/**
 * A history search that walks every ref (or a broad working-tree pickaxe) can
 * retain a large amount of Git's object graph while it runs. capability:bash
 * otherwise gives background jobs a deliberately generous hours-long deadline,
 * so a missing commit bound turns one forensic typo into a resident high-RSS
 * process. Keep this detector deliberately conservative: only the simple shell
 * grammar already understood by splitClassifiableShell is classified, and every
 * unknown shell form falls through to the normal timeout/sandbox path.
 */
export interface UnboundedGitHistorySearch {
  excerpt: string;
  selectors: string[];
}

function gitHistoryArgs(segment: readonly string[]): readonly string[] | null {
  let commandIndex = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[commandIndex] ?? '')) commandIndex += 1;
  if (commandBase(segment[commandIndex] ?? '') !== 'git') return null;

  let index = commandIndex + 1;
  // Git global options may precede the subcommand. The recognized value-taking
  // forms cover normal git -C repo log / git -c key=value log calls without
  // treating an arbitrary option value as a subcommand.
  while (index < segment.length) {
    const token = segment[index]!;
    if (
      token === '-C' ||
      token === '--git-dir' ||
      token === '--work-tree' ||
      token === '--namespace' ||
      token === '-c'
    ) {
      index += 2;
      continue;
    }
    if (
      token.startsWith('-C') ||
      token.startsWith('--git-dir=') ||
      token.startsWith('--work-tree=') ||
      token.startsWith('--namespace=') ||
      token.startsWith('--exec-path=') ||
      token.startsWith('-c')
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    return GIT_HISTORY_SUBCOMMANDS.has(token.toLowerCase()) ? segment.slice(index + 1) : null;
  }
  return null;
}

function hasBoundedGitHistoryCount(tokens: readonly string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (/^-[0-9]+$/.test(token) || /^-n[0-9]+$/.test(token) || /^--max-count=[0-9]+$/.test(token)) return true;
    if ((token === '-n' || token === '--max-count') && /^[0-9]+$/.test(tokens[index + 1] ?? '')) return true;
  }
  return false;
}

/**
 * Detect a repository-history command whose revision walk has no explicit
 * commit bound. This is a launch guard, not a shell parser: callers that need
 * a complicated command still receive the existing timeout/process-tree
 * confinement behavior rather than a false refusal from this advisory rule.
 */
export function detectUnboundedGitHistorySearch(command: string): UnboundedGitHistorySearch | null {
  const segments = splitClassifiableShell(command);
  if (!segments) return null;

  for (const segment of segments) {
    const historyTokens = gitHistoryArgs(segment);
    if (!historyTokens) continue;

    const separator = historyTokens.indexOf('--');
    const optionTokens = separator >= 0 ? historyTokens.slice(0, separator) : historyTokens;
    const selectors = optionTokens.filter((token) => {
      if (GIT_HISTORY_EXPANSION_OPTIONS.has(token)) return true;
      if (/^--(?:branches|remotes|tags|glob)(?:=|$)/.test(token)) return true;
      if (/^-S(?:.+)?$/.test(token) || /^-G(?:.+)?$/.test(token)) return true;
      return /^--(?:pickaxe-(?:all|regex|string)|grep|author|committer)(?:=|$)/.test(token);
    });
    if (selectors.length === 0 || hasBoundedGitHistoryCount(optionTokens)) continue;

    const hasBroadPickaxeScope = selectors.some((token) =>
      /^-S|^-G|^--pickaxe-|^--(?:grep|author|committer)/.test(token),
    );
    if (GIT_HISTORY_EXPANSION_OPTIONS.has(selectors[0]!) || !hasBroadPickaxeScope) {
      return {
        excerpt: segment.join(' ').slice(0, 240),
        selectors,
      };
    }

    // A pickaxe over one named file is a normal forensic operation. The broad
    // forms are the repository root (.) or no pathspec at all.
    const pathspecs = separator >= 0 ? historyTokens.slice(separator + 1) : [];
    const broadPathspec =
      separator < 0 || pathspecs.length === 0 || pathspecs.some((path) => path === '.' || path === './');
    if (broadPathspec) {
      return {
        excerpt: segment.join(' ').slice(0, 240),
        selectors,
      };
    }
  }
  return null;
}

export function formatUnboundedGitHistorySearchAdvice(diagnostic: UnboundedGitHistorySearch): string {
  return (
    'Refused: this repository-history search has no explicit commit bound (' +
    diagnostic.excerpt +
    '). Unbounded git log/rev-list ' +
    diagnostic.selectors.join(', ') +
    ' scans can consume host CPU and RSS for hours. Add -n/--max-count (for example: ' +
    'git log --all -n 100 -- path/to/file) and prefer a focused path; split wider ' +
    'forensics into bounded ref/path chunks before relaunching.'
  );
}

/**
 * A stale harness registry can leave `ctx.projectDir` pointing at a directory
 * that no longer exists. `resolveCapabilityBaseDir` intentionally preserves
 * that path for the read/write/edit capability family, where changing the
 * shared resolver would alter their path semantics. Bash is different: its
 * child process cannot start with a missing cwd. For an implicit cwd only,
 * recover to the operator's existing integration root when one is available.
 * Explicit cwd arguments never pass through this recovery path.
 */
export function resolveBashDefaultCwd(baseDir: string): string {
  try {
    if (statSync(baseDir).isDirectory()) return baseDir;
  } catch {
    // Fall through to the integration-root recovery check.
  }

  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (!integrationRoot) return baseDir;

  try {
    if (!statSync(integrationRoot).isDirectory()) return baseDir;
  } catch {
    return baseDir;
  }

  // Keep the same real-path guarantee as resolveCapabilityBaseDir so the
  // exec-sandbox's writable cwd bind follows writes through symlinks.
  return realpathSoft(integrationRoot);
}

/** A near-match is a real repair candidate only above this — below it, two unrelated
 * short directory names can coincidentally score high, and a wrong guess is worse than
 * none (EI-21859036061097062: `evidence` vs `essence` scores 0.7 by raw Levenshtein). */
const CWD_SUGGESTION_SIMILARITY_FLOOR = 0.82;

/**
 * EI-21859036061097062: an explicit cwd whose failing SEGMENT is a near-miss rename of
 * a real sibling directory (measured: `papercuspai-workspace` for the long-lived
 * `papercupai-workspace` — an easy transposition once the harness itself is named
 * `papercusp`) fails with nothing to correct FROM. Walk up to the nearest existing
 * ancestor, and if EXACTLY ONE of its siblings is a close-enough rename of the missing
 * segment, reconstruct the corrected full path and verify it actually resolves before
 * suggesting it — this must never offer a guess that is itself still broken, and an
 * ambiguous (0 or 2+) match says nothing rather than pick one.
 */
export function suggestExistingCwd(cwd: string): string | undefined {
  // `probe` walks UP from `cwd` looking for the nearest existing ancestor; `cwd` itself
  // stays untouched so the remainder below is computed against the FULL original path,
  // not just the (possibly much shallower) non-existent prefix the walk stopped at.
  let probe = cwd;
  let ancestor = dirname(probe);
  // Walk up until an existing directory is found, or we hit the filesystem root
  // (dirname('/') === '/', which is the loop's only termination without a match).
  while (ancestor !== probe) {
    try {
      if (statSync(ancestor).isDirectory()) break;
    } catch {
      // Not this one either — keep walking up.
    }
    probe = ancestor;
    ancestor = dirname(probe);
  }
  if (ancestor === probe) return undefined; // no existing ancestor at all

  const remainder = cwd.slice(ancestor.length).replace(/^[/\\]+/, '');
  const missingSegment = remainder.split(/[/\\]/)[0];
  if (!missingSegment) return undefined;
  const rest = remainder.slice(missingSegment.length);

  let siblings: string[];
  try {
    siblings = readdirSync(ancestor);
  } catch {
    return undefined;
  }

  const candidates = siblings
    .filter((entry) => entry !== missingSegment)
    .map((entry) => ({ entry, score: similarity(entry, missingSegment) }))
    .filter(({ score }) => score >= CWD_SUGGESTION_SIMILARITY_FLOOR);
  if (candidates.length !== 1) return undefined; // no match, or too ambiguous to guess

  const rebuilt = join(ancestor, candidates[0]!.entry) + rest;
  try {
    if (statSync(rebuilt).isDirectory()) return rebuilt;
  } catch {
    // The reconstructed path doesn't check out either — say nothing rather than
    // suggest a path that is itself still broken.
  }
  return undefined;
}

/**
 * Node reports a nonexistent child cwd as an ENOENT on the BINARY
 * (`spawn /usr/bin/bash ENOENT`), which reads as "bash is missing" and has
 * been misdiagnosed that way (EI-21357058090189702, via code:run on a harness
 * whose registered repo root does not exist). Check the final cwd before any
 * spawn and fail with the real cause and the concrete fix instead.
 */
export function missingBashCwdError(cwd: string, explicitCwd: boolean): string | null {
  try {
    if (statSync(cwd).isDirectory()) return null;
    return (
      `capability:bash cwd '${cwd}' exists but is not a directory — the child process cannot start there. ` +
      `Pass an existing directory as cwd.`
    );
  } catch {
    // Missing (or unreadable) — fall through to the explanatory error below.
  }
  if (explicitCwd) {
    const suggestion = suggestExistingCwd(cwd);
    return (
      `capability:bash cwd '${cwd}' does not exist — the child process cannot start. ` +
      `(Node would report this as a misleading "spawn /usr/bin/bash ENOENT".) ` +
      (suggestion ? `Did you mean '${suggestion}'? ` : '') +
      `Pass an existing directory as cwd.`
    );
  }
  return (
    `capability:bash implicit cwd '${cwd}' (this context's project dir) does not exist, and no existing ` +
    `PAPERCUSP_INTEGRATION_ROOT was available to recover to — the harness registry likely points at a ` +
    `stale or phantom repo root. Pass cwd explicitly (an absolute path to an existing directory). ` +
    `(Node would otherwise report this as a misleading "spawn /usr/bin/bash ENOENT".)`
  );
}

const integrationEnvSchema = z
  .record(
    z.string().regex(ENV_NAME_RE, 'destination must be a valid environment variable name'),
    z.string().regex(INTEGRATION_KEY_NAME_RE, 'source must be a SCREAMING_SNAKE_CASE integration credential name'),
  )
  .refine((value) => Object.keys(value).length <= 16, 'integration_env accepts at most 16 entries')
  .refine(
    (value) => Object.keys(value).every((name) => !RESERVED_INTEGRATION_ENV_NAMES.has(name)),
    `integration_env cannot replace reserved process variables: ${[...RESERVED_INTEGRATION_ENV_NAMES].join(', ')}`,
  );

// Keep the machine-readable result contract aligned with every code-mode branch
// below. Most fields are optional because launch/yield/terminal/refusal payloads
// are intentionally branch-shaped; passthrough preserves diagnostics added by a
// branch without turning this schema into a closed-list trap for code:run callers.
const bashResultSchema = z
  .object({
    ok: z.boolean(),
    bash_id: z.string().optional(),
    task_id: z.string().optional(),
    status: z.enum(['running', 'completed', 'failed', 'killed', 'timed_out']).optional(),
    running: z.boolean().optional(),
    yielded: z.boolean().optional(),
    cleanup_pending: z.boolean().optional(),
    exit_code: z.number().int().nullable().optional(),
    duration_ms: z.number().nonnegative().optional(),
    cwd: z.string().optional(),
    output: z.string().optional(),
    truncated: z.boolean().optional(),
    total_bytes: z.number().int().nonnegative().optional(),
    log_path: z.string().optional(),
    response_window_ms: z.number().int().nonnegative().optional(),
    timeout_ms: z.number().int().nonnegative().optional(),
    deadline: z.string().optional(),
    advice: z.string().optional(),
    process_table_notice: z.string().optional(),
    integration_env: z
      .record(z.string(), z.object({ source: z.string(), masked: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

// A successful ps/pgrep exit is not evidence that a host process is absent:
// capability:bash can run behind a private PID namespace. Keep the warning in
// the result itself, where a kill-deciding caller sees it alongside the data.
function processTableNotice(command: string): string | undefined {
  if (!/\b(?:ps|pgrep|pidof|pstree)\b(?=\s|$)/.test(command)) return undefined;
  return 'Process-table output may be limited to this shell\'s PID namespace. An empty ps/pgrep/pidof/pstree result does not prove a host process is gone. Use processes:list and, when deciding cgroup lifetime, verify the recorded scope under /sys/fs/cgroup.';
}

export default defineTool({
  name: 'capability:bash',
  description:
    'Run `bash -c` in the project dir; stream and spill large output to a log. Operator callers may bind redacted integration credentials.',
  guidance: {
    // WI-71582: the `jq` tip below was CUT FROM THE PROMPT to clear the 1500-char
    // prompt-weight HARD CAP (this tool was 1613 — a gate RED). Kept here because a
    // comment costs ZERO prompt weight (promptWeight() sums description + when +
    // notWhen + chaining + byRole only, per the note at :247), so the knowledge is
    // preserved without the budget cost — do NOT paste it back into `when`:
    //   "For non-trivial `jq` filters, compile first with `jq -n` against no input
    //    before reading exports; this catches syntax errors without consuming export
    //    input."
    // It was the narrowest tip here (it helps only a non-trivial jq filter over a
    // consumable export), which is why it lost to the rg/backtick and background-job
    // guidance. If it needs to be agent-facing again, put it in a doc and point at it.
    when:
      'fixed-string searches: prefer `rg -F`, else `grep -F`; single-quote — unmatched backtick fails before either tool runs. ' +
      'Apostrophe regexes break single-quoted arguments; use `rg -F`, `-e` per pattern, or quoted stdin/file. ' +
      `${RIPGREP_SCOPE_GUIDANCE} Do not run an unbounded search from the repository root. Bound git history scans with \`-n\`; unbounded refused. do not shell-background child without \`wait\`.`,
    notWhen:
      'Use capability:read/write/edit for one-file ops and capability:git for git. Shell execution strips DB credential env vars, so use dev:pg_query for read-only operator DB queries.',
    chaining:
      'run_in_background:true returns bash_id + durable task_id → capability:bash_output { task_id }; stop with processes:kill { taskId }. Never push.',
    // EI-21543657511391052: the stale 'capability:bash_kill' entry is DELETED, not
    // replaced. It is absent from trimmed surfaces (su) and refuses some principals, so
    // it routed callers to a verb they could not invoke. No substitute is needed here
    // because `chaining` above already names the working route (processes:kill{taskId}).
    // NOTE for whoever edits this next: `seeAlso` is NOT summed by promptWeight()
    // (tool-guidance-budget.ts — description + when + notWhen + chaining + byRole only),
    // so changing this array cannot move the prompt-weight budget in either direction.
    seeAlso: ['capability:bash_output (read a backgrounded run)', 'capability:git (git actions, gated as git)'],
  },
  capability: 'capability:bash',
  effectForCall: classifyCapabilityBashEffect,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  // The handler waits at most the response window; the durable job owns the
  // potentially much longer execution deadline independently.
  timeoutSec: Math.floor(FOREGROUND_TIMEOUT_CEILING_MS / 1000) + 10,
  // EI-18666279107998059: this handler can await a child through the bounded
  // response window and never reads ctx.tx — without this, the host's
  // ambient workspace transaction sits idle for the whole exec and gets killed
  // by Postgres's idle_in_transaction_session_timeout (60s), surfacing as a
  // bare "write CONNECTION_CLOSED 127.0.0.1:6432" that correlates with call
  // duration, not the command. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  result: bashResultSchema,
  events: { output: z.string().describe('text/plain') },
  args: z.object({
    command: z
      .string()
      .min(1)
      .optional()
      .describe('The bash command to run (passed to `bash -c`). Required, unless `cmd` is given.'),
    cmd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Alias for `command`. Accepted because the Codex CLI\'s own native `shell` tool call uses "cmd" as its ' +
          'argument key (EI-22073622160284651: a Codex-backed agent reaching for this tool by habit typed `cmd` ' +
          'and was rejected), so an agent used to that convention can reach for it here too. Prefer `command`.',
      ),
    description: z
      .string()
      .optional()
      .describe('5–10 word description of what the command does (for telemetry / the agent log).'),
    timeout: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS, MIN_TIMEOUT_ERROR)
      .max(MAX_BACKGROUND_TIMEOUT_MS)
      .optional()
      .describe(
        `Wall-clock timeout in ms (minimum ${MIN_TIMEOUT_MS}; values below one second are rejected to catch ` +
          `seconds-vs-milliseconds mistakes — 20 seconds = 20000ms). This is the EXECUTION deadline, not the response window. ` +
          `Ordinary calls default to ${DEFAULT_TIMEOUT_MS}; if still running at the response window they return the SAME durable job without killing it. ` +
          `Explicit run_in_background calls default to ${DEFAULT_BACKGROUND_TIMEOUT_MS}. Maximum ${MAX_BACKGROUND_TIMEOUT_MS}. ` +
          `The whole confined task subtree IS terminated only at this execution deadline ` +
          `(systemd RuntimeMaxSec plus the local SIGTERM/SIGKILL path), ` +
          `so raise this for a job that legitimately runs longer. Deliberately daemonized descendants remain tracked ` +
          `inside the same task and share its deadline; use a dedicated service launcher for a different lifetime.`,
      ),
    yield_after_ms: z
      .number()
      .int()
      .min(10)
      .max(FOREGROUND_TIMEOUT_CEILING_MS)
      .optional()
      .describe(
        `Ordinary-call RESPONSE window in ms (default ${FOREGROUND_TIMEOUT_CEILING_MS}, max ${FOREGROUND_TIMEOUT_CEILING_MS}). ` +
          `If the command is still running when this window ends, the call returns its original durable bash_id/task_id and ` +
          `the job continues until completion, explicit kill/abort, or the separate timeout execution deadline. ` +
          `This never restarts or duplicates the command. Ignored with run_in_background:true, which yields immediately.`,
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'Return the durable job immediately instead of waiting for fast completion. Ordinary calls already yield the same job automatically at yield_after_ms. Read later output via capability:bash_output.',
      ),
    allow_duplicate: z
      .boolean()
      .optional()
      .describe(
        'Allow a duplicate launch when a live task already has the exact same command and cwd. ' +
          'Use only when the duplicate is intentional.',
      ),
    cwd: z
      .string()
      .optional()
      .describe('Working dir (absolute, or relative to the project dir). Defaults to the project dir.'),
    integration_env: integrationEnvSchema
      .optional()
      .describe(
        'Operator-authority only. Map child environment variable names to encrypted setup:save_integration_key names, e.g. {"DEEPGRAM_API_KEY":"SIDESTAGE_DEEPGRAM_API_KEY"}. Raw values stay server-side, exist only in this child process, and are exact-value-redacted from events, results, background reads, and spill logs.',
      ),
  }),
  async handler(args, ctx) {
    // command/cmd: `cmd` is accepted as an alias (see its schema description) — normalize to
    // one local binding so every downstream use is unambiguous and `command` stays required
    // in effect even though the schema field itself is optional to make room for the alias.
    const command = args.command ?? args.cmd;
    if (!command) {
      throw new Error(
        'command is required (the bash command to run, passed to `bash -c`); `cmd` is also accepted as an alias',
      );
    }
    // Start the caller-visible response clock before filesystem/policy/provenance
    // preflight. Otherwise a slow preflight plus a full wait window could still
    // outrun the MCP cap even though the job itself yielded on time.
    const responseWindowMs = args.yield_after_ms ?? FOREGROUND_TIMEOUT_CEILING_MS;
    const responseDeadlineAtMs = Date.now() + responseWindowMs;
    const baseDir = resolveCapabilityBaseDir(ctx);
    const cwd = args.cwd
      ? isAbsolute(args.cwd)
        ? args.cwd
        : resolve(baseDir, args.cwd)
      : resolveBashDefaultCwd(baseDir);
    // Preflight the FINAL cwd (explicit or recovered-implicit) before either
    // spawn path, so a missing directory fails with its real cause instead of
    // the child's misleading `spawn /usr/bin/bash ENOENT`.
    const cwdError = missingBashCwdError(cwd, Boolean(args.cwd));
    if (cwdError) throw new Error(cwdError);
    const unboundedGitHistorySearch = detectUnboundedGitHistorySearch(command);
    if (unboundedGitHistorySearch) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              reason: 'unbounded_git_history',
              selectors: unboundedGitHistorySearch.selectors,
              message: formatUnboundedGitHistorySearchAdvice(unboundedGitHistorySearch),
            }),
          },
        ],
        isError: true,
      };
    }
    // Classify before any Git read. The overwhelmingly common command remains a
    // pure string check; only a canonical root test or candidate worktree cut
    // reaches the live marker/HEAD CAS immediately before its actual spawn.
    const frozenLineageRoot = resolveCapabilityIntegrationRoot();
    const frozenLineageCommand = frozenLineageRoot
      ? classifyFrozenLineageShellCommand({ command, cwd: realpathSoft(cwd) })
      : null;
    const frozenLineageRefusal = async () => {
      if (!frozenLineageRoot) return null;
      const verdict = await evaluateFrozenLineageShellCommand(frozenLineageCommand, frozenLineageRoot, {
        readCheckoutHead: repoHeadSha,
        canonicalizePath: realpathSoft,
        readFrozenRepairQueue: () =>
          readFrozenCandidateRepairQueue({
            workspaceId: activeWorkspaceId(),
            installSlug: operatorHomeHarnessSlug(),
          }),
      });
      return frozenLineageShellCommandViolationPayload(verdict);
    };
    const untrackedBackgrounding = detectUntrackedShellBackgrounding(command);
    if (untrackedBackgrounding) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              reason: 'untracked_shell_background',
              message: formatUntrackedShellBackgroundAdvice(untrackedBackgrounding),
            }),
          },
        ],
        isError: true,
      };
    }
    // EI-21910156647461981: an explicitly detached task survives the caller's
    // carry boundary, so a successor can accidentally launch the exact same
    // command again. Keep this cross-call guard scoped to run_in_background:
    // applying it to ordinary calls makes unrelated concurrent fast commands
    // with the same command/cwd reject one another. P-002's per-call start-once
    // invariant is enforced separately by the single startBackground call.
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId;
    if (args.run_in_background && !args.allow_duplicate && workspaceId) {
      const expectedArgv = ['bash', '-o', 'pipefail', '-c', command];
      const duplicate = (await listLiveTasks(workspaceId)).find(
        (task) =>
          task.class === 'bash-job' &&
          task.cwd === cwd &&
          task.argv.length === expectedArgv.length &&
          task.argv.every((arg, index) => arg === expectedArgv[index]),
      );
      if (duplicate) {
        const bashId = duplicate.detail?.bashJobId;
        const taskHandle = `capability:bash_output { task_id: "${duplicate.taskId}" }`;
        const bashHandle =
          typeof bashId === 'string' && bashId.length > 0
            ? ` (or { bash_id: "${bashId}" } in the original launching context)`
            : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'duplicate_live_task',
                task_id: duplicate.taskId,
                ...(typeof bashId === 'string' && bashId.length > 0 ? { bash_id: bashId } : {}),
                cwd,
                advice:
                  `A live background shell with the exact command and cwd already exists. ` +
                  `Reattach with ${taskHandle}${bashHandle}. ` +
                  'Pass allow_duplicate:true only when this duplicate launch is intentional.',
              }),
            },
          ],
          isError: true,
        };
      }
    }
    // WI-6677: the EXECUTION default still depends on explicit background mode.
    // P-002 separates that deadline from the response window: an ordinary call
    // starts a durable job and may yield it without changing this value.
    const executionTimeoutMs =
      args.timeout ?? (args.run_in_background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    // Resolve from server-owned caller identity. Trusted owner automation keeps
    // the rollout flag's compatibility behavior; confined work forces a real
    // wrapper and refuses before spawn when none is available.
    const sandboxPolicy = await capabilityExecSandboxPolicy(ctx);
    // computer-tool-plan Gap C: if the calling bee's hive holds a leased sandbox desktop,
    // run its shell with DISPLAY bound to that desktop so GUI apps it launches (`firefox &`,
    // `soffice --calc &`) appear ON the leased Xvfb — capability:computer then drives them.
    // The handler runs in the OPERATOR process, so resolve per-caller from ctx.harnessSlug
    // (the bee's spawn-env never reaches here). No lease → no DISPLAY → unchanged. The lease
    // is always a sandbox display, never host :0.
    const hive = resolveConcreteHarnessSlug(undefined, ctx);
    const leasedDisplay = hive ? displayForHive(hive) : undefined;
    const desktopEnv = leasedDisplay ? { DISPLAY: leasedDisplay } : undefined;
    const integrationEntries = Object.entries(args.integration_env ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (integrationEntries.length > 0 && ctx.isSuperuser !== true && !isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('capability:bash integration_env requires superuser or operator, architect, or mug authority');
    }

    const resolvedIntegrationEntries = await Promise.all(
      integrationEntries.map(async ([envName, sourceName]) => ({
        envName,
        sourceName,
        value: await readIntegrationKey(sourceName),
      })),
    );
    const missingIntegrationSources = [
      ...new Set(resolvedIntegrationEntries.filter((entry) => !entry.value).map((entry) => entry.sourceName)),
    ];
    if (missingIntegrationSources.length > 0) {
      throw new Error(
        `capability:bash integration_env references missing saved integration credential(s): ${missingIntegrationSources.join(', ')}`,
      );
    }
    const integrationEnv = Object.fromEntries(resolvedIntegrationEntries.map((entry) => [entry.envName, entry.value!]));
    const integrationEnvView = Object.fromEntries(
      resolvedIntegrationEntries.map((entry) => [
        entry.envName,
        {
          source: entry.sourceName,
          masked: maskIntegrationKey(entry.value),
        },
      ]),
    );
    // The operator process does not run inside the caller's psu shell, so its
    // inherited PAPERCUSP_SID is either absent or belongs to a different
    // session. Resolve the caller through the shared coordination identity
    // seam and explicitly bind that id to every child, including foreground
    // verifier commands. If this context cannot be attributed, clear the
    // inherited value rather than letting a stale operator identity authorize
    // a verifier against the wrong desktop.
    let callerSid = '';
    try {
      callerSid = resolveAgentIdentity(ctx as unknown as ResolveIdentityCtx).ownerId.trim();
    } catch {
      callerSid = '';
    }
    const childEnv = {
      ...(desktopEnv ?? {}),
      ...integrationEnv,
      // WI-22952438885573520: local test runs launched through capability:bash
      // already execute in a caller-scoped harness/workspace, but the reporter
      // learns that identity only from these two child environment variables.
      // Stamp concrete scope here so the resulting local test_runs row remains
      // bindable as spec evidence. Keep wildcard/unscoped calls unattributed;
      // inventing a tenant would be worse than an explicit NULL attribution.
      ...(hive && hive !== '*' ? { PAPERCUSP_TEST_RUN_HARNESS: hive } : {}),
      ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { PAPERCUSP_WORKSPACE_ID: ctx.workspaceId } : {}),
      PAPERCUSP_SID: callerSid,
      // The marker is owned by this handler, not by caller-provided env. An
      // ordinary call survives a response yield, but its execution deadline or
      // caller abort still kills the entire process tree, so mutation probes
      // must refuse --in-tree before they touch a tracked file. Explicit
      // background jobs clear both names as before.
      [CAPABILITY_BASH_FOREGROUND_ENV]: args.run_in_background ? '' : '1',
      [CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV]: args.run_in_background ? '' : String(executionTimeoutMs),
    };
    const redactValues = resolvedIntegrationEntries.map((entry) => entry.value!);
    const integrationHeader =
      integrationEntries.length > 0 ? ` · integration_env ${JSON.stringify(integrationEnvView)}` : '';
    const processNotice = processTableNotice(command);

    const provenance = await resolveBashTaskProvenance(ctx as unknown as ResolveIdentityCtx, hive ?? null);
    const frozenRefusal = await frozenLineageRefusal();
    if (frozenRefusal) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(frozenRefusal) }],
        isError: true,
      };
    }
    // expensive-verification-loops P-002: a slow launch for a work item that keeps failing
    // slow attempts is held until the loop is audited on the item (quick calls pass).
    const loopRefusal = await loopLaunchRefusal({
      workspaceId,
      workItemId: provenance.workItemId,
      background: Boolean(args.run_in_background),
      timeoutMs: executionTimeoutMs,
    });
    if (loopRefusal) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(loopRefusal) }], isError: true };
    }

    // CAP-CONTRACT-P002-YIELD-SAME-JOB@1: every admitted call forks exactly
    // once through the existing durable background/task seam. The only mode
    // difference is how long this request waits before returning that handle.
    const job = startBackground(
      {
        command,
        cwd,
        stateDir: ctx.stateDir,
        ...(!args.run_in_background ? { onChunk: (chunk: string) => ctx.emit('output', chunk) } : {}),
        sandboxEnabled: sandboxPolicy.enabled,
        sandboxRequired: sandboxPolicy.required,
        ...(Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
        ...(redactValues.length > 0 ? { redactValues } : {}),
        ...provenance,
      },
      executionTimeoutMs,
    );

    if (args.run_in_background) {
      // EI-19915289191989412: a command whose LAST pipeline stage is a buffering
      // filter (`| tail -45`, `| head`, `| sort`, …) does not flush anything to
      // the job's log until the WHOLE pipeline exits — the log stays at exactly
      // 0 bytes for the entire run, then fills all at once at exit. Say so NOW,
      // at launch, rather than leaving the reader to discover it from a string of
      // empty bash_output polls that look identical to "never started".
      const bufferingStage = detectBufferingLastStage(command);
      const bufferingNote = bufferingStage ? formatBufferingPipelineAdvice(bufferingStage, 'launch') : '';
      // EI-21301075566136325: same say-it-NOW rationale as the buffering note — a
      // command that redirects its own stdout keeps the capability log empty for
      // its whole run, and a string of empty bash_output polls looks identical to
      // "never started". Name the redirect target at launch so the reader judges
      // progress by THAT file, not by the capability tail.
      const selfRedirectAtLaunch = detectSelfOutputRedirect(command);
      const selfRedirectLaunchNote = selfRedirectAtLaunch
        ? ` ${formatSelfRedirectAdvice(selfRedirectAtLaunch, null)}`
        : '';
      // EI-20063051138162607: the sibling typecheck tools spawn tsc themselves and
      // so can pin its heap (tscHeapEnv); this one runs a command the CALLER wrote,
      // and rewriting NODE_OPTIONS underneath it would be the more surprising
      // behavior. So say it instead of fixing it — the caller keeps sovereignty
      // over the command, and stops needing to know the heap requirement by heart.
      const heapNote = typecheckHeapLaunchWarning(command) ?? '';
      const payload = {
        ok: true,
        bash_id: job.id,
        task_id: job.taskId,
        status: 'running',
        cwd,
        log_path: job.logPath,
        // WI-6677: state the deadline at LAUNCH. It is enforced by SIGTERM/SIGKILL,
        // so a caller who needs longer must know now — not discover it as an
        // unexplained death two hours in.
        timeout_ms: job.timeoutMs,
        deadline: job.deadlineAt ? new Date(job.deadlineAt).toISOString() : undefined,
        ...(integrationEntries.length > 0 ? { integration_env: integrationEnvView } : {}),
        ...(processNotice ? { process_table_notice: processNotice } : {}),
        advice:
          `Background shell started. Preserve durable task_id "${job.taskId}" across carry. ` +
          `Read output: capability:bash_output { task_id: "${job.taskId}" } ` +
          `(or { bash_id: "${job.id}" } in this launching context). ` +
          `Stop: processes:kill { taskId: "${job.taskId}" }. ` +
          `It is terminated at ${job.deadlineAt ? new Date(job.deadlineAt).toISOString() : 'its deadline'} — ` +
          `re-launch with a larger \`timeout\` (max ${MAX_BACKGROUND_TIMEOUT_MS}ms) if the shell job needs longer. ` +
          `All descendants in this task's confined service share that deadline; use a dedicated service launcher ` +
          `when a descendant needs a separate lifetime.` +
          bufferingNote +
          selfRedirectLaunchNote +
          heapNote,
      };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(payload),
          },
        ],
        ...(ctx.codeMode ? { structuredContent: payload } : {}),
      };
    }

    const disposition = await waitForJobResponse(job, ctx.signal, Math.max(0, responseDeadlineAtMs - Date.now()));
    const r = snapshotJobResult(job);

    if (disposition === 'yielded') {
      const bufferingStage = detectBufferingLastStage(command);
      const bufferingNote = bufferingStage ? formatBufferingPipelineAdvice(bufferingStage, 'launch') : '';
      const selfRedirectAtLaunch = detectSelfOutputRedirect(command);
      const selfRedirectLaunchNote = selfRedirectAtLaunch
        ? ` ${formatSelfRedirectAdvice(selfRedirectAtLaunch, null)}`
        : '';
      const heapNote = typecheckHeapLaunchWarning(command) ?? '';
      const payload = {
        ok: r.status === 'running',
        bash_id: job.id,
        task_id: job.taskId,
        status: r.status,
        running: r.status === 'running',
        yielded: true,
        cleanup_pending: r.status !== 'running',
        cwd,
        output: r.output,
        truncated: r.truncated,
        total_bytes: r.totalBytes,
        log_path: job.logPath,
        response_window_ms: responseWindowMs,
        timeout_ms: job.timeoutMs,
        deadline: job.deadlineAt ? new Date(job.deadlineAt).toISOString() : undefined,
        ...(integrationEntries.length > 0 ? { integration_env: integrationEnvView } : {}),
        ...(processNotice ? { process_table_notice: processNotice } : {}),
        advice:
          `Response window elapsed; the original shell ${
            r.status === 'running' ? 'is still running' : `has status ${r.status} and is finishing whole-tree cleanup`
          }. Preserve durable task_id "${job.taskId}" across carry. ` +
          `Read output: capability:bash_output { task_id: "${job.taskId}" } ` +
          `(or { bash_id: "${job.id}" } in this launching context). ` +
          `Stop: processes:kill { taskId: "${job.taskId}" }. ` +
          `The response yield did NOT restart or kill the command; its separate execution deadline is ` +
          `${job.deadlineAt ? new Date(job.deadlineAt).toISOString() : 'still in force'}.` +
          bufferingNote +
          selfRedirectLaunchNote +
          heapNote,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        ...(ctx.codeMode ? { structuredContent: payload } : {}),
      };
    }

    const header =
      `exit ${r.exitCode ?? 'null'}` +
      (r.status !== 'completed' ? ` (${r.status})` : '') +
      ` · ${(r.durationMs / 1000).toFixed(1)}s · cwd ${cwd}` +
      (r.truncated ? ` · bounded preview (${r.totalBytes} bytes total)` : '') +
      ` · full output → ${r.logPath}` +
      integrationHeader;

    const isError = r.status === 'failed' && r.exitCode === null;
    const timeoutHint =
      r.status === 'timed_out'
        ? `\n⏱ execution deadline reached after ${((job.timeoutMs ?? executionTimeoutMs) / 1000).toFixed(0)}s; the same job's whole process tree was terminated. Partial/full permitted output: ${r.logPath}.`
        : '';

    return {
      content: [{ type: 'text' as const, text: `${header}\n${processNotice ? `NOTICE: ${processNotice}\n` : ''}${r.output || '(no output)'}${timeoutHint}` }],
      isError,
      // EI-20066912585022608: the text above is the right answer for a MODEL reading
      // this result and the wrong one for a `code:run` script, which gets handed the
      // raw string and whose `result.<field>` then resolves to undefined SILENTLY —
      // indistinguishable from a true empty. Worse, this tool's own background branch
      // returns JSON, so `capability.bash(...)` changed shape depending on an argument.
      // Give code-mode the same data the header renders, and only code-mode: attaching
      // it unconditionally would duplicate every foreground command's output on the
      // wire for direct callers that read the text and never look at this field.
      //
      // `output` is deliberately NOT called `stdout` — bash-jobs pipes stdout and
      // stderr into one buffer, so `stdout` would be a name that reads right and is
      // false, which is the same defect class one level down. A script that guesses
      // `.stdout` now gets a loud fieldMiss naming the real keys instead of ''.
      ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
        ? {
            structuredContent: {
              // `ok` answers the question a script actually asks — "did my command
              // succeed" — NOT the narrower "did the shell manage to run it"
              // (`isError`, reserved for a command that never produced an exit code).
              // `status === 'completed'` is exactly `exitCode === 0` in bash-jobs;
              // 'failed' | 'killed' | 'timed_out' all read as ok:false, and `status`
              // is what distinguishes "it ran and failed" from "it never finished".
              // Defining ok as !isError instead would hand back ok:true for a command
              // that exited 3 — the reads-true-but-false shape this whole item is about.
              ok: r.status === 'completed',
              bash_id: job.id,
              task_id: job.taskId,
              status: r.status,
              running: false,
              yielded: false,
              exit_code: r.exitCode,
              duration_ms: r.durationMs,
              cwd,
              output: r.output,
              truncated: r.truncated,
              total_bytes: r.totalBytes,
              log_path: r.logPath,
              response_window_ms: responseWindowMs,
              timeout_ms: job.timeoutMs,
              deadline: job.deadlineAt ? new Date(job.deadlineAt).toISOString() : undefined,
              ...(integrationEntries.length > 0 ? { integration_env: integrationEnvView } : {}),
              ...(processNotice ? { process_table_notice: processNotice } : {}),
            },
          }
        : {}),
    };
  },
});
