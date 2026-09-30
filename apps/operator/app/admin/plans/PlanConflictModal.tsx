'use client';

/**
 * PlanConflictModal — the compare-and-swap stale-recovery surface
 * (P-301, D-011).
 *
 * `plans:set-content` rejects a save when the file changed on disk
 * since the editor loaded it (`expectedHash` mismatch). Rather than
 * silently clobber the concurrent change, the UI shows the on-disk
 * version and lets the human choose:
 *
 *   - Discard & reload — drop the local draft, reload the disk version.
 *   - Keep my draft    — stay in Edit mode with the unsaved draft. A
 *                        re-save will stale again until the user
 *                        reloads; this is a deliberate dead-end the
 *                        user chooses with the diff in front of them.
 *
 * A force-overwrite path is intentionally not offered in v1 — it needs
 * the stale response to carry `currentHash` so the re-save can CAS
 * against it; that refinement is requested of agent-plan-tracking
 * Phase 5 (D-011) and the path lands when the field does.
 */

import { Modal } from '@/app/harness/Modal';

interface Props {
  open: boolean;
  currentContent: string;
  onReload: () => void;
  onKeepEditing: () => void;
}

export default function PlanConflictModal({
  open,
  currentContent,
  onReload,
  onKeepEditing,
}: Props) {
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onKeepEditing()}
      title="Plan changed on disk"
      srOnlyTitle
      contentClassName="pc-conflict"
    >
      <div className="pc-conflict__body">
        <header className="pc-conflict__head">
          <h3>Plan changed on disk</h3>
          <p>
            Another agent or shell modified this plan since you started
            editing. The save was rejected so the concurrent change
            isn&apos;t silently overwritten (compare-and-swap, D-011).
          </p>
        </header>
        <span className="pc-conflict__label">Current version on disk</span>
        <pre className="pc-conflict__current">{currentContent}</pre>
        <footer className="pc-conflict__foot">
          <button type="button" className="pc-conflict__btn" onClick={onKeepEditing}>
            Keep my draft open
          </button>
          <button
            type="button"
            className="pc-conflict__btn pc-conflict__btn--primary"
            onClick={onReload}
          >
            Discard my edits &amp; reload
          </button>
        </footer>
      </div>
    </Modal>
  );
}
