"use client";

import { Tooltip } from "@/app/harness/Tooltip";
/**
 * /settings/omp — full configuration surface for the omp (oh-my-pi)
 * agent backend. Mirrors `omp config list` / `omp config set`, plus (WI-3449,
 * 2026-07-10 settings audit) the engineer-collaborator INTEGRATION panel that
 * used to live on its own `/settings/omp-integration` page — owner asked for
 * the two merged into one, since both are "the omp settings page" to a user.
 *
 * Layout:
 * - Integration panel first (install/uninstall the optional legacy OMP MCP
 *   wiring and clean any retired omp-su residue) — a fixed section, since it's a
 *   one-time setup action rather than a config value to search/edit.
 * - Search bar (filters across all `omp config` sections below).
 * - Each config section ([providers], [tools], [memory], …) is a collapsible
 *   group. Web-search section starts open (the user's stated entry
 *   point) plus any section that has search matches.
 * - Each setting renders as the right input type (boolean toggle,
 *   enum select, number, text, or JSON for array/record).
 * - Edits debounce to a single POST; success/failure surfaces inline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryState, parseAsString, parseAsArrayOf } from "nuqs";
import { Button } from "../../harness/Button";
import { Checkbox } from "../../harness/Checkbox";
import { Select } from "../../harness/Select";
import { DraftNumberInput } from "@/lib/forms";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";

interface OmpSetting {
  key: string;
  raw: string;
  parsed: unknown;
  type:
    | "string"
    | "boolean"
    | "number"
    | "array"
    | "record"
    | { kind: "enum"; choices: string[] };
  isUnset: boolean;
}

interface OmpSection {
  name: string;
  settings: OmpSetting[];
}

type RowState = "idle" | "saving" | "saved" | "error";

const SECTIONS_OPEN_BY_DEFAULT = ["providers"];

export default function OmpSettingsPage(): React.JSX.Element {
  const [sections, setSections] = useState<OmpSection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // URL-backed view state (nuqs) — agents can read + drive the filter and
  // section expansion; survives reloads/deep-links.
  const [query, setQuery] = useQueryState("q", parseAsString.withDefault(""));
  const [openSections, setOpenSections] = useQueryState(
    "open",
    parseAsArrayOf(parseAsString).withDefault(SECTIONS_OPEN_BY_DEFAULT),
  );
  const [rowStates, setRowStates] = useState<
    Record<string, { state: RowState; error?: string }>
  >({});

  const refresh = async () => {
    setLoadError(null);
    try {
      const r = await fetch("/api/agent-mcp/omp-config");
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "failed to load");
      setSections(d.sections as OmpSection[]);
    } catch (err) {
      setLoadError((err as Error).message ?? String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!sections) return null;
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((sec) => ({
        ...sec,
        settings: sec.settings.filter(
          (s) =>
            s.key.toLowerCase().includes(q) ||
            sec.name.toLowerCase().includes(q),
        ),
      }))
      .filter((sec) => sec.settings.length > 0);
  }, [sections, query]);

  // Auto-expand sections that have search matches.
  useEffect(() => {
    if (!query || !filtered) return;
    void setOpenSections((prev) => {
      const next = new Set(prev);
      for (const sec of filtered) next.add(sec.name);
      return next.size === prev.length ? prev : [...next];
    });
  }, [query, filtered, setOpenSections]);

  const setRow = (key: string, s: { state: RowState; error?: string }) => {
    setRowStates((prev) => ({ ...prev, [key]: s }));
  };

  const saveValue = async (key: string, value: unknown) => {
    setRow(key, { state: "saving" });
    try {
      const r = await fetch("/api/agent-mcp/omp-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setRow(key, { state: "saved" });
      // Refresh just this row's parsed value so the UI matches what omp stored.
      void refresh();
      setTimeout(() => setRow(key, { state: "idle" }), 1500);
    } catch (err) {
      setRow(key, {
        state: "error",
        error: (err as Error).message ?? String(err),
      });
    }
  };

  const unsetValue = async (key: string) => {
    setRow(key, { state: "saving" });
    try {
      const r = await fetch("/api/agent-mcp/omp-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, unset: true }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setRow(key, { state: "saved" });
      void refresh();
      setTimeout(() => setRow(key, { state: "idle" }), 1500);
    } catch (err) {
      setRow(key, {
        state: "error",
        error: (err as Error).message ?? String(err),
      });
    }
  };

  if (loadError) {
    return (
      <div>
        <h1>Oh-My-Pi (omp) settings</h1>
        <div style={S.error}>
          <strong>Failed to load omp config.</strong>
          <div>{loadError}</div>
          <p className="pc-settings-hint" style={{ marginTop: 8 }}>
            Check that <code>omp</code> is on the operator&apos;s PATH and that{" "}
            <code>omp config list</code> works at the shell.
          </p>
          <button onClick={() => void refresh()}>Retry</button>
        </div>
      </div>
    );
  }

  if (!sections) {
    return (
      <div>
        <h1>Oh-My-Pi (omp) settings</h1>
        <p className="pc-settings-loading">Loading omp config…</p>
      </div>
    );
  }

  const totalSettings = sections.reduce((n, s) => n + s.settings.length, 0);
  const totalShown =
    filtered?.reduce((n, s) => n + s.settings.length, 0) ?? totalSettings;

  return (
    <div>
      <header>
        <h1>Oh-My-Pi (omp) settings</h1>
        <p className="pc-settings-intro">
          Read and edit the {totalSettings} settings exposed by{" "}
          <code>omp config list</code>. Changes persist immediately via{" "}
          <code>omp config set</code> and apply to all new omp invocations
          (existing sessions keep their startup config).
        </p>
      </header>

      <OmpIntegrationPanel />

      <div style={S.searchRow}>
        <input
          type="search"
          value={query}
          onChange={(e) => void setQuery(e.target.value || null)}
          placeholder="Filter settings (e.g. web_search, hindsight, theme)…"
          style={S.searchInput}
          aria-label="Filter omp settings"
        />
        {query && (
          <span style={S.muted}>
            {totalShown} / {totalSettings} matching
          </span>
        )}
      </div>

      <div style={S.sections}>
        {filtered?.map((sec) => {
          const isOpen = openSections.includes(sec.name);
          return (
            <section key={sec.name} style={S.section}>
              <button
                style={S.sectionHeader}
                onClick={() => {
                  void setOpenSections((prev) =>
                    prev.includes(sec.name)
                      ? prev.filter((n) => n !== sec.name)
                      : [...prev, sec.name],
                  );
                }}
                aria-expanded={isOpen}
              >
                <span style={S.sectionChevron}>{isOpen ? "▾" : "▸"}</span>
                <span style={S.sectionName}>[{sec.name}]</span>
                <span style={S.sectionCount}>{sec.settings.length}</span>
              </button>
              {isOpen && (
                <div style={S.sectionBody}>
                  {sec.settings.map((setting) => (
                    <SettingRow
                      key={setting.key}
                      setting={setting}
                      rowState={rowStates[setting.key]}
                      onSave={(v) => void saveValue(setting.key, v)}
                      onUnset={() => void unsetValue(setting.key)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Engineer-collaborator wiring for OMP (formerly the standalone
 * `/settings/omp-integration` page, P-012 of
 * desktop-app-install-integration-2026-05-23; merged here 2026-07-10,
 * WI-3449). Reads state from GET /api/desktop/install/omp-integration;
 * POST installs/re-installs, DELETE uninstalls. Phase 1
 * (papercusp-files) runs automatically at sidecar boot when
 * PAPERCUSP_DESKTOP=1; this panel is purely for the opt-in OMP-config
 * wiring (Phase 2).
 */
interface OmpIntegrationState {
  ompAgentDir: string;
  mcpJsonPath: string;
  legacyContextPath: string;
  legacyExtensionPath: string;
  ompAgentDirExists: boolean;
  ompBinaryPath: string | null;
  mcpServerInstalled: boolean;
  wrapperInstalled: boolean;
  wrapperPath: string;
  legacyBlockPresent: boolean;
  pathWarning: string | null;
}

interface OmpIntegrationResponseBody extends OmpIntegrationState {
  ok: boolean;
  supported?: boolean;
  reason?: string;
  changed?: boolean;
  actions?: string[];
  error?: string;
}

type OmpIntegrationActionState = "idle" | "installing" | "uninstalling";

function OmpIntegrationPanel() {
  const [state, setState] = useState<OmpIntegrationState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<OmpIntegrationActionState>("idle");
  const [actionResult, setActionResult] = useState<{
    kind: "ok" | "error";
    message: string;
    actions?: string[];
  } | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch("/api/desktop/install/omp-integration");
      const d = (await r.json()) as OmpIntegrationResponseBody;
      if (!d.ok) throw new Error(d.error ?? "failed to load");
      setState(d);
    } catch (err) {
      setLoadError((err as Error).message ?? String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async () => {
    setAction("installing");
    setActionResult(null);
    try {
      const r = await fetch("/api/desktop/install/omp-integration", {
        method: "POST",
      });
      const d = (await r.json()) as OmpIntegrationResponseBody;
      if (!d.ok) throw new Error(d.error ?? "install failed");
      const actions = d.actions ?? [];
      setActionResult({
        kind: "ok",
        message:
          d.changed === false
            ? "Already installed — no changes needed."
            : `Installed (${actions.length} action${actions.length === 1 ? "" : "s"}).`,
        actions,
      });
      await refresh();
    } catch (err) {
      setActionResult({
        kind: "error",
        message: (err as Error).message ?? String(err),
      });
    } finally {
      setAction("idle");
    }
  }, [refresh]);

  const uninstall = useCallback(async () => {
    if (
      !(await askConfirm({
        title: "Uninstall OMP integration?",
        body: "This removes the papercusp-su MCP entry, the gateway provider, and any stale retired omp-su wrapper.",
        confirmLabel: "Uninstall",
        destructive: true,
      }))
    )
      return;
    setAction("uninstalling");
    setActionResult(null);
    try {
      const r = await fetch("/api/desktop/install/omp-integration", {
        method: "DELETE",
      });
      const d = (await r.json()) as OmpIntegrationResponseBody;
      if (!d.ok) throw new Error(d.error ?? "uninstall failed");
      const actions = d.actions ?? [];
      setActionResult({
        kind: "ok",
        message:
          actions.length === 0
            ? "Nothing to uninstall."
            : `Uninstalled (${actions.length} action${actions.length === 1 ? "" : "s"}).`,
        actions,
      });
      await refresh();
    } catch (err) {
      setActionResult({
        kind: "error",
        message: (err as Error).message ?? String(err),
      });
    } finally {
      setAction("idle");
    }
  }, [askConfirm, refresh]);

  return (
    <section
      style={{
        ...S.section,
        padding: "14px 16px",
        marginBottom: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {confirmEl}
      <div>
        <h2 style={{ fontSize: 14, margin: 0 }}>
          Engineer-collaborator integration
        </h2>
        <p
          className="pc-settings-intro"
          style={{ marginBottom: 0, marginTop: 4 }}
        >
          Wires Papercusp into your local OMP (oh-my-pi) install so{" "}
          <code>omp-su</code> launches OMP in engineer-collaborator mode
          (playbook + coordination extension + this operator as an MCP server).
          Plain <code>omp</code> stays vanilla.
        </p>
      </div>

      {loadError && (
        <div role="alert" style={{ color: "var(--bad, #c00)" }}>
          Failed to load state: {loadError}
        </div>
      )}

      {state && (
        <>
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              gap: "6px 16px",
              alignItems: "center",
            }}
          >
            <strong>OMP detected:</strong>
            <span>
              {state.ompBinaryPath ? (
                <code>{state.ompBinaryPath}</code>
              ) : (
                <em style={{ color: "var(--muted)" }}>Not found on PATH</em>
              )}
            </span>

            <strong>OMP agent dir:</strong>
            <span>
              <code>{state.ompAgentDir}</code>{" "}
              {state.ompAgentDirExists ? (
                <span style={{ color: "var(--good, #060)" }}>✓ exists</span>
              ) : (
                <em style={{ color: "var(--muted)" }}>missing</em>
              )}
            </span>

            <strong>MCP server in mcp.json:</strong>
            <span>
              {state.mcpServerInstalled ? (
                <span style={{ color: "var(--good, #060)" }}>✓ installed</span>
              ) : (
                <em style={{ color: "var(--muted)" }}>not installed</em>
              )}
            </span>

            <strong>Retired omp-su residue:</strong>
            <span>
              <code>{state.wrapperPath}</code>{" "}
              {state.wrapperInstalled ? (
                <span style={{ color: "var(--warn, #b80)" }}>
                  present — uninstall removes it
                </span>
              ) : (
                <em style={{ color: "var(--muted)" }}>none (expected)</em>
              )}
            </span>

            <strong>Legacy CLAUDE.md block:</strong>
            <span>
              {state.legacyBlockPresent ? (
                <em style={{ color: "var(--warn, #b80)" }}>
                  present — will be stripped on install
                </em>
              ) : (
                <span>none</span>
              )}
            </span>
          </section>

          {state.pathWarning && (
            <div role="alert" style={{ color: "var(--warn, #b80)" }}>
              {state.pathWarning}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <Button
              size="lg"
              variant="primary"
              onClick={install}
              disabled={action !== "idle"}
            >
              {action === "installing"
                ? "Installing…"
                : state.mcpServerInstalled || state.wrapperInstalled
                  ? "Re-install"
                  : "Install"}
            </Button>
            <Button
              size="lg"
              variant="accent"
              onClick={uninstall}
              disabled={
                action !== "idle" ||
                (!state.mcpServerInstalled && !state.wrapperInstalled)
              }
            >
              {action === "uninstalling" ? "Uninstalling…" : "Uninstall"}
            </Button>
            <Button
              size="lg"
              variant="accent"
              onClick={() => void refresh()}
              disabled={action !== "idle"}
            >
              Refresh
            </Button>
          </div>

          {actionResult && (
            <div
              role="status"
              style={{
                color:
                  actionResult.kind === "error"
                    ? "var(--bad, #c00)"
                    : "var(--text)",
              }}
            >
              <div>{actionResult.message}</div>
              {actionResult.actions && actionResult.actions.length > 0 && (
                <ul style={{ marginTop: 4 }}>
                  {actionResult.actions.map((a, i) => (
                    <li key={i}>
                      <code>{a}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SettingRow({
  setting,
  rowState,
  onSave,
  onUnset,
}: {
  setting: OmpSetting;
  rowState?: { state: RowState; error?: string };
  onSave: (v: unknown) => void;
  onUnset: () => void;
}): React.JSX.Element {
  const stateLabel =
    rowState?.state === "saving"
      ? "Saving…"
      : rowState?.state === "saved"
        ? "Saved"
        : rowState?.state === "error"
          ? `Error: ${rowState.error?.slice(0, 80) ?? "unknown"}`
          : null;

  return (
    <div style={S.row}>
      <div style={S.rowKey}>
        <code style={S.code}>{setting.key}</code>
        {stateLabel && (
          <span
            style={rowState?.state === "error" ? S.stateError : S.stateInfo}
          >
            {stateLabel}
          </span>
        )}
      </div>
      <div style={S.rowControl}>
        <ValueControl setting={setting} onSave={onSave} />
      </div>
      <div style={S.rowMeta}>
        {!setting.isUnset && (
          <Tooltip label="Reset to default (unset)">
            <button type="button" style={S.btnGhost} onClick={onUnset}>
              ↻ default
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function ValueControl({
  setting,
  onSave,
}: {
  setting: OmpSetting;
  onSave: (v: unknown) => void;
}): React.JSX.Element {
  if (setting.type === "boolean") {
    return (
      <label style={S.toggle}>
        <Checkbox
          checked={setting.parsed === true}
          onChange={(v) => onSave(v)}
          ariaLabel={setting.key}
        />
        <span>{setting.parsed === true ? "on" : "off"}</span>
      </label>
    );
  }
  if (typeof setting.type === "object" && setting.type.kind === "enum") {
    return (
      <Select
        value={setting.isUnset ? "_unset" : String(setting.parsed)}
        onChange={(v) => onSave(v === "_unset" ? "" : v)}
        options={[
          ...(setting.isUnset ? [{ value: "_unset", label: "(not set)" }] : []),
          ...setting.type.choices.map((c) => ({ value: c, label: c })),
        ]}
        ariaLabel={setting.key}
      />
    );
  }
  if (setting.type === "number") {
    return <NumberControl setting={setting} onSave={onSave} />;
  }
  if (setting.type === "array" || setting.type === "record") {
    return <JsonControl setting={setting} onSave={onSave} />;
  }
  return <StringControl setting={setting} onSave={onSave} />;
}

function StringControl({
  setting,
  onSave,
}: {
  setting: OmpSetting;
  onSave: (v: unknown) => void;
}): React.JSX.Element {
  const [v, setV] = useState<string>(
    setting.isUnset ? "" : String(setting.parsed ?? ""),
  );
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!dirtyRef.current)
      setV(setting.isUnset ? "" : String(setting.parsed ?? ""));
  }, [setting.parsed, setting.isUnset]);
  const commit = () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    onSave(v);
  };
  return (
    <input
      type="text"
      value={v}
      onChange={(e) => {
        dirtyRef.current = true;
        setV(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
      placeholder={setting.isUnset ? "(not set)" : ""}
      style={S.input}
    />
  );
}

function NumberControl({
  setting,
  onSave,
}: {
  setting: OmpSetting;
  onSave: (v: unknown) => void;
}): React.JSX.Element {
  // Commit/validation semantics live in lib/forms DraftNumberInput: a
  // non-numeric or empty draft never persists (the old fall-through saved
  // the raw string; an empty field saved 0 — Number('') === 0).
  const parsedNum =
    typeof setting.parsed === "number"
      ? setting.parsed
      : Number(setting.parsed);
  return (
    <DraftNumberInput
      value={setting.isUnset || !Number.isFinite(parsedNum) ? null : parsedNum}
      min={undefined}
      onCommit={(n) => onSave(n)}
      placeholder={setting.isUnset ? "(not set)" : ""}
      style={S.input}
    />
  );
}

function JsonControl({
  setting,
  onSave,
}: {
  setting: OmpSetting;
  onSave: (v: unknown) => void;
}): React.JSX.Element {
  const initial = setting.isUnset
    ? ""
    : JSON.stringify(setting.parsed ?? null, null, 2);
  const [v, setV] = useState<string>(initial);
  const [err, setErr] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!dirtyRef.current)
      setV(
        setting.isUnset ? "" : JSON.stringify(setting.parsed ?? null, null, 2),
      );
  }, [setting.parsed, setting.isUnset]);
  const commit = () => {
    if (!dirtyRef.current) return;
    if (!v.trim()) {
      dirtyRef.current = false;
      setErr(null);
      onSave(setting.type === "array" ? [] : {});
      return;
    }
    try {
      const parsed = JSON.parse(v);
      dirtyRef.current = false;
      setErr(null);
      onSave(parsed);
    } catch (e) {
      // Keep dirty set on a failed parse — clearing it let the next external
      // echo overwrite the user's draft mid-fix.
      setErr((e as Error).message);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <textarea
        value={v}
        onChange={(e) => {
          dirtyRef.current = true;
          setV(e.target.value);
        }}
        onBlur={commit}
        rows={Math.min(10, Math.max(2, v.split("\n").length))}
        placeholder={setting.type === "array" ? "[]" : "{}"}
        style={{
          ...S.input,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          minWidth: 320,
        }}
      />
      {err && <span style={S.stateError}>JSON: {err}</span>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  searchInput: { flex: 1 },
  sections: { display: "flex", flexDirection: "column", gap: 8 },
  section: {
    background: "var(--bg-2)",
    border: "1px solid var(--border)",
    borderRadius: 6,
  },
  sectionHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "transparent",
    border: "none",
    color: "inherit",
    padding: "10px 14px",
    fontSize: 13,
    cursor: "pointer",
    textAlign: "left",
  },
  sectionChevron: { fontSize: 11, color: "var(--fg-mute)", minWidth: 12 },
  sectionName: {
    fontFamily: "ui-monospace, monospace",
    fontWeight: 600,
    fontSize: 12,
    color: "var(--fg)",
  },
  sectionCount: { fontSize: 11, color: "var(--fg-mute)", marginLeft: "auto" },
  sectionBody: {
    padding: "4px 0 12px",
    borderTop: "1px solid color-mix(in oklab, var(--border), transparent 50%)",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(220px, 1fr) minmax(0, 2fr) auto",
    gap: 12,
    padding: "8px 14px",
    alignItems: "center",
    borderBottom:
      "1px solid color-mix(in oklab, var(--border), transparent 70%)",
  },
  rowKey: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  rowControl: { minWidth: 0 },
  rowMeta: { display: "flex", justifyContent: "flex-end" },
  input: { width: "100%", boxSizing: "border-box" },
  select: {},
  toggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    cursor: "pointer",
  },
  stateInfo: {
    fontSize: 11,
    color: "var(--good, #10b981)",
    fontStyle: "italic",
  },
  stateError: {
    fontSize: 11,
    color: "var(--bad, #ef4444)",
    fontStyle: "italic",
    maxWidth: 360,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  error: {
    background: "color-mix(in oklab, var(--bad, #ef4444), transparent 92%)",
    border:
      "1px solid color-mix(in oklab, var(--bad, #ef4444), transparent 70%)",
    borderRadius: 6,
    padding: 16,
    color: "color-mix(in oklab, var(--bad, #ef4444), white 30%)",
    fontSize: 13,
    marginTop: 16,
  },
};
