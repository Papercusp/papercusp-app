import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorDetail } from '../ErrorDetail';
import { reportRenderCrash } from '../../lib/render-crash-report';

/**
 * AdvTabErrorBoundary — isolates a render crash in ONE /adv tab body so it can't
 * white-screen the whole operator UI. The shell chrome (AgentsRunningPill, the
 * tab strip, the workspace/harness switcher) lives OUTSIDE this boundary and
 * keeps working, and every OTHER tab stays reachable — only the crashed tab is
 * replaced with a fallback.
 *
 * Why this exists (2026-07-11): a render-time throw in a tab body — e.g. a hook
 * useMemo iterating a query result whose shape changed under it (the /adv Create
 * dock `use-create-data` crash) — had NO boundary, so it propagated to the React
 * root and unmounted the ENTIRE tree. The owner saw a blank /adv and couldn't
 * reach ANY tab (including the agents popup in the shell). A single tab's bug
 * must never take down the whole operator.
 *
 * Reset semantics: keyed by the active tab at the call site (`key={tab}`), so
 * navigating to a different tab remounts + resets the boundary — a crashed tab
 * recovers the moment the user switches away and back (or its data heals).
 */
interface Props {
  children: ReactNode;
  /** The active tab id — shown in the fallback, and used (as `key` at the call
   *  site) to reset the boundary when the user navigates to another tab. */
  tab: string;
}
interface State {
  error: Error | null;
  /** React component stack (componentDidCatch) — names the component that threw. */
  componentStack: string | null;
}

export default class AdvTabErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // The shell survives a caught tab crash, so this console line is the only
    // signal the tab died — surfaced for the read_console_messages debug path.
    console.error(`[adv-tab:${this.props.tab}] render crashed:`, error, info.componentStack);
    reportRenderCrash('adv-tab', error, info.componentStack ?? null, this.props.tab);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="adv-tab-error"
        style={{ padding: 24, maxWidth: 640, margin: '0 auto', color: 'var(--fg)' }}
      >
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>This section hit an error</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)', margin: '0 0 12px' }}>
          The <strong>{this.props.tab}</strong> tab failed to render. The rest of the app is
          unaffected — switch to another tab, or reload once the underlying issue is fixed.
        </p>
        <ErrorDetail error={error} componentStack={this.state.componentStack} />
      </div>
    );
  }
}
