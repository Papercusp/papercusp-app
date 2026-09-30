'use client';

/**
 * P-202 edit-mode decorations for the IR pane.
 *
 * Registered via `vditor.vditor.lute.SetJSRenderers({ renderers: {
 * Md2VditorIRDOM: { ... } } })` on the live editor instance. Confirmed
 * empirically (P-001 spike, D-003 primary path) to re-apply on every
 * IR re-spin in vditor 3.11.2 — no DOM observer, no post-process
 * pass.
 *
 * Selective override pattern:
 *
 *   - Status-enum code spans → emit `<code data-plan-status="X"
 *     class="pc-plan-status pc-plan-status--X">X</code>` with
 *     `WalkSkipChildren` so Lute does not also fire the per-marker
 *     sub-renderers (which would compose into broken HTML).
 *   - Non-status code spans → return `["", WalkContinue]` to fall
 *     through to vditor's default codeSpan render (which preserves IR-
 *     specific markers like `data-newline`).
 *
 * Item-ID anchors (`data-plan-item`) and bare `P-NNN`/`D-NNN` ref
 * wrapping are NOT applied in edit mode for v1 — list items in IR
 * carry inline markdown markers that the default renderer composes,
 * and a wholesale `renderListItem` override would lose them. The
 * read-mode path keeps those decorations; edit mode focuses on the
 * one decoration that earns its keep for editing — the clickable
 * status pill (paired with P-203's status-flip popover).
 */

const STATUS_TOKEN_RE = /^(todo|wip|blocked|needs-human|done|dropped)$/;

type Walk = { Continue: number; SkipChildren: number; Stop: number };

type LuteRenderCallback = (node: any, entering: boolean) => [string, number];

export type PlanIRRenderers = {
  renderCodeSpan: LuteRenderCallback;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildPlanIRRenderers(walk: Walk): PlanIRRenderers {
  const { Continue, SkipChildren } = walk;
  return {
    renderCodeSpan(node, entering) {
      if (!entering) return ['', Continue];
      let content = '';
      try {
        content = typeof node.Content === 'function' ? node.Content() : '';
      } catch {
        return ['', Continue];
      }
      if (!STATUS_TOKEN_RE.test(content)) {
        return ['', Continue];
      }
      const safe = escapeHtml(content);
      return [
        `<code data-plan-status="${safe}" class="pc-plan-status pc-plan-status--${safe}">${safe}</code>`,
        SkipChildren,
      ];
    },
  };
}

/**
 * Read the `Lute.Walk*` constants from the global `window.Lute` class.
 * The constants live on the class, not the per-vditor instance.
 */
export function readLuteWalk(): Walk | null {
  const Lute = (globalThis as any).Lute;
  if (!Lute) return null;
  const Continue = typeof Lute.WalkContinue === 'number' ? Lute.WalkContinue : 0;
  const SkipChildren = typeof Lute.WalkSkipChildren === 'number' ? Lute.WalkSkipChildren : 1;
  const Stop = typeof Lute.WalkStop === 'number' ? Lute.WalkStop : 2;
  return { Continue, SkipChildren, Stop };
}

/**
 * Attach a delegated click handler to the IR pane that intercepts
 * `[data-plan-status]` clicks. Returns a teardown.
 *
 * The handler is the wire for P-203 (status-flip popover); for now
 * it merely calls back into the consumer with the target element and
 * its current status. The consumer (PlanEditor) opens the popover.
 */
export function attachStatusClickHandler(
  root: HTMLElement,
  onStatusClick: (target: HTMLElement, status: string) => void,
): () => void {
  const handler = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const code = target?.closest('[data-plan-status]') as HTMLElement | null;
    if (!code) return;
    const status = code.dataset.planStatus;
    if (!status) return;
    event.preventDefault();
    event.stopPropagation();
    onStatusClick(code, status);
  };
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}
