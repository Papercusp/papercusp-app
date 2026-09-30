"use client";

/**
 * 03 Operate — the managed host fleet.
 *
 * The pre-redesign page rendered each host as a 400–900px card carrying every
 * telemetry panel at once, so four hosts were four screens of scrolling and
 * drift was something you computed yourself from three separate pills. Here:
 *
 *  - a DRIFT BANNER names the diverging hosts and how long they have diverged,
 *    because drift is the reason this page exists;
 *  - hosts are ROWS at row scale, so the fleet is legible at a glance;
 *  - each row carries ONE state chip, which states the divergence
 *    (`stopped → running`) instead of implying it;
 *  - the selected row expands IN PLACE with tabs, replacing the single
 *    `<details>` that used to dump every panel at once;
 *  - lifecycle actions are contextual (Start XOR Stop) plus an overflow menu,
 *    instead of five buttons of which three were always disabled.
 *
 * Unchanged: per-key busy tracking, the audit-export link, the destroy route
 * into the disposition modal, and the `HostedWorkspaceSession` mount whenever
 * the host advertises a connector.
 */

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  MoreHorizontal,
  Play,
  RefreshCw,
  Server,
  Square,
} from "lucide-react";
import { Button } from "@/app/harness/Button";
import { HostedDesktopConnection } from "./HostedDesktopConnection";
import {
  focusSafely,
  SignalList,
  StageHeader,
  useFocusLifecycle,
} from "./stage-primitives";
import {
  driftingWorkspaces,
  formatElapsed,
  formatMoney,
  formatSignal,
  formatTimestamp,
  hostStateChip,
  lifecycleActionPlan,
  signalTone,
  type LifecycleAction,
  type WorkspaceHostConnectionRow,
  type WorkspaceHostControlRow,
} from "./workspace-view-model";
import styles from "./cloud-workspaces.module.css";

export const HOST_TABS = [
  "overview",
  "resources",
  "logs",
  "cost",
  "desktops",
] as const;
export type HostTab = (typeof HOST_TABS)[number];

export function isHostTab(value: unknown): value is HostTab {
  return typeof value === "string" && HOST_TABS.includes(value as HostTab);
}

const TAB_LABELS: Record<HostTab, string> = {
  overview: "Overview",
  resources: "Resources",
  logs: "Logs",
  cost: "Cost",
  desktops: "Desktops",
};

export function OperateStage({
  workspaces,
  connections,
  busyKeys,
  selectedHostId,
  activeTab,
  onSelectHost,
  onSelectTab,
  onLifecycle,
  onDestroy,
  onGoToConfigure,
  now,
}: {
  workspaces: readonly WorkspaceHostControlRow[];
  /** Only its emptiness matters here: it decides whether the empty state can
   *  offer a route onward to Configure. */
  connections: readonly WorkspaceHostConnectionRow[];
  busyKeys: ReadonlySet<string>;
  selectedHostId: string | null;
  activeTab: HostTab;
  onSelectHost: (hostId: string | null) => void;
  onSelectTab: (tab: HostTab) => void;
  onLifecycle: (
    workspace: WorkspaceHostControlRow,
    action: Exclude<LifecycleAction, "destroy">,
  ) => void;
  onDestroy: (workspaceId: string) => void;
  onGoToConfigure: () => void;
  now?: number;
}) {
  const drifting = driftingWorkspaces(workspaces);

  if (workspaces.length === 0) {
    return (
      <section
        className={styles.stage}
        aria-labelledby="operate-stage-heading"
        data-stage="operate"
      >
        <StageHeader
          id="operate-stage-heading"
          step="03"
          eyebrow="Operate"
          title="Managed workspaces"
          description="Actions set desired state; reconciliation updates observed state and the durable progress stream."
        />
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>
            <Server size={22} aria-hidden="true" />
          </span>
          <h3>No cloud workspaces yet</h3>
          <p>
            Provisioning runs will appear here with their operation receipt and
            recoverability posture.
          </p>
          {connections.length > 0 ? (
            <Button variant="ghost" onClick={onGoToConfigure}>
              Configure the first workspace
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section
      className={styles.stage}
      aria-labelledby="operate-stage-heading"
      data-stage="operate"
    >
      <StageHeader
        id="operate-stage-heading"
        step="03"
        eyebrow="Operate"
        title="Managed workspaces"
        description="Actions set desired state; reconciliation updates observed state and the durable progress stream."
      />

      {drifting.length > 0 ? (
        <div className={styles.driftBanner} role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>
              {drifting.length === 1
                ? "1 host has diverged from its desired state"
                : `${drifting.length} hosts have diverged from their desired state`}
            </strong>
            <ul className={styles.driftList}>
              {drifting.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    type="button"
                    className={styles.driftLink}
                    onClick={() => onSelectHost(workspace.id)}
                  >
                    {workspace.name}
                  </button>
                  <span>
                    {workspace.observedState} → {workspace.desiredState} ·
                    diverged for {formatElapsed(workspace.observedAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <ul className={styles.hostRows} aria-label="Managed workspace hosts">
        {workspaces.map((workspace) => (
          <HostRow
            key={workspace.id}
            workspace={workspace}
            busyKeys={busyKeys}
            expanded={selectedHostId === workspace.id}
            activeTab={activeTab}
            onSelectHost={onSelectHost}
            onSelectTab={onSelectTab}
            onLifecycle={onLifecycle}
            onDestroy={onDestroy}
          />
        ))}
      </ul>
    </section>
  );
}

function HostRow({
  workspace,
  busyKeys,
  expanded,
  activeTab,
  onSelectHost,
  onSelectTab,
  onLifecycle,
  onDestroy,
}: {
  workspace: WorkspaceHostControlRow;
  busyKeys: ReadonlySet<string>;
  expanded: boolean;
  activeTab: HostTab;
  onSelectHost: (hostId: string | null) => void;
  onSelectTab: (tab: HostTab) => void;
  onLifecycle: (
    workspace: WorkspaceHostControlRow,
    action: Exclude<LifecycleAction, "destroy">,
  ) => void;
  onDestroy: (workspaceId: string) => void;
}) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const skipRestoreFocusRef = useRef(false);
  const menuItemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const tabButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const chip = hostStateChip(workspace);
  const plan = lifecycleActionPlan(workspace);
  const panelId = `host-panel-${workspace.id}`;

  const onTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % HOST_TABS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + HOST_TABS.length) % HOST_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = HOST_TABS.length - 1;
    }
    if (nextIndex === null) return;

    event.preventDefault();
    onSelectTab(HOST_TABS[nextIndex]);
    tabButtonsRef.current[nextIndex]?.focus();
  };

  useFocusLifecycle({
    open: overflowOpen,
    onOpenFocus: () =>
      menuItemsRef.current.find((item) => item && !item.disabled),
    onCloseFocus: () => {
      if (skipRestoreFocusRef.current) {
        skipRestoreFocusRef.current = false;
        return null;
      }
      return overflowTriggerRef.current;
    },
  });

  const onMenuKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === "Tab") {
      /* Let the browser move focus to the next document control; only close
         the popup so it cannot remain visually open after focus leaves. */
      skipRestoreFocusRef.current = true;
      setOverflowOpen(false);
      return;
    }

    const enabledIndices = plan.overflow.reduce<number[]>(
      (indices, action, actionIndex) => {
        if (
          action.enabled &&
          !busyKeys.has(`${action.action}:${workspace.id}`)
        ) {
          indices.push(actionIndex);
        }
        return indices;
      },
      [],
    );
    if (enabledIndices.length === 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      const position = enabledIndices.indexOf(index);
      nextIndex =
        enabledIndices[
          (position < 0 ? 0 : position + 1) % enabledIndices.length
        ];
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      const position = enabledIndices.indexOf(index);
      nextIndex =
        enabledIndices[
          (position < 0
            ? enabledIndices.length - 1
            : position - 1 + enabledIndices.length) % enabledIndices.length
        ];
    } else if (event.key === "Home") {
      nextIndex = enabledIndices[0];
    } else if (event.key === "End") {
      nextIndex = enabledIndices[enabledIndices.length - 1];
    }
    if (nextIndex === null || nextIndex === undefined) return;

    event.preventDefault();
    menuItemsRef.current[nextIndex]?.focus();
  };

  useEffect(() => {
    if (!overflowOpen) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!overflowRef.current?.contains(event.target as Node)) {
        /* Pointer dismissal leaves focus where the pointer chose. */
        skipRestoreFocusRef.current = true;
        setOverflowOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /*
       * Closing unmounts the menu, and with it whichever item holds focus —
       * the browser's fallback for a removed active element is <body>, i.e. a
       * keyboard user silently dropped to the start of the document (WCAG
       * 2.4.3). The menu-button pattern owes them the trigger back. Pointer
       * dismissal below deliberately does NOT restore, because there focus is
       * already following the pointer somewhere the user chose.
       */
      setOverflowOpen(false);
    };
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [overflowOpen]);

  return (
    <li className={styles.hostRowItem}>
      <div
        className={styles.hostRow}
        data-expanded={expanded ? "true" : "false"}
      >
        <button
          type="button"
          className={styles.hostRowMain}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => onSelectHost(expanded ? null : workspace.id)}
        >
          <span className={styles.hostIcon} aria-hidden="true">
            <Server size={16} />
          </span>
          <span className={styles.hostIdentity}>
            <strong>{workspace.name}</strong>
            <span>
              {workspace.target.toUpperCase()} · {workspace.region} ·{" "}
              {workspace.size} · {workspace.diskGiB} GiB
            </span>
          </span>
          {/*
           * ONE chip. It reads `stopped → running` only when the two states
           * actually diverge, so the common aligned case stays quiet.
           */}
          <span
            className={`${styles.stateChip} ${styles[chip.tone]}`}
            data-drifting={chip.drifting ? "true" : "false"}
          >
            {chip.label}
          </span>
          <span className={styles.hostCost}>
            {formatMoney(workspace.estimatedMonthlyUsd)} / mo
          </span>
        </button>

        <div
          className={styles.hostRowActions}
          aria-label={`Lifecycle actions for ${workspace.name}`}
        >
          {plan.primary ? (
            <Button
              variant="ghost"
              disabled={
                !plan.primary.enabled ||
                busyKeys.has(`${plan.primary.action}:${workspace.id}`)
              }
              onClick={() =>
                plan.primary &&
                onLifecycle(
                  workspace,
                  plan.primary.action as Exclude<LifecycleAction, "destroy">,
                )
              }
            >
              {plan.primary.action === "stop" ? (
                <Square size={13} aria-hidden="true" />
              ) : (
                <Play size={14} aria-hidden="true" />
              )}{" "}
              {plan.primary.label}
            </Button>
          ) : null}

          <div className={styles.overflow} ref={overflowRef}>
            <Button
              ref={overflowTriggerRef}
              variant="ghost"
              aria-label={`More actions for ${workspace.name}`}
              aria-expanded={overflowOpen}
              aria-haspopup="menu"
              onClick={() => {
                skipRestoreFocusRef.current = false;
                setOverflowOpen((open) => !open);
              }}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </Button>
            {overflowOpen ? (
              <div
                className={styles.overflowMenu}
                role="menu"
                aria-orientation="vertical"
                aria-label={`More actions for ${workspace.name}`}
              >
                {plan.overflow.map((action, index) => (
                  <button
                    key={action.action}
                    type="button"
                    role="menuitem"
                    className={styles.overflowItem}
                    ref={(node) => {
                      menuItemsRef.current[index] = node;
                    }}
                    data-destructive={
                      action.action === "destroy" ? "true" : "false"
                    }
                    disabled={
                      !action.enabled ||
                      busyKeys.has(`${action.action}:${workspace.id}`)
                    }
                    onKeyDown={(event) => onMenuKeyDown(event, index)}
                    onClick={() => {
                      /*
                       * Same unmount, same drop: activating an item removes
                       * the button that was clicked. Restore first, then
                       * dispatch — the destroy route opens a dialog, which is
                       * free to take focus from the trigger afterwards.
                       */
                      setOverflowOpen(false);
                      /* Keep focus on the trigger before a destroy dialog or
                         lifecycle mutation takes over; the shared lifecycle
                         hook also covers state-driven close paths. */
                      focusSafely(overflowTriggerRef.current);
                      if (action.action === "destroy") {
                        onDestroy(workspace.id);
                        return;
                      }
                      onLifecycle(
                        workspace,
                        action.action as Exclude<LifecycleAction, "destroy">,
                      );
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {expanded ? (
        <div className={styles.hostPanel} id={panelId}>
          <div
            className={styles.hostTabs}
            role="tablist"
            aria-label={`Detail for ${workspace.name}`}
          >
            {HOST_TABS.map((tab, index) => (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`${panelId}-tab-${tab}`}
                aria-selected={activeTab === tab}
                aria-controls={`${panelId}-${tab}`}
                tabIndex={activeTab === tab ? 0 : -1}
                className={styles.hostTab}
                ref={(node) => {
                  tabButtonsRef.current[index] = node;
                }}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                onClick={() => onSelectTab(tab)}
              >
                {TAB_LABELS[tab]}
                {tab === "resources" ? (
                  <small>{workspace.resources?.length ?? 0}</small>
                ) : null}
                {tab === "logs" ? (
                  <small>{workspace.logs?.length ?? 0}</small>
                ) : null}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`${panelId}-${activeTab}`}
            aria-labelledby={`${panelId}-tab-${activeTab}`}
            className={styles.hostTabPanel}
          >
            {activeTab === "overview" ? (
              <OverviewTab workspace={workspace} />
            ) : null}
            {activeTab === "resources" ? (
              <ResourcesTab workspace={workspace} />
            ) : null}
            {activeTab === "logs" ? <LogsTab workspace={workspace} /> : null}
            {activeTab === "cost" ? <CostTab workspace={workspace} /> : null}
            <HostedDesktopConnection
              workspace={workspace}
              showDesktop={activeTab === "desktops"}
            />
          </div>

          <div className={styles.hostPanelFooter}>
            <Button asChild variant="ghost">
              <a
                href={`/api/workspace-hosts/${encodeURIComponent(workspace.id)}/audit`}
                download
              >
                <Download size={14} aria-hidden="true" /> Audit export
              </a>
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function OverviewTab({ workspace }: { workspace: WorkspaceHostControlRow }) {
  return (
    <div className={styles.tabStack}>
      <dl className={styles.hostFacts}>
        <div>
          <dt>Resource</dt>
          <dd>{workspace.providerResourceId ?? "pending allocation"}</dd>
        </div>
        <div>
          <dt>Endpoint</dt>
          <dd>{workspace.endpoint ?? "not exposed"}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{workspace.scopeLabel}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{workspace.network}</dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>{formatTimestamp(workspace.observedAt)}</dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>
            <span
              className={`${styles.badge} ${styles[signalTone(workspace.health?.status ?? "unknown")]}`}
            >
              {workspace.health?.status ?? "not attested"}
            </span>
          </dd>
        </div>
      </dl>

      <div className={styles.recoverability}>
        {workspace.recoverability.kind === "none" ? (
          <AlertTriangle size={16} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={16} aria-hidden="true" />
        )}
        <div>
          <strong>Recoverability · {workspace.recoverability.kind}</strong>
          <span>
            {workspace.recoverability.label}
            {workspace.recoverability.updatedAt
              ? ` · ${formatTimestamp(workspace.recoverability.updatedAt)}`
              : ""}
          </span>
        </div>
      </div>

      {workspace.operation ? (
        <div className={styles.operation} aria-live="polite">
          <div className={styles.operationHeader}>
            <span>
              {workspace.operation.action} · {workspace.operation.message} ·{" "}
              <code>{workspace.operation.id}</code>
            </span>
            <strong>{workspace.operation.percent}%</strong>
          </div>
          <progress max={100} value={workspace.operation.percent}>
            {workspace.operation.percent}%
          </progress>
          {workspace.operation.request != null ||
          workspace.operation.error != null ? (
            <div className={styles.operationPayloads}>
              {workspace.operation.request != null ? (
                <div>
                  <strong>Redacted request</strong>
                  <code>{formatSignal(workspace.operation.request)}</code>
                </div>
              ) : null}
              {workspace.operation.error != null ? (
                <div>
                  <strong>Operation error</strong>
                  <code>{formatSignal(workspace.operation.error)}</code>
                </div>
              ) : null}
            </div>
          ) : null}
          <ol
            className={styles.eventStream}
            aria-label={`Progress for ${workspace.name}`}
          >
            {workspace.operation.events.map((event) => (
              <li key={event.id}>
                <span
                  className={`${styles.eventDot} ${styles[signalTone(event.level ?? event.status)]}`}
                  aria-hidden="true"
                />
                <time dateTime={event.ts}>{formatTimestamp(event.ts)}</time>
                <strong>{event.phase}</strong>
                <span>
                  {event.message}
                  <small>
                    {event.source ?? "controller"} · {event.level ?? "info"}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <section
        className={styles.telemetryPanel}
        aria-label={`Drift and connectivity for ${workspace.name}`}
      >
        <div className={styles.telemetryHeading}>
          <h4>Drift &amp; connectivity</h4>
          <span>
            attested {formatTimestamp(workspace.health?.attestedAt)} · bootstrap{" "}
            {workspace.health?.bootstrapVersion ?? "unknown"}
          </span>
        </div>
        <h5>Tunnel status</h5>
        <code className={styles.signalCode}>
          {formatSignal(workspace.tunnel ?? {})}
        </code>
        <h5>Version drift</h5>
        <SignalList
          items={workspace.versionDrift}
          empty="No version drift recorded."
        />
        <h5>Health checks</h5>
        <SignalList
          items={workspace.health?.checks}
          empty="No health checks recorded."
        />
      </section>
    </div>
  );
}

function ResourcesTab({ workspace }: { workspace: WorkspaceHostControlRow }) {
  if (!workspace.resources?.length) {
    return (
      <p className={styles.telemetryEmpty}>
        No provider resource checkpoints recorded.
      </p>
    );
  }
  return (
    <ul className={styles.resourceList}>
      {workspace.resources.map((resource) => (
        <li key={resource.logicalKey}>
          <div>
            <strong>{resource.logicalKey}</strong>
            <span
              className={`${styles.badge} ${styles[signalTone(resource.state)]}`}
            >
              {resource.state}
            </span>
          </div>
          <code>{resource.providerId ?? "provider id pending"}</code>
          <small>
            {resource.kind ?? "resource"} · attempts {resource.attempts}
            {resource.providerRequestId
              ? ` · request ${resource.providerRequestId}`
              : ""}
          </small>
          {resource.error != null ? (
            <em>{formatSignal(resource.error)}</em>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LogsTab({ workspace }: { workspace: WorkspaceHostControlRow }) {
  if (!workspace.logs?.length) {
    return (
      <p className={styles.telemetryEmpty}>
        No cloud-init, systemd, or controller logs recorded.
      </p>
    );
  }
  return (
    <ol className={styles.logList}>
      {workspace.logs.map((log) => (
        <li key={log.id}>
          <time dateTime={log.observedAt}>
            {formatTimestamp(log.observedAt)}
          </time>
          <span className={`${styles.badge} ${styles[signalTone(log.level)]}`}>
            {log.level}
          </span>
          <strong>
            {log.stream}
            {log.unit ? ` · ${log.unit}` : ""}
          </strong>
          <code>{log.message}</code>
        </li>
      ))}
    </ol>
  );
}

function CostTab({ workspace }: { workspace: WorkspaceHostControlRow }) {
  return (
    <div className={styles.tabStack}>
      <dl className={styles.hostFacts}>
        <div>
          <dt>Estimated monthly</dt>
          <dd>{formatMoney(workspace.estimatedMonthlyUsd)}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{workspace.size}</dd>
        </div>
        <div>
          <dt>Disk</dt>
          <dd>{workspace.diskGiB} GiB</dd>
        </div>
      </dl>
      <section
        className={styles.telemetryPanel}
        aria-label={`Cost and quota signals for ${workspace.name}`}
      >
        <h5>Cost signals</h5>
        <SignalList
          items={workspace.costSignals}
          empty="No cost signals recorded."
        />
        <h5>Quota signals</h5>
        <SignalList
          items={workspace.quotaSignals}
          empty="No quota signals recorded."
        />
      </section>
    </div>
  );
}
