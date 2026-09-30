'use client';

/**
 * Sketch pane for the design tab. Plan §11.
 *
 * v0.1: minimal HTML5 canvas with freehand drawing, eraser, undo,
 * clear, and save. tldraw is a planned upgrade once richer shapes
 * matter; the storage shape (PNG dataURL in payload.png) survives
 * that swap.
 *
 * Sketches are scoped to a feature: pick a feature on the left rail
 * → sketch here → save → re-loadable from the prior-sketches list.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

interface PriorSketch {
  id: string;
  label: string | null;
  png: string | null;
  createdTs: number | null;
}

const CANVAS_W = 720;
const CANVAS_H = 480;
const SKETCH_PAPER = '#ffffff';
const token = {
  fgMuted: 'var(--fg-mute)',
  fgDim: 'var(--fg-dim)',
  border: 'var(--border)',
  bg2: 'var(--bg-2)',
  bgDeep: 'var(--bg-deeper)',
  accentFill: 'color-mix(in srgb, var(--accent), transparent 84%)',
  accentBorder: 'color-mix(in srgb, var(--accent-strong), transparent 58%)',
  danger: 'var(--bad)',
} as const;

export default function SketchPane({
  slug,
  featureId,
}: {
  slug: string;
  featureId: string | null;
}) {
  const workspaceId = useWorkspaceId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useQueryState('sketchTool', parseAsStringEnum<'pen' | 'eraser'>(['pen', 'eraser']).withDefault('pen'));
  const [color, setColor] = useState('#111827');
  const [lineWidth, setLineWidth] = useState(2);
  const [drawing, setDrawing] = useState(false);
  const [history, setHistory] = useState<ImageData[]>([]); // for undo
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  // Initialize canvas + clear when feature changes.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = SKETCH_PAPER;
    ctx.fillRect(0, 0, c.width, c.height);
    setHistory([]);
  }, [featureId]);

  const sketchesQ = useSyncQuery<PriorSketch>({
    queryName: 'designSketches.byFeature',
    args: { harnessSlug: slug, featureId: featureId ?? '', workspaceId: workspaceId ?? 'default' },
    enabled: !!featureId,
  });

  function pushHistory() {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    setHistory((h) => {
      const next = h.slice(-19); // cap at 20 steps
      next.push(ctx.getImageData(0, 0, c.width, c.height));
      return next;
    });
  }

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    pushHistory();
    setDrawing(true);
    lastPoint.current = pointFromEvent(e);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (tool === 'pen') {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.globalCompositeOperation = 'source-over';
    } else {
      // Eraser paints the sketch paper color, not the app chrome.
      ctx.strokeStyle = SKETCH_PAPER;
      ctx.lineWidth = lineWidth * 4;
      ctx.globalCompositeOperation = 'source-over';
    }
    if (lastPoint.current) {
      ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    lastPoint.current = p;
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    canvasRef.current?.releasePointerCapture(e.pointerId);
    setDrawing(false);
    lastPoint.current = null;
  }

  function undo() {
    if (history.length === 0) return;
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const last = history[history.length - 1];
    ctx.putImageData(last, 0, 0);
    setHistory((h) => h.slice(0, -1));
  }

  function clear() {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    pushHistory();
    ctx.fillStyle = SKETCH_PAPER;
    ctx.fillRect(0, 0, c.width, c.height);
  }

  async function save() {
    if (!featureId) return;
    const c = canvasRef.current;
    if (!c) return;
    setSaving(true);
    setSaveError(null);
    try {
      const png = c.toDataURL('image/png');
      const r = await fetch('/api/design/sketches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: slug,
          feature: featureId,
          png,
          label: label.trim() || undefined,
          workspace: workspaceId ?? 'default',
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      setLabel('');
      sketchesQ.invalidate();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const priors = sketchesQ.data ?? [];
  const priorTimes = useMemo(
    () => priors.map((s) => (s.createdTs ? new Date(s.createdTs).toLocaleString() : '?')),
    [priors],
  );

  if (!featureId) {
    return (
      <p style={{ color: token.fgMuted }}>
        Pick a feature on the left to sketch against it. Sketches are stored as
        artifacts on the feature.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <header style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Sketch</h2>
          <span style={{ color: token.fgMuted, fontSize: 12 }}>
            feature: <code>{featureId}</code>
          </span>
        </header>
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            padding: 6,
            border: `1px solid ${token.border}`,
            borderTop: `1px solid ${token.border}`,
            borderBottom: 'none',
            background: token.bg2,
            fontSize: 12,
          }}
        >
          <button
            type="button"
            onClick={() => setTool('pen')}
            style={toolBtn(tool === 'pen')}
            aria-pressed={tool === 'pen'}
          >
            ✎ Pen
          </button>
          <button
            type="button"
            onClick={() => setTool('eraser')}
            style={toolBtn(tool === 'eraser')}
            aria-pressed={tool === 'eraser'}
          >
            ◯ Eraser
          </button>
          <span style={{ width: 1, alignSelf: 'stretch', background: token.border, margin: '0 4px' }} />
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            disabled={tool === 'eraser'}
            aria-label="Stroke color"
            style={{ width: 28, height: 24, padding: 0, border: `1px solid ${token.border}`, borderRadius: 3 }}
          />
          <label style={{ color: token.fgMuted }}>
            Width
            <input
              type="range"
              min={1}
              max={12}
              value={lineWidth}
              onChange={(e) => setLineWidth(Number(e.target.value))}
              style={{ marginLeft: 4, verticalAlign: 'middle' }}
            />
          </label>
          <span style={{ width: 1, alignSelf: 'stretch', background: token.border, margin: '0 4px' }} />
          <button type="button" onClick={undo} disabled={history.length === 0} style={toolBtn(false)}>
            ↶ Undo
          </button>
          <button type="button" onClick={clear} style={toolBtn(false)}>Clear</button>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Optional label…"
              style={{ padding: '4px 8px', borderRadius: 4, border: `1px solid ${token.border}`, background: token.bgDeep, color: 'var(--fg)', fontSize: 12 }}
            />
            <button
              type="button"
              onClick={save}
              disabled={saving}
              style={{
                padding: '4px 10px',
                background: token.accentFill,
                color: 'var(--accent-soft)',
                border: `1px solid ${token.accentBorder}`,
                borderRadius: 4,
                fontSize: 12,
                cursor: saving ? 'wait' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save sketch'}
            </button>
          </span>
        </div>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            display: 'block',
            border: `1px solid ${token.border}`,
            borderRadius: '0 0 4px 4px',
            background: SKETCH_PAPER,
            touchAction: 'none',
            cursor: tool === 'eraser' ? 'cell' : 'crosshair',
            maxWidth: '100%',
            height: 'auto',
          }}
        />
        {saveError && (
          <p style={{ color: token.danger, fontSize: 12, marginTop: 8 }}>save failed: {saveError}</p>
        )}
      </div>
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          borderLeft: `1px solid ${token.border}`,
          paddingLeft: 12,
          maxHeight: CANVAS_H + 48,
          overflowY: 'auto',
        }}
      >
        <h3 style={{ fontSize: 12, fontWeight: 600, color: token.fgDim, textTransform: 'uppercase' }}>
          Prior sketches{' '}
          <span style={{ color: token.fgMuted, fontWeight: 400 }}>({priors.length})</span>
        </h3>
        {sketchesQ.loading && <p style={{ color: token.fgMuted, fontSize: 12 }}>Loading…</p>}
        {sketchesQ.error && (
          <p style={{ color: token.danger, fontSize: 12 }}>
            {sketchesQ.error.message}
          </p>
        )}
        {priors.length === 0 && !sketchesQ.loading && (
          <p style={{ color: token.fgMuted, fontSize: 12 }}>None yet.</p>
        )}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {priors.map((s, i) => (
            <li key={s.id} style={{ marginBottom: 8 }}>
              {s.png && (
                <img
                  src={s.png}
                  alt={s.label || `sketch ${i + 1}`}
                  style={{ width: '100%', border: `1px solid ${token.border}`, borderRadius: 4, display: 'block', background: SKETCH_PAPER }}
                />
              )}
              <div style={{ fontSize: 11, color: token.fgMuted, marginTop: 2 }}>
                {s.label && <strong style={{ color: token.fgDim }}>{s.label}</strong>}
                {s.label && ' · '}
                {priorTimes[i]}
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function toolBtn(active: boolean): React.CSSProperties {
  return {
    padding: '3px 8px',
    border: `1px solid ${token.border}`,
    borderRadius: 4,
    background: active ? token.accentFill : token.bg2,
    color: active ? 'var(--accent-soft)' : token.fgDim,
    cursor: 'pointer',
  };
}
