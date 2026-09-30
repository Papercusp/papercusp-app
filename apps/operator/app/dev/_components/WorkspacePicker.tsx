'use client';

import { useEffect, useState } from 'react';
import { Checkbox } from '../../harness/Checkbox';

interface Workspace {
  id: string;
  name: string;
}

interface Props {
  selected: string[] | null;
  onChange: (ids: string[] | null) => void;
}

/**
 * Pure transition for the workspace multi-select. `selected === null` means
 * "all workspaces"; otherwise it's the explicit id list. Toggling an id:
 *   - from "all" → switch to everything-except-`id` (so the click deselects it)
 *   - present in the list → remove it (empty result reverts to "all" / null)
 *   - absent → add it
 * Extracted from the component's `toggle` handler so the rules can be pinned
 * without rendering.
 */
export function nextSelection(
  selected: string[] | null,
  allIds: string[],
  id: string,
): string[] | null {
  if (selected === null) {
    return allIds.filter((x) => x !== id);
  }
  const next = selected.includes(id)
    ? selected.filter((x) => x !== id)
    : [...selected, id];
  return next.length === 0 ? null : next;
}

export default function WorkspacePicker({ selected, onChange }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces')
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((d) => {
        if (cancelled) return;
        setWorkspaces(d.workspaces ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allSelected = selected === null;

  function toggle(id: string) {
    onChange(nextSelection(selected, workspaces.map((w) => w.id), id));
  }

  if (loading) return <div className="pc-dev-muted">…</div>;

  return (
    <div className="pc-dev-ws-picker">
      <label className="pc-dev-ws-row">
        <Checkbox
          checked={allSelected}
          onChange={() => onChange(allSelected ? [] : null)}
          ariaLabel="All workspaces"
        />
        <span>All workspaces</span>
      </label>
      {workspaces.map((w) => (
        <label key={w.id} className="pc-dev-ws-row">
          <Checkbox
            checked={allSelected || (selected?.includes(w.id) ?? false)}
            onChange={() => toggle(w.id)}
            ariaLabel={w.name || w.id}
          />
          <span>{w.name || w.id}</span>
        </label>
      ))}
    </div>
  );
}
