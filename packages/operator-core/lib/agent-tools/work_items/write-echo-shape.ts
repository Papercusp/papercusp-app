/**
 * work_items write-echo diet (context-trimming-tiers-2026-07-01 P-025).
 *
 * work_items:claim / work_items:complete answer through the bulk envelope
 * { ok, results:[…], counts } and each success row ECHOES the full WorkItem
 * (payload subtree, full summary, timestamps — claim measured up to 79KB/call,
 * complete avg 8.3KB). The caller just wrote/claimed the item: it needs the
 * outcome (ok / state / error / hint / reflect), not the row replayed.
 *
 * Trimmed/standard project the echoed `workItem` to a compact ref; trimmed
 * additionally drops the `completion`/`outputPayload` echoes (pure replays of
 * the caller's OWN input — inherently recoverable, flagged once at the
 * envelope by `echo_note`, D-004). Outcome fields (ok/id/error/holder/hint/
 * stateError/stateWarning/verificationWarning/authorityWarning/completionAuthority/
 * assigneeMismatchWarning/reflect/holderContext) always pass through verbatim — this
 * shaper only ever touches `workItem`, `completion` and `outputPayload`, so a new
 * outcome field needs no change here. (P-027's `holderContext` on a claim_conflict is
 * exactly such a field: it rides through untouched because the row is SPREAD, not
 * rebuilt from an allowlist — which is the property that keeps this claim true.)
 */

export const WRITE_ECHO_TIER_CAPS = {
  trimmed: { title: 90, dropAuthoredEchoes: true },
  standard: { title: 140, dropAuthoredEchoes: false },
} as const;

type EchoTier = keyof typeof WRITE_ECHO_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

function compactWorkItemRef(v: unknown, titleCap: number): unknown {
  if (!v || typeof v !== "object") return v ?? null;
  const w = v as Record<string, unknown>;
  return {
    id: w.id ?? null,
    kind: w.kind ?? null,
    harness: w.harness ?? null,
    state: w.state ?? w.status ?? null,
    title: clip(w.title, titleCap),
    assignee: w.assignee ?? w.taken_by ?? null,
  };
}

export function shapeWorkItemWriteEcho(data: unknown, tier: EchoTier): unknown {
  const d = data as { ok?: unknown; results?: unknown[] } | null | undefined;
  if (!d || !Array.isArray(d.results)) return data;
  const c = WRITE_ECHO_TIER_CAPS[tier];

  let droppedAuthoredEcho = false;
  const results = d.results.map((row) => {
    if (!row || typeof row !== "object") return row;
    const r = { ...(row as Record<string, unknown>) };
    if (r.workItem !== undefined && r.workItem !== null) {
      r.workItem = compactWorkItemRef(r.workItem, c.title);
    }
    if (c.dropAuthoredEchoes) {
      if (r.completion !== undefined) {
        delete r.completion;
        droppedAuthoredEcho = true;
      }
      if (r.outputPayload !== undefined) {
        delete r.outputPayload;
        droppedAuthoredEcho = true;
      }
    }
    return r;
  });

  return {
    ...(d as Record<string, unknown>),
    results,
    ...(droppedAuthoredEcho
      ? {
          echo_note:
            'completion/outputPayload echoes omitted at trimmed tier (they replay your own input) — payloadTier:"full" to see the recorded form',
        }
      : {}),
  };
}
