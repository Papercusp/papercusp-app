/**
 * Iframe portal infrastructure — keeps iframe DOM nodes persistent
 * across dockview panel reparent (drag-to-new-group).
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §7
 *
 * Problem: dockview unmounts a panel's React tree when it moves between
 * groups. For iframe-hosted content (VSCode/code-server, Drizzle Studio,
 * plugin iframes), this drops editor state, scroll position, cursor.
 *
 * Solution: each iframe lives in a fixed off-DOM container (kept under
 * document.body so layout/style cascade still applies). When a panel
 * mounts, it ATTACHES the existing iframe DOM node to its slot. On
 * unmount it moves the node BACK to the off-DOM container — never
 * destroying it. The iframe's window/document persists, including JS
 * state and editor selection.
 *
 * Lifecycle:
 *   - getOrCreateIframe(id, src): returns the (cached) iframe, creating
 *     it under the off-DOM container on first call
 *   - attach(id, container): move iframe DOM node into container
 *   - detach(id): move iframe back to off-DOM container
 *   - destroy(id): remove the iframe entirely (panel closed)
 */

'use client';

const REGISTRY = new Map<string, HTMLIFrameElement>();
let offDomContainer: HTMLDivElement | null = null;

function getOffDomContainer(): HTMLDivElement {
  if (!offDomContainer) {
    if (typeof document === 'undefined') {
      throw new Error('iframe-host requires browser environment');
    }
    offDomContainer = document.createElement('div');
    offDomContainer.id = 'papercusp-iframe-host';
    // Off-screen, but in document so style cascade + JS keeps running.
    offDomContainer.style.cssText =
      'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
    document.body.appendChild(offDomContainer);
  }
  return offDomContainer;
}

export interface IframeOptions {
  /** Initial src URL. Only used when the iframe is first created. */
  src: string;
  /** Sandbox attribute (optional). */
  sandbox?: string;
  /** Allow attribute (e.g. 'clipboard-read; clipboard-write'). */
  allow?: string;
  /** Title for accessibility. */
  title?: string;
}

/**
 * Returns the iframe for `id`, creating it under the off-DOM container
 * on first call. Subsequent calls return the same node.
 */
export function getOrCreateIframe(
  id: string,
  options: IframeOptions,
): HTMLIFrameElement {
  let f = REGISTRY.get(id);
  if (f) return f;
  f = document.createElement('iframe');
  f.dataset.iframeHostId = id;
  f.src = options.src;
  if (options.sandbox) f.setAttribute('sandbox', options.sandbox);
  if (options.allow) f.setAttribute('allow', options.allow);
  if (options.title) f.title = options.title;
  f.style.cssText = 'width:100%;height:100%;border:0;display:block;';
  getOffDomContainer().appendChild(f);
  REGISTRY.set(id, f);
  return f;
}

/**
 * Move iframe DOM node into the given container element. Idempotent.
 * If the iframe doesn't exist yet, this is a no-op.
 */
export function attach(id: string, container: HTMLElement): void {
  const f = REGISTRY.get(id);
  if (!f || f.parentElement === container) return;
  container.appendChild(f);
}

/**
 * Move iframe back to the off-DOM container. Used on panel unmount so
 * the React component can teardown without destroying the iframe.
 */
export function detach(id: string): void {
  const f = REGISTRY.get(id);
  if (!f) return;
  if (f.parentElement !== getOffDomContainer()) {
    getOffDomContainer().appendChild(f);
  }
}

/**
 * Permanently destroy the iframe (panel closed for good).
 */
export function destroy(id: string): void {
  const f = REGISTRY.get(id);
  if (f) {
    f.remove();
    REGISTRY.delete(id);
  }
}

/** For tests + memory inspection. */
export function _registrySize(): number {
  return REGISTRY.size;
}

/** For tests — wipe state between cases. */
export function _resetForTests(): void {
  for (const f of REGISTRY.values()) f.remove();
  REGISTRY.clear();
  if (offDomContainer) {
    offDomContainer.remove();
    offDomContainer = null;
  }
}
