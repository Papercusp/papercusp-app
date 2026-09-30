/**
 * KnowledgePackCandidates — the fleet→pack candidate strip in the Learnings
 * view (self-improvement-consume-edges-2026-06-12 P-032 / B-11; auto-adopt
 * reversal owner-auto-adopt-fleet-lessons-2026-07-19 / WI-5414).
 *
 * Candidates are cross-hive recurring lessons staged by the
 * recurrence-escalation loop (`knowledgePacks.candidates` sync query), each
 * carrying provenance (signature, scopes, recurrence count, source items).
 * They do NOT wait for a human anymore: a scheduled automated-review sweep
 * (the improvement-triage cadence) judges every pending candidate against
 * the fleet-lessons pack's existing content and auto-adopts (writes it into
 * the pack — the version bumps, so every hive carrying the pack lights
 * `updateAvailable` and adopts through its normal install/upgrade conflict
 * review) or auto-dismisses (terminal) with the verdict recorded as the
 * decision note. The buttons here are the OWNER's manual override — adopt or
 * dismiss a still-pending candidate now, ahead of the sweep.
 *
 * Renders nothing when there is nothing to show (no pending candidates AND no
 * recent auto-adoptions) — the parent owns the layout.
 */
import { useState } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import { Inbox, Sparkles } from "lucide-react";
import {
  AUTO_ADOPT_REVIEWER,
  type KnowledgePackCandidate,
} from "@papercusp/operator-core/lib/knowledge-packs/candidates-shared";
import { Tooltip } from "@/app/harness/Tooltip";
import { useLexicon } from "@/lib/useLexicon";
import { LearningDisclosure } from "./LearningVisuals";

const actionBtn: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg-dim)",
  cursor: "pointer",
  fontSize: 11,
  padding: "1px 7px",
};

export default function KnowledgePackCandidates() {
  const t = useLexicon();
  const sync = useSyncQuery<KnowledgePackCandidate>({
    queryName: "knowledgePacks.candidates",
    args: {},
    staleTime: 30_000,
  });
  const pending = sync.data ?? [];

  // Recently auto-adopted — the automated review sweep's own track record, so
  // "no human review step" doesn't read as "nothing is visible" (WI-5414 c).
  const recentAuto = useSyncQuery<KnowledgePackCandidate>({
    queryName: "knowledgePacks.candidates",
    args: { status: "adopted", decidedBy: AUTO_ADOPT_REVIEWER, limit: 5 },
    staleTime: 30_000,
  });
  const recentAdopted = recentAuto.data ?? [];

  // Which candidate's draft is expanded — URL state (agents drive review via
  // ui:dispatch; deep-linkable).
  const [lcand, setLcand] = useQueryState(
    "lcand",
    parseAsString.withDefault(""),
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [adoptedNote, setAdoptedNote] = useState("");

  const decide = async (
    c: KnowledgePackCandidate,
    action: "adopt" | "dismiss",
  ) => {
    setError("");
    setAdoptedNote("");
    setBusy(c.id);
    try {
      const res = await fetch("/api/knowledge-packs/candidate-decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, action }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        error?: string;
        packId?: string;
        packVersion?: string;
      };
      if (!res.ok || data.ok === false) {
        setError(data.error ?? data.reason ?? `HTTP ${res.status}`);
      } else if (action === "adopt" && data.packId) {
        setAdoptedNote(
          `Adopted into ${data.packId} v${data.packVersion ?? "?"} — ${t('pot', { plural: true })} with the pack installed now show an update to review; others can install it from "add a pack".`,
        );
      }
    } catch (e) {
      setError((e as Error).message ?? "network error");
    } finally {
      setBusy("");
      sync.invalidate();
      recentAuto.invalidate();
    }
  };

  const visible = pending.slice(0, 3);
  const remaining = pending.slice(3);
  const renderCandidate = (c: KnowledgePackCandidate) => (
    <div key={c.id} className="pc-pack-candidates__row">
      <div className="pc-pack-candidates__main">
        <strong>{c.title}</strong>
        <span
          title={`Recurred ${c.recurrenceCount}× across ${c.scopes.join(", ")}${c.sourceItemIds.length > 0 ? ` · from ${c.sourceItemIds.join(", ")}` : ""}`}
        >
          {c.recurrenceCount}× · {c.scopes.length} scope
          {c.scopes.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          style={actionBtn}
          onClick={() => void setLcand(lcand === c.id ? "" : c.id)}
          aria-expanded={lcand === c.id}
        >
          {lcand === c.id ? "hide draft" : "view draft"}
        </button>
        <Tooltip
          label="Adopt now, ahead of the automated review sweep — written straight into the fleet-lessons pack"
        >
          <button
            type="button"
            style={{
              ...actionBtn,
              borderColor: "var(--accent)",
              color: "var(--accent)",
            }}
            disabled={busy === c.id}
            onClick={() => void decide(c, "adopt")}
          >
            adopt now
          </button>
        </Tooltip>
        <Tooltip label="Dismiss now, ahead of the automated review sweep — permanent; this lesson's signature never re-files">
          <button
            type="button"
            style={actionBtn}
            disabled={busy === c.id}
            onClick={() => void decide(c, "dismiss")}
          >
            dismiss now
          </button>
        </Tooltip>
      </div>
      {lcand === c.id ? (
        <div className="pc-pack-candidates__draft">{c.draftText}</div>
      ) : null}
    </div>
  );

  if (
    pending.length === 0 &&
    recentAdopted.length === 0 &&
    !error &&
    !adoptedNote
  ) {
    return null;
  }

  return (
    <div
      className="pc-pack-candidates"
      data-testid="pack-candidates"
      aria-label="Fleet lesson candidates — auto-reviewed and auto-adopted"
    >
      <p className="pc-pack-candidates__head">
        <Inbox size={13} aria-hidden /> Fleet lesson candidates
        {pending.length > 0 ? <span>{pending.length}</span> : null}
      </p>
      <p className="pc-pack-candidates__sub">
        Cross-hive recurring lessons staged by the recurrence-escalation sweep.
      </p>
      {pending.length > 0 ? (
        <p className="pc-pack-candidates__sub">
          Auto-reviewed on a schedule and adopted into fleet-lessons unless
          the review finds a conflict. The buttons below decide now, ahead of
          that sweep.
        </p>
      ) : null}
      {visible.map(renderCandidate)}
      {remaining.length > 0 ? (
        <LearningDisclosure label="More candidates" count={remaining.length}>
          {remaining.map(renderCandidate)}
        </LearningDisclosure>
      ) : null}
      {pending.length === 0 && recentAdopted.length > 0 ? (
        <p className="pc-pack-candidates__sub">
          Nothing awaiting review right now — candidates are auto-adopted as
          they recur.
        </p>
      ) : null}
      {recentAdopted.length > 0 ? (
        <div className="pc-pack-candidates__auto">
          <p className="pc-pack-candidates__autohead">
            <Sparkles size={12} aria-hidden /> Recently auto-adopted
          </p>
          <ul>
            {recentAdopted.map((c) => (
              <li key={c.id}>
                <strong>{c.title}</strong>
                <span>{c.recurrenceCount}× · {c.scopes.length} scope{c.scopes.length === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {adoptedNote ? (
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 11.5,
            color: "var(--good, #34d399)",
          }}
        >
          {adoptedNote}
        </p>
      ) : null}
      {error ? (
        <p
          className="pc-learning__empty"
          role="alert"
          style={{ margin: "6px 0 0" }}
        >
          Candidate action failed: {error}
        </p>
      ) : null}
      <style>{`
        .pc-pack-candidates { border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border)); border-radius: 9px; padding: 8px 11px; background: color-mix(in srgb, var(--accent) 4%, var(--bg-2)); }
        .pc-pack-candidates__head { min-height: 24px; display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; font-weight: 680; }
        .pc-pack-candidates__head > span { margin-left: auto; border-radius: 999px; padding: 1px 7px; background: color-mix(in srgb, var(--accent) 13%, transparent); color: var(--accent); font-size: 10px; font-variant-numeric: tabular-nums; }
        .pc-pack-candidates__sub { margin: 3px 0 0; font-size: 10.5px; color: var(--fg-mute); }
        .pc-pack-candidates__row { border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent); padding: 5px 0; font-size: 11.5px; }
        .pc-pack-candidates__main { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto auto auto; align-items: center; gap: 7px; }
        .pc-pack-candidates__main > strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 620; }
        .pc-pack-candidates__main > span { color: var(--fg-mute); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .pc-pack-candidates__draft { margin-top: 5px; padding: 6px 8px; border-radius: 5px; background: var(--bg-1); white-space: pre-wrap; }
        .pc-pack-candidates__auto { margin-top: 7px; padding-top: 6px; border-top: 1px dashed color-mix(in srgb, var(--border) 72%, transparent); }
        .pc-pack-candidates__autohead { display: flex; align-items: center; gap: 5px; margin: 0 0 3px; font-size: 10.5px; font-weight: 620; color: var(--fg-dim); }
        .pc-pack-candidates__auto ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-pack-candidates__auto li { display: flex; align-items: baseline; gap: 6px; font-size: 11px; }
        .pc-pack-candidates__auto li > strong { font-weight: 560; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-pack-candidates__auto li > span { color: var(--fg-mute); font-size: 10px; white-space: nowrap; }
        @media (max-width: 720px) { .pc-pack-candidates__main { grid-template-columns: minmax(160px, 1fr) auto auto auto; } .pc-pack-candidates__main > span { grid-column: 1 / -1; grid-row: 2; } }
      `}</style>
    </div>
  );
}
