'use client';

import { memo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import { laneColor, LANE_WIDTH, ROW_HEIGHT, NODE_WIDTH, type LaidOutCommit } from './graphLayout';

interface NodeData {
  commit: LaidOutCommit;
  maxLane: number;
}

const DOT_SIZE = 8;
const LABEL_GAP = 10;

function formatTs(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function CommitNode({ data }: { data: NodeData }) {
  const c = data.commit;
  const color = laneColor(c.lane);
  const labelLeft = (data.maxLane + 1) * LANE_WIDTH + LABEL_GAP - c.lane * LANE_WIDTH;
  const isHead = c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD ->'));
  const [hovered, setHovered] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const nodeRef = useRef<HTMLDivElement>(null);

  const onEnter = () => {
    if (nodeRef.current) {
      const r = nodeRef.current.getBoundingClientRect();
      const x = r.right + 10;
      const y = Math.min(r.top, window.innerHeight - 200);
      setAnchor({ x, y: Math.max(8, y) });
    }
    setHovered(true);
  };
  const onLeave = () => setHovered(false);

  return (
    <div
      ref={nodeRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: 'relative',
        width: NODE_WIDTH,
        height: ROW_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        color: '#d1d5db',
        cursor: 'pointer',
        borderRadius: 3,
        background: hovered ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
        transition: 'background 80ms ease',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, top: 0, left: DOT_SIZE / 2 }} />
      <div
        style={{
          width: DOT_SIZE,
          height: DOT_SIZE,
          borderRadius: '50%',
          background: color,
          boxShadow: isHead ? `0 0 0 1.5px #fff, 0 0 0 3px ${color}` : `0 0 0 1.5px #0b0e14`,
          flexShrink: 0,
          transition: 'transform 120ms ease',
          transform: hovered ? 'scale(1.4)' : 'scale(1)',
        }}
      />
      <div
        style={{
          marginLeft: labelLeft,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        {isHead && <span style={{ color: '#10b981', fontSize: 9 }}>●</span>}
        <span
          style={{
            color: hovered ? '#f3f4f6' : '#d1d5db',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {c.subject}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, bottom: 0, left: DOT_SIZE / 2 }} />

      {hovered && anchor && typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: anchor.x,
              top: anchor.y,
              zIndex: 9999,
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 6,
              padding: '10px 12px',
              boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
              minWidth: 320,
              maxWidth: 560,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              color: '#e5e7eb',
              pointerEvents: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', background: color }} />
              <span style={{ color: '#94a3b8', fontSize: 11 }}>{c.sha.slice(0, 12)}</span>
              <span style={{ color: '#64748b', fontSize: 10 }}>· {formatTs(c.ts)}</span>
              {c.refs.map((r) => {
                const isTag = r.startsWith('tag: ');
                const isHeadRef = r === 'HEAD' || r.startsWith('HEAD ->');
                const label = isTag ? r.slice(5) : r;
                const bg = isHeadRef ? '#065f46' : isTag ? '#1e3a8a' : '#1f2937';
                const fg = isHeadRef ? '#a7f3d0' : isTag ? '#dbeafe' : '#cbd5e1';
                return (
                  <span
                    key={r}
                    style={{ fontSize: 9, background: bg, color: fg, padding: '1px 6px', borderRadius: 3, fontWeight: 500 }}
                  >
                    {label}
                  </span>
                );
              })}
            </div>
            <div style={{ color: '#e2e8f0', fontSize: 12, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {c.subject}
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 6 }}>
              by <span style={{ color: '#94a3b8' }}>{c.author}</span>
              {c.parents.length > 1 && (
                <span style={{ marginLeft: 10, color: '#fbbf24' }}>↳ merge ({c.parents.length} parents)</span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export default memo(CommitNode);
