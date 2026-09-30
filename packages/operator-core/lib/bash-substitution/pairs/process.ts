/**
 * Equivalence pairs — the PROCESS/JOB family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-008).
 *
 * Population: 1,598 `ps`/`pgrep` atoms across 62 of 86 sessions, of which this
 * pair's pattern claims 1,590 (the 8 excluded are searches for an agent kind —
 * see the boundary note on `psProcessQuery`).
 * Proposed replacement: `dev:processes`. Verdict: NOT A SUBSTITUTE (0/24).
 *
 * This is the plan's first NEGATIVE result, and recording it is the point. D-001
 * requires the audit be able to conclude "leave the bash alone"; an audit that
 * can only ever ratify a substitution is not an audit. So this pair exists to
 * carry the evidence that `dev:processes` must NEVER gate `ps`/`pgrep` — and to
 * fail loudly (via `expectedVerdict`) if someone later widens the tool without
 * re-deriving that conclusion.
 *
 * ── The capability envelope, read from the tool ──────────────────────────────
 * `dev:processes` takes exactly one optional argument: `kinds?: Array<'run.sh' |
 * 'omp' | 'claude' | 'paperclip' | 'pty' | 'next'>`. `listProcesses` walks
 * /proc, classifies each cmdline against six hard-coded needles, and — the
 * decisive line — `if (kind === 'other') continue`. Everything that is not one
 * of those six agent shapes is DROPPED before the caller sees it.
 *
 * There is no pid selector, no name/pattern filter, and no ppid in the returned
 * shape (`pid, kind, cmdline, cwd, started_seconds_ago, harness_slug,
 * workspace_id`).
 *
 * ── What the corpus asks for, bucketed by QUESTION ───────────────────────────
 *   822 (51.4%)  whole-host inventory   `ps aux`, `ps -ef`, `ps -eo …`
 *   364 (22.8%)  liveness/age of a PID  `ps -p 636440 -o pid,etime,cmd`
 *   350 (21.9%)  liveness by job NAME   `pgrep -f "tsc --noEmit"`
 *    26 ( 1.6%)  children of a pid      `ps --ppid $PID -o pid,cmd`
 *    36 ( 2.3%)  other
 *
 * Three of those five buckets name a capability the tool does not have at all.
 * The largest bucket looks like the tool's shape — and is the most misleading:
 * of the 815 `ps … | grep X` pairs in the corpus, exactly TWO grep for something
 * inside `dev:processes`' six kinds. The other 813 look for `local-matrix`,
 * `vitest`, `tsc --noEmit`, `live-federation-gate`, `deb-hetzner-matrix`,
 * `green-checkpoint`, `tauri` — jobs the agent itself started, every one of
 * which `listProcesses` classifies as `other` and drops.
 *
 * The sample bears this out at full strength: 0 of 24 real commands have a
 * `dev:processes` expression, across 18 distinct sessions. Not one.
 *
 * ── The finding ──────────────────────────────────────────────────────────────
 * `dev:processes` answers "what AGENTS are running on this host". Agents are
 * asking "is MY JOB done yet". Those are different questions about disjoint sets
 * of processes, which is why the verdict here is `not-a-substitute` rather than
 * `needs-widening`: there is no corner to widen, because the overlap is ~0.
 *
 * This same 6-kind filter is why the write side fails too. `processes:kill`
 * resolves its target through `listProcesses({})` and then allows only
 * `run.sh | omp | claude` — so asking it to kill a runaway `vitest` returns
 * `pid_not_found` for a process that is demonstrably alive. Same root cause,
 * worse symptom (a wrong error rather than an empty list).
 *
 * ── Therefore: P-022, not P-012 ──────────────────────────────────────────────
 * P-008 asks whether the right answer is widening `dev:processes` (P-012) or
 * superseding it with the job surface (P-022). The bucket table answers it:
 * 46.3% of this family is explicitly "a job I started", identified by a pid the
 * agent is holding or a name the agent chose. Widening `dev:processes` to accept
 * a pid and a pattern would not produce a tool — it would produce `ps` with
 * extra steps, and it would still not know the one thing the agent actually
 * wants, which is whether the job FINISHED and what it printed. An owned job
 * handle answers that directly and deletes the polling loop instead of
 * re-encoding it. Hence: leave `ps`/`pgrep` alone (this pair is evidence, never
 * enforcement) and route the intent through P-022's job lifecycle.
 */

import type { CoverageResult, BashSubstitutionPair } from '../types';

/**
 * The six cmdline classifiers in `listProcesses`, verbatim. Duplicated here
 * deliberately: this is a MODEL of the tool used to score coverage, and if the
 * tool's real classifiers change, the recomputed verdict must change with them
 * rather than silently tracking a shared constant. The `expectedVerdict` latch
 * is what surfaces that divergence.
 */
export const DEV_PROCESSES_KINDS = ['run.sh', 'omp', 'claude', 'paperclip', 'pty', 'next'] as const;

/** Selects one or more explicit pids: `-p 123`, `-p $PID`, `-p $(…)`, `--pid`. */
const PID_SELECTOR = /(?:^|\s)(?:-p\s*=?\s*(?:\d|\$)|--pid\b|-q\s)/;

/** Selects the CHILDREN of a pid: `ps --ppid 4242`, `pgrep -P 4242`. */
const PPID_SELECTOR = /(?:^|\s)(?:--ppid\b|-P\s)/;

/** A `pgrep` invocation — always a search by name/pattern. */
const IS_PGREP = /^pgrep\b/;

/**
 * The pattern `pgrep` was given, i.e. the job the agent is looking for.
 * Flags are skipped so `pgrep -af "tsc --noEmit"` yields `tsc --noEmit`.
 */
function pgrepPattern(atom: string): string | null {
  const match = /^pgrep\s+((?:-\w+\s+)*)(.*)$/.exec(atom);
  if (!match) return null;
  const rest = match[2].trim();
  if (!rest) return null;
  // Strip one layer of quoting and any trailing redirect the atomiser kept.
  const unquoted = /^(["'])([^"']*)\1?/.exec(rest);
  const value = (unquoted ? unquoted[2] : rest.split(/\s+/)[0]).trim();
  return value.replace(/\s*(?:\d?>[&]?\S+)\s*$/, '').trim() || null;
}

/**
 * P-008 — "is my job still running?" → `dev:processes`.
 *
 * ── Why the pattern excludes searches for an agent kind ──────────────────────
 * The first draft of this pair claimed the whole `ps`/`pgrep` family and scored
 * 1/24 — `needs-widening`, on the strength of a single atom, `pgrep -fc
 * "claude"`. That atom is not noise: searching for a `claude` process IS the
 * question `dev:processes` exists to answer, and `{ kinds: ['claude'] }` answers
 * it exactly. Two different intents were sharing one pattern.
 *
 * D-008 says the fix for a mixed pattern is to narrow it until the residue falls
 * outside, and that is what the lookahead below does: this pair now claims only
 * "is MY JOB running", and searches naming one of the six agent kinds fall out.
 *
 * That distinction is the plan's own framing of P-008 — `dev:processes` answers
 * "what agents run here", agents are asking "is my job done" — so drawing the
 * pattern around the second question is not gerrymandering toward a tidier
 * label; it is the finding, expressed as a boundary.
 *
 * The excluded intent gets NO pair of its own: only ~2 atoms in 1,598 ask it,
 * which is far under `MIN_SAMPLE_SIZE`, and `auditPair` rightly refuses to issue
 * a verdict from a sample that thin. Too rare to enforce is a real answer.
 *
 * The `kinds` branch in `cover()` below is deliberately KEPT even though the
 * pattern should now exclude every atom that could reach it. It is a tripwire:
 * if the lookahead ever stops working, that branch scores a match as covered,
 * the verdict flips off `not-a-substitute`, and the test fails loudly instead of
 * quietly auditing a pattern that no longer means what this comment says.
 *
 * `ps\b` does not match `psql` — `s` and `q` are both word characters, so there
 * is no boundary between them — which keeps this pair off the postgres family.
 *
 * The verb anchor requires a SHELL-ARGUMENT boundary — whitespace or end of
 * atom — rather than a bare `\b`. `atomize` is documented as not a shell
 * parser, so an inlined script payload (`python3 -c "ps=json.load(...)"`)
 * splits into pseudo-verb atoms headed by short identifiers, and a bare `\b`
 * sits happily between `ps` and `=` (both are non-word-adjacent: `s` is a word
 * char, `=` is not). `(?=\s|$)` still matches every real `ps`/`pgrep`
 * invocation (always followed by a flag/arg or nothing) while refusing an
 * atom where a same-named identifier is immediately assigned to (EI-18733363666718163).
 *
 * ── P-022 / D-025: why the advisory now names a LAUNCH-SITE workflow ─────────
 * The verdict is unchanged and still correct — `dev:processes` cannot answer
 * this question. But the old advisory ended "Keep using ps/pgrep for that",
 * which is the WI-6146 shape: true of the tool it names, and silent about the
 * fact that the intent DOES have a good answer one step earlier. P-022 measured
 * 2,315 ps/pgrep atoms across 63 sessions asking it, and 2,307 of them (99.7%)
 * already land on THIS pattern — so this advisory, not a new pair, is where that
 * finding belongs. A second pair over the same atoms would be contradictory
 * enforcement (the gate fires whichever matches first), not extra coverage.
 *
 * The registry cannot express the fix as an equivalence, and that is a property
 * of the fix rather than a gap here: `capability:bash_output` requires a
 * `bash_id` minted only by `capability:bash { run_in_background: true }`, while
 * every real atom carries a pid from a NATIVE launch. There is nothing to map
 * the command onto, so the verdict stays `not-a-substitute` and the value is
 * carried entirely by the prose.
 *
 * The wording is deliberately hedged. Reading `capability/bash_output.ts` before
 * writing it showed the obvious claim — "use capability:bash, it survives
 * compaction" — is FALSE: that tool's in-memory job registry is wiped on any
 * operator restart, and on this shared box such a restart is cross-agent
 * (EI-8855). What is actually true is weaker and still decisive: the job is
 * REATTACHABLE, because the log is written to a deterministic `stateDir + bash_id`
 * path, so `strandedJobLookup` recovers the tail without the registry and
 * `diagnoseStrandedCause` (EI-18666279107998059) reports a confirmed cause
 * instead of a bare `unknown_bash_id`. A native background id has no such path
 * and is simply dead after the boundary. Promise recoverability, never immunity.
 */
export const psProcessQuery: BashSubstitutionPair = {
  id: 'process.ps-pgrep',
  intentLabel: 'host-job-liveness-query',
  bashPattern: /^(?:ps|pgrep)(?=\s|$)(?![^\n]*\b(?:run\.sh|omp|claude|paperclip|pty|next)\b)/,
  toolName: 'dev:processes',
  advisoryText:
    'dev:processes lists only agent-kind processes (run.sh/omp/claude/paperclip/pty/next) and has no pid or name selector — it cannot answer "is my job still running", so ps/pgrep stays correct for a job that is ALREADY started. The fix is at the LAUNCH site: start long jobs with capability:bash { run_in_background: true } and poll capability:bash_output { bash_id, filter }. Not because that is restart-proof — the in-memory job registry is wiped whenever ANY agent restarts the operator — but because the log persists at a deterministic path, so a stranded poll still returns the tail plus a CONFIRMED cause (EI-8855) instead of a dead id.',
  routing: {
    want: 'whether a job you started is still running',
    use: '`dev:processes` — REJECTED for this intent (see P-008); it lists only agent-kind processes',
    insteadOf: '`ps -p <pid>` / `pgrep -f <job>` — no tool form for an already-started job; launch via capability:bash to get a pollable handle',
  },
  expectedVerdict: 'not-a-substitute',
  cover(atom: string): CoverageResult {
    if (PPID_SELECTOR.test(atom)) {
      return {
        covered: false,
        reason: 'asks for the CHILDREN of a pid; dev:processes returns no ppid and has no parent selector',
      };
    }
    if (PID_SELECTOR.test(atom)) {
      return {
        covered: false,
        reason: 'asks about a SPECIFIC pid; dev:processes has no pid selector, only an optional kinds filter',
      };
    }
    if (IS_PGREP.test(atom)) {
      const pattern = pgrepPattern(atom);
      if (!pattern) {
        return { covered: false, reason: 'pgrep with no resolvable pattern; dev:processes cannot search by name' };
      }
      // The genuine overlap: a search for one of the six agent kinds maps onto
      // the `kinds` filter. This branch is why the envelope is not rigged — if
      // the corpus were full of `pgrep -f claude` this pair would score
      // `equivalent` and the audit would say so.
      const kind = DEV_PROCESSES_KINDS.find((k) => pattern.toLowerCase().includes(k.toLowerCase()));
      if (kind) {
        return { covered: true, expression: `dev:processes { kinds: ['${kind}'] }` };
      }
      return {
        covered: false,
        reason: `searches for "${pattern.slice(0, 40)}", which dev:processes classifies as 'other' and drops`,
      };
    }
    // Everything left is a whole-host listing (`ps aux`, `ps -ef`, `ps -eo …`).
    // dev:processes returns at most six agent shapes, so it cannot serve a
    // request for the process table — the answer would silently omit almost
    // every row, which is worse than an error.
    return {
      covered: false,
      reason: 'asks for the whole process table; dev:processes drops every process outside its six agent kinds',
    };
  },
};

/** Every pair in the process family, in registry order. */
export const PROCESS_PAIRS: BashSubstitutionPair[] = [psProcessQuery];
