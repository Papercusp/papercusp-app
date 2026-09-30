'use client';

/**
 * LocalCardHost — host component for `askUserLocal` calls.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md §4.4 (M6 boundary)
 *
 * `askUserLocal` (in lib/chat-cards/ask-user-local.ts) is the
 * client-side companion to server-side `ctx.askUser`. Every mounted host
 * subscribes to the SAME shared queue; a HOST ELECTION picks exactly one
 * of them (the most-recently-mounted) to actually render the head card
 * (EI-19952165837170400 — previously each host kept its own independently
 * fed queue, so a card rendered in every mounted host at once and
 * resolving one left the rest orphaned and still answerable).
 *
 * Mount LocalCardHost anywhere a card-rendering slot makes sense (the
 * operator chat sidebar mounts it once; an open session popup mounts a
 * second instance). Without a mounted host, every askUserLocal call
 * immediately resolves `{action:'cancel'}`. With more than one mounted,
 * only the most-recently-mounted renders — closing it promotes the
 * next-most-recently-mounted host, so a still-pending card surfaces there.
 *
 * Renderer reuse: same AskChoiceCard / InputCard dispatch as
 * PendingCardsBar (the server-side state-channel consumer), so cards
 * look identical regardless of which path emitted them.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  AskChoiceCard,
  type AskChoiceArgs,
  type AskChoiceResponse,
} from './AskChoiceCard';
import { InputCard, type InputCardResponse } from './InputCard';
import {
  isActiveLocalCardHost,
  registerLocalCardHost,
  subscribeAskUserLocal,
  type OpenLocalCard,
} from '@/lib/chat-cards/ask-user-local';
import { Select, type SelectOption } from '@/app/harness/Select';
import type { CardPresentation } from '@papercusp/agent-mcp';
import type { ReportBlock } from '@papercusp/chat-protocol';

interface SchemaWithPresentation {
  presentation?: CardPresentation;
  prompt?: string;
  fallbackText?: string;
  allowDecline?: boolean;
  report?: ReportBlock;
}

export function LocalCardHost(): ReactNode {
  // Stable per-mount identity for the host election (EI-19952165837170400).
  const hostIdRef = useRef<string | null>(null);
  if (hostIdRef.current === null) {
    hostIdRef.current = crypto.randomUUID();
  }
  const hostId = hostIdRef.current;

  const [queue, setQueue] = useState<readonly OpenLocalCard[]>([]);

  // Mirror the SHARED queue — every host sees the same state, so resolving
  // in one host is instantly reflected in every other mounted host too.
  useEffect(() => subscribeAskUserLocal(setQueue), []);

  // Register in the host election. Registering/unregistering re-notifies
  // every queue subscriber (including this one), which is what makes a
  // newly-mounted host immediately supersede an already-mounted one, and
  // an unmounting active host promote whichever mounted host is next.
  useEffect(() => registerLocalCardHost(hostId), [hostId]);

  if (queue.length === 0) return null;
  if (!isActiveLocalCardHost(hostId)) return null;
  const head = queue[0];
  const remaining = queue.length - 1;

  // The spec is CardSpec<T>; we read presentation/prompt/fallbackText/
  // allowDecline off it the same way PendingCardsBar reads them off
  // OpenCardWithRun. Fields are optional — fall back to fallbackText
  // when no presentation is set.
  const spec = head.spec as SchemaWithPresentation;
  const prompt = spec.prompt ?? '';
  const presentation = spec.presentation;
  const fallbackText = spec.fallbackText;
  const allowDecline = spec.allowDecline ?? true;

  // No local setQueue here: head.resolve() mutates the SHARED queue and
  // broadcasts it (ask-user-local.ts), which flows back to this (and every
  // other mounted) host through the subscribeAskUserLocal effect above.
  const resolveHead = (response: ReturnType<typeof inputToCardResponse>): void => {
    head.resolve(response);
  };

  let body: ReactNode;
  if (presentation && (presentation.kind === 'radio' || presentation.kind === 'checkbox')) {
    const args: AskChoiceArgs = {
      question: prompt,
      options: presentation.options.map((o) => ({
        id: o.id,
        label: o.label,
        hint: o.hint,
        style: o.style,
      })),
      multi: presentation.kind === 'checkbox',
      report: spec.report,
    };
    const onChoice = (r: AskChoiceResponse): void => {
      if (r.action === 'submit') {
        // Match the same payload shape used by PendingCardsBar for
        // server-side cards. Local consumers parse this directly.
        resolveHead({
          action: 'submit',
          payload: { picks: r.picks.map((p) => p.option_id) },
        });
      } else if (r.action === 'decline') {
        resolveHead({ action: 'decline', reason: r.reason });
      } else {
        resolveHead({ action: 'cancel' });
      }
    };
    body = (
      <AskChoiceCard args={args} onResponse={onChoice} allowDecline={allowDecline} />
    );
  } else if (presentation && presentation.kind === 'select') {
    // WI-6552 [owner 2026-07-27]: the COMPACT single-choice branch. Same
    // answer shape as 'radio' ({ picks: [id] }) so no consumer changes — the
    // only difference is that the option set lives behind a dropdown instead
    // of one full-width row each, which is what let the rubric picker eat the
    // entire chat popup. Uses the existing Radix-backed design-system Select
    // rather than a hand-rolled menu.
    const selectOptions: SelectOption[] = presentation.options.map((o) => ({
      value: o.id,
      label: o.hint ? `${o.label} — ${o.hint}` : o.label,
    }));
    body = (
      <div className="local-card-host-select" role="group" aria-label={prompt || 'Choose an option'}>
        {prompt ? <p className="local-card-host-select-prompt">{prompt}</p> : null}
        <div className="local-card-host-select-row">
          <Select
            value=""
            onChange={(id) => resolveHead({ action: 'submit', payload: { picks: [id] } })}
            options={selectOptions}
            placeholder={presentation.placeholder ?? 'Choose…'}
            ariaLabel={prompt || presentation.placeholder || 'Choose an option'}
            testId="local-card-select"
          />
          {allowDecline ? (
            <button
              type="button"
              className="local-card-host-select-cancel"
              onClick={() => resolveHead({ action: 'cancel' })}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    );
  } else if (
    presentation &&
    (presentation.kind === 'text' || presentation.kind === 'date' || presentation.kind === 'slider')
  ) {
    const onInput = (r: InputCardResponse): void => {
      if (r.action === 'submit') {
        resolveHead({ action: 'submit', payload: { value: r.value } });
      } else {
        resolveHead({ action: 'decline', reason: r.reason });
      }
    };
    body = (
      <InputCard
        prompt={prompt}
        presentation={presentation}
        fallbackText={fallbackText}
        allowDecline={allowDecline}
        onResponse={onInput}
      />
    );
  } else {
    body = (
      <div className="local-card-host-fallback" role="status">
        <p>{prompt || fallbackText || 'No renderer available'}</p>
        <button
          type="button"
          onClick={() => resolveHead({ action: 'cancel' })}
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="local-card-host" data-remaining={remaining}>
      {body}
      {remaining > 0 && (
        <p className="local-card-host-queue" aria-live="polite">
          {remaining} more {remaining === 1 ? 'card' : 'cards'} after this
        </p>
      )}
    </div>
  );
}

// Helper so the response type is enforceable without exporting
// CardResponse from a client module (avoids a Zod runtime import here).
function inputToCardResponse<P>(r:
  | { action: 'submit'; payload: P }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' },
):
  | { action: 'submit'; payload: P }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' } {
  return r;
}
