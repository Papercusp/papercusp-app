'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * Run-detail panel — plan-agent-launch P-023.
 *
 * Mounted on the Agents tab when `?run=<id>` is set. Shows:
 *   1. A header with the run's title, status pill, and a ⚠ badge when
 *      its `planContentHash` differs from the plan's current hash
 *      (D-018 — the run was seeded against an older revision).
 *   2. An "Open agent console" button that spawns a native terminal
 *      running `<agent-cli> -r <sessionId>`. The live agent surface
 *      is the terminal itself (no in-browser SSE — D-022 amended).
 *   3. The persisted transcript over `plan_run_turns` (paginated,
 *      substring-filterable, never a whole dump — D-002).
 *   4. A "Continue" form that POSTs `plans:resume` in background mode
 *      (D-022); the new user/assistant turns appear on the next
 *      transcript refresh.
 *
 * `useQueryState('run', parseAsInteger)` drives mount + unmount;
 * close = clear the URL key.
 */

import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsInteger } from 'nuqs';
import {
  fetchPlanRunTranscript,
  launchPlanRunConsole,
  resumePlanAgent,
  type PlanRunTranscriptResult,
  type PlanRunTranscriptTurn,
  type PlanRunStatus,
  type TriggerRunVisibility,
} from './plans-api';
import { launchErrorLabel } from './AgentsPanel';

interface Props {
  /** The plan's slug — passed to launchPlanRunConsole so the spawned
   *  terminal picks up the per-plan background color. */
  planSlug: string;
  /** The plan's display title — surfaced in the header AND passed to
   *  the spawned console as its window title (issue: "titlebar should
   *  be the plan title"). */
  planTitle: string | null;
  /** The plan's current contentHash — drives the stale badge. */
  currentContentHash: string | undefined;
}

const PAGE_SIZE = 20;

export default function RunDetailPanel({ planSlug, planTitle, currentContentHash }: Props) {
  const [runId, setRunId] = useQueryState('run', parseAsInteger);
  const [meta, setMeta] = useState<PlanRunTranscriptResult | null>(null);
  const [turns, setTurns] = useState<PlanRunTranscriptTurn[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Continue form.
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [consoleBusy, setConsoleBusy] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);

  // Reset when the run changes.
  useEffect(() => {
    setMeta(null);
    setTurns([]);
    setNextCursor(null);
    setQuery('');
    setError(null);
    setMessage('');
    setSendError(null);
    setConsoleError(null);
  }, [runId]);

  const loadFirstPage = useCallback(async () => {
    if (runId === null) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchPlanRunTranscript({
        runId,
        query: query.trim() || undefined,
        limit: PAGE_SIZE,
      });
      setMeta(r);
      setTurns(r.turns);
      setNextCursor(r.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [runId, query]);

  useEffect(() => { void loadFirstPage(); }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (runId === null || nextCursor === null) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchPlanRunTranscript({
        runId,
        query: query.trim() || undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      setTurns((prev) => [...prev, ...r.turns]);
      setNextCursor(r.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [runId, nextCursor, query]);

  const onSend = async () => {
    if (runId === null || sending) return;
    const text = message.trim();
    if (!text) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await resumePlanAgent({ runId, message: text });
      if ('ok' in res && res.ok) {
        setMessage('');
        // Reload from page 1 so the new user turn appears at once
        // (the assistant turn lands when the background turn settles).
        await loadFirstPage();
      } else {
        setSendError(
          launchErrorLabel(
            res as { error?: string; busy?: Array<{ owner_label?: string; intent?: string }> },
          ),
        );
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const onOpenConsole = async () => {
    if (!meta) return;
    setConsoleBusy(true);
    setConsoleError(null);
    try {
      await launchPlanRunConsole({
        sessionId: meta.sessionId,
        planSlug,
        // Window title prefers the plan's display title; falls back to
        // the slug if the plan has no title yet.
        label: planTitle?.trim() || planSlug,
      });
    } catch (e) {
      setConsoleError(e instanceof Error ? e.message : String(e));
    } finally {
      setConsoleBusy(false);
    }
  };

  if (runId === null) return null;

  const stale =
    meta !== null &&
    currentContentHash !== undefined &&
    meta.planContentHash !== currentContentHash;

  return (
    <section className="pc-run-detail" aria-label="Run detail">
      <header className="pc-run-detail__head">
        <button
          type="button"
          className="pc-run-detail__back"
          onClick={() => setRunId(null)}
          aria-label="Back to runs list"
        >
          ← Runs
        </button>
        <span className="pc-run-detail__title">
          <span className="pc-run-detail__plan-title">
            {planTitle?.trim() || planSlug}
          </span>
          <span className="pc-run-detail__run-id">
            {meta ? `Run #${meta.runId}` : `Run #${runId}`}
          </span>
        </span>
        {meta ? (
          <span
            className={`pc-agent-row__status pc-agent-row__status--${meta.status}`}
            title={describeRunStatus(meta.status)}
          >
            {meta.status}
          </span>
        ) : null}
        {stale ? (
          <span
            className="pc-agent-row__stale"
            title="Seeded against an older revision of this plan"
          >
            ⚠ stale
          </span>
        ) : null}
        <Tooltip label="Resume the run in a real terminal — the live agent surface."><button
          type="button"
          className="pc-run-detail__console"
          onClick={onOpenConsole}
          disabled={!meta || consoleBusy}

        >
          {consoleBusy ? 'Opening…' : 'Open agent console'}
        </button></Tooltip>
      </header>
      {consoleError ? (
        <div className="pc-run-detail__error">{consoleError}</div>
      ) : null}
      {meta?.triggerRun ? <TriggerRunTrace trigger={meta.triggerRun} /> : null}
      <div className="pc-run-detail__controls">
        <input
          type="search"
          className="pc-rev-convo__query"
          placeholder="Filter turns (substring)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter turns by substring"
        />
      </div>
      {error ? <div className="pc-run-detail__error">{error}</div> : null}
      {meta && turns.length === 0 && !loading ? (
        <div className="pc-run-detail__empty">
          {query.trim()
            ? 'No turns match this filter.'
            : 'No turns recorded yet — the first turn is in flight.'}
        </div>
      ) : null}
      {turns.length > 0 ? (
        <ol className="pc-rev-convo__turns">
          {turns.map((t) => (
            <TurnRow key={t.seq} turn={t} />
          ))}
        </ol>
      ) : null}
      {loading ? <div className="pc-rev-convo__loading">Loading…</div> : null}
      {nextCursor !== null && !loading ? (
        <button type="button" className="pc-rev-convo__more" onClick={loadMore}>
          Load more
        </button>
      ) : null}
      <section className="pc-run-detail__compose" aria-label="Send a message to this run">
        <textarea
          className="pc-agents-compose__note"
          placeholder="Send a follow-up to this run…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          disabled={sending}
        />
        {sendError ? <div className="pc-agents-compose__error">{sendError}</div> : null}
        <div className="pc-agents-compose__row">
          <button
            type="button"
            className="pc-agents-compose__submit"
            onClick={onSend}
            disabled={sending || message.trim().length === 0}
          >
            {sending ? 'Sending…' : 'Continue'}
          </button>
        </div>
      </section>
    </section>
  );
}

function formatDuration(ms: number | null): string {
  if (ms == null) return 'in progress';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function TriggerRunTrace({ trigger }: { trigger: TriggerRunVisibility }) {
  const planRun = trigger.planRun;
  const planProgress = planRun?.workItems.total
    ? `${planRun.workItems.passed}/${planRun.workItems.total} items`
    : 'no items';
  const agents = planRun?.agents.length
    ? `${planRun.agents.length} agent${planRun.agents.length === 1 ? '' : 's'}`
    : 'no assigned agents';
  return (
    <section className="pc-trigger-trace" aria-labelledby="pc-trigger-trace-title">
      <header className="pc-trigger-trace__head">
        <div>
          <span className="pc-trigger-trace__kicker">{trigger.sourceKind} · {trigger.eventPattern}</span>
          <h3 id="pc-trigger-trace-title">Trigger decision trace</h3>
          <p>{trigger.causeSummary}</p>
        </div>
        <span
          className="pc-trigger-trace__disposition"
          data-disposition={trigger.policyDisposition}
        >
          {trigger.policyDetail}
        </span>
      </header>

      <dl className="pc-trigger-trace__facts">
        <div><dt>Binding</dt><dd>{trigger.bindingId}</dd></div>
        <div><dt>Filter</dt><dd><code>{JSON.stringify(trigger.eventFilter)}</code></dd></div>
        <div><dt>Storm policy</dt><dd><code>{JSON.stringify(trigger.stormPolicy)}</code></dd></div>
        <div><dt>Dedupe key</dt><dd><code>{trigger.dedupeKey}</code></dd></div>
        {planRun ? (
          <div>
            <dt>Launched plan</dt>
            <dd>
              {planRun.instancePlanSlug ? (
                <a href={`/admin/plans?plan=${encodeURIComponent(planRun.instancePlanSlug)}`}>
                  {planRun.instancePlanSlug}
                </a>
              ) : `Run #${planRun.id}`}
              {' · '}{planRun.status} · {planProgress} · {agents} · {formatDuration(planRun.durationMs)} · {planRun.costUsd > 0 ? `$${planRun.costUsd.toFixed(2)}` : '$0.00'}
            </dd>
          </div>
        ) : null}
      </dl>

      <ol className="pc-trigger-trace__timeline" aria-label="Trigger timeline">
        {trigger.timeline.map((step) => (
          <li key={step.stage} data-status={step.status}>
            <span>{step.stage}</span>
            <strong>{step.detail}</strong>
            <time>{step.at ? new Date(step.at).toLocaleString() : 'pending'}</time>
          </li>
        ))}
      </ol>

      <details className="pc-trigger-trace__payload">
        <summary>Redacted event payload</summary>
        <pre>{JSON.stringify(trigger.redactedPayload, null, 2)}</pre>
      </details>

      {trigger.outcomeLinks.length > 0 ? (
        <nav className="pc-trigger-trace__outcomes" aria-label="Run outcomes">
          <span>Outcomes</span>
          {trigger.outcomeLinks.map((link) =>
            link.href ? (
              <a key={`${link.kind}:${link.label}`} href={link.href} target="_blank" rel="noreferrer">
                {link.label}
              </a>
            ) : (
              <span key={`${link.kind}:${link.label}`}>{link.label}</span>
            ),
          )}
        </nav>
      ) : null}
    </section>
  );
}

function TurnRow({ turn }: { turn: PlanRunTranscriptTurn }) {
  return (
    <li className="pc-rev-convo-turn" data-role={turn.role}>
      <header className="pc-rev-convo-turn__head">
        <span className="pc-rev-convo-turn__role">{turn.role}</span>
        <span className="pc-rev-convo-turn__seq" title={`Turn #${turn.seq}`}>
          #{turn.seq}
        </span>
        <span className="pc-rev-convo-turn__when">
          {new Date(turn.createdAt).toLocaleString()}
        </span>
      </header>
      <pre className="pc-rev-convo-turn__content">{turn.content}</pre>
    </li>
  );
}

/* Pure helper — same shape as AgentsPanel.describeRunStatus, repeated
 * here to avoid importing back into this file's parent module. */
function describeRunStatus(s: PlanRunStatus): string {
  switch (s) {
    case 'running':  return 'a turn is in progress';
    case 'idle':     return 'between turns, resumable';
    case 'done':     return 'manually marked done';
    case 'archived': return 'archived (resume to reactivate)';
    case 'failed':   return 'the run failed or was orphaned';
  }
}
