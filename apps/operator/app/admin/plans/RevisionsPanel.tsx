'use client';

/**
 * Revisions panel — `plan_revisions`-backed (plan-agent-launch P-017).
 *
 * The successor to GitHistoryStrip: a compact list of the revisions
 * recorded by the `plans:*` write verbs (the spine D-003 defines),
 * newest-first. Each row carries the actual *why* (the inline
 * `rationale`) plus author / when / `+N −N` diff-stat. Git history
 * stays as a coarse backup data source — `plans:history`/`plans:diff`
 * still exist on the backend — but is not displayed here.
 *
 * P-017 is just the rows. Per-revision diff modals (sourced from the
 * snapshot pair) are P-018; the "open conversation" drill-down keyed
 * on `session_id` is P-019.
 */

import { parseAsBoolean, parseAsInteger, useQueryState } from 'nuqs';
import { usePlanRevisions, type PlanRevision } from './plans-api';
import { rowSessionTag } from './RevisionConversationModal';

interface Props {
  slug: string;
}

const COLLAPSED_COUNT = 5;

export default function RevisionsPanel({ slug }: Props) {
  const { data, loading, error, refresh } = usePlanRevisions(slug);
  const [expanded, setExpanded] = useQueryState(
    'revOpen',
    parseAsBoolean.withDefault(false),
  );
  // P-018: revision currently shown in the diff modal. `?rev=<id>`,
  // null when closed. URL-backed so a diff link is shareable.
  const [openRev, setOpenRev] = useQueryState('rev', parseAsInteger);
  // P-019: revision whose conversation is open. `?convo=<id>`, null
  // when closed. Separate key from `?rev=` so a user can deep-link
  // to either a diff or its conversation independently.
  const [openConvo, setOpenConvo] = useQueryState('convo', parseAsInteger);

  const revisions = data ?? [];
  const visible = expanded ? revisions : revisions.slice(0, COLLAPSED_COUNT);

  if (error) {
    return (
      <div className="pc-revisions-panel pc-revisions-panel--error">
        <span>Revisions: {error}</span>
        <button
          type="button"
          className="pc-revisions-panel__retry"
          onClick={refresh}
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading && revisions.length === 0) {
    return (
      <div className="pc-revisions-panel pc-revisions-panel--loading">
        Loading revisions…
      </div>
    );
  }

  if (revisions.length === 0) {
    return (
      <div className="pc-revisions-panel pc-revisions-panel--empty">
        No revisions for this plan yet.
      </div>
    );
  }

  return (
    <div className="pc-revisions-panel" aria-label="Revisions">
      <header className="pc-revisions-panel__head">
        <span className="pc-revisions-panel__kicker">Revisions</span>
        <span className="pc-revisions-panel__count">{revisions.length}</span>
        {revisions.length > COLLAPSED_COUNT ? (
          <button
            type="button"
            className="pc-revisions-panel__toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? `Show last ${COLLAPSED_COUNT}`
              : `Show all ${revisions.length}`}
          </button>
        ) : null}
      </header>
      <ul className="pc-revisions-panel__list">
        {visible.map((r) => (
          <RevisionRow
            key={r.id}
            revision={r}
            onOpenDiff={() => setOpenRev(r.id)}
            onOpenConvo={() => setOpenConvo(r.id)}
          />
        ))}
      </ul>
      {/* P-020: the diff + convo modals are rendered at PlanDetail
       *  level so a deep link `?tab=editor&rev=42` still shows them
       *  even when this panel isn't mounted. The setters here drive
       *  the same nuqs keys; the modals just consume those keys. */}
    </div>
  );
}

function RevisionRow({
  revision,
  onOpenDiff,
  onOpenConvo,
}: {
  revision: PlanRevision;
  onOpenDiff: () => void;
  onOpenConvo: () => void;
}) {
  const tag = rowSessionTag(revision.sessionId, revision.sessionKind);
  const drillable = tag === null;
  return (
    <li
      className="pc-revision-row"
      data-session-kind={revision.sessionKind ?? 'none'}
      data-author-kind={revision.authorKind}
    >
      <button
        type="button"
        className="pc-revision-row__head pc-revision-row__head--button"
        onClick={onOpenDiff}
        aria-label={`Show diff for revision #${revision.seq}`}
      >
        <span className="pc-revision-row__seq" title={`Revision #${revision.seq}`}>
          #{revision.seq}
        </span>
        <span
          className="pc-revision-row__author"
          title={revision.authorId}
        >
          {formatAuthor(revision)}
        </span>
        <span className="pc-revision-row__when">
          {formatTimestamp(revision.createdAt)}
        </span>
        <span className="pc-revision-row__stat" aria-label="Lines changed">
          <span className="pc-revision-row__stat--add">+{revision.diffStat.added}</span>
          <span className="pc-revision-row__stat--del">
            −{revision.diffStat.removed}
          </span>
        </span>
      </button>
      <div className="pc-revision-row__rationale">
        {formatRationale(revision)}
      </div>
      <div className="pc-revision-row__convo">
        {drillable ? (
          <button
            type="button"
            className="pc-revision-row__convo-btn"
            onClick={onOpenConvo}
            aria-label={`Open conversation behind revision #${revision.seq}`}
          >
            Open conversation
          </button>
        ) : (
          <span className="pc-revision-row__convo-tag" title={tag ?? undefined}>
            {tag}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Display label for a revision's author — kind + a short identity
 * suffix. Pure; the full id is exposed via the title attribute.
 */
export function formatAuthor(revision: PlanRevision): string {
  const id = revision.authorId.trim();
  if (revision.authorKind === 'human') {
    // Email-shaped ids: keep the local part; everything else: short prefix.
    const at = id.indexOf('@');
    return at > 0 ? id.slice(0, at) : id.slice(0, 24);
  }
  // Agent ids tend to look like `pus-abcdefab-cdef-...` — show the first
  // two dash-separated chunks so the row stays scannable.
  const parts = id.split('-');
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : id.slice(0, 16);
}

/**
 * Display the rationale inline, with a typed placeholder when absent
 * (the kind of write determines what "no rationale" means). Pure.
 */
export function formatRationale(revision: PlanRevision): React.ReactNode {
  if (revision.rationale && revision.rationale.trim().length > 0) {
    return revision.rationale;
  }
  const placeholder =
    revision.sessionKind === 'git_backfill'
      ? '(no commit message)'
      : revision.sessionKind === 'plan_run'
        ? '(no rationale — summarisable via plans:summarize-revision)'
        : '(direct edit — no rationale)';
  return (
    <span className="pc-revision-row__rationale--muted">{placeholder}</span>
  );
}

/**
 * Render a millisecond timestamp as a compact label: HH:MM today,
 * "Mon 7" within a year, "Mar '25" beyond. Pure.
 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const ageMs = Date.now() - ms;
  const day = 86_400_000;
  if (ageMs < day) {
    return `${d.getHours().toString().padStart(2, '0')}:${d
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
  }
  if (ageMs < day * 365) {
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short' });
}
