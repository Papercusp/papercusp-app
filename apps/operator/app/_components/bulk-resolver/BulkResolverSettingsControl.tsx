"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, Loader2, RotateCcw, Settings2 } from "lucide-react";
import { Button } from "@/app/harness/Button";
import {
  Combobox,
  flattenComboboxEntries,
  type ComboboxEntry,
  type ComboboxOption,
} from "@/app/harness/Combobox";
import { Popover } from "@/app/harness/Popover";
import { useSuLaunchOptions } from "@/app/adv/sessions/use-su-launch-options";
import {
  ACCOUNT_SELECT_DEFAULT,
  EFFORT_SELECT_DEFAULT,
  MODEL_SELECT_DEFAULT,
  buildAccountOptions,
  buildEffortOptions,
  buildModelOptions,
  modelBackend,
} from "@/app/adv/sessions/su-launch-option-entries";
import {
  BULK_RESOLVER_CARRY_MODES,
  resolveBulkResolverLaunch,
  type BulkResolverLaunchProfile,
  type BulkResolverProfileKind,
  type EffectiveBulkResolverLaunch,
} from "@papercusp/operator-core/lib/agent-config-constants";
import {
  BULK_AUTOMATION_MODES,
  DEFAULT_BULK_AUTOMATION_POLICY,
  normalizeBulkAutomationPolicy,
  type BulkAutomationPolicy,
} from "@papercusp/operator-core/lib/attention/bulk-dispositions";
import type { BulkResolverSettingsState } from "./bulk-resolver-settings";
import type { RunLiveness } from "@papercusp/operator-core/lib/attention/bulk-run-store";

type LaunchReceipt = Partial<EffectiveBulkResolverLaunch> & {
  automationPolicy?: BulkAutomationPolicy | null;
};

export function formatResolverLaunchReceipt(
  snapshot: LaunchReceipt | null | undefined,
): string {
  if (!snapshot || Object.keys(snapshot).length === 0)
    return "Launch settings not recorded (legacy run)";
  const model = snapshot.model
    ? `${snapshot.model}${snapshot.effort ? `:${snapshot.effort}` : ""}`
    : "Default model";
  const backend =
    snapshot.backend ??
    (snapshot.model ? modelBackend(snapshot.model) : "claude") ??
    "unknown backend";
  return [
    model,
    backend,
    snapshot.account ?? "default",
    snapshot.carry ?? "warm",
    snapshot.automationPolicy
      ? snapshot.automationPolicy.mode
      : snapshot.automationMode
        ? snapshot.automationMode
        : "safe-high",
  ].join(" · ");
}

function ensureCurrentOption(
  options: ComboboxEntry[],
  value: string | null,
  detail: string,
): ComboboxEntry[] {
  if (
    !value ||
    flattenComboboxEntries(options).some((option) => option.value === value)
  )
    return options;
  return [{ value, label: value, detail }, ...options];
}

const CARRY_OPTIONS: ComboboxOption[] = BULK_RESOLVER_CARRY_MODES.map(
  (carry) => ({
    value: carry,
    label: carry === "warm" ? "Warm carry" : "Cold carry",
    detail:
      carry === "warm"
        ? "Resume the same live context on each wake"
        : "Rebuild each wake from the last checkpoint",
  }),
);

const AUTOMATION_OPTIONS: ComboboxOption[] = BULK_AUTOMATION_MODES.map(
  (mode) => ({
    value: mode,
    label:
      mode === "review-all"
        ? "Review all"
        : mode === "safe-medium-plus"
          ? "Safe · medium+"
          : "Safe · high confidence",
    detail:
      mode === "review-all"
        ? "Never auto-apply; prepare recommendations for you"
        : mode === "safe-medium-plus"
          ? "Auto-apply only eligible medium/high-confidence actions"
          : "Auto-apply only eligible high-confidence actions",
  }),
);

export interface BulkResolverSettingsControlProps {
  kind: BulkResolverProfileKind;
  settings: BulkResolverSettingsState;
  /** Exact click-time snapshot from a running/review run. Presence makes the
   * control a read-only launch receipt; absence edits the next-run defaults. */
  effective?: LaunchReceipt | null;
  /** Server-derived from the canonical run-store classifier. The UI renders
   * this verdict; it never carries its own heartbeat timeout. */
  liveness?: RunLiveness | null;
  onRestart?: () => void;
  restartBusy?: boolean;
}

export default function BulkResolverSettingsControl({
  kind,
  settings,
  effective,
  liveness,
  onRestart,
  restartBusy = false,
}: BulkResolverSettingsControlProps) {
  const [open, setOpen] = useState(false);
  const profile = settings.profile;
  const automationPolicy = normalizeBulkAutomationPolicy({
    mode: profile.automationMode,
    minConfidence: profile.minConfidence,
  });
  const backend = modelBackend(profile.model ?? "") ?? "claude";
  const launchOptions = useSuLaunchOptions(null, backend);
  const modelOptions = useMemo(
    () =>
      ensureCurrentOption(
        buildModelOptions(launchOptions.ompCatalog.models),
        profile.model,
        "Saved model",
      ),
    [launchOptions.ompCatalog.models, profile.model],
  );
  const selectedOmpModel = useMemo(
    () =>
      launchOptions.ompCatalog.models.find(
        (model) => model.selector === profile.model,
      ) ?? null,
    [launchOptions.ompCatalog.models, profile.model],
  );
  const effortOptions = useMemo(
    () => buildEffortOptions(selectedOmpModel),
    [selectedOmpModel],
  );
  const accountOptions = useMemo(
    () =>
      ensureCurrentOption(
        buildAccountOptions(launchOptions.accounts),
        profile.account,
        "Saved account",
      ),
    [launchOptions.accounts, profile.account],
  );
  const resolved = resolveBulkResolverLaunch(profile);
  const nextReceipt = resolved.effective
    ? formatResolverLaunchReceipt(resolved.effective)
    : "Invalid settings";
  const label = kind === "inbox-resolve" ? "Inbox resolver" : "Plans resolver";

  if (effective !== undefined) {
    const stale = liveness?.state === "stale" ? liveness : null;
    return (
      <div
        className="op-resolver-settings op-resolver-settings--receipt"
        data-testid={`${kind}-launch-receipt`}
      >
        <span className="op-resolver-settings__eyebrow">Launched</span>
        <span className="op-resolver-settings__summary">
          {formatResolverLaunchReceipt(effective)}
        </span>
        <span className="op-resolver-settings__fixed">
          fresh · headless · su
        </span>
        {stale ? (
          <div
            className="op-resolver-settings__liveness"
            role="alert"
            data-testid={`${kind}-resolver-stale`}
          >
            <AlertCircle size={12} aria-hidden="true" />
            <span>
              {stale.measuredFrom === "start"
                ? "Resolver never reported after launch"
                : "Resolver stopped reporting"}
            </span>
            {onRestart ? (
              <button
                type="button"
                disabled={restartBusy}
                onClick={onRestart}
                data-testid={`${kind}-restart`}
              >
                {restartBusy ? (
                  <Loader2
                    size={11}
                    className="op-resolver-settings__spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RotateCcw size={11} aria-hidden="true" />
                )}
                {restartBusy ? "Restarting…" : "Restart resolver"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const update = (patch: Partial<BulkResolverLaunchProfile>) => {
    settings.updateProfile({ ...profile, ...patch });
  };
  const problem =
    settings.validationError ??
    (!resolved.ok ? (resolved.message ?? "Invalid settings") : null);

  return (
    <div className="op-resolver-settings" data-testid={`${kind}-settings`}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="start"
        ariaLabel={`${label} launch settings`}
        trigger={
          <Button
            variant="neutral"
            size="sm"
            className="op-resolver-settings__trigger"
            disabled={settings.loading}
            data-testid={`${kind}-settings-trigger`}
          >
            {settings.loading || settings.saving ? (
              <Loader2
                size={12}
                className="op-resolver-settings__spin"
                aria-hidden="true"
              />
            ) : settings.ready ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <AlertCircle size={12} aria-hidden="true" />
            )}
            <Settings2 size={12} aria-hidden="true" />
            <span>
              {settings.loading
                ? `Loading ${label.toLowerCase()}…`
                : `Next run · ${nextReceipt}`}
            </span>
          </Button>
        }
        contentClassName="op-resolver-settings__panel"
      >
        <div className="op-resolver-settings__panel-head">
          <strong>{label} launch</strong>
          <span>
            Saved for this pane; the click-time values are recorded on every
            run.
          </span>
        </div>
        <div className="op-resolver-settings__grid">
          <label>
            <span>Model</span>
            <Combobox
              value={profile.model ?? MODEL_SELECT_DEFAULT}
              emptyValue={MODEL_SELECT_DEFAULT}
              onChange={(value) =>
                update({
                  model: value === MODEL_SELECT_DEFAULT ? null : value,
                  effort: null,
                })
              }
              ariaLabel={`${label} model`}
              placeholder="Default model"
              emptyLabel="No models match"
              options={modelOptions}
              testId={`${kind}-model`}
            />
          </label>
          <label>
            <span>Effort</span>
            <Combobox
              value={profile.effort ?? EFFORT_SELECT_DEFAULT}
              emptyValue={EFFORT_SELECT_DEFAULT}
              onChange={(value) =>
                update({
                  effort:
                    value === EFFORT_SELECT_DEFAULT
                      ? null
                      : (value as BulkResolverLaunchProfile["effort"]),
                })
              }
              ariaLabel={`${label} effort`}
              placeholder="Default effort"
              emptyLabel="No effort levels match"
              options={effortOptions}
              disabled={!profile.model}
              testId={`${kind}-effort`}
            />
          </label>
          <label>
            <span>Account</span>
            <Combobox
              value={profile.account || ACCOUNT_SELECT_DEFAULT}
              emptyValue={ACCOUNT_SELECT_DEFAULT}
              onChange={(account) => update({ account })}
              ariaLabel={`${label} account`}
              placeholder="Default account"
              emptyLabel="No accounts match"
              options={accountOptions}
              testId={`${kind}-account`}
            />
          </label>
          <label>
            <span>Carry</span>
            <Combobox
              value={profile.carry}
              onChange={(carry) =>
                update({ carry: carry as BulkResolverLaunchProfile["carry"] })
              }
              ariaLabel={`${label} carry`}
              emptyLabel="No carry modes match"
              options={CARRY_OPTIONS}
              testId={`${kind}-carry`}
            />
          </label>
          <label>
            <span>Automation</span>
            <Combobox
              value={automationPolicy.mode}
              onChange={(mode) => {
                const next = normalizeBulkAutomationPolicy({ mode: mode as typeof automationPolicy.mode });
                update({
                  automationMode: next.mode,
                  minConfidence: next.minConfidence,
                });
              }}
              ariaLabel={`${label} automation policy`}
              emptyLabel="No automation modes match"
              options={AUTOMATION_OPTIONS}
              testId={`${kind}-automation`}
            />
          </label>
        </div>
        <p className="op-resolver-settings__fixed-copy">
          Fixed invariants: fresh session · headless · superuser. The model
          selects the compatible backend.
        </p>
        <p className="op-resolver-settings__hint">
          Confidence is an additional floor; protected and owner-only actions
          always stay manual. Default: {DEFAULT_BULK_AUTOMATION_POLICY.mode}.
        </p>
        {launchOptions.error ? (
          <p className="op-resolver-settings__hint">
            Live account/model options unavailable: {launchOptions.error}
          </p>
        ) : null}
        {problem || settings.error ? (
          <div className="op-resolver-settings__error" role="alert">
            {problem ?? settings.error}
            {settings.error ? (
              <button type="button" onClick={settings.retry}>
                Retry
              </button>
            ) : null}
          </div>
        ) : (
          <div className="op-resolver-settings__saved" role="status">
            {settings.saving ? "Saving…" : "Saved"} · {nextReceipt}
          </div>
        )}
      </Popover>
    </div>
  );
}
