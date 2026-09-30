/**
 * /res — Resources: workspace-scoped resource → fleet allocation.
 *
 * Hand your account pools, local GPUs, and AGENT SEATS to the fleets in this
 * workspace. A FLEET is the terminal drop-target. The rail is split into two
 * titled groups (agent-allocation-framework D-001):
 *
 *   · Autonomous-loop capacity — accounts (% share) + local GPUs. This is the
 *     SUPPLY pool that fuels the queen↔bee loop and the seats' AUTO account.
 *   · Agent seats — counted agent_slot templates (model·effort·account,
 *     D-002/D-003): launchable su-agents, capped by COUNT not share.
 *
 * Gated by FLAGS.RES_ALLOCATION (default ON). Fully tokenized to the frost
 * semantic scale (design/tokens).
 *
 * WIRED (P-201, P-003): reads via @papercusp/sync — fleets (fleets.byWorkspace),
 * account pools (accounts.pool), persisted allotments (p2p.allotments — ALL
 * kinds incl. agent_slot), and the workspace tier menu
 * (agentConfig.modelTiersBaseline) that seeds the seat templates. Writes go
 * through the loopback /api/agent-mcp/p2p-allotment-set route (P-002 routes it
 * through the resource:delegate tool), which fires
 * notifySyncInvalidate('p2p.allotments') so the board is live over desktop SSE.
 *
 * agent_slot write contract (P-001 store, pinned 2026-07-03): the trio lives in
 * `axis` {model, effort, account}; `quantity` is top-level (1..1000); the row
 * ref is DERIVED server-side (`agentSlotRef`) so ref↔axis can't disagree;
 * sharePct is ignored for slots. Pre-mig-486 rows degrade to hidden chips
 * (toSlotRow) rather than crashing the board.
 *
 * Fleets are FLAT (agent_fleets has no hive nesting), so the tree currently
 * renders one level under a workspace root; cross-hive nesting fills in as
 * federation (P-301) lands. The spend bar is hidden until fleet capacity (P-206)
 * is wired.
 *
 * POT-WIDE SEAT OFFERS (pot-seat-pools-prose-ux-2026-07-18 P-002): a seat
 * delegation may also target the whole pot instead of one fleet
 * (resource:delegate { potSlug, audience }, P-001) — a standing offer any
 * fleet in the pot can draw from once the honor/spend paths (P-003/P-004)
 * land, audience-gated ('trusted-members' | 'whole-pot'). These rows carry
 * `fleetSlug: null` + a non-null `potSlug`/`audience`, so they are filtered
 * OUT of the per-fleet tree above and rendered as their own "Whole pot" card
 * (below the fleet tree) with an audience toggle per seat row, revocable the
 * same way. `potSlug` must be one of this workspace's real shared hives
 * (offer-store-publish.ts's disambiguator check) — resolved read-only via the
 * `hive.workspaceScope` sync query; the card hides behind an explanatory note
 * when this workspace has no single shared hive.
 */
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { toast } from 'sonner';
import { useLexicon } from '@/lib/useLexicon';
import type { ModelTier } from '@papercusp/operator-core/lib/agent-config-constants';
import { Select } from '../harness/Select';
import {
  AGENT_SLOT_MAX_QUANTITY,
  AUTO_ACCOUNT,
  agentSlotRef,
  parseTierSpecToSlot,
  planSlotWrite,
  slotChipLabel,
  toSlotRow,
  type SlotAxis,
  type SlotRow,
} from './seat-slots';
import './res.css';

/** Share-capped kinds (the Autonomous-loop capacity group). */
type ResType = 'account' | 'gpu';
/** Everything resource_allotments stores (mig 486 adds agent_slot). */
type WireKind = ResType | 'agent_slot';
/** P-001/D-002: audience gate for a pot-scoped (potSlug) allotment. */
type AllotmentAudience = 'trusted-members' | 'whole-pot';

/* ── Wire types — mirror the server row shapes, kept local per the client
 *    wire-type decoupling convention. ── */
interface FleetRow {
  workspaceId: string;
  fleetSlug: string;
  title: string | null;
  owner: string | null;
}
interface AccountRow {
  id: string;
  label: string | null;
  available?: boolean;
  boundTo?: string | null;
}
interface AllotmentRow {
  /** null for a pot-scoped row (P-001) — exactly one of fleetSlug/potSlug is set. */
  fleetSlug: string | null;
  /** P-001: the pot-scoped grantee — mutually exclusive with fleetSlug. */
  potSlug?: string | null;
  /** P-001/D-002: required iff potSlug is set; null for a fleet-scoped row. */
  audience?: AllotmentAudience | null;
  resourceKind: WireKind;
  resourceRef: string;
  sharePct: number;
  /** agent_slot rows only (mig 486); null for account/gpu. */
  quantity?: number | null;
  /** agent_slot rows carry the {model, effort, account} trio (D-002). */
  axis?: Record<string, unknown> | null;
  status: 'active' | 'paused';
}

interface AllotmentSetArgs {
  action: 'set' | 'remove';
  /** Exactly one of fleetSlug/potSlug (P-001). */
  fleetSlug?: string;
  /** Pot-scoped grantee (P-001) — the workspace's shared-hive slug. */
  potSlug?: string;
  /** Required iff potSlug is set (D-002). */
  audience?: AllotmentAudience;
  resourceKind: WireKind;
  /** Optional for agent_slot 'set' — the store DERIVES it from axis. */
  resourceRef?: string;
  sharePct?: number;
  quantity?: number;
  axis?: SlotAxis;
}

/** REST fallback for allotment writes (desktop SSE → the loopback route). */
async function p2pAllotmentSetRest(args: AllotmentSetArgs): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/agent-mcp/p2p-allotment-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: { ok?: boolean; error?: string; detail?: string } = {};
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) throw new Error(data.detail ?? data.error ?? `HTTP ${r.status}`);
  return { ok: true };
}

interface FleetNode {
  kind: 'fleet';
  id: string;
  name: string;
  who: string;
}
interface HiveNode {
  kind: 'hive';
  id: string;
  name: string;
  who: string;
  children: ResNode[];
}
type ResNode = HiveNode | FleetNode;

/** A draggable rail card: an account pool, a GPU, or a seat TEMPLATE. */
interface ResourceCard {
  id: string;
  type: 'account' | 'gpu' | 'seat';
  label: string;
  meta: string;
  /** Seat templates carry the (model, effort) the drop instantiates (account starts AUTO). */
  seat?: Pick<SlotAxis, 'model' | 'effort'>;
}

interface Assignment {
  resId: string;
  type: ResType;
  label: string;
  pct: number;
}

function countFleets(n: ResNode): number {
  return n.kind === 'fleet' ? 1 : n.children.reduce((s, c) => s + countFleets(c), 0);
}

const pctKey = (fleetId: string, resId: string) => `${fleetId} ${resId}`;

export default function ResourcesPage() {
  const t = useLexicon();
  // ── Real data via @papercusp/sync (server-side activeWorkspaceId scoping). ──
  const { data: fleetsData, error: fleetsError } = useSyncQuery<FleetRow>({ queryName: 'fleets.byWorkspace' });
  const { data: accountsData } = useSyncQuery<AccountRow>({ queryName: 'accounts.pool' });
  const { data: allotmentsData } = useSyncQuery<AllotmentRow>({ queryName: 'p2p.allotments' });
  const { data: tiersData } = useSyncQuery<ModelTier>({ queryName: 'agentConfig.modelTiersBaseline' });
  // P-002: whether this workspace ("pot") has exactly one shared Hive to
  // publish a pot-scoped seat offer into — potSlug must be a real shared hive
  // (offer-store-publish.ts). Fail-soft: any other shape just hides the card.
  const { data: hiveScopeData } = useSyncQuery<{ kind: 'one' | 'many' | 'none'; homeSlug: string | null }>({
    queryName: 'hive.workspaceScope',
  });
  const potHomeSlug = hiveScopeData?.[0]?.kind === 'one' ? (hiveScopeData[0].homeSlug ?? null) : null;

  const workspace = fleetsData?.[0]?.workspaceId ?? 'this workspace';

  const accounts = useMemo<ResourceCard[]>(
    () =>
      (accountsData ?? []).map((a) => ({
        id: a.id,
        type: 'account' as const,
        label: a.label ?? a.id,
        meta: [a.available === false ? 'rate-limited' : 'available', a.boundTo ? `bound ${a.boundTo}` : null]
          .filter(Boolean)
          .join(' · '),
      })),
    [accountsData],
  );
  // GPU axis stubbed until local inference (P-207) + the owner's model decision.
  const gpus = useMemo<ResourceCard[]>(() => [], []);

  // Seat templates: one per workspace tier-menu entry whose spec is
  // representable as a slot axis (parseTierSpecToSlot filters e.g. colon-bearing
  // provider ids). Dropping one instantiates 1 × model·effort on AUTO (D-003).
  const seats = useMemo<ResourceCard[]>(() => {
    const out: ResourceCard[] = [];
    for (const t of tiersData ?? []) {
      const slot = parseTierSpecToSlot(t.spec);
      if (!slot) continue;
      out.push({
        id: `seat:${slot.model}:${slot.effort}`,
        type: 'seat',
        label: t.name,
        meta: `${slot.model}·${slot.effort}`,
        seat: slot,
      });
    }
    return out;
  }, [tiersData]);

  const allCards = useMemo(() => [...accounts, ...gpus, ...seats], [accounts, gpus, seats]);

  // Fleets are flat → a single workspace root with the fleets as leaves.
  const tree = useMemo<HiveNode>(
    () => ({
      kind: 'hive',
      id: 'ws-root',
      name: workspace,
      who: 'this workspace',
      children: (fleetsData ?? []).map<FleetNode>((f) => ({
        kind: 'fleet',
        id: f.fleetSlug,
        name: f.title ?? f.fleetSlug,
        who: f.owner ?? '—',
      })),
    }),
    [fleetsData, workspace],
  );

  // Assignments are DERIVED from persisted allotments (source of truth); the
  // account label is looked up from the accounts read (allotments store only the
  // resource ref). Paused rows are shown too (styled by status is a later pass).
  const accountLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of accounts) m.set(c.id, c.label);
    return m;
  }, [accounts]);
  const assignments = useMemo<Record<string, Assignment[]>>(() => {
    const out: Record<string, Assignment[]> = {};
    for (const a of allotmentsData ?? []) {
      if (!a.fleetSlug) continue; // pot-scoped row (P-001) — rendered separately below
      if (a.resourceKind !== 'account' && a.resourceKind !== 'gpu') continue;
      (out[a.fleetSlug] ??= []).push({
        resId: a.resourceRef,
        type: a.resourceKind,
        label: accountLabel.get(a.resourceRef) ?? a.resourceRef,
        pct: a.sharePct,
      });
    }
    return out;
  }, [allotmentsData, accountLabel]);

  // Seat rows per fleet (agent_slot allotments). Degraded pre-mig-486 rows are
  // dropped by toSlotRow rather than crashing the board. Pot-scoped rows
  // (fleetSlug null) are excluded here — see potSlotRows below.
  const slotRows = useMemo<Record<string, SlotRow[]>>(() => {
    const out: Record<string, SlotRow[]> = {};
    for (const a of allotmentsData ?? []) {
      if (!a.fleetSlug) continue;
      const row = toSlotRow(a);
      if (row) (out[a.fleetSlug] ??= []).push(row);
    }
    return out;
  }, [allotmentsData]);

  // P-002: pot-wide seat offers (potSlug set) — one flat list (a workspace has
  // at most one shared-hive "pot" today), each row's audience tracked
  // separately since the store carries it per-row, not per-pot.
  const potSlotRows = useMemo<SlotRow[]>(() => {
    const out: SlotRow[] = [];
    for (const a of allotmentsData ?? []) {
      if (!a.potSlug) continue;
      const row = toSlotRow(a);
      if (row) out.push(row);
    }
    return out;
  }, [allotmentsData]);
  const potAudienceByRef = useMemo(() => {
    const m = new Map<string, AllotmentAudience>();
    for (const a of allotmentsData ?? []) {
      if (a.potSlug && a.resourceKind === 'agent_slot' && (a.audience === 'trusted-members' || a.audience === 'whole-pot')) {
        m.set(a.resourceRef, a.audience);
      }
    }
    return m;
  }, [allotmentsData]);

  // Tree expansion is user-meaningful view state → URL (nuqs); collapsed hive ids.
  const [collapsedParam, setCollapsedParam] = useQueryState('collapsed', parseAsString.withDefault(''));
  const collapsed = useMemo(() => new Set(collapsedParam.split(',').filter(Boolean)), [collapsedParam]);
  const toggleHive = useCallback(
    (id: string) => {
      const next = new Set(collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      void setCollapsedParam([...next].join(',') || null);
    },
    [collapsed, setCollapsedParam],
  );

  const setAllotment = useSyncMutate<AllotmentSetArgs, { ok: boolean; error?: string }>(
    'p2p.allotmentSet',
    p2pAllotmentSetRest,
  );

  // Mid-drag slider values → local overlay (state policy: mid-edit draft). A ref
  // holds the latest so the pointer-up commit never reads a stale closure.
  const [pctDraft, setPctDraft] = useState<Record<string, number>>({});
  const pctDraftRef = useRef<Record<string, number>>({});
  const dragRef = useRef<ResourceCard | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [overFleet, setOverFleet] = useState<string | null>(null);
  const [overPot, setOverPot] = useState(false);
  const [busy, setBusy] = useState(false);

  const assign = useCallback(
    async (fleetId: string, cardRes: ResourceCard) => {
      setBusy(true);
      try {
        if (cardRes.type === 'seat') {
          // Drop = +1 seat of this template on the fleet (merges into an
          // existing AUTO row for the same model·effort — one row per ref).
          const target: SlotAxis = { ...cardRes.seat!, account: AUTO_ACCOUNT };
          const plan = planSlotWrite(slotRows[fleetId] ?? [], target, 1);
          await setAllotment({
            action: 'set',
            fleetSlug: fleetId,
            resourceKind: 'agent_slot',
            resourceRef: agentSlotRef(plan.set.axis), // informative only — the store derives
            quantity: plan.set.quantity,
            axis: plan.set.axis,
          });
          toast.success(`${plan.set.quantity} × ${cardRes.meta} seat${plan.set.quantity !== 1 ? 's' : ''} → ${fleetId}`);
          return;
        }
        if ((assignments[fleetId] ?? []).some((a) => a.resId === cardRes.id)) return; // already assigned
        await setAllotment({
          action: 'set',
          fleetSlug: fleetId,
          resourceKind: cardRes.type,
          resourceRef: cardRes.id,
          sharePct: 100,
        });
        toast.success(`Allocated ${cardRes.label} → ${fleetId}`);
      } catch (e) {
        toast.error(`Couldn't allocate: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [assignments, slotRows, setAllotment],
  );
  const unassign = useCallback(
    async (fleetId: string, resId: string, kind: WireKind) => {
      setBusy(true);
      try {
        await setAllotment({ action: 'remove', fleetSlug: fleetId, resourceKind: kind, resourceRef: resId });
      } catch (e) {
        toast.error(`Couldn't remove: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [setAllotment],
  );

  /** Seat count stepper: same axis ⇒ same derived ref ⇒ PK upsert of the count. */
  const stepSlot = useCallback(
    async (fleetId: string, row: SlotRow, delta: number) => {
      const plan = planSlotWrite(slotRows[fleetId] ?? [], row.axis, row.quantity + delta, row.ref);
      if (plan.set.quantity === row.quantity) return;
      setBusy(true);
      try {
        await setAllotment({
          action: 'set',
          fleetSlug: fleetId,
          resourceKind: 'agent_slot',
          resourceRef: row.ref,
          quantity: plan.set.quantity,
          axis: plan.set.axis,
        });
      } catch (e) {
        toast.error(`Couldn't change seats: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [slotRows, setAllotment],
  );

  /** Retarget a seat row's gateway account (D-003). The derived ref changes, so
      this is set-new-then-remove-old; landing on an occupied ref MERGES counts. */
  const retargetSlotAccount = useCallback(
    async (fleetId: string, row: SlotRow, account: string) => {
      if (account === row.axis.account) return;
      const plan = planSlotWrite(slotRows[fleetId] ?? [], { ...row.axis, account }, row.quantity, row.ref);
      setBusy(true);
      try {
        await setAllotment({
          action: 'set',
          fleetSlug: fleetId,
          resourceKind: 'agent_slot',
          resourceRef: agentSlotRef(plan.set.axis),
          quantity: plan.set.quantity,
          axis: plan.set.axis,
        });
        if (plan.removeRef) {
          await setAllotment({
            action: 'remove',
            fleetSlug: fleetId,
            resourceKind: 'agent_slot',
            resourceRef: plan.removeRef,
          });
        }
      } catch (e) {
        toast.error(`Couldn't move seats: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [slotRows, setAllotment],
  );

  // ── P-002: pot-wide seat offers — the same seat operations as a fleet's
  //    row, but keyed by potSlug instead of fleetSlug and carrying the
  //    required audience. New offers default to the narrower 'trusted-members'
  //    (D-002 has no silent default at the tool boundary; the UI still needs
  //    ONE to seed the drop — the audience Select on the chip corrects it
  //    immediately after, before anyone can spend it). ──
  const DEFAULT_POT_AUDIENCE: AllotmentAudience = 'trusted-members';

  const assignPotSeat = useCallback(
    async (cardRes: ResourceCard) => {
      if (!potHomeSlug || cardRes.type !== 'seat') return;
      setBusy(true);
      try {
        const target: SlotAxis = { ...cardRes.seat!, account: AUTO_ACCOUNT };
        const plan = planSlotWrite(potSlotRows, target, 1);
        await setAllotment({
          action: 'set',
          potSlug: potHomeSlug,
          audience: potAudienceByRef.get(agentSlotRef(plan.set.axis)) ?? DEFAULT_POT_AUDIENCE,
          resourceKind: 'agent_slot',
          resourceRef: agentSlotRef(plan.set.axis),
          quantity: plan.set.quantity,
          axis: plan.set.axis,
        });
        toast.success(`${plan.set.quantity} × ${cardRes.meta} seat${plan.set.quantity !== 1 ? 's' : ''} → whole pot`);
      } catch (e) {
        toast.error(`Couldn't offer to the pot: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [potHomeSlug, potSlotRows, potAudienceByRef, setAllotment],
  );
  const unassignPot = useCallback(
    async (resId: string, kind: WireKind) => {
      if (!potHomeSlug) return;
      setBusy(true);
      try {
        await setAllotment({ action: 'remove', potSlug: potHomeSlug, resourceKind: kind, resourceRef: resId });
      } catch (e) {
        toast.error(`Couldn't remove: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [potHomeSlug, setAllotment],
  );
  const stepPotSlot = useCallback(
    async (row: SlotRow, delta: number) => {
      if (!potHomeSlug) return;
      const plan = planSlotWrite(potSlotRows, row.axis, row.quantity + delta, row.ref);
      if (plan.set.quantity === row.quantity) return;
      setBusy(true);
      try {
        await setAllotment({
          action: 'set',
          potSlug: potHomeSlug,
          audience: potAudienceByRef.get(row.ref) ?? DEFAULT_POT_AUDIENCE,
          resourceKind: 'agent_slot',
          resourceRef: row.ref,
          quantity: plan.set.quantity,
          axis: plan.set.axis,
        });
      } catch (e) {
        toast.error(`Couldn't change seats: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [potHomeSlug, potSlotRows, potAudienceByRef, setAllotment],
  );
  const retargetPotSlotAccount = useCallback(
    async (row: SlotRow, account: string) => {
      if (!potHomeSlug || account === row.axis.account) return;
      const plan = planSlotWrite(potSlotRows, { ...row.axis, account }, row.quantity, row.ref);
      setBusy(true);
      try {
        await setAllotment({
          action: 'set',
          potSlug: potHomeSlug,
          audience: potAudienceByRef.get(row.ref) ?? DEFAULT_POT_AUDIENCE,
          resourceKind: 'agent_slot',
          resourceRef: agentSlotRef(plan.set.axis),
          quantity: plan.set.quantity,
          axis: plan.set.axis,
        });
        if (plan.removeRef) {
          await setAllotment({ action: 'remove', potSlug: potHomeSlug, resourceKind: 'agent_slot', resourceRef: plan.removeRef });
        }
      } catch (e) {
        toast.error(`Couldn't move seats: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [potHomeSlug, potSlotRows, potAudienceByRef, setAllotment],
  );
  const setPotAudience = useCallback(
    async (row: SlotRow, audience: AllotmentAudience) => {
      if (!potHomeSlug || potAudienceByRef.get(row.ref) === audience) return;
      setBusy(true);
      try {
        await setAllotment({
          action: 'set',
          potSlug: potHomeSlug,
          audience,
          resourceKind: 'agent_slot',
          resourceRef: row.ref,
          quantity: row.quantity,
          axis: row.axis,
        });
      } catch (e) {
        toast.error(`Couldn't change audience: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [potHomeSlug, potAudienceByRef, setAllotment],
  );

  const setDraftPct = useCallback((fleetId: string, resId: string, pct: number) => {
    const k = pctKey(fleetId, resId);
    pctDraftRef.current[k] = pct;
    setPctDraft({ ...pctDraftRef.current });
  }, []);
  const commitPct = useCallback(
    async (fleetId: string, resId: string, type: ResType, fallback: number) => {
      const pct = pctDraftRef.current[pctKey(fleetId, resId)] ?? fallback;
      try {
        await setAllotment({ action: 'set', fleetSlug: fleetId, resourceKind: type, resourceRef: resId, sharePct: pct });
      } catch (e) {
        toast.error(`Couldn't update share: ${e instanceof Error ? e.message : 'failed'}`);
      }
    },
    [setAllotment],
  );

  const fleetsFor = useCallback(
    (c: ResourceCard): string[] => {
      const names: string[] = [];
      const walk = (n: ResNode) => {
        if (n.kind === 'fleet') {
          const hit =
            c.type === 'seat'
              ? (slotRows[n.id] ?? []).some((r) => r.axis.model === c.seat!.model && r.axis.effort === c.seat!.effort)
              : (assignments[n.id] ?? []).some((a) => a.resId === c.id);
          if (hit) names.push(n.name);
        } else n.children.forEach(walk);
      };
      walk(tree);
      // P-002: a seat template offered to the whole pot shows up alongside its
      // per-fleet assignments on the draggable card.
      if (c.type === 'seat' && potSlotRows.some((r) => r.axis.model === c.seat!.model && r.axis.effort === c.seat!.effort)) {
        names.push('the pot');
      }
      return names;
    },
    [assignments, slotRows, potSlotRows, tree],
  );

  const onCardClick = useCallback((id: string) => setPickedId((cur) => (cur === id ? null : id)), []);
  const onFleetActivate = useCallback(
    (fleetId: string) => {
      if (!pickedId) return;
      const cardRes = allCards.find((c) => c.id === pickedId);
      if (cardRes) void assign(fleetId, cardRes);
      setPickedId(null);
    },
    [pickedId, allCards, assign],
  );
  const onPotActivate = useCallback(() => {
    if (!pickedId) return;
    const cardRes = allCards.find((c) => c.id === pickedId);
    if (cardRes?.type === 'seat') void assignPotSeat(cardRes);
    setPickedId(null);
  }, [pickedId, allCards, assignPotSeat]);

  /** Account options a fleet's seat chips may bill to: AUTO + the accounts THIS
      fleet has been allocated (D-003 — the supply→seat link, visible in the control). */
  const fleetAccountOptions = useCallback(
    (fleetId: string): { id: string; label: string }[] =>
      (assignments[fleetId] ?? [])
        .filter((a) => a.type === 'account')
        .map((a) => ({ id: a.resId, label: a.label })),
    [assignments],
  );

  const renderNode = (n: ResNode): React.ReactNode => {
    if (n.kind === 'hive') {
      const isCollapsed = collapsed.has(n.id);
      const fleets = countFleets(n);
      return (
        <div key={n.id} className="res-branch">
          <button type="button" className="res-node" aria-expanded={!isCollapsed} onClick={() => toggleHive(n.id)}>
            <span className="res-chev" aria-hidden="true">▾</span>
            <span className="res-ico" aria-hidden="true">☕</span>
            <span className="nm">{n.name}</span>
            <span className="who">{n.who}</span>
            <span className="cnt">{fleets} fleet{fleets !== 1 ? 's' : ''}</span>
          </button>
          {!isCollapsed && (
            <div className="res-children">
              {n.children.length === 0 ? (
                <div className="res-empty">No fleets in this workspace yet — create one in Ops.</div>
              ) : (
                n.children.map(renderNode)
              )}
            </div>
          )}
        </div>
      );
    }
    const list = assignments[n.id] ?? [];
    const slots = slotRows[n.id] ?? [];
    const acctOptions = fleetAccountOptions(n.id);
    return (
      <div key={n.id} className="res-branch">
        <div
          className={`res-fleet${overFleet === n.id ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOverFleet(n.id); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverFleet((c) => (c === n.id ? null : c)); }}
          onDrop={(e) => {
            e.preventDefault();
            setOverFleet(null);
            const cardRes = dragRef.current;
            if (cardRes) void assign(n.id, cardRes);
          }}
          onClick={() => onFleetActivate(n.id)}
        >
          <div className="res-fhead">
            <span className="dia" aria-hidden="true">◆</span>
            <span className="nm">{n.name}</span>
            <span className="who">{n.who}</span>
          </div>
          <div className="res-drop">
            {list.length === 0 && slots.length === 0 && <span className="hint">Drop accounts or seats here</span>}
            {list.map((a) => {
              const shownPct = pctDraft[pctKey(n.id, a.resId)] ?? a.pct;
              return (
                <span key={a.resId} className={`res-chip ${a.type === 'account' ? 'a' : 'g'}`}>
                  <span className="lbl">{a.label}</span>
                  {a.type === 'gpu' ? (
                    <span className="pct locked" title="Fractional GPU share arrives with local inference (P-207). Locked at 100% for now.">
                      100%<span className="lock" aria-hidden="true">🔒</span>
                    </span>
                  ) : (
                    <>
                      <input
                        type="range"
                        min={5}
                        max={100}
                        step={5}
                        value={shownPct}
                        disabled={busy}
                        aria-label={`${a.label} share percent`}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setDraftPct(n.id, a.resId, Number(e.target.value))}
                        onPointerUp={() => void commitPct(n.id, a.resId, a.type, a.pct)}
                      />
                      <span className="pct">{shownPct}%</span>
                    </>
                  )}
                  <button
                    type="button"
                    className="x"
                    aria-label={`Remove ${a.label} from ${n.name}`}
                    onClick={(e) => { e.stopPropagation(); void unassign(n.id, a.resId, a.type); }}
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {slots.map((row) => {
              // Always show the row's REAL account, even if that pool was later
              // unallocated from the fleet (it renders as an extra option).
              const orphanAccount =
                row.axis.account !== AUTO_ACCOUNT && !acctOptions.some((o) => o.id === row.axis.account);
              const accountOptions = [
                { value: AUTO_ACCOUNT, label: 'AUTO' },
                ...acctOptions.map((o) => ({ value: o.id, label: o.label })),
                ...(orphanAccount ? [{ value: row.axis.account, label: row.axis.account }] : []),
              ];
              return (
                <span key={row.ref} className="res-chip s">
                  <span className="lbl" title={row.ref}>{slotChipLabel(row)}</span>
                  <span className="res-step" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="stepbtn"
                      disabled={busy || row.quantity <= 1}
                      aria-label={`Fewer ${row.axis.model}·${row.axis.effort} seats on ${n.name}`}
                      onClick={() => void stepSlot(n.id, row, -1)}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="stepbtn"
                      disabled={busy || row.quantity >= AGENT_SLOT_MAX_QUANTITY}
                      aria-label={`More ${row.axis.model}·${row.axis.effort} seats on ${n.name}`}
                      onClick={() => void stepSlot(n.id, row, +1)}
                    >
                      +
                    </button>
                  </span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Select
                      value={row.axis.account}
                      onChange={(value) => void retargetSlotAccount(n.id, row, value)}
                      options={accountOptions}
                      disabled={busy}
                      ariaLabel={`${row.axis.model}·${row.axis.effort} seats gateway account`}
                      triggerClassName="res-acct"
                    />
                  </span>
                  <button
                    type="button"
                    className="x"
                    aria-label={`Remove ${slotChipLabel(row)} seats from ${n.name}`}
                    onClick={(e) => { e.stopPropagation(); void unassign(n.id, row.ref, 'agent_slot'); }}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const card = (c: ResourceCard) => {
    const on = fleetsFor(c);
    return (
      <div
        key={c.id}
        className={`res-card${dragId === c.id ? ' dragging' : ''}${pickedId === c.id ? ' picked' : ''}`}
        data-type={c.type}
        draggable
        onDragStart={(e) => { dragRef.current = c; setDragId(c.id); e.dataTransfer.effectAllowed = 'copy'; }}
        onDragEnd={() => { dragRef.current = null; setDragId(null); }}
        onClick={() => onCardClick(c.id)}
      >
        <span className="res-grip" aria-hidden="true">⠿</span>
        <div className="body">
          <div className="nm">{c.label}</div>
          <div className="mt">{c.meta}</div>
          <div className="assignedto">{on.length ? `→ ${on.join(', ')}` : ''}</div>
        </div>
        <span className={`res-tag ${c.type === 'account' ? 'a' : c.type === 'gpu' ? 'g' : 's'}`}>
          {c.type === 'account' ? 'POOL' : c.type === 'gpu' ? 'CARD' : 'SEAT'}
        </span>
      </div>
    );
  };

  return (
    <div className="res-page">
      <div className="res-head">
        <h1>Resources</h1>
        <p className="res-lede">
          Allocation is scoped to this workspace. Drag an account or a seat onto a <b>fleet</b> to hand it
          over — the change is saved instantly.
        </p>
        <span className="res-ws">
          <span className="k">Workspace</span>
          <span className="v">{workspace}</span>
        </span>
      </div>

      {fleetsError && (
        <p role="alert" className="res-err">Couldn&apos;t load fleets: {fleetsError.message}</p>
      )}

      <div className="res-board">
        <div className="res-col">
          <div className="res-colhead">
            <h2>{t('pot', { plural: true })} &amp; fleets</h2>
            <span className="ct">{countFleets(tree)} fleets</span>
          </div>
          <div className="res-tree">{renderNode(tree)}</div>

          {/* P-002: pot-wide seat offers — a standing seat delegation any fleet
              in the pot can spend from (once P-003/P-004 land), instead of one
              named fleet. Hidden behind an explanatory note when this
              workspace has no single shared hive to publish into. */}
          {potHomeSlug ? (
            <div
              className={`res-fleet res-pot${overPot ? ' over' : ''}`}
              onDragOver={(e) => {
                if (dragRef.current?.type !== 'seat') return;
                e.preventDefault();
                setOverPot(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverPot(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOverPot(false);
                const cardRes = dragRef.current;
                if (cardRes?.type === 'seat') void assignPotSeat(cardRes);
              }}
              onClick={onPotActivate}
            >
              <div className="res-fhead">
                <span className="dia" aria-hidden="true">☕</span>
                <span className="nm">Whole pot</span>
                <span className="who">{potHomeSlug} — audience-gated, spendable by any fleet in the pot</span>
              </div>
              <div className="res-drop">
                {potSlotRows.length === 0 && <span className="hint">Drop a seat here to offer it to the whole pot</span>}
                {potSlotRows.map((row) => {
                  const audience = potAudienceByRef.get(row.ref) ?? DEFAULT_POT_AUDIENCE;
                  return (
                    <span key={row.ref} className="res-chip s">
                      <span className="lbl" title={row.ref}>{slotChipLabel(row)}</span>
                      <span className="res-step" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="stepbtn"
                          disabled={busy || row.quantity <= 1}
                          aria-label={`Fewer ${row.axis.model}·${row.axis.effort} pot-wide seats`}
                          onClick={() => void stepPotSlot(row, -1)}
                        >
                          −
                        </button>
                        <button
                          type="button"
                          className="stepbtn"
                          disabled={busy || row.quantity >= AGENT_SLOT_MAX_QUANTITY}
                          aria-label={`More ${row.axis.model}·${row.axis.effort} pot-wide seats`}
                          onClick={() => void stepPotSlot(row, +1)}
                        >
                          +
                        </button>
                      </span>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Select
                          value={audience}
                          onChange={(value) => void setPotAudience(row, value as AllotmentAudience)}
                          options={[
                            { value: 'trusted-members', label: 'Trusted members' },
                            { value: 'whole-pot', label: 'Whole pot' },
                          ]}
                          disabled={busy}
                          ariaLabel={`${row.axis.model}·${row.axis.effort} pot-wide audience`}
                          triggerClassName="res-acct res-audience"
                        />
                      </span>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Select
                          value={row.axis.account}
                          onChange={(value) => void retargetPotSlotAccount(row, value)}
                          options={[{ value: AUTO_ACCOUNT, label: 'AUTO' }]}
                          disabled={busy}
                          ariaLabel={`${row.axis.model}·${row.axis.effort} pot-wide seats gateway account`}
                          triggerClassName="res-acct"
                        />
                      </span>
                      <button
                        type="button"
                        className="x"
                        aria-label={`Remove ${slotChipLabel(row)} pot-wide seats`}
                        onClick={(e) => { e.stopPropagation(); void unassignPot(row.ref, 'agent_slot'); }}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="res-empty">
              Pot-wide seat offers need a single shared hive for this workspace — none configured. Fleet-scoped
              seats above still work; join or publish a shared hive to enable a standing pot-wide offer.
            </div>
          )}
        </div>

        {/* D-001 group 1: the SUPPLY pool — what the autonomous loop (and the
            seats' AUTO account) draws from. */}
        <div className="res-col res-group" data-group="capacity">
          <div className="res-colhead">
            <h2>Autonomous-loop capacity</h2>
            <span className="ct">{accounts.length + gpus.length} sources</span>
          </div>
          <p className="res-grouplede">
            Fuels the {t('brain', { lower: true })}↔{t('contributor', { lower: true })} loop — accounts share by <b>%</b>, and a fleet&apos;s seats on AUTO draw
            from these accounts.
          </p>
          <div className="res-subhead">
            <h3>Accounts</h3>
            <span className="ct">{accounts.length} pools</span>
          </div>
          {accounts.length === 0 ? (
            <div className="res-empty">No account pools registered.</div>
          ) : (
            accounts.map(card)
          )}
          <div className="res-subhead">
            <h3>Graphics cards</h3>
            <span className="ct">{gpus.length} local</span>
          </div>
          <div className="res-locknote">Local GPU sharing arrives with local inference (P-207).</div>
          {gpus.map(card)}
        </div>

        {/* D-001 group 2: the DEMAND side — counted, launchable su-agent seats. */}
        <div className="res-col res-group" data-group="seats">
          <div className="res-colhead">
            <h2>Agent seats</h2>
            <span className="ct">{seats.length} templates</span>
          </div>
          <p className="res-grouplede">
            Launchable su-agents, capped by <b>count</b> — drop a seat on a fleet, then set how many and
            which account (AUTO = gateway pick).
          </p>
          {seats.length === 0 ? (
            <div className="res-empty">No representable model tiers — check the workspace tier menu.</div>
          ) : (
            seats.map(card)
          )}
        </div>
      </div>

      <div className="res-hintbar">
        <span aria-hidden="true">💡</span>
        <div>
          Drop an account or a <b>seat</b> on a fleet, or click a card then a fleet. Accounts take a{' '}
          <b>%</b> share; seats take a <b>count</b> (step it on the chip). A seat&apos;s account of AUTO
          draws from the accounts you gave that fleet.
        </div>
      </div>
    </div>
  );
}
