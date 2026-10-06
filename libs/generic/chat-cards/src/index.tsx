'use client';

/**
 * Shared interactive-card presentation.
 *
 * This is deliberately a props seam: hosts own transport, state subscription,
 * routing and theme CSS; this package owns the DOM, interaction semantics and
 * CardResponse shaping. That lets the operator and portal render the same card
 * implementation without either app importing the other.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Sparkles, Square } from 'lucide-react';
import { parseGoalOwnerReportSnapshot, serializeGoalOwnerReportSnapshot } from '@papercusp/chat-protocol';
import type {
  CardResponse,
  OpenCardSnapshot,
  ReportBlock,
  ReportItem,
  ReportPlan,
  GoalOwnerReportRefV1,
  GoalOwnerReportSnapshotV1,
} from '@papercusp/chat-protocol';

export interface AskChoiceOption {
  id: string;
  label: string;
  hint?: string;
  style?: 'default' | 'primary' | 'danger';
  terminal?: boolean;
}

export interface AskChoiceArgs {
  question: string;
  options: AskChoiceOption[];
  multi?: boolean;
  report?: ReportBlock;
}

export interface AskChoiceAnswered {
  picks: Array<{ option_id: string; label: string }>;
  declined?: boolean;
  at: number;
}

export type AskChoiceResponse =
  | { action: 'submit'; picks: Array<{ option_id: string; label: string }> }
  | { action: 'navigate'; option_id: string; label: string }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' };

export type ReportRenderer = (report: ReportBlock) => ReactNode;

export interface AskChoiceCardProps {
  args: AskChoiceArgs;
  answered?: AskChoiceAnswered;
  onResponse?: (response: AskChoiceResponse) => void;
  onAnswer?: (commit: { picks: Array<{ option_id: string; label: string }> }) => void;
  allowDecline?: boolean;
  disableWhenAnswered?: boolean;
  hideOptions?: boolean;
  expired?: boolean;
  renderReport?: ReportRenderer;
  /** Host-owned rich presentation for the question text. The default stays a
   *  plain paragraph; opted-in hosts may return structured inline/block DOM. */
  renderQuestion?: (question: string) => ReactNode;
}

export function AskChoiceCard({
  args,
  answered,
  onResponse,
  onAnswer,
  allowDecline = true,
  disableWhenAnswered = true,
  hideOptions = false,
  expired = false,
  renderReport,
  renderQuestion,
}: AskChoiceCardProps): ReactNode {
  const questionId = `ask-${args.question.slice(0, 16).replace(/\s+/g, '-')}`;
  const isAnswered = Boolean(answered);
  const isExpired = expired && !isAnswered;
  const disabled = (isAnswered && disableWhenAnswered) || isExpired;
  const multi = args.multi === true;
  const mainOptions = hideOptions
    ? []
    : multi
      ? args.options
      : args.options.filter((option) => option.terminal !== false);
  const navOptions = hideOptions || multi
    ? []
    : args.options.filter((option) => option.terminal === false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const pickedIds = new Set(answered?.picks.map((pick) => pick.option_id) ?? []);

  const fire = (response: AskChoiceResponse): void => {
    if (disabled) return;
    onResponse?.(response);
    if (response.action === 'submit') onAnswer?.({ picks: response.picks });
  };
  const commit = (picks: Array<{ option_id: string; label: string }>): void => {
    if (!disabled && picks.length > 0) fire({ action: 'submit', picks });
  };

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="ask-choice-card"
      data-tool="chat:ask_choice"
      data-multi={multi ? 'true' : 'false'}
      data-answered={isAnswered ? 'true' : 'false'}
      data-expired={isExpired ? 'true' : 'false'}
    >
      <div className="ask-choice-head">
        {renderQuestion ? (
          <div id={questionId} className="ask-choice-question">
            {renderQuestion(args.question)}
          </div>
        ) : (
          <p id={questionId} className="ask-choice-question">{args.question}</p>
        )}
        {isExpired ? (
          <p className="ask-choice-expired" role="status">Expired — this question is no longer open.</p>
        ) : answered?.declined ? (
          <p className="ask-choice-picked">Skipped</p>
        ) : answered ? (
          <p className="ask-choice-picked">
            Picked <span>{answered.picks.map((pick) => pick.label).join(' · ')}</span>
          </p>
        ) : null}
      </div>
      {args.report ? (
        <div className="ask-choice-report">
          {renderReport ? renderReport(args.report) : <ReportBlockCard report={args.report} />}
        </div>
      ) : null}
      {mainOptions.length > 0 ? (
        <div className="ask-choice-options">
          {mainOptions.map((option) => {
            const picked = pickedIds.has(option.id);
            const toggled = multi && !isAnswered && selected.has(option.id);
            const highlighted = picked || toggled;
            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                aria-label={option.label}
                {...(multi
                  ? { 'aria-checked': highlighted, role: 'checkbox' }
                  : { 'aria-pressed': picked || undefined })}
                onClick={() => {
                  if (disabled) return;
                  if (!multi) {
                    commit([{ option_id: option.id, label: option.label }]);
                    return;
                  }
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(option.id)) next.delete(option.id);
                    else next.add(option.id);
                    return next;
                  });
                }}
                className="ask-choice-option"
                data-style={option.style ?? 'default'}
                data-picked={highlighted ? 'true' : 'false'}
                data-disabled={disabled ? 'true' : 'false'}
              >
                <span aria-hidden="true" className="ask-choice-option-icon" data-style={option.style ?? 'default'}>
                  {highlighted ? <Check className="ask-choice-icon" /> : multi ? <Square className="ask-choice-icon" /> : <Sparkles className="ask-choice-icon" />}
                </span>
                <span className="ask-choice-option-text">
                  <span className="ask-choice-option-label">{option.label}</span>
                  {option.hint ? <span aria-hidden="true" className="ask-choice-option-hint">{option.hint}</span> : null}
                </span>
                {!disabled && !multi ? <ChevronRight className="ask-choice-option-chevron" strokeWidth={2} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {navOptions.length > 0 ? (
        <div className="ask-choice-nav">
          {navOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              aria-label={option.label}
              className="ask-choice-nav-btn"
              data-style={option.style ?? 'default'}
              onClick={() => fire({ action: 'navigate', option_id: option.id, label: option.label })}
            >
              {option.label}
              {option.hint ? <span className="ask-choice-nav-hint">{option.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {!hideOptions && multi && !isAnswered && !isExpired ? (
        <div className="ask-choice-submit-row">
          <span className="ask-choice-submit-hint">
            {selected.size === 0 ? 'Pick one or more, then Submit' : `${selected.size} selected`}
          </span>
          <div className="ask-choice-actions">
            {allowDecline ? <button type="button" onClick={() => fire({ action: 'decline' })} className="ask-choice-skip" aria-label="Skip">Skip</button> : null}
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={() => commit(args.options
                .filter((option) => selected.has(option.id))
                .map((option) => ({ option_id: option.id, label: option.label })))}
              className="ask-choice-submit"
            >
              Submit
            </button>
          </div>
        </div>
      ) : null}
      {!hideOptions && !multi && !isAnswered && !isExpired && allowDecline ? (
        <div className="ask-choice-skip-row">
          <button type="button" onClick={() => fire({ action: 'decline' })} className="ask-choice-skip-link" aria-label="Skip this question">Skip</button>
        </div>
      ) : null}
    </div>
  );
}

export type InputCardPresentation =
  | { kind: 'text'; placeholder?: string; multiline?: boolean }
  | { kind: 'date'; min?: string; max?: string }
  | { kind: 'slider'; min: number; max: number; step?: number };

export type InputCardResponse =
  | { action: 'submit'; value: string | number }
  | { action: 'decline'; reason?: string };

export interface InputCardProps {
  prompt: string;
  presentation: InputCardPresentation;
  fallbackText?: string;
  allowDecline?: boolean;
  onResponse: (response: InputCardResponse) => void;
}

export function InputCard({
  prompt,
  presentation,
  fallbackText,
  allowDecline = true,
  onResponse,
}: InputCardProps): ReactNode {
  const questionId = `input-${prompt.slice(0, 16).replace(/\s+/g, '-')}`;
  const [text, setText] = useState('');
  const sliderMin = presentation.kind === 'slider' ? presentation.min : 0;
  const sliderMax = presentation.kind === 'slider' ? presentation.max : 0;
  const sliderStep = presentation.kind === 'slider' ? (presentation.step ?? 1) : 1;
  const [slider, setSlider] = useState(() => Math.round((sliderMin + sliderMax) / 2 / sliderStep) * sliderStep);
  const submitText = (): void => {
    if (text.length > 0) onResponse({ action: 'submit', value: text });
  };

  return (
    <div role="group" aria-labelledby={questionId} className="input-card" data-kind={presentation.kind}>
      <p id={questionId} className="input-card-question">{prompt}</p>
      {presentation.kind === 'text' ? (
        presentation.multiline ? (
          <textarea className="input-card-textarea" value={text} onChange={(event) => setText(event.target.value)} placeholder={presentation.placeholder ?? fallbackText ?? ''} rows={3} aria-label="response" />
        ) : (
          <input
            type="text"
            className="input-card-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitText();
              }
            }}
            placeholder={presentation.placeholder ?? fallbackText ?? ''}
            aria-label="response"
          />
        )
      ) : presentation.kind === 'date' ? (
        <input type="date" className="input-card-date" value={text} min={presentation.min} max={presentation.max} onChange={(event) => setText(event.target.value)} aria-label="date" />
      ) : (
        <div className="input-card-slider-row">
          <input type="range" className="input-card-slider" min={presentation.min} max={presentation.max} step={sliderStep} value={slider} onChange={(event) => setSlider(Number(event.target.value))} aria-label="value" aria-valuemin={presentation.min} aria-valuemax={presentation.max} aria-valuenow={slider} />
          <output className="input-card-slider-value" aria-live="polite">{slider}</output>
        </div>
      )}
      <div className="input-card-actions">
        {allowDecline ? <button type="button" onClick={() => onResponse({ action: 'decline' })} className="input-card-skip" aria-label="Skip">Skip</button> : null}
        <button
          type="button"
          disabled={presentation.kind !== 'slider' && text.length === 0}
          onClick={() => presentation.kind === 'slider'
            ? onResponse({ action: 'submit', value: slider })
            : submitText()}
          className="input-card-submit"
        >
          Submit
        </button>
      </div>
    </div>
  );
}

type Tone = 'good' | 'accent' | 'bad' | 'muted';

function statusGlyph(status: string | undefined): { glyph: string; tone: Tone; label: string } {
  const value = (status ?? '').trim().toLowerCase();
  if (['done', 'passed', 'shipped', 'resolved'].includes(value)) return { glyph: '●', tone: 'good', label: value };
  if (['wip', 'active', 'in_progress', 'in-progress', 'doing'].includes(value)) return { glyph: '◐', tone: 'accent', label: value };
  if (['blocked', 'failing', 'failed', 'error'].includes(value)) return { glyph: '■', tone: 'bad', label: value };
  if (['needs-human', 'needs_human', 'review'].includes(value)) return { glyph: '◆', tone: 'accent', label: value };
  if (['dropped', 'deprecated', 'closed'].includes(value)) return { glyph: '×', tone: 'muted', label: value };
  return { glyph: value ? '○' : '·', tone: 'muted', label: value };
}

export interface ReportBlockRenderContext {
  item: ReportItem;
  plan: ReportPlan;
}

/** The host resolves the exact immutable ID through its existing report library. */
export interface ResolvedGoalOwnerReport {
  reportId: string;
  workspaceId: string;
  goalId: string;
  bodySha256: string;
  bodyMd: string;
  snapshot: GoalOwnerReportSnapshotV1;
}

export interface ReportBlockCardProps {
  report: ReportBlock;
  renderItemText?: (context: ReportBlockRenderContext) => ReactNode;
  onDrillIn?: (ref: string) => void;
  canDrillIn?: (ref: string) => boolean;
  resolveGoalReport?: (reference: GoalOwnerReportRefV1) => Promise<ResolvedGoalOwnerReport>;
  /** Hosts may keep expansion in their URL/router; portable hosts use local state. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  renderGoalReportControl?: (control: { label: string; expanded: boolean; onClick: () => void }) => ReactNode;
}

function GoalReportDetail({ reference, resolve, expanded, onToggle, renderControl }: {
  reference: GoalOwnerReportRefV1;
  resolve: ReportBlockCardProps['resolveGoalReport'];
  expanded: boolean;
  onToggle: () => void;
  renderControl: ReportBlockCardProps['renderGoalReportControl'];
}): ReactNode {
  const key = `${reference.goalId}:${reference.reportId}:${reference.bodySha256}`;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; result?: ResolvedGoalOwnerReport; error?: string }>({ key });
  useEffect(() => {
    if (!expanded || !resolve || (state.key === key && state.result)) return;
    let cancelled = false;
    setState({ key });
    void (async () => {
      try {
        const result = await resolve(reference);
        const snapshot = parseGoalOwnerReportSnapshot(result.snapshot);
        if (!snapshot || result.reportId !== reference.reportId || result.goalId !== reference.goalId ||
          result.bodySha256 !== reference.bodySha256 || snapshot.goalId !== reference.goalId ||
          snapshot.workspaceId !== result.workspaceId || result.bodyMd !== serializeGoalOwnerReportSnapshot(snapshot)) {
          throw new Error('The resolved report does not match this pinned snapshot.');
        }
        const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.bodyMd));
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== reference.bodySha256) throw new Error('The report body does not match this pinned snapshot.');
        if (!cancelled) setState({ key, result });
      } catch (error) {
        if (!cancelled) setState({ key, error: error instanceof Error ? error.message : 'Report resolution failed.' });
      }
    })();
    return () => { cancelled = true; };
    // The scalar key is the reference identity. Result state deliberately does not
    // trigger another fetch; collapse/reopen keeps this immutable result cached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, resolve, key, retry]);
  if (!resolve) return <p className="report-block-plan-summary">Full snapshot is unavailable in this view.</p>;
  const label = expanded ? 'Collapse full report' : 'Expand full report';
  const result = state.key === key ? state.result : undefined;
  const error = state.key === key ? state.error : undefined;
  return (
    <div className="report-block-goal-detail">
      {renderControl ? renderControl({ label, expanded, onClick: onToggle }) : (
        <button type="button" className="report-block-item-drill" aria-expanded={expanded} onClick={onToggle}>{label}</button>
      )}
      {expanded ? (
        <div className="report-block-goal-content">
          {result ? (
            <>
              <p className="report-block-goal-as-of">Historical snapshot · observed at {result.snapshot.observedAt}</p>
              <pre className="report-block-goal-body" data-report-id={result.reportId}>{result.bodyMd}</pre>
            </>
          ) : error ? (
            <>
              <p role="alert">This snapshot could not be loaded. {error}</p>
              <button type="button" className="report-block-item-drill" onClick={() => setRetry((value) => value + 1)}>Retry loading report</button>
            </>
          ) : <p role="status">Loading this snapshot…</p>}
        </div>
      ) : null}
    </div>
  );
}

export function ReportBlockCard({ report, renderItemText, onDrillIn, canDrillIn,
  resolveGoalReport, expanded, onExpandedChange, renderGoalReportControl }: ReportBlockCardProps): ReactNode {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = expanded ?? localExpanded;
  if (!report.plans.length && !report.goalReport) return null;
  return (
    <div className="report-block-card" data-component="report-block" role="group" aria-label={report.title ?? 'Report'}>
      {report.title ? <div className="report-block-title">{report.title}</div> : null}
      {report.goalReport ? <GoalReportDetail reference={report.goalReport} resolve={resolveGoalReport}
        expanded={isExpanded} onToggle={() => { setLocalExpanded(!isExpanded); onExpandedChange?.(!isExpanded); }}
        renderControl={renderGoalReportControl} /> : null}
      <div className="report-block-plans">
        {report.plans.map((plan, planIndex) => {
          const planStatus = statusGlyph(plan.status);
          return (
            <div key={`${plan.slug ?? plan.title}:${planIndex}`} className="report-block-plan" data-tone={planStatus.tone}>
              <div className="report-block-plan-head">
                <span className="report-block-glyph" data-tone={planStatus.tone} aria-hidden="true" title={planStatus.label || undefined}>{planStatus.glyph}</span>
                <span className="report-block-plan-title">{plan.title}</span>
                {plan.status ? <span className="report-block-plan-status" data-tone={planStatus.tone}>{plan.status}</span> : null}
              </div>
              {plan.summary ? <p className="report-block-plan-summary">{plan.summary}</p> : null}
              {plan.items?.length ? (
                <ul className="report-block-items">
                  {plan.items.map((item, itemIndex) => {
                    const itemStatus = statusGlyph(item.status);
                    const drillable = Boolean(item.ref && onDrillIn && (!canDrillIn || canDrillIn(item.ref)));
                    return (
                      <li key={`${item.id ?? item.text}:${itemIndex}`} className="report-block-item" data-tone={itemStatus.tone}>
                        <span className="report-block-glyph" data-tone={itemStatus.tone} aria-hidden="true" title={itemStatus.label || undefined}>{itemStatus.glyph}</span>
                        {item.id ? <span className="report-block-item-id">{item.id}</span> : null}
                        {renderItemText ? renderItemText({ item, plan }) : <span className="report-block-item-text">{item.text}</span>}
                        {drillable ? <button type="button" className="report-block-item-drill" onClick={() => onDrillIn?.(item.ref!)} data-ref={item.ref} aria-label={`Open ${item.ref}`}>Open ↗</button> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface CardRendererProps {
  card: OpenCardSnapshot;
  busy?: boolean;
  expired?: boolean;
  onResponse: (response: CardResponse) => void;
  renderReport?: ReportRenderer;
}

export function CardRenderer({ card, busy = false, expired = false, onResponse, renderReport }: CardRendererProps): ReactNode {
  const presentation = card.presentation;
  if (presentation && (presentation.kind === 'radio' || presentation.kind === 'checkbox' || presentation.kind === 'select')) {
    return (
      <AskChoiceCard
        args={{
          question: card.prompt,
          options: (presentation.options ?? []).map((option) => ({ id: option.id, label: option.label, hint: option.hint, style: option.style })),
          multi: presentation.kind === 'checkbox',
          report: card.report,
        }}
        expired={expired}
        disableWhenAnswered={busy}
        allowDecline={card.allowDecline ?? true}
        renderReport={renderReport}
        onResponse={(response) => {
          if (response.action === 'submit') onResponse({ action: 'submit', correlationId: card.correlationId, value: { picks: response.picks.map((pick) => pick.option_id) } });
          else if (response.action === 'decline') onResponse({ action: 'decline', correlationId: card.correlationId });
          else if (response.action === 'cancel') onResponse({ action: 'cancel', correlationId: card.correlationId });
        }}
      />
    );
  }
  if (presentation && (presentation.kind === 'text' || presentation.kind === 'date' || presentation.kind === 'slider')) {
    const inputPresentation: InputCardPresentation = presentation.kind === 'slider'
      ? {
          kind: 'slider',
          min: typeof presentation.min === 'number' ? presentation.min : 0,
          max: typeof presentation.max === 'number' ? presentation.max : 100,
          step: presentation.step,
        }
      : presentation.kind === 'date'
        ? {
            kind: 'date',
            min: typeof presentation.min === 'string' ? presentation.min : undefined,
            max: typeof presentation.max === 'string' ? presentation.max : undefined,
          }
        : { kind: 'text', placeholder: presentation.placeholder, multiline: presentation.multiline };
    return (
      <InputCard
        prompt={card.prompt}
        presentation={inputPresentation}
        fallbackText={card.fallbackText}
        allowDecline={card.allowDecline ?? true}
        onResponse={(response) => response.action === 'submit'
          ? onResponse({ action: 'submit', correlationId: card.correlationId, value: { value: response.value } })
          : onResponse({ action: 'decline', correlationId: card.correlationId })}
      />
    );
  }
  return (
    <div className="chat-card-fallback" role="status">
      <p>{card.prompt || card.fallbackText || 'No renderer available'}</p>
      {(card.allowDecline ?? true) ? <button type="button" disabled={busy} onClick={() => onResponse({ action: 'decline', correlationId: card.correlationId })}>Dismiss</button> : null}
    </div>
  );
}

export interface PendingCardsBarProps {
  cards: readonly OpenCardSnapshot[];
  busy?: boolean;
  error?: string | null;
  expiredCorrelationIds?: ReadonlySet<string>;
  onResponse: (response: CardResponse) => void;
  renderReport?: ReportRenderer;
  className?: string;
}

export function PendingCardsBar({ cards, busy = false, error = null, expiredCorrelationIds, onResponse, renderReport, className }: PendingCardsBarProps): ReactNode {
  const head = cards[0];
  if (!head) return null;
  const remaining = cards.length - 1;
  return (
    <div className={className ?? 'pending-cards-bar'} data-remaining={remaining}>
      <CardRenderer card={head} busy={busy} expired={expiredCorrelationIds?.has(head.correlationId) ?? false} onResponse={onResponse} renderReport={renderReport} />
      {remaining > 0 ? <p className="pending-cards-queue" aria-live="polite">{remaining} more {remaining === 1 ? 'card' : 'cards'} after this</p> : null}
      {error ? <p className="pending-cards-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** Local hosts share the same props/rendering; only the host-election adapter differs. */
export function LocalCardHost(props: PendingCardsBarProps): ReactNode {
  return <PendingCardsBar {...props} className={props.className ?? 'local-card-host'} />;
}

export interface UICardRendererProps {
  resource: { uri: string; mimeType: string; text?: string; blob?: string; _meta?: Record<string, unknown> };
  defaultHeight?: number;
  className?: string;
}

function decodeBlob(value: string): string {
  if (typeof window === 'undefined') return '';
  try { return atob(value); } catch { return ''; }
}

function externalUrl(text: string): string | null {
  const value = text.trim();
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

export function UICardRenderer({ resource, defaultHeight = 240, className }: UICardRendererProps): ReactNode {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(defaultHeight);
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== ref.current?.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (data && data.type === 'mcpUi:size' && typeof data.height === 'number') {
        setHeight(Math.min(800, Math.max(80, data.height)));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const text = resource.text ?? (resource.blob ? decodeBlob(resource.blob) : '');
  const src = externalUrl(text);
  return (
    <div className={className} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'transparent' }} data-mcp-ui-uri={resource.uri}>
      <iframe ref={ref} title={`mcp-ui: ${resource.uri}`} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: '100%', height, border: 0, display: 'block' }} {...(src ? { src } : { srcDoc: text })} />
    </div>
  );
}

export function isUIResourceContent(content: unknown): content is { type: 'resource'; resource: UICardRendererProps['resource'] } {
  if (!content || typeof content !== 'object') return false;
  const record = content as Record<string, unknown>;
  if (record.type !== 'resource' || !record.resource || typeof record.resource !== 'object') return false;
  const resource = record.resource as Record<string, unknown>;
  // MCP-UI resources are `ui://` by spec; any other resource URI (a papercusp:// data
  // resource, say) is ordinary content and must NOT be handed to the iframe renderer.
  return (
    typeof resource.uri === 'string' &&
    resource.uri.startsWith('ui://') &&
    typeof resource.mimeType === 'string'
  );
}
