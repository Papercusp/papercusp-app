import { Component, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectHistoryView } from '@papercusp/ui-primitives';
import type { ProjectHistoryDocument } from '@papercusp/plan-parser/project-history';
import './release-project-history.css';

const host = document.getElementById('release-project-history');
const fallback = document.getElementById('release-history-fallback');

function unavailable() {
  if (fallback) fallback.hidden = false;
  return <p role="alert">Interactive history is unavailable. The release details below are still available.</p>;
}

class HistoryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? unavailable() : this.props.children; }
}

function History({ history }: { history: ProjectHistoryDocument }) {
  useEffect(() => { if (fallback) fallback.hidden = true; }, []);
  const params = new URLSearchParams(window.location.search);
  return <ProjectHistoryView
    plans={history.plans.map((plan) => ({ ...plan, project: history.project, snapshot: history.source }))}
    initialDocument={params.get('document')}
    initialWorkItem={params.get('work-item')}
    initialTarget={params.get('plan') ? { plan: params.get('plan')!, item: params.get('item') } : null}
    documentAssetBaseUrl="../assets/vditor"
  />;
}

if (host?.dataset.document) {
  const root = createRoot(host);
  fetch(host.dataset.document)
    .then(async (response) => {
      if (!response.ok) throw new Error(`History HTTP ${response.status}`);
      const history = await response.json() as ProjectHistoryDocument;
      if (history.schemaVersion !== 2 || !Array.isArray(history.plans) ||
          history.source?.planCount !== history.plans.length || history.project?.id !== 'papercusp') {
        throw new Error('Unsupported release history document');
      }
      root.render(<HistoryBoundary><History history={history} /></HistoryBoundary>);
    })
    .catch(() => root.render(unavailable()));
}
