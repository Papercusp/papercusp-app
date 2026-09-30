/**
 * IframePanel — generic panel wrapper that hosts an iframe via the
 * iframe-host portal pattern. Use this for any panel whose state must
 * survive drag-reparent (VSCode/code-server, Drizzle Studio, plugin
 * iframes).
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §7
 */

'use client';

import { useEffect, useRef } from 'react';
import { attach, detach, getOrCreateIframe } from './iframe-host';
import type { PanelComponentProps } from './panel-registry';

export interface IframePanelParams {
  src: string;
  sandbox?: string;
  allow?: string;
  title?: string;
}

export function IframePanel(props: PanelComponentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const params = (props.params ?? {}) as Partial<IframePanelParams>;
  const src = params.src;
  if (!src) {
    return (
      <div style={{ padding: 16, color: '#f99', fontSize: 13 }}>
        IframePanel missing required `params.src`
      </div>
    );
  }
  // Stable iframe id keyed by panel id (NOT src — same panel surviving
  // a navigation should keep its iframe; different panels get different
  // iframes even for the same src).
  const iframeId = props.panelId;

  useEffect(() => {
    if (!containerRef.current) return;
    // Create on first mount.
    getOrCreateIframe(iframeId, {
      src,
      sandbox: params.sandbox,
      allow: params.allow,
      title: params.title ?? props.panelType,
    });
    attach(iframeId, containerRef.current);
    return () => {
      // On unmount (including drag-reparent), move iframe back to
      // off-DOM container. The iframe is NOT destroyed; another
      // mount picks it up. Destroy is called explicitly by the dock
      // when the panel is closed.
      detach(iframeId);
    };
    // src/sandbox/allow can change for different panel instances; the
    // iframe is keyed by panelId though, so we don't recreate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeId]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', display: 'flex' }}
      aria-label={params.title ?? `${props.panelType} content`}
    />
  );
}
