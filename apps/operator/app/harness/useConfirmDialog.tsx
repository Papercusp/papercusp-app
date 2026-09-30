'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ConfirmModal } from './ConfirmModal';

/**
 * useConfirmDialog — hook-based imperative replacement for `window.confirm()`.
 *
 * Preserves the existing `if (!await confirm(...)) return;` control flow
 * pattern, so migrating a confirm()-gated handler is a one-line change at
 * each call site instead of a refactor across state + JSX.
 *
 *   const { confirm, element } = useConfirmDialog();
 *   ...
 *   async function deletePlugin() {
 *     if (!await confirm({
 *       title: `Disable ${plugin.name}?`,
 *       body: 'The plugin config is preserved.',
 *       destructive: true,
 *       confirmLabel: 'Disable',
 *     })) return;
 *     // ... rest of handler unchanged
 *   }
 *
 *   return <>{element}<button onClick={deletePlugin}>…</button></>;
 *
 * **Caveat — the dialog closes as soon as the user clicks Confirm**, even
 * though the post-confirm async work is still running. This matches the
 * native `window.confirm()` behavior (returns immediately on click). If
 * the surrounding UI uses `setBusy(true)` to indicate progress, that still
 * works. If you need the modal to stay open with a "Working…" state until
 * the async work finishes, use the controlled `<ConfirmModal>` directly
 * with its async `onConfirm` prop instead.
 */
export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  requireType?: string;
}

export function useConfirmDialog() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);
  // Captured at open-time so we can restore focus to whichever element
  // the user was on when they triggered the dialog. Radix's built-in
  // focus restoration only works when the dialog is wired via <Trigger>;
  // imperative opens (this hook) bypass that path.
  const triggerRef = useRef<HTMLElement | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // If a prior dialog is still mounted (rapid re-open), resolve it as
      // cancelled before swapping in the new one — never leave a dangling
      // promise.
      if (resolverRef.current) resolverRef.current(false);
      resolverRef.current = resolve;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      triggerRef.current = active instanceof HTMLElement ? active : null;
      setOpts(options);
    });
  }, []);

  const close = useCallback((result: boolean) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setOpts(null);
    r?.(result);
    // Restore focus after Radix's own focus-management has torn down.
    // requestAnimationFrame is enough — Radix uses a microtask cleanup.
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger && typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        if (document.contains(trigger)) trigger.focus({ preventScroll: true });
      });
    }
  }, []);

  const element = opts ? (
    <ConfirmModal
      open
      onOpenChange={(o) => { if (!o) close(false); }}
      title={opts.title}
      body={opts.body}
      confirmLabel={opts.confirmLabel}
      cancelLabel={opts.cancelLabel}
      destructive={opts.destructive}
      requireType={opts.requireType}
      onConfirm={() => close(true)}
    />
  ) : null;

  return { confirm, element };
}
