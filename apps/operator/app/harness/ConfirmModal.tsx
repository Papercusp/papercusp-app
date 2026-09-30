'use client';

import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';

/**
 * ConfirmModal — the canonical replacement for `window.confirm()`.
 *
 * Use this wrapper instead of inventing a per-site confirm dialog. It owns
 * the cancel/confirm button layout, the destructive styling, the async
 * confirm state, and (optionally) the typed-confirmation token pattern for
 * highly destructive actions ("type DELETE to confirm").
 *
 * Pattern:
 *
 *   const [confirmOpen, setConfirmOpen] = useState(false);
 *   ...
 *   <button onClick={() => setConfirmOpen(true)}>Delete</button>
 *   <ConfirmModal
 *     open={confirmOpen}
 *     onOpenChange={setConfirmOpen}
 *     title="Delete workspace?"
 *     body="This removes every harness and snapshot in this workspace. Cannot be undone."
 *     confirmLabel="Delete workspace"
 *     destructive
 *     onConfirm={async () => { await api.delete(); }}
 *   />
 *
 * `onConfirm` may be async — the confirm button shows a busy state while it
 * runs, and the dialog auto-closes on resolve. If it throws, the dialog
 * stays open and re-enables the buttons (toast the error yourself).
 *
 * For high-stakes destructive actions, pass `requireType="DELETE"` to gate
 * the confirm button behind the user typing that exact string. Use for
 * irreversible operations only.
 *
 * For non-confirm informational popups, use `toast.info()` / `toast.error()`
 * from sonner instead of this component.
 */
export function ConfirmModal({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  requireType,
  onConfirm,
  contentStyle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  requireType?: string;
  onConfirm: () => void | Promise<void>;
  contentStyle?: React.CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');

  const reset = () => {
    setBusy(false);
    setTyped('');
  };
  const close = () => {
    onOpenChange(false);
    reset();
  };

  const armed = !requireType || typed === requireType;

  const handleConfirm = async () => {
    if (!armed || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      close();
    } catch (err) {
      setBusy(false);
      throw err;
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        if (!v) reset();
        onOpenChange(v);
      }}
      title={title}
      srOnlyTitle
      closeOnEscape={!busy}
      closeOnOutsideClick={!busy}
      contentStyle={{
        width: 'min(440px, 92vw)',
        background: 'var(--bg-popover, #0d1829)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
        color: 'var(--fg, #e8e8ea)',
        ...contentStyle,
      }}
    >
      <h2 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>{title}</h2>
      <div style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
        {body}
      </div>
      {requireType ? (
        <label style={{ display: 'block', margin: '0 0 16px', fontSize: 12, color: 'var(--fg-mute)' }}>
          Type <code style={{ background: 'var(--bg-2)', padding: '0 4px', borderRadius: 3 }}>{requireType}</code> to confirm:
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            disabled={busy}
            style={{
              display: 'block',
              width: '100%',
              marginTop: 6,
              padding: '6px 8px',
              background: 'var(--bg-2)',
              border: `1px solid ${typed && !armed ? 'var(--bad)' : 'var(--border)'}`,
              borderRadius: 4,
              color: 'var(--fg)',
              fontFamily: 'inherit',
              fontSize: 13,
            }}
          />
        </label>
      ) : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={close}
          disabled={busy}
          style={ghostBtn(busy)}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={!armed || busy}
          autoFocus={!requireType}
          style={destructive ? destructiveBtn(!armed || busy) : primaryBtn(!armed || busy)}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function ghostBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    fontSize: 13,
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--fg-dim)',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    fontSize: 13,
    background: 'var(--accent)',
    border: '1px solid var(--accent)',
    color: 'var(--accent-ink, #051827)',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontWeight: 600,
  };
}
function destructiveBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    fontSize: 13,
    background: 'var(--bad)',
    border: '1px solid var(--bad)',
    color: '#fff',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontWeight: 600,
  };
}
