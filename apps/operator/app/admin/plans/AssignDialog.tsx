'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * AssignDialog — cross-user handoff / @-mention assign UI
 * (shared-hive-collaboration-2026-06-14 P-008 + P-016).
 *
 * "Assign this plan / item to @user": a Popover-anchored picker over the assignable
 * roster (useAssignableMembers → dev.assignableMembers) — LIVE coordination sessions
 * AND offline admitted hive members — with a filter typeahead + an optional note.
 * Assigning fires a coord:send (assignToUser): a PRESENT member is addressed by their
 * live ownerId (the message lands in their inbox AND re-invokes them now —
 * deliver-and-wake); an OFFLINE member is addressed by `@user:gh:<id>`, which PARKS
 * durably (slot_parked_messages) and is delivered when that member next reads their
 * inbox (P-016 — the gap B8 deferred). The dialog never builds the `@user:` selector
 * itself: the server precomputes each row's `assignAddress`.
 *
 * Open-state is a nuqs param (`assign`) so only one picker is open at a time and the
 * surface is agent-controllable; the in-flight selection/note are local drafts.
 *
 * Reuses: Popover (anchored panel), ownerColor (P-003 per-user color) for the member
 * dot, sonner toast for feedback. No new design-system component.
 */

import { useMemo, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import { AtSign } from 'lucide-react';
import { Popover } from '@/app/harness/Popover';
import { ownerColor } from '@/app/_components/owner-color';
import { useAssignableMembers, assignToUser, type AssignableMember } from './plans-api';

interface AssignDialogProps {
  planSlug: string;
  /** Plan-item id (e.g. 'P-005') when assigning one item; omit/null for the whole plan. */
  itemRef?: string | null;
  /** Compact trigger (icon-only) for dense per-item rows; default false (labeled). */
  compact?: boolean;
}

function memberMatches(m: AssignableMember, needle: string): boolean {
  if (!needle) return true;
  const hay = `${m.label} ${m.key} ${m.intent ?? ''} ${m.githubUsername ?? ''}`.toLowerCase();
  return hay.includes(needle);
}

export default function AssignDialog({ planSlug, itemRef, compact = false }: AssignDialogProps) {
  const myKey = itemRef ? `item:${planSlug}:${itemRef}` : `plan:${planSlug}`;
  const [assign, setAssign] = useQueryState('assign', parseAsString);
  const open = assign === myKey;

  const roster = useAssignableMembers();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const members = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = (roster.data ?? []).filter((m) => m.key && memberMatches(m, needle));
    // Online (present, assignable deliver-and-wake) first, then offline members;
    // alphabetical within each group. Stable.
    return [...all].sort((a, b) => {
      if (a.present !== b.present) return a.present ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [roster.data, filter]);

  const targetLabel = itemRef ? `item ${itemRef}` : 'this plan';

  function close() {
    void setAssign(null);
    setFilter('');
    setSelected(null);
    setNote('');
  }

  async function doAssign() {
    if (!selected || submitting) return;
    setSubmitting(true);
    const picked = members.find((m) => m.key === selected);
    if (!picked) {
      setSubmitting(false);
      return;
    }
    const who = picked.label;
    try {
      const r = await assignToUser({
        to: [picked.assignAddress],
        planSlug,
        itemRef: itemRef ?? null,
        note: note.trim() || null,
      });
      if (r.error) {
        toast.error('Assign failed', { description: r.error });
        return;
      }
      const woken = r.wake?.woken ?? 0;
      const description = !picked.present
        ? "Parked — they'll get it when they're next online."
        : woken > 0
          ? 'Notified + woke them now.'
          : 'Delivered to their inbox.';
      toast.success(`Assigned ${targetLabel} to ${who}`, { description });
      close();
    } catch (e) {
      toast.error('Assign failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => (o ? void setAssign(myKey) : close())}
      trigger={
        <Tooltip label={`Assign ${targetLabel} to @user`}><button
          type="button"
          className={`pc-assign__trigger${compact ? ' is-compact' : ''}`}
          aria-label={`Assign ${targetLabel} to a user`}

        >
          <AtSign size={compact ? 13 : 14} aria-hidden="true" />
          {compact ? null : <span>Assign</span>}
        </button></Tooltip>
      }
      contentClassName="pc-assign__panel"
      ariaLabel={`Assign ${targetLabel} to a user`}
    >
      <div className="pc-assign" role="group" aria-label={`Assign ${targetLabel}`}>
        <div className="pc-assign__head">Assign {targetLabel} to…</div>
        <input
          type="search"
          className="pc-assign__filter"
          placeholder="Filter members…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter roster"
          autoFocus
        />
        <ul className="pc-assign__list" role="listbox" aria-label="Roster">
          {roster.loading && members.length === 0 ? (
            <li className="pc-assign__empty">Loading roster…</li>
          ) : members.length === 0 ? (
            <li className="pc-assign__empty">No members to assign.</li>
          ) : (
            members.slice(0, 50).map((m) => (
              <li key={m.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected === m.key}
                  className={`pc-assign__member${selected === m.key ? ' is-selected' : ''}${m.present ? '' : ' is-offline'}`}
                  onClick={() => setSelected(m.key)}
                >
                  <span
                    className="pc-assign__dot"
                    aria-hidden="true"
                    style={{ background: ownerColor(m.userId ?? m.key) }}
                  />
                  <span className="pc-assign__label">{m.label}</span>
                  {m.present ? (
                    m.intent ? <span className="pc-assign__intent">{m.intent}</span> : null
                  ) : (
                    <span className="pc-assign__offline" title="Not online — will be delivered when they return">
                      offline
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
        <textarea
          className="pc-assign__note"
          placeholder="Optional note for the assignee…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          aria-label="Assignment note"
        />
        <div className="pc-assign__actions">
          <button type="button" className="pc-assign__cancel" onClick={close} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="pc-assign__confirm"
            onClick={doAssign}
            disabled={!selected || submitting}
          >
            {submitting ? 'Assigning…' : 'Assign + notify'}
          </button>
        </div>
      </div>
    </Popover>
  );
}
