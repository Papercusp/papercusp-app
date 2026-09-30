'use client';

/**
 * use-su-launch-options — the GUI launcher's option source, which is psu's OWN
 * option source (WI-6321).
 *
 * Owner ask 2026-07-27, and the load-bearing half of the item: "the options in
 * the gui should match the exact same options that the psu utiltiy uses because
 * it should share the same code for getting the options". Not "make the lists
 * look the same" — SHARE the source, so they cannot drift.
 *
 * `GET /api/agent-mcp/console/bootstrap-su/options` is exactly that source:
 * psu-launcher's `fetchFleetChoices` and `fetchAccountChoices` both read it, and
 * its own docblock already describes it as picker data "for the `psu` launcher
 * (and the /adv 'Launch SU' modal)". It was built to be shared; the GUI simply
 * never used the fleet/account halves, which is why a GUI launch could not
 * express either. Reading the same endpoint means a fleet created in a terminal
 * shows up in the GUI picker with the same colour, with no second query to keep
 * in step.
 *
 * The VOCABULARY options that are static rather than live (models, efforts,
 * context sizes, account modes) come from `agent-config-constants`, the
 * client-safe module whose values are pinned to psu-launcher's own menus by the
 * parity suite in apps/operator/lib/psu-launcher.test.ts.
 *
 * Fail-soft by design, matching psu: any error yields empty lists so the picker
 * still renders its "no fleet" / "default account" rows and a launch remains
 * possible. A launcher that refuses to open because a list did not load is worse
 * than one offering the defaults.
 */
import { useCallback, useEffect, useState } from 'react';

/** One curated colour scheme, as the options endpoint serves it. */
export interface FleetColorScheme {
  name: string;
  bg: string;
  fg: string;
  cursor: string;
}

/** A durable named fleet the workspace offers (agent_fleets row). Persists even
 *  with zero live members (named-su-agent-fleets D-003). */
export interface FleetChoice {
  slug: string;
  title: string | null;
  scheme: string | null;
  color: FleetColorScheme;
}

/** A pool account the gateway offers. Empty unless the gateway is on — the
 *  endpoint hides the pool otherwise (resolveAccountChoices). */
export interface AccountChoice {
  id: string;
  label?: string | null;
  detail?: string | null;
  availability?: 'available' | 'unavailable' | 'unknown';
}

export interface OmpLaunchModelCost {
  /** OMP may use a negative finite sentinel when a router's price is dynamic. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Exact launch metadata from the host-local `omp models --json` registry. */
export interface OmpLaunchModel {
  provider: string;
  id: string;
  selector: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  thinking: string[] | null;
  input: Array<'text' | 'image'>;
  cost: OmpLaunchModelCost;
}

export type OmpLaunchCatalog =
  | {
      status: 'available';
      availability: 'enabled-configured';
      credentials: 'unchecked';
      upstream: 'unchecked';
      models: OmpLaunchModel[];
      error: null;
    }
  | {
      status: 'unavailable';
      availability: 'unknown';
      credentials: 'unchecked';
      upstream: 'unchecked';
      models: [];
      error: string | null;
    };

export interface SuLaunchOptions {
  fleets: FleetChoice[];
  /** The colour a NEW fleet would be allocated — lets the create row preview the
   *  colour it will actually get (the server re-derives the same one). */
  nextScheme: FleetColorScheme | null;
  /** The full curated catalog, for the new-fleet colour picker. */
  schemes: FleetColorScheme[];
  accounts: AccountChoice[];
  ompCatalog: OmpLaunchCatalog;
  loading: boolean;
  error: string | null;
  /** Re-read after a launch creates a fleet, so the new one appears without a reload. */
  refresh: () => void;
}

export interface IdentityLaunchChoice {
  id: string;
  tier: string;
  version?: string | null;
  sourceRevision: string;
  launchCompatibility?: { eligible: boolean; reason: string | null };
  slots: Array<{ slot: string; cardinality: 'exclusive' | 'additive' | null }>;
}

export interface IdentityLaunchCatalog {
  identities: IdentityLaunchChoice[];
  unreadable: Array<{ id: string; error: string }>;
  nextAfter: string | null;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
}

/** The GUI and psu consume the same paged bootstrap options endpoint. A failed
 * read keeps the SU default available and never invents an installed choice. */
export function useIdentityLaunchCatalog(workspaceId?: string | null): IdentityLaunchCatalog {
  const [catalog, setCatalog] = useState<Pick<IdentityLaunchCatalog,
    'identities' | 'unreadable' | 'nextAfter'>>({ identities: [], unreadable: [], nextAfter: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const readPage = useCallback(async (after: string | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ identities: '1', limit: '30' });
      if (workspaceId) params.set('workspace', workspaceId);
      if (after) params.set('after', after);
      const response = await fetch(`/api/agent-mcp/console/bootstrap-su/options?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = await response.json() as Partial<IdentityLaunchCatalog> & { status?: string };
      if (page.status !== 'ok' || !Array.isArray(page.identities) || !Array.isArray(page.unreadable)) {
        throw new Error('Invalid identity catalog response');
      }
      if (after && page.nextAfter === after) throw new Error('Identity catalog cursor did not advance');
      setCatalog((previous) => ({
        identities: after ? [...previous.identities, ...page.identities!] : page.identities!,
        unreadable: after ? [...previous.unreadable, ...page.unreadable!] : page.unreadable!,
        nextAfter: typeof page.nextAfter === 'string' ? page.nextAfter : null,
      }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    setCatalog({ identities: [], unreadable: [], nextAfter: null });
    void readPage(null);
  }, [readPage]);
  const loadMore = useCallback(() => {
    if (!loading && catalog.nextAfter) void readPage(catalog.nextAfter);
  }, [loading, catalog.nextAfter, readPage]);
  return { ...catalog, loading, error, loadMore };
}

const EMPTY_OMP_CATALOG: Extract<OmpLaunchCatalog, { status: 'unavailable' }> = {
  status: 'unavailable',
  availability: 'unknown',
  credentials: 'unchecked',
  upstream: 'unchecked',
  models: [],
  error: null,
};

const EMPTY: Omit<SuLaunchOptions, 'loading' | 'error' | 'refresh'> = {
  fleets: [],
  nextScheme: null,
  schemes: [],
  accounts: [],
  ompCatalog: EMPTY_OMP_CATALOG,
};

/**
 * Normalize the endpoint's `accounts` payload into a flat choice list. The shape
 * has varied across the account-routing work (a bare array, or `{ pool: [...] }`
 * as psu's `promptAccount` receives it), so both are accepted rather than
 * assuming one — an unexpected shape degrades to "no pool accounts", never a
 * crash that takes the whole launcher down.
 */
export function normalizeAccountChoices(raw: unknown): AccountChoice[] {
  const states = raw && typeof raw === 'object' && !Array.isArray(raw) &&
    (raw as { accountStates?: unknown }).accountStates &&
    typeof (raw as { accountStates?: unknown }).accountStates === 'object'
    ? (raw as { accountStates: Record<string, unknown> }).accountStates
    : {};
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { pool?: unknown })?.pool)
      ? (raw as { pool: unknown[] }).pool
      : [];
  return list
    .map((a): AccountChoice | null => {
      if (typeof a === 'string') {
        const state = states[a];
        return {
          id: a,
          ...(state === 'available' || state === 'unavailable' || state === 'unknown'
            ? { availability: state } : {}),
        };
      }
      if (a && typeof a === 'object') {
        const o = a as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : typeof o.value === 'string' ? o.value : null;
        if (!id) return null;
        return {
          id,
          label: typeof o.label === 'string' ? o.label : typeof o.name === 'string' ? o.name : null,
          detail: typeof o.detail === 'string' ? o.detail : null,
          ...(states[id] === 'available' || states[id] === 'unavailable' || states[id] === 'unknown'
            ? { availability: states[id] as AccountChoice['availability'] } : {}),
        };
      }
      return null;
    })
    .filter((a): a is AccountChoice => a !== null);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeOmpModel(raw: unknown): OmpLaunchModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const selector = typeof row.selector === 'string' ? row.selector.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const nullableNumber = (value: unknown): value is number | null => value === null || finiteNonNegative(value);
  const thinking: string[] | null | undefined = row.thinking === null
    ? null
    : Array.isArray(row.thinking) && row.thinking.every((v) => typeof v === 'string' && v.length > 0)
      ? row.thinking as string[]
      : undefined;
  const input: Array<'text' | 'image'> | undefined = Array.isArray(row.input) &&
    row.input.every((v) => v === 'text' || v === 'image')
    ? row.input as Array<'text' | 'image'>
    : undefined;
  const cost = row.cost && typeof row.cost === 'object' ? row.cost as Record<string, unknown> : null;
  if (
    !provider || !id || !name || selector !== `${provider}/${id}` ||
    !nullableNumber(row.contextWindow) || !nullableNumber(row.maxTokens) ||
    typeof row.reasoning !== 'boolean' || thinking === undefined || input === undefined || !cost ||
    !finiteNumber(cost.input) || !finiteNumber(cost.output) ||
    !finiteNumber(cost.cacheRead) || !finiteNumber(cost.cacheWrite)
  ) return null;
  return {
    provider,
    id,
    selector,
    name,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    reasoning: row.reasoning,
    thinking: thinking === null ? null : [...thinking],
    input: [...input],
    cost: {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
    },
  };
}

/** Normalize the browser boundary without silently changing selector identity. */
export function normalizeOmpCatalog(raw: unknown): OmpLaunchCatalog {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (value?.status === 'unavailable') {
    return {
      ...EMPTY_OMP_CATALOG,
      error: typeof value.error === 'string' ? value.error : null,
    };
  }
  if (value?.status !== 'available' || !Array.isArray(value.models)) {
    return { ...EMPTY_OMP_CATALOG, error: 'Invalid OMP catalog response' };
  }
  const models = value.models.map(normalizeOmpModel);
  if (models.some((model) => model === null)) {
    return { ...EMPTY_OMP_CATALOG, error: 'Invalid OMP model metadata' };
  }
  return {
    status: 'available',
    availability: 'enabled-configured',
    credentials: 'unchecked',
    upstream: 'unchecked',
    models: models as OmpLaunchModel[],
    error: null,
  };
}

export function useSuLaunchOptions(workspaceId?: string | null, agent = 'claude'): SuLaunchOptions {
  const [state, setState] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace', workspaceId);
    // The pool is per-backend (pinning is claude/codex only), so the endpoint
    // wants to know which agent is being launched — same param psu sends.
    if (agent) params.set('agent', agent);
    const qs = params.toString();
    setLoading(true);
    fetch(`/api/agent-mcp/console/bootstrap-su/options${qs ? `?${qs}` : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Record<string, unknown>) => {
        if (cancelled) return;
        setState({
          fleets: Array.isArray(data.fleets) ? (data.fleets as FleetChoice[]) : [],
          nextScheme: (data.nextScheme as FleetColorScheme | null) ?? null,
          schemes: Array.isArray(data.schemes) ? (data.schemes as FleetColorScheme[]) : [],
          accounts: normalizeAccountChoices(data.accounts),
          ompCatalog: normalizeOmpCatalog(data.ompCatalog),
        });
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Fail-soft (see the header): keep the defaults usable.
        setState(EMPTY);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agent, tick]);

  return { ...state, loading, error, refresh };
}
