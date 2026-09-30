import { useEffect, useMemo, useState } from 'react';
import { Bot, X } from 'lucide-react';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';
import ChatPanel from '@/app/harness/ChatPanel';
import { Modal } from '@/app/harness/Modal';

const COMPOSER_CONTEXT_MAX_CHARS = 3_500;

export function buildWorkflowComposerContext(input: {
  harnessSlug: string;
  sources: ExternalTriggerAdminSnapshot['sources'];
  intent: string;
}): string {
  const encoded = JSON.stringify({
    surface: 'workflows-composer',
    harness: input.harnessSlug,
    intent: input.intent || null,
    sources: input.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      status: source.status,
      bindingCount: source.bindingCount,
      armedBindingCount: source.armedBindingCount,
    })),
    contract: {
      structuralChanges: 'agent-mediated',
      useCanonicalPlanAndTriggerTools: true,
      autoArm: false,
      operatorReviewsAndArmsDirectly: true,
    },
  });
  return encoded.length <= COMPOSER_CONTEXT_MAX_CHARS
    ? encoded
    : `${encoded.slice(0, COMPOSER_CONTEXT_MAX_CHARS - 1)}…`;
}

function initialComposerMessage(intent: string): string | undefined {
  const prompt = intent.trim();
  if (!prompt) return undefined;
  return [
    `Create a workflow for this intent: ${prompt}`,
    'Use the canonical plan and trigger tools after re-reading the connected sources and harness named in the UI context.',
    'Persist the plan and binding as a reviewable draft, but do not arm any schedule or external binding. Report the canonical plan and binding ids plus anything still needed before I review and arm it directly.',
  ].join('\n\n');
}

export default function WorkflowComposerDialog({
  harnessSlug,
  sources,
  intent,
  onClose,
  onAdvancedSetup,
}: {
  harnessSlug: string | null;
  sources: ExternalTriggerAdminSnapshot['sources'];
  intent: string;
  onClose: () => void;
  onAdvancedSetup: () => void;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const context = useMemo(
    () => harnessSlug ? buildWorkflowComposerContext({ harnessSlug, sources, intent }) : '',
    [harnessSlug, intent, sources],
  );

  useEffect(() => {
    if (!harnessSlug) return;
    let cancelled = false;
    fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker', title: 'Workflow composer' }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { id?: unknown; error?: string; detail?: string };
        if (!response.ok || typeof body.id !== 'string') {
          throw new Error(body.detail ?? body.error ?? `HTTP ${response.status}`);
        }
        return body.id;
      })
      .then((id) => { if (!cancelled) setChatId(id); })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [harnessSlug]);

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Compose a workflow with the agent"
      description="Describe the outcome; the agent creates the plan and trigger wiring as a disarmed draft for review."
      srOnlyTitle
      contentClassName="pc-workflows-create"
      contentStyle={{ width: 'min(960px, calc(100vw - 32px))' }}
    >
      <header className="pc-workflows-create__head">
        <div>
          <div className="pc-workflows-create__eyebrow">Workflow agent</div>
          <h2><Bot size={20} aria-hidden /> Compose a workflow</h2>
          <p>The agent builds the plan and trigger wiring. Nothing is armed until you review it and use the direct arm control.</p>
        </div>
        <button type="button" aria-label="Close workflow composer" onClick={onClose}>
          <span className="pc-workflows-create__close-inner"><X size={18} aria-hidden /></span>
        </button>
      </header>

      <div className="pc-workflows-create__body">
        {!harnessSlug ? (
          <p className="pc-workflows__notice" role="alert">
            Choose a harness before composing a workflow so the agent has a canonical plan scope.
          </p>
        ) : error ? (
          <p className="pc-workflows__notice" role="alert">Could not start the workflow agent: {error}</p>
        ) : !chatId ? (
          <p className="pc-workflows__notice" role="status">Starting the workflow agent…</p>
        ) : (
          <div style={{ minHeight: 480, height: 'min(62vh, 640px)' }}>
            <ChatPanel
              slug={harnessSlug}
              chatId={chatId}
              initialMessage={initialComposerMessage(intent)}
              context={context}
            />
          </div>
        )}
      </div>

      <footer className="pc-workflows-create__foot">
        <span>The manual structural form is retained only for low-level administration.</span>
        <button type="button" onClick={onAdvancedSetup}>Advanced manual setup</button>
      </footer>
    </Modal>
  );
}
