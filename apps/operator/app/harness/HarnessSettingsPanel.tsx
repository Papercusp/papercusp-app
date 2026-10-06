'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { Checkbox } from './Checkbox';
import { Select } from './Select';
import SavedPromptsSection from './SavedPromptsSection';
import HarnessPluginsSection from './HarnessPluginsSection';
import IntegrationModeSection from './IntegrationModeSection';
import { VirtualGrid, type ColumnDef } from '@papercusp/grid-core';

/**
 * Per-harness Settings panel — one tab inside the harness UI.
 *
 * All controls live per-harness in the spec (`config.json` →
 * parallelWorkers.* / debugger.*) so each harness can carry its own
 * worker-count vocabulary and synthesizer behavior.
 *
 * Sections:
 *   1. Workers — max, worker count (one / fixed / orchestrator-picked),
 *      synthesizer behavior, debugger threshold, branchIsolation.
 *   2. Worker count tiers — only visible when "orchestrator picks per
 *      feature" is selected. Edits `parallelWorkers.adaptive.{tiers,
 *      labels,rubric}`.
 *   3. Worker decisions — recent NEXT_WORKER decisions for this
 *      harness. Read-only.
 */

/**
 * How the per-feature worker count is decided.
 *
 *  - 'one'   → exactly 1 worker per feature (parallelism comes from
 *              running many features in parallel up to `max`).
 *  - 'fixed' → a static N≥2 workers compete on every feature.
 *  - 'tiers' → the orchestrator LLM picks N per feature from a
 *              configured tier set (e.g. {1,2,4}).
 *
 * Internal-only UI state. Not persisted directly — derived on save into
 * `parallelWorkers.{workersPerFeature, adaptive}`. The runtime keys off
 * those + `resolveWorkerCount`, not off a `mode` string.
 */
type WorkerCountMode = 'one' | 'fixed' | 'tiers';

interface AdaptiveCfg {
  tiers: number[];
  labels: string[];
  rubric: string;
}

interface ParallelWorkersCfg {
  max: number;
  workerCountMode: WorkerCountMode;
  workersPerFeature: number | null;
  /** Cap distinct features in flight. null = no separate cap (only
   *  max-workers limits). 1 = traditional one-feature-at-a-time. */
  maxFeaturesInFlight: number | null;
  /** Whether single-worker features also go through synthesis.
   *  Default ON: synthesis acts as a code-review pass even when
   *  there's only one candidate. Flip OFF for speed. */
  synthesizeSingle: boolean;
  adaptive: AdaptiveCfg;
}

interface BranchIsoCfg {
  enabled: boolean;
  useWorktrees: boolean;
}

interface AiBackendRowCfg {
  /** Empty string = applies as harness-wide default. */
  role: string;
  agentCmd: string;
  model: string;
  /** Whitespace-split when persisted. Stored as the raw user string. */
  extraArgsRaw: string;
}

/**
 * Roles the per-role override dropdown surfaces. The orchestrator can
 * carry overrides for any role string — this list is just the curated
 * "obvious" set; users can add a custom role name via the input.
 */
const KNOWN_ROLES = [
  'orchestrator',
  'worker',
  'validator',
  'synthesizer',
  'debugger',
  'scoper',
  'architect',
  'reviewer',
  'curator',
  'documenter',
  'scanner',
];

const DEFAULT_TIERS = [1, 2, 4];
const DEFAULT_LABELS = ['trivial', 'normal', 'hard'];
const DEFAULT_RUBRIC =
  '- Tier 1 (trivial): copy/text changes, single-file edits, well-isolated bug fixes.\n' +
  '- Tier 2 (normal): multi-file changes with clear scope, no architectural decisions.\n' +
  '- Tier 3 (hard): cross-cutting refactors, ambiguous specs, security-sensitive areas.';

const RUBRIC_MAX_BYTES = 8 * 1024;

interface TelemetryRow {
  id: number;
  ts: number;
  feature_id: string;
  requested_n: number;
  actual_n: number;
  tier_label: string | null;
  available_at_decision: number | null;
  max_slots: number | null;
  outcome: string | null;
  outcome_ts: number | null;
  duration_ms: number | null;
  synthesized: boolean | null;
  synthesis_error: string | null;
}

interface DiscordSettings {
  isShared: boolean;
  guildId: string;
  inviteUrl: string;
  saving: boolean;
  saved: boolean;
  error: string | null;
}

export default function HarnessSettingsPanel({
  slug,
  phase,
}: {
  slug: string;
  phase: string;
}) {
  const workspaceId = useWorkspaceId(); // EI-1763: tenant-scope sync reads
  // V1 hides the deprecated orchestrator-lane controls (worker-count
  // mode, fixed N, features cap, synthesizer, tiers, telemetry). They
  // remain wired (state/load/save) so a harness with these configs set
  // keeps working — only the UI rendering is flag-gated. Flip on when
  // testing features are enabled.
  const testingFlag = useFlag(FLAGS.TESTING);
  const [parallel, setParallel] = useState<ParallelWorkersCfg>({
    max: 1,
    workerCountMode: 'one',
    workersPerFeature: null,
    maxFeaturesInFlight: null,
    synthesizeSingle: true,
    adaptive: { tiers: DEFAULT_TIERS, labels: DEFAULT_LABELS, rubric: DEFAULT_RUBRIC },
  });
  const [branchIso, setBranchIso] = useState<BranchIsoCfg>({
    enabled: false,
    useWorktrees: false,
  });
  /** `debugger.threshold` — attempts at which the debugger role auto-fires before workers. */
  const [debuggerThreshold, setDebuggerThreshold] = useState<number>(3);
  /**
   * AI backend rows. The first row (role='') is the harness-wide default;
   * any further rows are per-role overrides. Resolution order at runtime:
   * roles[role] ⊕ default ⊕ process env (AGENT_CMD).
   *
   * Secrets: this UI is plaintext-config.json only — do NOT enter API
   * keys here. They belong in process env / the encrypted-credentials
   * store (future work, post-impl report).
   */
  const [aiBackend, setAiBackend] = useState<AiBackendRowCfg[]>([
    { role: '', agentCmd: '', model: '', extraArgsRaw: '' },
  ]);
  const [originalConfig, setOriginalConfig] = useState<Record<string, unknown>>({});

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [discord, setDiscord] = useState<DiscordSettings>({
    isShared: false,
    guildId: '',
    inviteUrl: '',
    saving: false,
    saved: false,
    error: null,
  });

  // harnessProjectFiles.byHarness is the sole owner of durable config.json.
  // Empty is authoritative (a harness with no row has default config); a REST
  // back-stop would let a late response overwrite a newer pushed value.
  const settingsQuery = useSyncQuery<{
    harnessSlug: string;
    config?: string | null;
  }>({
    queryName: 'harnessProjectFiles.byHarness',
    args: { harnessSlug: slug, workspaceId },
    enabled: !!slug,
  });
  const { data: settingsConfigRows, loading: settingsLoading } = settingsQuery;
  const telemetryQuery = useSyncQuery<TelemetryRow>({
    queryName: 'adaptiveTelemetry.byHarness',
    args: { harnessSlug: slug, workspaceId, limit: 200 },
    enabled: !!slug && parallel.workerCountMode === 'tiers',
  });
  const telemetry = telemetryQuery.data ?? [];
  const telemetryLoading = telemetryQuery.loading;
  const discordConfigQuery = useSyncQuery<{
    guildId: string;
    inviteUrl: string;
  }>({
    queryName: 'discordConfig.byHarness',
    args: { harnessSlug: slug, workspaceId },
    enabled: !!slug,
  });
  const { data: discordConfigRows, loading: discordConfigLoading } = discordConfigQuery;
  const applyLoadedConfig = useCallback((cfg: Record<string, unknown>) => {
    setOriginalConfig(cfg);
    const pwRaw = (cfg.parallelWorkers ?? {}) as Record<string, unknown>;
    const biRaw = (cfg.branchIsolation ?? {}) as Record<string, unknown>;
    const dbgRaw = (cfg.debugger ?? {}) as Record<string, unknown>;
    const adapRaw = (pwRaw.adaptive ?? {}) as Record<string, unknown>;
    const rawTiers = Array.isArray(adapRaw.tiers) ? adapRaw.tiers as number[] : DEFAULT_TIERS;
    const rawLabels = Array.isArray(adapRaw.labels) ? adapRaw.labels as string[] : DEFAULT_LABELS;
    const max = typeof pwRaw.max === 'number' ? pwRaw.max : 1;
    const wpfRaw = typeof pwRaw.workersPerFeature === 'number' ? pwRaw.workersPerFeature : null;

    // Migrate legacy `parallelWorkers.mode` → workerCountMode. Also
    // infer when `mode` is absent but other fields indicate intent.
    let workerCountMode: WorkerCountMode;
    if (pwRaw.mode === 'adaptive' || (pwRaw.mode === undefined && adapRaw && Object.keys(adapRaw).length > 0)) {
      workerCountMode = 'tiers';
    } else if (pwRaw.mode === 'competition' || (pwRaw.mode === undefined && wpfRaw !== null && wpfRaw > 1)) {
      workerCountMode = 'fixed';
    } else {
      workerCountMode = 'one';
    }

    setParallel({
      max,
      workerCountMode,
      workersPerFeature: wpfRaw,
      maxFeaturesInFlight: typeof pwRaw.maxFeaturesInFlight === 'number' ? pwRaw.maxFeaturesInFlight : null,
      synthesizeSingle: pwRaw.synthesizeSingle === undefined ? true : pwRaw.synthesizeSingle === true,
      adaptive: {
        tiers: rawTiers.length >= 2 && rawTiers.length === rawLabels.length ? rawTiers : DEFAULT_TIERS,
        labels: rawTiers.length >= 2 && rawTiers.length === rawLabels.length ? rawLabels : DEFAULT_LABELS,
        rubric: typeof adapRaw.rubric === 'string' ? adapRaw.rubric : DEFAULT_RUBRIC,
      },
    });
    setBranchIso({
      enabled: biRaw.enabled === true,
      useWorktrees: biRaw.useWorktrees === true,
    });
    setDebuggerThreshold(
      typeof dbgRaw.threshold === 'number' && dbgRaw.threshold > 0
        ? Math.floor(dbgRaw.threshold)
        : 3,
    );
    // aiBackend.{default, roles[role]} → flat row list
    const aiRaw = (cfg.aiBackend ?? {}) as Record<string, unknown>;
    const def = (aiRaw.default ?? {}) as Record<string, unknown>;
    const rolesObj = (aiRaw.roles ?? {}) as Record<string, Record<string, unknown>>;
    const rows: AiBackendRowCfg[] = [
      {
        role: '',
        agentCmd: typeof def.agentCmd === 'string' ? def.agentCmd : '',
        model: typeof def.model === 'string' ? def.model : '',
        extraArgsRaw: Array.isArray(def.extraArgs) ? (def.extraArgs as string[]).join(' ') : '',
      },
    ];
    for (const [role, rolCfg] of Object.entries(rolesObj)) {
      rows.push({
        role,
        agentCmd: typeof rolCfg.agentCmd === 'string' ? rolCfg.agentCmd : '',
        model: typeof rolCfg.model === 'string' ? rolCfg.model : '',
        extraArgsRaw: Array.isArray(rolCfg.extraArgs) ? (rolCfg.extraArgs as string[]).join(' ') : '',
      });
    }
    setAiBackend(rows);
    const discordCfg = (cfg.discord ?? {}) as Record<string, unknown>;
    setDiscord((prev) => ({
      ...prev,
      guildId: typeof discordCfg.guildId === 'string' ? discordCfg.guildId : '',
      inviteUrl: typeof discordCfg.inviteUrl === 'string' ? discordCfg.inviteUrl : '',
    }));
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (settingsLoading || !Array.isArray(settingsConfigRows)) return;
    const cfgRaw = settingsConfigRows[0]?.config;
    if (typeof cfgRaw !== 'string' || !cfgRaw.trim()) { applyLoadedConfig({}); return; }
    try { applyLoadedConfig(JSON.parse(cfgRaw)); }
    catch { applyLoadedConfig({}); }
  }, [settingsConfigRows, settingsLoading, applyLoadedConfig]);

  // Load discord config from the sync query and isShared status from the dedicated endpoint.
  // The sync query provides guildId/inviteUrl; isShared is fetched separately.
  useEffect(() => {
    if (discordConfigLoading || !Array.isArray(discordConfigRows)) return;
    const cfgRow = discordConfigRows[0];
    if (cfgRow) {
      setDiscord((prev) => ({
        ...prev,
        guildId: cfgRow.guildId ?? '',
        inviteUrl: cfgRow.inviteUrl ?? '',
      }));
    }
  }, [discordConfigRows, discordConfigLoading]);

  // Fetch isShared status from the REST endpoint (shared.json existence check).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/harness/${slug}/discord`)
      .then((r) => r.json())
      .then((d: { isShared?: boolean }) => {
        if (cancelled) return;
        setDiscord((prev) => ({ ...prev, isShared: d.isShared === true }));
      })
      .catch(() => { /* not critical */ });
    return () => { cancelled = true; };
  }, [slug]);

  const saveDiscord = useCallback(async () => {
    setDiscord((prev) => ({ ...prev, saving: true, error: null, saved: false }));
    try {
      const res = await fetch(`/api/harness/${slug}/discord`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ guildId: discord.guildId.trim(), inviteUrl: discord.inviteUrl.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setDiscord((prev) => ({ ...prev, saving: false, saved: true }));
      discordConfigQuery.invalidate();
      toast.success('Discord settings saved');
    } catch (e) {
      setDiscord((prev) => ({ ...prev, saving: false, error: (e as Error).message }));
      toast.error('Failed to save Discord settings', { description: (e as Error).message });
    }
  }, [slug, discord.guildId, discord.inviteUrl, discordConfigQuery]);

  // Validation for tier shape — only fires in tiers mode.
  const validation = useMemo(() => {
    if (parallel.workerCountMode !== 'tiers') return { ok: true, msg: '' };
    const t = parallel.adaptive.tiers;
    const l = parallel.adaptive.labels;
    if (t.length < 2 || t.length > 5) return { ok: false, msg: 'Tiers must have 2-5 entries' };
    if (!t.every((n) => Number.isInteger(n) && n >= 1 && n <= 64)) {
      return { ok: false, msg: 'Tier values must be integers in [1, 64]' };
    }
    for (let i = 1; i < t.length; i++) {
      if (t[i] <= t[i - 1]) return { ok: false, msg: 'Tiers must be strictly ascending' };
    }
    if (l.length !== t.length) return { ok: false, msg: `Labels (${l.length}) must match tiers (${t.length})` };
    if (!l.every((s) => s.length > 0 && s.length <= 32)) {
      return { ok: false, msg: 'Labels must be non-empty and ≤32 characters' };
    }
    // UTF-8 byte length the browser-safe way — `Buffer` is a Node global and
    // doesn't exist in the Tauri WebKit renderer ("Can't find variable: Buffer").
    if (new TextEncoder().encode(parallel.adaptive.rubric).length > RUBRIC_MAX_BYTES) {
      return { ok: false, msg: `Rubric exceeds ${RUBRIC_MAX_BYTES} bytes` };
    }
    return { ok: true, msg: '' };
  }, [parallel]);

  const save = useCallback(async () => {
    if (!validation.ok) return;
    setSaving(true);
    try {
      // Merge into the existing spec config so we don't clobber unrelated keys.
      const cfg = { ...originalConfig } as Record<string, any>;

      // The runtime keys off resolveWorkerCount (workersPerFeature +
      // tier set), not a `mode` string. Stop writing the legacy field.
      const pw: Record<string, any> = { max: parallel.max };

      if (parallel.workerCountMode === 'one') {
        pw.workersPerFeature = 1;
      } else if (parallel.workerCountMode === 'fixed') {
        pw.workersPerFeature = parallel.workersPerFeature ?? parallel.max;
      }
      // tiers mode: omit workersPerFeature so resolveWorkerCount uses
      // the tier set + orchestrator's N=k decision.

      if (parallel.maxFeaturesInFlight !== null) {
        pw.maxFeaturesInFlight = parallel.maxFeaturesInFlight;
      }
      // synthesizeSingle: default is true (synth even on N=1). Only
      // persist when user explicitly disabled.
      if (!parallel.synthesizeSingle) {
        pw.synthesizeSingle = false;
      }
      if (parallel.workerCountMode === 'tiers') {
        pw.adaptive = {
          tiers: parallel.adaptive.tiers,
          labels: parallel.adaptive.labels,
          rubric: parallel.adaptive.rubric,
        };
      }
      cfg.parallelWorkers = pw;

      // branchIso: forced-on at max>1; user-toggleable at max=1.
      const bi: Record<string, any> = { ...((cfg.branchIsolation as object) ?? {}) };
      if (parallel.max > 1) {
        bi.enabled = true;
        if (parallel.workerCountMode === 'fixed' || parallel.workerCountMode === 'tiers') {
          bi.useWorktrees = true;
        }
      } else {
        bi.enabled = branchIso.enabled;
      }
      cfg.branchIsolation = bi;

      // debugger.threshold: persist only when not the default (3).
      const dbg: Record<string, any> = { ...((cfg.debugger as object) ?? {}) };
      if (debuggerThreshold !== 3) {
        dbg.threshold = debuggerThreshold;
        cfg.debugger = dbg;
      } else if ('threshold' in dbg) {
        delete dbg.threshold;
        if (Object.keys(dbg).length === 0) {
          delete cfg.debugger;
        } else {
          cfg.debugger = dbg;
        }
      }

      // aiBackend: flatten rows back to {default, roles}. Empty fields
      // are dropped so unset rows don't pollute config.json.
      const aiOut: Record<string, unknown> = {};
      const rolesOut: Record<string, Record<string, unknown>> = {};
      for (const row of aiBackend) {
        const trimmedCmd = row.agentCmd.trim();
        const trimmedModel = row.model.trim();
        const extraArgs = row.extraArgsRaw.split(/\s+/).filter(Boolean);
        const slot: Record<string, unknown> = {};
        if (trimmedCmd) slot.agentCmd = trimmedCmd;
        if (trimmedModel) slot.model = trimmedModel;
        if (extraArgs.length > 0) slot.extraArgs = extraArgs;
        if (Object.keys(slot).length === 0) continue;
        if (row.role === '') {
          aiOut.default = slot;
        } else {
          rolesOut[row.role] = slot;
        }
      }
      if (Object.keys(rolesOut).length > 0) aiOut.roles = rolesOut;
      if (Object.keys(aiOut).length > 0) {
        cfg.aiBackend = aiOut;
      } else {
        delete cfg.aiBackend;
      }

      const res = await fetch(`/api/harness/${slug}/spec?phase=${phase}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: JSON.stringify(cfg, null, 2) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Settings saved');
      setOriginalConfig(cfg);
    } catch (e) {
      toast.error('Save failed', { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [parallel, branchIso, debuggerThreshold, aiBackend, originalConfig, slug, phase, validation.ok]);

  if (!loaded) {
    return <div style={{ padding: 24, color: 'var(--fg-mute)' }}>Loading…</div>;
  }

  const hasMaxAboveOne = parallel.max > 1;

  // ───── tier row helpers ─────
  const updateTier = (idx: number, value: string) => {
    const n = parseInt(value, 10);
    setParallel((p) => ({
      ...p,
      adaptive: {
        ...p.adaptive,
        tiers: p.adaptive.tiers.map((v, i) => (i === idx ? (Number.isFinite(n) ? n : v) : v)),
      },
    }));
  };
  const updateLabel = (idx: number, value: string) => {
    setParallel((p) => ({
      ...p,
      adaptive: {
        ...p.adaptive,
        labels: p.adaptive.labels.map((v, i) => (i === idx ? value : v)),
      },
    }));
  };
  const addTierRow = () => {
    setParallel((p) => {
      if (p.adaptive.tiers.length >= 5) return p;
      const last = p.adaptive.tiers[p.adaptive.tiers.length - 1] ?? 1;
      return {
        ...p,
        adaptive: {
          ...p.adaptive,
          tiers: [...p.adaptive.tiers, last + 2],
          labels: [...p.adaptive.labels, `tier-${p.adaptive.tiers.length + 1}`],
        },
      };
    });
  };
  const removeTierRow = (idx: number) => {
    setParallel((p) => {
      if (p.adaptive.tiers.length <= 2) return p;
      return {
        ...p,
        adaptive: {
          ...p.adaptive,
          tiers: p.adaptive.tiers.filter((_, i) => i !== idx),
          labels: p.adaptive.labels.filter((_, i) => i !== idx),
        },
      };
    });
  };

  // ───── telemetry columns ─────
  const telemetryColumns: ColumnDef<TelemetryRow>[] = [
    {
      key: 'when', header: 'When', width: 2,
      toCopyText: (r) => new Date(r.ts).toISOString(),
      render: ({ row }) => <>{new Date(row.ts).toLocaleString()}</>,
    },
    {
      key: 'feature', header: 'Feature', width: 2,
      toCopyText: (r) => r.feature_id,
      render: ({ row }) => <>{row.feature_id}</>,
    },
    {
      key: 'n', header: 'N', width: 1,
      toCopyText: (r) => r.requested_n === r.actual_n ? String(r.actual_n) : `${r.actual_n} (req ${r.requested_n})`,
      render: ({ row }) => <>{row.requested_n === row.actual_n ? row.actual_n : `${row.actual_n} (req ${row.requested_n})`}</>,
    },
    {
      key: 'tier', header: 'Tier', width: 1,
      toCopyText: (r) => r.tier_label ?? '',
      render: ({ row }) => <>{row.tier_label ?? '—'}</>,
    },
    {
      key: 'slots', header: 'Slots', width: 1,
      toCopyText: (r) => r.max_slots != null && r.available_at_decision != null ? `${r.available_at_decision}/${r.max_slots}` : '',
      render: ({ row }) => <>{row.max_slots != null && row.available_at_decision != null ? `${row.available_at_decision}/${row.max_slots}` : '—'}</>,
    },
    {
      key: 'synth', header: 'Synth', width: 1.5,
      toCopyText: (r) => r.synthesized === true ? 'ok' : r.synthesized === false ? `failed${r.synthesis_error ? `: ${r.synthesis_error}` : ''}` : '',
      render: ({ row }) => {
        const text = row.synthesized === true ? 'ok' : row.synthesized === false ? `failed${row.synthesis_error ? ` (${row.synthesis_error.slice(0, 40)})` : ''}` : '—';
        const color = row.synthesized === false ? 'var(--bad, #d97757)' : 'var(--fg-mute)';
        return <span style={{ color }} title={row.synthesis_error ?? undefined}>{text}</span>;
      },
    },
    {
      key: 'outcome', header: 'Outcome', width: 1,
      toCopyText: (r) => r.outcome ?? 'pending',
      render: ({ row }) => {
        const color = row.outcome === 'pass' ? 'var(--good, #6aa84f)' : row.outcome === 'fail' ? 'var(--bad, #d97757)' : 'var(--fg-mute)';
        return <span style={{ color }}>{row.outcome ?? 'pending'}</span>;
      },
    },
    {
      key: 'duration', header: 'Duration', width: 1,
      toCopyText: (r) => r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '',
      render: ({ row }) => <>{row.duration_ms != null ? `${(row.duration_ms / 1000).toFixed(1)}s` : '—'}</>,
    },
  ];

  return (
    <div style={{ padding: 16, maxWidth: 920, overflowY: 'auto' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Settings — {slug}</h1>
        <p style={{ margin: '6px 0 0', color: 'var(--fg-mute)', fontSize: 12.5 }}>
          Per-harness configuration. Saved to <code>{phase}</code> spec
          (<code>config.json</code>). Changes take effect on the next harness run.
        </p>
      </header>

      {/* ── Section 1: Workers ──────────────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Workers</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 110, fontSize: 11.5, color: 'var(--fg-mute)' }}>max workers</span>
            <input
              type="number"
              min={1}
              max={64}
              value={parallel.max}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setParallel((p) => ({ ...p, max: Number.isFinite(n) ? n : 1 }));
              }}
              style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
            />
            <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>1-64 total concurrent</span>
          </div>

          {testingFlag && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 110, fontSize: 11.5, color: 'var(--fg-mute)' }}>workers / feature</span>
              <Select
                value={parallel.workerCountMode}
                onChange={(v) =>
                  setParallel((p) => ({ ...p, workerCountMode: v as WorkerCountMode }))
                }
                options={[
                  { value: 'one', label: 'one' },
                  { value: 'fixed', label: 'fixed N' },
                  { value: 'tiers', label: 'orchestrator picks' },
                ]}
              />
            </div>
          )}

          {testingFlag && parallel.workerCountMode === 'fixed' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 110, fontSize: 11.5, color: 'var(--fg-mute)' }}>N per feature</span>
              <input
                type="number"
                min={2}
                max={parallel.max}
                value={parallel.workersPerFeature ?? ''}
                placeholder={String(parallel.max)}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') {
                    setParallel((p) => ({ ...p, workersPerFeature: null }));
                  } else {
                    const n = parseInt(v, 10);
                    setParallel((p) => ({ ...p, workersPerFeature: Number.isFinite(n) ? n : null }));
                  }
                }}
                style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
              />
              <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                empty = all {parallel.max} on each feature
              </span>
            </div>
          )}

          {/* maxFeaturesInFlight — applies to every parallel mode. Caps
              the number of distinct features the orchestrator can have
              workers on at once, even if there are more worker slots
              free. Useful when you want to constrain "width" without
              reducing the total worker budget. Testing-only. */}
          {testingFlag && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 80, fontSize: 11.5, color: 'var(--fg-mute)' }}>features cap</span>
              <input
                type="number"
                min={1}
                value={parallel.maxFeaturesInFlight ?? ''}
                placeholder="no cap"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') {
                    setParallel((p) => ({ ...p, maxFeaturesInFlight: null }));
                  } else {
                    const n = parseInt(v, 10);
                    setParallel((p) => ({ ...p, maxFeaturesInFlight: Number.isFinite(n) && n > 0 ? n : null }));
                  }
                }}
                style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
              />
              <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                {parallel.max > 1
                  ? 'empty = unlimited (only worker slots limit)'
                  : 'empty = unlimited (takes effect when max > 1)'}
              </span>
            </div>
          )}

          {/* ── Synthesizer knob ─────────────────────────────────── */}
          {testingFlag && (
            <div style={{ marginTop: 6, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
              <div style={{ fontSize: 11.5, color: 'var(--fg-mute)', marginBottom: 6, fontStyle: 'italic' }}>
                Synthesizer (always merges/polishes worker output before validation)
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                <Checkbox
                  checked={parallel.synthesizeSingle}
                  onChange={(v) => setParallel((p) => ({ ...p, synthesizeSingle: v }))}
                  ariaLabel="synthesize single-worker output"
                />
                <span>synthesize single-worker output</span>
                <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                  (off = skip extra LLM call when N=1)
                </span>
              </label>
              <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 6, lineHeight: 1.5 }}>
                ↳ to upgrade the model the synthesizer runs on (e.g. opus), add
                a <code>synthesizer</code> override in the <em>AI backend</em>
                section below.
              </div>
            </div>
          )}

          {/* ── Debugger threshold ──────────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <span style={{ width: 110, fontSize: 11.5, color: 'var(--fg-mute)' }}>debugger after</span>
            <input
              type="number"
              min={1}
              max={20}
              value={debuggerThreshold}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n > 0) setDebuggerThreshold(n);
              }}
              style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
            />
            <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
              attempts (debugger auto-fires before worker)
            </span>
          </div>

          {/* `branch isolation` remains a compatibility config field; worker
              dispatch now always uses the ordinary invoke path. */}

          <div style={{ fontSize: 11.5, color: 'var(--fg-mute)', lineHeight: 1.5, marginTop: 4 }}>
            {testingFlag ? (
              <>
                ↳{' '}
                {parallel.workerCountMode === 'one' ? (
                  <>up to <strong>{parallel.max}</strong> different feature{parallel.max === 1 ? '' : 's'} in parallel, 1 worker each</>
                ) : parallel.workerCountMode === 'fixed' ? (
                  (() => {
                    const wpf = parallel.workersPerFeature ?? parallel.max;
                    const inFlight = Math.max(1, Math.floor(parallel.max / wpf));
                    return (
                      <>
                        <strong>{wpf}</strong> worker{wpf === 1 ? '' : 's'}/feature,{' '}
                        <strong>{inFlight}</strong> feature{inFlight === 1 ? '' : 's'} in flight (max {parallel.max})
                      </>
                    );
                  })()
                ) : (
                  <>
                    orchestrator picks N per feature from{' '}
                    <strong>{`{${parallel.adaptive.tiers.join(', ')}}`}</strong> (max {parallel.max})
                  </>
                )}
                {hasMaxAboveOne && (
                  <>; branchIso auto-on{(parallel.workerCountMode === 'fixed' || parallel.workerCountMode === 'tiers') && ' + worktrees'}</>
                )}
              </>
            ) : (
              <>
                ↳ up to <strong>{parallel.max}</strong> feature{parallel.max === 1 ? '' : 's'} in parallel, one worker each.
              </>
            )}
          </div>
        </div>
      </section>

      {/* ── Section 2: Worker count tiers ───────────────────── */}
      {testingFlag && parallel.workerCountMode === 'tiers' && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Worker count tiers</h2>
          <p style={{ margin: '0 0 8px', color: 'var(--fg-mute)', fontSize: 11.5 }}>
            2–5 ascending integer tiers. Orchestrator picks one per feature based on the rubric.
            Lowest tier is the fallback when no <code>N=</code> is emitted.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {parallel.adaptive.tiers.map((value, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 60, fontSize: 11, color: 'var(--fg-mute)' }}>
                  Tier {idx + 1}
                </span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={value}
                  onChange={(e) => updateTier(idx, e.target.value)}
                  style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
                />
                <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>workers</span>
                <input
                  type="text"
                  value={parallel.adaptive.labels[idx] ?? ''}
                  onChange={(e) => updateLabel(idx, e.target.value)}
                  placeholder="label"
                  maxLength={32}
                  style={{ width: 140, fontSize: 13, padding: '3px 6px' }}
                />
                <Tooltip label={parallel.adaptive.tiers.length <= 2 ? 'Need at least 2 tiers' : 'Remove row'}><button
                  type="button"
                  onClick={() => removeTierRow(idx)}
                  disabled={parallel.adaptive.tiers.length <= 2}

                  style={{ fontSize: 11, padding: '2px 8px' }}
                >
                  ✕
                </button></Tooltip>
              </div>
            ))}
            <button
              type="button"
              onClick={addTierRow}
              disabled={parallel.adaptive.tiers.length >= 5}
              style={{ alignSelf: 'flex-start', fontSize: 11, padding: '3px 10px', marginTop: 4 }}
            >
              + Add tier
            </button>
          </div>

          <h3 style={{ fontSize: 13, margin: '16px 0 6px' }}>Difficulty rubric</h3>
          <p style={{ margin: '0 0 8px', color: 'var(--fg-mute)', fontSize: 11.5 }}>
            Appended to the orchestrator prompt — guides which tier it picks per feature.
          </p>
          <textarea
            value={parallel.adaptive.rubric}
            onChange={(e) => setParallel((p) => ({ ...p, adaptive: { ...p.adaptive, rubric: e.target.value } }))}
            placeholder={DEFAULT_RUBRIC}
            rows={6}
            style={{
              width: '100%', fontSize: 12, padding: 8, fontFamily: 'monospace',
              background: 'var(--bg-1)',
              border: '1px solid var(--border)', borderRadius: 4,
              color: 'inherit',
            }}
          />
        </section>
      )}

      {/* ── Section 2.5: AI backend (per-harness default + per-role overrides) ─ */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>AI backend</h2>
        <p style={{ margin: '0 0 8px', color: 'var(--fg-mute)', fontSize: 11.5 }}>
          Default agent command + per-role overrides. Resolution at invoke
          time: <code>roles[role]</code> ⊕ <code>default</code> ⊕ process env
          (<code>AGENT_CMD</code>). Leave blank to fall through. Common
          values: <code>omp -p</code>, <code>claude -p</code>,
          <code>omp -p --model claude-sonnet-4-6</code>.
        </p>
        <p style={{ margin: '0 0 8px', color: 'var(--bad, #d97757)', fontSize: 11.5 }}>
          ⚠ Do not put API keys here — config.json is plaintext. Set secrets
          in the shell environment for now.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {aiBackend.map((row, idx) => {
            const isDefault = row.role === '';
            const usedRoles = new Set(aiBackend.filter((_, i) => i !== idx).map((r) => r.role));
            const availableRoles = KNOWN_ROLES.filter((r) => !usedRoles.has(r));
            return (
              <div
                key={idx}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '140px 1fr 160px 200px 32px',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                {isDefault ? (
                  <div style={{ fontSize: 12, color: 'var(--fg-mute)', fontWeight: 500 }}>
                    default (all roles)
                  </div>
                ) : (
                  <input
                    type="text"
                    list={`ai-roles-${idx}`}
                    value={row.role}
                    placeholder="role"
                    onChange={(e) => {
                      const v = e.target.value;
                      setAiBackend((rows) => rows.map((r, i) => (i === idx ? { ...r, role: v } : r)));
                    }}
                    style={{ fontSize: 12, padding: '3px 6px' }}
                  />
                )}
                <input
                  type="text"
                  value={row.agentCmd}
                  placeholder={isDefault ? 'omp -p' : '(inherits default)'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAiBackend((rows) => rows.map((r, i) => (i === idx ? { ...r, agentCmd: v } : r)));
                  }}
                  style={{ fontSize: 12, padding: '3px 6px', fontFamily: 'monospace' }}
                />
                <input
                  type="text"
                  value={row.model}
                  placeholder="model (optional)"
                  onChange={(e) => {
                    const v = e.target.value;
                    setAiBackend((rows) => rows.map((r, i) => (i === idx ? { ...r, model: v } : r)));
                  }}
                  style={{ fontSize: 12, padding: '3px 6px', fontFamily: 'monospace' }}
                />
                <input
                  type="text"
                  value={row.extraArgsRaw}
                  placeholder="extra args (whitespace-split)"
                  onChange={(e) => {
                    const v = e.target.value;
                    setAiBackend((rows) => rows.map((r, i) => (i === idx ? { ...r, extraArgsRaw: v } : r)));
                  }}
                  style={{ fontSize: 12, padding: '3px 6px', fontFamily: 'monospace' }}
                />
                {isDefault ? (
                  <span />
                ) : (
                  <Tooltip label="Remove role override"><button
                    type="button"
                    onClick={() => setAiBackend((rows) => rows.filter((_, i) => i !== idx))}

                    style={{ fontSize: 11, padding: '2px 6px' }}
                  >
                    ✕
                  </button></Tooltip>
                )}
                {!isDefault && (
                  <datalist id={`ai-roles-${idx}`}>
                    {availableRoles.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => {
              const used = new Set(aiBackend.map((r) => r.role));
              const next = KNOWN_ROLES.find((r) => !used.has(r)) ?? '';
              setAiBackend((rows) => [...rows, { role: next, agentCmd: '', model: '', extraArgsRaw: '' }]);
            }}
            style={{ alignSelf: 'flex-start', fontSize: 11, padding: '3px 10px', marginTop: 4 }}
          >
            + Add role override
          </button>
        </div>
      </section>

      {/* ── Section: Discord ────────────────────────────────── */}
      <section style={{ marginBottom: 24, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <h2 style={{ fontSize: 14, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#5865F2', flexShrink: 0 }} aria-hidden>
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.031.056a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
          Discord
        </h2>
        {!discord.isShared ? (
          <p style={{ margin: 0, color: 'var(--fg-mute)', fontSize: 11.5, fontStyle: 'italic' }}>
            Discord integration is only available for shared harnesses. Use the Share button to publish this harness first.
          </p>
        ) : (
          <>
            <p style={{ margin: '0 0 12px', color: 'var(--fg-mute)', fontSize: 11.5 }}>
              Link a Discord server to show a live online-count badge in the /adv navbar.
              Requires the Discord server widget to be enabled in Server Settings → Widget.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 540 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ width: 90, fontSize: 11.5, color: 'var(--fg-mute)', flexShrink: 0 }}>Guild ID</label>
                <input
                  type="text"
                  value={discord.guildId}
                  onChange={(e) => setDiscord((prev) => ({ ...prev, guildId: e.target.value, saved: false }))}
                  placeholder="e.g. 1509111829471690783"
                  style={{ flex: 1, fontSize: 12, padding: '4px 8px', fontFamily: 'monospace' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ width: 90, fontSize: 11.5, color: 'var(--fg-mute)', flexShrink: 0 }}>Invite URL</label>
                <input
                  type="text"
                  value={discord.inviteUrl}
                  onChange={(e) => setDiscord((prev) => ({ ...prev, inviteUrl: e.target.value, saved: false }))}
                  placeholder="https://discord.gg/…"
                  style={{ flex: 1, fontSize: 12, padding: '4px 8px' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => void saveDiscord()}
                  disabled={discord.saving || !discord.guildId.trim()}
                  style={{ fontSize: 12, padding: '5px 14px', cursor: discord.saving || !discord.guildId.trim() ? 'not-allowed' : 'pointer' }}
                >
                  {discord.saving ? 'Saving…' : 'Save Discord'}
                </button>
                {discord.saved && (
                  <span style={{ fontSize: 11.5, color: 'var(--good, #6aa84f)' }}>✓ Saved</span>
                )}
                {discord.error && (
                  <span style={{ fontSize: 11.5, color: 'var(--bad, #d97757)' }}>⚠ {discord.error}</span>
                )}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-mute)', lineHeight: 1.5 }}>
                To enable the widget: Discord → Server Settings → Widget → Enable Server Widget.
                The Guild ID is shown there too. The badge refreshes every 5 minutes.
              </p>
            </div>
          </>
        )}
      </section>

      {/* ── Save bar ────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!validation.ok || saving}
          style={{
            fontSize: 13, padding: '6px 18px',
            cursor: !validation.ok || saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {!validation.ok && (
          <span style={{ fontSize: 11.5, color: 'var(--bad, #d97757)' }}>⚠ {validation.msg}</span>
        )}
      </div>

      {/* ── Section 3: Worker decisions (tiers mode only) ───── */}
      {testingFlag && parallel.workerCountMode === 'tiers' && (
        <section>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ fontSize: 14, margin: 0 }}>Recent worker decisions</h2>
            <button
              type="button"
              onClick={() => telemetryQuery.invalidate()}
              disabled={telemetryLoading}
              style={{ fontSize: 11, padding: '3px 10px' }}
            >
              {telemetryLoading ? '…' : 'Refresh'}
            </button>
          </div>
          {telemetry.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--fg-mute)', fontSize: 12 }}>
              No worker decisions recorded yet. Run the harness with tier-mode worker counts to populate.
            </div>
          ) : (
            <div style={{ height: 360, border: '1px solid var(--border)', borderRadius: 4 }}>
              <VirtualGrid<TelemetryRow>
                columns={telemetryColumns}
                rows={telemetry}
                getRowId={(r) => String(r.id)}
                rowMinHeight={32}
                headerHeight={32}
                estimateRowHeight={32}
              />
            </div>
          )}
        </section>
      )}

      {/* P-017 (pot-review-integration-mode-2026-10-05, D-007): "Where should the
          agents' work go?" with guided switching. Saves independently of the
          config.json Save bar; hidden for projects that are not pots. */}
      <IntegrationModeSection slug={slug} />

      <SavedPromptsSection scope={{ kind: 'harness', slug }} />

      {/* Plugins — relocated from the retired Config tab (config-tab-cleanup-
          2026-06-08). Per-harness plugin enable/disable/configure/invoke; saves
          independently of the config.json Save bar above. */}
      <HarnessPluginsSection slug={slug} />
    </div>
  );
}
