'use client';

import { useEffect, useState } from 'react';
import CommandCard, { type CommandSpec } from '../../_components/CommandCard';
import '../../admin-ops.css';

interface CommandsResponse {
  commands: CommandSpec[];
}

// Ordered install→build→test pipeline; the tab renders these in this order.
const WDIO_IDS = [
  'wdio-webkit-driver-check',
  'wdio-install',
  'build-linux-prod',
  'wdio-test',
] as const;

/**
 * Pure: pick the WDIO pipeline commands out of the full command list, in the
 * fixed install→build→test order, dropping any that aren't present. Exported
 * for tests.
 */
export function orderWdioCommands(commands: CommandSpec[]): CommandSpec[] {
  return WDIO_IDS.flatMap((id) => commands.find((c) => c.id === id) ?? []);
}

export default function PackagedBuildTab() {
  const [commands, setCommands] = useState<CommandSpec[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/commands')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: CommandsResponse) => {
        if (cancelled) return;
        setCommands(orderWdioCommands(j.commands));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Packaged build</h1>
          <p className="pc-test-tab-intro">
            WebdriverIO + tauri-driver runner that drives the shipped Tauri binary. The only path
            that catches IPC latency, window-creation cost, and asset-protocol load times in the
            real binary. With the webapp retired, this is the canonical pre-release check.
          </p>
        </div>
      </header>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Pipeline</h2>
        <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '0 0 8px' }}>
          Run top-to-bottom on a fresh checkout. The webkit driver check and wdio install are
          one-time. The Linux prod build takes ~3–5 min. The wdio test boots <code>tauri-driver</code> on
          :4445, drives the binary, injects <code>web-vitals</code>, and reports INP/LCP/CLS.
        </p>
        {error && <div className="pc-ops-error">Failed to load commands: {error}</div>}
        {commands === null && !error && <div className="pc-ops-empty">loading…</div>}
        {commands && (
          <div className="pc-ops-grid">
            {commands.map((c) => <CommandCard key={c.id} spec={c} />)}
          </div>
        )}
      </div>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Manual reference</h2>
        <pre style={{ fontSize: 12, lineHeight: 1.5, background: 'var(--bg-3)', padding: 12, borderRadius: 4, margin: 0 }}>
{`# Linux WebDriver (one-time, requires sudo):
sudo apt install webkit2gtk-driver

# wdio deps (one-time):
cd tools/perf-test/wdio && npm install

# Build + test:
cd papercusp-desktop && npm run build
cd tools/perf-test/wdio && npm run test:all`}
        </pre>
        <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 8 }}>
          See <code>tools/perf-test/wdio/README.md</code> for the full architecture vs. the
          in-process <code>/admin/testing</code> tabs. <code>tauri-driver</code> is already
          installed via cargo.
        </p>
      </div>
    </>
  );
}
