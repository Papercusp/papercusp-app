"use client";

/**
 * Cloud Workspaces — the guided rail.
 *
 * This file is the ORCHESTRATOR and nothing else: it owns the sync read, the
 * URL state, the one mutation seam every stage dispatches through, and the
 * destroy modal. Every derivation lives in `workspace-view-model.ts`; every
 * pixel lives in the rail and the three stage components.
 *
 * The page used to be a single ~1,950-line scroll of three stacked sections.
 * A rail plus one stage means the operator sees the step they are on at full
 * size, and the status of the two they are not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Cloud, RefreshCw, Trash2 } from "lucide-react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { toast } from "sonner";
import { useSyncMutate, useSyncQuery } from "@papercusp/sync";
import { Button } from "@/app/harness/Button";
import { Modal } from "@/app/harness/Modal";
import { RadioGroup } from "@/app/harness/RadioGroup";
import { TextInput } from "@/app/harness/TextInput";
import { WorkspaceRail } from "./WorkspaceRail";
import { ConnectStage, EMPTY_CONNECT_DRAFT, type ConnectDraft } from "./ConnectStage";
import { ConfigureStage } from "./ConfigureStage";
import { HOST_TABS, OperateStage, type HostTab } from "./OperateStage";
import { Field } from "./stage-primitives";
import {
  DESTROY_DISPOSITIONS,
  workspaceHostActionRest,
  type WorkspaceHostActionArgs,
  type WorkspaceHostActionResponse,
} from "./workspace-host-actions";
import {
  canProvision as canProvisionFrom,
  estimateMonthlyUsd,
  isDiskGiBValid,
  railModel,
  readinessChecks,
  recentActivity,
  resolveActiveStep,
  workspaceHostIdFromName,
  type DestroyDisposition,
  type LifecycleAction,
  type ProviderTarget,
  type StepId,
  type WorkspaceHostConnectionRow,
  type WorkspaceHostControlRow,
} from "./workspace-view-model";
import styles from "./cloud-workspaces.module.css";

/*
 * `page.test.tsx` imports these three from `./page`, and so does anything else
 * that treats the page as the module boundary for this surface. The types and
 * the REST helper moved to their own modules during the rail redesign; these
 * re-exports keep that refactor invisible to importers.
 */
export type {
  CloudWorkspacesControlRow,
  WorkspaceHostConnectionRow,
  WorkspaceHostControlRow,
} from "./workspace-view-model";
export { workspaceHostIdFromName } from "./workspace-view-model";
export { workspaceHostActionRest } from "./workspace-host-actions";

export default function CloudWorkspacesPage() {
  const control = useSyncQuery<
    WorkspaceHostConnectionRow | WorkspaceHostControlRow
  >({
    queryName: "workspaceHosts.control",
  });
  const mutate = useSyncMutate<
    WorkspaceHostActionArgs,
    WorkspaceHostActionResponse
  >("workspaceHosts.action", workspaceHostActionRest);

  const rows = useMemo(() => control.data ?? [], [control.data]);
  const connections = useMemo(
    () =>
      rows.filter(
        (row): row is WorkspaceHostConnectionRow => row.kind === "connection",
      ),
    [rows],
  );
  const workspaces = useMemo(
    () =>
      rows.filter(
        (row): row is WorkspaceHostControlRow => row.kind === "workspace",
      ),
    [rows],
  );

  /* ── URL state ──────────────────────────────────────────────────────────── */

  const [stepParam, setStepParam] = useQueryState(
    "step",
    parseAsStringEnum<StepId>(["connect", "configure", "operate"]),
  );
  const [hostParam, setHostParam] = useQueryState("host", parseAsString);
  const [tabParam, setTabParam] = useQueryState(
    "tab",
    parseAsStringEnum<HostTab>([...HOST_TABS]).withDefault("overview"),
  );
  const [connectionParam, setConnectionParam] = useQueryState(
    "connection",
    parseAsString.withDefault(""),
  );
  const [scopeParam, setScopeParam] = useQueryState(
    "scope",
    parseAsString.withDefault(""),
  );
  const [regionParam, setRegionParam] = useQueryState(
    "region",
    parseAsString.withDefault(""),
  );
  const [sizeParam, setSizeParam] = useQueryState(
    "size",
    parseAsString.withDefault(""),
  );
  const [imageParam, setImageParam] = useQueryState(
    "image",
    parseAsString.withDefault(""),
  );
  const [networkParam, setNetworkParam] = useQueryState(
    "network",
    parseAsString.withDefault(""),
  );
  const [diskParam, setDiskParam] = useQueryState(
    "disk",
    parseAsString.withDefault("100"),
  );
  const [nameParam, setNameParam] = useQueryState(
    "name",
    parseAsString.withDefault(""),
  );
  const [connectTarget, setConnectTarget] = useQueryState(
    "connect",
    parseAsStringEnum<ProviderTarget>(["gcp", "aws", "azure"]),
  );
  const [destroyId, setDestroyId] = useQueryState("destroy", parseAsString);
  const [disposition, setDisposition] = useQueryState(
    "disposition",
    parseAsStringEnum<DestroyDisposition>([
      "snapshot",
      "backup",
      "discard",
    ]).withDefault("snapshot"),
  );

  /* ── Local (non-user-meaningful) state ──────────────────────────────────── */

  const [connectDraft, setConnectDraft] =
    useState<ConnectDraft>(EMPTY_CONNECT_DRAFT);
  const [destroyConfirm, setDestroyConfirm] = useState("");
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const inFlightKeysRef = useRef(new Set<string>());
  const uncertainValidationsRef = useRef(new Map<string, string | undefined>());

  // The origin scheduler can stop waiting at 20 seconds while the server keeps
  // inspecting and later persists the result. Reconcile against the canonical
  // connection row instead of reporting that an unknown outcome failed.
  useEffect(() => {
    for (const connection of connections) {
      if (!uncertainValidationsRef.current.has(connection.id)) continue;
      const before = uncertainValidationsRef.current.get(connection.id);
      const after = connection.lastValidatedAt;
      if (!after || (before && Date.parse(after) <= Date.parse(before))) continue;
      uncertainValidationsRef.current.delete(connection.id);
      if (connection.status === "connected") {
        toast.success(`${connection.label} connection status updated: connected`);
      } else {
        toast.error(`${connection.label} connection status updated: ${connection.status}`);
      }
    }
  }, [connections]);

  /* ── Catalog selection ──────────────────────────────────────────────────── */

  const selectedConnection =
    connections.find((row) => row.id === connectionParam) ??
    connections[0] ??
    null;
  const selectedScope =
    selectedConnection?.scopes.find((option) => option.id === scopeParam) ??
    selectedConnection?.scopes[0] ??
    null;
  const selectedRegion =
    selectedConnection?.regions.find((option) => option.id === regionParam) ??
    selectedConnection?.regions[0] ??
    null;
  const selectedZone = selectedRegion?.zones?.[0] ?? null;
  const selectedSize =
    selectedConnection?.sizes.find((option) => option.id === sizeParam) ??
    selectedConnection?.sizes[0] ??
    null;
  const selectedImage =
    selectedConnection?.images.find((option) => option.id === imageParam) ??
    selectedConnection?.images[0] ??
    null;
  const selectedNetwork =
    selectedConnection?.networks.find((option) => option.id === networkParam) ??
    selectedConnection?.networks[0] ??
    null;
  const catalogSelectionCanonical =
    connectionParam === (selectedConnection?.id ?? "") &&
    scopeParam === (selectedScope?.id ?? "") &&
    regionParam === (selectedRegion?.id ?? "") &&
    sizeParam === (selectedSize?.id ?? "") &&
    imageParam === (selectedImage?.id ?? "") &&
    networkParam === (selectedNetwork?.id ?? "");
  const diskGiB = Number(diskParam);
  const diskGiBValid = isDiskGiBValid(diskParam);

  /*
   * Canonicalization: a stale or absent catalog id in the URL is rewritten to
   * whatever the live catalog actually resolved to, and a dependent id whose
   * catalog dimension came back empty is cleared to "". Unchanged from the
   * pre-redesign page — the URL is the shareable state, so it must converge.
   */
  useEffect(() => {
    if (connections.length === 0) return;

    const connectionId = selectedConnection?.id ?? "";
    const scopeId = selectedScope?.id ?? "";
    const regionId = selectedRegion?.id ?? "";
    const sizeId = selectedSize?.id ?? "";
    const imageId = selectedImage?.id ?? "";
    const networkId = selectedNetwork?.id ?? "";

    if (connectionParam !== connectionId) void setConnectionParam(connectionId);
    if (scopeParam !== scopeId) void setScopeParam(scopeId);
    if (regionParam !== regionId) void setRegionParam(regionId);
    if (sizeParam !== sizeId) void setSizeParam(sizeId);
    if (imageParam !== imageId) void setImageParam(imageId);
    if (networkParam !== networkId) void setNetworkParam(networkId);
  }, [
    connectionParam,
    connections.length,
    imageParam,
    networkParam,
    regionParam,
    scopeParam,
    selectedConnection?.id,
    selectedImage?.id,
    selectedNetwork?.id,
    selectedRegion?.id,
    selectedScope?.id,
    selectedSize?.id,
    setConnectionParam,
    setImageParam,
    setNetworkParam,
    setRegionParam,
    setScopeParam,
    setSizeParam,
    sizeParam,
  ]);

  /* ── Derived view state ─────────────────────────────────────────────────── */

  const activeStep = resolveActiveStep(stepParam, connections, workspaces);
  const rail = useMemo(
    () => railModel(connections, workspaces, activeStep),
    [connections, workspaces, activeStep],
  );
  const activity = useMemo(
    () => recentActivity(connections, workspaces),
    [connections, workspaces],
  );
  const checks = useMemo(
    () =>
      readinessChecks({
        catalogSelectionCanonical,
        diskGiBValid,
        connection: selectedConnection,
        name: nameParam,
        scope: selectedScope,
        region: selectedRegion,
        zone: selectedZone,
        size: selectedSize,
        image: selectedImage,
        network: selectedNetwork,
      }),
    [
      catalogSelectionCanonical,
      diskGiBValid,
      nameParam,
      selectedConnection,
      selectedImage,
      selectedNetwork,
      selectedRegion,
      selectedScope,
      selectedSize,
      selectedZone,
    ],
  );
  const canProvision = canProvisionFrom(checks);
  const estimatedMonthlyUsd = estimateMonthlyUsd(
    selectedSize,
    diskGiB,
    diskGiBValid,
    selectedConnection?.diskPricePerGiBMonth,
  );
  const destroyWorkspace =
    workspaces.find((row) => row.id === destroyId) ?? null;

  /* ── The single mutation seam ───────────────────────────────────────────── */

  /*
   * Busy is tracked PER KEY, not as one page-wide boolean: two overlapping
   * mutations must disable independently and each must re-enable on its own
   * settle, so starting host A never greys out host B's controls.
   */
  const perform = useCallback(
    async (
      key: string,
      args: WorkspaceHostActionArgs,
      successMessage: string,
    ) => {
      if (inFlightKeysRef.current.has(key)) return false;

      inFlightKeysRef.current.add(key);
      setBusyKeys((current) => {
        const next = new Set(current);
        next.add(key);
        return next;
      });
      try {
        const response = await mutate(args);
        if (args.action === "validate-connection") {
          uncertainValidationsRef.current.delete(args.connectionId);
        }
        toast.success(response.message || successMessage);
        await control.invalidate?.();
        return true;
      } catch (error) {
        if (
          args.action === "validate-connection" &&
          error instanceof Error &&
          error.name === "OriginSchedulerError" &&
          "code" in error &&
          error.code === "timeout"
        ) {
          const previous = connections.find((row) => row.id === args.connectionId);
          uncertainValidationsRef.current.set(args.connectionId, previous?.lastValidatedAt);
          toast.info("Validation response timed out; checking connection status. It may still complete.");
          await control.invalidate?.();
          return false;
        }
        toast.error(
          error instanceof Error
            ? error.message
            : "Workspace-host action failed",
        );
        return false;
      } finally {
        inFlightKeysRef.current.delete(key);
        setBusyKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [connections, control, mutate],
  );

  /* ── Handlers ───────────────────────────────────────────────────────────── */

  const goToStep = useCallback(
    (step: StepId) => {
      void setStepParam(step);
    },
    [setStepParam],
  );

  const closeConnectPanel = useCallback(() => {
    void setConnectTarget(null);
    setConnectDraft(EMPTY_CONNECT_DRAFT);
  }, [setConnectTarget]);

  const handleConnect = useCallback(
    (target: ProviderTarget) => {
      void perform(
        "connect",
        {
          action: "connect",
          target,
          label: connectDraft.label.trim(),
          credentialRef: connectDraft.credentialRef.trim(),
          projectId: connectDraft.projectId.trim(),
          serviceAccountEmail: connectDraft.serviceAccountEmail.trim(),
        },
        `${connectDraft.label.trim()} connected`,
      ).then((ok) => {
        if (ok) closeConnectPanel();
      });
    },
    [closeConnectPanel, connectDraft, perform],
  );

  const handleValidate = useCallback(
    (connectionId: string, providerLabel: string) => {
      void perform(
        `validate:${connectionId}`,
        { action: "validate-connection", connectionId },
        `${providerLabel} connection validated`,
      );
    },
    [perform],
  );

  const handleProvision = useCallback(() => {
    if (
      !canProvision ||
      !selectedConnection ||
      selectedConnection.target !== "gcp" ||
      !selectedScope ||
      !selectedRegion ||
      !selectedZone ||
      !selectedSize ||
      !selectedImage ||
      !selectedNetwork ||
      !diskGiBValid
    )
      return;

    void perform(
      "provision",
      {
        action: "provision",
        connectionId: selectedConnection.id,
        name: nameParam.trim(),
        /* The canonical desired-spec. Shape is a wire contract — do not reorder
         * or omit: hostId / target / scope / region / zone / size / image /
         * data{volumeGiB,encrypted} / provider{network{mode}}. */
        desired: {
          hostId: workspaceHostIdFromName(nameParam),
          target: "gcp",
          scope: { kind: "project", id: selectedScope.id },
          region: selectedRegion.id,
          zone: selectedZone,
          size: selectedSize.id,
          image: {
            id: selectedImage.id,
            ...(selectedImage.version
              ? { version: selectedImage.version }
              : {}),
          },
          data: { volumeGiB: diskGiB, encrypted: true },
          provider: { network: { mode: "managed" } },
        },
      },
      `Provisioning ${nameParam.trim()}`,
    );
  }, [
    canProvision,
    diskGiB,
    diskGiBValid,
    nameParam,
    perform,
    selectedConnection,
    selectedImage,
    selectedNetwork,
    selectedRegion,
    selectedScope,
    selectedSize,
    selectedZone,
  ]);

  const handleLifecycle = useCallback(
    (
      workspace: WorkspaceHostControlRow,
      action: Exclude<LifecycleAction, "destroy">,
    ) => {
      const gerund: Record<Exclude<LifecycleAction, "destroy">, string> = {
        start: "Starting",
        stop: "Stopping",
        repair: "Repairing",
        snapshot: "Snapshotting",
      };
      void perform(
        `${action}:${workspace.id}`,
        { action, workspaceId: workspace.id },
        `${gerund[action]} ${workspace.name}`,
      );
    },
    [perform],
  );

  const closeDestroyModal = useCallback(() => {
    void setDestroyId(null);
    void setDisposition("snapshot");
    setDestroyConfirm("");
  }, [setDestroyId, setDisposition]);

  const backupReady =
    disposition !== "backup" ||
    (destroyWorkspace?.recoverability.kind === "backup" &&
      Boolean(destroyWorkspace.recoverability.updatedAt));
  const confirmationReady =
    disposition !== "discard" || destroyConfirm === destroyWorkspace?.name;
  const canDestroy = Boolean(destroyWorkspace && backupReady && confirmationReady);

  const handleDestroy = useCallback(() => {
    if (!destroyWorkspace || !backupReady || !confirmationReady) return;
    const hostId = destroyWorkspace.id;
    void perform(
      `destroy:${hostId}`,
      {
        action: "destroy",
        workspaceId: hostId,
        disposition,
        confirmation: {
          expectedHostId: hostId,
          confirmedBy: "operator:cloud-workspaces-ui",
          confirmedAt: new Date().toISOString(),
        },
      },
      `Destroying ${destroyWorkspace.name}`,
    ).then((ok) => {
      if (ok) closeDestroyModal();
    });
  }, [backupReady, closeDestroyModal, confirmationReady, destroyWorkspace, disposition, perform]);

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderCopy}>
          <p className={styles.eyebrow}>
            <Cloud size={14} aria-hidden="true" /> Local BYOC control plane
          </p>
          <h1>Cloud Workspaces</h1>
          <p className={styles.intro}>
            Provision and operate durable Papercusp hosts in infrastructure you
            control. Desired state and observed state stay separate so drift is
            visible instead of guessed away.
          </p>
        </div>
        <div className={styles.pageHeaderActions}>
          <Button
            variant="accent"
            onClick={() => void control.invalidate?.()}
            disabled={control.loading || control.fetching}
            aria-label="Refresh cloud workspace state"
          >
            <RefreshCw
              className={control.fetching ? styles.spin : undefined}
              size={14}
              aria-hidden="true"
            />
            {control.fetching ? "Refreshing" : "Refresh"}
          </Button>
          <small>
            {control.error ? "Control read unavailable" : "Live control state"}
          </small>
        </div>
      </header>

      {control.loading ? (
        <section className={styles.notice} aria-live="polite">
          <RefreshCw className={styles.spin} size={18} aria-hidden="true" />{" "}
          Loading provider connections and workspace state…
        </section>
      ) : control.error ? (
        <section
          className={`${styles.notice} ${styles.noticeError}`}
          role="alert"
        >
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Local cloud control plane unavailable</strong>
            <p>
              {control.error.message}. No provider action is available while
              this read is unresolved.
            </p>
          </div>
        </section>
      ) : null}

      <div className={styles.shell}>
        <WorkspaceRail
          model={rail}
          activity={activity}
          activeStep={activeStep}
          onSelectStep={goToStep}
        />

        {/* NOT a <main> landmark: the router already renders the document's single
            <main data-route-transition-page> (operator-vite/src/routes/__root.tsx),
            and nesting a second one is invalid + degrades screen-reader navigation.
            Pinned by "contributes no nested <main> landmark" in page.test.tsx. */}
        <div className={styles.stageArea}>
          {activeStep === "connect" ? (
            <ConnectStage
              connections={connections}
              selectedConnectionId={selectedConnection?.id ?? null}
              busyKeys={busyKeys}
              connectTarget={connectTarget}
              draft={connectDraft}
              onDraftChange={(patch) =>
                setConnectDraft((current) => ({ ...current, ...patch }))
              }
              onSelectTarget={(target) => {
                if (target === null) {
                  closeConnectPanel();
                  return;
                }
                void setConnectTarget(target);
              }}
              onConnect={handleConnect}
              onValidate={handleValidate}
            />
          ) : null}

          {activeStep === "configure" ? (
            <ConfigureStage
              connections={connections}
              selection={{
                connection: selectedConnection,
                scope: selectedScope,
                region: selectedRegion,
                zone: selectedZone,
                size: selectedSize,
                image: selectedImage,
                network: selectedNetwork,
              }}
              name={nameParam}
              disk={diskParam}
              diskGiBValid={diskGiBValid}
              checks={checks}
              canProvision={canProvision}
              estimatedMonthlyUsd={estimatedMonthlyUsd}
              busyKeys={busyKeys}
              onNameChange={(value) => void setNameParam(value)}
              onDiskChange={(value) => void setDiskParam(value)}
              onConnectionChange={(value) => void setConnectionParam(value)}
              onScopeChange={(value) => void setScopeParam(value)}
              onRegionChange={(value) => void setRegionParam(value)}
              onSizeChange={(value) => void setSizeParam(value)}
              onImageChange={(value) => void setImageParam(value)}
              onNetworkChange={(value) => void setNetworkParam(value)}
              onProvision={handleProvision}
              onOpenConnect={() => {
                void setStepParam("connect");
                void setConnectTarget("gcp");
              }}
            />
          ) : null}

          {activeStep === "operate" ? (
            <OperateStage
              workspaces={workspaces}
              connections={connections}
              busyKeys={busyKeys}
              selectedHostId={hostParam}
              activeTab={tabParam}
              onSelectHost={(hostId) => void setHostParam(hostId)}
              onSelectTab={(tab) => void setTabParam(tab)}
              onLifecycle={handleLifecycle}
              onDestroy={(workspaceId) => void setDestroyId(workspaceId)}
              onGoToConfigure={() => void setStepParam("configure")}
            />
          ) : null}
        </div>
      </div>

      <Modal
        open={Boolean(destroyWorkspace)}
        onOpenChange={(open) => {
          if (!open) closeDestroyModal();
        }}
        title={`Destroy ${destroyWorkspace?.name ?? "workspace"}`}
        description="Choose and record the recoverability disposition before any provider resource is deleted."
        contentClassName={styles.modal}
        closeOnOutsideClick={false}
      >
        <div className={styles.modalBody}>
          <div className={styles.dangerNotice}>
            <AlertTriangle size={18} aria-hidden="true" />
            Destroy is asynchronous. Completion requires a provider read
            confirming every resource is absent.
          </div>
          <RadioGroup
            label="Recoverability disposition"
            className={styles.dispositionGroup}
            optionClassName={styles.disposition}
            value={disposition}
            options={DESTROY_DISPOSITIONS.map(
              // Each entry already carries `value`; spreading it is enough.
              (entry) => ({ ...entry }),
            )}
            onChange={(next) => void setDisposition(next)}
          >
            {({ label, detail }) => (
              <>
                <strong>{label}</strong>
                <span>{detail}</span>
              </>
            )}
          </RadioGroup>
          {disposition === "discard" && destroyWorkspace ? (
            <Field label={`Type “${destroyWorkspace.name}” to confirm discard`}>
              <TextInput
                value={destroyConfirm}
                onChange={(event) => setDestroyConfirm(event.target.value)}
                aria-label={`Type ${destroyWorkspace.name} to confirm discard`}
              />
            </Field>
          ) : null}
          <p
            id="destroy-admission-blocker"
            className={styles.readiness}
            role="status"
          >
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              <strong>
                {disposition === "backup" && !backupReady
                  ? "Verified backup required"
                  : disposition === "discard" && !confirmationReady
                    ? "Typed confirmation required"
                    : "Ready for durable teardown"}
              </strong>
              <span>
                {disposition === "snapshot"
                  ? "A fresh provider snapshot must complete before any resource is deleted."
                  : disposition === "backup"
                    ? backupReady
                      ? `Existing backup ${destroyWorkspace?.recoverability.label ?? ""} will remain the recovery point.`
                      : "Record and verify a durable backup before selecting this disposition."
                    : "Discard permanently removes the host without creating a recovery point."}
              </span>
            </span>
          </p>
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={closeDestroyModal}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!canDestroy || busyKeys.has(`destroy:${destroyWorkspace?.id ?? ""}`)}
              aria-describedby="destroy-admission-blocker"
              onClick={handleDestroy}
            >
              <Trash2 size={14} aria-hidden="true" /> Confirm destroy
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
