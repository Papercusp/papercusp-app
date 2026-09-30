/**
 * VERBATIM replay corpus for the measurement-overlap duplicate signal (plan
 * duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05, R-1/R-2).
 *
 * Title + summary of the measured true-duplicate pair, copied byte-for-byte from
 * harness_shared.work_items on 2026-09-27. EI-22393887492211068 was filed first;
 * WI-2145269 followed 61s later and was admitted beside it. Do NOT tidy, reflow or
 * re-derive this text: the whole point is that the wording differs while the
 * measurements agree.
 */

export interface ReplayRow {
  id: string;
  /** created_ts (epoch ms) as stored. */
  createdTs: number;
  title: string;
  summary: string;
}

export const FIRST_FILED_EI_22393887492211068: ReplayRow = {
  id: "EI-22393887492211068",
  createdTs: 1788582075342,
  title:
    "Telemetry retention gap keeps the papercusp dump above the backup headroom guard: session_archive_files (21.6 GiB) uncovered, tool_invocations regressed to 14.6 GiB vs its own 5.6 GiB baseline",
  summary:
    "WHY THIS IS FILED AS A BUG, NOT A CHORE: it is the standing root cause of WI-2145150. The hourly papercusp dump is ~110 GiB, so the backup headroom guard needs 274 GiB free (110 x 1.40 = 154, + the 120 GiB floor). The volume cannot hold that, so papercusp is SKIPPED every hour and STATUS.json reports failed:[\"papercusp\"]. 12 of 13 databases dump fine; only this one is starved. RPO is currently degrading, not lost (previous dump intact).\n\nMEASURED 2026-09-05T04:22Z, top of harness_shared by pg_total_relation_size:\n  session_archive_files   21.6 GiB   <-- LARGEST\n  tool_invocations        14.6 GiB\n  session_turns           10.2 GiB\n  session_turn_chunks      6.3 GiB\n  session_turn_parts       5.8 GiB\n  gateway_payload_blobs    3.7 GiB\n  route_invocations        3.0 GiB\n  work_items               2.0 GiB\n  memory_recall_stats      1.8 GiB\n  coord_event_log          1.5 GiB\n  agent_activity           1.3 GiB\n\nTWO DISTINCT DEFECTS, both against WI-844 (RESOLVED, titled 'Telemetry table retention: route_invocations 9.2GB/42M + tool_invocations 5.6GB/8M (~15GB, dominant PG growth)'):\n\n1. REGRESSION. route_invocations fell 9.2 -> 3.0 GiB, so that retention works. tool_invocations went 5.6 -> 14.6 GiB, ~2.6x the baseline recorded in WI-844's own title, despite being equally in scope. Its retention is either not running or its policy is too loose. NOTE: 5.6 GiB is the figure in that title, i.e. the state when it was filed, not a reading I took pre-fix myself — the comparison is against the item's own recorded baseline.\n\n2. COVERAGE GAP. session_archive_files (21.6 GiB) is now the single largest table and was never in WI-844's scope at all, nor is the session_turn* family (22.3 GiB combined across turns/chunks/parts). WI-844's premise that route_invocations + tool_invocations were 'dominant PG growth' is no longer true.\n\n⛔ THE OBVIOUS FIX IS WRONG — DO NOT EXCLUDE THESE FROM THE HOURLY DUMP. packages/backup/src/hook.ts:58-100 already excludes ~28 such tables from the WORKSPACE SNAPSHOT, and its own comment states they 'stay recoverable from the hourly host-level dump (db-backup.sh -> /mnt/data/Backup/db-dumps/pg/papercusp/), which includes all table data.' The hourly dump is the FIDELITY BACKSTOP the slim snapshot depends on. Copying that exclusion list into the hourly dump would shrink it under the guard AND leave session_archives, audit_log, decision_ledger et al. in NO backup at all — a silent total recovery gap that would present as a successful fix.\n\nThe safe lever is RETENTION (delete the rows), not EXCLUSION (stop backing them up): retention shrinks the DB so both dump paths shrink and nothing loses coverage.\n\nALSO RULED OUT (measured, so nobody re-derives it): reclaiming disk cannot fix this. I freed 33 GiB of build scratch under a leader ruling and free space ended LOWER than it started (249 -> 243 GiB); a 90s sample showed ~-1.3 GiB/min sustained drift from fleet churn. Deletion cannot outrun consumption on this volume.\n\nREPRO: the SQL above against papercusp, plus tail /mnt/data/Backup/db-dumps/db-backup.log for the hourly 'papercusp SKIPPED — needs ~154 GiB ... plus the 120 GiB floor' line.",
};

export const SECOND_FILED_WI_2145269: ReplayRow = {
  id: "WI-2145269",
  createdTs: 1788582131531,
  title:
    "DB retention scope is stale and incomplete — session_archive_files (22GB) was never in WI-844; papercusp dump requirement stays above available headroom",
  summary:
    "Supersedes the scope of WI-844 (marked RESOLVED, covered ~15GB). Two agents converged on this independently within minutes — su-c2e1f693 by triage, me by direct table sizing.\n\nMEASURED harness_shared, top 8 by total relation size (86 GB DB, 67.3 GiB in these 8):\n  session_archive_files   22 GB   <-- LARGEST, never in WI-844 scope\n  tool_invocations        15 GB   <-- WI-844 recorded 5.6 GB; has REGRESSED\n  session_turns           10 GB\n  session_turn_chunks    6.4 GB\n  session_turn_parts     6.0 GB\n  gateway_payload_blobs  3.8 GB\n  route_invocations      3.1 GB   <-- WI-844 recorded 9.2 GB; has SHRUNK\n  work_items             2.1 GB\n\nWHY IT MATTERS (the mechanism, stated so it is checkable): the backup guard requires free >= dump*1.4 + 120 GiB floor = ~274 GiB. Free is ~243. The papercusp dump has been SKIPPED every hour. Retention on these tables shrinks the DB -> shrinks the dump -> LOWERS the requirement. It does NOT free /mnt/data directly (PGDATA is on /), so judge it by the guard's stated \"needs ~N GiB\" line falling, not by df.\n\nHARD CONSTRAINT: retention is NOT pg_dump --exclude-table-data. Exclusion removes backup COVERAGE and creates a silent recovery gap; retention removes the ROWS. su-c2e1f693 nearly proposed exclusion and correctly stopped — do not reintroduce it.\n\nDO NOT: order further disk reclaim. That lane is spent and measured twice — 33 GiB freed and free space ended LOWER than it started. Reclaiming is a treadmill here; the requirement side is the lever.\n\nCAUTION CARRIED FROM THIS INVESTIGATION: before deleting anything on disk, scan the exact path for *.deb/*.dmg/*.sig/*.asc. A steward ruling of mine (this session) would have destroyed a signed 0.0.18 .deb because I inferred \"regenerable\" from a directory name. \"Regenerable by name\" is not evidence.\n\nOPEN / NOT ESTABLISHED: what consumed ~13 GiB of /mnt/data in ~90s (free has since been stable at 243.18 GiB across repeated samples). I made two causal claims about it and retracted both; a running pg_dump seen during that window parents to the operator hono-host and writes to a SOCKET, so it is neither \"a leak\" nor the backup service. Do not inherit either story.",
};

/** Title + summary, joined the way the admission guards join them. */
export function searchableText(row: Pick<ReplayRow, "title" | "summary">): string {
  return `${row.title}\n${row.summary}`;
}
