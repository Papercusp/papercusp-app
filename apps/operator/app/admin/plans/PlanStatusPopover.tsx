'use client';

/**
 * P-203 — status-flip menu anchored to a clicked `[data-plan-status]`
 * code element. Six buttons (todo / wip / blocked / needs-human / done /
 * dropped); selection calls `plans:set-status` and closes. Esc / outside
 * click cancels.
 *
 * Anchoring strategy: fixed positioning relative to the clicked
 * element's bounding rect. Lighter than wiring Radix Popover's virtual
 * `<Anchor>` for this single use, and survives vditor re-renders since
 * we recompute the rect on every open.
 *
 * Item-ID resolution: walks up from the clicked code to the parent
 * `<li>` and reads the leading `<strong>` — works in both read mode
 * (where `decoratePlanDom` adds `data-plan-item` to the LI) and edit
 * mode (where IR's leading `<strong>P-NNN</strong>` is the canonical
 * source, no data attribute needed).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
// WI-6941: this file used to carry its own copy of writeError, which checked the
// top-level `ok` first and so reported every FAILED bulk write as a success — the
// worst instance being a `claim_conflict` (a live peer holds the item) rendering as
// a completed status flip. One wire shape, one reader.
import { setItemStatus, writeError } from './plans-api';

export type PlanStatus = 'todo' | 'wip' | 'blocked' | 'needs-human' | 'done' | 'dropped';

const STATUS_ORDER: PlanStatus[] = [
  'todo',
  'wip',
  'blocked',
  'needs-human',
  'done',
  'dropped',
];

export interface PendingStatusFlip {
  target: HTMLElement;
  status: PlanStatus;
  /** Resolved item ID — found by walking from `target` up to the LI. */
  itemId: string;
}

/**
 * Resolves the item ID for a status pill click, or returns null if the
 * pill is not inside a recognizable item.
 */
export function resolveItemId(target: HTMLElement): string | null {
  // Read-mode preview: `decoratePlanDom` stamps `data-plan-item` on the LI.
  const li = target.closest('li');
  if (!li) return null;
  const fromAttr = li.getAttribute('data-plan-item');
  if (fromAttr) return fromAttr;
  // Edit-mode IR: leading `<strong>P-NNN</strong>` carries the ID. Match a
  // P-NNN or D-NNN pattern.
  const strongs = li.querySelectorAll('strong');
  for (const s of Array.from(strongs)) {
    const txt = (s.textContent ?? '').trim();
    if (/^[PD]-\d{3,}$/.test(txt)) return txt;
  }
  return null;
}

interface PopoverProps {
  pending: PendingStatusFlip | null;
  slug: string;
  /** Called after a successful status set — consumer refetches plans:get. */
  onSuccess: () => void;
  onClose: () => void;
}

export default function PlanStatusPopover({
  pending,
  slug,
  onSuccess,
  onClose,
}: PopoverProps) {
  const [busy, setBusy] = useState<PlanStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset busy/err when the pending changes.
  useEffect(() => {
    setBusy(null);
    setErr(null);
  }, [pending]);

  // Esc / outside-click close.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const node = containerRef.current;
      if (!node) return;
      if (e.target instanceof Node && node.contains(e.target)) return;
      if (e.target === pending.target) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [pending, onClose]);

  // Position calc.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!pending) {
      setPos(null);
      return;
    }
    const rect = pending.target.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [pending]);

  if (!pending || !pos) return null;

  return (
    <div
      ref={containerRef}
      className="pc-plan-status-popover"
      role="menu"
      aria-label={`Set status for ${pending.itemId}`}
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 200 }}
    >
      <div className="pc-plan-status-popover__head">
        <span className="pc-plan-status-popover__kicker">{pending.itemId}</span>
        <span className="pc-plan-status-popover__current">
          current: <code className={`pc-plan-status pc-plan-status--${pending.status}`}>{pending.status}</code>
        </span>
      </div>
      <ul className="pc-plan-status-popover__list" role="none">
        {STATUS_ORDER.map((s) => {
          const isCurrent = s === pending.status;
          const isBusy = busy === s;
          return (
            <li key={s} role="none">
              <button
                type="button"
                role="menuitemradio"
                className={`pc-plan-status-popover__btn${isCurrent ? ' is-current' : ''}`}
                disabled={busy !== null}
                aria-checked={isCurrent}
                onClick={async () => {
                  if (isCurrent) {
                    onClose();
                    return;
                  }
                  setBusy(s);
                  setErr(null);
                  try {
                    const res = await setItemStatus({
                      slug,
                      itemId: pending.itemId,
                      status: s,
                    });
                    const e = writeError(res);
                    if (e) {
                      setBusy(null);
                      setErr(e);
                      return;
                    }
                    onSuccess();
                    onClose();
                  } catch (e) {
                    setBusy(null);
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                <code className={`pc-plan-status pc-plan-status--${s}`}>{s}</code>
                {isCurrent ? <span className="pc-plan-status-popover__hint">current</span> : null}
                {isBusy ? <span className="pc-plan-status-popover__hint">…</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {err ? <div className="pc-plan-status-popover__err">{err}</div> : null}
    </div>
  );
}
