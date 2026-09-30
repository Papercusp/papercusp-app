/**
 * Native-scheduler lockout for spawned agent sessions
 * (native-scheduler-lockout-2026-06-09).
 *
 * The hive's liveness contract is "a wake is always armed IN THE ROUTINES
 * TABLE" (`pot:declare-wake` → the one-shot `hive-wake` routine row): that
 * table is the single scheduler of record that `pot:status`, Pause, the
 * wake-mode gate, and the liveness backstop all read (D-001). claude-code
 * ships its OWN scheduling surfaces — Cron* tools, `ScheduleWakeup`, the
 * `/schedule` + `/loop` skills — and a wake scheduled there is invisible to
 * all of that machinery: the backstop double-fires, Pause can't stage it, and
 * a cron job outlives the hive as a zombie (verified live 2026-06-09:
 * `ScheduleWakeup` IS in a headless `-p` session's toolset). So every agent
 * launch denies them, forcing the one scheduler the substrate can see.
 *
 * Two layers ride the same flag:
 *   - T1 (`NATIVE_SCHEDULER_DENY`): claude's first-class scheduler tools.
 *   - T2 (`OS_SCHEDULER_BASH_DENY`): `Bash(<cmd>:*)` deny patterns for the
 *     persistent OS schedulers reachable through the Bash tool. Headless bees
 *     run with a minimal, hook-free CLAUDE_CONFIG_DIR (creds symlink only),
 *     so a PreToolUse hook guard never fires there — the deny patterns are
 *     the only enforcement that reaches every claude agent session (D-007).
 *     Known limits, accepted: prefix rules don't catch compound commands
 *     (`x && crontab …`), and `at` is omitted (bare-prefix rule would
 *     false-positive `atuin`/`attach`); the prompt layer (P-011) carries the
 *     intent, and the omp/codex hook seams (P-010) do word-boundary matching.
 *
 * Scope: AGENT sessions only (headless invoke spawns, wake-executor resumes,
 * interactive `psu --role` panes). The human `psu su` collaborator session
 * keeps its native schedulers — `/schedule` there is the owner's own surface
 * (D-003).
 *
 * Flag form: MUST be the single-token `--disallowedTools=a,b,c` (D-002). The
 * flag is variadic (`<tools...>`) and the space form greedily eats every
 * following token — including a trailing positional prompt (verified live:
 * the wake text became "deny rules"). The deny holds under
 * `--permission-mode bypassPermissions` (also verified live — the tool is
 * removed from the model's toolset, not merely permission-gated).
 *
 * psu-launcher.mjs (plain-node script, can't import TS) duplicates the
 * rendered literal in `roleLaunchArgs`; the lockstep test in
 * apps/operator/lib/psu-launcher.test.ts pins the two copies together.
 */

/** T1a — claude-code's first-class scheduler TOOLS. MODEL-facing: the model
 *  calls these itself, and every agent persona (su included) already forbids
 *  that in prose in favour of `loop:arm` / `plans:set-schedule`. */
export const NATIVE_SCHEDULER_TOOL_DENY = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
] as const;

/** T1b — the scheduling SKILLS. OWNER-facing: these are what a human types as
 *  `/schedule` and `/loop`, which is the surface D-003 preserves for the human
 *  `psu su` collaborator. Denying them removes an OWNER affordance, so they are
 *  split from T1a and are NOT part of the su-session deny. */
export const NATIVE_SCHEDULER_SKILL_DENY = [
  'Skill(schedule)',
  'Skill(loop)',
] as const;

/** T1 — claude-code's first-class scheduler tools + skills. DERIVED from T1a+T1b
 *  so the union and its subsets cannot drift apart (one source, not three lists). */
export const NATIVE_SCHEDULER_DENY = [
  ...NATIVE_SCHEDULER_TOOL_DENY,
  ...NATIVE_SCHEDULER_SKILL_DENY,
] as const;

/** T2 — persistent OS schedulers via the Bash tool (colon prefix-rule form;
 *  entries must stay space-free so the `=` single-token join survives). */
export const OS_SCHEDULER_BASH_DENY = [
  'Bash(crontab:*)',
  'Bash(systemd-run:*)',
  'Bash(batch:*)',
] as const;

/** The ready-to-append argv token (claude CLI). Single `=` token — see header. */
export function nativeSchedulerDenyFlag(): string {
  return `--disallowedTools=${[...NATIVE_SCHEDULER_DENY, ...OS_SCHEDULER_BASH_DENY].join(',')}`;
}

/**
 * The su-session argv token: T1a (model-facing scheduler TOOLS) ONLY.
 *
 * D-003 exempts the human `psu su` collaborator from the full lockout so the
 * OWNER keeps `/schedule` and `/loop`. That rationale covers T1b (the skills a
 * human types) — it does NOT cover T1a, which only the MODEL calls and which
 * the su playbook already forbids in prose: "do NOT self-pace with Claude
 * Code's native `/loop` (or `ScheduleWakeup`) … declare an engine loop with
 * `loop:arm`". So su was paying twice — once for schemas it must not use, once
 * for the prose banning them.
 *
 * Measured 2026-09-18 by capturing the `tools` array of a real `/v1/messages`
 * body (7-arm A/B with a no-deny positive control): ScheduleWakeup 4,923 B +
 * CronCreate 3,642 B + CronDelete 360 B + CronList 231 B = **9,156 B of tool
 * schemas on EVERY turn of EVERY su session**. With ToolSearch denied there is
 * no native schema deferral, so none of it is recoverable later.
 *
 * Deliberately NOT included, each for a stated reason:
 *   - T1b skills — removing them would remove the owner's own `/schedule` +
 *     `/loop`, which is precisely what D-003 protects.
 *   - T2 `Bash(crontab:*)` etc. — worth 0 bytes (deny patterns ship no schema)
 *     while costing the owner a real shell capability. This flag is a COST fix;
 *     it does not quietly widen the su lockout's behavioural scope.
 *
 * MUST stay one `=` token — same greed-guard reason as the full flag.
 */
export function suSchedulerToolsDenyFlag(): string {
  return `--disallowedTools=${NATIVE_SCHEDULER_TOOL_DENY.join(',')}`;
}

/** True when `cmd` already carries an explicit --disallowedTools /
 *  --disallowed-tools (either form) — an operator-configured deny list wins;
 *  we never stack a second flag (claude would union them, but the operator's
 *  intent is ambiguous, so leave their command untouched) (D-004). */
export function hasExplicitDisallowedTools(cmd: string): boolean {
  return /--disallowed(?:-t|T)ools(?:=|\s)/.test(cmd);
}
