"use client";

/**
 * Settings → Identities (identities-v1 P-011, D-028/D-030).
 *
 * Reads the existing identity catalog + activation surface and shared agent
 * roster through @papercusp/sync. Every durable selection lives in nuqs. Writes
 * go through the existing loopback mutation door and only a host-acknowledged
 * revision is labelled Applied; desired/prepared state never borrows that badge.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { useSyncMutate, useSyncQuery } from "@papercusp/sync";
import { RichGrid, type ColumnDef } from "@papercusp/grid-core";
import type { RosterAgent } from "@papercusp/agent-roster";
import { toast } from "sonner";
import { Button } from "@/app/harness/Button";
import { Checkbox } from "@/app/harness/Checkbox";
import { RadioGroup } from "@/app/harness/RadioGroup";
import { Select } from "@/app/harness/Select";
import { advRosterArgs } from "@/lib/adv-roster-args";

type Tab = "library" | "agent" | "bindings";
type Delivery = "inject-now" | "relaunch-with-carry";
/** Read-only indicator options for the shared RadioGroup: delivery is derived
 * from the slot policy, so every option stays disabled. */
const DELIVERY_OPTIONS: ReadonlyArray<{ value: Delivery; disabled: true }> = [
  { value: "inject-now", disabled: true },
  { value: "relaunch-with-carry", disabled: true },
];
type ActivationStatus = "desired" | "prepared" | "applied" | "failed";
type MutationAction = "preview" | "attach" | "switch" | "detach" | "rollback";

const TABS = ["library", "agent", "bindings"] as const;
const DELIVERIES = ["inject-now", "relaunch-with-carry"] as const;

interface IdentitySummary {
  id: string;
  sourceId: string;
  tier: string;
  version?: string | null;
  sourceRevision?: string | null;
  launchCompatibility?: { eligible: boolean; reason: string | null };
  description?: string | null;
  slots: Array<{ slot: string; cardinality: "exclusive" | "additive" | null }>;
  sourcePath: string;
}

interface Revision {
  specificationRevision: string;
  stateRevision: string;
}

interface Activation {
  desired: Revision;
  prepared: Revision | null;
  applied: Revision | null;
  status: ActivationStatus;
  failure?: string;
}

interface ProvenanceRow {
  path: string;
  sourceRef: string;
  sourceRevision?: string;
}

interface AgentArtifact {
  specificationRevision?: string;
  compilerVersion?: string;
  configuration?: unknown;
  inputs?: unknown[];
  provenance?: ProvenanceRow[];
}

interface ArtifactHistoryEntry extends Revision {
  stack: string[];
  recordedAt: string;
}

interface IdentitySurface {
  identities: IdentitySummary[];
  unreadable: Array<{ id: string; error: string }>;
  catalogAfter: string | null;
  catalogNextAfter: string | null;
  catalogScanned: number;
  session: null | {
    ownerId: string;
    agent: string;
    principalId: string;
    harnessSlug: string | null;
    explicitStack: string[];
    effectiveStack: string[];
    appliedStack: string[];
    specificationRevision: string | null;
    stateRevision: string | null;
    activation: Activation | null;
    artifact: AgentArtifact | null;
    appliedArtifact: AgentArtifact | null;
    history: ArtifactHistoryEntry[];
  };
  transitions: Array<{
    phase: ActivationStatus;
    source: string;
    specificationRevision: string;
    stateRevision: string;
    stackRefs: string[];
    failure: string | null;
    recordedAt: string;
  }>;
  bindings: { available: false; milestone: "M3"; message: string };
}

interface RosterResponse {
  active: RosterAgent[];
}

interface DiffRow {
  field: string;
  applied: unknown;
  selected: unknown;
  origin: string | null;
}

interface MutationArgs {
  ownerId: string;
  action: MutationAction;
  identityId?: string;
  slot?: string;
}

interface MutationResult {
  ok: boolean;
  changed: boolean;
  action: MutationAction;
  delivery: Delivery | null;
  stack: string[];
  replaced: string | null;
  specificationRevision: string;
  stateRevision: string;
  diff: DiffRow[];
  activation: Activation | null;
  nudge: { queued: boolean; reason: string | null };
  error?: string;
}

interface CompositionResult {
  ok: boolean;
  id: string;
  components: Array<{ ref: string; sourceRevision: string }>;
  preview: {
    layers: Array<{ id: string; revision: string }>;
    bundles: Array<{ kind: string; ref: string }>;
    grants: { requires?: string[]; optional?: string[] } | null;
    knobs: unknown;
    contributions: Array<{ id: string; source: string; refresh: string }>;
    launchCompatibility: { eligible: boolean; reason: string | null };
  };
}

async function postIdentityManagement<T extends { ok: boolean; error?: string }>(args: object): Promise<T> {
  const response = await fetch("/api/agent-mcp/identity-management", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let result: Partial<T> = {};
  try {
    result = JSON.parse(text) as T;
  } catch {
    // The typed error below preserves the status when a proxy returns HTML.
  }
  if (!response.ok || result.ok === false) {
    throw new Error(result.error ?? `HTTP ${response.status}`);
  }
  return result as T;
}

const identityMutationRest = (args: MutationArgs) =>
  postIdentityManagement<MutationResult>(args);

function shortRevision(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "—";
}

function printable(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function identityRef(identity: IdentitySummary, slot: string): string {
  return `${slot}:${identity.id}`;
}

function slotFor(
  identity: IdentitySummary | null,
  requested: string,
): IdentitySummary["slots"][number] | null {
  if (!identity) return null;
  return (
    identity.slots.find((entry) => entry.slot === requested) ??
    identity.slots[0] ??
    null
  );
}

function statusCopy(
  activation: Activation | null,
): { tone: string; title: string; body: string } | null {
  if (!activation) return null;
  switch (activation.status) {
    case "desired":
      return {
        tone: "info",
        title: "Change requested",
        body: "The currently applied identity remains active.",
      };
    case "prepared":
      return {
        tone: "warn",
        title: "Validated; waiting for host acknowledgement",
        body: "The prior identity remains active until the host accepts this exact revision.",
      };
    case "applied":
      return {
        tone: "good",
        title: "Identity applied",
        body: "This revision was acknowledged by the host.",
      };
    case "failed":
      return {
        tone: "bad",
        title: "The change failed",
        body: activation.failure
          ? `${activation.failure} The previous valid identity remains active; retry or roll back.`
          : "The previous valid identity remains active; retry or roll back.",
      };
  }
}

const DIFF_COLUMNS: ColumnDef<DiffRow>[] = [
  {
    key: "field",
    header: "Field",
    width: "minmax(180px, 1.2fr)",
    toCopyText: (row) => row.field,
    render: ({ row }) => <code>{row.field}</code>,
  },
  {
    key: "applied",
    header: "Applied",
    width: "minmax(130px, 1fr)",
    toCopyText: (row) => printable(row.applied),
    render: ({ row }) => printable(row.applied),
  },
  {
    key: "selected",
    header: "Selected",
    width: "minmax(130px, 1fr)",
    toCopyText: (row) => printable(row.selected),
    render: ({ row }) => printable(row.selected),
  },
  {
    key: "origin",
    header: "Origin",
    width: "minmax(120px, .8fr)",
    toCopyText: (row) => row.origin ?? "",
    render: ({ row }) => row.origin ?? "—",
  },
];

export default function IdentitySettingsPage() {
  const [tab, setTab] = useQueryState(
    "identityTab",
    parseAsStringEnum<Tab>([...TABS]).withDefault("library"),
  );
  const [search, setSearch] = useQueryState(
    "identitySearch",
    parseAsString.withDefault(""),
  );
  const [slotFilter, setSlotFilter] = useQueryState(
    "identitySlot",
    parseAsString.withDefault("all"),
  );
  const [identityId, setIdentityId] = useQueryState(
    "identityId",
    parseAsString.withDefault(""),
  );
  const [agentId, setAgentId] = useQueryState(
    "identityAgent",
    parseAsString.withDefault(""),
  );
  const [delivery, setDelivery] = useQueryState(
    "identityDelivery",
    parseAsStringEnum<Delivery>([...DELIVERIES]).withDefault(
      "relaunch-with-carry",
    ),
  );

  const rosterQuery = useSyncQuery<RosterResponse>({
    queryName: "advRoster.list",
    args: advRosterArgs(null),
    pollIntervalMs: 5_000,
  });
  const agents = useMemo(
    () =>
      (rosterQuery.data?.[0]?.active ?? []).filter(
        (agent) => agent.sessionState !== "ended",
      ),
    [rosterQuery.data],
  );
  const effectiveAgentId = agentId || agents[0]?.ownerId || "";
  const [catalogAfter, setCatalogAfter] = useState<string | null>(null);
  const [catalogHistory, setCatalogHistory] = useState<Array<string | null>>([]);
  useEffect(() => {
    setCatalogAfter(null);
    setCatalogHistory([]);
  }, [effectiveAgentId]);
  const identityQuery = useSyncQuery<IdentitySurface>({
    queryName: "identities.surface",
    args: { ...(effectiveAgentId ? { ownerId: effectiveAgentId } : {}),
      ...(catalogAfter ? { after: catalogAfter } : {}), limit: 30 },
  });
  const surface = identityQuery.data?.[0] ?? null;
  const identities = surface?.identities ?? [];
  const selected =
    identities.find((identity) => identity.id === identityId) ??
    identities.find((identity) => identity.id === "papercusp-engineer") ??
    identities[0] ??
    null;
  const requestedSlot = slotFilter === "all" ? "" : slotFilter;
  const selectedSlot = slotFor(selected, requestedSlot);
  const currentRef =
    selected && selectedSlot ? identityRef(selected, selectedSlot.slot) : null;
  const isApplied = Boolean(
    currentRef && surface?.session?.appliedStack.includes(currentRef),
  );

  const slots = useMemo(
    () =>
      [
        ...new Set(
          identities.flatMap((identity) =>
            identity.slots.map((entry) => entry.slot),
          ),
        ),
      ].sort(),
    [identities],
  );
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return identities.filter((identity) => {
      if (
        slotFilter !== "all" &&
        !identity.slots.some((slot) => slot.slot === slotFilter)
      )
        return false;
      if (!needle) return true;
      return [
        identity.id,
        identity.sourceId,
        identity.description ?? "",
        identity.tier,
        ...identity.slots.map((slot) => slot.slot),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [identities, search, slotFilter]);

  const mutate = useSyncMutate<MutationArgs, MutationResult>(
    "identities.apply",
    identityMutationRest,
  );
  const [busy, setBusy] = useState<MutationAction | null>(null);
  const [review, setReview] = useState<MutationResult | null>(null);
  const [lastResult, setLastResult] = useState<MutationResult | null>(null);
  const [compositionId, setCompositionId] = useState("");
  const [compositionDescription, setCompositionDescription] = useState("");
  const [componentRefs, setComponentRefs] = useState<string[]>([]);
  const [compositionPreview, setCompositionPreview] = useState<CompositionResult | null>(null);
  const [compositionBusy, setCompositionBusy] = useState(false);
  const previewIsCurrent = Boolean(compositionPreview?.id === compositionId.trim() &&
    JSON.stringify(compositionPreview.components.map((entry) => entry.ref)) === JSON.stringify(componentRefs));

  const runComposition = async (action: "preview-composition" | "save-composition") => {
    setCompositionBusy(true);
    try {
      const result = await postIdentityManagement<CompositionResult>({
        action, compositionId: compositionId.trim(), description: compositionDescription.trim(),
        componentRefs, harnessSlug: surface?.session?.harnessSlug ?? null,
      });
      if (action === "preview-composition") setCompositionPreview(result);
      else {
        toast.success(`Saved ${result.id} to the identity library.`);
        setCompositionPreview(null);
        setCompositionId("");
        setCompositionDescription("");
        setComponentRefs([]);
        identityQuery.invalidate?.();
      }
    } catch (error) {
      toast.error(`Identity composition failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setCompositionBusy(false);
    }
  };

  useEffect(() => {
    if (!selectedSlot?.cardinality) return;
    const required: Delivery =
      selectedSlot.slot === "domain" || selectedSlot.slot === "client"
        ? "relaunch-with-carry"
        : "inject-now";
    if (delivery !== required) void setDelivery(required);
  }, [delivery, selectedSlot, setDelivery]);

  const run = useCallback(
    async (args: MutationArgs) => {
      setBusy(args.action);
      try {
        const result = await mutate(args);
        setLastResult(result);
        if (args.action === "preview") setReview(result);
        else {
          setReview(null);
          identityQuery.invalidate?.();
          toast.success(
            result.delivery === "relaunch-with-carry"
              ? "Identity change prepared. The agent must cross a clean fresh-context boundary before it becomes applied."
              : result.changed
                ? "Identity change prepared for the live session."
                : "The identity stack was already in that state.",
          );
        }
        return result;
      } catch (error) {
        toast.error(
          `Identity change failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return null;
      } finally {
        setBusy(null);
      }
    },
    [identityQuery, mutate],
  );

  const reviewSelected = useCallback(() => {
    if (!effectiveAgentId || !selected || !selectedSlot) return;
    void (async () => {
      const result = await run({
        ownerId: effectiveAgentId,
        action: "preview",
        identityId: selected.id,
        slot: selectedSlot.slot,
      });
      if (!result) return;
      if (result.delivery) void setDelivery(result.delivery);
      void setTab("agent");
    })();
  }, [effectiveAgentId, run, selected, selectedSlot, setDelivery, setTab]);

  const applySelected = useCallback(() => {
    if (!effectiveAgentId || !selected || !selectedSlot) return;
    const action: MutationAction =
      selectedSlot.cardinality === "additive" ? "attach" : "switch";
    void run({
      ownerId: effectiveAgentId,
      action,
      identityId: selected.id,
      slot: selectedSlot.slot,
    });
  }, [effectiveAgentId, run, selected, selectedSlot]);

  const detachSelected = useCallback(() => {
    if (!effectiveAgentId || !selected || !selectedSlot) return;
    void run({
      ownerId: effectiveAgentId,
      action: "detach",
      identityId: selected.id,
      slot: selectedSlot.slot,
    });
  }, [effectiveAgentId, run, selected, selectedSlot]);

  const rollback = useCallback(() => {
    if (!effectiveAgentId) return;
    void run({ ownerId: effectiveAgentId, action: "rollback" });
  }, [effectiveAgentId, run]);

  const banner = statusCopy(
    lastResult?.activation ?? surface?.session?.activation ?? null,
  );
  const reviewRows = review?.diff ?? [];
  const agentLabel =
    agents.find((agent) => agent.ownerId === effectiveAgentId)?.label ||
    effectiveAgentId;

  return (
    <main className="pc-identities">
      <header className="pc-identities__header">
        <div>
          <h1>Identities</h1>
          <p className="pc-settings-intro">
            Choose agent behavior, inspect what is actually active, and manage
            the transition safely.
          </p>
        </div>
        <label className="pc-identities__agent-picker">
          <span>Agent</span>
          <Select
            value={effectiveAgentId}
            onChange={(value) => {
              void setAgentId(value);
              setReview(null);
            }}
            ariaLabel="Agent to manage"
            placeholder="Choose an agent"
            options={agents.map((agent) => ({
              value: agent.ownerId,
              label: agent.label || agent.ownerId,
            }))}
            disabled={agents.length === 0}
          />
        </label>
      </header>

      <div
        className="pc-identities__tabs"
        role="tablist"
        aria-label="Identity management sections"
      >
        {TABS.map((value) => (
          <Button
            key={value}
            role="tab"
            aria-selected={tab === value}
            variant={tab === value ? "accent" : "ghost"}
            onClick={() => void setTab(value)}
          >
            {value === "library"
              ? "Library"
              : value === "agent"
                ? "Current agent"
                : "Provider bindings"}
          </Button>
        ))}
      </div>

      {identityQuery.loading && <p role="status">Loading identities…</p>}
      {identityQuery.error && (
        <div
          className="pc-identities__banner pc-identities__banner--bad"
          role="alert"
        >
          <strong>Identities could not be read.</strong> Nothing was changed.{" "}
          <Button onClick={() => identityQuery.invalidate?.()}>Retry</Button>
        </div>
      )}

      {!identityQuery.loading && !identityQuery.error && tab === "library" && (
        <section
          className="pc-identities__library"
          aria-label="Installed identities"
        >
          <div className="pc-identities__catalog pc-card">
            <h2>Installed identities</h2>
            <label className="pc-identities__search">
              <span className="sr-only">Search installed identities</span>
              <input
                type="search"
                value={search}
                onChange={(event) => void setSearch(event.target.value)}
                placeholder="Search this page…"
                aria-label="Search installed identities"
              />
            </label>
            <div
              className="pc-identities__chips"
              role="group"
              aria-label="Filter identities by slot"
            >
              {["all", ...slots].map((slot) => (
                <button
                  key={slot}
                  type="button"
                  className={slotFilter === slot ? "is-active" : ""}
                  aria-pressed={slotFilter === slot}
                  onClick={() => void setSlotFilter(slot)}
                >
                  {slot === "all" ? "All slots" : slot}
                </button>
              ))}
            </div>
            <div className="pc-identities__identity-list">
              {visible.map((identity) => {
                const applied = identity.slots.some((slot) =>
                  surface?.session?.appliedStack.includes(
                    identityRef(identity, slot.slot),
                  ),
                );
                return (
                  <button
                    key={identity.id}
                    type="button"
                    className={
                      selected?.id === identity.id
                        ? "pc-identities__identity is-selected"
                        : "pc-identities__identity"
                    }
                    aria-label={`Inspect identity ${identity.id}`}
                    onClick={() => {
                      void setIdentityId(identity.id);
                      setReview(null);
                    }}
                  >
                    <span>
                      <strong>{identity.id}</strong>
                      <small>
                        {identity.description ||
                          identity.slots.map((slot) => slot.slot).join(" · ")}
                      </small>
                    </span>
                    {applied && (
                      <span className="pc-identities__pill pc-identities__pill--applied">
                        Applied
                      </span>
                    )}
                  </button>
                );
              })}
              {visible.length === 0 && (
                <div className="pc-identities__empty">
                  <strong>No selectable identities match on this page</strong>
                  <span>Clear the search, choose another slot, or load the next page.</span>
                </div>
              )}
              {(surface?.unreadable ?? []).map((row) => (
                <div key={`invalid:${row.id}`} className="pc-identities__identity pc-identities__identity--invalid"
                  role="status" aria-label={`Invalid identity ${row.id}`}>
                  <strong>{row.id}</strong>
                  <small>Invalid source: {row.error}</small>
                </div>
              ))}
            </div>
            <div className="pc-identities__catalog-pages" aria-label="Identity catalog pages">
              <Button variant="ghost" disabled={catalogHistory.length === 0 || identityQuery.loading}
                onClick={() => {
                  setCatalogAfter(catalogHistory.at(-1) ?? null);
                  setCatalogHistory(catalogHistory.slice(0, -1));
                }}>Previous</Button>
              <span>Page {catalogHistory.length + 1}</span>
              <Button variant="ghost" disabled={!surface?.catalogNextAfter || identityQuery.loading}
                onClick={() => {
                  if (!surface?.catalogNextAfter) return;
                  setCatalogHistory([...catalogHistory, catalogAfter]);
                  setCatalogAfter(surface.catalogNextAfter);
                }}>Load more</Button>
            </div>
          </div>

          <div className="pc-identities__detail pc-card">
            {selected ? (
              <>
                <div className="pc-identities__detail-head">
                  <div>
                    <h2>{selected.id}</h2>
                    <p>{selected.description || "Installed identity layer"}</p>
                  </div>
                  {isApplied && (
                    <span className="pc-identities__pill pc-identities__pill--applied">
                      Applied
                    </span>
                  )}
                </div>
                <dl className="pc-identities__details">
                  <div>
                    <dt>Tier</dt>
                    <dd>{selected.tier}</dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{selected.version || "unversioned"}</dd>
                  </div>
                  <div>
                    <dt>Source revision</dt>
                    <dd><code>{shortRevision(selected.sourceRevision)}</code></dd>
                  </div>
                  {selected.launchCompatibility?.eligible === false && <div>
                    <dt>Launch availability</dt>
                    <dd>{selected.launchCompatibility.reason}</dd>
                  </div>}
                  <div>
                    <dt>Source id</dt>
                    <dd>
                      <code>{selected.sourceId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd title={selected.sourcePath}>{selected.sourcePath}</dd>
                  </div>
                </dl>

                <div className="pc-identities__slot-row">
                  <label>
                    <span>Slot</span>
                    <Select
                      value={selectedSlot?.slot ?? ""}
                      onChange={(value) => {
                        void setSlotFilter(value);
                        setReview(null);
                      }}
                      ariaLabel="Identity slot"
                      options={selected.slots.map((slot) => ({
                        value: slot.slot,
                        label: `${slot.slot} · ${slot.cardinality ?? "unknown cardinality"}`,
                      }))}
                    />
                  </label>
                  <span className="pc-identities__muted">
                    {selectedSlot?.cardinality === "additive"
                      ? "Additive — attaches beside existing identities."
                      : "Exclusive — applying this identity replaces the current holder."}
                  </span>
                </div>

                <section
                  className="pc-identities__settings"
                  aria-label="Identity settings"
                >
                  <h3>Identity settings</h3>
                  <p>
                    This installed identity declares no separately editable
                    values on this surface. Its configuration remains
                    file-canonical and is resolved from the installed blueprint
                    before activation.
                  </p>
                </section>

                <div className="pc-identities__actions">
                  <Button
                    variant="primary"
                    onClick={reviewSelected}
                    disabled={
                      !effectiveAgentId || !selectedSlot || busy !== null
                    }
                  >
                    {busy === "preview" ? "Preparing review…" : "Review switch"}
                  </Button>
                  {isApplied && (
                    <Button onClick={detachSelected} disabled={busy !== null}>
                      {busy === "detach" ? "Detaching…" : "Detach identity"}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="pc-identities__empty">
                <strong>No identities installed</strong>
                <span>
                  Install an identity through Cupboard, then return here.
                </span>
              </div>
            )}
          </div>
          <div className="pc-identities__composer pc-card" aria-label="Compose named identity">
            <h2>Compose a named identity</h2>
            <p>Choose reusable components, inspect their resources and settings, then save one named selection.</p>
            <label><span>Name</span>
              <input value={compositionId} disabled={compositionBusy} aria-label="New identity name"
                placeholder="research-steward" onChange={(event) => {
                  setCompositionId(event.target.value); setCompositionPreview(null);
                }} />
            </label>
            <label><span>Description</span>
              <input value={compositionDescription} disabled={compositionBusy} aria-label="New identity description"
                onChange={(event) => { setCompositionDescription(event.target.value); setCompositionPreview(null); }} />
            </label>
            <div className="pc-identities__component-options" role="group" aria-label="Identity components">
              {identities.flatMap((identity) => identity.slots.filter((slot) => slot.cardinality).map((slot) => {
                const ref = identityRef(identity, slot.slot);
                return <label key={ref}>
                  <Checkbox checked={componentRefs.includes(ref)} disabled={compositionBusy}
                    ariaLabel={`Include ${identity.id} as ${slot.slot}`}
                    onChange={(checked) => {
                      setComponentRefs((current) => checked
                        ? [...current.filter((value) => value.split(':')[0] !== slot.slot &&
                          !value.endsWith(`:${identity.id}`)), ref]
                        : current.filter((value) => value !== ref));
                      setCompositionPreview(null);
                    }} />
                  <span>{identity.id} · {slot.slot} · {identity.tier} · {identity.version || "unversioned"}</span>
                </label>;
              }))}
            </div>
            {componentRefs.length > 0 && <p>Selected: {componentRefs.join(" · ")}</p>}
            <div className="pc-identities__actions">
              <Button disabled={compositionBusy || !compositionId.trim() || componentRefs.length === 0}
                onClick={() => void runComposition("preview-composition")}>Preview composition</Button>
              <Button variant="primary" disabled={compositionBusy || !previewIsCurrent}
                onClick={() => void runComposition("save-composition")}>Save named identity</Button>
            </div>
            {compositionPreview && <div className="pc-identities__composition-preview" role="status">
              <h3>Composition preview</h3>
              <p>Sources: {compositionPreview.preview.layers.map((layer) =>
                `${layer.id} (${shortRevision(layer.revision)})`).join(" · ")}</p>
              <p>Resources: {compositionPreview.preview.bundles.map((bundle) =>
                `${bundle.kind}:${bundle.ref}`).join(" · ") || "none"}</p>
              <p>Required tools: {compositionPreview.preview.grants?.requires?.join(" · ") || "none"}</p>
              <p>Optional tools: {compositionPreview.preview.grants?.optional?.join(" · ") || "none"}</p>
              <p>Operational settings: {printable(compositionPreview.preview.knobs)}</p>
              <p>Current context: {compositionPreview.preview.contributions.map((entry) =>
                `${entry.id} (${entry.source}, ${entry.refresh})`).join(" · ") || "none"}</p>
              {compositionPreview.preview.launchCompatibility.eligible === false && <p role="alert">
                This composition can be saved, but it cannot be launched from a plain Identity picker: {compositionPreview.preview.launchCompatibility.reason}
              </p>}
            </div>}
          </div>
        </section>
      )}

      {!identityQuery.loading && !identityQuery.error && tab === "agent" && (
        <section className="pc-identities__agent" aria-label="Current agent">
          {!surface?.session ? (
            <div className="pc-card pc-identities__empty">
              <strong>No mutable session selected</strong>
              <span>
                Choose a live agent whose launch specification can be managed.
              </span>
            </div>
          ) : (
            <>
              <div className="pc-card pc-identities__agent-card">
                <div className="pc-identities__detail-head">
                  <div>
                    <h2>{agentLabel || "Current agent"}</h2>
                    <p>
                      <code>{surface.session.ownerId}</code>
                    </p>
                  </div>
                  {surface.session.activation?.status === "applied" && (
                    <span className="pc-identities__pill pc-identities__pill--applied">
                      Applied
                    </span>
                  )}
                </div>
                <dl className="pc-identities__details">
                  <div>
                    <dt>Agent</dt>
                    <dd>{surface.session.agent}</dd>
                  </div>
                  <div>
                    <dt>Principal</dt>
                    <dd>
                      <code>{surface.session.principalId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Harness</dt>
                    <dd>{surface.session.harnessSlug || "workspace-wide"}</dd>
                  </div>
                  <div>
                    <dt>Applied revision</dt>
                    <dd>
                      <code>
                        {shortRevision(
                          surface.session.activation?.applied
                            ?.specificationRevision,
                        )}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>Desired revision</dt>
                    <dd>
                      <code>
                        {shortRevision(
                          surface.session.activation?.desired
                            .specificationRevision,
                        )}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>State revision</dt>
                    <dd>
                      <code>
                        {shortRevision(surface.session.stateRevision)}
                      </code>
                    </dd>
                  </div>
                </dl>
              </div>

              {banner && (
                <div
                  className={`pc-identities__banner pc-identities__banner--${banner.tone}`}
                  role={
                    surface.session.activation?.status === "failed"
                      ? "alert"
                      : "status"
                  }
                  aria-live={
                    surface.session.activation?.status === "failed"
                      ? "assertive"
                      : "polite"
                  }
                >
                  <strong>{banner.title}.</strong> {banner.body}
                </div>
              )}

              <div className="pc-card pc-identities__stack-card">
                <h2>Applied stack</h2>
                <p className="pc-identities__muted">
                  This is the host-acknowledged stack. Desired and prepared
                  revisions remain pending above until acknowledgement.
                </p>
                <div className="pc-identities__stack">
                  {surface.session.appliedStack.length > 0 ? (
                    surface.session.appliedStack.map((ref) => (
                      <code key={ref}>{ref}</code>
                    ))
                  ) : (
                    <span>
                      No host-acknowledged identity stack is recorded.
                    </span>
                  )}
                </div>
              </div>

              {selected && selectedSlot && (
                <fieldset className="pc-card pc-identities__review-controls">
                  <legend>Switch review</legend>
                  <p>
                    Selected <strong>{selected.id}</strong> for the{" "}
                    <code>{selectedSlot.slot}</code> slot.
                  </p>
                  <RadioGroup
                    label="Delivery"
                    className="pc-identities__delivery"
                    value={delivery}
                    options={DELIVERY_OPTIONS}
                    // Delivery is derived from the slot policy (see the effect
                    // above), so every option is disabled and the group is a
                    // read-only indicator — never a user choice.
                    onChange={() => undefined}
                  >
                    {(option) =>
                      option.value === "inject-now" ? (
                        <span>
                          <strong>Soft update</strong> — keep this context.
                        </span>
                      ) : (
                        <span>
                          <strong>Fresh context</strong> — relaunch with carried
                          work.
                        </span>
                      )
                    }
                  </RadioGroup>
                  <p className="pc-identities__muted">
                    Delivery is derived from the slot policy. Domain and client
                    changes start a fresh context. Work state may carry; prior
                    identity instructions do not. Private memory keeps its
                    existing scope.
                  </p>
                  <div className="pc-identities__actions">
                    <Button
                      variant="accent"
                      onClick={reviewSelected}
                      disabled={busy !== null}
                    >
                      {busy === "preview"
                        ? "Refreshing review…"
                        : "Refresh review"}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={applySelected}
                      disabled={
                        !review || busy !== null || review.changed === false
                      }
                      aria-label="Apply identity"
                    >
                      {busy === "switch" || busy === "attach"
                        ? "Applying…"
                        : "Apply identity"}
                    </Button>
                  </div>
                </fieldset>
              )}

              <div className="pc-card pc-identities__diff">
                <h2>Revision diff</h2>
                {reviewRows.length > 0 ? (
                  <div
                    style={{
                      height: Math.min(360, 44 + reviewRows.length * 38),
                    }}
                  >
                    <RichGrid<DiffRow>
                      columns={DIFF_COLUMNS}
                      rows={reviewRows}
                      getRowId={(row) => row.field}
                      rowMinHeight={34}
                      headerHeight={34}
                    />
                  </div>
                ) : (
                  <p className="pc-identities__muted">
                    {review
                      ? "The selected identity produces no configuration difference."
                      : "Review an identity to compare it with the applied artifact."}
                  </p>
                )}
              </div>

              <details className="pc-card pc-identities__explain">
                <summary>Explain this agent</summary>
                <p className="pc-identities__muted">
                  Derived from the compiled artifact and current policy, not a
                  parallel inventory.
                </p>
                <h3>Effective stack</h3>
                <div className="pc-identities__stack">
                  {surface.session.effectiveStack.map((ref) => (
                    <code key={ref}>{ref}</code>
                  ))}
                </div>
                <h3>Provenance</h3>
                <ul>
                  {(surface.session.artifact?.provenance ?? [])
                    .slice(0, 40)
                    .map((entry) => (
                      <li key={`${entry.path}:${entry.sourceRef}`}>
                        <code>{entry.path}</code> ← {entry.sourceRef}
                      </li>
                    ))}
                  {(surface.session.artifact?.provenance ?? []).length ===
                    0 && <li>No provenance rows were recorded.</li>}
                </ul>
              </details>

              <div className="pc-identities__rollback">
                <Button
                  onClick={rollback}
                  disabled={
                    surface.session.history.length === 0 || busy !== null
                  }
                  aria-label="Roll back identity"
                >
                  {busy === "rollback" ? "Rolling back…" : "Roll back identity"}
                </Button>
                <span className="pc-identities__muted">
                  {surface.session.history.length > 0
                    ? `Restores the previous validated receipt (${shortRevision(surface.session.history[0]?.specificationRevision)}).`
                    : "No prior validated identity revision is available."}
                </span>
              </div>
            </>
          )}
        </section>
      )}

      {!identityQuery.loading && !identityQuery.error && tab === "bindings" && (
        <section
          className="pc-card pc-identities__bindings"
          aria-label="Provider bindings"
        >
          <h2>Provider bindings</h2>
          <div
            className="pc-identities__banner pc-identities__banner--info"
            role="status"
            aria-live="polite"
          >
            <strong>Available in M3.</strong>{" "}
            {surface?.bindings.message ??
              "Existing pot bindings remain unchanged."}
          </div>
          <p>
            Capability-class provider selection and rebind review are
            intentionally unavailable in this milestone. This page will reuse
            conforming provider evidence and existing pot bindings when M3
            lands; no placeholder write is exposed now.
          </p>
        </section>
      )}

      <style>{`
        .pc-identities { display: grid; gap: 16px; min-width: 0; container-type: inline-size; container-name: identities; }
        .pc-identities h1, .pc-identities h2, .pc-identities h3, .pc-identities p { margin-top: 0; }
        .pc-identities__header { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
        .pc-identities__agent-picker { display: grid; gap: 5px; min-width: 210px; color: var(--fg-mute); font-size: 11px; }
        .pc-identities__tabs, .pc-identities__actions, .pc-identities__rollback { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-identities__library { display: grid; grid-template-columns: minmax(250px, .82fr) minmax(340px, 1.18fr); gap: 14px; }
        .pc-identities__composer { grid-column: 1 / -1; display: grid; gap: 10px; }
        .pc-identities__composer > label { display: grid; gap: 4px; }
        .pc-identities__composer input { max-width: 520px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-3); color: var(--fg); }
        .pc-identities__component-options { display: grid; gap: 6px; max-height: 220px; overflow: auto; }
        .pc-identities__component-options label { display: flex; align-items: center; gap: 8px; }
        .pc-identities .pc-card { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-2); }
        .pc-identities__catalog, .pc-identities__detail, .pc-identities__agent { min-width: 0; }
        .pc-identities__search input { box-sizing: border-box; width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-3); color: var(--fg); }
        .pc-identities__chips { display: flex; gap: 5px; flex-wrap: wrap; margin: 10px 0; }
        .pc-identities__chips button { padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--fg-mute); font-size: 11px; }
        .pc-identities__chips button.is-active { border-color: color-mix(in oklab, var(--accent), transparent 35%); background: color-mix(in oklab, var(--accent), transparent 86%); color: var(--fg); }
        .pc-identities__identity-list { display: grid; gap: 7px; max-height: 520px; overflow: auto; }
        .pc-identities__identity { display: flex; justify-content: space-between; gap: 10px; width: 100%; padding: 10px; text-align: left; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); color: var(--fg); }
        .pc-identities__identity.is-selected { border-color: color-mix(in oklab, var(--accent), transparent 35%); background: color-mix(in oklab, var(--accent), var(--bg) 91%); }
        .pc-identities__identity > span:first-child { display: grid; gap: 3px; min-width: 0; }
        .pc-identities__identity small, .pc-identities__muted { color: var(--fg-mute); }
        .pc-identities__identity small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-identities__detail-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
        .pc-identities__pill { display: inline-flex; padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 800; text-transform: uppercase; }
        .pc-identities__pill--applied { background: color-mix(in oklab, var(--good), transparent 82%); color: var(--good); }
        .pc-identities__details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; margin: 12px 0; overflow: hidden; border: 1px solid var(--border); border-radius: 9px; background: var(--border); }
        .pc-identities__details > div { display: grid; gap: 3px; min-width: 0; padding: 9px 10px; background: var(--bg); }
        .pc-identities__details dt { color: var(--fg-mute); font-size: 10px; text-transform: uppercase; }
        .pc-identities__details dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-identities__slot-row, .pc-identities__settings { display: grid; gap: 8px; margin: 14px 0; }
        .pc-identities__slot-row label { display: flex; align-items: center; gap: 8px; }
        .pc-identities__settings { padding-top: 12px; border-top: 1px solid var(--border); }
        .pc-identities__settings p { margin-bottom: 0; color: var(--fg-mute); }
        .pc-identities__empty { display: grid; place-items: center; gap: 5px; min-height: 130px; padding: 18px; text-align: center; color: var(--fg-mute); }
        .pc-identities__banner { padding: 11px 13px; border: 1px solid var(--border); border-radius: 9px; }
        .pc-identities__banner--info { border-color: color-mix(in oklab, var(--accent), transparent 58%); background: color-mix(in oklab, var(--accent), transparent 91%); }
        .pc-identities__banner--warn { border-color: color-mix(in oklab, var(--warn), transparent 55%); background: color-mix(in oklab, var(--warn), transparent 91%); }
        .pc-identities__banner--good { border-color: color-mix(in oklab, var(--good), transparent 55%); background: color-mix(in oklab, var(--good), transparent 91%); }
        .pc-identities__banner--bad { border-color: color-mix(in oklab, var(--bad), transparent 50%); background: color-mix(in oklab, var(--bad), transparent 91%); }
        .pc-identities__agent { display: grid; gap: 12px; }
        .pc-identities__stack { display: flex; gap: 6px; flex-wrap: wrap; }
        .pc-identities__stack code { padding: 4px 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-3); }
        .pc-identities__review-controls { display: grid; gap: 10px; }
        .pc-identities__review-controls legend { padding: 0 6px; font-weight: 700; }
        .pc-identities__delivery { display: grid; gap: 7px; }
        .pc-identities__delivery label { display: flex; align-items: center; gap: 8px; }
        .pc-identities__diff { min-width: 0; overflow: hidden; }
        .pc-identities__explain summary { cursor: pointer; font-weight: 700; }
        .pc-identities__explain ul { max-height: 300px; overflow: auto; }
        .pc-identities__bindings { display: grid; gap: 12px; }
        .pc-identities__unreadable { color: var(--fg-mute); font-size: 12px; }
        @container identities (max-width: 900px) {
          .pc-identities__header { align-items: stretch; flex-direction: column; }
          .pc-identities__library { grid-template-columns: 1fr; }
        }
        @container identities (max-width: 560px) {
          .pc-identities__details { grid-template-columns: 1fr; }
          .pc-identities__tabs .pc-btn { flex: 1 1 auto; }
        }
      `}</style>
    </main>
  );
}
