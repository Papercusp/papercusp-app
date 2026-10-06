/**
 * edit-attribution — the P-001 edit-time CAPTURE of
 * deterministic-commit-workitem-attribution-2026-06-22.
 *
 * Writes one harness_shared.edit_attribution_ledger row per granted file edit, joining
 * the lock holder's claimed lane (work-item + harness) AT EDIT TIME (D-002) so attribution
 * SURVIVES the agent's session ending before the ~10-min git-sync tick. git-sync reads this
 * window back by repo_root+file to attribute its per-agent commits (P-003), and the durable
 * git_sync_commit_attribution link (P-004) feeds the doc-drift (P-005) + merge-resolver
 * (P-006) consumers.
 *
 * DETERMINISTIC + best-effort (D-001/D-006): pure server code — NO LLM, NO extra agent tool
 * call (the work-item is read from the claim the agent ALREADY holds). Called fire-and-forget
 * from the locks:acquire grant; ANY failure here is swallowed and must NEVER affect the lock
 * (the hot per-edit path). Mirrors the best-effort raw-SQL pattern of lib/decision-ledger/emit.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getActiveClaimForOwner } from './work-item-claims';
import { getPresence } from './agent-tools/coordination/presence';
import { isLifecycleIntent } from './agent-tools/coordination/presence-payload';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';

export interface RecordEditAttributionInput {
  /** The lock's coordination domain — the physical repo root (the join key). */
  repoRoot: string;
  /** Superproject-relative paths the lock was granted over. */
  files: string[];
  /** The lock holder's stable owner id. */
  agentId: string;
  /** The lock's per-edit intent. */
  intent?: string;
  /** The editing agent's workspace — required to look up its claimed lane. */
  workspaceId?: string;
  /**
   * The caller's queue-time/current goal pointer. When present it is validated
   * against canonical work-item ownership and never replaced with a guessed
   * claim. Absent preserves the legacy claim-store fallback.
   */
  goalRef?: string;
  sessionId?: string;
  contributor?: string;
  /** Dispatcher call id for duplicate-safe server-side edit capture. */
  dispatchCallId?: string;
}

/**
 * Append edit-attribution ledger rows for a just-granted lock. Resolves the holder's
 * exact canonical work-item from a supplied goal pointer, or from the legacy active
 * claim when no pointer exists, then writes one row per file. Never throws.
 */
export async function recordEditAttribution(
  input: RecordEditAttributionInput,
  opts: { strict?: boolean } = {},
): Promise<void> {
  try {
    const files = (input.files ?? []).filter(Boolean);
    if (files.length === 0 || !input.agentId || !input.repoRoot) return;

    const { sql } = getOrgPg();

    // The work-item join, at edit time (D-002). The state stamp disambiguates owners who
    // hold several canonical work-items at once. Validate the exact pointer against the
    // canonical row's workspace, holder, and lifecycle; a stale/foreign/non-item pointer
    // becomes honest NULL and MUST NOT fall through to a different legacy claim. Only
    // callers without a pointer retain the old work_item_claims fallback.
    let harnessSlug: string | null = null;
    let workItemId: string | null = null;
    if (input.workspaceId) {
      const goalRef = input.goalRef?.trim() || null;
      if (goalRef) {
        const rows = await sql<Array<{ harness_slug: string; feature_id: string }>>`
          SELECT harness_slug, feature_id
            FROM harness_shared.work_items
           WHERE workspace_id = ${input.workspaceId}
             AND feature_id = ${goalRef}
             AND taken_by = ${input.agentId}
             AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
           LIMIT 1
        `.catch(() => []);
        const item = rows[0];
        if (item) {
          harnessSlug = item.harness_slug;
          workItemId = item.feature_id;
        }
      } else {
        const claim = await getActiveClaimForOwner(input.workspaceId, input.agentId).catch(() => null);
        if (claim) {
          harnessSlug = claim.harnessSlug ?? null;
          workItemId = claim.workItemId ?? null;
        }
      }
    }

    // WI-6584: plan_slug was UNCONDITIONALLY written as NULL here — the input type didn't
    // even carry a planSlug field, so there was nothing to thread even if a caller wanted to.
    // `work_item_claims` (the join above) has no plan_slug column at all (a work-item claim
    // and a declared plan lane are different things), so the only live source for "which plan
    // is this agent working under, right now" is its own presence row (coord:declare-intent /
    // coord:orient write `current_plan_slug` there — agent-coordination-architecture-v2 §4.2).
    // One more cheap single-row indexed read (by agentId, mirrors the claim lookup above);
    // best-effort like everything else here — absent/stale presence just means an honest
    // unattributed plan_slug, never a guess.
    let planSlug: string | null = null;
    const presence = await getPresence(input.agentId).catch(() => null);
    if (presence?.currentPlanSlug) planSlug = presence.currentPlanSlug;

    // EI-20055604348536487: `intent` must carry what the agent said it was DOING (D-002) — but
    // the automatic per-edit file-lock hook acquires with `intent: f'PreToolUse:{tool_name}'`,
    // and locks:acquire passes that straight through, so 97.5% of this column was the name of
    // the hook rather than any intent (measured 24h/n=3,257: 3,047 'PreToolUse:Edit' + 210
    // 'PreToolUse:Write' vs ~50 real). git-sync renders this field as the COMMIT SUBJECT, so
    // the sentinel was one reader-side filter away from becoming fleet-wide commit messages.
    //
    // The agent's declared coord intent is ALREADY in hand — `presence` is fetched just above
    // for plan_slug (WI-6584) — so recovering the real value costs NO extra query on this
    // per-edit hot path. The lifecycle label moves to `acquired_via` (784) rather than being
    // discarded: it is the only thing the column carried, and "did this edit come through the
    // automatic hook" stays worth knowing.
    //
    // HONEST LIMIT: a declared intent can be STALE (declared at orient, not re-declared since),
    // so this is "what the agent last said it was doing", not proof of this edit's purpose. That
    // is the same freshness the plan_slug above and enrich-busy's `holder_intent` already accept,
    // and it is strictly better than a label that describes no work at all. When neither side has
    // a usable intent we write NULL — an honest unattributed edit (D-003), never a guess.
    const rawIntent = input.intent?.trim() || null;
    const lifecycleLabel = isLifecycleIntent(rawIntent);
    const declaredIntent = presence?.intent?.trim() || null;
    const intent = lifecycleLabel
      ? isLifecycleIntent(declaredIntent)
        ? null
        : declaredIntent
      : rawIntent;
    const acquiredVia = lifecycleLabel ? rawIntent : null;

    // One row per file via unnest — a single round-trip on the hot path.
    await sql`
      INSERT INTO harness_shared.edit_attribution_ledger
        (repo_root, file, agent_id, session_id, contributor, workspace_id,
         harness_slug, work_item_id, plan_slug, intent, acquired_via, dispatch_call_id)
      SELECT ${input.repoRoot}, f, ${input.agentId}, ${input.sessionId ?? null},
             ${input.contributor ?? null}, ${input.workspaceId ?? null},
             ${harnessSlug}, ${workItemId}, ${planSlug}, ${intent}, ${acquiredVia},
             ${input.dispatchCallId ?? null}
        FROM unnest(${files}::text[]) AS f
      ON CONFLICT DO NOTHING
    `;
  } catch (error) {
    // best-effort: edit attribution must NEVER break the lock path — except for the
    // one caller that needs the row to exist (strict, below).
    if (opts.strict) throw error;
  }
}

/**
 * The same write, but it THROWS when the insert fails instead of swallowing it.
 * Plan personal-data-reader-set-labels-2026-10-01 P-014 (WI-10005571): for an owner
 * holding an active personal disclosure, this row is what holds the edited path out
 * of git-sync (personal-vault/git-sync-hold.ts), so locks:release writes it BEFORE
 * releasing and keeps the lock when the write fails. Every other caller stays
 * best-effort.
 */
export async function recordEditAttributionStrict(input: RecordEditAttributionInput): Promise<void> {
  await recordEditAttribution(input, { strict: true });
}

/** One agent's attributed edits in a repo, as git-sync reads them back (P-003). Shaped to
 *  AttributionRosterEntry (git-sync-attribution.ts) — superproject-relative `files`. */
export interface LedgerRosterEntry {
  agent: string;
  files: string[];
  workItems: string[];
  planSlug?: string;
  intent?: string;
  sessionId?: string;
  contributor?: string;
}

interface LedgerRow {
  agent_id: string;
  file: string;
  work_item_id: string | null;
  plan_slug: string | null;
  intent: string | null;
  session_id: string | null;
  contributor: string | null;
}

/**
 * Build git-sync's attribution roster for a repo from the edit ledger (P-003) — the
 * DURABLE source (D-002), so a commit is attributed even after the editing agent's session
 * ended (which live-presence derivation misses). Each file is attributed to its MOST-RECENT
 * editor within `lookbackHours` (DISTINCT ON (file) ORDER BY ts DESC); rows are then grouped
 * by agent. Best-effort: returns [] on any error so the caller falls back to presence.
 *
 * ⚠ SCOPED BY workspace_id, NOT repo_root (WI-37668) — do NOT "restore" a repo_root filter.
 * The ledger's `repo_root` column is written from the LOCK COORDINATION DOMAIN
 * (locks/identity.ts readIdentity → lockCoordinationDomain()), which resolves to the repo root
 * of whichever OPERATOR PROCESS served the locks:acquire call — NOT the repo the edited files
 * live in. This box serves locks from the release checkout while agents edit the staging tree,
 * so rows land under `…/papercup-release` while git-sync syncs `…/papercusp`. The old
 * `WHERE repo_root = <git-sync's root>` therefore matched ZERO rows and made derived
 * attribution silently inert: measured 2026-08-10, 3,379 rows/24h under the serving root vs 0
 * under the sync root (last row under the sync root: 2026-07-17). Fixing this writer-side is
 * not available — locks:acquire receives already-repo-relative paths and carries no
 * harness/project context, so it cannot know the file's true repo root.
 *
 * DISCRIMINATION is workspace scoping PLUS the caller's dirty-file intersection: git-sync
 * partitions the DIRTY set (git-sync-attribution.buildAttributionGroups), so a roster entry for
 * a file that is not dirty in this repo never matches. Residual risk: two repos in ONE workspace
 * sharing a repo-relative path, both dirty, both edited inside the window, could cross-attribute
 * a trailer. Tighten by also scoping on harness_slug once that column is reliably populated — it
 * is NULL on ~99.6% of rows today because it is joined from the agent's active work-item claim.
 */
export async function readEditAttributionRoster(opts: {
  /** The syncing repo's workspace — the join key. Absent ⇒ [] (unscopable, never read globally). */
  workspaceId: string | null | undefined;
  lookbackHours?: number;
}): Promise<LedgerRosterEntry[]> {
  try {
    const { workspaceId, lookbackHours = 24 } = opts;
    if (!workspaceId) return [];
    const { sql } = getOrgPg();
    const rows = await sql<LedgerRow[]>`
      SELECT DISTINCT ON (file)
             agent_id, file, work_item_id, plan_slug, intent, session_id, contributor
        FROM harness_shared.edit_attribution_ledger
       WHERE workspace_id = ${workspaceId}
         AND ts >= now() - make_interval(hours => ${lookbackHours})
       ORDER BY file, ts DESC
    `;
    // One agent can edit different files under different work-items inside the
    // lookback window. Keep those provenance cohorts separate: collapsing only
    // by agent unions an older lane onto newer files and makes git-sync stamp a
    // commit with the wrong Papercusp-Work-Item trailer (EI-21193794700858679).
    const byProvenance = new Map<string, LedgerRosterEntry>();
    for (const r of rows) {
      const key = JSON.stringify([
        r.agent_id,
        r.work_item_id,
        r.plan_slug,
        r.intent,
        r.session_id,
        r.contributor,
      ]);
      let e = byProvenance.get(key);
      if (!e) {
        e = { agent: r.agent_id, files: [], workItems: [] };
        byProvenance.set(key, e);
      }
      if (!e.files.includes(r.file)) e.files.push(r.file);
      if (r.work_item_id && !e.workItems.includes(r.work_item_id)) e.workItems.push(r.work_item_id);
      // Every row in this cohort has identical scalar provenance.
      if (r.plan_slug && !e.planSlug) e.planSlug = r.plan_slug;
      if (r.intent && !e.intent) e.intent = r.intent;
      if (r.session_id && !e.sessionId) e.sessionId = r.session_id;
      if (r.contributor && !e.contributor) e.contributor = r.contributor;
    }
    return [...byProvenance.values()];
  } catch {
    return [];
  }
}

/** The Papercusp provenance a git-sync per-agent commit carries in its trailers (P-004). */
export interface ParsedCommitAttribution {
  agent?: string;
  workItems: string[];
  sessionId?: string;
  planSlug?: string;
}

/**
 * Parse the `Papercusp-Agent|Work-Item|Session|Plan:` trailers a git-sync per-agent commit
 * carries (written in run-git-sync.ts). Pure + testable. The commit↔work-item link travels in
 * git history via these; the post-sync reader (P-004) turns them + the commit's changed files
 * into git_sync_commit_attribution rows for the fast reverse-index the consumers query.
 */
export function parsePapercuspTrailers(commitBody: string): ParsedCommitAttribution {
  const out: ParsedCommitAttribution = { workItems: [] };
  for (const raw of (commitBody ?? '').split('\n')) {
    const m = /^(Papercusp-Agent|Papercusp-Work-Item|Papercusp-Session|Papercusp-Plan):\s*(.+)$/.exec(raw.trim());
    if (!m) continue;
    const val = m[2].trim();
    if (m[1] === 'Papercusp-Agent') out.agent = val;
    else if (m[1] === 'Papercusp-Work-Item') out.workItems = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'Papercusp-Session') out.sessionId = val;
    else if (m[1] === 'Papercusp-Plan') out.planSlug = val;
  }
  return out;
}

/** One git_sync_commit_attribution row — the durable commit→work-item link (P-004). */
export interface CommitAttributionRow {
  workspaceId: string;
  harnessSlug: string;
  /** scope: 'superproject' or a submodule path. */
  repo: string;
  commitSha: string;
  file: string;
  agentId?: string;
  sessionId?: string;
  workItemId?: string;
  planSlug?: string;
}

/**
 * Bulk-insert git_sync_commit_attribution rows (P-004) — one per (file × work-item) for a
 * git-sync commit. DETERMINISTIC + best-effort (D-006): raw SQL, never throws. Powers the
 * doc-drift "which work-item changed this code?" join (P-005) + the merge-resolver authorship
 * context (P-006).
 */
export async function recordCommitAttribution(rows: CommitAttributionRow[]): Promise<void> {
  try {
    if (!rows || rows.length === 0) return;
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.git_sync_commit_attribution
        (workspace_id, harness_slug, repo, commit_sha, file, agent_id, session_id, work_item_id, plan_slug)
      SELECT * FROM unnest(
        ${rows.map((r) => r.workspaceId)}::text[],
        ${rows.map((r) => r.harnessSlug)}::text[],
        ${rows.map((r) => r.repo)}::text[],
        ${rows.map((r) => r.commitSha)}::text[],
        ${rows.map((r) => r.file)}::text[],
        ${rows.map((r) => r.agentId ?? null)}::text[],
        ${rows.map((r) => r.sessionId ?? null)}::text[],
        ${rows.map((r) => r.workItemId ?? null)}::text[],
        ${rows.map((r) => r.planSlug ?? null)}::text[]
      )
    `;
  } catch {
    // best-effort: commit attribution must never affect git-sync.
  }
}

/**
 * P-005 (doc-drift attribution): the work-item(s) that recently changed the given CODE files,
 * read back from git_sync_commit_attribution. The doc-freshness sweep calls this for a drifted
 * doc's anchored files so the doc-steward learns WHY the code changed (D-006: derived, no extra
 * agent tool call). Best-effort — returns a `file → workItemIds` map, empty on any error.
 * `lookbackHours` bounds it (default 14 days — the "what recently shaped this code" window).
 */
export async function lookupDriftCauseWorkItems(
  files: string[],
  opts: { harnessSlug?: string; lookbackHours?: number } = {},
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const uniq = [...new Set((files ?? []).filter(Boolean))];
    if (uniq.length === 0) return out;
    const { sql } = getOrgPg();
    const rows = await sql<{ file: string; work_item_id: string }[]>`
      SELECT DISTINCT file, work_item_id
        FROM harness_shared.git_sync_commit_attribution
       WHERE file = ANY(${uniq})
         AND work_item_id IS NOT NULL
         ${opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``}
         AND ts >= now() - make_interval(hours => ${opts.lookbackHours ?? 24 * 14})
    `;
    for (const r of rows) {
      const arr = out.get(r.file) ?? [];
      if (!arr.includes(r.work_item_id)) arr.push(r.work_item_id);
      out.set(r.file, arr);
    }
    return out;
  } catch {
    return out;
  }
}
