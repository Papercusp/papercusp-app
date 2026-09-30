/**
 * logs:read — the matching lines from a systemd unit's journal, distilled.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-023 (D-027 measurement + design
 * ruling). The parsing, argv construction and journalctl error semantics live in
 * `lib/journal-read.ts` so they are testable without a real journal; this file is
 * the argument envelope and the honest-null projection.
 *
 * ── Why a new verb and not a mode on something existing (D-027 §1) ──────────
 * `dev:service_health` answers up/down/latency for a FIXED endpoint registry —
 * a different question, and it feeds an alarm path. The existing `journal:*`
 * group is the AGENT journal (peer briefs, push utilization): reusing that
 * namespace would collide on the single most confusable word in the system.
 * Before building, `tools:find` for a unit-journal reader was run and returned
 * exactly those two plus `activity:tool-log` — reproducing the two saved recipes
 * (`locate-checkpoint-journal-reader`, `find-bounded-log-inspection-tool`) in
 * which agents searched for this tool, found nothing, and fell back to raw
 * journalctl. There is no surface to extend; this is the missing one.
 *
 * ── Why there is no raw-output passthrough ──────────────────────────────────
 * 96% of the measured corpus pipes journalctl into `| grep` / `| tail`, and 0%
 * uses `--grep`. Handing back raw output would re-create that pipe inside the
 * tool and forfeit the whole saving. `grep` is pushed down to journalctl.
 *
 * ── Scope, stated honestly so the substitution pair cannot lie ──────────────
 * `-f`/`--follow` (4 of 428 measured commands) is NOT covered: a streaming
 * follow has no request/response form, the same caveat `capability:read` carries
 * for `tail -f`. Keep using bash for that.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveUnitName } from '../dev/systemd-service-probe';
import {
  JOURNAL_LEVELS,
  JOURNAL_READ_DEFAULT_LIMIT,
  JOURNAL_READ_DEFAULT_SINCE,
  JOURNAL_READ_MAX_LIMIT,
  JOURNAL_SCOPES,
  readJournal,
} from '../../journal-read';
import { shapeLogsRead } from './read-shape';

export default defineTool({
  name: 'logs:read',
  profile: 'engineer',
  description:
    "A host service's log lines, filtered SERVER-SIDE and distilled — `journalctl --user -u <unit> --since <w> | grep <pat> | tail -n` on Linux, or the equivalent macOS `log show` unified-log query — as { backend, entries:[{ts,unit,level,message,repeat}], matched, collapsed, truncated }. `grep` is pushed into the host logger's predicate so only matching lines are read, and consecutive identical lines collapse to one row + a count. Reads logs only — it does not follow (`-f`) and does not restart anything.",
  capability: 'intel:read',
  guidance: {
    when: 'You need what a service actually logged: diagnosing why a unit failed, restarted, or went quiet; finding a specific marker line in a window; confirming a deploy/tick/job ran. Pass `grep` with the needle you would have piped to grep — that is the point of the tool.',
    notWhen: 'NOT "is the service up" (dev:service_health) and NOT "did MY background job finish" (capability:bash_output). A live streaming follow (`journalctl -f`) has no tool form — keep using bash for that. Reading a *.log FILE is capability:read — for a `release:deploy` log path, call `capability:read { file_path: <logPath>, tail: N }` (optionally add result projection `grep`), not `logs:read` with the path as a journal unit.',
    chaining: 'dev:service_health says a unit is down → logs:read { unit, grep:"error|failed" } says why. Widen by loosening `grep` or `since`, not by dropping to raw journalctl.',
    returns:
      "{ entries[], matched, collapsed, truncated, window, units, unitsUnknown, unitsHistorical, historicalCommand, windowOutsideJournal, journalAvailable, journalError, command }.\n\nAN EMPTY `entries` HAS FIVE DIFFERENT MEANINGS — read these fields before concluding anything from it:\n  • windowOutsideJournal non-null → YOUR WINDOW IS IN THE FUTURE, nothing was 'quiet'. journalctl parses `since`/`until` in LOCAL time while papercusp reports UTC, so a pasted UTC stamp queries ahead of now and returns a clean 0 rows. The field carries resolvedSinceUtc, newestEntryUtc, aheadByMs and a ready hint — prefer a RELATIVE window ('-30 min'). Null does NOT clear the window (the check is skipped when it cannot be proven), so a relative window is still the safe default.\n  • unitsHistorical non-empty → systemd no longer has the transient unit loaded, but a bounded unscoped journal fallback found historical messages naming it. These are real historical records, not a clean live-unit window; `historicalCommand` shows the exact fallback argv.\n  • unitsUnknown non-empty → no journal record was recovered and systemd does not know that unit. The name may be WRONG (a typo, or it was never installed); fix the name and re-read.\n  • journalError non-null → the read FAILED (including a scan that TIMED OUT before finishing — a wide `since` + a `grep` + the `-n` tail cap forces a slow reverse scan on a chatty unit). `entries` is meaningless, NOT empty, and `matched` is `null`, NEVER 0 — a 0 there would be indistinguishable from a genuinely clean window. Never report 'no errors in the log' from this state; on a timeout, narrow `since`/`grep` or lower `limit` and retry.\n  • journalAvailable:false → this host has NO systemd journal at all (macOS, a container, the shipped desktop target). Says nothing about the service.\n  • all three clear → the window is GENUINELY CLEAN. (journalctl exits 1 when --grep matches nothing; that is a clean read, not a failure.)\n\n`repeat` > 1 means that row stands for N CONSECUTIVE identical lines (`lastTs` is the final one); `collapsed` totals the lines removed. `truncated:true` means older rows were dropped to honour `limit` — the NEWEST are kept, so widen `since` or tighten `grep` rather than raising `limit` blindly. `matched` counts lines before dedup but is BOUNDED BY limit+1 (the cap is pushed down to journalctl's `-n`), so on a truncated read it is a FLOOR, never the true total — do not report it as 'there were N matches'. `command` is the primary journalctl argv; `historicalCommand` is the bounded fallback argv when it was needed.\n\n`window.resolved` states the ABSOLUTE UTC window that was actually searched, and is present on EVERY zero-row read (null on a read that returned rows, on a failed read, and off systemd — it is not resolved where it buys nothing). Read it before concluding anything from an empty result: `since`/`until` echo back the SPECS you passed, which look identical whether they meant what you intended or four hours away from it. `sinceUtc`/`untilUtc` are what journalctl's own grammar resolved them to (a null FIELD inside a present object means that spec was unresolvable, not that the window was open), `untilRequested` separates \"unbounded end\" from \"could not tell\", and `invertedHint` non-null means `until` resolved BEFORE `since` — the window cannot match anything by construction, so 0 rows says nothing at all about what was logged.",
    seeAlso: [
      'dev:service_health (is a KNOWN service healthy — probes the endpoint registry)',
      'dev:restart (restart a dev service, with the drain protocol)',
      'capability:read (read a *.log FILE, including `tail -n` semantics)',
      'release:deploy (status exposes deploy/checkpoint log paths and direct file-read handles)',
    ],
  },
  requirePrincipal: false,
  // journal-read shells out to journalctl/systemctl and never reads ctx.tx. Do not
  // retain the dispatcher's ambient org-app transaction while that host I/O runs;
  // code:run's inner dispatch honors this flag too, avoiding a pool acquisition
  // before log triage under fleet load (EI-20246577252417163).
  skipWorkspaceTx: true,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    unit: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(10)])
      .optional()
      .describe("Unit name(s). A bare name is `.service`-suffixed ('papercup-bg-host' → 'papercup-bg-host.service'); '.timer'/'.socket'/'.target' etc are left alone. Several units read as one merged, time-ordered stream."),
    identifier: z.string().min(1).max(200).optional()
      .describe('Syslog identifier (`journalctl -t`), for entries logged without a unit.'),
    since: z.string().min(1).max(100).optional()
      .describe(`Window start, in journalctl's own grammar: '-30 min', '2 hours ago', '09:40:00', '2026-07-26 00:00'; compact lookbacks such as '40m' and '-2h' are also accepted. Bare absolute date/time values are parsed in the host's LOCAL timezone, while returned entry timestamps are UTC — use a relative window or an explicit @epoch value when UTC precision matters. Default '${JOURNAL_READ_DEFAULT_SINCE}'. REQUIRED when neither unit nor identifier is given, because an unscoped scan walks every unit in the journal (measured 25.97s versus 7.58s scoped, on the same host).`),
    until: z.string().min(1).max(100).optional().describe("Window end, same grammar and LOCAL-time rule for bare absolute values; returned timestamps are UTC. Use a relative window or explicit @epoch value for an unambiguous UTC boundary. Omit for 'up to now'."),
    grep: z.string().min(1).max(500).optional()
      .describe('Case-insensitive PCRE pushed down to `journalctl --grep`, so non-matching lines are never read. Pass the needle you would otherwise have piped to grep — alternation works: "oom|killed process".'),
    level: z.enum(JOURNAL_LEVELS).optional()
      .describe("Minimum severity: this level AND MORE SEVERE (journalctl `-p` semantics), so level:'err' also returns crit/alert/emerg."),
    limit: z.number().int().min(1).max(JOURNAL_READ_MAX_LIMIT).optional()
      .describe(`Max rows returned, newest kept (default ${JOURNAL_READ_DEFAULT_LIMIT}). Collapsed repeats count as ONE row.`),
    scope: z.enum(JOURNAL_SCOPES).optional()
      .describe("Which journal: 'user' (default, the papercup-* units), 'system' (kernel/OOM records, pgbouncer, systemd-oomd — a DIFFERENT journal, not a filter), or 'all' (everything you can see). If a unit you know exists comes back with unitsUnknown naming it, you are reading the wrong journal."),
  }),
  result: z
    .object({
      entries: z.unknown().optional(),
      matched: z.unknown().optional(),
      collapsed: z.unknown().optional(),
      truncated: z.unknown().optional(),
      window: z.unknown().optional(),
      units: z.unknown().optional(),
      unitsUnknown: z.unknown().optional(),
      unitsHistorical: z.unknown().optional(),
      historicalCommand: z.unknown().optional(),
      windowOutsideJournal: z.unknown().optional(),
      journalAvailable: z.unknown().optional(),
      journalError: z.unknown().optional(),
      command: z.unknown().optional(),
    })
    .passthrough(),
  // EI-20203342112661815: `limit` bounds ROWS, not BYTES, so a 120-row read of a
  // chatty unit built a 34KB payload that the generic door then cut to 12 of 120
  // entries — keeping the array HEAD, which inverts this tool's documented
  // newest-kept guarantee into oldest-kept. These shapers spend a measured char
  // budget from the newest end instead, and stamp the cut. See read-shape.ts.
  shape: {
    standard: (data) => shapeLogsRead(data, 'standard'),
    trimmed: (data) => shapeLogsRead(data, 'trimmed'),
  },
  async handler(args, ctx) {
    void ctx;
    const units = args.unit === undefined
      ? []
      : (Array.isArray(args.unit) ? args.unit : [args.unit]).map(resolveUnitName);

    // An unscoped read walks EVERY unit in the journal. That is a real cost
    // (25.97s vs 7.58s on a 1.2GB journal, per soak-report's measurement), so it
    // stays available — 35 of 428 measured commands genuinely need it — but only
    // with an explicit window, never with a silently-defaulted one.
    if (!units.length && !args.identifier && !args.since) {
      return {
        data: {
          ok: false,
          error: 'unscoped_read_needs_since',
          detail:
            'Reading with no `unit` and no `identifier` scans every unit in the journal. Pass `unit` (much faster), or pass an explicit `since` window to accept the host-wide scan.',
        },
      };
    }

    const result = await readJournal({
      units,
      identifier: args.identifier,
      since: args.since,
      until: args.until,
      grep: args.grep,
      level: args.level,
      limit: args.limit,
      scope: args.scope,
    });

    return { data: { ok: result.journalError === null, ...result } };
  },
});
