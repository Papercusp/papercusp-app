/**
 * stranded-checkpoint-scan — the read behind `work_items:stranded` (WI-38297).
 *
 * THE PROBLEM IT MEASURES. The backlog holds finished, committed work that is still
 * `open`. The shape is always the same: a holder does the work, writes a checkpoint
 * that says so, releases the item pending one last verification — and the verification
 * never reports, because it was a native background job whose bookkeeping lives in the
 * holder's own process and dies with it (EI-16611). Measured instances: WI-5895 sat
 * open 17 days after its fix was committed; WI-3561 and WI-3578, 34 days each. Their
 * checkpoints said the work was done. Nothing read them in bulk.
 *
 * WHY THIS IS A READ AND NOT A SWEEP. `checkpointDeclaresTerminal` — the best
 * available classifier, and the one this reuses rather than inventing a rival — was
 * measured at ~43% precision over this exact population (2026-08-12, hand-reading
 * EVERY one of its 23 matches). A majority-correct classifier is fine for a queue a
 * reader triages and fatal for anything that closes items: the observed false
 * positives include a checkpoint opening "⛔ DO NOT CLOSE…" and another reading
 * "CLAIMED, no code written yet". So this returns CANDIDATES and the note HEAD that
 * justifies each one, and deliberately offers no close/flip path. See
 * {@link ./checkpoint-terminal-claim} for the two classifiers rejected on the same
 * evidence — do not reintroduce them as refinements.
 *
 * SCOPE: issue-family (`engineer_issues`) only, on purpose. Feature-family units
 * already have a live consumer of the same predicate — the pot placement watchdog's
 * stale-open reconcile (EI-15232) — so they are covered, and only 5 open feature rows
 * carry a checkpoint at all. Issue-family is the genuinely unwatched population (444
 * of 25,613 open issues carry a checkpoint).
 */
import { getOrgPg } from '@papercusp/db-org';
import { checkpointDeclaresTerminal } from './checkpoint-terminal-claim';
import { detectBgJobCheckpointClaim } from './checkpoint-bg-job-claim';
import { claimHoldExclusionSql } from './work-items';
import { issueOwnAuthorWhereSql } from './work-items-admission';

/**
 * The auto-appended tool-log section, stripped before the head is cut.
 *
 * This is not cosmetic — it is the trap that killed the tail-reading classifier. Every
 * checkpoint written through the normal turn-end path gets a `tool-log tail:` block
 * listing tool NAMES, and those names include the literal strings `work_items_complete`
 * and `work_items_release`. A reader (human or regex) that sees the END of a checkpoint
 * therefore sees words that look exactly like a completion claim on 100% of notes,
 * regardless of what the author actually wrote. 6 of 15 matches in the tail experiment
 * were pure tool-log noise.
 */
const TOOL_LOG_TAIL_RE = /\n\s*tool-log tail:[\s\S]*$/i;

/** Default char budget for the returned head — enough to carry an author's opening
 *  verdict (the part that decides the item) without shipping whole checkpoints. */
export const CHECKPOINT_HEAD_CHARS = 400;

/**
 * The reader-facing excerpt: the checkpoint's HEAD, tool-log stripped.
 *
 * HEAD and not tail because the assertive terminal declaration this scan selects on is
 * anchored to the start of the note — that anchoring is the only reason the classifier
 * survives the tool-log at all — so the head is both what matched and what a reader
 * needs in order to overturn the match.
 */
export function checkpointHead(note: string, maxChars = CHECKPOINT_HEAD_CHARS): string {
  const body = note.replace(TOOL_LOG_TAIL_RE, '').trim();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars).trimEnd()}…`;
}

export interface StrandedCandidate {
  id: string;
  harness: string | null;
  kind: string | null;
  title: string;
  assignee: string | null;
  severity: string | null;
  /** Checkpoint HEAD (tool-log stripped) — the evidence for the match, to be READ. */
  checkpointHead: string;
  /** Epoch ms of the checkpoint's last write. */
  checkpointWrittenTs: number | null;
  /** Days since the checkpoint was written — the strand's age, the triage sort key. */
  checkpointAgeDays: number | null;
  /**
   * The item's checkpoint ALSO cites a background job/task as its evidence — the
   * specific WI-38297 smell, and a strictly stronger signal than the terminal
   * declaration alone: a checkpoint promising "will complete once the bg job lands"
   * names a reference that cannot outlive its author's process, so the promised
   * report provably never arrived.
   */
  citesBgJob: boolean;
  /**
   * Whether THIS node can take the item terminal at all.
   *
   * A remote-authored item REFUSES `work_items:complete` locally — "its authoring peer
   * must claim/resolve it, and this node will receive the terminal state through
   * federation". Nothing about the checkpoint, the age, or the bg-job citation predicts
   * it, so a drain agent discovers it only AFTER paying the whole verification cost.
   * That happened on WI-3529: fully source-verified (rig real, 4/4 green in 10 days),
   * then unclosable — the evidence had to be posted as a comment for its authoring peer
   * instead. Measured 2026-08-12 over the live backlog: 74 of 489 open checkpointed
   * items (15%) are remote-authored, so this is a routine outcome, not an edge case.
   *
   * A `false` does NOT mean "skip it" — those strands still need draining, just by a
   * different move (verify, then hand the authoring peer the evidence).
   *
   * WI-10006562: an origin='remote' row authored by one of THIS node's own keys (a sync
   * echo stranded the label) IS closable here — the write paths heal its origin
   * (selfHealOwnNodeOriginIfStranded) — so it reads `true`, with `ownNodeAuthored` saying why.
   */
  closableLocally: boolean;
  /** Raw federation origin backing `closableLocally` (`'local' | 'remote' | null`). */
  origin: string | null;
  /** True only for an origin='remote' row whose author key is one of this node's own keys:
   *  the remote label is a stranded echo, not a peer's authorship. */
  ownNodeAuthored: boolean;
}

export interface StrandedScanResult {
  /** Open issue-family rows carrying ANY checkpoint — the population classified. */
  scanned: number;
  /** How many of `scanned` satisfied the WHOLE predicate (classifier + `minAgeDays`).
   *  A COUNT OVER THE FULL POPULATION, never over the returned page — see
   *  `returned`/`truncatedByLimit`. */
  matched: number;
  /** The `minAgeDays` floor this result was computed under, echoed so `matched` is never
   *  read as an unfiltered total. 0 = no age floor. */
  minAgeDays: number;
  /** Of `matched`, how many also cite a background job (the stronger signal). */
  matchedCitingBgJob: number;
  /** Of `matched`, how many CANNOT be closed on this node (remote-authored). Counted
   *  over the FULL population like every other count here, never over the page, so a
   *  caller sizing "how much of this can I actually drain" is not reading a floor. */
  matchedNotClosableLocally: number;
  /** Rows actually returned (bounded by the caller's limit). */
  returned: number;
  /** True when `matched > returned` — the counts above are still totals, but the ROW
   *  LIST is a page. Present so a floor is never read as a total. */
  truncatedByLimit: boolean;
  candidates: StrandedCandidate[];
}

interface ScanRow {
  issue_id: string;
  scope: string | null;
  kind: string | null;
  title: string | null;
  assignee: string | null;
  severity: string | null;
  origin: string | null;
  /** origin='remote' AND authored by one of this node's own keys (computed in the scan SQL). */
  own_node_authored?: boolean | null;
  note: string | null;
  updated_ts: string | number | null;
}

/** `engineer_issues.scope` is `harness:<slug>` (or a bare word like `operator` for an
 *  unscoped row). Returns the slug, or null when there is no harness component. */
export function harnessFromIssueScope(scope: string | null | undefined): string | null {
  if (!scope) return null;
  const m = /^harness:(.+)$/.exec(scope);
  return m ? (m[1] ?? null) : null;
}

/**
 * Classify one already-fetched population. Pure — exported so the precision/behaviour
 * tests exercise the real classifier over fixture rows without a database.
 */
export function classifyStrandedRows(
  rows: readonly ScanRow[],
  opts: { limit: number; headChars?: number; minAgeDays?: number },
): StrandedScanResult {
  const scanned = rows.length;
  const minAgeDays = opts.minAgeDays ?? 0;
  const matches: StrandedCandidate[] = [];
  let matchedCitingBgJob = 0;
  let matchedNotClosableLocally = 0;

  for (const r of rows) {
    const note = r.note ?? '';
    if (!checkpointDeclaresTerminal(note)) continue;
    const writtenTs = r.updated_ts == null ? null : Number(r.updated_ts);
    const ts = writtenTs != null && Number.isFinite(writtenTs) ? writtenTs : null;
    const ageDays = ts == null ? null : Math.floor((Date.now() - ts) / 86_400_000);
    // An un-dated checkpoint is KEPT under an age floor rather than dropped: "age
    // unknown" is not evidence of freshness, and silently discarding it would hide
    // exactly the rows whose provenance is already damaged.
    if (minAgeDays > 0 && ageDays != null && ageDays < minAgeDays) continue;
    const citesBgJob = detectBgJobCheckpointClaim(note).detected;
    if (citesBgJob) matchedCitingBgJob += 1;
    // Only an explicit 'remote' blocks a local close — an unknown/null origin is treated
    // as closable so a missing column reads as "try it", never as a phantom wall that
    // hides drainable work. The refusal is authoritative and cheap when we are wrong.
    // An own-node row stranded at 'remote' is no wall either (WI-10006562): its write paths
    // heal the label, so only a remote row authored by a PEER blocks a local close.
    const remoteLabel = r.origin === 'remote';
    const ownNodeAuthored = remoteLabel && r.own_node_authored === true;
    const closableLocally = !remoteLabel || ownNodeAuthored;
    if (!closableLocally) matchedNotClosableLocally += 1;
    matches.push({
      id: r.issue_id,
      harness: harnessFromIssueScope(r.scope),
      kind: r.kind,
      title: r.title ?? '',
      assignee: r.assignee,
      severity: r.severity,
      checkpointHead: checkpointHead(note, opts.headChars),
      checkpointWrittenTs: ts,
      checkpointAgeDays: ageDays,
      citesBgJob,
      closableLocally,
      origin: r.origin,
      ownNodeAuthored,
    });
  }

  // OLDEST STRAND FIRST — age is the primary key, `citesBgJob` only breaks ties.
  //
  // The first cut of this ranked citesBgJob ABOVE age, on the reasoning that a checkpoint
  // promising a background-job result is the highest-confidence strand. Running the scan
  // against the live backlog refuted that outright (2026-08-12): the four bg-citing
  // matches were 0d, 0d, 3d and 10d old, while every genuinely stranded item — WI-3529
  // (33d), WI-5372 (24d), WI-5457 (23d) — cited no job at all. The reason is obvious in
  // hindsight: an agent whose checkpoint mentions a running background job is usually an
  // agent working RIGHT NOW. The citation explains how a strand is CREATED; it does not
  // identify one after the fact. Age does. Sorting bg-first put the least-stranded rows
  // at the top of a queue whose entire purpose is surfacing the most-stranded.
  matches.sort((a, b) => {
    const byAge = (b.checkpointAgeDays ?? -1) - (a.checkpointAgeDays ?? -1);
    if (byAge !== 0) return byAge;
    if (a.citesBgJob !== b.citesBgJob) return a.citesBgJob ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const page = matches.slice(0, opts.limit);
  return {
    scanned,
    // The counts are computed over the WHOLE population, before the page is cut — a
    // count derived from a capped fetch is indistinguishable from a real total, and
    // this one is read as "how much stranded work is there".
    matched: matches.length,
    minAgeDays,
    matchedCitingBgJob,
    matchedNotClosableLocally,
    returned: page.length,
    truncatedByLimit: matches.length > page.length,
    candidates: page,
  };
}

/**
 * Fetch + classify. The join keys on the work-item ID PARSED OUT OF the carry-note
 * scope, never on a scope string rebuilt in SQL.
 *
 * That distinction is load-bearing. The scope's harness component is CANONICALIZED on
 * write (`workItemCheckpointScope`: null / '' / '*' all collapse onto the `*`
 * sentinel, EI-8805), so SQL that rebuilds `'workitem:' || harness || ':' || id` from
 * an item's own columns silently misses every harness-null item — the exact namespace
 * drift that canonicalization exists to prevent, reintroduced on a new seam. Matching
 * on the trailing id component sidesteps the harness question entirely, and is sound
 * for the reason the canonicalization itself relies on: a work-item id is unique
 * within a workspace. `[^:]+$` (rather than a positional split) keeps that true even
 * if a harness slug ever contains a colon.
 */
export async function scanStrandedCheckpoints(args: {
  workspaceId: string;
  harness?: string | null;
  limit: number;
  headChars?: number;
  minAgeDays?: number;
}): Promise<StrandedScanResult> {
  const { sql } = getOrgPg();
  const harnessScope = args.harness ? `harness:${args.harness}` : null;
  const rows = await sql<ScanRow[]>`
    SELECT ei.issue_id, ei.scope, ei.kind, ei.title, ei.assignee, ei.severity,
           ei.origin, cn.note, cn.updated_ts,
           -- WI-10006562: same own-key predicate the claim gate and write-path heal use
           -- (work-items-admission.ts), so the label and the refusal cannot disagree.
           (ei.origin = 'remote' AND EXISTS (
             SELECT 1 FROM harness_shared.work_items wi
              WHERE wi.workspace_id = ei.workspace_id AND wi.feature_id = ei.issue_id
                AND ${issueOwnAuthorWhereSql(sql, args.workspaceId)}
           )) AS own_node_authored
      FROM harness_shared.carry_notes cn
      JOIN harness_shared.engineer_issues ei
        ON ei.workspace_id = cn.workspace_id
       AND ei.issue_id = substring(cn.scope from '[^:]+$')
     WHERE cn.workspace_id = ${args.workspaceId}
       AND cn.scope LIKE 'workitem:%'
       AND ei.state = 'open'
       -- WI-2797: a claim-held row is deliberately parked out of self-select. It is
       -- still open and directly claimable by id, but it is not stranded work for this
       -- queue; apply the shared floor before the classifier and its aggregate counts.
       AND ${claimHoldExclusionSql(sql, 'ei.payload')}
       AND (${harnessScope}::text IS NULL OR ei.scope = ${harnessScope})`;

  return classifyStrandedRows(rows, {
    limit: args.limit,
    headChars: args.headChars,
    minAgeDays: args.minAgeDays,
  });
}
