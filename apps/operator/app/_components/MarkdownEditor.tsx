'use client';

/**
 * Vditor-backed markdown editor used across the operator's editing surfaces.
 *
 * Lifecycle invariants (the four sharp edges of any Vditor wrapper):
 *  1. Mount-effect deps are config-only — value updates never remount the editor.
 *  2. External value changes go through setValue + scroll/cursor preservation.
 *  3. `disabled` is its own effect; toggling it never recreates the instance.
 *  4. `cache: { enable: false }` so Vditor's localStorage cache doesn't mask updates.
 */

import { useEffect, useRef, useState } from 'react';
import { hardReload } from '@papercusp/operator-core/lib/hard-reload';
import { neutralizePlantuml } from './vditor-plantuml-guard';

/**
 * Inline fallback when the lazy `import('vditor')` chunk fails to load — which
 * happens when the bundle was rebuilt underneath an open page (`vite build
 * --watch` rewrites `dist/`, so the running page references a now-404'd chunk).
 * Without this the markdown pane just renders blank ("config tab not loading
 * markdown via vditor"). The global ChunkReloadPrompt also fires on the
 * `vite:preloadError`, but an inline notice with a working reload is clearer at
 * the point of use.
 */
function VditorUnavailable({
  style,
  className,
  raw,
}: {
  style?: React.CSSProperties;
  className?: string;
  /**
   * The markdown source the failed renderer would have shown. When present we
   * render it as readable preformatted text BELOW the notice, so a stale page
   * (rebuilt-bundle chunk 404) still shows the plan/doc content instead of
   * dead-ending — the Reload button upgrades to the full rendered view. The
   * content is already in hand (the `value` prop); the only thing the 404 took
   * away is the pretty renderer, not the text.
   */
  raw?: string;
}) {
  const hasRaw = typeof raw === 'string' && raw.trim().length > 0;
  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 120,
        fontSize: 13,
        color: "var(--fg-mute, #7f9bb4)",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: hasRaw ? "8px 12px" : 16,
          textAlign: "center",
          borderBottom: hasRaw
            ? "1px solid var(--border, rgba(125,211,252,0.18))"
            : undefined,
        }}
      >
        <span>
          Couldn&rsquo;t load the markdown renderer
          {hasRaw ? " — showing raw text. " : ". "}
          <span style={{ fontSize: 12 }}>
            The app was likely updated underneath this page.
          </span>
        </span>
        <button
          type="button"
          onClick={() => hardReload()}
          style={{
            padding: "4px 14px",
            fontSize: 12,
            fontWeight: 600,
            color: "#06121b",
            background: "var(--accent, #57d7ff)",
            border: 0,
            borderRadius: 6,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          Reload
        </button>
      </div>
      {hasRaw && (
        <pre
          style={{
            flex: 1,
            minHeight: 0,
            margin: 0,
            padding: 16,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--fg, #e6e6e6)",
            background: "var(--bg-1, #19232a)",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        >
          {raw}
        </pre>
      )}
    </div>
  );
}

/**
 * Where Vditor fetches its RUNTIME assets from (WI-7088).
 *
 * Vditor resolves everything it loads lazily — the Lute markdown parser, i18n,
 * toolbar icons, highlight.js, mermaid/KaTeX/echarts renderers, emoji, content
 * themes — from `options.cdn`, as `${cdn}/dist/<path>`. Its built-in default is
 * `https://unpkg.com/vditor@<version>`, so OMITTING this option silently makes
 * every cold markdown render depend on the public internet:
 *
 *     lute.min.js  3907 KB  ·  highlight.min.js  1025 KB  ·  icons  42 KB
 *     third-languages.js  21 KB  ·  en_US.js  2 KB      =  ~4.9 MB per render
 *
 * That was measured as the "opening a plan takes several seconds" bug — and
 * `lute.min.js` is a Go->WASM-transpiled blob, so it is slow to PARSE even once
 * the bytes are cached. Pointing at a local mirror makes it a localhost read and
 * makes markdown work offline.
 *
 * The mirror is `apps/operator/public/vditor/dist/**`, populated from
 * node_modules by `apps/operator/scripts/setup-vditor-runtime.sh` (postinstall +
 * operator-vite prebuild). `publicDir` is `apps/operator/public`, so it is
 * served at `/vditor/**` in dev and copied into `dist/` for prod — hence the
 * root-relative base below, matching how `/wordmark.svg` & co. resolve.
 *
 * ⚠ EVERY Vditor entry point must pass this. A surface that omits `cdn` silently
 * reverts to unpkg for its own assets and reintroduces the bug for that surface
 * only — which is why `MarkdownEditor.cdn.test.ts` asserts none of them do.
 */
export const VDITOR_CDN = '/vditor';

export type MarkdownColorScheme = "light" | "dark";

function colorChannels(value: string): [number, number, number] | null {
  const color = value.trim();
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i)?.[1];
  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((part) => `${part}${part}`)
            .join("")
        : hex;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** Resolve Vditor's binary content theme from the host's live semantic theme.
 * Portal themes name their scheme explicitly. Custom themes do not, so their
 * computed `--bg` luminance is the source of truth rather than a hard-coded id
 * list. */
export function resolveMarkdownColorScheme(
  root: HTMLElement | null = typeof document === "undefined"
    ? null
    : document.documentElement,
): MarkdownColorScheme {
  if (!root || typeof window === "undefined") return "dark";
  if (root.dataset.theme === "portal-light") return "light";
  if (root.dataset.theme === "portal-dark") return "dark";
  const styles = window.getComputedStyle(root);
  const channels = colorChannels(styles.getPropertyValue("--bg"));
  if (channels) {
    const [red, green, blue] = channels;
    return (red * 299 + green * 587 + blue * 114) / 1000 >= 160
      ? "light"
      : "dark";
  }
  const colorScheme = styles.colorScheme;
  return colorScheme.includes("light") && !colorScheme.includes("dark")
    ? "light"
    : "dark";
}

function markdownThemeInputs(): string | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  return JSON.stringify([
    document.documentElement.getAttribute('data-theme'),
    document.documentElement.getAttribute('style'),
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? null,
  ]);
}

function useMarkdownColorScheme(): MarkdownColorScheme {
  const observedInputs = useRef<string | null>(null);
  const [scheme, setScheme] = useState<MarkdownColorScheme>(() => {
    observedInputs.current = markdownThemeInputs();
    return resolveMarkdownColorScheme();
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined")
      return;
    const sync = () => {
      observedInputs.current = markdownThemeInputs();
      setScheme(resolveMarkdownColorScheme());
    };
    window.addEventListener("papercusp:theme-changed", sync);
    window.addEventListener("storage", sync);
    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(sync);
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    media?.addEventListener?.("change", sync);
    media?.addListener?.(sync);
    if (observedInputs.current !== markdownThemeInputs()) sync();
    return () => {
      window.removeEventListener("papercusp:theme-changed", sync);
      window.removeEventListener("storage", sync);
      observer?.disconnect();
      media?.removeEventListener?.("change", sync);
      media?.removeListener?.(sync);
    };
  }, []);
  return scheme;
}

// Vditor renders ```plantuml blocks by POSTING the diagram source to
// plantuml.com. `cdn` cannot redirect it (the render fn takes a cdn arg and
// ignores it), so it is intercepted in `transform` instead — see
// vditor-plantuml-guard.ts (cdn-egress-fixes-2026-08-02 P-002).

// Vditor's CSS (~45 KB / 302 rules) is loaded lazily alongside the editor
// JS. Importing it at module level pulls the whole stylesheet into every
// bundle that imports anything from this file — including consumers that
// only use the lightweight `MarkdownPreview` (banner/toast/support panels)
// and never instantiate Vditor. Diagnostic 2026-05-06: the dashboard had
// 302 vditor-* CSS rules loaded but 0 vditor DOM elements.
//
// Implementation: mounted by `loadVditorCss()` below, called once before
// the first `new Vditor(...)`. Uses `import()` so Turbopack/webpack code-
// split it into its own CSS chunk and load on demand.
let _vditorCssPromise: Promise<unknown> | null = null;
function loadVditorCss(): Promise<unknown> {
  if (!_vditorCssPromise) _vditorCssPromise = import('vditor/dist/index.css');
  return _vditorCssPromise;
}

// Warm the whole Vditor stack — the `vditor` JS chunk, its CSS chunk, and the
// one-time Lute (Go→WASM) markdown-parser init that a `Vditor.preview()` call
// triggers — AHEAD of first use, off the critical path. Measured (WI-5547): a
// COLD first plan-popup open pays ~600ms of Lute init + first-parse on top of
// the ~300–700ms React mount (~1.6s total, over the 1500ms desktop-perf
// budget); a WARM open is ~430ms. Calling this on idle from a surface that is
// about to render markdown (the Plans sidebar face) moves that cold cost off
// the click. Idempotent + best-effort: a failure resets the memo so a later
// call retries, and never surfaces (the real mount re-imports + shows its own
// VditorUnavailable fallback). The throwaway preview renders into a DETACHED
// node — no flash, no layout, no KaTeX/mermaid (minimal content) — but Lute's
// WASM instance is process-global, so the real render reuses it.
let _vditorPreloadPromise: Promise<boolean> | null = null;
export function preloadVditor(): Promise<boolean> {
  if (_vditorPreloadPromise) return _vditorPreloadPromise;
  _vditorPreloadPromise = (async () => {
    try {
      await loadVditorCss();
      const Vditor = (await import('vditor')).default;
      const warm = document.createElement('div');
      await Vditor.preview(warm, 'warm', {
        cdn: VDITOR_CDN,
        transform: neutralizePlantuml,
        // Pinned even though 'warm' contains no math (EI-19370965762703309).
        // NOT because the default is unsafe: vditor's own types document
        // `engine` as "默认值: 'KaTeX'" and its bundled defaults literally read
        // `math:{engine:"KaTeX",...}`, so an unset engine resolves to KaTeX,
        // not MathJax. The egress risk is an EXPLICIT `engine: 'MathJax'` —
        // MathJax pulls speech-rule-engine from cdn.jsdelivr.net — plus the
        // fact that a library default is not ours to rely on across upgrades.
        // Pinning here makes the property hold by construction and uniform
        // across all three entry points, so the per-entry-point guard in
        // vditor-cdn.test.ts can assert it without a special case.
        math: { engine: 'KaTeX' },
        mode: 'dark',
        lang: 'en_US',
      } as never);
      return true;
    } catch {
      _vditorPreloadPromise = null; // best-effort — allow a later retry
      return false;
    }
  })();
  return _vditorPreloadPromise;
}

export type MarkdownEditorMode = 'ir' | 'wysiwyg' | 'sv';
type VditorOptions = NonNullable<ConstructorParameters<typeof import('vditor').default>[1]>;
export type MarkdownEditorToolbar = NonNullable<VditorOptions['toolbar']>;


export interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  mode?: MarkdownEditorMode;
  readOnly?: boolean;
  /** CSS height for the editor container. Defaults to 100% of parent. */
  height?: number | string;
  /** Min height for `ir`/`wysiwyg` modes. Vditor ignores this in `sv`. */
  minHeight?: number;
  /** Override the default toolbar config. Pass [] for no toolbar. */
  toolbar?: MarkdownEditorToolbar;
  /** Show Vditor's built-in document outline panel (left or right). */
  outline?: false | 'left' | 'right';
  /** Forwarded as a className on the outer wrapper. */
  className?: string;
  /** Inline style on the outer wrapper. */
  style?: React.CSSProperties;
  placeholder?: string;
  /**
   * Fires once after the editor is fully constructed and the initial value
   * has been set. Receives the live Vditor instance. Use for surfaces that
   * need to register Lute renderers (`vditor.lute.SetJSRenderers(...)`) or
   * attach delegated event handlers to the editor element. Called with
   * `null` on unmount/destroy.
   */
  onInstance?: (instance: any | null) => void;
}

/**
 * Pre-process Obsidian-style `[[wiki-link]]` syntax into standard markdown
 * links pointing at `/wiki?target=...`. Applied in <MarkdownPreview> only;
 * editor surfaces show `[[X]]` as literal text.
 *
 *   [[knowledge]]              → [knowledge](/wiki?target=knowledge)
 *   [[sheets/knowledge]]       → [sheets/knowledge](/wiki?target=knowledge&harness=sheets)
 *   [[supervisor-notes|notes]] → [notes](/wiki?target=supervisor-notes)
 */
export function expandWikiLinks(md: string): string {
  return (md ?? '').replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, raw, label) => {
    const t = raw.trim();
    let target = t;
    let harness: string | null = null;
    const slash = t.indexOf('/');
    if (slash > 0) {
      harness = t.slice(0, slash);
      target = t.slice(slash + 1);
    }
    const display = (label ?? t).trim();
    const params = new URLSearchParams({ target });
    if (harness) params.set('harness', harness);
    return `[${display}](/wiki?${params.toString()})`;
  });
}

/**
 * Read-only renderer for markdown — uses Vditor's static `preview()` API,
 * which renders Mermaid / KaTeX / PlantUML / Echarts / flowchart inline
 * without instantiating a full editor. Drop-in replacement for
 * `<ReactMarkdown>{md}</ReactMarkdown>`. Also expands [[wiki-links]].
 *
 * @param outline When true or 'left'/'right', renders a sticky table-of-contents
 *                panel beside the rendered content using `Vditor.outlineRender`.
 */
export function MarkdownPreview({
  value,
  outline = false,
  className,
  style,
  renderers,
  onParsed,
}: {
  value: string;
  outline?: boolean | 'left' | 'right';
  className?: string;
  style?: React.CSSProperties;
  /**
   * Lute custom renderers, passed straight through to Vditor.preview's
   * documented `renderers: ILuteRender` option (per-construct overrides
   * like renderCodeSpan / renderListItem / renderText). Typed loosely
   * because vditor does not publish ILuteRender in its public types.
   * Read via ref so callers don't need to memoize.
   */
  renderers?: Record<string, unknown>;
  /**
   * Fired once with the rendered DOM after each Vditor.preview() call.
   * Used by post-render decorators (Plans admin, P-106) for DOM-walking
   * passes that don't fit the renderer protocol. Read via ref so
   * callers don't need to memoize.
   */
  onParsed?: (root: HTMLElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const renderersRef = useRef(renderers);
  renderersRef.current = renderers;
  const onParsedRef = useRef(onParsed);
  onParsedRef.current = onParsed;
  const [loadError, setLoadError] = useState(false);
  const colorScheme = useMarkdownColorScheme();
  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;
    let disposeOutline: (() => void) | undefined;
    setLoadError(false);
    (async () => {
      await loadVditorCss();
      const Vditor = (await import("vditor")).default;
      if (cancelled || !ref.current) return;
      const previewOpts: Record<string, unknown> = {
        cdn: VDITOR_CDN,
        transform: neutralizePlantuml,
        mode: colorScheme,
        theme: { current: colorScheme },
        math: { engine: "KaTeX" },
        anchor: 1,
        lang: "en_US",
      };
      if (renderersRef.current) previewOpts.renderers = renderersRef.current;
      await Vditor.preview(
        ref.current,
        expandWikiLinks(value ?? ""),
        previewOpts as never,
      );
      if (cancelled || !ref.current) return;
      try {
        onParsedRef.current?.(ref.current);
      } catch {
        /* decorator errors don't fail render */
      }
      if (outline && outlineRef.current && ref.current) {
        const outlineRoot = outlineRef.current;
        const previewRoot = ref.current;
        outlineRoot.innerHTML = "";
        Vditor.outlineRender(previewRoot, outlineRoot);

        const links = Array.from(
          outlineRoot.querySelectorAll<HTMLAnchorElement>("a"),
        );
        for (const link of links) {
          const targetId = getOutlineTargetId(link);
          const identity = `${targetId ?? ""} ${link.textContent ?? ""}`;
          link.dataset.planOutlineKind = /\bp-\d{3,}\b/i.test(identity)
            ? "item"
            : /\bd-\d{3,}\b/i.test(identity)
              ? "decision"
              : "section";
          // Vditor normally emits anchors, but keep custom-renderer entries in
          // the keyboard order even when they only carry `data-target-id`.
          link.tabIndex = 0;
        }

        const markCurrent = (active: HTMLAnchorElement) => {
          for (const link of links) {
            if (link === active) link.setAttribute("aria-current", "location");
            else link.removeAttribute("aria-current");
          }
        };

        // Vditor's standalone outlineRender attaches a click handler that does
        // `window.scrollTo(0, idElement.offsetTop)` — but our preview lives inside
        // a flex container with its own overflow, so window-level scroll is wrong.
        // Intercept and scrollIntoView() the heading instead so it scrolls
        // whichever ancestor is actually scrollable.
        const onClick = (event: Event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLAnchorElement>("a")
              : null;
          if (!target || !outlineRoot.contains(target)) return;
          const targetId = getOutlineTargetId(target);
          if (!targetId) return;
          const heading = Array.from(
            previewRoot.querySelectorAll<HTMLElement>("[id]"),
          ).find((candidate) => candidate.id === targetId);
          if (!heading) return;
          event.preventDefault();
          event.stopPropagation();
          markCurrent(target);
          heading.scrollIntoView({ block: "start", behavior: "smooth" });
        };
        outlineRoot.addEventListener("click", onClick, true);
        disposeOutline = () =>
          outlineRoot.removeEventListener("click", onClick, true);
      }
    })().catch((err: unknown) => {
      if (cancelled) return;
      // The lazy vditor chunk 404'd (bundle rebuilt underneath the page).
      // Surface a reload affordance instead of a silently blank pane.
      setLoadError(true);
      // eslint-disable-next-line no-console
      console.error("[MarkdownPreview] vditor failed to load:", err);
    });
    return () => {
      cancelled = true;
      disposeOutline?.();
    };
  }, [value, outline, colorScheme]);

  if (loadError) {
    return <VditorUnavailable className={className} style={style} raw={value} />;
  }

  if (outline) {
    const position = outline === 'right' ? 'right' : 'left';
    const outlinePanel = (
      <nav
        aria-label="Plan outline"
        className={`pc-md-outline-shell pc-md-outline-shell--${position}`}
      >
        <div className="pc-md-outline__header">
          <span>Plan outline</span>
          <span className="pc-md-outline__legend" aria-hidden="true">
            P items · D decisions
          </span>
        </div>
        <div ref={outlineRef} className="pc-md-outline" />
      </nav>
    );
    return (
      <div
        className={[
          "pc-md-preview-layout",
          `pc-md-preview-layout--outline-${position}`,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={style}
      >
        {position === "left" && outlinePanel}
        <div ref={ref} className="vditor-reset pc-md-preview" />
        {position === "right" && outlinePanel}
        <style>{`
          ${markdownPreviewOutlineCss}
          ${markdownPreviewReadableCodeCss}
        `}</style>
      </div>
    );
  }

  return (
    <>
      <div
        ref={ref}
        className={`vditor-reset pc-md-preview ${className ?? ""}`}
        style={{
          background: "var(--bg-1, #19232a)",
          color: "var(--fg, #e6e6e6)",
          ...style,
        }}
      />
      <style>{markdownPreviewReadableCodeCss}</style>
    </>
  );
}

function getOutlineTargetId(link: HTMLAnchorElement): string | null {
  const explicit = link.dataset.targetId?.trim();
  if (explicit) return explicit;
  const href = link.getAttribute("href") ?? "";
  if (!href.startsWith("#") || href.length === 1) return null;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

const markdownPreviewOutlineCss = `
  .pc-md-preview-layout {
    container-type: inline-size;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    gap: clamp(10px, 2vw, 18px);
    background: var(--bg-1, #19232a);
  }
  .pc-md-preview-layout > .pc-md-preview {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    color: var(--fg, #e6e6e6);
  }
  .pc-md-outline-shell {
    position: sticky;
    top: 0;
    align-self: flex-start;
    display: flex;
    flex: 0 0 clamp(190px, 22cqi, 248px);
    flex-direction: column;
    width: clamp(190px, 22cqi, 248px);
    max-height: min(72vh, calc(100vh - 100px));
    overflow: hidden;
    color: var(--fg-mute, #7f9bb4);
    background: color-mix(in srgb, var(--bg-2, #111b2d), transparent 8%);
    border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
    border-radius: 10px;
  }
  .pc-md-outline__header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 10px 8px;
    color: var(--fg, #e7f7ff);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.18));
  }
  .pc-md-outline__legend {
    color: var(--fg-dim, #9db5c8);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
  }
  .pc-md-outline.vditor-outline {
    display: block;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
  }
  .pc-md-outline ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pc-md-outline ul ul {
    margin-inline-start: 7px;
    padding-inline-start: 8px;
    border-inline-start: 1px solid var(--border, rgba(125, 211, 252, 0.18));
  }
  .pc-md-outline li {
    margin: 2px 0;
  }
  .pc-md-outline a {
    --pc-outline-kind: transparent;
    position: relative;
    display: block;
    padding: 4px 7px 4px 10px;
    color: var(--fg-mute, #7f9bb4);
    font-size: 12px;
    line-height: 1.4;
    text-decoration: none;
    overflow-wrap: anywhere;
    border: 1px solid transparent;
    border-radius: 6px;
  }
  .pc-md-outline a::before {
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 3px;
    width: 2px;
    content: '';
    background: var(--pc-outline-kind);
    border-radius: 999px;
  }
  .pc-md-outline a[data-plan-outline-kind='section'] {
    color: var(--fg-dim, #b9d4e8);
    font-weight: 650;
  }
  .pc-md-outline a[data-plan-outline-kind='item'] {
    --pc-outline-kind: var(--accent, #57d7ff);
  }
  .pc-md-outline a[data-plan-outline-kind='decision'] {
    --pc-outline-kind: var(--warn, #fb923c);
  }
  .pc-md-outline a:hover {
    color: var(--fg, #e7f7ff);
    background: var(--bg-3, rgba(255, 255, 255, 0.075));
  }
  .pc-md-outline a:focus-visible {
    color: var(--fg, #e7f7ff);
    background: color-mix(in srgb, var(--accent, #57d7ff) 11%, transparent);
    border-color: color-mix(in srgb, var(--accent, #57d7ff) 58%, transparent);
    outline: 2px solid color-mix(in srgb, var(--accent, #57d7ff) 56%, transparent);
    outline-offset: 1px;
  }
  .pc-md-outline a[aria-current='location'] {
    color: var(--fg, #e7f7ff);
    font-weight: 650;
    background: color-mix(in srgb, var(--accent, #57d7ff) 16%, transparent);
    border-color: color-mix(in srgb, var(--accent, #57d7ff) 36%, transparent);
  }
  .pc-md-preview-layout .pc-md-preview,
  .pc-md-preview-layout .pc-md-preview pre,
  .pc-md-preview-layout .pc-md-preview code {
    background-color: var(--bg-1, #0b1220) !important;
  }
  @container (max-width: 680px) {
    .pc-md-preview-layout {
      flex-direction: column;
    }
    .pc-md-outline-shell {
      position: relative;
      order: -1;
      width: 100%;
      max-height: none;
      flex-basis: auto;
    }
    .pc-md-outline.vditor-outline {
      max-height: 190px;
    }
  }
`;

const markdownPreviewReadableCodeCss = `
  .pc-md-preview :is(pre, pre code) {
    background: color-mix(in srgb, var(--bg-popover, #0d1829), transparent 6%) !important;
    color: var(--fg, #e7f7ff) !important;
  }
  .pc-md-preview pre {
    border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32)) !important;
    border-radius: 12px !important;
  }
  .pc-md-preview :is(code.language-yaml, code.language-yml, code.language-frontmatter, pre code:first-child) {
    color: var(--fg, #e7f7ff) !important;
  }
  .pc-md-preview :is(.hljs-attr, .hljs-attribute, .hljs-keyword, .hljs-meta) {
    color: var(--accent-strong, #7dd3fc) !important;
  }
  .pc-md-preview :is(.hljs-string, .hljs-literal, .hljs-number) {
    color: var(--fg-dim, #b9d4e8) !important;
  }
`;

const DEFAULT_TOOLBAR: MarkdownEditorToolbar = [
  'headings', 'bold', 'italic', 'strike', '|',
  'list', 'ordered-list', 'check', 'quote', '|',
  'code', 'inline-code', 'link', 'table', '|',
  'edit-mode', 'preview', 'outline', 'export',
];

export function MarkdownEditor({
  value,
  onChange,
  mode = "ir",
  readOnly = false,
  height = "100%",
  minHeight = 200,
  toolbar = DEFAULT_TOOLBAR,
  outline = false,
  className,
  style,
  placeholder,
  onInstance,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onInstanceRef = useRef(onInstance);
  onInstanceRef.current = onInstance;
  const initialValueRef = useRef(value);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const colorScheme = useMarkdownColorScheme();
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;

  // Mount: deps are config-only so value changes don't remount.
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    (async () => {
      await loadVditorCss();
      const Vditor = (await import("vditor")).default;
      if (cancelled || !containerRef.current) return;
      const initialColorScheme = colorSchemeRef.current;
      const inst = new Vditor(containerRef.current, {
        cdn: VDITOR_CDN,
        mode,
        theme: initialColorScheme === "dark" ? "dark" : "classic",
        lang: "en_US",
        cache: { enable: false },
        undoDelay: 0,
        minHeight,
        placeholder,
        toolbar,
        outline: outline
          ? { enable: true, position: outline }
          : { enable: false, position: "left" },
        preview: {
          theme: { current: initialColorScheme },
          math: { engine: "KaTeX" },
          transform: neutralizePlantuml,
        },
        input: (next: string) => onChangeRef.current?.(next),
        after: () => {
          if (cancelled) return;
          editorRef.current = inst;
          inst.setValue(initialValueRef.current ?? "");
          if (readOnly) inst.disabled();
          else inst.enable();
          // `outline.enable: true` mounts the DOM but Vditor leaves it
          // display:none after layout; force-show on the next frame so we
          // run after Vditor's own post-mount layout pass.
          //
          // Also install a click handler that scrolls the IR pane explicitly:
          // Vditor's built-in handler is bound on first render, gets re-run
          // unreliably across HMR / setValue paths, and the scroll math
          // assumes the editor is the document scroll layer (not always true
          // once we constrain it to a container).
          if (outline) {
            const wireOutline = () => {
              const panel = containerRef.current?.querySelector(
                ".vditor-outline",
              ) as HTMLElement | null;
              if (!panel) return;
              panel.style.display = "block";
              if (panel.dataset.pcOutlineWired) return;
              panel.dataset.pcOutlineWired = "1";
              panel.addEventListener(
                "click",
                (event) => {
                  let t = event.target as HTMLElement | null;
                  while (t && t !== panel) {
                    const tid = t.getAttribute?.("data-target-id");
                    if (tid) {
                      const heading = containerRef.current?.querySelector(
                        `#${CSS.escape(tid)}`,
                      ) as HTMLElement | null;
                      if (heading) {
                        event.preventDefault();
                        event.stopPropagation();
                        heading.scrollIntoView({
                          block: "start",
                          behavior: "smooth",
                        });
                      }
                      return;
                    }
                    t = t.parentElement;
                  }
                },
                true,
              );
            };
            requestAnimationFrame(() => requestAnimationFrame(wireOutline));
            setTimeout(wireOutline, 100);
            setTimeout(wireOutline, 400);
          }
          setReady(true);
          try {
            onInstanceRef.current?.(inst);
          } catch {
            /* consumer error shouldn't abort mount */
          }
        },
      });
    })().catch((err: unknown) => {
      if (cancelled) return;
      // The lazy vditor chunk 404'd (bundle rebuilt underneath the page).
      // Surface a reload affordance instead of a silently empty editor.
      setLoadError(true);
      // eslint-disable-next-line no-console
      console.error("[MarkdownEditor] vditor failed to load:", err);
    });
    return () => {
      cancelled = true;
      try {
        onInstanceRef.current?.(null);
      } catch {
        /* ignore */
      }
      try {
        editorRef.current?.destroy();
      } catch {
        /* destroy after unmount race */
      }
      editorRef.current = null;
      setReady(false);
    };
    // Only remount on config-shape changes, never on value/onChange/readOnly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, JSON.stringify(toolbar)]);

  // External value updates: setValue with scroll/cursor preservation.
  useEffect(() => {
    if (!ready || !editorRef.current) return;
    const inst = editorRef.current;
    const current = inst.getValue();
    if (current === value) return;
    const sx = window.scrollX,
      sy = window.scrollY;
    const focused = !!containerRef.current?.contains(document.activeElement);
    inst.setValue(value ?? "");
    if (!focused) {
      requestAnimationFrame(() => window.scrollTo(sx, sy));
    }
  }, [value, ready]);

  // Disabled toggle without remount.
  useEffect(() => {
    if (!ready || !editorRef.current) return;
    if (readOnly) editorRef.current.disabled();
    else editorRef.current.enable();
  }, [readOnly, ready]);

  // Update the live editor without remounting so cursor, undo, dirty, and
  // scroll state survive an operator or portal theme switch.
  useEffect(() => {
    if (!ready || !editorRef.current) return;
    editorRef.current.setTheme(
      colorScheme === "dark" ? "dark" : "classic",
      colorScheme,
    );
  }, [colorScheme, ready]);

  if (loadError) {
    return (
      <VditorUnavailable
        className={className}
        style={{ height, ...style }}
        raw={value}
      />
    );
  }

  return (
    <>
      <style>{`
        /* Vditor mounts INTO the container element and adds .vditor class names
         * to it. To get internal scrolling instead of vertical-overflow, we
         * override Vditor's inline height with !important. The .vditor-ir
         * element is the scroll container — Vditor's outline click handler
         * does \`vditor.ir.element.scrollTop = …\`, so .vditor-ir MUST be the
         * overflow:auto layer (not its inner <pre>) for outline links to work. */
        /* Vditor owns its class-level palette, but the host owns the semantic
         * surface. Apply live tokens in both classic and dark modes so a
         * theme switch never reveals a stale hard-coded strip while scrolling. */
        .pc-md-editor-host.vditor {
          --panel-background-color: var(--bg-1) !important;
          --toolbar-background-color: var(--bg-1) !important;
          --textarea-background-color: var(--bg-1) !important;
          background-color: var(--bg-1) !important;
          color: var(--fg) !important;
        }
        .pc-md-editor-host.vditor .vditor-content,
        .pc-md-editor-host.vditor .vditor-ir,
        .pc-md-editor-host.vditor .vditor-wysiwyg,
        .pc-md-editor-host.vditor .vditor-sv,
        .pc-md-editor-host.vditor .vditor-reset,
        .pc-md-editor-host.vditor .vditor-outline,
        .pc-md-editor-host.vditor .vditor-toolbar {
          background-color: var(--bg-1) !important;
          color: var(--fg) !important;
        }
        .pc-md-editor-host.vditor { display: flex !important; flex-direction: column !important; height: 100% !important; min-height: 0; }
        .pc-md-editor-host.vditor > .vditor-toolbar { flex: 0 0 auto; }
        .pc-md-editor-host.vditor > .vditor-content { flex: 1 1 0 !important; min-height: 0 !important; display: flex !important; overflow: hidden !important; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-outline { flex: 0 0 auto; max-width: 240px; overflow: auto; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-ir,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-wysiwyg,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-sv { flex: 1 1 0 !important; min-height: 0 !important; overflow: auto !important; background-color: var(--bg-2) !important; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-ir > pre,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-wysiwyg > pre,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-sv > pre { overflow: visible !important; min-height: 100%; box-sizing: border-box; }
      `}</style>
      <div
        ref={containerRef}
        className={`pc-md-editor-host ${className ?? ""}`}
        style={{ height, width: "100%", minHeight: 0, ...style }}
      />
    </>
  );
}

export default MarkdownEditor;
