'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Pencil, Network, PencilRuler, MessageSquare } from 'lucide-react';

const WriteView = dynamic(() => import('./WriteView').then((m) => m.WriteView), { ssr: false });
const MapView = dynamic(() => import('./MapView').then((m) => m.MapView), { ssr: false });
const CanvasView = dynamic(() => import('./CanvasView').then((m) => m.CanvasView), { ssr: false });
const BrainstormChat = dynamic(() => import('./BrainstormChat'), { ssr: false });

type SubTab = 'write' | 'map' | 'canvas';

export function BrainstormPanel({ slug }: { slug: string }) {
  const [sub, setSub] = useState<SubTab>('write');
  const [md, setMd] = useState('');
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div className="h-panel" style={{ height: '100%' }}>
      <div className="h-panel-head">
        <span className="h-panel-title">brainstorm</span>
        <div className="h-brainstorm-subtabs">
          {[
            { id: 'write' as const, icon: Pencil, label: 'write' },
            { id: 'map' as const, icon: Network, label: 'map' },
            { id: 'canvas' as const, icon: PencilRuler, label: 'canvas' },
          ].map((t) => (
            <button
              key={t.id}
              className={`h-sub${sub === t.id ? ' on' : ''}`}
              onClick={() => setSub(t.id)}
              title={t.label}
              aria-label={t.label}
            >
              <t.icon size={12} />
            </button>
          ))}
        </div>
        <div className="h-panel-actions">
          <button
            className={`h-btn-icon${chatOpen ? ' on' : ''}`}
            onClick={() => setChatOpen((v) => !v)}
            title={chatOpen ? 'Hide chat' : 'Show chat'}
          >
            <MessageSquare size={11} />
          </button>
        </div>
      </div>
      <div className="h-brainstorm-body">
        <div className="h-brainstorm-main" style={{ flex: chatOpen ? '1 1 auto' : '1 1 100%' }}>
          {sub === 'write' && <WriteView slug={slug} onMarkdownChange={setMd} />}
          {sub === 'map' && <MapView markdown={md} />}
          {sub === 'canvas' && <CanvasView slug={slug} />}
        </div>
        {chatOpen && (
          <div className="h-brainstorm-chat">
            <BrainstormChat slug={slug} />
          </div>
        )}
      </div>
    </div>
  );
}
