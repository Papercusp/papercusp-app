"use client";

/**
 * 02 Configure — the provisioning form.
 *
 * Three changes from the pre-redesign page:
 *
 *  - the eight flat fields are GROUPED (Placement / Capacity / Storage &
 *    network), so the form reads as three decisions instead of eight;
 *  - machine sizes are selectable CARDS carrying their own capacity and price,
 *    because choosing a size is a comparison and a dropdown hides the
 *    alternatives you are comparing against;
 *  - the semicolon-joined blocker sentence ("Required: a; b; c.") is a
 *    CHECKLIST, so a four-condition failure reads as four fixable lines.
 *
 * Unchanged and load-bearing: the canonical provision desired-spec, disk
 * validation with no silent correction, the catalog-empty explanations, and
 * `aria-describedby` on every field.
 */

import { AlertTriangle, Check, Cloud, DollarSign, Plus, Server } from "lucide-react";
import { Button } from "@/app/harness/Button";
import { RadioGroup } from "@/app/harness/RadioGroup";
import { Select } from "@/app/harness/Select";
import { TextInput } from "@/app/harness/TextInput";
import { Field, FieldGroup, StageHeader } from "./stage-primitives";
import {
  DISK_MAX_GIB,
  DISK_MIN_GIB,
  formatCapacity,
  formatMoney,
  type CatalogOption,
  type ImageOption,
  type ReadinessCheck,
  type RegionOption,
  type SizeOption,
  type WorkspaceHostConnectionRow,
} from "./workspace-view-model";
import styles from "./cloud-workspaces.module.css";

export interface ConfigureSelection {
  connection: WorkspaceHostConnectionRow | null;
  scope: CatalogOption | null;
  region: RegionOption | null;
  zone: string | null;
  size: SizeOption | null;
  image: ImageOption | null;
  network: CatalogOption | null;
}

export function ConfigureStage({
  connections,
  selection,
  name,
  disk,
  diskGiBValid,
  checks,
  canProvision,
  estimatedMonthlyUsd,
  busyKeys,
  onNameChange,
  onDiskChange,
  onConnectionChange,
  onScopeChange,
  onRegionChange,
  onSizeChange,
  onImageChange,
  onNetworkChange,
  onProvision,
  onOpenConnect,
}: {
  connections: readonly WorkspaceHostConnectionRow[];
  selection: ConfigureSelection;
  name: string;
  disk: string;
  diskGiBValid: boolean;
  checks: readonly ReadinessCheck[];
  canProvision: boolean;
  estimatedMonthlyUsd: number | undefined;
  busyKeys: ReadonlySet<string>;
  onNameChange: (value: string) => void;
  onDiskChange: (value: string) => void;
  onConnectionChange: (value: string) => void;
  onScopeChange: (value: string) => void;
  onRegionChange: (value: string) => void;
  onSizeChange: (value: string) => void;
  onImageChange: (value: string) => void;
  onNetworkChange: (value: string) => void;
  onProvision: () => void;
  onOpenConnect: () => void;
}) {
  const { connection, scope, region, zone, size, image, network } = selection;
  const unmet = checks.filter((check) => !check.ok);

  if (connections.length === 0) {
    return (
      <section
        className={styles.stage}
        aria-labelledby="configure-stage-heading"
        data-stage="configure"
      >
        <StageHeader
          id="configure-stage-heading"
          step="02"
          eyebrow="Configure"
          title="New workspace"
          description="Selections are URL-backed so this exact provisioning view can be reviewed, shared, and revisited."
        />
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>
            <Server size={22} aria-hidden="true" />
          </span>
          <h3>Connect a provider to begin</h3>
          <p>
            The form stays inert until a validated provider catalog supplies
            real scope and capacity options.
          </p>
          <Button variant="primary" onClick={onOpenConnect}>
            <Plus size={14} aria-hidden="true" /> Connect a provider
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      className={styles.stage}
      aria-labelledby="configure-stage-heading"
      data-stage="configure"
    >
      <StageHeader
        id="configure-stage-heading"
        step="02"
        eyebrow="Configure"
        title="New workspace"
        description="Selections are URL-backed so this exact provisioning view can be reviewed, shared, and revisited."
      />

      <form
        className={styles.provisionForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canProvision) return;
          onProvision();
        }}
      >
        <div className={styles.configureColumns}>
          <div className={styles.configureFields}>
            <FieldGroup
              title="Placement"
              hint="Which provider catalog this host is cut from, and where it lands."
            >
              <Field
                label="Workspace name"
                hint={!name.trim() ? "Required before provisioning." : undefined}
              >
                {(hintId) => (
                  <TextInput
                    value={name}
                    onChange={(event) => onNameChange(event.target.value)}
                    placeholder="research-control"
                    aria-label="Workspace name"
                    aria-describedby={hintId}
                  />
                )}
              </Field>
              <Field label="Provider connection">
                <Select
                  value={connection?.id ?? ""}
                  onChange={onConnectionChange}
                  ariaLabel="Provider connection"
                  options={connections.map((row) => ({
                    value: row.id,
                    label: `${row.label} · ${row.target.toUpperCase()}`,
                  }))}
                />
              </Field>
              <Field
                label="Project, account, or subscription"
                hint={
                  connection?.scopes.length
                    ? undefined
                    : "No projects, accounts, or subscriptions were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={scope?.id ?? ""}
                    onChange={onScopeChange}
                    ariaLabel="Project, account, or subscription"
                    placeholder="No scopes available"
                    disabled={!connection?.scopes.length}
                    options={
                      connection?.scopes.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
              <Field
                label="Region"
                hint={
                  connection?.regions.length
                    ? zone
                      ? `Zone ${zone}`
                      : "No available zone for this region."
                    : "No regions were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={region?.id ?? ""}
                    onChange={onRegionChange}
                    ariaLabel="Region"
                    placeholder="No regions available"
                    disabled={!connection?.regions.length}
                    options={
                      connection?.regions.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
            </FieldGroup>

            <FieldGroup
              title="Capacity"
              hint="Compare machine sizes against each other and their price."
            >
              {connection?.sizes.length ? (
                /*
                 * The shared radiogroup primitive carries the roving-tabindex
                 * keyboard contract, so this file only decides what a size
                 * card looks like.
                 */
                <div className={styles.sizeFieldset}>
                  <span className={styles.fieldLabel}>Machine size</span>
                  <RadioGroup
                    label="Machine size"
                    className={styles.sizeCards}
                    optionClassName={styles.sizeCard}
                    value={size?.id ?? null}
                    options={connection.sizes.map((option) => ({
                      value: option.id,
                      option,
                    }))}
                    onChange={onSizeChange}
                  >
                    {({ option }) => (
                      <>
                        <span className={styles.sizeCardBody}>
                          <strong>{option.label}</strong>
                          {/*
                           * formatCapacity refuses to render a partial catalog
                           * row, so an incomplete size can never leak
                           * "undefined vCPU" into the card.
                           */}
                          <span>{formatCapacity(option)}</span>
                          <em>
                            {option.hourlyUsd === undefined
                              ? "Price unavailable"
                              : `${formatMoney(option.hourlyUsd * 730)} / month`}
                          </em>
                        </span>
                        <span className={styles.sizeCardTick} aria-hidden="true">
                          <Check size={14} />
                        </span>
                      </>
                    )}
                  </RadioGroup>
                </div>
              ) : (
                <Field
                  label="Machine size"
                  hint="No machine sizes were returned by this provider connection."
                >
                  {(hintId) => (
                    <Select
                      value=""
                      onChange={onSizeChange}
                      ariaLabel="Machine size"
                      placeholder="No machine sizes available"
                      disabled
                      options={[]}
                      describedBy={hintId}
                    />
                  )}
                </Field>
              )}

              <Field
                label="Image"
                hint={
                  connection?.images.length
                    ? undefined
                    : "No images were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={image?.id ?? ""}
                    onChange={onImageChange}
                    ariaLabel="Machine image"
                    placeholder="No images available"
                    disabled={!connection?.images.length}
                    options={
                      connection?.images.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
            </FieldGroup>

            <FieldGroup
              title="Storage & network"
              hint="Durable data volume and the network this host attaches to."
            >
              <Field
                label="Disk (GiB)"
                hint={
                  diskGiBValid
                    ? `${DISK_MIN_GIB}–${DISK_MAX_GIB.toLocaleString("en-US")} GiB`
                    : `Enter a whole number between ${DISK_MIN_GIB} and ${DISK_MAX_GIB.toLocaleString("en-US")} GiB.`
                }
              >
                {(hintId) => (
                  <TextInput
                    type="number"
                    min={DISK_MIN_GIB}
                    max={DISK_MAX_GIB}
                    step={1}
                    required
                    /*
                     * No silent correction: an out-of-range or fractional value
                     * stays exactly as typed and is reported invalid, rather
                     * than being clamped behind the operator's back.
                     */
                    value={disk}
                    onChange={(event) => onDiskChange(event.target.value)}
                    aria-label="Disk size in GiB"
                    aria-describedby={hintId}
                    aria-invalid={!diskGiBValid}
                  />
                )}
              </Field>
              <Field
                label="Network"
                hint={
                  connection?.networks.length
                    ? undefined
                    : "No networks were returned by this provider connection."
                }
              >
                {(hintId) => (
                  <Select
                    value={network?.id ?? ""}
                    onChange={onNetworkChange}
                    ariaLabel="Network"
                    placeholder="No networks available"
                    disabled={!connection?.networks.length}
                    options={
                      connection?.networks.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })) ?? []
                    }
                    describedBy={hintId}
                  />
                )}
              </Field>
            </FieldGroup>
          </div>

          <aside className={styles.configureSummary}>
            <div
              className={styles.estimate}
              role="group"
              aria-label="Estimated workspace cost"
            >
              <span className={styles.estimateIcon}>
                <DollarSign size={19} aria-hidden="true" />
              </span>
              <div className={styles.estimateTotal}>
                <span>Estimated monthly cost</span>
                <strong>
                  {formatMoney(estimatedMonthlyUsd)} <small>/ month</small>
                </strong>
                <p>
                  Estimate only · 730 compute hours + selected disk · provider
                  taxes and egress excluded.
                </p>
              </div>
              <dl className={styles.estimateFacts}>
                <div>
                  <dt>Provider</dt>
                  <dd>{connection?.target.toUpperCase() ?? "—"}</dd>
                </div>
                <div>
                  <dt>Region</dt>
                  <dd>{region?.label ?? "—"}</dd>
                </div>
                <div>
                  <dt>Compute</dt>
                  <dd>{size ? formatCapacity(size) : "—"}</dd>
                </div>
              </dl>
            </div>

            {/*
             * The checklist. Each condition is its own line with its own fix,
             * in the order an operator would work through them.
             */}
            <div
              id="provision-readiness"
              className={styles.readiness}
              role="status"
            >
              <p className={styles.readinessHeading}>
                {unmet.length === 0 ? (
                  <>
                    <Check size={16} aria-hidden="true" />
                    <strong>Ready to provision</strong>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={16} aria-hidden="true" />
                    <strong>
                      Provisioning blocked · {unmet.length} of {checks.length}{" "}
                      unmet
                    </strong>
                  </>
                )}
              </p>
              <ul className={styles.readinessList}>
                {checks.map((check) => (
                  <li key={check.id} data-ok={check.ok ? "true" : "false"}>
                    <span className={styles.readinessMark} aria-hidden="true">
                      {check.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
                    </span>
                    <span className={styles.readinessBody}>
                      <span>{check.label}</span>
                      {!check.ok && check.fix ? <em>{check.fix}</em> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!canProvision || busyKeys.has("provision")}
              aria-describedby="provision-readiness"
            >
              <Cloud size={16} aria-hidden="true" /> Provision workspace
            </Button>
          </aside>
        </div>
      </form>
    </section>
  );
}
