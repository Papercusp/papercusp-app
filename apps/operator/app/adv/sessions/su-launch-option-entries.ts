"use client";

/**
 * Browser-safe option entries shared by every owner-side SU launch control.
 *
 * The static vocabulary comes from agent-config-constants, whose parity suite
 * pins it to psu. Host-local OMP models and gateway accounts are supplied by
 * useSuLaunchOptions, the same live endpoint psu reads. Keeping the entry
 * builders here prevents each surface from growing a look-alike menu that
 * silently falls behind the launcher.
 */
import type { SuAgent } from "@papercusp/operator-core/lib/su-agents";
import {
  CLOUD_MODEL_MENU,
  LAUNCH_ACCOUNT_MODES,
  MODEL_EFFORT_LEVELS,
} from "@papercusp/operator-core/lib/agent-config-constants";
import type { ComboboxEntry, ComboboxOption } from "@/app/harness/Combobox";
import type { AccountChoice, OmpLaunchModel } from "./use-su-launch-options";

export const MODEL_SELECT_DEFAULT = "__default_model__";

export const OMP_MODEL_OPTIONS: ComboboxOption[] = [
  { value: MODEL_SELECT_DEFAULT, label: "Default" },
  ...CLOUD_MODEL_MENU.map((model) => ({
    value: model.value,
    label: model.label,
    detail: model.backend === "codex" ? "codex CLI" : "claude CLI",
  })),
];

function formatTokenCount(value: number | null): string | null {
  if (value === null) return null;
  if (value >= 1_000_000) return `${value / 1_000_000}M context`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k context`;
  return `${value} context`;
}

/** Native aliases stay stable; host-local OMP selectors live in their own group. */
export function buildModelOptions(models: OmpLaunchModel[]): ComboboxEntry[] {
  const native = OMP_MODEL_OPTIONS.filter(
    (option) => option.value !== MODEL_SELECT_DEFAULT,
  );
  const groups: ComboboxEntry[] = [
    OMP_MODEL_OPTIONS[0],
    { kind: "group", label: "Papercusp aliases", options: native },
  ];
  if (models.length > 0) {
    groups.push({
      kind: "group",
      label: "OMP installed models",
      options: models.map((model) => ({
        value: model.selector,
        label: model.name,
        detail: [
          model.provider,
          formatTokenCount(model.contextWindow),
          model.reasoning ? "reasoning" : null,
        ]
          .filter(Boolean)
          .join(" · "),
        keywords: [model.provider, model.id, model.selector, ...model.input],
      })),
    });
  }
  return groups;
}

export const EFFORT_SELECT_DEFAULT = "__default_effort__";

const EFFORT_LABELS: Record<string, { label: string; detail: string }> = {
  low: { label: "Low", detail: "Fastest, cheapest — shallow reasoning" },
  medium: { label: "Medium", detail: "Balanced reasoning depth vs cost" },
  high: { label: "High", detail: "Deep reasoning" },
  xhigh: { label: "xHigh", detail: "Deeper still — slower and pricier" },
  max: { label: "Max", detail: "Strongest reasoning available" },
};

export const EFFORT_OPTIONS: ComboboxOption[] = [
  { value: EFFORT_SELECT_DEFAULT, label: "Default effort" },
  ...MODEL_EFFORT_LEVELS.map((level) => ({
    value: level,
    label: EFFORT_LABELS[level]?.label ?? level,
    detail: EFFORT_LABELS[level]?.detail,
  })),
];

/** OMP publishes per-model effort support; never offer a suffix it did not. */
export function buildEffortOptions(
  model?: OmpLaunchModel | null,
): ComboboxOption[] {
  if (!model) return EFFORT_OPTIONS;
  return [
    EFFORT_OPTIONS[0],
    ...(model.thinking ?? []).map((level) => ({
      value: level,
      label: EFFORT_LABELS[level]?.label ?? level,
      detail: EFFORT_LABELS[level]?.detail,
    })),
  ];
}

/** The CLI backend implied by a selected model, or undefined for inheritance. */
export function modelBackend(model: string): SuAgent | undefined {
  const value = model.trim();
  if (!value || value === MODEL_SELECT_DEFAULT) return undefined;
  const colon = value.lastIndexOf(":");
  const base =
    colon > 0 &&
    (MODEL_EFFORT_LEVELS as readonly string[]).includes(value.slice(colon + 1))
      ? value.slice(0, colon)
      : value;
  const native = CLOUD_MODEL_MENU.find((choice) => choice.value === base)
    ?.backend as SuAgent | undefined;
  if (native) return native;
  return base.includes("/") ? "omp" : undefined;
}

export const ACCOUNT_SELECT_DEFAULT = "default";

/** psu's two routing modes followed by the live gateway pool accounts. */
export function buildAccountOptions(
  accounts: AccountChoice[],
): ComboboxOption[] {
  const modeDetail: Record<string, string> = {
    default: "System / CLI login — no gateway pin",
    auto: "Gateway-routed with failover across the pool",
  };
  return [
    ...LAUNCH_ACCOUNT_MODES.map((mode) => ({
      value: mode,
      label: mode === "default" ? "Default account" : "Auto (gateway)",
      detail: modeDetail[mode],
    })),
    ...accounts.map((account) => ({
      value: account.id,
      label: account.label?.trim() || account.id,
      detail: account.availability === 'unavailable'
        ? 'Used up — usage limit reached'
        : account.availability === 'unknown'
          ? 'Usage unverified — check capacity before pinning'
          : account.detail?.trim() || "Pinned pool account",
      keywords: [account.id],
      disabled: account.availability === 'unavailable',
    })),
  ];
}
