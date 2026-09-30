'use client';

/**
 * BranchActionRunner — modal that invokes a per-branch action and renders
 * its run as STRUCTURE via the shared <StructuredStreamView> (typed run row
 * with status/duration/latest output; raw stdout/stderr one click away in
 * the drawer — the xterm escape hatch). It used to flatten the same typed
 * event stream (`action-started`, `output`, `stderr`, `action-completed`,
 * `action-failed`, `done`) into opaque terminal bytes.
 *
 * Plan: structured-streams-not-terminals-2026-06-05 (D-004, P1). The step
 * projection + raw-line ANSI renderer live in `branch-action-stream-steps.ts`
 * (pure, unit-tested); this component is now just the start-run wiring.
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../harness/Modal';
import { useLexicon } from '@/lib/useLexicon';
import { StructuredStreamView } from './StructuredStreamView';
import {
  BRANCH_ACTION_EVENT_KINDS,
  classifyBranchActionTerminal,
  deriveBranchActionSteps,
  renderBranchActionRawLine,
} from './branch-action-stream-steps';

interface Props {
  slug: string;
  branch: 'staging' | 'testing' | 'production';
  name: string;
  /** If set, attach to an existing run instead of starting a new one. */
  existingRunId?: string;
  onClose: () => void;
}

export default function BranchActionRunner({ slug, branch, name, existingRunId, onClose }: Props) {
  const t = useLexicon();
  const [runId, setRunId] = useState<string | null>(existingRunId ?? null);
  const [status, setStatus] = useState<'starting' | 'streaming' | 'done' | 'failed' | 'error'>(
    existingRunId ? 'streaming' : 'starting',
  );
  const [error, setError] = useState<string | null>(null);

  const [missingKeys, setMissingKeys] = useState<{ name: string; plugin?: string }[] | null>(null);

  // Start the run if we don't have one yet
  useEffect(() => {
    if (runId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/harness/${slug}/branch/${branch}/action-run?name=${encodeURIComponent(name)}`,
          { method: 'POST' },
        );
        const body = await res.json();
        if (res.status === 412) {
          if (!cancelled) {
            setMissingKeys(body.missing ?? []);
            setStatus('error');
            setError('Required keys missing');
          }
          return;
        }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setRunId(body.runId as string);
          setStatus('streaming');
        }
      } catch (e) {
        if (!cancelled) { setError(String((e as Error).message)); setStatus('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [runId, slug, branch, name]);

  const streamUrl = useMemo(() => runId
    ? `/api/harness/${slug}/branch/${branch}/action-stream?name=${encodeURIComponent(name)}&runId=${encodeURIComponent(runId)}`
    : null,
    [runId, slug, branch, name]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`${branch} / ${name}`}
      srOnlyTitle
      closeOnEscape={status === 'done' || status === 'failed' || status === 'error'}
      closeOnOutsideClick={status === 'done' || status === 'failed' || status === 'error'}
      contentStyle={{
        width: 'min(900px, 100%)', height: 'min(600px, 100%)',
        background: '#161b22', border: '1px solid var(--border)',
        borderRadius: 6, display: 'flex', flexDirection: 'column',
      }}
    >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 12px', borderBottom: '1px solid var(--border)',
          fontSize: 12,
        }}>
          <span style={{ fontWeight: 600 }}>{branch} / {name}</span>
          <span style={{ color: 'var(--fg-dim)' }}>{slug}</span>
          <span style={{
            marginLeft: 'auto',
            color:
              status === 'done' ? '#3fb950' :
              status === 'failed' || status === 'error' ? 'var(--bad)' :
              '#58a6ff',
          }}>
            {status}{runId ? ` · ${runId}` : ''}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--fg)', borderRadius: 3, padding: '2px 8px',
              cursor: 'pointer', fontSize: 11,
            }}
          >Close</button>
        </div>
        {!missingKeys && (
          <div style={{ flex: 1, minHeight: 0, padding: 8, display: 'flex', flexDirection: 'column' }}>
            {streamUrl ? (
              <StructuredStreamView
                url={streamUrl}
                eventKinds={BRANCH_ACTION_EVENT_KINDS}
                deriveSteps={deriveBranchActionSteps}
                formatRawLine={renderBranchActionRawLine}
                classifyTerminal={classifyBranchActionTerminal}
                controlKinds={{ attached: 'attached', done: 'done' }}
                onDone={({ kind }) => {
                  if (kind === 'success') setStatus('done');
                  else if (kind === 'failed') setStatus('failed');
                }}
                caption={`${branch}/${name} @ ${slug}${runId ? ` · ${runId}` : ''}`}
                rawRows={20}
              />
            ) : (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--fg-mute)' }}>
                Starting {branch}/{name}…
              </div>
            )}
          </div>
        )}
        {missingKeys && (
          <div style={{ padding: 16, background: '#1c1917', color: 'var(--warn)', fontSize: 13, lineHeight: 1.5, overflow: 'auto', flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--warn)' }}>
              Required keys missing
            </div>
            <div style={{ color: '#c9d1d9', marginBottom: 12 }}>
              This action needs values that haven't been configured yet for this {t('pot', { lower: true })}.
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {missingKeys.map((m) => (
                <li key={m.name} style={{ marginBottom: 8 }}>
                  <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 3 }}>{m.name}</code>
                  {m.plugin && (
                    <>
                      {' '}— from{' '}
                      <a
                        href={`/harness/${slug}?panel=plugins&plugin=${encodeURIComponent(m.plugin)}`}
                        style={{ color: '#58a6ff' }}
                      >
                        {m.plugin}
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {missingKeys[0]?.plugin && (
              <a
                href={`/harness/${slug}?panel=plugins&plugin=${encodeURIComponent(missingKeys[0].plugin)}`}
                style={{
                  display: 'inline-block', marginTop: 12,
                  padding: '6px 12px', background: '#58a6ff', color: '#0d1117',
                  textDecoration: 'none', borderRadius: 4, fontWeight: 600,
                }}
              >
                Configure {missingKeys[0].plugin} →
              </a>
            )}
          </div>
        )}
        {error && !missingKeys && (
          <div style={{ padding: '6px 12px', background: '#3a1010', color: 'var(--bad)', fontSize: 12 }}>
            {error}
          </div>
        )}
    </Modal>
  );
}
