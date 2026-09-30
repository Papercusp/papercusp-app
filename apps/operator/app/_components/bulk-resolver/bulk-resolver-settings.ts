"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_BULK_RESOLVER_LAUNCH_PROFILE,
  resolveBulkResolverLaunch,
  type BulkResolverLaunchProfile,
  type BulkResolverProfileKind,
} from "@papercusp/operator-core/lib/agent-config-constants";
import {
  DEFAULT_BULK_AUTOMATION_POLICY,
  isBulkAutomationMode,
  isBulkConfidence,
} from "@papercusp/operator-core/lib/attention/bulk-dispositions";

function freshDefault(): BulkResolverLaunchProfile {
  return { ...DEFAULT_BULK_RESOLVER_LAUNCH_PROFILE };
}

/** Normalize at the browser boundary through the canonical click-time resolver. */
export function normalizeResolverLaunchProfile(
  raw: unknown,
): BulkResolverLaunchProfile {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<BulkResolverLaunchProfile>)
      : {};
  const resolved = resolveBulkResolverLaunch(value);
  if (!resolved.ok || !resolved.effective) {
    throw new Error(
      resolved.message ?? "saved resolver launch profile is invalid",
    );
  }
  const { model, effort, account, carry } = resolved.effective;
  const hasPolicy =
    typeof value.automationMode === "string" ||
    typeof value.minConfidence === "string";
  return {
    model,
    effort,
    account,
    carry,
    ...(hasPolicy
      ? {
          automationMode:
            isBulkAutomationMode(value.automationMode)
              ? value.automationMode
              : DEFAULT_BULK_AUTOMATION_POLICY.mode,
          minConfidence:
            isBulkConfidence(value.minConfidence)
              ? value.minConfidence
              : DEFAULT_BULK_AUTOMATION_POLICY.minConfidence,
        }
      : {}),
  };
}

export async function loadResolverLaunchProfile(
  kind: BulkResolverProfileKind,
  signal?: AbortSignal,
): Promise<BulkResolverLaunchProfile> {
  const response = await fetch("/api/agent-config", { signal });
  if (!response.ok)
    throw new Error(
      `could not load resolver settings (HTTP ${response.status})`,
    );
  const json = (await response.json().catch(() => ({}))) as {
    config?: {
      resolverProfiles?: Partial<Record<BulkResolverProfileKind, unknown>>;
    };
  };
  return normalizeResolverLaunchProfile(json.config?.resolverProfiles?.[kind]);
}

export async function patchResolverLaunchProfile(
  kind: BulkResolverProfileKind,
  profile: BulkResolverLaunchProfile,
): Promise<void> {
  const response = await fetch("/api/agent-config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolverProfiles: { [kind]: profile } }),
  });
  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      json.error ??
        `could not save resolver settings (HTTP ${response.status})`,
    );
  }
}

export interface BulkResolverSettingsState {
  profile: BulkResolverLaunchProfile;
  loading: boolean;
  saving: boolean;
  error: string | null;
  validationError: string | null;
  ready: boolean;
  updateProfile: (profile: BulkResolverLaunchProfile) => void;
  retry: () => void;
}

/**
 * Per-pane durable defaults. Saves are serialized so rapid model/effort/account
 * selections cannot arrive out of order and restore an older profile.
 */
export function useBulkResolverSettings(
  kind: BulkResolverProfileKind,
): BulkResolverSettingsState {
  const [profile, setProfile] =
    useState<BulkResolverLaunchProfile>(freshDefault);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  const latestSave = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadResolverLaunchProfile(kind, controller.signal)
      .then((loaded) => {
        setProfile(loaded);
        setValidationError(null);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kind, reloadTick]);

  const updateProfile = useCallback(
    (next: BulkResolverLaunchProfile) => {
      setProfile(next);
      const resolved = resolveBulkResolverLaunch(next);
      if (!resolved.ok) {
        setValidationError(
          resolved.message ?? "resolver launch settings are invalid",
        );
        return;
      }
      setValidationError(null);
      setError(null);

      const saveId = ++latestSave.current;
      pendingSaves.current += 1;
      setSaving(true);
      saveTail.current = saveTail.current
        .catch(() => undefined)
        .then(() => patchResolverLaunchProfile(kind, next))
        .then(() => {
          if (saveId === latestSave.current) setError(null);
        })
        .catch((cause: unknown) => {
          if (saveId === latestSave.current) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        })
        .finally(() => {
          pendingSaves.current -= 1;
          if (pendingSaves.current === 0) setSaving(false);
        });
    },
    [kind],
  );

  const ready = useMemo(
    () => !loading && !saving && !error && !validationError,
    [loading, saving, error, validationError],
  );

  return {
    profile,
    loading,
    saving,
    error,
    validationError,
    ready,
    updateProfile,
    retry: () => setReloadTick((value) => value + 1),
  };
}
