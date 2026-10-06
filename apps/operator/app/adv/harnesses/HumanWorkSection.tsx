'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../harness/Button';

interface HumanWorkView {
  offer: { id: string; brief: string; rubricRef: string; amountCents: number; currency: string;
    status: 'available' | 'claimed' | 'submitted' | 'accepted' | 'rejected' | 'paid' };
  version: number;
  mine: boolean;
  submission: string | null;
}

const errorCopy = (status: number, code?: string): string => {
  if (status === 401) return 'Sign in to claim work.';
  if (status === 404) return 'No work has been offered to the market.';
  if (status === 409) return 'This offer changed or was already claimed. Refresh to see its current status.';
  if (code === 'external_human_required') return 'This work must be claimed by someone other than its owner.';
  if (status === 403) return 'Your signed-in account cannot perform this action.';
  return 'Human work could not be loaded. Try again.';
};

/** Accepted E3 design, using the registry's action.primary Button primitive. */
export function HumanWorkSection({ slug, id, refreshKey }: { slug: string; id: string; refreshKey: string }) {
  const heading = useId();
  const resultId = useId();
  const endpoint = `/api/harness/${encodeURIComponent(slug)}/work-items/${encodeURIComponent(id)}/human-work`;
  const [view, setView] = useState<HumanWorkView | null>(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const currentEndpoint = useRef(endpoint);
  currentEndpoint.current = endpoint;

  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++requestSeq.current;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { credentials: 'include',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      const data = await response.json();
      if (seq !== requestSeq.current || currentEndpoint.current !== endpoint) return;
      if (!response.ok) { setView(null); setError(errorCopy(response.status, data.error)); return; }
      setView(data as HumanWorkView);
    } catch {
      if (seq === requestSeq.current && !signal?.aborted) { setView(null); setError(errorCopy(500)); }
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => { controller.abort(); requestSeq.current++; };
  }, [load, refreshKey]);
  useEffect(() => { setView(null); setResult(''); }, [endpoint]);

  const act = async (action: 'claim' | 'submit') => {
    if (!view || busy) return;
    const seq = ++requestSeq.current;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ action, version: view.version, ...(action === 'submit' ? { result: result.trim() } : {}) }) });
      const data = await response.json();
      if (seq !== requestSeq.current || currentEndpoint.current !== endpoint) return;
      if (!response.ok) { setView(null); setError(errorCopy(response.status, data.error)); return; }
      setView(data as HumanWorkView);
    } catch {
      if (seq === requestSeq.current) {
        setView(null);
        setError('The action could not be confirmed. Refresh to check before trying again.');
      }
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  };

  return (
    <section className="pc-adv-detail__section" aria-labelledby={heading}>
      <h2 id={heading}>Human work</h2>
      <p>Only work explicitly offered to the market appears here. Read the brief, rubric, and payout terms before claiming.</p>
      {error ? <p role="alert">{error}</p> : null}
      {busy ? <p role="status">Loading…</p> : null}
      {view ? <>
        <h3>Work brief</h3>
        <p className="pc-adv-detail__prose">{view.offer.brief}</p>
        <p>Review rubric: {view.offer.rubricRef}</p>
        <p>Payout: {new Intl.NumberFormat(undefined, { style: 'currency', currency: view.offer.currency }).format(view.offer.amountCents / 100)}</p>
        {view.offer.status === 'available' ? <Button type="button" variant="primary" aria-label="Claim this work"
          disabled={busy} onClick={() => void act('claim')}>Claim work</Button> : null}
        {view.mine && view.offer.status === 'claimed' ? <form onSubmit={event => { event.preventDefault(); void act('submit'); }}>
          <label htmlFor={resultId}>Your result</label>
          <textarea id={resultId} value={result} maxLength={32000} required disabled={busy}
            onChange={event => setResult(event.target.value)} rows={5} style={{ width: '100%' }} />
          <Button type="submit" variant="primary" disabled={busy || !result.trim()}>Submit for review</Button>
        </form> : null}
        {!view.mine && view.offer.status === 'claimed' ? <p role="status">This work has already been claimed.</p> : null}
        {view.offer.status === 'submitted' ? <p role="status">Submitted for independent review.</p> : null}
        {view.offer.status === 'accepted' ? <p role="status">Review passed. Manual payment is pending.</p> : null}
        {view.offer.status === 'rejected' ? <p role="status">Review did not pass.</p> : null}
        {view.offer.status === 'paid' ? <p role="status">Manual payment recorded.</p> : null}
        {view.mine && view.submission ? <p className="pc-adv-detail__prose">{view.submission}</p> : null}
      </> : null}
      <p aria-live="polite">Payment is recorded manually after an independent passing rubric grade.</p>
      {error ? <Button type="button" disabled={busy} onClick={() => void load()}>Refresh human work</Button> : null}
    </section>
  );
}
