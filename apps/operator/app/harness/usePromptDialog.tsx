'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { PromptModal } from './PromptModal';

/**
 * usePromptDialog — imperative replacement for `window.prompt()`.
 * Parallel to `useConfirmDialog` but resolves to the typed string
 * (or null on cancel).
 *
 *   const { prompt, element } = usePromptDialog();
 *   ...
 *   async function rename() {
 *     const name = await prompt({
 *       title: 'Rename workspace',
 *       label: 'New name',
 *       defaultValue: current,
 *       validate: (v) => v.length > 64 ? 'Max 64 chars' : null,
 *     });
 *     if (!name) return;
 *     await save(name);
 *   }
 *
 *   return <>{element}<button onClick={rename}>…</button></>;
 *
 * Same caveat as useConfirmDialog: the dialog closes on submit click; the
 * post-submit async work runs without further dialog feedback. If you need
 * "Working…" state, use `<PromptModal>` directly with its async `onSubmit`.
 */
export interface PromptOptions {
  title: string;
  label: string;
  body?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  allowEmpty?: boolean;
  validate?: (value: string) => string | null;
}

export function usePromptDialog() {
  const [opts, setOpts] = useState<PromptOptions | null>(null);
  const resolverRef = useRef<((v: string | null) => void) | null>(null);
  // Captured at open-time to restore focus after close. Radix's own
  // focus-restoration only fires when the dialog is wired via <Trigger>.
  const triggerRef = useRef<HTMLElement | null>(null);

  const prompt = useCallback((options: PromptOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      if (resolverRef.current) resolverRef.current(null);
      resolverRef.current = resolve;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      triggerRef.current = active instanceof HTMLElement ? active : null;
      setOpts(options);
    });
  }, []);

  const close = useCallback((result: string | null) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setOpts(null);
    r?.(result);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger && typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        if (document.contains(trigger)) trigger.focus({ preventScroll: true });
      });
    }
  }, []);

  const element = opts ? (
    <PromptModal
      open
      onOpenChange={(o) => { if (!o) close(null); }}
      title={opts.title}
      label={opts.label}
      body={opts.body}
      defaultValue={opts.defaultValue}
      placeholder={opts.placeholder}
      submitLabel={opts.submitLabel}
      cancelLabel={opts.cancelLabel}
      allowEmpty={opts.allowEmpty}
      validate={opts.validate}
      onSubmit={(v) => close(v)}
    />
  ) : null;

  return { prompt, element };
}
