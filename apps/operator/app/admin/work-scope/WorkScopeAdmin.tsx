"use client";

import { useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { useSyncQuery } from "@papercusp/sync";
import type {
  WorkScopeAssessment,
  WorkScopeDecision,
  WorkScopeStatusPayload,
} from "@papercusp/operator-core/lib/work-scope-policy";
import { Select } from "@/app/harness/Select";
import { Table, type TableColumn } from "@/app/harness/Table";

/**
 * /admin/work-scope — the owner's control for the workspace WORK-SCOPE policy
 * (WI-2145092, the D-003 residue of plan workspace-work-scope-policy-2026-09-04).
 *
 * READ: `workScope.policy` — the same status lens `state:read { cell:'workspace.workScope' }`
 * answers with, so this pane, the cell and the MCP tool cannot disagree; SSE-invalidated on
 * every set/clear through OPERATOR_STATE_SYNC_NAMES.
 * WRITE: POST /api/work-scope/set|clear — the same audited control mutation as
 * `workspace:work_scope { op:'set'|'clear' }` (one path, two doors).
 *
 * State: the form fields are mid-edit DRAFTS and the two-step clear is a transient
 * confirmation, so both are `useState` by the nuqs rule; there is no tab/filter/selection
 * here that an agent would need to read from the URL.
 */

type Mode = "enforce" | "off";

interface Draft {
  allow: string;
  mode: Mode;
  reason: string;
}

const PAGE_STYLE: CSSProperties = {
  display: "grid",
  gap: 14,
  padding: "18px clamp(14px, 3vw, 30px) 28px",
  color: "var(--fg, #e7f7ff)",
};

const CARD_STYLE: CSSProperties = {
  display: "grid",
  gap: 10,
  padding: 14,
  borderRadius: 10,
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  background: "var(--bg-raised, rgba(255,255,255,0.03))",
};

const LABEL_STYLE: CSSProperties = { fontSize: 12, opacity: 0.7, textTransform: "uppercase", fontWeight: 600 };

const CHIP_STYLE: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid var(--border, rgba(255,255,255,0.18))",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 12,
  marginRight: 6,
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border, rgba(255,255,255,0.18))",
  background: "var(--bg-deep, rgba(0,0,0,0.25))",
  color: "inherit",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 13,
};

const BUTTON_STYLE: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--border, rgba(255,255,255,0.18))",
  background: "var(--accent, #2563eb)",
  color: "#fff",
  cursor: "pointer",
};

const DANGER_BUTTON_STYLE: CSSProperties = { ...BUTTON_STYLE, background: "var(--bad, #b91c1c)" };
const GHOST_BUTTON_STYLE: CSSProperties = { ...BUTTON_STYLE, background: "transparent", color: "inherit" };

const ASSESSMENT_TONE: Record<WorkScopeAssessment, { bg: string; text: string }> = {
  enforce: { bg: "rgba(34,197,94,0.18)", text: "Enforced — out-of-scope work is refused at every dispatch seam" },
  off: { bg: "rgba(245,158,11,0.18)", text: "Off — a policy row exists but confines nothing (fail-open)" },
  absent: { bg: "rgba(148,163,184,0.18)", text: "Absent — no policy row; every harness is allowed" },
};

const MODE_OPTIONS = [
  { value: "enforce", label: "enforce — refuse work outside the allow-list" },
  { value: "off", label: "off — keep the row, confine nothing" },
];

/** Split a newline/comma separated allow-list into trimmed, de-duplicated slugs. */
export function parseAllowList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const s = raw.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const LEDGER_COLUMNS: TableColumn<WorkScopeDecision>[] = [
  { key: "at", header: "When", render: (r) => r.at.replace("T", " ").replace(/\.\d+Z$/, "Z") },
  { key: "verdict", header: "Verdict", render: (r) => r.verdict },
  { key: "site", header: "Seam", render: (r) => r.site },
  { key: "harness", header: "Harness", render: (r) => r.harness ?? "—" },
  { key: "subject", header: "Subject", render: (r) => r.subject ?? "—", cellTitle: (r) => r.note },
];

export default function WorkScopeAdmin() {
  const query = useSyncQuery<WorkScopeStatusPayload>({
    queryName: "workScope.policy",
    args: { recent: 20 },
    staleTime: 15_000,
  });
  const payload = query.data?.[0];

  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"set" | "clear" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  if (query.loading && !payload) {
    return <div style={PAGE_STYLE}>Loading work-scope policy…</div>;
  }
  if (query.error && !payload) {
    return <div style={PAGE_STYLE}>Failed to load the work-scope policy: {String(query.error)}</div>;
  }
  if (!payload) {
    return <div style={PAGE_STYLE}>No work-scope status returned.</div>;
  }

  // The form seeds from the live row until the operator starts editing; a successful
  // write drops the draft so the next render re-seeds from the freshly invalidated read.
  const form: Draft = draft ?? {
    allow: payload.allowHarnesses.join("\n"),
    mode: payload.mode ?? "enforce",
    reason: "",
  };
  const allowList = parseAllowList(form.allow);
  const canSet = busy === null && allowList.length > 0 && form.reason.trim().length >= 3;
  const tone = ASSESSMENT_TONE[payload.assessments.policy];

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !j.ok) throw new Error((j.error as string | undefined) ?? `HTTP ${res.status}`);
    return j;
  }

  async function submitSet() {
    setBusy("set");
    try {
      const j = await post("/api/work-scope/set", {
        mode: form.mode,
        allowHarnesses: allowList,
        reason: form.reason.trim(),
      });
      toast.success(
        form.mode === "enforce" ? "Work-scope policy enforced" : "Work-scope policy set to off",
        { description: `allow: ${allowList.join(", ")} · audit ${String(j.auditId ?? "?")}` },
      );
      setDraft(null);
    } catch (e) {
      toast.error("Failed to set the work-scope policy", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function submitClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setBusy("clear");
    try {
      const j = await post("/api/work-scope/clear", {});
      toast.success("Work-scope policy cleared — every harness is allowed again", {
        description: `audit ${String(j.auditId ?? "?")}`,
      });
      setDraft(null);
    } catch (e) {
      toast.error("Failed to clear the work-scope policy", { description: (e as Error).message });
    } finally {
      setBusy(null);
      setConfirmClear(false);
    }
  }

  return (
    <div style={PAGE_STYLE} data-testid="work-scope-admin">
      <section style={{ ...CARD_STYLE, background: tone.bg }} aria-label="Current work-scope policy">
        <div style={LABEL_STYLE}>Current policy</div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>
          <span data-testid="work-scope-assessment">{payload.assessments.policy}</span>
          <span style={{ fontWeight: 400, opacity: 0.85 }}> — {tone.text}</span>
        </div>
        <div>
          <span style={LABEL_STYLE}>Allowed harnesses </span>
          {payload.allowHarnesses.length === 0 ? (
            <span style={{ opacity: 0.7 }}>(none)</span>
          ) : (
            payload.allowHarnesses.map((h) => (
              <span key={h} style={CHIP_STYLE} data-testid="work-scope-allow">
                {h}
              </span>
            ))
          )}
        </div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13, opacity: 0.85 }}>
          <span>mode: <code>{payload.mode ?? "—"}</code></span>
          <span>exceptions: {payload.exceptions}</span>
          <span>set by: {payload.setBy ?? "—"}</span>
          <span>updated: {payload.updatedAt ?? "—"}</span>
        </div>
        {payload.reason ? <div style={{ fontSize: 13 }}>reason: {payload.reason}</div> : null}
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          Agents read this as <code>state:read {"{"} cell: &quot;workspace.workScope&quot; {"}"}</code>; the MCP tool is{" "}
          <code>workspace:work_scope</code>.
        </div>
      </section>

      <section style={CARD_STYLE} aria-label="Set the work-scope policy">
        <div style={LABEL_STYLE}>Set policy</div>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 13 }}>Allowed harnesses (one per line or comma-separated; <code>foo/*</code> admits every sub-harness of foo)</span>
          <textarea
            aria-label="Allowed harnesses"
            rows={4}
            style={INPUT_STYLE}
            value={form.allow}
            onChange={(e) => setDraft({ ...form, allow: e.target.value })}
            disabled={busy !== null}
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 13 }}>Mode</span>
          <Select
            ariaLabel="Mode"
            testId="work-scope-mode"
            disabled={busy !== null}
            value={form.mode}
            onChange={(v: string) => setDraft({ ...form, mode: v === "off" ? "off" : "enforce" })}
            options={MODE_OPTIONS}
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 13 }}>Reason (recorded on the audit row)</span>
          <input
            aria-label="Reason"
            style={INPUT_STYLE}
            value={form.reason}
            placeholder="e.g. owner: only papercusp work this week"
            onChange={(e) => setDraft({ ...form, reason: e.target.value })}
            disabled={busy !== null}
          />
        </label>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" style={BUTTON_STYLE} onClick={() => void submitSet()} disabled={!canSet}>
            {busy === "set" ? "Setting…" : "Set policy"}
          </button>
          <button
            type="button"
            style={confirmClear ? DANGER_BUTTON_STYLE : GHOST_BUTTON_STYLE}
            onClick={() => void submitClear()}
            disabled={busy !== null || payload.assessments.policy === "absent"}
          >
            {busy === "clear" ? "Clearing…" : confirmClear ? "Confirm clear (every harness allowed again)" : "Clear policy…"}
          </button>
          {confirmClear && busy === null ? (
            <button type="button" style={GHOST_BUTTON_STYLE} onClick={() => setConfirmClear(false)}>
              Keep it
            </button>
          ) : null}
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            {allowList.length} harness{allowList.length === 1 ? "" : "es"} · audited, one-call revertible
          </span>
        </div>
      </section>

      <section style={CARD_STYLE} aria-label="Scope decisions ledger">
        <div style={LABEL_STYLE}>Ledger</div>
        <div style={{ display: "flex", gap: 18, fontSize: 13 }}>
          <span data-testid="work-scope-count-denied">denied: {payload.ledger.counts.denied}</span>
          <span>held: {payload.ledger.counts.held}</span>
          <span>re-homed: {payload.ledger.counts.rehomed}</span>
        </div>
        {payload.ledger.recent.length === 0 ? (
          <div style={{ fontSize: 13, opacity: 0.7 }}>No decisions recorded yet.</div>
        ) : (
          <Table<WorkScopeDecision>
            columns={LEDGER_COLUMNS}
            rows={[...payload.ledger.recent].reverse()}
            getRowKey={(r) => `${r.at}:${r.site}:${r.harness ?? ''}:${r.subject ?? ''}`}
          />
        )}
      </section>
    </div>
  );
}
