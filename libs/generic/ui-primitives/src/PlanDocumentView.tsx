'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

/** Minimal plan-item shape needed by the shared read surface. */
export interface PlanDocumentItem {
  id: string;
  text?: string;
  storedStatus?: string;
  effectiveStatus?: string;
}

/** Minimal decision shape needed by jump search. */
export interface PlanDocumentDecision {
  id: string;
  title?: string | null;
}

export interface PlanDocumentCandidate {
  id: string;
  label: string;
  hint: string;
  kind: 'item' | 'decision';
}

export type PlanDocumentTheme = 'dark' | 'light';

function planDocumentColorChannels(
  value: string,
): [number, number, number] | null {
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

/** Resolve Vditor's binary content theme from any host's live semantic theme.
 * Portal hosts use light/dark, operator hosts use named themes, and system mode
 * may use neither; the computed --bg channel is the common source of truth. */
export function resolvePlanDocumentTheme(
  root: HTMLElement | null = typeof document === "undefined"
    ? null
    : document.documentElement,
): PlanDocumentTheme {
  if (!root || typeof window === "undefined") return "dark";
  const named = root.dataset.theme;
  if (named === "light" || named === "portal-light") return "light";
  if (named === "dark" || named === "portal-dark") return "dark";
  const styles = window.getComputedStyle(root);
  const channels = planDocumentColorChannels(styles.getPropertyValue("--bg"));
  if (channels) {
    const [red, green, blue] = channels;
    return (red * 299 + green * 587 + blue * 114) / 1000 >= 160
      ? "light"
      : "dark";
  }
  const colorScheme = styles.colorScheme;
  if (colorScheme.includes("light") && !colorScheme.includes("dark"))
    return "light";
  return typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "light"
    : "dark";
}

// Reading attributes/media does not force style resolution across the newly
// mounted plan. Keep the render-to-subscription race covered without repeating
// getComputedStyle during every unchanged mount commit.
function planThemeInputs(): string | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  return JSON.stringify([
    document.documentElement.getAttribute('data-theme'),
    document.documentElement.getAttribute('style'),
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? null,
  ]);
}

function usePlanDocumentTheme(
  explicitTheme?: PlanDocumentTheme,
): PlanDocumentTheme {
  const observedInputs = useRef<string | null>(null);
  const [theme, setTheme] = useState<PlanDocumentTheme>(() => {
    observedInputs.current = planThemeInputs();
    return explicitTheme ?? resolvePlanDocumentTheme();
  });

  useEffect(() => {
    if (explicitTheme) {
      observedInputs.current = null;
      setTheme(explicitTheme);
      return;
    }
    if (typeof window === "undefined" || typeof document === "undefined")
      return;
    const sync = () => {
      observedInputs.current = planThemeInputs();
      setTheme(resolvePlanDocumentTheme());
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
    if (observedInputs.current !== planThemeInputs()) sync();
    return () => {
      window.removeEventListener("papercusp:theme-changed", sync);
      window.removeEventListener("storage", sync);
      observer?.disconnect();
      media?.removeEventListener?.("change", sync);
      media?.removeListener?.(sync);
    };
  }, [explicitTheme]);

  return explicitTheme ?? theme;
}

export interface PlanDocumentViewProps {
  /** Complete plan markdown. Leading frontmatter is stripped when metadata is supplied. */
  value: string;
  slug?: string;
  frontmatter?: Record<string, unknown>;
  items?: readonly PlanDocumentItem[];
  decisions?: readonly PlanDocumentDecision[];
  outline?: 'left' | 'right' | false;
  /** The host may already render these controls around the document. */
  showJump?: boolean;
  showFrontmatter?: boolean;
  /** Root-relative Vditor runtime mirror. Must be supplied by the host app. */
  assetBaseUrl?: string;
  theme?: PlanDocumentTheme;
  className?: string;
  style?: CSSProperties;
  /** Host-specific decorators run after the shared plan decorations. */
  onParsed?: (root: HTMLElement) => void;
  /** Optional diagnostics. Content-ready includes host data retrieval + React mount;
   * styles-ready follows CSS loading; renderer-ready follows JS loading;
   * preview-rendered precedes decoration. */
  onRenderPhase?: (phase: 'content-ready' | 'styles-ready' | 'renderer-ready' | 'preview-rendered') => void;
}

const STATUS_TOKEN_RE = /^(todo|wip|blocked|needs-human|done|dropped)$/;
const PLAN_ID_RE = /^[PD]-\d{3,}$/;
const PLAN_REF_RE = /\b([PD]-\d{3,})\b/g;
const MAX_JUMP_HITS = 8;

export const PLANTUML_NEUTRALIZED_CLASS = 'language-plantuml-neutralized';

/**
 * Vditor's PlantUML adapter posts diagram source to plantuml.com. Its transform
 * hook runs first, so rename the selector the adapter searches for and fail
 * closed while keeping the source readable as a code block.
 */
export function neutralizePlanDocumentPlantuml(html: string): string {
  return html.replace(/language-plantuml(?![\w-])/g, PLANTUML_NEUTRALIZED_CLASS);
}

/** Expand Obsidian-style wiki links without coupling the viewer to a router. */
export function expandPlanDocumentWikiLinks(markdown: string): string {
  return (markdown ?? '').replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_match, raw, label) => {
    const requested = String(raw).trim();
    const slash = requested.indexOf('/');
    const harness = slash > 0 ? requested.slice(0, slash) : null;
    const target = slash > 0 ? requested.slice(slash + 1) : requested;
    const params = new URLSearchParams({ target });
    if (harness) params.set('harness', harness);
    return `[${String(label ?? requested).trim()}](/wiki?${params.toString()})`;
  });
}

/** Remove one leading YAML frontmatter block from canonical plan markdown. */
export function stripPlanFrontmatter(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  return match ? source.slice(match[0].length) : source;
}

/** Decorate Vditor output with status pills, item anchors, badges, and refs. */
export function decoratePlanDocumentDom(
  root: HTMLElement,
  items: readonly PlanDocumentItem[] | undefined,
): void {
  const byId = new Map<string, PlanDocumentItem>();
  for (const item of items ?? []) byId.set(item.id, item);

  for (const code of Array.from(root.querySelectorAll<HTMLElement>('code'))) {
    if (code.dataset.planStatus || code.closest('pre')) continue;
    const status = (code.textContent ?? '').trim();
    if (!STATUS_TOKEN_RE.test(status)) continue;
    code.dataset.planStatus = status;
    code.classList.add('pc-plan-status', `pc-plan-status--${status}`);
  }

  for (const itemElement of Array.from(root.querySelectorAll<HTMLElement>('li'))) {
    if (itemElement.dataset.planItem) continue;
    const firstStrong =
      itemElement.querySelector<HTMLElement>(':scope > strong') ??
      itemElement.querySelector<HTMLElement>(':scope > p > strong');
    if (!firstStrong) continue;
    const id = (firstStrong.textContent ?? '').trim();
    if (!PLAN_ID_RE.test(id)) continue;
    itemElement.dataset.planItem = id;

    const item = byId.get(id);
    if (
      !item?.storedStatus ||
      !item.effectiveStatus ||
      item.effectiveStatus === item.storedStatus
    ) {
      continue;
    }
    const statusCode = itemElement.querySelector<HTMLElement>(
      `code[data-plan-status="${item.storedStatus}"]`,
    );
    const anchor = statusCode ?? firstStrong;
    if (anchor.nextElementSibling?.classList.contains('pc-plan-badge')) continue;
    const badge = document.createElement('sup');
    badge.className = `pc-plan-badge pc-plan-badge--${item.effectiveStatus}`;
    badge.textContent = item.effectiveStatus;
    badge.title = `effective: ${item.effectiveStatus} (stored: ${item.storedStatus})`;
    anchor.after(badge);
  }

  wrapPlanDocumentRefs(root);
}

function wrapPlanDocumentRefs(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('a, code, pre, .pc-plan-ref')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (
        parent.tagName === 'STRONG' &&
        parent.parentElement?.closest('li[data-plan-item]')
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      PLAN_REF_RE.lastIndex = 0;
      const hit = PLAN_REF_RE.test(node.nodeValue ?? '');
      PLAN_REF_RE.lastIndex = 0;
      return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    targets.push(node as Text);
  }

  for (const text of targets) {
    const value = text.nodeValue ?? '';
    PLAN_REF_RE.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = PLAN_REF_RE.exec(value)) !== null) {
      if (match.index > last) {
        fragment.appendChild(document.createTextNode(value.slice(last, match.index)));
      }
      const id = match[1] ?? '';
      const anchor = document.createElement('a');
      anchor.className = 'pc-plan-ref';
      anchor.dataset.planRef = id;
      anchor.textContent = id;
      anchor.href = `#${id}`;
      fragment.appendChild(anchor);
      last = match.index + match[0].length;
    }
    if (last < value.length) fragment.appendChild(document.createTextNode(value.slice(last)));
    text.replaceWith(fragment);
  }
}

export function findPlanDocumentHeading(scope: HTMLElement, id: string): HTMLElement | null {
  for (const heading of Array.from(scope.querySelectorAll<HTMLElement>('h3'))) {
    if ((heading.textContent ?? '').trim().startsWith(id)) return heading;
  }
  return null;
}

/** Scroll to a P-NNN item or D-NNN decision and briefly highlight it. */
export function scrollPlanDocumentTarget(scope: HTMLElement | null, id: string): boolean {
  if (!scope || !PLAN_ID_RE.test(id)) return false;
  const destination = id.startsWith('P-')
    ? scope.querySelector<HTMLElement>(`[data-plan-item="${id}"]`)
    : scope.querySelector<HTMLElement>(`#${id}`) ?? findPlanDocumentHeading(scope, id);
  if (!destination) return false;
  destination.scrollIntoView({ block: 'center', behavior: 'smooth' });
  destination.classList.add('pc-plan-highlight');
  globalThis.setTimeout(() => destination.classList.remove('pc-plan-highlight'), 1500);
  return true;
}

/** Install one delegated click listener for all rendered P-NNN/D-NNN refs. */
export function attachPlanDocumentRefClickHandler(root: HTMLElement): () => void {
  const handler = (event: Event) => {
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-plan-ref]');
    const id = anchor?.dataset.planRef;
    if (!id) return;
    event.preventDefault();
    scrollPlanDocumentTarget(root, id);
  };
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}

/** Exact ID, then ID prefix, then ID/text substring; capped for a compact list. */
export function rankPlanDocumentCandidates(
  candidates: readonly PlanDocumentCandidate[],
  query: string,
): PlanDocumentCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const exact: PlanDocumentCandidate[] = [];
  const prefix: PlanDocumentCandidate[] = [];
  const substring: PlanDocumentCandidate[] = [];
  for (const candidate of candidates) {
    const id = candidate.id.toLowerCase();
    const hint = candidate.hint.toLowerCase();
    if (id === normalized) exact.push(candidate);
    else if (id.startsWith(normalized)) prefix.push(candidate);
    else if (id.includes(normalized) || hint.includes(normalized)) substring.push(candidate);
  }
  return [...exact, ...prefix, ...substring].slice(0, MAX_JUMP_HITS);
}

export function PlanDocumentJump({
  items,
  decisions,
  scopeRef,
}: {
  items?: readonly PlanDocumentItem[];
  decisions?: readonly PlanDocumentDecision[];
  scopeRef: RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const candidates = useMemo<PlanDocumentCandidate[]>(() => [
    ...(items ?? []).map((item) => ({
      id: item.id,
      label: item.id,
      hint: item.text ?? '',
      kind: 'item' as const,
    })),
    ...(decisions ?? []).map((decision) => ({
      id: decision.id,
      label: decision.id,
      hint: decision.title ?? '',
      kind: 'decision' as const,
    })),
  ], [items, decisions]);
  const hits = useMemo(
    () => rankPlanDocumentCandidates(candidates, query),
    [candidates, query],
  );

  useEffect(() => setActive(0), [query]);

  const jumpTo = useCallback((id: string) => {
    if (!scrollPlanDocumentTarget(scopeRef.current, id)) return;
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }, [scopeRef]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setQuery('');
      setOpen(false);
      return;
    }
    if (!hits.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % hits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = hits[active] ?? hits[0];
      if (hit) jumpTo(hit.id);
    }
  }, [active, hits, jumpTo]);

  const expanded = open && hits.length > 0;
  return (
    <div className="pc-jump" data-open={expanded ? 'true' : 'false'}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        className="pc-jump__input"
        placeholder={candidates.length ? 'Jump to P-001, decision, or item text…' : 'No items in this plan'}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => globalThis.setTimeout(() => setOpen(false), 120)}
        onKeyDown={handleKeyDown}
        disabled={!candidates.length}
        aria-label="Jump to item"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
      />
      {expanded ? (
        <ul id={listId} className="pc-jump__hits" role="listbox">
          {hits.map((hit, index) => (
            <li
              id={`${listId}-${index}`}
              key={`${hit.kind}-${hit.id}`}
              className={`pc-jump__hit ${index === active ? 'is-active' : ''}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                jumpTo(hit.id);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span className={`pc-jump__id pc-jump__id--${hit.kind}`}>{hit.label}</span>
              <span className="pc-jump__hint">{hit.hint}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatFrontmatterScalar(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    const iso = value.toISOString();
    return /T00:00:00\.000Z$/.test(iso) ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    const parts = value.map(formatFrontmatterScalar).filter((part): part is string => part !== null);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/** Compact metadata card shared by full plan-document readers. */
export function PlanDocumentFrontmatter({
  slug,
  frontmatter,
}: {
  slug?: string;
  frontmatter: Record<string, unknown>;
}) {
  const rows: Array<[string, string]> = [];
  const add = (label: string, value: unknown) => {
    const formatted = formatFrontmatterScalar(value);
    if (formatted !== null) rows.push([label, formatted]);
  };
  add('slug', frontmatter.slug ?? slug);
  add('status', frontmatter.status);
  add('created', frontmatter.created);
  add('updated', frontmatter.updated);
  add('owner', frontmatter.owner);
  for (const key of Object.keys(frontmatter)) {
    if (['title', 'slug', 'status', 'created', 'updated', 'owner'].includes(key)) continue;
    add(key, frontmatter[key]);
  }
  if (!rows.length) return null;
  return (
    <section className="pc-plan-fm" aria-label="Plan metadata">
      <dl className="pc-plan-fm__grid">
        {rows.map(([label, value]) => (
          <div className="pc-plan-fm__row" key={label}>
            <dt className="pc-plan-fm__key">{label}</dt>
            <dd className="pc-plan-fm__val">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

let vditorCssPromise: Promise<unknown> | null = null;
function loadVditorCss(): Promise<unknown> {
  if (!vditorCssPromise) vditorCssPromise = import('vditor/dist/index.css');
  return vditorCssPromise;
}

/**
 * Foreground and background for the raw-text fallback, ALWAYS returned as a
 * pair from one theme decision.
 *
 * This exists because splitting the two is how the fallback silently became
 * unreadable (WI-39341): the stylesheet hardcoded a dark `background:#19232A`
 * but took `color: var(--fg)` from the host, so on a light-themed host the
 * pair disagreed — measured at roughly 1.1:1 contrast, i.e. invisible. A
 * failed renderer then looked like a broken button rather than a degraded one.
 * Returning both halves together makes that class of desync unrepresentable.
 */
export function planDocumentFallbackSurface(theme: PlanDocumentTheme): {
  background: string;
  color: string;
} {
  return theme === 'dark'
    ? { background: '#19232A', color: '#e6e6e6' }
    : { background: '#f3f1ed', color: '#28231f' };
}

function PlanDocumentFallback({ value, theme }: { value: string; theme: PlanDocumentTheme }) {
  return (
    <div className="pc-plan-document__fallback" role="status">
      <p>Couldn&rsquo;t load the plan renderer — showing raw text.</p>
      <pre style={planDocumentFallbackSurface(theme)}>{value}</pre>
    </div>
  );
}

/**
 * Complete read-only plan document surface. The host supplies the Vditor asset
 * mirror and styling; the shared component supplies rendering behavior.
 */
export function PlanDocumentView({
  value,
  slug,
  frontmatter,
  items,
  decisions,
  outline = "left",
  showJump = true,
  showFrontmatter = true,
  assetBaseUrl = "/vditor",
  theme,
  className,
  style,
  onParsed,
  onRenderPhase,
}: PlanDocumentViewProps) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const onParsedRef = useRef(onParsed);
  onParsedRef.current = onParsed;
  const onRenderPhaseRef = useRef(onRenderPhase);
  onRenderPhaseRef.current = onRenderPhase;
  const [loadError, setLoadError] = useState(false);
  const resolvedTheme = usePlanDocumentTheme(theme);
  const body = frontmatter ? stripPlanFrontmatter(value) : value;

  // Begin visual preparation in the document's commit, before the browser
  // paints an empty preview. A passive effect waits until after that paint
  // (and any other queued work). Asset loading remains asynchronous; completion
  // and cancellation still follow the actual Vditor render below.
  useLayoutEffect(() => {
    if (!previewRef.current) return;
    let cancelled = false;
    let detachRefs = () => {};
    let detachOutline = () => {};
    setLoadError(false);

    const reportPhase = (phase: 'content-ready' | 'styles-ready' | 'renderer-ready' | 'preview-rendered') => {
      try { onRenderPhaseRef.current?.(phase); } catch { /* diagnostics cannot fail rendering */ }
    };
    (async () => {
      reportPhase('content-ready');
      await loadVditorCss();
      if (cancelled || !previewRef.current) return;
      reportPhase('styles-ready');
      const Vditor = (await import("vditor")).default;
      if (cancelled || !previewRef.current) return;
      reportPhase('renderer-ready');
      await Vditor.preview(
        previewRef.current,
        expandPlanDocumentWikiLinks(body),
        {
          cdn: assetBaseUrl,
          transform: neutralizePlanDocumentPlantuml,
          mode: resolvedTheme,
          theme: { current: resolvedTheme },
          math: { engine: "KaTeX" },
          anchor: 1,
          lang: "en_US",
        } as never,
      );
      if (cancelled || !previewRef.current) return;

      reportPhase('preview-rendered');
      decoratePlanDocumentDom(previewRef.current, items);
      detachRefs = attachPlanDocumentRefClickHandler(previewRef.current);
      try {
        onParsedRef.current?.(previewRef.current);
      } catch {
        // A host decoration cannot make the underlying document unreadable.
      }

      if (outline && outlineRef.current) {
        const outlineRoot = outlineRef.current;
        const previewRoot = previewRef.current;
        outlineRoot.innerHTML = "";
        Vditor.outlineRender(previewRoot, outlineRoot);

        const topLevelList =
          outlineRoot.querySelector<HTMLUListElement>(":scope > ul") ??
          outlineRoot.appendChild(document.createElement("ul"));
        const representedItems = new Set<string>();
        for (const target of Array.from(
          outlineRoot.querySelectorAll<HTMLElement>("[data-target-id]"),
        )) {
          const identity = `${target.dataset.targetId ?? ""} ${target.textContent ?? ""}`;
          const itemId = identity.match(/\b(P-\d{3,})\b/i)?.[1]?.toUpperCase();
          if (itemId) representedItems.add(itemId);
        }

        const missingItems = (items ?? []).filter(
          (item) => PLAN_ID_RE.test(item.id) && !representedItems.has(item.id),
        );
        if (missingItems.length > 0) {
          const group = document.createElement("li");
          group.className = "pc-md-outline__group";
          const label = document.createElement("div");
          label.className = "pc-md-outline__group-label";
          label.textContent = "Plan items";
          group.appendChild(label);
          const list = document.createElement("ul");
          for (const item of missingItems) {
            const row = document.createElement("li");
            const anchor = document.createElement("a");
            anchor.href = `#${item.id}`;
            anchor.dataset.targetId = item.id;
            anchor.dataset.planOutlineKind = "item";
            const id = document.createElement("span");
            id.className = "pc-md-outline__item-id";
            id.textContent = item.id;
            anchor.appendChild(id);
            if (item.text?.trim()) {
              const summary = document.createElement("span");
              summary.className = "pc-md-outline__item-summary";
              summary.textContent = item.text.trim();
              anchor.appendChild(summary);
            }
            row.appendChild(anchor);
            list.appendChild(row);
          }
          group.appendChild(list);
          const decisionsSection = Array.from(topLevelList.children).find(
            (child) =>
              child
                .querySelector<HTMLElement>(":scope > [data-target-id]")
                ?.dataset.targetId?.toLowerCase() === "decisions",
          );
          topLevelList.insertBefore(group, decisionsSection ?? null);
        }

        const targets = Array.from(
          outlineRoot.querySelectorAll<HTMLElement>("[data-target-id]"),
        );
        for (const target of targets) {
          const identity = `${target.dataset.targetId ?? ""} ${target.textContent ?? ""}`;
          target.dataset.planOutlineKind = /\bP-\d{3,}\b/i.test(identity)
            ? "item"
            : /\bD-\d{3,}\b/i.test(identity)
              ? "decision"
              : "section";
          if (target.tagName !== "A" && target.tagName !== "BUTTON") {
            target.setAttribute("role", "link");
          }
          target.tabIndex = 0;
        }

        const markCurrent = (active: HTMLElement) => {
          for (const target of targets) {
            if (target === active)
              target.setAttribute("aria-current", "location");
            else target.removeAttribute("aria-current");
          }
        };

        const activateOutlineTarget = (target: HTMLElement, event: Event) => {
          const targetId = target.dataset.targetId;
          if (!targetId) return;
          const destination = PLAN_ID_RE.test(targetId)
            ? targetId.startsWith("P-")
              ? Array.from(
                  previewRoot.querySelectorAll<HTMLElement>("[data-plan-item]"),
                ).find((element) => element.dataset.planItem === targetId)
              : (previewRoot.querySelector<HTMLElement>(`#${targetId}`) ??
                findPlanDocumentHeading(previewRoot, targetId))
            : Array.from(
                previewRoot.querySelectorAll<HTMLElement>("[id]"),
              ).find((element) => element.id === targetId);
          if (!destination) return;
          event.preventDefault();
          event.stopPropagation();
          markCurrent(target);
          destination.scrollIntoView({ block: "start", behavior: "smooth" });
        };

        const handleOutlineClick = (event: Event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-target-id]")
              : null;
          if (target && outlineRoot.contains(target)) {
            activateOutlineTarget(target, event);
          }
        };
        const handleOutlineKeyDown = (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-target-id]")
              : null;
          if (target && outlineRoot.contains(target)) {
            activateOutlineTarget(target, event);
          }
        };
        outlineRoot.addEventListener("click", handleOutlineClick, true);
        outlineRoot.addEventListener("keydown", handleOutlineKeyDown, true);
        detachOutline = () => {
          outlineRoot.removeEventListener("click", handleOutlineClick, true);
          outlineRoot.removeEventListener(
            "keydown",
            handleOutlineKeyDown,
            true,
          );
        };
      }
    })().catch(() => {
      if (!cancelled) setLoadError(true);
    });

    return () => {
      cancelled = true;
      detachRefs();
      detachOutline();
    };
  }, [assetBaseUrl, body, items, outline, resolvedTheme]);

  const preview = loadError ? (
    <PlanDocumentFallback value={body} theme={resolvedTheme} />
  ) : (
    <div
      ref={previewRef}
      className="vditor-reset pc-md-preview pc-plan-document__preview"
      style={{
        background: "var(--bg-1, #19232a)",
        color: "var(--fg, #e6e6e6)",
      }}
    />
  );

  const outlinePanel = (
    <nav
      aria-label="Plan outline"
      className={`pc-md-outline-shell pc-md-outline-shell--${outline || "left"}`}
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
      ref={scopeRef}
      className={`pc-plan-document ${className ?? ""}`.trim()}
      style={style}
    >
      {showJump ? (
        <PlanDocumentJump
          items={items}
          decisions={decisions}
          scopeRef={scopeRef}
        />
      ) : null}
      {showFrontmatter && frontmatter ? (
        <PlanDocumentFrontmatter slug={slug} frontmatter={frontmatter} />
      ) : null}
      {outline ? (
        <div className="pc-plan-document__body">
          {outline === "left" ? outlinePanel : null}
          {preview}
          {outline === "right" ? outlinePanel : null}
        </div>
      ) : (
        preview
      )}
      <style>{planDocumentCss}</style>
    </div>
  );
}

const planDocumentCss = `
  .pc-plan-document { container-type: inline-size; display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
  .pc-plan-document__body { display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; gap: clamp(10px, 2vw, 18px); }
  .pc-plan-document__preview { flex: 1 1 auto; min-width: 0; min-height: 0; background: var(--bg-1, #19232a) !important; color: var(--fg, #e6e6e6) !important; }
  .pc-plan-document .pc-md-outline-shell { position: sticky; top: 0; align-self: flex-start; display: flex; flex: 0 0 clamp(190px, 22cqi, 248px); flex-direction: column; width: clamp(190px, 22cqi, 248px); max-height: min(72vh, calc(100vh - 100px)); overflow: hidden; color: var(--fg-mute, #7f9bb4); background: color-mix(in srgb, var(--bg-2, #111b2d), transparent 8%); border: 1px solid var(--border, rgba(125,211,252,.18)); border-radius: 10px; }
  .pc-plan-document .pc-md-outline__header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 9px 10px 8px; color: var(--fg, #e7f7ff); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; border-bottom: 1px solid var(--border, rgba(125,211,252,.18)); }
  .pc-plan-document .pc-md-outline__legend { color: var(--fg-dim, #9db5c8); font-size: 9px; font-weight: 600; letter-spacing: .02em; text-transform: none; white-space: nowrap; }
  .pc-plan-document .pc-md-outline.vditor-outline { display: block; min-height: 0; overflow-y: auto; padding: 8px; }
  .pc-plan-document .pc-md-outline ul { list-style: none; padding-left: 12px; margin: 0; }
  .pc-plan-document .pc-md-outline > ul { padding-left: 0; }
  .pc-plan-document .pc-md-outline ul ul { margin-inline-start: 7px; padding-inline-start: 8px; border-inline-start: 1px solid var(--border, rgba(125,211,252,.18)); }
  .pc-plan-document .pc-md-outline li { margin: 2px 0; }
  .pc-plan-document .pc-md-outline [data-target-id] { --pc-outline-kind: transparent; position: relative; display: flex; align-items: baseline; gap: 6px; padding: 4px 7px 4px 10px; color: var(--fg-mute, #7f9bb4); font-size: 12px; line-height: 1.4; text-decoration: none; overflow-wrap: anywhere; cursor: pointer; border: 1px solid transparent; border-radius: 6px; }
  .pc-plan-document .pc-md-outline [data-target-id]::before { position: absolute; top: 6px; bottom: 6px; left: 3px; width: 2px; content: ''; background: var(--pc-outline-kind); border-radius: 999px; }
  .pc-plan-document .pc-md-outline [data-plan-outline-kind='section'] { color: var(--fg-dim, #b9d4e8); font-weight: 650; }
  .pc-plan-document .pc-md-outline [data-plan-outline-kind='item'] { --pc-outline-kind: var(--accent, #57d7ff); }
  .pc-plan-document .pc-md-outline [data-plan-outline-kind='decision'] { --pc-outline-kind: var(--warning, var(--warn, #fb923c)); }
  .pc-plan-document .pc-md-outline [data-target-id]:hover { color: var(--fg, #e7f7ff); background: var(--bg-3, rgba(255,255,255,.075)); }
  .pc-plan-document .pc-md-outline [data-target-id]:focus-visible { color: var(--fg, #e7f7ff); background: color-mix(in srgb, var(--accent, #57d7ff) 11%, transparent); border-color: color-mix(in srgb, var(--accent, #57d7ff) 58%, transparent); outline: 2px solid color-mix(in srgb, var(--accent, #57d7ff) 56%, transparent); outline-offset: 1px; }
  .pc-plan-document .pc-md-outline [data-target-id][aria-current='location'] { color: var(--fg, #e7f7ff); font-weight: 650; background: color-mix(in srgb, var(--accent, #57d7ff) 16%, transparent); border-color: color-mix(in srgb, var(--accent, #57d7ff) 36%, transparent); }
  .pc-plan-document .pc-md-outline__group { margin-top: 7px; padding-top: 7px; border-top: 1px solid var(--border, rgba(125,211,252,.18)); }
  .pc-plan-document .pc-md-outline__group-label { padding: 2px 7px 4px; color: var(--fg-dim, #9db5c8); font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
  .pc-plan-document .pc-md-outline__item-id { flex: 0 0 auto; color: var(--accent-strong, var(--accent, #57d7ff)); font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; font-weight: 750; }
  .pc-plan-document .pc-md-outline__item-summary { display: -webkit-box; min-width: 0; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .pc-plan-document__fallback { flex: 1 1 auto; min-width: 0; border: 1px solid var(--border, rgba(125,211,252,.18)); border-radius: 8px; overflow: hidden; }
  .pc-plan-document__fallback p { margin: 0; padding: 8px 12px; color: var(--fg-mute, #7f9bb4); border-bottom: 1px solid var(--border, rgba(125,211,252,.18)); }
  /* Colours deliberately absent: planDocumentFallbackSurface() supplies the
     foreground/background PAIR inline, so they can never come from different
     sources and disagree (WI-39341). Do not reintroduce a colour here. */
  .pc-plan-document__fallback pre { margin: 0; padding: 16px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .pc-plan-document .pc-md-preview :is(pre, pre code) { background: color-mix(in srgb, var(--bg-popover, #0d1829), transparent 6%) !important; color: var(--fg, #e7f7ff) !important; }
  .pc-plan-document .pc-md-preview pre { border: 1px solid var(--border-strong, rgba(125,211,252,.32)) !important; border-radius: 12px !important; }
  .pc-plan-document .pc-md-preview :is(code.language-yaml, code.language-yml, code.language-frontmatter, pre code:first-child) { color: var(--fg, #e7f7ff) !important; }
  .pc-plan-document .pc-md-preview :is(.hljs-attr, .hljs-attribute, .hljs-keyword, .hljs-meta) { color: var(--accent-strong, #7dd3fc) !important; }
  .pc-plan-document .pc-md-preview :is(.hljs-string, .hljs-literal, .hljs-number) { color: var(--fg-dim, #b9d4e8) !important; }
  @container (max-width: 680px) {
    .pc-plan-document__body { flex-direction: column; }
    .pc-plan-document .pc-md-outline-shell { position: relative; order: -1; width: 100%; max-height: none; flex-basis: auto; }
    .pc-plan-document .pc-md-outline.vditor-outline { max-height: 190px; }
  }
`;
