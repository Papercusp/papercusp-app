'use client';

import Link from '@/lib/router-compat/link';
import { usePathname } from '@/lib/router-compat/navigation';
import * as Tabs from '@radix-ui/react-tabs';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';

/**
 * Admin section shell — route-backed admin tabs wrapped in the shared Radix
 * Tabs primitive so the chrome matches the rest of the design system.
 */
const BASE_TABS = [
  { href: "/admin/run", label: "Run" },
  { href: "/admin/features", label: "Features" },
  { href: "/admin/admission", label: "Admission" },
  // WI-2145092: the workspace work-scope policy (which harnesses agents may work).
  { href: "/admin/work-scope", label: "Work scope" },
  { href: "/admin/dbos", label: "DBOS" },
] as const;

export default function AdminShell({
  title = 'Admin',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const triggersEnabled = useFlag(FLAGS.TRIGGERS_ADMIN);
  const pathname = usePathname() || '/admin/run';
  const tabs = triggersEnabled
    ? [
        BASE_TABS[0],
        BASE_TABS[1],
        BASE_TABS[2],
        BASE_TABS[3],
        { href: "/admin/triggers", label: "Triggers" },
        BASE_TABS[4],
      ]
    : [...BASE_TABS];
  const activeTab = tabs.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`)) ?? tabs[0];

  return (
    <div className="pc-adminshell">
      <header className="pc-adminshell__header">
        <div className="pc-adminshell__copy">
          <span className="pc-adminshell__kicker">Admin console</span>
          <h1>{title}</h1>
        </div>
        <Tabs.Root value={activeTab.href} className="pc-adminshell__tabs">
          <Tabs.List className="pc-adminshell__tablist" aria-label="Admin sections">
            {tabs.map((t) => (
              <Tabs.Trigger key={t.href} value={t.href} asChild className="pc-adminshell__tab">
                <Link href={t.href}>{t.label}</Link>
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
        <span className="pc-adminshell__spacer" />
        <span className="pc-adminshell__host">localhost · :3055</span>
      </header>
      <div className="pc-adminshell__body">{children}</div>
      <style>{`
        .pc-adminshell {
          display: flex;
          flex-direction: column;
          min-height: calc(100vh - 56px);
          background:
            radial-gradient(circle at top left, color-mix(in srgb, var(--accent), transparent 94%), transparent 28%),
            linear-gradient(180deg, color-mix(in srgb, var(--bg-deep), transparent 1%), color-mix(in srgb, var(--bg-deeper), transparent 0%));
        }
        .pc-adminshell__header {
          display: flex;
          align-items: flex-end;
          gap: 16px;
          padding: 14px 18px 12px;
          border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
          background:
            linear-gradient(180deg, color-mix(in srgb, var(--bg), transparent 2%), color-mix(in srgb, var(--bg-deep), transparent 2%));
          box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.02);
        }
        .pc-adminshell__copy {
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .pc-adminshell__kicker {
          color: color-mix(in srgb, var(--accent-soft), transparent 36%);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-adminshell__header h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 760;
          line-height: 1;
          letter-spacing: 0;
          color: #f4fbff;
        }
        .pc-adminshell__tabs {
          align-self: stretch;
          display: flex;
          align-items: flex-end;
        }
        .pc-adminshell__tablist {
          display: inline-flex;
          align-items: flex-end;
          gap: 6px;
          padding: 0 0 1px;
        }
        .pc-adminshell__tab {
          display: inline-flex;
          align-items: center;
          min-height: 34px;
          padding: 0 12px;
          border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
          border-bottom-color: color-mix(in srgb, var(--accent-strong), transparent 92%);
          border-radius: 10px 10px 0 0;
          background: rgba(255, 255, 255, 0.02);
          color: rgba(214, 236, 248, 0.72);
          font-size: 12px;
          font-weight: 650;
          letter-spacing: 0;
          text-decoration: none !important;
          transition: background-color 120ms, border-color 120ms, color 120ms, transform 120ms;
        }
        .pc-adminshell__tab:hover {
          color: #eff8ff;
          background: color-mix(in srgb, var(--bg-popover), transparent 4%);
          border-color: color-mix(in srgb, var(--accent-strong), transparent 72%);
          text-decoration: none !important;
        }
        .pc-adminshell__tab[aria-selected="true"] {
          color: #f7fdff;
          background:
            linear-gradient(180deg, color-mix(in srgb, var(--bg-raised), transparent 2%), color-mix(in srgb, var(--bg-1), transparent 1%));
          border-color: rgba(103, 232, 249, 0.38);
          border-bottom-color: color-mix(in srgb, var(--bg), transparent 2%);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
          transform: translateY(1px);
        }
        .pc-adminshell__tab:focus-visible {
          outline: 2px solid rgba(103, 232, 249, 0.58);
          outline-offset: 2px;
        }
        .pc-adminshell__spacer { flex: 1; }
        .pc-adminshell__host {
          align-self: center;
          padding: 5px 10px;
          border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 88%);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.025);
          color: color-mix(in srgb, var(--accent-soft), transparent 32%);
          font-size: 11px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .pc-adminshell__body {
          flex: 1;
          min-height: 0;
          overflow: auto;
        }
      `}</style>
    </div>
  );
}
