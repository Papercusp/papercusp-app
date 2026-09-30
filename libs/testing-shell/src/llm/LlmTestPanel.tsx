'use client';
/**
 * LlmTestPanel — generic scenario-driven LLM-testing UI (Phase 7, P-072 of
 * universal-testing-domains-generic-2026-06-03). Ported from the operator's
 * admin/testing LlmTab.
 *
 * Generalized for cross-project reuse:
 *  - Every backend route is a PROP (scenariosEndpoint / runsEndpoint /
 *    runDetailEndpoint / findingsEndpoint / credentialsEndpoint). The lib bakes
 *    no `/api/admin/llm-tests/...` path; the consumer supplies its own (the
 *    operator's current paths are documented as the defaults a host should pass,
 *    NOT hardcoded here).
 *  - The operator's `../harness/Button` is replaced by a local token-styled
 *    Button (same pattern as ChaosDesktopPanel / AiExplorePanel — zero operator
 *    imports).
 *  - The pc-test-* styling ships in ./llm-test.css so the panel is
 *    self-contained.
 *  - nuqs (`useQueryState`) drives the 4-subtab + filter state, matching the
 *    repo's URL-state convention (nuqs is a lib peer dep).
 *
 * Domain/SUT-agnostic: the panel renders whatever scenarios/runs/findings the
 * injected backend returns. It imports nothing host-coupled (no @/lib/*, no
 * @papercusp/papercusp-shared, no apps/operator). The framework severity /
 * finding-source unions are reused from ../llm/types rather than redefined.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useQueryState, parseAsStringEnum, parseAsString } from 'nuqs';
import './llm-test.css';
import type { JudgeFinding, JudgeResult } from './types';

const alpha = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

// ── Local token-styled button (replaces the operator's harness Button) ──
function Button({
  variant = 'ghost',
  onClick,
  disabled,
  title,
  children,
}: {
  variant?: 'primary' | 'ghost' | 'destructive';
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}): ReactElement {
  const color = variant === 'primary' ? 'var(--accent)' : variant === 'destructive' ? 'var(--bad)' : 'var(--fg-dim)';
  const filled = variant !== 'ghost';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: filled ? alpha(color, 13) : 'transparent',
        border: `1px solid ${filled ? alpha(color, 40) : 'var(--border)'}`,
        color,
        borderRadius: 4,
        padding: '6px 12px',
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ── Props: every backend route is injected ──
export interface LlmTestPanelProps {
  /** GET → `{ scenarios: ScenarioRow[] }`. Operator default: `/api/admin/llm-tests/scenarios`. */
  scenariosEndpoint: string;
  /** GET (?target=&status=) → `{ runs: RunRow[] }`. Operator default: `/api/admin/llm-tests/runs`. */
  runsEndpoint: string;
  /**
   * GET `${runDetailEndpoint}/${runId}` → RunDetail. Operator default:
   * `/api/admin/llm-tests/runs` (run detail is the same base + `/${id}`).
   */
  runDetailEndpoint: string;
  /**
   * GET (?severity=&source=&acknowledged=) → `{ findings: FindingRow[]; shapeCounts }`,
   * PATCH `${findingsEndpoint}/${id}` `{ acknowledged }`. Operator default:
   * `/api/admin/llm-tests/findings`.
   */
  findingsEndpoint: string;
  /**
   * Optional GET/POST `{ anthropic_api_key, updated_at }` for the judge/sim-user
   * API-key strip. Omit → the key-management strip is hidden (the backend owns
   * the key; a missing key surfaces as a run error). Operator default:
   * `/api/credentials`.
   */
  credentialsEndpoint?: string;
}

type Subtab = 'targets' | 'scenarios' | 'runs' | 'findings';

// ── Wire row shapes (the snake_case API envelopes the backend returns). These
// are the on-the-wire shapes, distinct from the framework's domain types
// (RunSummary / Scenario in ../llm/types); the framework severity + judge-result
// shapes ARE reused below where the wire embeds them. ──
type RunRow = {
  id: string;
  scenario_id: string;
  scenario_target: string;
  status: string;
  sut_model: string;
  judge_model: string;
  persona_id: string;
  started_at: string;
  finished_at: string | null;
  cost_usd: string | number;
  scores_json: Record<string, number> | null;
  findings_count: Record<string, number>;
  cap_breaches: string[];
  matrix_group_id: string | null;
  matrix_index: number | null;
};
type ScenarioRow = {
  id: string;
  version: number;
  target: string;
  description: string;
  persona: string;
  runMatrix: { repeat: number; variancePolicy?: string } | null;
  realWorkspace: boolean;
  transport: string;
  rubricVersion: string;
  assertCount: number;
  caps: { maxTurns: number; maxWallSecs: number; maxCostUsd: number };
};
type FindingRow = {
  id: string;
  run_id: string;
  source: 'assert' | 'judge' | 'variance';
  severity: JudgeFinding['severity'];
  axis: string | null;
  assert_kind: string | null;
  evidence_turn_idx: number | null;
  claim: string;
  suggestion: string | null;
  copy_prompt: string | null;
  acknowledged: boolean;
  // Promotion/grouping fields the findings list reads (present on the wire).
  shape?: string;
  scenario_id?: string;
  started_at?: string;
  promoted_to_assert_id?: string | null;
};

export default function LlmTestPanel(props: LlmTestPanelProps): ReactElement {
  const [subtab, setSubtab] = useQueryState(
    'subtab',
    parseAsStringEnum<Subtab>(['targets', 'scenarios', 'runs', 'findings']).withDefault('runs'),
  );

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">LLM testing</h1>
          <p className="pc-test-tab-intro">
            Scenario-driven, judge-scored tests for any LLM chat surface (sim-user → SUT → judge).
            Backend only — no UI driving.
          </p>
        </div>
      </header>

      {props.credentialsEndpoint ? <AnthropicKeyStrip endpoint={props.credentialsEndpoint} /> : null}

      <nav className="pc-test-subnav" aria-label="LLM testing subtabs">
        <Button variant={subtab === 'runs' ? 'primary' : 'ghost'} onClick={() => setSubtab('runs')}>Runs</Button>
        <Button variant={subtab === 'scenarios' ? 'primary' : 'ghost'} onClick={() => setSubtab('scenarios')}>Scenarios</Button>
        <Button variant={subtab === 'targets' ? 'primary' : 'ghost'} onClick={() => setSubtab('targets')}>Targets</Button>
        <Button variant={subtab === 'findings' ? 'primary' : 'ghost'} onClick={() => setSubtab('findings')}>Findings</Button>
      </nav>

      <div style={{ marginTop: 16 }}>
        {subtab === 'runs' && <RunsView runsEndpoint={props.runsEndpoint} runDetailEndpoint={props.runDetailEndpoint} />}
        {subtab === 'scenarios' && <ScenariosView scenariosEndpoint={props.scenariosEndpoint} />}
        {subtab === 'targets' && <TargetsView scenariosEndpoint={props.scenariosEndpoint} />}
        {subtab === 'findings' && <FindingsView findingsEndpoint={props.findingsEndpoint} />}
      </div>
    </>
  );
}

function AnthropicKeyStrip({ endpoint }: { endpoint: string }) {
  const [masked, setMasked] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetch(endpoint)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { setMasked(j.anthropic_api_key ?? null); setUpdatedAt(j.updated_at ?? null); })
      .catch((e) => setError((e as Error).message));
  };

  useEffect(load, [endpoint]);

  const post = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anthropic_api_key: key }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setMasked(j.anthropic_api_key ?? null);
      setUpdatedAt(j.updated_at ?? null);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () => post(draft);
  const clear = () => {
    if (!confirm('Clear stored Anthropic API key?')) return;
    void post('');
  };

  return (
    <div className="pc-test-card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, minWidth: 140 }}>Anthropic API key</div>
        <div style={{ color: 'var(--fg-mute, #888)', fontSize: 12, minWidth: 220 }}>
          {masked ? <>stored: <code>{masked}</code>{updatedAt ? ` · ${new Date(updatedAt).toLocaleString()}` : ''}</> : <em>not set — sim-user + judge will fail</em>}
        </div>
        <input
          className="pc-test-input"
          type="password"
          placeholder="sk-ant-…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1, minWidth: 280 }}
          autoComplete="off"
        />
        <Button variant="primary" onClick={save} disabled={busy || !draft.trim()}>
          {masked ? 'Replace' : 'Save'}
        </Button>
        {masked ? <Button variant="ghost" onClick={clear} disabled={busy}>Clear</Button> : null}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-mute, #888)' }}>
        Persisted by the host&apos;s credentials store. An <code>ANTHROPIC_API_KEY</code> env var takes precedence when set.
      </div>
      {error ? <div style={{ marginTop: 6, color: 'var(--bad, #c33)', fontSize: 12 }}>Error: {error}</div> : null}
    </div>
  );
}

function TargetsView({ scenariosEndpoint }: { scenariosEndpoint: string }) {
  const [data, setData] = useState<ScenarioRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(scenariosEndpoint)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setData(j.scenarios as ScenarioRow[]))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [scenariosEndpoint]);

  const [, setSubtab] = useQueryState(
    'subtab',
    parseAsStringEnum<Subtab>(['targets', 'scenarios', 'runs', 'findings']).withDefault('runs'),
  );
  const [, setTargetFilter] = useQueryState('target', parseAsString.withDefault(''));

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const byTarget = new Map<string, ScenarioRow[]>();
  for (const s of data) {
    const arr = byTarget.get(s.target) ?? [];
    arr.push(s);
    byTarget.set(s.target, arr);
  }
  const entries = Array.from(byTarget.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="pc-test-card">
      <table className="pc-test-table">
        <thead>
          <tr>
            <th>target</th>
            <th>scenarios</th>
            <th>personas</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([target, scenarios]) => {
            const personas = new Set(scenarios.map((s) => s.persona));
            return (
              <tr key={target}>
                <td><strong>{target}</strong></td>
                <td>{scenarios.length}</td>
                <td>{Array.from(personas).join(', ')}</td>
                <td>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setTargetFilter(target);
                      setSubtab('runs');
                    }}
                  >
                    runs →
                  </Button>{' '}
                  <Button variant="ghost" onClick={() => setSubtab('scenarios')}>
                    scenarios →
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ScenariosView({ scenariosEndpoint }: { scenariosEndpoint: string }) {
  const [data, setData] = useState<ScenarioRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(scenariosEndpoint)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setData(j.scenarios as ScenarioRow[]))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [scenariosEndpoint]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (data.length === 0) return <Empty msg="No scenarios registered." />;

  return (
    <div className="pc-test-card">
      <table className="pc-test-table">
        <thead>
          <tr>
            <th>id</th>
            <th>target</th>
            <th>persona</th>
            <th>matrix</th>
            <th>transport</th>
            <th>asserts</th>
            <th>caps</th>
            <th>description</th>
          </tr>
        </thead>
        <tbody>
          {data.map((s) => (
            <tr key={s.id}>
              <td><code>{s.id}</code> v{s.version}</td>
              <td>{s.target}</td>
              <td>{s.persona}</td>
              <td>{s.runMatrix ? `${s.runMatrix.repeat}×` : '1×'}</td>
              <td>{s.transport}</td>
              <td>{s.assertCount}</td>
              <td>{s.caps.maxTurns}t / {s.caps.maxWallSecs}s / ${s.caps.maxCostUsd}</td>
              <td style={{ maxWidth: 400 }}>{s.description.slice(0, 120)}{s.description.length > 120 ? '…' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunsView({ runsEndpoint, runDetailEndpoint }: { runsEndpoint: string; runDetailEndpoint: string }) {
  const [targetFilter, setTargetFilter] = useQueryState('target', parseAsString.withDefault(''));
  const [statusFilter, setStatusFilter] = useQueryState('status', parseAsString.withDefault(''));
  const [selectedRunId, setSelectedRunId] = useQueryState('run', parseAsString.withDefault(''));
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const url = new URL(runsEndpoint, window.location.origin);
    if (targetFilter) url.searchParams.set('target', targetFilter);
    if (statusFilter) url.searchParams.set('status', statusFilter);
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setRuns(j.runs as RunRow[]))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [targetFilter, statusFilter, runsEndpoint]);

  if (error) return <ErrorBox error={error} />;
  if (!runs) return <Loading />;

  return (
    <>
      <div className="pc-test-card-row" style={{ marginBottom: 12 }}>
        <input
          className="pc-test-input"
          placeholder="filter target (e.g. operator)"
          value={targetFilter}
          onChange={(e) => setTargetFilter(e.target.value || null)}
        />
        <select
          className="pc-test-input"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value || null)}
        >
          <option value="">any status</option>
          <option value="passed">passed</option>
          <option value="failed">failed</option>
          <option value="errored">errored</option>
          <option value="preview">preview</option>
        </select>
      </div>

      {runs.length === 0 ? (
        <Empty msg="No runs yet. Record one via the host's llm-test CLI." />
      ) : (
        <div className="pc-test-card">
          <table className="pc-test-table">
            <thead>
              <tr>
                <th>started</th>
                <th>scenario</th>
                <th>persona</th>
                <th>SUT / judge</th>
                <th>status</th>
                <th>scores</th>
                <th>cost</th>
                <th>findings</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} onClick={() => setSelectedRunId(r.id)} style={{ cursor: 'pointer' }}
                    className={r.id === selectedRunId ? 'is-selected' : undefined}>
                  <td title={r.started_at}>{new Date(r.started_at).toLocaleString()}</td>
                  <td><code>{r.scenario_id}</code></td>
                  <td>{r.persona_id}</td>
                  <td>{r.sut_model.replace('claude-', '')} / {r.judge_model.replace('claude-', '')}</td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.matrix_group_id ? <span className="pc-test-badge is-muted">#{(r.matrix_index ?? 0) + 1}</span> : null}
                  </td>
                  <td>{formatScores(r.scores_json)}</td>
                  <td>${Number(r.cost_usd).toFixed(4)}</td>
                  <td>{formatFindings(r.findings_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedRunId ? (
        <RunDetailPanel runId={selectedRunId} runDetailEndpoint={runDetailEndpoint} onClose={() => setSelectedRunId(null)} />
      ) : null}
    </>
  );
}

interface RunDetail {
  run: {
    id: string;
    scenario_id: string;
    scenario_target: string;
    persona_id: string;
    persona_traits_json: Record<string, unknown>;
    sut_model: string;
    judge_model: string;
    workspace_mode: string;
    transport_mode: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    cost_usd: string | number;
    cap_breaches: string[];
    scores_json: Record<string, number> | null;
    transcript_norm_json: Array<{
      idx: number;
      assistantText: string;
      userText?: string;
      simThought?: string;
      simKind?: string;
      toolCalls: Array<{ name: string; input?: unknown }>;
      cards: Array<{ kind: string; voiceAnswerable?: boolean }>;
      controlTags: Array<{ tag: string; attrs?: Record<string, string> }>;
      finishReason: string;
      costUsd: number;
      latencyMs: number;
      error?: string | null;
    }>;
    telemetry_json: { toolInvocations?: Array<{ toolName: string; status: string }>; continueChainRows?: unknown[] } | null;
    // The judge envelope is the framework's JudgeResult, loosened for wire findings.
    judge_json: (Pick<JudgeResult, 'scores' | 'notes' | 'judgeOverruledAssert' | 'costUsd'> & {
      findings: Array<Pick<JudgeFinding, 'axis' | 'severity' | 'claim' | 'suggestion'> & { copyPrompt?: string; evidenceTurnIdx?: number }>;
    }) | null;
  };
  findings: FindingRow[];
}

function RunDetailPanel({ runId, runDetailEndpoint, onClose }: { runId: string; runDetailEndpoint: string; onClose: () => void }) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedTurn, setExpandedTurn] = useState<number | null>(0);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    fetch(`${runDetailEndpoint}/${runId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setData(j as RunDetail))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [runId, runDetailEndpoint]);

  return (
    <div
      role="dialog"
      aria-label="Run detail"
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: '70vw', maxWidth: 1100,
        background: 'var(--bg, #fff)', borderLeft: '1px solid var(--border, #ddd)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
        overflow: 'auto', padding: 16, zIndex: 100,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Run detail</h2>
        <Button variant="ghost" onClick={onClose}>close</Button>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {!data && !error ? <Loading /> : null}
      {data ? <RunDetailBody data={data} expandedTurn={expandedTurn} onToggleTurn={setExpandedTurn} /> : null}
    </div>
  );
}

function RunDetailBody({
  data,
  expandedTurn,
  onToggleTurn,
}: {
  data: RunDetail;
  expandedTurn: number | null;
  onToggleTurn: (idx: number | null) => void;
}) {
  const { run, findings } = data;
  const turns = Array.isArray(run.transcript_norm_json) ? run.transcript_norm_json : [];
  const tools = run.telemetry_json?.toolInvocations ?? [];
  const assertViolations = findings.filter((f) => f.source === 'assert');
  const judgeFindings = findings.filter((f) => f.source === 'judge');
  const varianceFindings = findings.filter((f) => f.source === 'variance');

  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };

  return (
    <>
      <section className="pc-test-card" style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 12 }}>
          <div><strong>scenario</strong><br /><code>{run.scenario_id}</code></div>
          <div><strong>target</strong><br />{run.scenario_target}</div>
          <div><strong>persona</strong><br />{run.persona_id}</div>
          <div><strong>status</strong><br /><StatusBadge status={run.status} /></div>
          <div><strong>SUT</strong><br />{run.sut_model.replace('claude-', '')}</div>
          <div><strong>judge</strong><br />{run.judge_model.replace('claude-', '')}</div>
          <div>
            <strong>cost</strong><br />${Number(run.cost_usd).toFixed(4)}
            {run.judge_json?.costUsd != null ? (
              <span style={{ color: 'var(--fg-mute, #888)' }}> (judge ${run.judge_json.costUsd.toFixed(4)})</span>
            ) : null}
          </div>
          <div><strong>workspace</strong><br />{run.workspace_mode} / {run.transport_mode}</div>
        </div>
        {run.scores_json ? (
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <strong>scores:</strong>{' '}
            {Object.entries(run.scores_json).map(([a, v]) => (
              <span key={a} style={{ marginRight: 12 }}>
                {a}: <strong>{Number(v).toFixed(1)}</strong>
              </span>
            ))}
          </div>
        ) : null}
        {run.cap_breaches?.length ? (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--bad, #c33)' }}>
            cap breaches: {run.cap_breaches.join(', ')}
          </div>
        ) : null}
        {run.judge_json?.judgeOverruledAssert ? (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--warn, #b80)' }}>
            ⚠ judge overruled a deterministic assertion — review findings
          </div>
        ) : null}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <section>
          <h3 style={{ marginTop: 0 }}>Transcript ({turns.length} turn{turns.length === 1 ? '' : 's'})</h3>
          {turns.length === 0 ? (
            <Empty msg="No turns captured." />
          ) : (
            turns.map((t) => {
              const isOpen = expandedTurn === t.idx;
              return (
                <div key={t.idx} className="pc-test-card" style={{ padding: 10, marginBottom: 8 }}>
                  <div
                    onClick={() => onToggleTurn(isOpen ? null : t.idx)}
                    style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', fontSize: 12 }}
                  >
                    <strong>turn {t.idx}</strong>
                    <span style={{ color: 'var(--fg-mute, #888)' }}>
                      {t.finishReason} · {t.latencyMs}ms
                      {t.toolCalls.length > 0 ? ` · ${t.toolCalls.length} tool${t.toolCalls.length === 1 ? '' : 's'}` : ''}
                      {t.controlTags.length > 0 ? ` · ${t.controlTags.map((c) => `<${c.tag}/>`).join(' ')}` : ''}
                      {t.error ? ' · error' : ''}
                    </span>
                  </div>
                  {isOpen ? (
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                      {t.userText !== undefined ? (
                        <>
                          <div style={{ fontSize: 12, color: 'var(--fg-mute, #888)', marginBottom: 4 }}>
                            <strong>sim user{t.simKind ? ` (${t.simKind})` : ''}</strong>
                          </div>
                          <pre style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px 0', background: 'var(--bg-soft, #f8f8f8)', padding: 8 }}>
                            {t.userText || <em>(empty)</em>}
                          </pre>
                          {t.simThought ? (
                            <details style={{ marginBottom: 8 }}>
                              <summary style={{ cursor: 'pointer', fontSize: 12 }}>sim-user thought</summary>
                              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, background: 'var(--bg-soft, #f8f8f8)', padding: 8 }}>
                                {t.simThought}
                              </pre>
                            </details>
                          ) : null}
                        </>
                      ) : null}
                      <pre style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px 0', background: 'var(--bg-soft, #f8f8f8)', padding: 8 }}>
                        {t.assistantText || <em>(empty)</em>}
                      </pre>
                      {t.toolCalls.length > 0 ? (
                        <details>
                          <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                            tool calls ({t.toolCalls.length})
                          </summary>
                          <pre style={{ fontSize: 11, background: 'var(--bg-soft, #f8f8f8)', padding: 8 }}>
                            {JSON.stringify(t.toolCalls, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                      {t.cards.length > 0 ? (
                        <details>
                          <summary style={{ cursor: 'pointer', fontSize: 12 }}>cards ({t.cards.length})</summary>
                          <pre style={{ fontSize: 11, background: 'var(--bg-soft, #f8f8f8)', padding: 8 }}>
                            {JSON.stringify(t.cards, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                      {t.error ? (
                        <div style={{ marginTop: 4, color: 'var(--bad, #c33)', fontSize: 12 }}>
                          error: <code>{t.error}</code>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          {tools.length > 0 ? (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                Telemetry — tool invocations ({tools.length})
              </summary>
              <table className="pc-test-table" style={{ marginTop: 8 }}>
                <thead><tr><th>tool</th><th>status</th></tr></thead>
                <tbody>
                  {tools.map((tl, i) => (
                    <tr key={i}><td><code>{tl.toolName}</code></td><td>{tl.status}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
        </section>

        <aside>
          <h3 style={{ marginTop: 0 }}>Findings</h3>
          {assertViolations.length > 0 ? (
            <>
              <h4 style={{ fontSize: 12, color: 'var(--fg-mute, #888)' }}>Asserts ({assertViolations.length})</h4>
              {assertViolations.map((f) => (
                <div key={f.id} className="pc-test-card" style={{ padding: 8, marginBottom: 6, fontSize: 12 }}>
                  <SeverityBadge severity={f.severity} />{' '}
                  {f.assert_kind ? <code>{f.assert_kind}</code> : null}
                  <div style={{ marginTop: 4 }}>{f.claim}</div>
                  {f.evidence_turn_idx != null ? (
                    <div style={{ fontSize: 11, marginTop: 2, color: 'var(--fg-mute, #888)' }}>
                      turn {f.evidence_turn_idx}
                    </div>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
          {judgeFindings.length > 0 ? (
            <>
              <h4 style={{ fontSize: 12, color: 'var(--fg-mute, #888)' }}>Judge ({judgeFindings.length})</h4>
              {judgeFindings.map((f) => (
                <div key={f.id} className="pc-test-card" style={{ padding: 8, marginBottom: 6, fontSize: 12 }}>
                  <SeverityBadge severity={f.severity} />{' '}
                  {f.axis ? <strong>{f.axis}</strong> : null}
                  <div style={{ marginTop: 4 }}>{f.claim}</div>
                  {f.suggestion ? (
                    <div style={{ marginTop: 4, color: 'var(--fg-mute, #888)' }}>→ {f.suggestion}</div>
                  ) : null}
                  {f.copy_prompt ? (
                    <Button variant="ghost" onClick={() => copy(f.copy_prompt!)} title="Copy as agent prompt">
                      copy prompt
                    </Button>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
          {varianceFindings.length > 0 ? (
            <>
              <h4 style={{ fontSize: 12, color: 'var(--fg-mute, #888)' }}>Variance ({varianceFindings.length})</h4>
              {varianceFindings.map((f) => (
                <div key={f.id} className="pc-test-card" style={{ padding: 8, marginBottom: 6, fontSize: 12 }}>
                  <SeverityBadge severity={f.severity} /> {f.claim}
                </div>
              ))}
            </>
          ) : null}
          {findings.length === 0 ? <Empty msg="No findings on this run." /> : null}
        </aside>
      </div>

      <section style={{ marginTop: 16, fontSize: 12, color: 'var(--fg-mute, #888)' }}>
        <strong>Re-run:</strong> use the host&apos;s llm-test CLI to replay &amp; re-evaluate run{' '}
        <code>{run.id}</code> (scenario <code>{run.scenario_id}</code>).
      </section>
    </>
  );
}

type FindingsResponse = { findings: FindingRow[]; shapeCounts: Record<string, number> };

type FindingFilterSeverity = '' | 'error' | 'warn' | 'info';
type FindingFilterSource = '' | 'assert' | 'judge' | 'variance';

function FindingsView({ findingsEndpoint }: { findingsEndpoint: string }) {
  const [severity, setSeverity] = useQueryState(
    'sev',
    parseAsStringEnum<FindingFilterSeverity>(['', 'error', 'warn', 'info']).withDefault(''),
  );
  const [source, setSource] = useQueryState(
    'src',
    parseAsStringEnum<FindingFilterSource>(['', 'assert', 'judge', 'variance']).withDefault(''),
  );
  const [showAck, setShowAck] = useQueryState(
    'ack',
    parseAsStringEnum<'open' | 'done'>(['open', 'done']).withDefault('open'),
  );
  const [data, setData] = useState<FindingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    const url = new URL(findingsEndpoint, window.location.origin);
    if (severity) url.searchParams.set('severity', severity);
    if (source) url.searchParams.set('source', source);
    url.searchParams.set('acknowledged', showAck === 'done' ? 'true' : 'false');
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setData(j as FindingsResponse))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [severity, source, showAck, reloadKey, findingsEndpoint]);

  const onToggleAck = async (id: string, acknowledged: boolean) => {
    try {
      await fetch(`${findingsEndpoint}/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledged }),
      });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <div className="pc-test-card-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <Button variant={showAck === 'open' ? 'primary' : 'ghost'} onClick={() => setShowAck('open')}>Open</Button>
        <Button variant={showAck === 'done' ? 'primary' : 'ghost'} onClick={() => setShowAck('done')}>Acknowledged</Button>
        <select className="pc-test-input" value={severity} onChange={(e) => setSeverity((e.target.value || null) as FindingFilterSeverity | null)}>
          <option value="">any severity</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
        </select>
        <select className="pc-test-input" value={source} onChange={(e) => setSource((e.target.value || null) as FindingFilterSource | null)}>
          <option value="">any source</option>
          <option value="assert">deterministic assert</option>
          <option value="judge">judge</option>
          <option value="variance">variance</option>
        </select>
      </div>

      {data.findings.length === 0 ? (
        <Empty msg={showAck === 'open' ? 'No outstanding findings. Drill into a run from the Runs tab to see assertions inline.' : 'No acknowledged findings yet.'} />
      ) : (
        <div className="pc-test-card">
          <table className="pc-test-table">
            <thead>
              <tr>
                <th>severity</th>
                <th>scenario · started</th>
                <th>source · axis</th>
                <th>claim</th>
                <th>promotion</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.findings.map((f) => {
                const shape = f.shape ?? '';
                const scenarioCount = shape ? data.shapeCounts[shape] ?? 0 : 0;
                return (
                  <tr key={f.id}>
                    <td><SeverityBadge severity={f.severity} /></td>
                    <td>
                      <code>{f.scenario_id ?? f.run_id}</code>
                      <br />
                      <span style={{ color: 'var(--fg-mute)', fontSize: 11 }}>
                        {f.started_at ? new Date(f.started_at).toLocaleString() : ''}
                      </span>
                    </td>
                    <td>
                      <span className="pc-test-badge is-muted">{f.source}</span>
                      {f.axis ? <> · {f.axis}</> : f.assert_kind ? <> · <code>{f.assert_kind}</code></> : null}
                    </td>
                    <td style={{ maxWidth: 480 }}>
                      <div>{f.claim}</div>
                      {f.suggestion ? (
                        <div style={{ color: 'var(--fg-mute)', fontSize: 12, marginTop: 4 }}>
                          → {f.suggestion}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {f.promoted_to_assert_id ? (
                        <span className="pc-test-badge is-good" title={f.promoted_to_assert_id}>promoted</span>
                      ) : scenarioCount >= 3 ? (
                        <span className="pc-test-badge is-needs" title={`shape seen in ${scenarioCount} scenarios`}>
                          candidate · {scenarioCount}×
                        </span>
                      ) : scenarioCount >= 2 ? (
                        <span className="pc-test-badge is-muted" title={`shape seen in ${scenarioCount} scenarios`}>
                          recurring · {scenarioCount}×
                        </span>
                      ) : null}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {f.copy_prompt ? (
                        <Button variant="ghost" onClick={() => copy(f.copy_prompt!)} title="Copy as agent prompt">
                          copy prompt
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        onClick={() => onToggleAck(f.id, showAck !== 'done')}
                      >
                        {showAck === 'done' ? 'reopen' : 'ack'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls = severity === 'error' ? 'is-bad' : severity === 'warn' ? 'is-needs' : 'is-muted';
  return <span className={`pc-test-badge ${cls}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'passed' ? 'is-good'
      : status === 'failed' ? 'is-bad'
        : status === 'errored' ? 'is-bad'
          : 'is-muted';
  return <span className={`pc-test-badge ${cls}`}>{status}</span>;
}

function formatScores(scores: Record<string, number> | null): ReactNode {
  if (!scores) return '—';
  const entries = Object.entries(scores);
  if (entries.length === 0) return '—';
  const avg = entries.reduce((s, [, v]) => s + v, 0) / entries.length;
  return <span title={JSON.stringify(scores)}>{avg.toFixed(1)} avg ({entries.length} axes)</span>;
}

function formatFindings(c: Record<string, number>): string {
  const parts: string[] = [];
  if (c.error) parts.push(`${c.error} err`);
  if (c.warn) parts.push(`${c.warn} warn`);
  if (c.info) parts.push(`${c.info} info`);
  return parts.length === 0 ? '—' : parts.join(' / ');
}

function Loading() {
  return <div className="pc-test-loading">loading…</div>;
}

function Empty({ msg }: { msg: string }) {
  return <div className="pc-test-card" style={{ padding: 16, color: 'var(--fg-mute)' }}>{msg}</div>;
}

function ErrorBox({ error }: { error: string }) {
  return <div className="pc-test-card is-bad" style={{ padding: 16 }}>Error: {error}</div>;
}
