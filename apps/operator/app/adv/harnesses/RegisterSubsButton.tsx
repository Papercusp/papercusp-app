'use client';

/**
 * RegisterSubsButton — one-click "register sub-pots". POSTs to
 * `/api/harness/projects/register-subs`, surfaces the discovered +
 * newly-registered count via toast. Idempotent — re-clicking after a
 * `git submodule add` picks up the new one.
 *
 * WHERE it lives (owner ask 2026-07-27): on the POT BAR (AdvPotBar), so it is
 * reachable from every pot-scoped tab and always targets the SELECTED POT. It
 * used to sit on the Work tab's HarnessTopBar, keyed to the drilled-into MEMBER
 * (`dockSlug`) rather than the pot root — which is the wrong scope for a
 * scan-this-repo-for-submodules action. Extracted from HarnessTopBar.tsx (P-019)
 * unchanged apart from that scope fix.
 */

import { useState } from 'react';
import { Network } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';

export default function RegisterSubsButton({ slug }: { slug: string }) {
  const t = useLexicon();
  const [pending, setPending] = useState(false);
  return (
    <Tooltip label={`Scan this ${t('pot')} for git submodules and register them as sub-${t('pot', { plural: true, lower: true })}`}>
    <button
      type="button"
      className="pc-adv-topbar__register-subs"
      onClick={async () => {
        if (pending) return;
        setPending(true);
        try {
          const r = await fetch('/api/harness/projects/register-subs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rootSlug: slug }),
          });
          const data = (await r.json().catch(() => null)) as
            | { ok?: boolean; discovered?: number; membership?: { kind: 'hive_slug' | 'parent_slug'; value: string } | null; registered?: unknown[]; reconciled?: unknown[]; hiveReconciled?: string[]; errors?: Array<{ slug: string; error: string }>; error?: string }
            | null;
          if (!r.ok || !data?.ok) {
            toast.error(`register-subs failed: ${data?.error ?? `HTTP ${r.status}`}`);
            return;
          }
          const newCount = (data.registered ?? []).length;
          const fixedCount = (data.reconciled ?? []).length + (data.hiveReconciled ?? []).length;
          const errCount = (data.errors ?? []).length;
          const hiveNote =
            data.membership?.kind === 'hive_slug' ? ` Members of ${t('pot', { lower: true })} '${data.membership.value}'.` : '';
          const msg = `Discovered ${data.discovered ?? 0} submodules — ${newCount} new, ${fixedCount} reconciled${errCount ? `, ${errCount} errors` : ''}.${hiveNote}`;
          if (errCount > 0) toast.error(msg);
          else if (newCount + fixedCount === 0) toast.success(`No new sub-${t('pot', { plural: true, lower: true })} (registry up-to-date).`, { duration: 2500 });
          else toast.success(msg, { duration: 3000 });
        } catch (e) {
          toast.error(`register-subs failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setPending(false);
        }
      }}
      disabled={pending}
    >
      <Network size={13} aria-hidden />
      {pending ? 'Scanning…' : `Register sub-${t('pot', { plural: true, lower: true })}`}
      <style>{`
        .pc-adv-topbar__register-subs {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 999px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          color: var(--fg, #e7f7ff);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0;
          cursor: pointer;
          flex-shrink: 0;
        }
        .pc-adv-topbar__register-subs:hover:not(:disabled) {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 70%);
        }
        .pc-adv-topbar__register-subs:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>
    </button>
    </Tooltip>
  );
}
