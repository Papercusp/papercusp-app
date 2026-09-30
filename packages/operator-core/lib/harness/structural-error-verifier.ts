/**
 * structural-error-verifier — the INVERSE of completion-ref-verifier (EI-1747).
 *
 * `completion-ref-verifier` confirms a DONE feature's fix-commit is PRESENT on the
 * remote (git ls-remote). THIS confirms an OPEN watchdog structural-error EI's error
 * signature is ABSENT from the deployed operator's live telemetry — so an
 * already-fixed-but-open item AUTO-RESOLVES instead of rotting. Watchdog-filed
 * structural-error EIs carry no `completion_ref`, so the completion-ref daemon never
 * touches them; they accumulate and agents burn cycles re-investigating landed fixes
 * (F-FIX-033/034/035 were all already-fixed-but-open; verifying WI-214 / F-FIX-034
 * cost real time this session). Together the two daemons close both ends of the fix
 * lifecycle: presence-on-remote (done items) ↔ absence-on-deployed (open items).
 *
 * WHY telemetry-absence == deployed-fix: `harness_shared.tool_invocations` is LIVE
 * telemetry of the RUNNING (deployed) operator. "Zero error-status invocations of this
 * tool in the trailing window" == the deployed code stopped emitting the error == the
 * fix shipped. A window-based absence check therefore inherently reads DEPLOYED state
 * (no deploy-sha resolution needed) and correctly keeps an item open until its fix
 * actually ships (an item whose fix is only on staging keeps erroring on :3070, so it
 * stays open until the deploy promotes).
 *
 * Design (su-dfe5e + su-fa300, EI-1747): a PLAIN, shed-aware `setInterval` — deliberately
 * NOT a DBOS scheduled workflow (EI-1622 workflow_status bloat) and NOT a routine-engine
 * action (wedge-prone). The decision is a pure function; all I/O is an injected seam so
 * the orchestration is unit-testable without PG or a clock.
 */
import { getOrgPg } from '@papercusp/db-org';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { setIssueState } from '../issues-engineer';
import {
  toolErrorClassSqlCase,
  toolErrorFingerprintSqlCase,
} from './improvements/tool-error-classifier';
import { parseRepeatedToolErrorKey } from './improvements/watchdog-key-migration';

/**
 * The conservative auto-resolve decision (PURE). Resolve ONLY when:
 *   1. the error has not recurred within the window,
 *   2. the item is itself older than the window (so a young item that simply has not
 *      had time to recur is never closed), AND
 *   3. a POSITIVE CONTROL: the tool was actually invoked (any status) at least once
 *      within the window.
 *
 * (3) is EI-21905244571119790's fix. Without it, "zero recurrences" is ambiguous between
 * "the bug is fixed" and "nobody exercised this code path" — and for a whole class of
 * tool defects that manifest as a well-formed `{ok:false, ...}` return value rather than
 * a thrown exception (e.g. testing:run-status's `unknown_run`), the telemetry channel
 * `countRecentToolErrors` reads is STRUCTURALLY INCAPABLE of ever recording a recurrence,
 * so recentRecurrences reads 0 forever regardless of whether the bug is fixed. Requiring
 * evidence the tool was actually called converts an unfalsifiable "silence" into at least
 * a real, if imperfect, signal, and — critically — an idle-tool false-close (recurrences=0
 * because NOBODY called it) is now correctly kept open rather than resolved.
 *
 * Erring toward keeping-open is correct: a re-open is cheap, a wrongly-closed real bug is
 * not — this is a strict tightening (never widens what auto-resolves).
 */
export function decideStructuralAutoResolve(input: {
  recentRecurrences: number;
  itemAgeMs: number;
  windowMs: number;
  recentTotalInvocations: number;
}): boolean {
  return (
    input.recentRecurrences === 0 &&
    input.itemAgeMs >= input.windowMs &&
    input.recentTotalInvocations > 0
  );
}

/** A selected OPEN structural-error item, with its exact watchdogKey parsed for the tool. */
export interface OpenStructuralItem {
  workspaceId: string;
  issueId: string;
  /** the offending tool, parsed from `repeated-tool-error:<tool>:structural[:fingerprint]`. */
  tool: string;
  watchdogKey: string;
  ageMs: number;
}

/** Injected I/O seam — concrete PG impl in `makePgStructuralVerifierDeps`; fakes in tests. */
export interface StructuralVerifierDeps {
  selectOpenStructuralItems(): Promise<OpenStructuralItem[]>;
  /**
   * Count error/timeout/refused-status `tool_invocations` for the exact structural
   * watchdogKey in `workspaceId` over the trailing windowMs.
   *
   * The key is part of the seam deliberately: two structural fingerprints under
   * one tool are distinct filings and one repaired fingerprint must not be hidden
   * by a still-failing sibling.
   */
  countRecentToolErrors(tool: string, watchdogKey: string, workspaceId: string, windowMs: number): Promise<number>;
  /**
   * EI-21905244571119790 positive control: count `tool_invocations` for `tool` in
   * `workspaceId` over the trailing windowMs, ANY status. Zero means the tool was never
   * even called in the window — "no errors" then proves nothing, and MUST NOT be read as
   * "the fix shipped".
   */
  countRecentToolInvocations(tool: string, workspaceId: string, windowMs: number): Promise<number>;
  resolveItem(workspaceId: string, issueId: string, note: string): Promise<void>;
}

export interface StructuralVerifierOptions {
  /** quiet window: error-absence for ≥ this long (and item older than this) ⇒ resolve. Default 6h. */
  windowMs?: number;
  /** safety cap on items processed per tick. Default 50. */
  maxPerTick?: number;
}

const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_MAX_PER_TICK = 50;

/**
 * One verification pass: select OPEN structural items → for each, count recent error
 * recurrences of its tool → decide → resolve the quiet+old ones (else leave open).
 * Pure over its injected deps (no PG, no wall-clock) — fully unit-testable. A single
 * item's failure (count/resolve throw) is swallowed so one bad row never aborts the pass.
 */
export async function runStructuralErrorVerifierOnce(
  deps: StructuralVerifierDeps,
  opts: StructuralVerifierOptions = {},
): Promise<{ checked: number; resolved: number; kept: number; errored: number }> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPerTick = opts.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const items = (await deps.selectOpenStructuralItems()).slice(0, maxPerTick);
  let resolved = 0;
  let kept = 0;
  let errored = 0;
  for (const item of items) {
    try {
      const [recentRecurrences, recentTotalInvocations] = await Promise.all([
        deps.countRecentToolErrors(item.tool, item.watchdogKey, item.workspaceId, windowMs),
        deps.countRecentToolInvocations(item.tool, item.workspaceId, windowMs),
      ]);
      if (
        decideStructuralAutoResolve({ recentRecurrences, itemAgeMs: item.ageMs, windowMs, recentTotalInvocations })
      ) {
        const hrs = Math.round(windowMs / 3_600_000);
        await deps.resolveItem(
          item.workspaceId,
          item.issueId,
          `auto-resolved (EI-1747 structural-error verifier): structural watchdog key \`${item.watchdogKey}\` for \`${item.tool}\` had ${recentTotalInvocations} invocation(s) but emitted no matching error/timeout/refused status in the deployed operator's telemetry for ≥${hrs}h, so this exact structural error is fixed on the deployed sha. Reopens automatically if the watchdog re-files on recurrence. (EI-21905244571119790: this close required a positive-control invocation count — see that item if the underlying defect returns a well-formed ok:false result rather than an error/timeout/refused status, which this window cannot see regardless of recurrence.)`,
        );
        resolved++;
      } else {
        kept++;
      }
    } catch {
      // best-effort cleanup — one bad row must never abort the pass.
      errored++;
    }
  }
  return { checked: items.length, resolved, kept, errored };
}

/**
 * SQL pre-filter for the OPEN structural-error EIs this daemon owns, as a Postgres
 * regex. It MUST admit BOTH minted forms of a structural watchdogKey:
 *
 *   `repeated-tool-error:<tool>:structural`         — no fingerprint was derivable
 *   `repeated-tool-error:<tool>:structural:<fp>`    — the COMMON case
 *
 * `structural` is a FINGERPRINTED class (`FINGERPRINTED_TOOL_ERROR_CLASSES`, minted by
 * `toolErrorSignalKey` — see watchdog.ts "structural + caller + transient"), so the
 * fingerprinted form is the usual one, not the exception.
 *
 * EI-19453017656411107: the previous filter was `LIKE 'repeated-tool-error:%:structural'`,
 * which anchors the class token to the END of the key and therefore dropped every
 * fingerprinted row BEFORE the parser — the stated authority below — ever saw it. That
 * silently narrowed this daemon to a minority of its own class while looking correct.
 * Measured 2026-08-03 on live rows: 90 of 133 structural keys (67.7%) carried a
 * fingerprint and were invisible to the old filter.
 *
 * Mirrors `TOOL_ERROR_KEY_RE` (watchdog-key-migration.ts) for klass=structural. Exported
 * so the unit test asserts the EXACT pattern string handed to Postgres.
 */
export const STRUCTURAL_WATCHDOG_KEY_PATTERN = '^repeated-tool-error:.+:structural(:.*)?$';

/** Concrete Postgres-backed deps. */
export function makePgStructuralVerifierDeps(
  getPg: typeof getOrgPg = getOrgPg,
  now: () => number = Date.now,
): StructuralVerifierDeps {
  return {
    async selectOpenStructuralItems(): Promise<OpenStructuralItem[]> {
      const { sql } = getPg();
      const rows = await sql<{ workspace_id: string; issue_id: string; watchdog_key: string; created_ms: string }[]>`
        SELECT workspace_id,
               issue_id,
               payload->>'watchdogKey' AS watchdog_key,
               (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_ms
        FROM harness_shared.engineer_issues
        WHERE state = 'open'
          AND payload->>'watchdogKey' ~ ${STRUCTURAL_WATCHDOG_KEY_PATTERN}
        ORDER BY created_at ASC
        LIMIT 200
      `;
      const out: OpenStructuralItem[] = [];
      for (const r of rows) {
        const parsed = parseRepeatedToolErrorKey(r.watchdog_key);
        // Only structural-class keys with a parseable tool. The regex above is a
        // coarse pre-filter admitting BOTH the bare and fingerprinted forms; the
        // parser is the authority on class + tool.
        if (!parsed || parsed.klass !== 'structural') continue;
        out.push({
          workspaceId: r.workspace_id,
          issueId: r.issue_id,
          tool: parsed.tool,
          watchdogKey: r.watchdog_key,
          ageMs: now() - Number(r.created_ms),
        });
      }
      return out;
    },

    async countRecentToolErrors(
      tool: string,
      watchdogKey: string,
      workspaceId: string,
      windowMs: number,
    ): Promise<number> {
      const parsed = parseRepeatedToolErrorKey(watchdogKey);
      // The selector is the first line of defense, but keep the injected seam
      // fail-closed if a caller supplies a malformed or mismatched key.
      if (!parsed || parsed.klass !== 'structural' || parsed.tool !== tool) return 0;

      const { sql } = getPg();
      const sinceIso = new Date(now() - windowMs).toISOString();
      // 'refused' included per EI-21905244571119790: it is the documented status for a
      // handler that dispatched cleanly and self-reported failure via isError:true (a
      // business-level refusal) rather than throwing — see RecordInvocationInput's status
      // union in projected-tool-deps.ts. The original filter (`error`, `timeout` only)
      // missed this whole class, drifting from the tool-error-classifier's own convention
      // that a refused call is a real, non-quota-neutral failure.
      const rows = await sql<{ n: string }[]>`
        WITH classified AS (
          SELECT tool_name,
                 ${toolErrorClassSqlCase(sql)} AS class,
                 error_message
            FROM harness_shared.tool_invocations
           WHERE tool_name = ${tool}
             AND workspace_id = ${workspaceId}
             AND status IN ('error', 'timeout', 'refused')
             AND invoked_at > ${sinceIso}
        ),
        tagged AS (
          SELECT tool_name,
                 class,
                 ${toolErrorFingerprintSqlCase(sql)} AS fingerprint
            FROM classified
        )
        SELECT COUNT(*)::text AS n
          FROM tagged
         WHERE tool_name = ${tool}
           AND class = 'structural'
           AND fingerprint IS NOT DISTINCT FROM ${parsed.fingerprint}
      `;
      return Number(rows[0]?.n ?? 0);
    },

    async countRecentToolInvocations(tool: string, workspaceId: string, windowMs: number): Promise<number> {
      const { sql } = getPg();
      const sinceIso = new Date(now() - windowMs).toISOString();
      const rows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
        FROM harness_shared.tool_invocations
        WHERE tool_name = ${tool}
          AND workspace_id = ${workspaceId}
          AND invoked_at > ${sinceIso}
      `;
      return Number(rows[0]?.n ?? 0);
    },

    async resolveItem(workspaceId: string, issueId: string, note: string): Promise<void> {
      const { sql } = getPg();
      // First append the verifier's durable explanation and lifecycle projection, guarded
      // to the OPEN row. The terminal state itself MUST go through setIssueState: migration
      // 797 makes the engineer_issues compatibility-view trigger refuse direct lifecycle
      // flips, and setIssueState supplies the owner + completion reference gate.
      const changed = await sql<{ issue_id: string }[]>`
        UPDATE harness_shared.engineer_issues
        SET body = body || ${'\n\n' + note},
            payload = CASE
              WHEN payload ? 'ideaLifecycle'
                THEN jsonb_set(payload, '{ideaLifecycle,state}', '"resolved"'::jsonb)
              ELSE payload
            END,
            updated_at = NOW()
        WHERE workspace_id = ${workspaceId} AND issue_id = ${issueId} AND state = 'open'
        RETURNING issue_id
      `;
      if (!changed[0]) return;
      const resolved = await setIssueState(issueId, 'resolved', 'structural-error-verifier', note);
      if (!resolved) {
        throw new Error(`structural-error-verifier: lifecycle write was not applied for ${workspaceId}/${issueId}`);
      }
    },
  };
}

let timer: ManagedHandle | null = null;

/**
 * Start the shed-aware periodic verifier. Idempotent (a second call is a no-op while one
 * is running). The tick is best-effort cleanup: it is SKIPPED while the host is shedding
 * load, and a tick failure is swallowed (the next tick retries). The timer is `unref`'d
 * so it never holds the process open.
 */
export function startStructuralErrorVerifier(
  opts: {
    intervalMs?: number;
    windowMs?: number;
    isShedding?: () => boolean;
    deps?: StructuralVerifierDeps;
    log?: (msg: string) => void;
  } = {},
): { stop: () => void } {
  if (timer) return { stop: stopStructuralErrorVerifier };
  const intervalMs = opts.intervalMs ?? 30 * 60 * 1000; // every 30m — slow, low-stakes cleanup
  const deps = opts.deps ?? makePgStructuralVerifierDeps();
  const run = async (): Promise<void> => {
    if (opts.isShedding?.()) return; // shed under load — cleanup is never urgent
    try {
      const r = await runStructuralErrorVerifierOnce(deps, { windowMs: opts.windowMs });
      if (r.resolved > 0) {
        opts.log?.(
          `[structural-error-verifier] auto-resolved ${r.resolved}/${r.checked} stale structural EIs (${r.kept} kept, ${r.errored} errored)`,
        );
      }
    } catch (e) {
      opts.log?.(
        `[structural-error-verifier] tick failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  timer = managedSetInterval('structural-error-verifier', intervalMs, () => run(), { category: 'global-sweep' });
  // EI-19453017656411107 — ARMING must be observable. The tick above logs only when it
  // actually resolves something, so an armed-but-idle daemon and a never-started one
  // emitted byte-identical output: nothing. That is exactly how this stayed dark on
  // :3070 from the day it was written without anyone noticing, and why "0 log lines in
  // 6h" was NOT sufficient evidence of darkness on its own (the /proc environ check
  // was). One line at start makes the two states distinguishable from logs alone.
  opts.log?.(
    `[structural-error-verifier] armed — every ${Math.round(intervalMs / 60_000)}m (kill-switch: PAPERCUSP_STRUCTURAL_ERROR_VERIFIER=0)`,
  );
  return { stop: stopStructuralErrorVerifier };
}

export function stopStructuralErrorVerifier(): void {
  if (timer) {
    timer.stop();
    timer = null;
  }
}
