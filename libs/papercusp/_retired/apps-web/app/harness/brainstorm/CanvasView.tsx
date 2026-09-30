'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import '@excalidraw/excalidraw/index.css';

const Excalidraw = dynamic(
  async () => (await import('@excalidraw/excalidraw')).Excalidraw,
  { ssr: false, loading: () => <div className="h-empty">loading canvas…</div> },
);

interface SceneFile {
  elements: readonly any[];
  appState: Record<string, any>;
  files?: Record<string, any>;
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...a: any[]) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

interface Props { slug: string }

export function CanvasView({ slug }: Props) {
  const [scene, setScene] = useState<SceneFile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const saveRef = useRef<(s: SceneFile) => void>();

  useEffect(() => {
    let aborted = false;
    fetch(`/api/harness/${slug}/brainstorm-canvas`)
      .then((r) => r.json())
      .then((d) => {
        if (aborted) return;
        setScene(d.scene ?? { elements: [], appState: {}, files: {} });
        setLoaded(true);
      })
      .catch((e) => toast.error(`Canvas load failed: ${e}`));
    return () => { aborted = true; };
  }, [slug]);

  useEffect(() => {
    saveRef.current = debounce(async (s: SceneFile) => {
      try {
        await fetch(`/api/harness/${slug}/brainstorm-canvas`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scene: s }),
        });
      } catch (e: any) {
        toast.error(`Canvas save failed: ${e?.message ?? e}`);
      }
    }, 1200);
  }, [slug]);

  if (!loaded || !scene) return <div className="h-empty">loading canvas…</div>;

  return (
    <div className="h-brainstorm-canvas">
      <Excalidraw
        initialData={scene}
        theme="dark"
        UIOptions={{
          canvasActions: { export: false, saveAsImage: true, loadScene: false },
        }}
        onChange={(elements: readonly any[], appState: any, files: any) => {
          // Strip volatile appState fields that don't need persisting
          const trimmedAppState = {
            viewBackgroundColor: appState.viewBackgroundColor,
            gridSize: appState.gridSize,
            zoom: appState.zoom,
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
          };
          saveRef.current?.({ elements, appState: trimmedAppState, files });
        }}
      />
    </div>
  );
}
