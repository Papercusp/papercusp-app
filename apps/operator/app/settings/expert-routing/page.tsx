'use client';

/**
 * /settings/expert-routing — the consult expert-routing owner surface
 * (consult-expert-routing-2026-09-22 P-006).
 *
 * Two knobs, both owner authority:
 *
 *   1. WHO MAY ANSWER — the RANKED allowlist of models allowed to answer a
 *      consult (D-004). ORDER IS THE POLICY: rank 1 is tried first and each
 *      later rank is the fallback for a walled account or a failed launch, so
 *      this surface is a reorderable list, not a set of checkboxes.
 *      [owner 2026-09-22] "Lets create a setting exposed in the gui for selecting
 *      a list of models allowed to be experts and rank them"; seed "any
 *      opus/fable for claude and any sol/astra for chatgpt". Its purpose is to
 *      stop a weak model ANSWERING while keeping every agent's transcript usable
 *      as the knowledge SOURCE (D-003) — which is why this list never filters
 *      whose history the router searches.
 *
 *   2. RECENCY HALF-LIFE — the stage-2 comparison half-life (D-001 §2).
 *      ⚠ [owner 2026-09-22] "recently should only be considered when
 *      comparing... If we have like any expert floor that an agent has to pass,
 *      the recency shouldnt be considered for this." The copy below says so
 *      out loud: this value cannot strip an idle agent of expert status, because
 *      stage-1 qualification is recency-free.
 *
 * Reads `consult.expertRouting` via useSyncQuery (workspace-singleton, no args);
 * writes through the loopback /api/agent-mcp/consult-expert-routing-set route,
 * which MERGES the patch and fires the name-only
 * notifySyncInvalidate('consult.expertRouting').
 *
 * State policy: nuqs holds the add-model form's open state (user-meaningful view
 * state the agent → UI control surface reads off the URL); the edited list and
 * the half-life field are MID-EDIT DRAFTS and the save lifecycle is render-only,
 * so both are useState. A draft of `null` means "not edited" and renders straight
 * from the server value — so a successful save clears the draft rather than
 * hand-reconciling it against the refetch.
 *
 * The model picker DERIVES from CLOUD_MODEL_MENU (agent-config-constants), whose
 * parity suite pins it to psu's own menu. Per that module: "UI pickers must
 * derive from THIS, never re-declare" — a hand-kept list here is exactly the
 * drift that shipped a stale picker in 2026-07. A stored alias the menu does not
 * know (the seed's `gpt-6-astra` full ID) still renders and is never dropped, because the
 * launcher's accepted id set is open and the CLI owns it.
 */
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  CLOUD_MODEL_MENU,
  type CloudModelChoice,
} from '@papercusp/operator-core/lib/agent-config-constants';
import { Select, type SelectEntry } from '../../harness/Select';
import { Button } from '../../harness/Button';
import { TextInput } from '../../harness/TextInput';

/* ── Wire types — mirror operator-core/lib/consult/expert-routing-settings.ts +
 *    expert-model-allowlist.ts, kept local per the client wire-type decoupling
 *    convention. ── */
type ExpertBackend = 'claude' | 'codex' | 'omp';

interface AllowedExpertModel {
  rank: number;
  agent: ExpertBackend;
  model: string;
}

interface ExpertRoutingRow {
  allowlist: AllowedExpertModel[];
  recencyHalfLifeDays: number;
  bounds: {
    minRecencyHalfLifeDays: number;
    maxRecencyHalfLifeDays: number;
  };
  defaults: {
    allowlist: AllowedExpertModel[];
    recencyHalfLifeDays: number;
  };
}

interface SetArgs {
  allowlist?: Array<{ agent: ExpertBackend; model: string }>;
  recencyHalfLifeDays?: number;
}

/** REST path the sync-mutate hook calls (desktop SSE → the loopback route). */
async function expertRoutingSetRest(args: SetArgs): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/agent-mcp/consult-expert-routing-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: { ok?: boolean; error?: string } = {};
  try {
    data = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${r.status}`);
  return { ok: true };
}

/** The backend that actually launches a menu alias — never the user's guess. */
const BACKEND_LABEL: Record<ExpertBackend, string> = {
  claude: 'claude CLI',
  codex: 'codex CLI',
  omp: 'omp',
};

const CUSTOM = '__custom__';

const MENU_BY_VALUE = new Map<string, CloudModelChoice>(
  CLOUD_MODEL_MENU.map((choice) => [choice.value, choice]),
);

/** Label a stored entry. An alias the menu does not know keeps its raw spec. */
function modelLabel(entry: AllowedExpertModel): string {
  const known = MENU_BY_VALUE.get(entry.model);
  return known && known.backend === entry.agent ? known.label : entry.model;
}

function pairKey(agent: string, model: string): string {
  return `${agent}\u0000${model}`;
}

const sectionStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '16px 18px',
  marginBottom: 18,
  background: 'var(--bg)',
};
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 12px',
  marginBottom: 8,
  background: 'var(--bg-2)',
};
const rankStyle: CSSProperties = {
  flex: '0 0 auto',
  minWidth: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--fg-mute)',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
};
const chipStyle: CSSProperties = {
  flex: '0 0 auto',
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid var(--border)',
  color: 'var(--fg-mute)',
  fontSize: 11,
};
const hintStyle: CSSProperties = {
  color: 'var(--fg-mute)',
  fontSize: 12,
  lineHeight: 1.55,
  margin: '0 0 12px',
};

export default function ExpertRoutingSettingsPage() {
  const { data, loading, error } = useSyncQuery<ExpertRoutingRow>({
    queryName: 'consult.expertRouting',
  });
  const server = data?.[0] ?? null;

  const save = useSyncMutate<SetArgs, { ok: boolean; error?: string }>(
    'consult.expertRouting.set',
    expertRoutingSetRest,
  );

  // Panel open-state is user-meaningful view state → nuqs.
  const [addOpen, setAddOpen] = useQueryState('add', parseAsBoolean.withDefault(false));

  // Mid-edit drafts + save lifecycle → useState, per the state policy. `null`
  // means "untouched", so the row renders from the server value and a saved
  // write needs no reconciliation — just clear the draft.
  const [draftList, setDraftList] = useState<AllowedExpertModel[] | null>(null);
  const [draftHalfLife, setDraftHalfLife] = useState<string | null>(null);
  const [pick, setPick] = useState<string>(CLOUD_MODEL_MENU[0]?.value ?? CUSTOM);
  const [customModel, setCustomModel] = useState('');
  const [customBackend, setCustomBackend] = useState<ExpertBackend>('claude');
  const [busy, setBusy] = useState(false);

  const allowlist = draftList ?? server?.allowlist ?? [];
  const halfLifeText = draftHalfLife ?? (server ? String(server.recencyHalfLifeDays) : '');
  const dirty = draftList !== null || draftHalfLife !== null;

  const present = useMemo(
    () => new Set(allowlist.map((e) => pairKey(e.agent, e.model))),
    [allowlist],
  );

  /** Menu grouped by backend. An already-ranked pair is DISABLED rather than
   *  offered: the normalizer dedupes (agent, model), so adding a duplicate would
   *  silently vanish on save — the UI must not offer what the store will drop. */
  const modelOptions = useMemo<SelectEntry[]>(() => {
    const groups: SelectEntry[] = (['claude', 'codex'] as const).map((backend) => ({
      kind: 'group' as const,
      label: BACKEND_LABEL[backend],
      options: CLOUD_MODEL_MENU.filter((c) => c.backend === backend).map((c) => ({
        value: c.value,
        label: c.label,
        disabled: present.has(pairKey(c.backend, c.value)),
      })),
    }));
    return [...groups, { value: CUSTOM, label: 'Custom alias…' }];
  }, [present]);

  const move = useCallback(
    (index: number, delta: number) => {
      const next = [...allowlist];
      const to = index + delta;
      if (to < 0 || to >= next.length) return;
      [next[index], next[to]] = [next[to], next[index]];
      setDraftList(next.map((entry, i) => ({ ...entry, rank: i + 1 })));
    },
    [allowlist],
  );

  const remove = useCallback(
    (index: number) => {
      setDraftList(
        allowlist.filter((_, i) => i !== index).map((entry, i) => ({ ...entry, rank: i + 1 })),
      );
    },
    [allowlist],
  );

  const add = useCallback(() => {
    let agent: ExpertBackend;
    let model: string;
    if (pick === CUSTOM) {
      model = customModel.trim();
      agent = customBackend;
      if (!model) {
        toast.error('Enter a model alias (the spec passed to psu --model).');
        return;
      }
    } else {
      const choice = MENU_BY_VALUE.get(pick);
      if (!choice) return;
      // The alias decides which CLI launches it — take the backend from the
      // menu, never from a separate control the user could disagree with.
      model = choice.value;
      agent = choice.backend;
    }
    if (present.has(pairKey(agent, model))) {
      toast.error(`${model} is already ranked for ${BACKEND_LABEL[agent]}.`);
      return;
    }
    setDraftList([...allowlist, { rank: allowlist.length + 1, agent, model }]);
    setCustomModel('');
    void setAddOpen(false);
  }, [pick, customModel, customBackend, present, allowlist, setAddOpen]);

  const revert = useCallback(() => {
    setDraftList(null);
    setDraftHalfLife(null);
  }, []);

  const halfLifeValue = Number(halfLifeText);
  const bounds = server?.bounds;
  const halfLifeInvalid =
    !!server &&
    (!Number.isFinite(halfLifeValue) ||
      halfLifeValue < bounds!.minRecencyHalfLifeDays ||
      halfLifeValue > bounds!.maxRecencyHalfLifeDays);
  // An empty list is not a policy of "nobody may answer" — the store replaces it
  // with the seed. Blocking the save says that, instead of letting the owner
  // watch their edit come back as the default list.
  const listEmpty = allowlist.length === 0;
  const canSave = !!server && dirty && !busy && !halfLifeInvalid && !listEmpty;

  const onSave = useCallback(async () => {
    if (!server) return;
    setBusy(true);
    try {
      // Send BOTH fields whenever either changed: rank is positional on the
      // wire, and a whole-value write is what makes the persisted order exactly
      // what this list shows.
      await save({
        allowlist: allowlist.map((e) => ({ agent: e.agent, model: e.model })),
        recencyHalfLifeDays: halfLifeValue,
      });
      revert(); // clears drafts → renders the refetched, normalized server value
      toast.success('Expert routing saved.');
    } catch (err) {
      toast.error(`Save failed: ${(err as Error)?.message ?? 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }, [server, save, allowlist, halfLifeValue, revert]);

  const restoreDefaults = useCallback(() => {
    if (!server) return;
    setDraftList(server.defaults.allowlist.map((e, i) => ({ ...e, rank: i + 1 })));
    setDraftHalfLife(String(server.defaults.recencyHalfLifeDays));
  }, [server]);

  if (loading && !server) {
    return <div style={{ padding: 24, color: 'var(--fg-mute)' }}>Loading expert routing…</div>;
  }
  if (error && !server) {
    return (
      <div style={{ padding: 24, color: 'var(--bad)' }}>
        Could not read expert-routing settings: {String(error)}
      </div>
    );
  }
  if (!server) return null;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 820 }}>
      <h1 style={{ fontSize: 20, margin: '0 0 6px' }}>Expert routing</h1>
      <p style={hintStyle}>
        Governs <code>consult:get_feedback</code> — which peer an agent is routed to when it asks
        the fleet a question it would otherwise burn hours re-deriving.
      </p>

      <section style={sectionStyle} aria-labelledby="expert-models-heading">
        <h2 id="expert-models-heading" style={{ fontSize: 15, margin: '0 0 4px' }}>
          Models allowed to answer
        </h2>
        <p style={hintStyle}>
          Tried in order: rank 1 first, and each rank below it is the fallback when an account is
          rate-limited or a launch fails. This picks who <strong>answers</strong> — every agent&rsquo;s
          transcript stays searchable as the knowledge <strong>source</strong>, so a weaker model&rsquo;s
          experience is still usable without letting it write the reply.
        </p>

        {listEmpty ? (
          <div
            style={{ ...rowStyle, borderStyle: 'dashed', color: 'var(--warn)', display: 'block' }}
          >
            No models ranked. At least one is required — saving an empty list would fall back to
            the default policy rather than blocking every consult.
          </div>
        ) : (
          <ul
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
            data-testid="expert-routing-list"
          >
            {allowlist.map((entry, index) => (
              <li
                key={pairKey(entry.agent, entry.model)}
                style={rowStyle}
                data-testid="expert-model-row"
                data-model={entry.model}
                data-agent={entry.agent}
                data-rank={index + 1}
              >
                <span style={rankStyle} aria-label={`Rank ${index + 1}`}>
                  {index + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13 }}>{modelLabel(entry)}</span>
                  <span
                    style={{ marginLeft: 8, color: 'var(--fg-mute)', fontSize: 11 }}
                  >
                    <code>{entry.model}</code>
                  </span>
                </span>
                <span style={chipStyle}>{BACKEND_LABEL[entry.agent]}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${entry.model} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${entry.model} down`}
                  disabled={index === allowlist.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${entry.model}`}
                  onClick={() => remove(index)}
                >
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {addOpen ? (
          <div style={{ ...rowStyle, flexWrap: 'wrap', background: 'var(--bg)' }}>
            <Select
              value={pick}
              onChange={setPick}
              options={modelOptions}
              ariaLabel="Model to allow"
            />
            {pick === CUSTOM && (
              <>
                <TextInput
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
              placeholder="alias or full model ID, e.g. gpt-6-astra"
                  aria-label="Custom model alias"
                  style={{ width: 180 }}
                />
                <Select
                  value={customBackend}
                  onChange={(v) => setCustomBackend(v as ExpertBackend)}
                  options={(['claude', 'codex', 'omp'] as const).map((b) => ({
                    value: b,
                    label: BACKEND_LABEL[b],
                  }))}
                  ariaLabel="Backend for the custom alias"
                />
              </>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={add}
              data-testid="expert-routing-add-confirm"
            >
              Add
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void setAddOpen(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void setAddOpen(true)}
            data-testid="expert-routing-add-toggle"
          >
            <Plus size={14} /> Add a model
          </Button>
        )}
      </section>

      <section style={sectionStyle} aria-labelledby="recency-heading">
        <h2 id="recency-heading" style={{ fontSize: 15, margin: '0 0 4px' }}>
          Recency half-life
        </h2>
        <p style={hintStyle}>
          How fast experience ages when <em>comparing</em> candidates: after one half-life, work of
          equal depth counts for half as much as today&rsquo;s. Used only to rank peers who already
          qualify — <strong>it never decides whether someone qualifies</strong>, so going on holiday
          cannot cost an agent its expert status.
        </p>
        <label
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 13 }}
        >
          <span>Half-life</span>
          <TextInput
            type="number"
            inputMode="decimal"
            step="0.5"
            min={bounds!.minRecencyHalfLifeDays}
            max={bounds!.maxRecencyHalfLifeDays}
            value={halfLifeText}
            onChange={(e) => setDraftHalfLife(e.target.value)}
            aria-label="Recency half-life in days"
            aria-invalid={halfLifeInvalid || undefined}
            data-testid="expert-routing-half-life"
            trailing={<span style={{ color: 'var(--fg-mute)', fontSize: 11 }}>days</span>}
            style={{ width: 150 }}
          />
        </label>
        {halfLifeInvalid && (
          <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 8 }}>
            Enter a number between {bounds!.minRecencyHalfLifeDays} and{' '}
            {bounds!.maxRecencyHalfLifeDays} days.
          </div>
        )}
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button
          variant="primary"
          onClick={() => void onSave()}
          disabled={!canSave}
          data-testid="expert-routing-save"
        >
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
        <Button
          variant="ghost"
          onClick={revert}
          disabled={!dirty || busy}
          data-testid="expert-routing-revert"
        >
          Revert
        </Button>
        <Button
          variant="ghost"
          onClick={restoreDefaults}
          disabled={busy}
          data-testid="expert-routing-restore-defaults"
        >
          Restore defaults
        </Button>
        {dirty && !busy && (
          <span style={{ color: 'var(--warn)', fontSize: 12 }}>Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
