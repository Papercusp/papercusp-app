'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from '@/lib/router-compat/dynamic';
import { toast } from 'sonner';
import '@excalidraw/excalidraw/index.css';
// Points excalidraw's asset resolver at our local mirror. Without it the canvas
// pulls ~14MB of fonts from esm.sh (cdn-egress-fixes-2026-08-02 P-004).
import '@/app/_components/excalidraw-runtime';
import { useSyncQuery } from '@papercusp/sync';
import { validateEmbeddableLink } from './embeddable-policy';

type BrainstormRow = { harnessSlug: string; phase: string; content: string; canvas: unknown; mindmap: unknown; updatedAt: number };

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
  const saveRef = useRef<((s: SceneFile) => void) | undefined>(undefined);

  // Eager Zero subscription — replaces the lazy REST fetch so the canvas
  // hydrates same-frame on open instead of after a round trip.
  const { data: brainstormRows } = useSyncQuery<BrainstormRow>({
    queryName: 'harnessBrainstorm.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  const brainstormRow = useMemo(
    () => Array.isArray(brainstormRows) ? brainstormRows.find((r) => r.phase === 'staging') ?? brainstormRows[0] : undefined,
    [brainstormRows],
  );

  useEffect(() => {
    if (brainstormRows === undefined) return; // still loading
    const canvas = brainstormRow?.canvas as SceneFile | null | undefined;
    setScene(canvas ?? { elements: [], appState: {}, files: {} });
    setLoaded(true);
  }, [brainstormRow, brainstormRows]);

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

  // Force transparent canvas so the brainstorm write/map layers behind
  // this one stay visible — this surface is one of three z-stacked
  // layers sharing a single perceived workspace, not a standalone
  // whiteboard. (Excalidraw paints `viewBackgroundColor` over the
  // entire canvas; without overriding it here, even a transparent
  // wrapper div is covered by the editor's own fill.)
  const initialData = {
    ...scene,
    appState: { ...(scene.appState ?? {}), viewBackgroundColor: 'transparent' },
  };

  return (
    <div className="h-brainstorm-canvas">
      <Excalidraw
        initialData={initialData}
        theme="dark"
        UIOptions={{
          canvasActions: { export: false, saveAsImage: true, loadScene: false },
        }}
        validateEmbeddable={validateEmbeddableLink}
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
