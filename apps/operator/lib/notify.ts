/**
 * Standard helper for showing user-facing toasts.
 *
 * Use this instead of importing `toast` from sonner directly when you
 * want the toast to:
 *
 *  1. Carry an action button (e.g., "Open Config", "Retry") with a
 *     href OR a custom onClick.
 *  2. Have that button persisted in the Notification Center history,
 *     so the user can re-open the destination later from the bell.
 *
 * The recorder (ToastHistoryRecorder) reads the action's label + href
 * out of the rendered toast DOM via a `data-toast-action-href`
 * attribute that this helper injects on the action button. That way no
 * second POST is needed and we keep a single source of truth for
 * recording (the existing MutationObserver pipeline).
 *
 * For non-href actions (pure callback), the callback still fires when
 * the user clicks the button in the live toast, but no actionable
 * button is rendered in the history (because we can't replay arbitrary
 * functions). If you want a re-runnable button in the history, give
 * the action an `href` even for client-side navigation — Next's
 * router intercepts same-origin links automatically.
 */

import { type ReactElement, createElement } from 'react';
import { toast as sonnerToast } from 'sonner';
import { navigateClient } from '@papercusp/operator-core/lib/client-navigation';

export type NotifyLevel = 'message' | 'info' | 'success' | 'warning' | 'error';

export interface NotifyAction {
  label: string;
  /** Same-origin path (e.g. "/harness?ws=default&panel=config") or full
   *  https:// URL. Stored in the notification history so the panel can
   *  re-open the destination later. javascript:/data: schemes are
   *  rejected by the API. */
  href?: string;
  /** Optional extra side-effect to run when the user clicks the button
   *  in the *live* toast. Not persisted (functions aren't serializable),
   *  but if you also pass `href`, that part still works in history. */
  onClick?: () => void;
}

export interface NotifyOptions {
  description?: string;
  duration?: number;
  action?: NotifyAction;
}

export function resolveNotifyActionTarget(
  href: string | undefined,
  currentOrigin?: string,
): {
  kind: 'client' | 'external' | 'none';
  href: string | null;
} {
  if (!href) return { kind: 'none', href: null };
  if (href.startsWith('/')) return { kind: 'client', href };
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'none', href: null };
    const normalizedOrigin = currentOrigin?.endsWith('/') ? currentOrigin.slice(0, -1) : currentOrigin;
    if (normalizedOrigin && url.origin === normalizedOrigin) {
      return { kind: 'client', href: `${url.pathname}${url.search}${url.hash}` };
    }
    return { kind: 'external', href: url.href };
  } catch {
    return { kind: 'none', href: null };
  }
}

export function shouldInvokeNotifyActionCallback(action: Pick<NotifyAction, 'onClick'> | undefined): boolean {
  return typeof action?.onClick === 'function';
}

function buildSonnerAction(action: NotifyAction | undefined) {
  if (!action) return undefined;
  // The `label` is rendered by sonner inside its action `<button>`. By
  // wrapping in a span with `data-toast-action-href`, the recorder can
  // walk the toast DOM, find the attribute, and capture the action
  // label + href without any second POST.
  const labelNode: ReactElement = createElement(
    'span',
    {
      'data-toast-action-label': action.label,
      'data-toast-action-href': action.href ?? '',
    },
    action.label,
  );
  return {
    label: labelNode,
    onClick: () => {
      const target = resolveNotifyActionTarget(action.href, window.location.origin);
      if (target.kind === 'client' && target.href) {
        navigateClient(target.href);
      } else if (target.kind === 'external' && target.href) {
        window.open(target.href, '_blank', 'noopener,noreferrer');
      }
      if (shouldInvokeNotifyActionCallback(action)) action.onClick?.();
    },
  };
}

function call(level: NotifyLevel, message: string, opts: NotifyOptions = {}) {
  const { description, duration, action } = opts;
  const sonnerOpts: Parameters<typeof sonnerToast.message>[1] = {
    description,
    duration,
    action: buildSonnerAction(action),
  };
  switch (level) {
    case 'error':   return sonnerToast.error(message, sonnerOpts);
    case 'warning': return sonnerToast.warning(message, sonnerOpts);
    case 'success': return sonnerToast.success(message, sonnerOpts);
    case 'info':    return sonnerToast.info(message, sonnerOpts);
    case 'message': return sonnerToast.message(message, sonnerOpts);
  }
}

export const notify = {
  message: (msg: string, opts?: NotifyOptions) => call('message', msg, opts),
  info:    (msg: string, opts?: NotifyOptions) => call('info', msg, opts),
  success: (msg: string, opts?: NotifyOptions) => call('success', msg, opts),
  warning: (msg: string, opts?: NotifyOptions) => call('warning', msg, opts),
  error:   (msg: string, opts?: NotifyOptions) => call('error', msg, opts),
};
