'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  bootstrapHostedWorkspaceSelection,
  readHostedBrowserApiMarker,
  type HostedWorkspaceSelectionBootstrapResult,
} from '../../lib/hosted-browser-api';

let hostedWorkspaceBootstrap: Promise<HostedWorkspaceSelectionBootstrapResult> | null = null;

function ensureHostedWorkspaceBootstrap(): Promise<HostedWorkspaceSelectionBootstrapResult> {
  hostedWorkspaceBootstrap ??= bootstrapHostedWorkspaceSelection();
  return hostedWorkspaceBootstrap;
}

/** Do not start hosted sync until the authenticated session's workspace is selected. */
export default function HostedWorkspaceSelectionGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => !readHostedBrowserApiMarker());

  useEffect(() => {
    if (ready) return;
    let mounted = true;
    void ensureHostedWorkspaceBootstrap().finally(() => {
      if (mounted) setReady(true);
    });
    return () => { mounted = false; };
  }, [ready]);

  if (!ready) {
    return <div role="status" aria-live="polite">Loading your workspace…</div>;
  }
  return children;
}
