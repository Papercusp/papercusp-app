/**
 * The every-pot scope picker (learning-pot-scope-gate-2026-08-30, P-008).
 *
 * The rail is the "pots that do learning" surface; this is the "every pot in
 * the workspace" one (D-005), and therefore the ONLY route to a dormant pot's
 * controls. Its trigger is the rail's own `+N idle` chip — D-005 designated
 * that chip and deliberately left it inert until this existed, so opening is
 * wired there rather than through a second entry point.
 *
 * WHY EVERY ROW STATES A CONSEQUENCE (D-007). The pot switch is a GATE, not an
 * arm: releasing it lets each lane resume at its own prior arming, so a pot
 * whose lanes are all disarmed starts NOTHING when switched on. Measured live
 * (D-005), that is 47 of 54 pots — the majority. A picker that flipped the gate
 * and let the row read as "learning" would be lying about spend, so the model
 * hands each row what arming it would ACTUALLY do and the row prints it.
 *
 * The checkbox SELECTS; the footer WRITES (D-007) — one control, not two, and
 * one `learning:set-pot-scope` call for the whole selection rather than a loop.
 */
import { useCallback, useMemo, useState } from "react";
import { parseAsBoolean, parseAsString, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import type { AutomationCatalog } from "@papercusp/operator-core/lib/automation/catalog";
import { Checkbox } from "@/app/harness/Checkbox";
import { Modal } from "@/app/harness/Modal";
import { potHomeLabel } from "@/lib/pot-label";
import { useLexicon } from "@/lib/useLexicon";
import { runAgentTool } from "./run-tool";
import { useOpenPotDrawer } from "./LearningPotDrawer";
import {
  buildPotPickerRows,
  filterPotPickerRows,
  potScopeWrite,
  type PotPickerConsequence,
  type PotPickerRow,
} from "./learning-pot-picker";

/**
 * Minimal shape of the workspace pot listing this surface needs.
 * `harness_kind` is the wire field from `harnessProjects.lite` and is what
 * separates a POT from an ordinary repo — the query returns every project in
 * the workspace, so without it this surface lists submodules as pots.
 */
type ProjectLite = { slug: string; harness_kind?: string | null };

/**
 * URL keys. The picker's open state is addressable on purpose: the repo rule
 * puts dialog open-state in nuqs so the agent control surface can see it, and
 * P-009 retargets three `useOpenArming` call sites at this picker, which it can
 * only do if opening is expressible as a URL.
 */
const OPEN_KEY = "lpick";
const QUERY_KEY = "lpickq";

/** Open the picker from anywhere (the rail's idle chip; P-009's call sites). */
export function useOpenPotPicker(): () => void {
  const [, setOpen] = useQueryState(OPEN_KEY, parseAsBoolean.withDefault(false));
  return useCallback(() => void setOpen(true), [setOpen]);
}

function consequenceText(c: PotPickerConsequence): string {
  switch (c.kind) {
    case "resumes":
      return `Switching on resumes ${c.lanes.join(", ")}`;
    case "starts-nothing":
      // The honest case, and the one a gate-shaped control hides by default.
      return `Nothing is armed — switching on alone starts nothing; arm ${c.needsLane} to make it learn`;
    case "starts":
      return `Never learned — switching on starts ${c.lane}`;
  }
}

function PotRow({
  row,
  checked,
  onToggle,
  onOpenFields,
  disabled,
}: {
  row: PotPickerRow;
  checked: boolean;
  onToggle: (slug: string) => void;
  onOpenFields: (slug: string) => void;
  disabled: boolean;
}) {
  const label = potHomeLabel(row.potSlug);
  return (
    <li className="pc-potpick__row" data-learning={row.learning} data-slug={row.potSlug}>
      <label className="pc-potpick__pick">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle(row.potSlug)}
          ariaLabel={`Select ${label}`}
        />
        <span className="pc-potpick__name">{label}</span>
      </label>
      <span className="pc-potpick__state" data-state={row.learning}>
        {row.learning === "on" ? "on" : row.learning === "off" ? "off" : "unreadable"}
      </span>
      {/* P-012 / D-008. THIS BUTTON IS THE LOAD-BEARING PART OF THE DRAWER, not
          the drawer's own layout. The footer below writes the pot GATE and
          nothing else — D-007 keeps per-lane control off this surface on
          purpose — so before this existed, the ONLY way to reach a pot's
          per-lane switches was its rail chip. That is precisely why the rail
          cannot bury a switched-off pot (D-008, falsified twice) and why the
          Learning tab is "gigantic" with every pot paused. Opening the drawer
          BY SLUG, from a row that exists for every pot in the workspace, is
          what lets P-052 collapse the rail. */}
      <button
        type="button"
        className="pc-potpick__fields"
        onClick={() => onOpenFields(row.potSlug)}
        aria-label={`Open learning fields for ${label}`}
      >
        Fields
      </button>
      <span className="pc-potpick__conseq">{consequenceText(row.consequence)}</span>
    </li>
  );
}

export default function LearningPotPicker() {
  const t = useLexicon();
  const [open, setOpen] = useQueryState(OPEN_KEY, parseAsBoolean.withDefault(false));
  const [query, setQuery] = useQueryState(QUERY_KEY, parseAsString.withDefault(""));

  /**
   * Selection is deliberately NOT in the URL. The repo rule sends "selection
   * ids" to nuqs, but this selection is a pre-commit staging value discarded on
   * close, and encoding up to 54 slugs would put a kilobyte of comma-joined
   * text in the address bar — which the same rule explicitly forbids. The
   * durable, URL-worthy state here is the OUTCOME of the write, which lives in
   * the catalog, not the staging set that produced it.
   */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Hands a pot — dormant, off, or never-learned alike — to P-012's drawer. */
  const openFields = useOpenPotDrawer();

  const catalogQuery = useSyncQuery<AutomationCatalog>({
    queryName: "automation.catalog",
    args: {},
    staleTime: 15_000,
  });
  const projectsQuery = useSyncQuery<ProjectLite>({
    queryName: "harnessProjects.lite",
    args: { includeHiveHomes: true },
    staleTime: 60_000,
  });

  const arming = catalogQuery.data?.[0]?.arming ?? null;
  const projects = projectsQuery.data ?? null;

  const rows = useMemo(() => buildPotPickerRows(projects, arming), [projects, arming]);
  const visible = useMemo(() => filterPotPickerRows(rows, query), [rows, query]);

  const toggle = useCallback((slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  // Select-all acts on the VISIBLE rows only — the same rule the write follows,
  // so "select all" under a search can never stage a pot the user cannot see.
  const allVisibleSelected =
    visible.length > 0 && visible.every((r) => selected.has(r.potSlug));
  const toggleAllVisible = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const every = visible.length > 0 && visible.every((r) => next.has(r.potSlug));
      for (const r of visible) {
        if (every) next.delete(r.potSlug);
        else next.add(r.potSlug);
      }
      return next;
    });
  }, [visible]);

  const write = useCallback(
    async (enabled: boolean) => {
      const payload = potScopeWrite(visible, selected, enabled);
      if (!payload) return;
      setBusy(true);
      setErr(null);
      try {
        await runAgentTool("learning:set-pot-scope", payload);
        catalogQuery.invalidate?.();
        setSelected(new Set());
      } catch (e) {
        // Surface the refusal instead of silently rendering the old state —
        // set-pot-scope refuses an unknown slug precisely so a typo cannot read
        // as a successful switch-off.
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [visible, selected, catalogQuery],
  );

  const close = useCallback(() => {
    void setOpen(false);
    void setQuery("");
    setSelected(new Set());
    setErr(null);
  }, [setOpen, setQuery]);

  const selectedCount = visible.filter((r) => selected.has(r.potSlug)).length;
  const potPlural = t("pot", { plural: true, lower: true });

  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? void setOpen(true) : close())}
      title={`Learning scope — every ${t("pot", { lower: true })}`}
      contentClassName="pc-potpick"
    >
      <div className="pc-potpick__body">
        <input
          className="pc-potpick__search"
          type="search"
          value={query}
          placeholder={`Search ${potPlural}…`}
          aria-label={`Search ${potPlural}`}
          onChange={(e) => void setQuery(e.target.value)}
        />

        <div className="pc-potpick__count">
          {visible.length === rows.length
            ? `${rows.length} ${potPlural}`
            : `${visible.length} of ${rows.length} ${potPlural}`}
          {visible.length > 0 ? (
            <button type="button" className="pc-potpick__all" onClick={toggleAllVisible}>
              {allVisibleSelected ? "Clear" : "Select all"}
            </button>
          ) : null}
        </div>

        {visible.length === 0 ? (
          <p className="pc-potpick__empty">
            {rows.length === 0
              ? `No ${potPlural} to show yet.`
              : `No ${potPlural} match that search.`}
          </p>
        ) : (
          <ul className="pc-potpick__list">
            {visible.map((row) => (
              <PotRow
                key={row.potSlug}
                row={row}
                checked={selected.has(row.potSlug)}
                onToggle={toggle}
                onOpenFields={openFields}
                disabled={busy}
              />
            ))}
          </ul>
        )}

        {err ? (
          <p className="pc-potpick__err" role="alert">
            {err}
          </p>
        ) : null}

        <div className="pc-potpick__footer">
          <span className="pc-potpick__sel">{`${selectedCount} selected`}</span>
          <button
            type="button"
            className="pc-potpick__act"
            disabled={busy || selectedCount === 0}
            onClick={() => void write(true)}
          >
            Switch learning on
          </button>
          <button
            type="button"
            className="pc-potpick__act pc-potpick__act--off"
            disabled={busy || selectedCount === 0}
            onClick={() => void write(false)}
          >
            Switch learning off
          </button>
        </div>
      </div>

      <style>{`
        .pc-potpick { width: min(720px, calc(100vw - 32px)); }
        .pc-potpick__body { display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
        .pc-potpick__search {
          width: 100%; padding: 6px 9px; font-size: 12.5px;
          border-radius: 8px; border: 1px solid var(--border);
          background: var(--bg); color: var(--fg);
        }
        .pc-potpick__count {
          display: flex; align-items: center; gap: 8px;
          font-size: 11px; color: var(--fg-mute);
        }
        .pc-potpick__all {
          background: none; border: none; padding: 0; cursor: pointer;
          font: inherit; color: var(--accent); text-decoration: underline;
        }
        .pc-potpick__list {
          list-style: none; margin: 0; padding: 0;
          max-height: min(52vh, 460px); overflow-y: auto;
          border: 1px solid var(--border); border-radius: 10px;
        }
        .pc-potpick__row {
          display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
          grid-template-areas: "pick state fields" "conseq conseq conseq";
          gap: 2px 10px; padding: 7px 10px; font-size: 12px;
          border-bottom: 1px solid var(--border);
        }
        .pc-potpick__row:last-child { border-bottom: none; }
        .pc-potpick__pick {
          grid-area: pick; display: flex; align-items: center; gap: 8px;
          min-width: 0; cursor: pointer;
        }
        .pc-potpick__name {
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg);
        }
        .pc-potpick__state { grid-area: state; font-size: 10.5px; color: var(--fg-mute); }
        .pc-potpick__fields {
          grid-area: fields; padding: 2px 8px; font-size: 10.5px;
          border-radius: 7px; border: 1px solid var(--border-strong);
          background: var(--bg); color: var(--fg); cursor: pointer;
        }
        .pc-potpick__state[data-state="on"] { color: var(--good); }
        .pc-potpick__state[data-state="unknown"] { color: var(--warn); }
        /* The consequence line is the point of this surface, so it is never
           truncated away — it wraps onto its own row instead. */
        .pc-potpick__conseq {
          grid-area: conseq; font-size: 10.5px; color: var(--fg-mute); line-height: 1.4;
        }
        .pc-potpick__empty, .pc-potpick__err { margin: 6px 2px; font-size: 11.5px; }
        .pc-potpick__empty { color: var(--fg-mute); }
        .pc-potpick__err { color: var(--bad); }
        .pc-potpick__footer {
          display: flex; align-items: center; gap: 8px;
          padding-top: 6px; border-top: 1px solid var(--border);
        }
        .pc-potpick__sel { flex: 1 1 auto; font-size: 11px; color: var(--fg-mute); }
        .pc-potpick__act {
          padding: 5px 10px; font-size: 12px; border-radius: 8px;
          border: 1px solid var(--border-strong); background: var(--bg-1);
          color: var(--fg); cursor: pointer;
        }
        .pc-potpick__act:disabled { opacity: 0.5; cursor: default; }
      `}</style>
    </Modal>
  );
}
