'use client';

/**
 * ProvisionalOwnerExplainer — Phase 8 P-069d.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §15 claim/supersede + addendum-1 binding.
 *
 * Fires the first time an engineer shares a harness publicly. Explains
 * the provisional-ownership semantics: they are the first contributor,
 * which makes them the harness's provisional owner; the binding is
 * recorded immediately but the formal "Cupboard claim" happens once
 * the harness is published. Subsequent shares skip the explainer
 * (localStorage flag per machine).
 *
 * Designed for embedding in any wizard's success step OR as a standalone
 * modal — the consumer controls open/close. Pure UI.
 */

import { useEffect, type ReactNode } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { Button } from '@/app/harness/Button';
import { Modal } from '@/app/harness/Modal';

const FLAG_KEY = 'papercusp.provisionalOwner.shown.v1';

function hasSeenLocally(): boolean {
  try {
    return globalThis.localStorage?.getItem(wsLocalKey(FLAG_KEY)) === '1';
  } catch {
    return false;
  }
}

function markSeenLocally(): void {
  try {
    globalThis.localStorage?.setItem(wsLocalKey(FLAG_KEY), '1');
  } catch {
    // ignore — explainer just re-shows on next share, low harm
  }
}

export interface ProvisionalOwnerExplainerProps {
  open: boolean;
  /** GitHub login of the owner-to-be (typically the current viewer). */
  ownerLogin: string;
  /** Harness slug being shared. */
  harnessSlug: string;
  /** Called when the user dismisses. The dismissal is recorded so the
   * explainer doesn't re-show on the same machine. */
  onClose: () => void;
}

/**
 * Returns true if the explainer should show. Use this to gate
 * the explainer from a parent wizard: only `setOpen(true)` if
 * `shouldShowProvisionalOwnerExplainer()` is true at the moment
 * the wizard hits its share-success step.
 */
export function shouldShowProvisionalOwnerExplainer(): boolean {
  return !hasSeenLocally();
}

export function ProvisionalOwnerExplainer(props: ProvisionalOwnerExplainerProps): ReactNode {
  const { open, ownerLogin, harnessSlug, onClose } = props;

  useEffect(() => {
    if (open) {
      markSeenLocally();
    }
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`You're the provisional owner of ${harnessSlug}`}
      contentStyle={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 24,
        maxWidth: 480,
        width: '90%',
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <div
      data-testid="provisional-owner-explainer"
      >
        <p>
          Because you're the first contributor, you're the harness's{' '}
          <strong>provisional owner</strong>. Your device's pubkey is
          recorded against <code>@{ownerLogin}</code> for <code>{harnessSlug}</code>{' '}
          immediately.
        </p>
        <p style={{ marginTop: 8 }}>
          When you publish to Cupboard, this provisional ownership becomes
          the harness's <strong>formal claim</strong>. If you don't publish,
          another verified maintainer of the same GitHub repo can claim it
          later.
        </p>
        <p style={{ marginTop: 8, color: 'var(--fg-dim)' }}>
          We won't show this again on this machine.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <Button
            size="lg"
            variant="primary"
            onClick={onClose}
            data-testid="provisional-owner-explainer-dismiss"
          >
            Got it
          </Button>
        </div>
      </div>
    </Modal>
  );
}
