/**
 * harness_docs:list payload-tier shapers (context-trimming-tiers-2026-07-01
 * P-023). 7d MCP telemetry: avg 116KB, max 627KB/call — the active doc's FULL
 * markdown body, an entry row per doc (subject arrays + shas), and a `files`
 * list that duplicates entries[].docId. A trimmed/standard session gets lean
 * entry rows, a clipped body with a loud continuation pointer, and the files
 * duplicate collapsed to a count (D-004: nothing dropped silently).
 */

export const HARNESS_DOCS_TIER_CAPS = {
  trimmed: { entries: 80, title: 80, content: 4_000, overlay: 500, detail: 0 },
  standard: { entries: 150, title: 120, content: 12_000, overlay: 2_000, detail: 80 },
} as const;

type DocsTier = keyof typeof HARNESS_DOCS_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

export function shapeHarnessDocsList(
  data: unknown,
  tier: DocsTier,
  opts?: { docIdRequested?: boolean },
): unknown {
  const d = data as
    | ({ entries?: unknown[]; files?: unknown[]; content?: unknown; activeEntry?: unknown } & Record<
        string,
        unknown
      >)
    | null
    | undefined;
  if (!d || !Array.isArray(d.entries)) return data;
  const c = HARNESS_DOCS_TIER_CAPS[tier];
  // EI-8326: a caller that asked for ONE doc (docId supplied) wants a compact
  // per-doc status, not the whole harness's global entries list re-sent every
  // time — that's what bloated doc-steward status checks. Suppress the list,
  // keep `activeEntry` (the doc they asked about) fully populated, and leave
  // an explicit pointer for when the sibling list is genuinely wanted.
  if (opts?.docIdRequested) {
    const content = typeof d.content === 'string' ? d.content : null;
    const contentClipped = content != null && content.length > c.content;
    const ae = (d.activeEntry ?? null) as Record<string, unknown> | null;
    const overlay = ae && typeof ae.overlay === 'string' ? ae.overlay : null;
    const projectEntryCompact = (row: unknown): Record<string, unknown> => {
      const r = (row ?? {}) as Record<string, unknown>;
      return {
        docId: r.docId ?? null,
        source: r.source ?? null,
        status: r.status ?? null,
        title: clip(r.title, c.title),
        statusDetail: clip(r.statusDetail, c.detail),
        subject: clip(r.subjectLabel, c.detail),
        tracked: r.tracked !== false,
        bodyMissing: r.bodyMissing === true,
        hasOverlay: r.hasOverlay === true,
      };
    };
    return {
      ok: d.ok ?? true,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
      activePath: d.activePath ?? null,
      entriesCount: d.entries.length,
      entries_suppressed: 'a specific docId was requested — call without docId (or payloadTier:"full") for the whole harness entries list',
      filesCount: Array.isArray(d.files) ? d.files.length : 0,
      content: contentClipped ? `${content.slice(0, c.content - 1)}…` : content,
      ...(contentClipped
        ? {
            content_truncated: true,
            content_full_chars: content.length,
            content_hint: `body clipped at ${c.content} chars — re-call with payloadTier:"full" (or read the file) for the rest`,
          }
        : {}),
      activeEntry: ae
        ? {
            ...projectEntryCompact(ae),
            hasOverlay: ae.hasOverlay === true,
            overlay: clip(overlay, c.overlay),
            ...(overlay != null && overlay.length > c.overlay
              ? { overlay_truncated: true, overlay_full_chars: overlay.length }
              : {}),
          }
        : null,
    };
  }

  const projectEntry = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const base = {
      docId: r.docId ?? null,
      source: r.source ?? null,
      status: r.status ?? null,
      title: clip(r.title, c.title),
    };
    if (tier === "trimmed") return base;
    return {
      ...base,
      statusDetail: clip(r.statusDetail, c.detail),
      subject: clip(r.subjectLabel, c.detail),
      tracked: r.tracked !== false,
      bodyMissing: r.bodyMissing === true,
      hasOverlay: r.hasOverlay === true,
    };
  };

  const entries = d.entries.slice(0, c.entries).map(projectEntry);
  if (d.entries.length > c.entries) {
    entries.push({
      ...projectEntry({}),
      docId: "(truncated)",
      title: `showing ${c.entries} of ${d.entries.length} — payloadTier:"full" for all`,
    });
  }

  const content = typeof d.content === "string" ? d.content : null;
  const contentClipped = content != null && content.length > c.content;
  const ae = (d.activeEntry ?? null) as Record<string, unknown> | null;
  const overlay = ae && typeof ae.overlay === "string" ? ae.overlay : null;

  return {
    ok: d.ok ?? true,
    ...(d.reason !== undefined ? { reason: d.reason } : {}),
    activePath: d.activePath ?? null,
    // `files` duplicates entries[].docId — collapsed to a count at non-full tiers.
    filesCount: Array.isArray(d.files) ? d.files.length : 0,
    entries,
    content: contentClipped ? `${content.slice(0, c.content - 1)}…` : content,
    ...(contentClipped
      ? {
          content_truncated: true,
          content_full_chars: content.length,
          content_hint: `body clipped at ${c.content} chars — re-call with payloadTier:"full" (or read the file) for the rest`,
        }
      : {}),
    activeEntry: ae
      ? {
          ...projectEntry(ae),
          hasOverlay: ae.hasOverlay === true,
          overlay: clip(overlay, c.overlay),
          ...(overlay != null && overlay.length > c.overlay
            ? { overlay_truncated: true, overlay_full_chars: overlay.length }
            : {}),
        }
      : null,
  };
}
