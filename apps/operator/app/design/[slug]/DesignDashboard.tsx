"use client";

/**
 * Design tab — v0.1.
 *
 * Reads features with `needs_design=true` through @papercusp/sync and
 * groups them by `design_status`. Embeds the registry browser and memo
 * backlog through sync-backed design-phase query names.
 *
 * Plan §6 — apps/operator/content/internal-docs/design/design-phase-plan.mdx.
 *
 * Deliberately self-contained — does not import HarnessDashboard or
 * FeatureList. The shared mode-parameterized FeatureList is deferred
 * until the existing component is refactored without paperclip
 * collision risk.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryState, parseAsString, parseAsStringEnum } from "nuqs";
import type React from "react";
import { useSyncQuery } from "@papercusp/sync";
import type { CompanionListSummary } from "@papercusp/facets";
import { readListMeta } from "@papercusp/operator-core/lib/sync-resolver/list-meta";
import { filterCountLabel, type CountEvidence } from "@/app/harness/filters";
import { useWorkspaceId } from "@/lib/use-workspace-id";
import SketchPane from "./SketchPane";
import RegressionPane from "./RegressionPane";
import DesignEvidencePane from "./DesignEvidencePane";

/** The LIST row (WI-7232) — exactly the three fields the queue renders.
 *  `summary` and the other detail-card-only fields moved to
 *  `designFeatures.detail`: shipping 390 summaries to render at most one cost
 *  81.78% of a 521,715 B payload. */
interface DesignFeature {
  featureId: string;
  title: string | null;
  designStatus: "pending" | "accepted" | "ignored" | null;
}

/** The on-demand single-feature read backing the detail card. */
interface DesignFeatureDetail extends DesignFeature {
  summary: string | null;
  status: string | null;
  needsDesign: boolean;
  designSpecId: string | null;
  discardedDesignWork: boolean;
  updatedTs: number | null;
}

interface RegistryEntry {
  id: string;
  kind: string;
  summary: string;
  inputs?: Array<{ name: string; type: string; required?: boolean }>;
  variants?: string[];
}

interface MemoEntry {
  slug: string;
  title: string;
  status: string;
}

interface DtcgToken {
  id: string;
  type: string;
  value: unknown;
  description: string | null;
  group: string | null;
}

interface DtcgTokenList {
  source: string | null;
  error: string | null;
  count: number;
  tokens: DtcgToken[];
}

type Pane =
  | "features"
  | "memos"
  | "registry"
  | "tokens"
  | "sketch"
  | "regressions"
  | "evidence";

type Bucket = "all" | "pending" | "accepted" | "ignored";

const PANES: Pane[] = [
  "features",
  "memos",
  "registry",
  "tokens",
  "sketch",
  "regressions",
  // Sibling of "regressions", not a replacement: that pane asks whether a
  // surface changed since its baseline, this one whether it matches the design
  // ratified for it (P-008).
  "evidence",
];
const BUCKETS: Bucket[] = ["all", "pending", "accepted", "ignored"];
const DESIGN_FEATURES_PAGE = 100;

type DesignFeatureCounts = Record<Bucket, number>;

/** Page one replaces; cursor pages append idempotently by feature identity. */
export function mergeDesignFeaturePage<T extends { featureId: string }>(
  previous: readonly T[],
  page: readonly T[],
  cursor: string | null,
): T[] {
  if (!cursor) return [...page];
  const byId = new Map(previous.map((row) => [row.featureId, row] as const));
  for (const row of page) byId.set(row.featureId, row);
  return [...byId.values()];
}

/** Exact search-aware bucket counts authored by the companion aggregate. */
export function designFeatureBucketCounts(
  summary: CompanionListSummary | null | undefined,
): DesignFeatureCounts | null {
  const status = summary?.facets.find((facet) => facet.key === "status");
  if (!status) return null;
  const count = (value: Exclude<Bucket, "all">) =>
    status.values.find((entry) => entry.value === value)?.count ?? 0;
  const pending = count("pending");
  const accepted = count("accepted");
  const ignored = count("ignored");
  return {
    all: pending + accepted + ignored,
    pending,
    accepted,
    ignored,
  };
}

export default function DesignDashboard({ slug }: { slug: string }) {
  const workspaceId = useWorkspaceId();
  // Pane + bucket are user-meaningful selectors → URL via nuqs (agents read
  // the URL through ui:get_state; useState would make them invisible).
  const [activePane, setActivePane] = useQueryState(
    "pane",
    parseAsStringEnum<Pane>(PANES).withDefault("features"),
  );
  const [bucket, setBucket] = useQueryState(
    "bucket",
    parseAsStringEnum<Bucket>(BUCKETS).withDefault("all"),
  );
  const [selectedFeatureId, setSelectedFeatureId] = useQueryState(
    "feature",
    parseAsString,
  );
  const [featureSearch, setFeatureSearch] = useQueryState(
    "featureQuery",
    parseAsString.withDefault(""),
  );
  const [registryQuery, setRegistryQuery] = useState("");

  const [featureCursor, setFeatureCursor] = useState<string | null>(null);
  const [loadedFeatures, setLoadedFeatures] = useState<DesignFeature[]>([]);
  const [nextFeatureCursor, setNextFeatureCursor] = useState<string | null>(
    null,
  );
  const [featurePageReady, setFeaturePageReady] = useState(false);
  const sharedFeatureArgs = useMemo(
    () => ({
      harnessSlug: slug,
      workspaceId: workspaceId ?? "default",
      q: featureSearch,
      ...(bucket === "all" ? {} : { statuses: [bucket] }),
    }),
    [slug, workspaceId, featureSearch, bucket],
  );

  useEffect(() => {
    setFeatureCursor(null);
    setLoadedFeatures([]);
    setNextFeatureCursor(null);
    setFeaturePageReady(false);
  }, [slug, workspaceId, featureSearch, bucket]);

  const featuresQ = useSyncQuery<DesignFeature>({
    queryName: "designFeatures.byHarness",
    args: {
      ...sharedFeatureArgs,
      limit: DESIGN_FEATURES_PAGE,
      ...(featureCursor ? { cursor: featureCursor } : {}),
    },
    enabled: Boolean(slug),
  });
  const featuresSummaryQ = useSyncQuery<CompanionListSummary>({
    queryName: "designFeatures.summary",
    args: sharedFeatureArgs,
    enabled: Boolean(slug),
  });

  useEffect(() => {
    if (featuresQ.loading || featuresQ.fetching || !featuresQ.data) return;
    setLoadedFeatures((previous) =>
      mergeDesignFeaturePage(previous, featuresQ.data!, featureCursor),
    );
    const meta = readListMeta(featuresQ.data);
    setNextFeatureCursor(
      typeof meta?.nextCursor === "string" ? meta.nextCursor : null,
    );
    setFeaturePageReady(true);
  }, [featuresQ.data, featuresQ.loading, featuresQ.fetching, featureCursor]);

  const memosQ = useSyncQuery<MemoEntry>({
    queryName: "designMemos.list",
    args: { status: "any" },
    enabled: activePane === "memos",
  });

  const registryQ = useSyncQuery<RegistryEntry>({
    queryName: "designRegistry.search",
    args: { ecosystem: "react-tailwind", query: registryQuery },
    enabled: activePane === "registry",
  });

  const tokensQ = useSyncQuery<DtcgToken>({
    queryName: "designTokens.list",
    enabled: activePane === "tokens",
  });

  const features = featurePageReady ? loadedFeatures : [];
  const tokenRows = tokensQ.data ?? [];
  const featuresSummary = featuresSummaryQ.data?.[0] ?? null;
  const counts = useMemo(
    () => designFeatureBucketCounts(featuresSummary),
    [featuresSummary],
  );
  const pairedFetching = Boolean(
    featuresQ.loading ||
    featuresQ.fetching ||
    featuresSummaryQ.loading ||
    featuresSummaryQ.fetching,
  );
  const countError = Boolean(featuresQ.error || featuresSummaryQ.error);
  const countEvidence = useCallback(
    (count: number | undefined): CountEvidence => {
      if (countError) return { kind: "unknown", reason: "failed" };
      if (pairedFetching) return { kind: "unknown", reason: "updating" };
      if (count === undefined) return { kind: "unknown", reason: "loading" };
      return {
        kind: "corpus",
        count,
        population: featureSearch.trim()
          ? "the Design feature queue matching the current search"
          : "the Design feature queue",
      };
    },
    [countError, pairedFetching, featureSearch],
  );
  const countLabels = useMemo(
    () =>
      Object.fromEntries(
        BUCKETS.map((entry) => [
          entry,
          filterCountLabel(countEvidence(counts?.[entry]), "feature"),
        ]),
      ) as Record<Bucket, ReturnType<typeof filterCountLabel>>,
    [countEvidence, counts],
  );
  const loadedCountLabel = useMemo(() => {
    if (countError) {
      return filterCountLabel({ kind: "unknown", reason: "failed" }, "feature");
    }
    if (pairedFetching) {
      return filterCountLabel(
        { kind: "unknown", reason: "updating" },
        "feature",
      );
    }
    if (!featurePageReady || !featuresSummary) {
      return filterCountLabel(
        { kind: "unknown", reason: "loading" },
        "feature",
      );
    }
    return filterCountLabel(
      {
        kind: "window",
        count: features.length,
        window: "loaded server-filtered Design page",
        corpusTotal: featuresSummary.matched,
      },
      "feature",
    );
  }, [
    countError,
    pairedFetching,
    featurePageReady,
    featuresSummary,
    features.length,
  ]);
  const loadMoreFeatures = useCallback(() => {
    if (nextFeatureCursor) setFeatureCursor(nextFeatureCursor);
  }, [nextFeatureCursor]);

  // The list row still gates whether the detail card shows at all (a feature the
  // active bucket filters out stays hidden, as before) AND supplies the three
  // fields it shares with the detail read, so the header renders with no flicker.
  const selectedListRow = useMemo(
    () => features.find((f) => f.featureId === selectedFeatureId) ?? null,
    [features, selectedFeatureId],
  );

  // WI-7232: the heavy fields (summary, status, designSpecId, discardedDesignWork)
  // are fetched for the ONE selected feature instead of all 390.
  const featureDetailQ = useSyncQuery<DesignFeatureDetail>({
    queryName: "designFeatures.detail",
    args: {
      harnessSlug: slug,
      workspaceId: workspaceId ?? "default",
      featureId: selectedFeatureId ?? "",
    },
    enabled: Boolean(slug && selectedListRow),
  });
  const selectedDetail = featureDetailQ.data?.[0] ?? null;

  return (
    <div className="d-root pc-animate-in pc-animate-in--fast">
      <header className="d-header">
        <div className="d-titleblock">
          <div className="d-eyebrow">design workspace</div>
          <h1 className="d-title">
            Design <span>· {slug}</span>
          </h1>
          <p className="d-subtitle">
            IR specs, registry, tokens, sketches, and visual regression review.
          </p>
        </div>
        <div className="d-metrics" aria-label="Design queue summary">
          <Metric label="features" count={countLabels.all} tone="info" />
          <Metric label="pending" count={countLabels.pending} tone="warn" />
          <Metric label="accepted" count={countLabels.accepted} tone="good" />
        </div>
        <nav className="d-pane-tabs" aria-label="Design workspace panes">
          {PANES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setActivePane(p)}
              className="d-pane-tab"
              data-active={activePane === p}
              aria-pressed={activePane === p}
            >
              {p}
            </button>
          ))}
        </nav>
      </header>

      <div className="d-shell">
        <aside className="d-rail" aria-label="Design feature queue">
          <div className="d-rail-head">
            <div>
              <div className="d-section-label">Feature queue</div>
              <div className="d-rail-subtitle">Needs design handoff</div>
            </div>
            <span
              className="d-chip d-chip--info"
              data-count-evidence={loadedCountLabel.evidence}
              aria-label={loadedCountLabel.ariaLabel}
            >
              {loadedCountLabel.title}
            </span>
          </div>
          <div className="d-feature-search">
            <input
              type="search"
              value={featureSearch}
              onChange={(event) => void setFeatureSearch(event.target.value)}
              placeholder="Search the full Design queue…"
              aria-label="Search design features"
              className="d-search-input d-feature-search-input"
            />
          </div>
          <div
            className="d-buckets"
            role="group"
            aria-label="Filter design features by status"
          >
            {BUCKETS.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBucket(b)}
                className="d-bucket"
                data-active={bucket === b}
                aria-pressed={bucket === b}
                data-count-evidence={countLabels[b].evidence}
              >
                <span>{b}</span>
                <strong aria-label={countLabels[b].ariaLabel}>
                  {countLabels[b].title}
                </strong>
              </button>
            ))}
          </div>
          <ul className="d-feature-list">
            {featuresQ.loading && !featurePageReady ? (
              <StateRow tone="info">Loading design features…</StateRow>
            ) : featuresQ.error ? (
              <StateRow tone="bad">
                Failed to load: {featuresQ.error.message}
              </StateRow>
            ) : features.length === 0 ? (
              <StateRow tone="muted">
                No design features match the current search and status filter.
              </StateRow>
            ) : (
              <>
                {features.map((f) => (
                  <li key={f.featureId}>
                    <button
                      type="button"
                      onClick={() => setSelectedFeatureId(f.featureId)}
                      className="d-feature-row"
                      data-active={selectedFeatureId === f.featureId}
                    >
                      <span className="d-feature-title">
                        {f.title || f.featureId}
                      </span>
                      <span className="d-feature-meta">
                        <code>{f.featureId}</code>
                        <span className={designStatusClass(f.designStatus)}>
                          {f.designStatus ?? "pending"}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {nextFeatureCursor && (
                  <li className="d-feature-load-more-row">
                    <button
                      type="button"
                      className="d-feature-load-more"
                      onClick={loadMoreFeatures}
                      disabled={featuresQ.fetching}
                    >
                      {featuresQ.fetching
                        ? "Loading more…"
                        : "Load more design features"}
                    </button>
                  </li>
                )}
              </>
            )}
          </ul>
        </aside>

        <main className="d-content">
          {activePane === "features" && (
            <FeatureDetailPane
              listRow={selectedListRow}
              detail={selectedDetail}
              detailLoading={featureDetailQ.loading}
              counts={countLabels}
            />
          )}
          {activePane === "memos" && (
            <MemosPane
              memos={memosQ.data ?? []}
              loading={memosQ.loading}
              error={memosQ.error ? memosQ.error.message : null}
            />
          )}
          {activePane === "registry" && (
            <RegistryPane
              entries={registryQ.data ?? []}
              loading={registryQ.loading}
              error={registryQ.error ? registryQ.error.message : null}
              query={registryQuery}
              onQueryChange={setRegistryQuery}
            />
          )}
          {activePane === "tokens" && (
            <TokensPane
              data={
                {
                  source: "design/tokens/base.json",
                  error: null,
                  count: tokenRows.length,
                  tokens: tokenRows,
                } satisfies DtcgTokenList
              }
              loading={tokensQ.loading}
              error={tokensQ.error ? tokensQ.error.message : null}
            />
          )}
          {activePane === "sketch" && (
            <SketchPane slug={slug} featureId={selectedFeatureId} />
          )}
          {activePane === "regressions" && <RegressionPane />}
          {activePane === "evidence" && <DesignEvidencePane />}
        </main>
      </div>
    </div>
  );
}

function Metric({
  label,
  count,
  tone,
}: {
  label: string;
  count: ReturnType<typeof filterCountLabel>;
  tone: "info" | "warn" | "good";
}) {
  return (
    <div
      className={`d-metric d-metric--${tone}`}
      data-count-evidence={count.evidence}
      aria-label={`${label}: ${count.ariaLabel}`}
    >
      <span>{label}</span>
      <strong>{count.title}</strong>
    </div>
  );
}

function StateRow({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "info" | "bad" | "muted";
}) {
  return <li className={`d-state-row d-state-row--${tone}`}>{children}</li>;
}

function designStatusClass(
  s: "pending" | "accepted" | "ignored" | null,
): string {
  return `d-chip d-chip--${s ?? "pending"}`;
}

function memoStatusChipClass(status: string): string {
  if (status === "addressed") return "d-chip d-chip--accepted";
  if (status === "wontfix") return "d-chip d-chip--ignored";
  return "d-chip d-chip--pending";
}

/** WI-7232: the shared fields (title / featureId / designStatus) come from the
 *  LIST row so the header paints immediately; only the heavy detail-only fields
 *  wait on `designFeatures.detail`. */
function FeatureDetailPane({
  listRow,
  detail,
  detailLoading,
  counts,
}: {
  listRow: DesignFeature | null;
  detail: DesignFeatureDetail | null;
  detailLoading: boolean;
  counts: Record<Bucket, ReturnType<typeof filterCountLabel>>;
}) {
  const feature = listRow;
  if (!feature) {
    return (
      <section className="d-empty-card">
        <div className="d-empty-icon">◇</div>
        <h2>Pick a feature to inspect</h2>
        <p>
          Choose a queue item on the left to review its design status, linked
          design spec, discarded work flag, and implementation summary.
        </p>
        <div className="d-empty-chips">
          <span className="d-chip d-chip--info">{counts.all.title} total</span>
          <span className="d-chip d-chip--pending">
            {counts.pending.title} pending
          </span>
          <span className="d-chip d-chip--accepted">
            {counts.accepted.title} accepted
          </span>
        </div>
      </section>
    );
  }
  return (
    <article className="d-detail-card">
      <header className="d-card-head">
        <div>
          <div className="d-section-label">Selected feature</div>
          <h2>{feature.title || feature.featureId}</h2>
        </div>
        <span className={designStatusClass(feature.designStatus)}>
          {feature.designStatus ?? "pending"}
        </span>
      </header>
      <div className="d-kv-grid">
        <div>
          <dt>Feature ID</dt>
          <dd>
            <code>{feature.featureId}</code>
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{detail ? (detail.status ?? "—") : "…"}</dd>
        </div>
        <div>
          <dt>Design spec</dt>
          <dd>
            <code>{detail ? (detail.designSpecId ?? "—") : "…"}</code>
          </dd>
        </div>
        <div>
          <dt>Discarded work</dt>
          <dd>{detail ? (detail.discardedDesignWork ? "yes" : "no") : "…"}</dd>
        </div>
      </div>
      {detailLoading && !detail && (
        <section className="d-summary-card">
          <h3>Summary</h3>
          <p>Loading…</p>
        </section>
      )}
      {detail?.summary && (
        <section className="d-summary-card">
          <h3>Summary</h3>
          <p>{detail.summary}</p>
        </section>
      )}
    </article>
  );
}

function MemosPane({
  memos,
  loading,
  error,
}: {
  memos: MemoEntry[];
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <PanelState>Loading design memos…</PanelState>;
  if (error) return <PanelState tone="bad">Failed: {error}</PanelState>;
  if (memos.length === 0) return <PanelState>No memos yet.</PanelState>;
  return (
    <section className="d-pane-card">
      <header className="d-card-head">
        <div>
          <div className="d-section-label">Memo backlog</div>
          <h2>Design memos</h2>
        </div>
        <span className="d-chip d-chip--info">{memos.length}</span>
      </header>
      <ul className="d-list-stack">
        {memos.map((m) => (
          <li key={m.slug} className="d-memo-row">
            <a href={`/docs/design/${m.slug}`} target="_blank" rel="noreferrer">
              {m.title}
            </a>
            <span className={memoStatusChipClass(m.status)}>{m.status}</span>
            <code>{m.slug}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TokensPane({
  data,
  loading,
  error,
}: {
  data: {
    source: string | null;
    error: string | null;
    count: number;
    tokens: DtcgToken[];
  } | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <PanelState>Loading tokens…</PanelState>;
  if (error) return <PanelState tone="bad">Failed: {error}</PanelState>;
  if (!data) return <PanelState>No tokens loaded.</PanelState>;
  if (data.error)
    return <PanelState tone="bad">Token store error: {data.error}</PanelState>;
  if (data.tokens.length === 0) {
    return (
      <PanelState>
        No DTCG tokens found at workspace root{" "}
        <code>design/tokens/base.json</code>.
      </PanelState>
    );
  }

  const groups = new Map<string, DtcgToken[]>();
  for (const t of data.tokens) {
    const top = t.id.split(".")[0] || "misc";
    const arr = groups.get(top) ?? [];
    arr.push(t);
    groups.set(top, arr);
  }

  return (
    <section className="d-pane-card">
      <header className="d-card-head">
        <div>
          <div className="d-section-label">Token source</div>
          <h2>Tokens</h2>
        </div>
        <span className="d-chip d-chip--info">{data.count} DTCG</span>
        {data.source && <code className="d-source-chip">{data.source}</code>}
      </header>
      {[...groups.entries()].map(([group, tokens]) => (
        <section key={group} className="d-token-group">
          <h3>
            {group} <span>({tokens.length})</span>
          </h3>
          <ul className="d-token-grid">
            {tokens.map((t) => (
              <li key={t.id} className="d-token-card">
                <TokenSwatch token={t} />
                <div>
                  <code>{t.id}</code>
                  <span>
                    {String(t.value)} · {t.type}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function TokenSwatch({ token }: { token: DtcgToken }) {
  if (token.type === "color" && typeof token.value === "string") {
    return (
      <span
        className="d-token-swatch"
        title={String(token.value)}
        style={{ background: token.value }}
      />
    );
  }
  if (token.type === "dimension" && typeof token.value === "string") {
    const px = parseFloat(token.value);
    if (Number.isFinite(px) && px > 0 && px < 80) {
      return (
        <span className="d-token-swatch d-token-swatch--dimension" aria-hidden>
          <span style={{ width: px, height: px }} />
        </span>
      );
    }
  }
  return (
    <span className="d-token-swatch d-token-swatch--type">
      {token.type.slice(0, 3)}
    </span>
  );
}

function RegistryPane({
  entries,
  loading,
  error,
  query,
  onQueryChange,
}: {
  entries: RegistryEntry[];
  loading: boolean;
  error: string | null;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  return (
    <section className="d-pane-card">
      <header className="d-card-head d-card-head--stacked">
        <div>
          <div className="d-section-label">Component registry</div>
          <h2>React + Tailwind primitives</h2>
        </div>
        <span className="d-chip d-chip--info">{entries.length} matches</span>
      </header>
      <input
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Filter by id, summary, or input name…"
        className="d-search-input"
      />
      {loading ? (
        <PanelState>Loading registry…</PanelState>
      ) : error ? (
        <PanelState tone="bad">Failed: {error}</PanelState>
      ) : entries.length === 0 ? (
        <PanelState>No matches.</PanelState>
      ) : (
        <ul className="d-list-stack d-registry-list">
          {entries.map((e) => (
            <li key={e.id} className="d-registry-row">
              <div className="d-registry-title">
                <code>{e.id}</code>
                <span className="d-chip d-chip--info">{e.kind}</span>
              </div>
              <p>{e.summary}</p>
              {e.inputs && e.inputs.length > 0 && (
                <div className="d-registry-meta">
                  inputs:{" "}
                  {e.inputs
                    .map((i) => `${i.name}${i.required ? "*" : ""}: ${i.type}`)
                    .join(", ")}
                </div>
              )}
              {e.variants && e.variants.length > 0 && (
                <div className="d-registry-meta">
                  variants: {e.variants.join(" · ")}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PanelState({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "bad";
}) {
  return (
    <div className={`d-panel-state d-panel-state--${tone}`}>{children}</div>
  );
}
