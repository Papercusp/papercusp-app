"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { toast } from "sonner";
import { Button } from "../../harness/Button";
import { Checkbox } from "../../harness/Checkbox";
import { Modal } from "../../harness/Modal";
import { Select } from "../../harness/Select";
import { Table, type TableColumn } from "../../harness/Table";
import {
  isExternalWebUrl,
  openExternalWebUrl,
} from "../../_components/ExternalLinkProvider";
import { isDesktop } from "@/lib/ipc-status-tauri";
// The SAME predicate the server-side fence applies, not a copy of it — so the
// mint-time warning below cannot drift away from the rule it describes.
import { isCodingAgentRole } from "@papercusp/operator-core/lib/personal-vault/coding-roles";

/**
 * Sentinel for the "no provider account" choice in the archive-account picker.
 *
 * Radix refuses an empty-string `Select.Item` value (it throws and takes the whole
 * subtree down), so `harness/Select` filters `value === ''` entries out entirely.
 * An empty-string option would therefore VANISH rather than render. The unattributed
 * choice travels as this sentinel and is mapped back to `''` in onChange, which keeps
 * the option selectable both ways — a `placeholder` alone could only display it, never
 * let the user return to it after picking an account.
 */
const UNATTRIBUTED_ACCOUNT = "__unattributed__";

interface SourceStats {
  source: string;
  source_id: string | null;
  provider_account_id: string | null;
  documents: number;
  newest_at: string | null;
}

interface PurgeTarget {
  source: string | null;
  sourceId: string | null;
  providerAccountId: string | null;
}

type PersonalVaultImportStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface PersonalVaultImportJob {
  id: string;
  sourceId: string | null;
  providerAccountId: string | null;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  status: PersonalVaultImportStatus;
  bytesProcessed: number;
  entriesProcessed: number;
  documentsSeen: number;
  documentsImported: number;
  warnings: string[];
  cancelRequested: boolean;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  retainedUntil: string;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type PersonalPrincipalType = "plan-template" | "binding" | "agent-role";

interface PersonalGrant {
  id: string;
  principal_type: PersonalPrincipalType;
  principal_id: string;
  scopes: string[];
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface ImportStorageScope {
  retainedBytes: number;
  reservedBytes: number;
  usedBytes: number;
  remainingBytes: number;
  maxBytes: number;
  retainedJobs: number;
  reservedJobs: number;
  jobs: number;
  remainingJobs: number;
  maxJobs: number;
}

interface VaultStatus {
  ok: boolean;
  enabled: boolean;
  workspaceId: string;
  user: { id: string; displayName: string };
  stats: { sources: SourceStats[]; unembedded: number };
  grants: PersonalGrant[];
  supportedSources: string[];
  embedding: { mode: "gemma"; localOnly: true };
  /** Additive status field: an older sidecar may omit it during a rolling dev update. */
  importStorage?: { owner: ImportStorageScope; workspace: ImportStorageScope };
  integrations?: { google: IntegrationStatus; facebook?: IntegrationStatus };
}

interface IntegrationSourceStatus {
  kind: string;
  providerAccountId: string | null;
  status: string;
  lastConnectedAt: string | null;
  lastSyncAt: string | null;
  lastError?: string | null;
  backfill?: {
    status: "pending" | "throttled" | "complete";
    messages: number;
  } | null;
}

/** One line explaining a source's state beyond the bare status word. */
function sourceStatusDetail(source: IntegrationSourceStatus): string {
  const parts: string[] = [source.status];
  if (source.backfill && source.backfill.status !== "complete") {
    parts.push(
      `importing history (${source.backfill.messages.toLocaleString()} so far` +
        (source.backfill.status === "throttled"
          ? ", paused for provider quota)"
          : ")"),
    );
  }
  if (source.lastSyncAt) parts.push("synced " + formatDate(source.lastSyncAt));
  return parts.join(" · ");
}

interface IntegrationStatus {
  provider: "google" | "facebook";
  configured: boolean;
  connected: boolean;
  status: "needs-app-config" | "available" | "connected" | "degraded" | "error";
  sources: IntegrationSourceStatus[];
  capabilities?: GoogleCapabilityStatus[];
  accounts?: Array<GoogleAccountStatus | FacebookAccountStatus>;
}

type GoogleCapabilityId = "gmail" | "calendar" | "contacts" | "youtube";

interface GoogleCapabilityStatus {
  id: GoogleCapabilityId;
  sourceKind: "gmail" | "gcal" | "contacts" | "youtube";
  enabled: boolean;
  connected: boolean;
  status:
    | "needs-app-config"
    | "available"
    | "connected"
    | "disabled"
    | "needs-consent"
    | "degraded"
    | "error";
  missingScopes: string[];
}

interface GoogleAccountStatus {
  providerAccountId: string;
  displayName: string;
  connected: boolean;
  status: IntegrationStatus["status"];
  sources: IntegrationSourceStatus[];
  grantedScopes: string[];
  capabilities: GoogleCapabilityStatus[];
}

interface FacebookAccountStatus {
  providerAccountId: string;
  displayName: string;
  connected: boolean;
  status: IntegrationStatus["status"];
  sources: IntegrationSourceStatus[];
}

interface GrantPreview {
  ok: boolean;
  planSlug: string;
  harnessSlug: string;
  principalType: "plan-template";
  principalId: string;
  declaredScopes: string[];
}

interface ApiFailure {
  ok?: false;
  error?: string;
}

const ARCHIVE_HELP = {
  google: "https://support.google.com/accounts/answer/3024190",
  googleTakeout: "https://takeout.google.com/settings/takeout",
  facebook: "https://www.facebook.com/help/212802592074644",
  instagram: "https://www.facebook.com/help/181231772500920",
  x: "https://help.x.com/en/managing-your-account/accessing-your-x-data",
} as const;

const GOOGLE_CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_CAPABILITY_META: Record<
  GoogleCapabilityId,
  { label: string; detail: string }
> = {
  gmail: {
    label: "Gmail",
    detail: "Read mail and prepare drafts through replay-safe Gmail sync.",
  },
  calendar: {
    label: "Calendar",
    detail:
      "Read events and allow create, update, and delete through the shared Calendar surface.",
  },
  contacts: {
    label: "Contacts",
    detail: "Sync People API contacts into the owner-local Personal Vault.",
  },
  youtube: {
    label: "YouTube",
    detail:
      "Read channel activity and comments, and reply to comments. Replying needs the force-ssl scope, which also allows deleting your own comments.",
  },
};

/**
 * The three principal shapes `POST /api/user/personal-vault/grants` accepts,
 * stated the way the owner has to reason about them: WHO does this authorize?
 *
 * The plan-template row deliberately points back at "Approve plan access" —
 * that path reads the scopes the template itself declared, so it cannot grant
 * more than the plan asked for. Minting one here takes the scopes from the
 * owner instead, which is strictly weaker evidence of what the plan needs.
 */
const PRINCIPAL_TYPE_META: Record<
  PersonalPrincipalType,
  { label: string; who: string; placeholder: string }
> = {
  "agent-role": {
    label: "Agent role",
    who: "every agent session running under this role",
    placeholder: "operator",
  },
  binding: {
    label: "Work item",
    who: "agents working this one work item, by its id",
    placeholder: "WI-10001783",
  },
  "plan-template": {
    label: "Plan template",
    who: "runs of this plan template",
    placeholder: "meeting-prep-brief",
  },
};

/**
 * Expiry choices for a hand-minted grant. `null` means no `expires_at`.
 *
 * A finite default is deliberate: the owner's own 2026-08-28 agent-role grant
 * carried a 10-minute expiry, so time-boxing is the shape actually reached for,
 * and the curl path this UI replaces makes `expiresAt` an easily-omitted field.
 */
const GRANT_EXPIRY_CHOICES: ReadonlyArray<{
  id: string;
  label: string;
  ms: number | null;
}> = [
  { id: "10m", label: "10 minutes", ms: 10 * 60_000 },
  { id: "1h", label: "1 hour", ms: 60 * 60_000 },
  { id: "24h", label: "24 hours", ms: 24 * 60 * 60_000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 60 * 60_000 },
  { id: "never", label: "Until I revoke it", ms: null },
];

function expiryIsoFor(choiceId: string): string | undefined {
  const ms = GRANT_EXPIRY_CHOICES.find((c) => c.id === choiceId)?.ms ?? null;
  return ms === null ? undefined : new Date(Date.now() + ms).toISOString();
}

export function googleWorkspaceConnectHref(
  includeCalendarWrite = true,
  providerAccountId?: string,
): string {
  const params = new URLSearchParams({
    provider: "google",
    plugin: "google-workspace",
    harness: "papercusp",
    field: "owner",
  });
  if (providerAccountId) params.set("account", providerAccountId);
  if (includeCalendarWrite) params.set("scopes", GOOGLE_CALENDAR_EVENTS_SCOPE);
  return "/api/oauth/start?" + params.toString();
}

export function facebookPersonalVaultConnectHref(
  providerAccountId?: string,
): string {
  const params = new URLSearchParams({
    provider: "facebook",
    plugin: "facebook-personal-vault",
    harness: "papercusp",
    field: "owner",
  });
  if (providerAccountId) params.set("account", providerAccountId);
  return "/api/oauth/start?" + params.toString();
}

async function responseJson<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => ({}))) as T & ApiFailure;
  if (!response.ok || value.ok === false) {
    throw new Error(value.error ?? `HTTP ${response.status}`);
  }
  return value;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  const amount = value / 1024 ** unit;
  return `${amount >= 100 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function importProgress(job: PersonalVaultImportJob): number {
  if (job.status === "completed") return 100;
  if (job.sizeBytes <= 0) return 0;
  return Math.max(
    0,
    Math.min(100, Math.floor((job.bytesProcessed / job.sizeBytes) * 100)),
  );
}

function importStatusLabel(status: PersonalVaultImportStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function purgeTargetLabel(target: PurgeTarget): string {
  if (!target.source) return "entire Personal Vault";
  const source = `personal:${target.source}`;
  return target.providerAccountId
    ? `${source} for ${target.providerAccountId}`
    : source;
}

function integrationStatusLabel(status: IntegrationStatus["status"]): string {
  if (status === "needs-app-config") return "Needs app setup";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function capabilityStatusLabel(
  status: GoogleCapabilityStatus["status"],
): string {
  if (status === "needs-app-config") return "Needs app setup";
  if (status === "needs-consent") return "Consent update required";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function activeGrant(grant: PersonalGrant): boolean {
  if (grant.revoked_at) return false;
  return !grant.expires_at || new Date(grant.expires_at).getTime() > Date.now();
}

export default function PersonalVaultSettingsPage() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importProviderAccountId, setImportProviderAccountId] = useState("");
  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget | null>(null);
  const [planSlug, setPlanSlug] = useState("");
  const [harnessSlug, setHarnessSlug] = useState("papercusp");
  const [grantPreview, setGrantPreview] = useState<GrantPreview | null>(null);
  const [directType, setDirectType] =
    useState<PersonalPrincipalType>("agent-role");
  const [directPrincipalId, setDirectPrincipalId] = useState("");
  const [directScopes, setDirectScopes] = useState<string[]>([]);
  const [directExpiry, setDirectExpiry] = useState("24h");
  const [directConfirmOpen, setDirectConfirmOpen] = useState(false);
  const [googleOAuthPending, setGoogleOAuthPending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const importJobsQuery = useSyncQuery<PersonalVaultImportJob>({
    queryName: "personalVault.importJobs",
    args: { userId: status?.user.id ?? "", limit: 50 },
    enabled: Boolean(status?.user.id),
  });
  const importJobs = importJobsQuery.data ?? [];

  const load = useCallback(async () => {
    try {
      const next = await responseJson<VaultStatus>(
        await fetch("/api/user/personal-vault", { cache: "no-store" }),
      );
      setStatus(next);
    } catch (err) {
      toast.error(`Personal Vault load failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!googleOAuthPending) return;

    let refreshing = false;
    const refreshAfterOAuth = () => {
      if (refreshing) return;
      refreshing = true;
      void load().finally(() => setGoogleOAuthPending(false));
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshAfterOAuth();
    };

    window.addEventListener("focus", refreshAfterOAuth);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshAfterOAuth);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [googleOAuthPending, load]);

  const startGoogleOAuth = useCallback(
    async (includeCalendarWrite = true, providerAccountId?: string) => {
      if (busy) return;
      const startHref = googleWorkspaceConnectHref(
        includeCalendarWrite,
        providerAccountId,
      );

      // A normal browser is already Google's supported user agent. Preserve the
      // existing redirect flow there; only the Tauri webview needs the explicit
      // server-URL → system-browser handoff.
      if (!isDesktop()) {
        window.location.assign(startHref);
        return;
      }

      const action = providerAccountId
        ? `oauth-google:${providerAccountId}`
        : "oauth-google:add";
      setBusy(action);
      try {
        const requestUrl = new URL(startHref, window.location.href);
        requestUrl.searchParams.set("response", "json");
        const result = await responseJson<{
          ok: true;
          authorizationUrl: string;
        }>(
          await fetch(requestUrl.pathname + requestUrl.search, {
            cache: "no-store",
          }),
        );
        let authorizationUrl: URL;
        try {
          authorizationUrl = new URL(result.authorizationUrl);
        } catch {
          throw new Error("OAuth server returned an unsafe authorization URL");
        }
        if (
          authorizationUrl.protocol !== "https:" ||
          authorizationUrl.hostname !== "accounts.google.com" ||
          !isExternalWebUrl(authorizationUrl.toString(), window.location.href)
        ) {
          throw new Error("OAuth server returned an unsafe authorization URL");
        }
        await openExternalWebUrl(authorizationUrl.toString());
        setGoogleOAuthPending(true);
        toast.success(
          "Google sign-in opened in your browser. Finish there, then return to Papercusp.",
        );
      } catch (err) {
        toast.error(`Couldn’t open Google sign-in: ${(err as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const liveGrants = useMemo(
    () => status?.grants.filter(activeGrant) ?? [],
    [status],
  );

  const archiveAccounts = useMemo(() => {
    const accounts = new Map<string, string>();
    for (const account of status?.integrations?.google.accounts ?? []) {
      accounts.set(
        account.providerAccountId,
        `Google · ${account.displayName}`,
      );
    }
    for (const account of status?.integrations?.facebook?.accounts ?? []) {
      const label = `Facebook · ${account.displayName}`;
      const existing = accounts.get(account.providerAccountId);
      accounts.set(
        account.providerAccountId,
        existing ? `${existing} / ${label}` : label,
      );
    }
    return [...accounts].map(([providerAccountId, label]) => ({
      providerAccountId,
      label,
    }));
  }, [status]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!status || busy) return;
      const previous = status.enabled;
      setStatus({ ...status, enabled });
      setBusy("enabled");
      try {
        await responseJson<{ ok: true; enabled: boolean }>(
          await fetch("/api/user/personal-vault", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled }),
          }),
        );
        toast.success(
          enabled
            ? "Personal Vault enabled."
            : "Personal Vault disabled. Imports and recall are stopped.",
        );
      } catch (err) {
        setStatus({ ...status, enabled: previous });
        toast.error(
          `Couldn’t update the kill switch: ${(err as Error).message}`,
        );
      } finally {
        setBusy(null);
      }
    },
    [busy, status],
  );

  const disconnectGoogle = useCallback(
    async (providerAccountId: string) => {
      if (!status || busy) return;
      setBusy(`disconnect-google:${providerAccountId}`);
      try {
        await responseJson<{ ok: true; disconnectedSources: number }>(
          await fetch(
            "/api/user/personal-vault/integrations/google?" +
              new URLSearchParams({ account: providerAccountId }).toString(),
            { method: "DELETE" },
          ),
        );
        toast.success(
          `${providerAccountId} disconnected. Existing Personal Vault documents were kept.`,
        );
        await load();
      } catch (err) {
        toast.error(
          "Google Workspace disconnect failed: " + (err as Error).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [busy, load, status],
  );

  const setGoogleCapability = useCallback(
    async (
      providerAccountId: string,
      capability: GoogleCapabilityId,
      enabled: boolean,
    ) => {
      if (!status || busy) return;
      setBusy(`google-capability:${providerAccountId}:${capability}`);
      try {
        await responseJson<{
          ok: true;
          capability: GoogleCapabilityId;
          enabled: boolean;
        }>(
          await fetch(
            "/api/user/personal-vault/integrations/google/capabilities",
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                providerAccountId,
                capability,
                enabled,
              }),
            },
          ),
        );
        toast.success(
          `${GOOGLE_CAPABILITY_META[capability].label} live sync ${enabled ? "enabled" : "disabled"}. Existing Personal Vault documents were kept.`,
        );
        await load();
      } catch (err) {
        toast.error(
          `Couldn’t update ${GOOGLE_CAPABILITY_META[capability].label}: ${(err as Error).message}`,
        );
      } finally {
        setBusy(null);
      }
    },
    [busy, load, status],
  );

  const disconnectFacebook = useCallback(
    async (providerAccountId: string) => {
      if (!status || busy) return;
      setBusy(`disconnect-facebook:${providerAccountId}`);
      try {
        await responseJson<{ ok: true; disconnectedSources: number }>(
          await fetch(
            "/api/user/personal-vault/integrations/facebook?" +
              new URLSearchParams({ account: providerAccountId }).toString(),
            { method: "DELETE" },
          ),
        );
        toast.success(
          `${providerAccountId} disconnected. Existing Personal Vault documents were kept.`,
        );
        await load();
      } catch (err) {
        toast.error("Facebook disconnect failed: " + (err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [busy, load, status],
  );

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!status?.enabled) {
        toast.error("Enable the Personal Vault before importing.");
        return;
      }
      const pending = Array.from(files);
      if (!pending.length) return;
      setBusy("import");
      try {
        let queued = 0;
        let duplicates = 0;
        for (const file of pending) {
          const result = await responseJson<{
            ok: true;
            duplicate: boolean;
            job: PersonalVaultImportJob;
          }>(
            await fetch(
              "/api/user/personal-vault/import" +
                (importProviderAccountId
                  ? `?${new URLSearchParams({
                      providerAccountId: importProviderAccountId,
                    }).toString()}`
                  : ""),
              {
                method: "POST",
                headers: {
                  "content-type": file.type || "application/octet-stream",
                  "x-papercusp-filename": encodeURIComponent(file.name),
                },
                body: file,
              },
            ),
          );
          queued += 1;
          if (result.duplicate) duplicates += 1;
        }
        toast.success(
          `Queued ${queued.toLocaleString()} archive${queued === 1 ? "" : "s"} for private background import${importProviderAccountId ? ` under ${importProviderAccountId}` : ""}${duplicates ? ` · ${duplicates} duplicate${duplicates === 1 ? "" : "s"} resumed` : ""}.`,
        );
        importJobsQuery.invalidate?.();
        await load();
      } catch (err) {
        toast.error(`Import failed: ${(err as Error).message}`);
      } finally {
        setBusy(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [
      importJobsQuery.invalidate,
      importProviderAccountId,
      load,
      status?.enabled,
    ],
  );

  const cancelImport = useCallback(
    async (job: PersonalVaultImportJob) => {
      if (busy) return;
      setBusy(`cancel-import:${job.id}`);
      try {
        await responseJson<{ ok: true; job: PersonalVaultImportJob }>(
          await fetch(
            `/api/user/personal-vault/imports?${new URLSearchParams({ id: job.id }).toString()}`,
            { method: "DELETE" },
          ),
        );
        toast.success(`Cancellation requested for ${job.filename}.`);
        importJobsQuery.invalidate?.();
      } catch (err) {
        toast.error(
          `Couldn’t cancel ${job.filename}: ${(err as Error).message}`,
        );
      } finally {
        setBusy(null);
      }
    },
    [busy, importJobsQuery.invalidate],
  );

  const retryImport = useCallback(
    async (job: PersonalVaultImportJob) => {
      if (busy) return;
      setBusy(`retry-import:${job.id}`);
      try {
        await responseJson<{ ok: true; job: PersonalVaultImportJob }>(
          await fetch("/api/user/personal-vault/imports/retry", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: job.id }),
          }),
        );
        toast.success(`Retry queued for ${job.filename}.`);
        importJobsQuery.invalidate?.();
      } catch (err) {
        toast.error(
          `Couldn’t retry ${job.filename}: ${(err as Error).message}`,
        );
      } finally {
        setBusy(null);
      }
    },
    [busy, importJobsQuery.invalidate],
  );

  const purge = useCallback(async () => {
    if (!purgeTarget) return;
    const { source, sourceId, providerAccountId } = purgeTarget;
    setBusy(`purge:${providerAccountId ?? sourceId ?? source ?? "all"}`);
    try {
      const result = await responseJson<{
        ok: true;
        removed: {
          documents: number;
          cursors: number;
          aliases: number;
          identities: number;
          importJobs: number;
          importArchives: number;
          importArchiveCleanupFailures: number;
        };
      }>(
        await fetch("/api/user/personal-vault", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source,
            sourceId,
            providerAccountId,
            confirm: true,
          }),
        }),
      );
      toast.success(
        `Purged ${result.removed.documents.toLocaleString()} document${result.removed.documents === 1 ? "" : "s"}${source ? ` from ${purgeTargetLabel(purgeTarget)}` : ""} and ${result.removed.importArchives.toLocaleString()} retained encrypted archive${result.removed.importArchives === 1 ? "" : "s"}.${result.removed.importArchiveCleanupFailures ? ` ${result.removed.importArchiveCleanupFailures.toLocaleString()} archive cleanup${result.removed.importArchiveCleanupFailures === 1 ? " is" : "s are"} queued for retry.` : ""}`,
      );
      setPurgeTarget(null);
      await load();
    } catch (err) {
      toast.error(`Purge failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [load, purgeTarget]);

  const previewPlanGrant = useCallback(async () => {
    if (!planSlug.trim()) return;
    setBusy("grant-preview");
    try {
      const preview = await responseJson<GrantPreview>(
        await fetch("/api/user/personal-vault/grants/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            planSlug: planSlug.trim(),
            harnessSlug: harnessSlug.trim() || undefined,
          }),
        }),
      );
      setGrantPreview(preview);
    } catch (err) {
      toast.error(`Couldn’t inspect that plan: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [harnessSlug, planSlug]);

  const approvePlanGrant = useCallback(async () => {
    if (!grantPreview) return;
    setBusy("grant-approve");
    try {
      await responseJson<{ ok: true }>(
        await fetch("/api/user/personal-vault/grants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            planSlug: grantPreview.planSlug,
            harnessSlug: grantPreview.harnessSlug,
          }),
        }),
      );
      toast.success(
        `Approved ${grantPreview.declaredScopes.length} Personal Vault scope${grantPreview.declaredScopes.length === 1 ? "" : "s"} for ${grantPreview.principalId}.`,
      );
      setGrantPreview(null);
      setPlanSlug("");
      await load();
    } catch (err) {
      toast.error(`Grant approval failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [grantPreview, load]);

  const createDirectGrant = useCallback(async () => {
    const principalId = directPrincipalId.trim();
    if (!principalId || !directScopes.length) return;
    setBusy("grant-direct");
    try {
      await responseJson<{ ok: true }>(
        await fetch("/api/user/personal-vault/grants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            principalType: directType,
            principalId,
            scopes: directScopes,
            expiresAt: expiryIsoFor(directExpiry),
          }),
        }),
      );
      toast.success(
        `Granted ${directScopes.length} Personal Vault scope${directScopes.length === 1 ? "" : "s"} to ${principalId}.`,
      );
      setDirectConfirmOpen(false);
      setDirectPrincipalId("");
      setDirectScopes([]);
      await load();
    } catch (err) {
      toast.error(`Grant failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [directExpiry, directPrincipalId, directScopes, directType, load]);

  const revoke = useCallback(
    async (grant: PersonalGrant) => {
      setBusy(`revoke:${grant.id}`);
      try {
        await responseJson<{ ok: true }>(
          await fetch(
            `/api/user/personal-vault/grants?id=${encodeURIComponent(grant.id)}`,
            { method: "DELETE" },
          ),
        );
        toast.success(
          `Revoked Personal Vault access for ${grant.principal_id}.`,
        );
        await load();
      } catch (err) {
        toast.error(`Revoke failed: ${(err as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const sourceColumns: TableColumn<SourceStats>[] = [
    {
      key: "source",
      header: "Source",
      render: (source) => <code>personal:{source.source}</code>,
    },
    {
      key: "records",
      header: "Records",
      headerStyle: { textAlign: "right" },
      cellStyle: { textAlign: "right" },
      render: (source) => source.documents.toLocaleString(),
    },
    {
      key: "account",
      header: "Account",
      render: (source) => source.provider_account_id ?? "Legacy / unattributed",
      cellTitle: (source) => source.source_id ?? undefined,
    },
    {
      key: "newest",
      header: "Newest",
      render: (source) => formatDate(source.newest_at),
    },
    {
      key: "actions",
      header: "",
      cellStyle: { textAlign: "right" },
      render: (source) => (
        <Button
          variant="destructive"
          aria-label={`Purge personal:${source.source}${source.provider_account_id ? ` for ${source.provider_account_id}` : ""}`}
          onClick={() =>
            setPurgeTarget({
              source: source.source,
              sourceId: source.source_id,
              providerAccountId: source.provider_account_id,
            })
          }
          disabled={busy !== null}
        >
          {source.provider_account_id ? "Purge account" : "Purge source"}
        </Button>
      ),
    },
  ];

  const importJobColumns: TableColumn<PersonalVaultImportJob>[] = [
    {
      key: "archive",
      header: "Archive",
      render: (job) => (
        <>
          <strong>{job.filename}</strong>
          <span className="pc-settings-note" style={{ display: "block" }}>
            {formatBytes(job.sizeBytes)} · added {formatDate(job.createdAt)}
          </span>
        </>
      ),
    },
    {
      key: "account",
      header: "Account",
      render: (job) =>
        job.providerAccountId ?? "Offline archive · unattributed",
      cellTitle: (job) => job.sourceId ?? undefined,
    },
    {
      key: "status",
      header: "Status",
      render: (job) => (
        <span aria-label={`${job.filename} import status: ${job.status}`}>
          {importStatusLabel(job.status)}
          {job.cancelRequested && job.status === "running"
            ? " · cancelling"
            : ""}
        </span>
      ),
    },
    {
      key: "progress",
      header: "Progress",
      render: (job) => {
        const percent = importProgress(job);
        return (
          <>
            <progress
              aria-label={`${job.filename} import progress`}
              max={100}
              value={percent}
              style={{ width: 150, maxWidth: "100%" }}
            />
            <span className="pc-settings-note" style={{ display: "block" }}>
              {percent}% · {formatBytes(job.bytesProcessed)} of{" "}
              {formatBytes(job.sizeBytes)} ·{" "}
              {job.documentsImported.toLocaleString()} imported
            </span>
            {job.lastError ? (
              <span style={{ display: "block", color: "var(--bad)" }}>
                {job.lastError}
              </span>
            ) : job.warnings.length ? (
              <span className="pc-settings-note" style={{ display: "block" }}>
                {job.warnings.length.toLocaleString()} warning
                {job.warnings.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </>
        );
      },
    },
    {
      key: "actions",
      header: "",
      cellStyle: { textAlign: "right" },
      render: (job) => (
        <div className="pc-settings-actions">
          {job.status === "queued" || job.status === "running" ? (
            <Button
              variant="destructive"
              aria-label={`Cancel import ${job.filename}`}
              disabled={busy !== null || job.cancelRequested}
              onClick={() => void cancelImport(job)}
            >
              {busy === `cancel-import:${job.id}` || job.cancelRequested
                ? "Cancelling…"
                : "Cancel"}
            </Button>
          ) : null}
          {job.status === "failed" ? (
            <Button
              variant="primary"
              aria-label={`Retry import ${job.filename}`}
              disabled={busy !== null}
              onClick={() => void retryImport(job)}
            >
              {busy === `retry-import:${job.id}` ? "Queuing…" : "Retry"}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const grantColumns: TableColumn<PersonalGrant>[] = [
    {
      key: "principal",
      header: "Principal",
      render: (grant) => (
        <>
          <strong>{grant.principal_id}</strong>
          <span className="pc-settings-note" style={{ display: "block" }}>
            {grant.principal_type}
          </span>
        </>
      ),
    },
    {
      key: "scopes",
      header: "Scopes",
      render: (grant) => (
        <>
          {grant.scopes.map((scope) => (
            <code key={scope} style={{ marginRight: 6 }}>
              {scope}
            </code>
          ))}
        </>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (grant) => {
        const active = activeGrant(grant);
        return active ? "Active" : grant.revoked_at ? "Revoked" : "Expired";
      },
    },
    {
      key: "granted",
      header: "Granted",
      render: (grant) => formatDate(grant.granted_at),
    },
    {
      key: "actions",
      header: "",
      cellStyle: { textAlign: "right" },
      render: (grant) => {
        const active = activeGrant(grant);
        return active ? (
          <Button
            variant="destructive"
            onClick={() => void revoke(grant)}
            disabled={busy !== null}
          >
            {busy === `revoke:${grant.id}` ? "Revoking…" : "Revoke"}
          </Button>
        ) : null;
      },
    },
  ];

  if (loading || !status) {
    return (
      <main className="pc-settings-page pc-personal-vault">
        <h1>Personal Vault</h1>
        <p role="status">Loading…</p>
      </main>
    );
  }

  const googleAccounts = (status.integrations?.google.accounts ??
    []) as GoogleAccountStatus[];
  const facebookAccounts = (status.integrations?.facebook?.accounts ??
    []) as FacebookAccountStatus[];
  const connectedAccounts = [...googleAccounts, ...facebookAccounts].filter(
    (account) => account.connected,
  );
  const totalDocuments = status.stats.sources.reduce(
    (total, source) => total + source.documents,
    0,
  );
  const activeImports = importJobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );
  const failedImports = importJobs.filter((job) => job.status === "failed");
  const setupSteps = [
    {
      number: 1,
      title: "Connect accounts",
      detail: connectedAccounts.length
        ? `${connectedAccounts.length.toLocaleString()} account${connectedAccounts.length === 1 ? "" : "s"} connected`
        : "Connect Google or Facebook",
      complete: connectedAccounts.length > 0,
    },
    {
      number: 2,
      title: "Bring in history",
      detail: totalDocuments
        ? `${totalDocuments.toLocaleString()} records stored`
        : "Import a provider archive",
      complete: totalDocuments > 0,
    },
    {
      number: 3,
      title: "Confirm progress",
      detail: failedImports.length
        ? `${failedImports.length.toLocaleString()} import${failedImports.length === 1 ? "" : "s"} need attention`
        : activeImports.length
          ? `${activeImports.length.toLocaleString()} import${activeImports.length === 1 ? "" : "s"} in progress`
          : totalDocuments
            ? "Everything looks healthy"
            : "Progress appears here",
      complete: totalDocuments > 0 && failedImports.length === 0,
    },
  ];
  const recommendedAction = !status.enabled
    ? "Enable the Personal Vault to resume imports and live sync."
    : failedImports.length
      ? "Review the failed archive import below, then retry it."
      : connectedAccounts.length === 0
        ? "Connect your first Google or Facebook account."
        : totalDocuments === 0 && activeImports.length === 0
          ? "Choose the account that owns your archive, then import its history."
          : activeImports.length
            ? "Your archive is importing in the background. You can leave this page."
            : "Your vault is healthy. Add another account or import another archive when ready.";

  return (
    <main className="pc-settings-page pc-personal-vault">
      <header className="pc-vault-hero">
        <div>
          <span className="pc-vault-eyebrow">Private data hub</span>
          <h1>Personal Vault</h1>
        </div>
        <span
          className={`pc-vault-health ${status.enabled ? "is-ready" : "is-paused"}`}
          role="status"
        >
          <span aria-hidden="true">{status.enabled ? "●" : "○"}</span>
          {status.enabled ? "Vault on" : "Vault paused"}
        </span>
        <p className="pc-settings-intro">
          Connect accounts, bring in your history, and see what is safely stored
          on this device. Personal content stays outside normal agent recall and
          its vectors are produced only by the local EmbeddingGemma model.
        </p>
      </header>

      <section
        className="pc-settings-section pc-vault-overview"
        aria-labelledby="vault-setup-heading"
      >
        <div className="pc-vault-section-heading">
          <div>
            <span className="pc-vault-eyebrow">Start here</span>
            <h2 id="vault-setup-heading">Your setup</h2>
          </div>
          <label className="pc-vault-enable-control">
            <Checkbox
              checked={status.enabled}
              onChange={(value) => void setEnabled(value)}
              disabled={busy === "enabled"}
              ariaLabel="Enable Personal Vault imports and granted recall"
            />
            <span>
              <strong>{status.enabled ? "Enabled" : "Paused"}</strong>
              <span className="pc-settings-note">
                {status.enabled
                  ? "Local sync and imports are running"
                  : "Your data is retained"}
              </span>
            </span>
          </label>
        </div>
        <p className="pc-settings-note pc-vault-pause-note">
          Pausing immediately blocks imports, live ingestion, search, and
          granted recall. It does not delete anything.
        </p>

        <ol
          className="pc-vault-steps"
          aria-label="Personal Vault setup progress"
        >
          {setupSteps.map((step) => (
            <li
              key={step.number}
              className={step.complete ? "is-complete" : ""}
            >
              <span className="pc-vault-step-number" aria-hidden="true">
                {step.complete ? "✓" : step.number}
              </span>
              <span>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>

        <div className="pc-vault-next-action" role="note">
          <span className="pc-vault-next-icon" aria-hidden="true">
            →
          </span>
          <span>
            <strong>Recommended next step</strong>
            <span>{recommendedAction}</span>
          </span>
        </div>

        <dl className="pc-vault-summary" aria-label="Personal Vault summary">
          <div>
            <dt>Connected accounts</dt>
            <dd>{connectedAccounts.length.toLocaleString()}</dd>
            <span>
              {googleAccounts.length} Google · {facebookAccounts.length}{" "}
              Facebook
            </span>
          </div>
          <div>
            <dt>Records stored</dt>
            <dd>{totalDocuments.toLocaleString()}</dd>
            <span>
              {status.stats.unembedded.toLocaleString()} awaiting local
              embedding
            </span>
          </div>
          <div>
            <dt>Import activity</dt>
            <dd>
              {activeImports.length ? `${activeImports.length} active` : "Idle"}
            </dd>
            <span>
              {failedImports.length
                ? `${failedImports.length} need attention`
                : "No failures"}
            </span>
          </div>
          <div>
            <dt>Privacy</dt>
            <dd>Local only</dd>
            <span>
              {liveGrants.length.toLocaleString()} active agent grant
              {liveGrants.length === 1 ? "" : "s"}
            </span>
          </div>
        </dl>
      </section>

      <section
        className="pc-settings-section pc-vault-step-section"
        aria-labelledby="vault-integrations-heading"
      >
        <span className="pc-vault-step-kicker">Step 1</span>
        <h2 id="vault-integrations-heading">Live integrations</h2>
        <p className="pc-settings-note">
          Add each account once. Use Reconnect only to repair an account that is
          already listed. OAuth tokens stay server-side.
        </p>
        <div
          className="pc-settings-note"
          role="note"
          aria-label="Live integration privacy"
          style={{
            marginTop: 12,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 10,
          }}
        >
          <strong>Private by default.</strong> Live records are written only to
          your owner-bound Personal Vault. Disconnect stops future polling and
          clears the local token; it never deletes settled documents. Purge
          remains a separate, explicit action below.
        </div>
        {(() => {
          const google = status.integrations?.google ?? {
            provider: "google" as const,
            configured: false,
            connected: false,
            status: "needs-app-config" as const,
            sources: [],
          };
          const accounts = (google.accounts ?? []) as GoogleAccountStatus[];
          return (
            <article
              className="pc-vault-provider-card"
              aria-labelledby="vault-google-heading"
              style={{
                marginTop: 16,
                padding: 16,
                border: "1px solid var(--border)",
                borderRadius: 10,
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "start",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <h3 id="vault-google-heading" style={{ marginTop: 0 }}>
                    Google Workspace
                  </h3>
                  <p className="pc-settings-note">
                    Each Google account keeps its own OAuth credential, sync
                    cursors, and capability controls. Gmail uses provider push
                    notifications plus replay-safe incremental history sync.
                  </p>
                </div>
                <strong
                  aria-label={"Google Workspace status: " + google.status}
                >
                  {integrationStatusLabel(google.status)}
                </strong>
              </div>
              {accounts.length ? (
                <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
                  {accounts.map((account, accountIndex) => {
                    const accountHeadingId = `vault-google-account-${accountIndex}`;
                    const calendar = account.capabilities.find(
                      (capability) => capability.id === "calendar",
                    );
                    return (
                      <section
                        className="pc-vault-account-card"
                        key={account.providerAccountId}
                        aria-labelledby={accountHeadingId}
                        style={{
                          padding: 14,
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: 12,
                            alignItems: "start",
                            justifyContent: "space-between",
                          }}
                        >
                          <div>
                            <h4 id={accountHeadingId} style={{ margin: 0 }}>
                              {account.displayName}
                            </h4>
                            {account.displayName !==
                            account.providerAccountId ? (
                              <p
                                className="pc-settings-note"
                                style={{ margin: "4px 0 0" }}
                              >
                                {account.providerAccountId}
                              </p>
                            ) : null}
                          </div>
                          <strong
                            aria-label={`${account.displayName} status: ${account.status}`}
                          >
                            {integrationStatusLabel(account.status)}
                          </strong>
                        </div>
                        <details className="pc-vault-account-details">
                          <summary>Manage synced services</summary>
                          <fieldset>
                            <legend className="pc-vault-visually-hidden">
                              Account capabilities
                            </legend>
                            <div style={{ display: "grid", gap: 10 }}>
                              {account.capabilities.map((capability) => {
                                const meta =
                                  GOOGLE_CAPABILITY_META[capability.id];
                                return (
                                  <label
                                    key={capability.id}
                                    style={{
                                      display: "flex",
                                      alignItems: "flex-start",
                                      gap: 10,
                                    }}
                                  >
                                    <Checkbox
                                      checked={capability.enabled}
                                      disabled={
                                        !account.connected || busy !== null
                                      }
                                      onChange={(enabled) =>
                                        void setGoogleCapability(
                                          account.providerAccountId,
                                          capability.id,
                                          enabled,
                                        )
                                      }
                                      ariaLabel={`Enable ${meta.label} live sync for ${account.displayName}`}
                                    />
                                    <span style={{ flex: 1 }}>
                                      <span
                                        style={{
                                          display: "flex",
                                          gap: 8,
                                          justifyContent: "space-between",
                                        }}
                                      >
                                        <strong>{meta.label}</strong>
                                        <span
                                          aria-label={`${meta.label} capability status for ${account.displayName}: ${capability.status}`}
                                        >
                                          {capabilityStatusLabel(
                                            capability.status,
                                          )}
                                        </span>
                                      </span>
                                      <span
                                        className="pc-settings-note"
                                        style={{ display: "block" }}
                                      >
                                        {meta.detail}
                                      </span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                            <p
                              className="pc-settings-note"
                              style={{ marginBottom: 0 }}
                            >
                              Turning off one capability affects only this
                              account and surface. Its other live syncs and
                              settled Vault documents remain available.
                            </p>
                          </fieldset>
                        </details>
                        {calendar?.status === "needs-consent" ? (
                          <div
                            className="pc-settings-note"
                            role="status"
                            aria-label={`Calendar consent upgrade required for ${account.displayName}`}
                            style={{
                              marginTop: 12,
                              padding: 12,
                              border: "1px solid var(--warn, #fbbf24)",
                              borderRadius: 8,
                            }}
                          >
                            Calendar read sync remains available, but create,
                            update, and delete require renewed consent for this
                            account. The reconnect is account-targeted and never
                            creates a second source for the same identity.
                          </div>
                        ) : null}
                        {account.sources.length ? (
                          <dl className="pc-settings-status">
                            {account.sources.map((source) => (
                              <div key={source.kind}>
                                <dt>
                                  {source.kind === "gcal"
                                    ? "Calendar"
                                    : source.kind}
                                </dt>
                                <dd>
                                  {sourceStatusDetail(source)}
                                  {source.lastError ? (
                                    <span
                                      style={{
                                        display: "block",
                                        color: "var(--bad)",
                                      }}
                                    >
                                      {source.lastError}
                                    </span>
                                  ) : null}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                        <div
                          className="pc-settings-actions"
                          style={{ marginTop: 12 }}
                        >
                          <Button
                            variant="primary"
                            disabled={!google.configured || busy !== null}
                            onClick={() =>
                              void startGoogleOAuth(
                                calendar?.enabled !== false,
                                account.providerAccountId,
                              )
                            }
                          >
                            {busy ===
                            `oauth-google:${account.providerAccountId}`
                              ? "Opening browser…"
                              : `Reconnect ${account.displayName}`}
                          </Button>
                          {account.connected ? (
                            <Button
                              variant="destructive"
                              disabled={busy !== null}
                              onClick={() =>
                                void disconnectGoogle(account.providerAccountId)
                              }
                            >
                              {busy ===
                              `disconnect-google:${account.providerAccountId}`
                                ? "Disconnecting…"
                                : `Disconnect ${account.displayName}`}
                            </Button>
                          ) : null}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : google.configured ? (
                <p className="pc-settings-note" role="status">
                  No Google accounts are connected yet.
                </p>
              ) : null}
              {!google.configured ? (
                <p className="pc-settings-note" role="status">
                  Add a Google Desktop OAuth client at{" "}
                  ~/.config/papercusp/google-oauth-client.json to enable consent
                  on this machine.
                </p>
              ) : null}
              <div className="pc-settings-actions" style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  disabled={!google.configured || busy !== null}
                  onClick={() => void startGoogleOAuth(true)}
                >
                  {busy === "oauth-google:add"
                    ? "Opening browser…"
                    : "Add Google account"}
                </Button>
              </div>
              {googleOAuthPending ? (
                <p className="pc-settings-note" role="status">
                  Google sign-in is open in your browser. Finish the consent
                  flow there, then return to Papercusp; this page will refresh
                  your connection status.
                </p>
              ) : null}
              <p className="pc-settings-note" style={{ marginBottom: 0 }}>
                Add Account always starts a new consent flow. Reconnect and
                Disconnect are scoped to the selected account and keep settled
                documents; use Purge only for verified deletion.
              </p>
            </article>
          );
        })()}
        {(() => {
          const facebook = status.integrations?.facebook ?? {
            provider: "facebook" as const,
            configured: false,
            connected: false,
            status: "needs-app-config" as const,
            sources: [],
          };
          const accounts = (facebook.accounts ?? []) as FacebookAccountStatus[];
          return (
            <article
              className="pc-vault-provider-card"
              aria-labelledby="vault-facebook-heading"
              style={{
                marginTop: 16,
                padding: 16,
                border: "1px solid var(--border)",
                borderRadius: 10,
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "start",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <h3 id="vault-facebook-heading" style={{ marginTop: 0 }}>
                    Facebook
                  </h3>
                  <p className="pc-settings-note">
                    Live coverage is limited to your profile, your posts, and
                    photo metadata that Meta authorizes for this app. It does
                    not include Messenger, friends, private groups, ads/activity
                    logs, or a complete historical corpus.
                  </p>
                </div>
                <strong aria-label={"Facebook status: " + facebook.status}>
                  {integrationStatusLabel(facebook.status)}
                </strong>
              </div>
              {accounts.length ? (
                <div style={{ display: "grid", gap: 12 }}>
                  {accounts.map((account) => (
                    <section
                      key={account.providerAccountId}
                      aria-label={`Facebook account ${account.displayName}`}
                      style={{
                        padding: 12,
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 12,
                          alignItems: "center",
                          justifyContent: "space-between",
                        }}
                      >
                        <h4 style={{ margin: 0 }}>{account.displayName}</h4>
                        <strong
                          aria-label={`${account.displayName} Facebook status: ${account.status}`}
                        >
                          {integrationStatusLabel(account.status)}
                        </strong>
                      </div>
                      <dl className="pc-settings-status">
                        {account.sources.map((source) => (
                          <div
                            key={`${source.kind}:${source.providerAccountId ?? account.providerAccountId}`}
                          >
                            <dt>Profile, posts, photo metadata</dt>
                            <dd>
                              {sourceStatusDetail(source)}
                              {source.lastError ? (
                                <span
                                  style={{ display: "block", color: "var(--bad)" }}
                                >
                                  {source.lastError}
                                </span>
                              ) : null}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      <div
                        className="pc-settings-actions"
                        style={{ marginTop: 12 }}
                      >
                        <Button
                          disabled={!facebook.configured || busy !== null}
                          onClick={() =>
                            window.location.assign(
                              facebookPersonalVaultConnectHref(
                                account.providerAccountId,
                              ),
                            )
                          }
                        >
                          Reconnect {account.displayName}
                        </Button>
                        {account.connected ? (
                          <Button
                            variant="destructive"
                            disabled={busy !== null}
                            onClick={() =>
                              void disconnectFacebook(account.providerAccountId)
                            }
                          >
                            {busy ===
                            `disconnect-facebook:${account.providerAccountId}`
                              ? "Disconnecting…"
                              : `Disconnect ${account.displayName}`}
                          </Button>
                        ) : null}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="pc-settings-note">
                  No Facebook accounts are connected yet.
                </p>
              )}
              {!facebook.configured ? (
                <p className="pc-settings-note" role="status">
                  Add a Meta app client ID and <code>clientSecretFile</code> to{" "}
                  ~/.papercusp/oauth-apps.json. The <code>user_posts</code> and{" "}
                  <code>user_photos</code> permissions may require Meta app
                  review.
                </p>
              ) : null}
              <div className="pc-settings-actions" style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  disabled={!facebook.configured || busy !== null}
                  onClick={() =>
                    window.location.assign(facebookPersonalVaultConnectHref())
                  }
                >
                  {accounts.length
                    ? "Add Facebook Account"
                    : "Connect Facebook"}
                </Button>
              </div>
              <p className="pc-settings-note">
                Add Account always starts a new consent flow. Reconnect and
                Disconnect are scoped to the selected account and keep settled
                documents; use Purge only for verified deletion.
              </p>
              <p className="pc-settings-note" style={{ marginBottom: 0 }}>
                For fuller Facebook history—especially Messages—use the archive
                export and local importer below. Live connection and archive
                import complement each other.
              </p>
            </article>
          );
        })()}
      </section>

      <section
        className="pc-settings-section pc-vault-step-section"
        aria-labelledby="vault-import-heading"
      >
        <span className="pc-vault-step-kicker">Step 2</span>
        <h2 id="vault-import-heading">Import archives</h2>
        <p className="pc-settings-note">
          First choose which account owns the archive, then choose or drop the
          file. Imports continue safely in the background.
        </p>
        <label style={{ display: "block", maxWidth: 520, marginTop: 16 }}>
          <span style={{ display: "block", marginBottom: 4 }}>
            Archive account
          </span>
          <Select
            ariaLabel="Archive account"
            value={importProviderAccountId || UNATTRIBUTED_ACCOUNT}
            onChange={(value) =>
              setImportProviderAccountId(
                value === UNATTRIBUTED_ACCOUNT ? "" : value,
              )
            }
            disabled={busy === "import"}
            options={[
              {
                value: UNATTRIBUTED_ACCOUNT,
                label: "Offline archive · leave unattributed",
              },
              ...archiveAccounts.map((account) => ({
                value: account.providerAccountId,
                label: account.label,
              })),
            ]}
          />
          <span className="pc-settings-note" style={{ display: "block" }}>
            Choose the provider account this export belongs to so imported
            records stay isolated in search, dedupe, status, and purge.
          </span>
        </label>
        <p
          className="pc-settings-note"
          aria-label="Archive storage forecast"
          style={{ marginTop: 12 }}
        >
          <strong>Encrypted archive storage:</strong>{" "}
          {status.importStorage ? (
            <>
              {formatBytes(status.importStorage.owner.usedBytes)} of{" "}
              {formatBytes(status.importStorage.owner.maxBytes)} owner capacity
              · {status.importStorage.owner.jobs.toLocaleString()} of{" "}
              {status.importStorage.owner.maxJobs.toLocaleString()} retained or
              reserved jobs. Current usage is{" "}
              {formatBytes(status.importStorage.owner.retainedBytes)} retained +{" "}
              {formatBytes(status.importStorage.owner.reservedBytes)} reserved
              while uploads are in flight.
            </>
          ) : (
            "Storage forecast unavailable until the operator sidecar finishes updating."
          )}
        </p>
        <details className="pc-vault-disclosure">
          <summary>How to get an archive from each provider</summary>
          <div
            className="pc-settings-note"
            aria-labelledby="vault-archive-help-heading"
            style={{
              marginTop: 16,
              padding: 16,
              border: "1px solid var(--border)",
              borderRadius: 10,
            }}
          >
            <h3 id="vault-archive-help-heading" style={{ marginTop: 0 }}>
              How to get an archive
            </h3>
            <ol
              style={{
                display: "grid",
                gap: 14,
                marginBottom: 0,
                paddingLeft: 22,
              }}
            >
              <li>
                <strong>Gmail, Google Calendar, and Google Contacts:</strong>{" "}
                open{" "}
                <a
                  href={ARCHIVE_HELP.googleTakeout}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Google Takeout
                </a>
                , choose only <em>Mail</em>, <em>Calendar</em>, and{" "}
                <em>Contacts</em>, keep ZIP as the delivery format, create the
                export, then download every ZIP part to this computer.
                Google&apos;s{" "}
                <a
                  href={ARCHIVE_HELP.google}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  official download guide
                </a>{" "}
                explains the export and delivery choices.
              </li>
              <li>
                <strong>Facebook:</strong> follow Meta&apos;s{" "}
                <a
                  href={ARCHIVE_HELP.facebook}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Export your information guide
                </a>
                : Settings &amp; privacy → Accounts Center → Your information
                and permissions → Export your information → Create export →
                Export to device. Choose <em>Messages</em>, all time, and{" "}
                <em>JSON</em>, then import the downloaded ZIP here. Meta keeps a
                prepared download available for a limited time.
              </li>
              <li>
                <strong>Instagram:</strong> use the same Accounts Center flow
                and select the Instagram profile. Choose <em>Messages</em> and{" "}
                <em>JSON</em>; see Meta&apos;s{" "}
                <a
                  href={ARCHIVE_HELP.instagram}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Instagram export guide
                </a>
                .
              </li>
              <li>
                <strong>X:</strong> Settings and privacy → Your account →
                Download an archive of your data → Request archive. When X
                notifies you, download the ZIP and import it here. See the{" "}
                <a
                  href={ARCHIVE_HELP.x}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  official X archive guide
                </a>
                .
              </li>
            </ol>
            <p style={{ marginBottom: 0 }}>
              Archive files can contain highly private information. Keep them on
              this machine and delete the downloaded copies when you no longer
              need them.
            </p>
          </div>
        </details>
        <div
          role="button"
          tabIndex={0}
          aria-label="Choose or drop Personal Vault archive files"
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ")
              fileInput.current?.click();
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void importFiles(event.dataTransfer.files);
          }}
          style={{
            marginTop: 12,
            padding: "28px 20px",
            borderRadius: 10,
            cursor:
              status.enabled && busy !== "import" ? "pointer" : "not-allowed",
            border: `2px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
            background: dragging
              ? "color-mix(in srgb, var(--accent) 10%, var(--bg-2))"
              : "var(--bg-2)",
            opacity: status.enabled ? 1 : 0.6,
          }}
        >
          <strong>
            {busy === "import"
              ? "Importing locally…"
              : "Drop archive files here"}
          </strong>
          <span
            className="pc-settings-note"
            style={{ display: "block", marginTop: 4 }}
          >
            or click to choose files · duplicates are updated by stable source
            keys
          </span>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          disabled={!status.enabled || busy === "import"}
          accept=".zip,.mbox,.ics,.vcf,.json,.js"
          onChange={(event) =>
            event.target.files && void importFiles(event.target.files)
          }
        />
        <div aria-live="polite" style={{ marginTop: 20 }}>
          <span className="pc-vault-step-kicker">Step 3</span>
          <h3>Archive activity</h3>
          {importJobsQuery.error ? (
            <p role="alert">
              Import activity unavailable: {importJobsQuery.error.message}
            </p>
          ) : importJobsQuery.loading ? (
            <p role="status">Loading import activity…</p>
          ) : importJobs.length ? (
            <div style={{ overflowX: "auto" }}>
              <Table
                columns={importJobColumns}
                rows={importJobs}
                getRowKey={(job) => job.id}
              />
            </div>
          ) : (
            <p className="pc-settings-note">No archive imports queued yet.</p>
          )}
        </div>
      </section>

      <details className="pc-vault-advanced-disclosure">
        <summary>
          <span>
            <strong>Advanced privacy and access controls</strong>
            <span>
              Inspect source attribution, delete data, or manage agent grants
            </span>
          </span>
        </summary>
        <div className="pc-vault-advanced-content">
          <section
            className="pc-settings-section pc-vault-advanced-section"
            aria-labelledby="vault-sources-heading"
          >
            <span className="pc-vault-eyebrow">Advanced</span>
            <h2 id="vault-sources-heading">Imported sources</h2>
            {status.stats.sources.length ? (
              <div style={{ overflowX: "auto" }}>
                <Table
                  columns={sourceColumns}
                  rows={status.stats.sources}
                  getRowKey={(source) =>
                    JSON.stringify([
                      source.source,
                      source.source_id,
                      source.provider_account_id,
                    ])
                  }
                />
              </div>
            ) : (
              <p className="pc-settings-note">
                No personal records imported yet.
              </p>
            )}
            <div className="pc-settings-actions" style={{ marginTop: 16 }}>
              <Button
                variant="destructive"
                onClick={() =>
                  setPurgeTarget({
                    source: null,
                    sourceId: null,
                    providerAccountId: null,
                  })
                }
                disabled={busy !== null}
              >
                Purge entire vault
              </Button>
            </div>
          </section>

          <section
            className="pc-settings-section pc-vault-advanced-section"
            aria-labelledby="vault-plan-grant-heading"
          >
            <span className="pc-vault-eyebrow">Advanced</span>
            <h2 id="vault-plan-grant-heading">Approve plan access</h2>
            <p className="pc-settings-note">
              A plan template must declare <code>personalScopes</code> in its
              frontmatter. Preview reads that declaration from the canonical
              plan; approval cannot add scopes the template did not declare.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(220px, 2fr) minmax(160px, 1fr) auto",
                gap: 10,
                alignItems: "end",
                maxWidth: 840,
              }}
            >
              <label>
                <span style={{ display: "block", marginBottom: 4 }}>
                  Plan slug
                </span>
                <input
                  value={planSlug}
                  onChange={(event) => setPlanSlug(event.target.value)}
                  placeholder="meeting-prep-brief"
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4 }}>
                  Harness
                </span>
                <input
                  value={harnessSlug}
                  onChange={(event) => setHarnessSlug(event.target.value)}
                  placeholder="papercusp"
                />
              </label>
              <Button
                variant="primary"
                onClick={() => void previewPlanGrant()}
                disabled={!planSlug.trim() || busy !== null}
              >
                {busy === "grant-preview" ? "Inspecting…" : "Review access"}
              </Button>
            </div>
          </section>

          <section
            className="pc-settings-section pc-vault-advanced-section"
            aria-labelledby="vault-direct-grant-heading"
          >
            <span className="pc-vault-eyebrow">Advanced</span>
            <h2 id="vault-direct-grant-heading">Grant access directly</h2>
            <p className="pc-settings-note">
              For access that is not tied to a plan template — an agent role, or
              a single work item. You choose the scopes here, so prefer “Approve
              plan access” above whenever a plan declares what it needs.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(160px, 1fr) minmax(220px, 2fr)",
                gap: 10,
                alignItems: "end",
                maxWidth: 840,
              }}
            >
              <label>
                <span style={{ display: "block", marginBottom: 4 }}>
                  Grant to
                </span>
                <Select
                  ariaLabel="Principal type"
                  value={directType}
                  onChange={(value) =>
                    setDirectType(value as PersonalPrincipalType)
                  }
                  disabled={busy !== null}
                  options={(
                    Object.keys(PRINCIPAL_TYPE_META) as PersonalPrincipalType[]
                  ).map((type) => ({
                    value: type,
                    label: PRINCIPAL_TYPE_META[type].label,
                  }))}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4 }}>
                  {PRINCIPAL_TYPE_META[directType].label} identifier
                </span>
                <input
                  value={directPrincipalId}
                  onChange={(event) =>
                    setDirectPrincipalId(event.target.value)
                  }
                  placeholder={PRINCIPAL_TYPE_META[directType].placeholder}
                />
              </label>
            </div>

            <fieldset
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 14px 14px",
                margin: "14px 0 0",
                maxWidth: 840,
              }}
            >
              <legend style={{ padding: "0 6px", fontSize: 12 }}>
                Scopes to authorize
              </legend>
              {Object.entries(GOOGLE_CAPABILITY_META).map(([id, meta]) => {
                const scope = `personal:${id}`;
                const checked = directScopes.includes(scope);
                return (
                  <label
                    key={scope}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      marginTop: 8,
                    }}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={busy !== null}
                      onChange={(next) =>
                        setDirectScopes((prev) =>
                          next
                            ? [...prev, scope]
                            : prev.filter((s) => s !== scope),
                        )
                      }
                      ariaLabel={`Authorize ${meta.label}`}
                    />
                    <span>
                      <strong>{meta.label}</strong> <code>{scope}</code>
                      <span
                        className="pc-settings-note"
                        style={{ display: "block" }}
                      >
                        {meta.detail}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(200px, 1fr) auto",
                gap: 10,
                alignItems: "end",
                maxWidth: 840,
                marginTop: 14,
              }}
            >
              <label>
                <span style={{ display: "block", marginBottom: 4 }}>
                  Expires
                </span>
                <Select
                  ariaLabel="Grant expiry"
                  value={directExpiry}
                  onChange={setDirectExpiry}
                  disabled={busy !== null}
                  options={GRANT_EXPIRY_CHOICES.map((choice) => ({
                    value: choice.id,
                    label: choice.label,
                  }))}
                />
              </label>
              <Button
                variant="primary"
                onClick={() => setDirectConfirmOpen(true)}
                disabled={
                  !directPrincipalId.trim() ||
                  !directScopes.length ||
                  busy !== null
                }
              >
                Review grant
              </Button>
            </div>

            {directType === "agent-role" &&
            isCodingAgentRole(directPrincipalId) ? (
              <p
                role="alert"
                className="pc-settings-note"
                style={{ marginTop: 12, color: "var(--bad)" }}
              >
                <code>{directPrincipalId.trim()}</code> is a coding or review
                role. Those are denied Personal Vault access before any grant is
                consulted, so this grant would be created but would authorize
                nothing.
              </p>
            ) : null}
          </section>

          <section
            className="pc-settings-section pc-vault-advanced-section"
            aria-labelledby="vault-grants-heading"
          >
            <span className="pc-vault-eyebrow">Advanced</span>
            <h2 id="vault-grants-heading">Grant history</h2>
            {status.grants.length ? (
              <div style={{ overflowX: "auto" }}>
                <Table
                  columns={grantColumns}
                  rows={status.grants}
                  getRowKey={(grant) => grant.id}
                />
              </div>
            ) : (
              <p className="pc-settings-note">
                No Personal Vault grants have been approved.
              </p>
            )}
          </section>
        </div>
      </details>

      <Modal
        open={purgeTarget !== null}
        onOpenChange={(open) => !open && setPurgeTarget(null)}
        title={
          purgeTarget
            ? `Purge ${purgeTargetLabel(purgeTarget)}`
            : "Purge Personal Vault"
        }
        description="This permanently deletes Personal Vault documents, vectors, cursors, and orphaned identity data."
        contentStyle={{
          width: "min(520px, calc(100vw - 4rem))",
          padding: 22,
          borderRadius: 12,
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
        }}
      >
        <h2>
          {purgeTarget
            ? `Purge ${purgeTargetLabel(purgeTarget)}?`
            : "Purge Personal Vault?"}
        </h2>
        <p>
          This permanently removes the selected documents, their local vectors,
          sync cursor, source aliases, and identities no longer referenced by
          another source. Grant history is retained for audit.
        </p>
        <div
          className="pc-settings-actions"
          style={{ justifyContent: "flex-end" }}
        >
          <Button
            onClick={() => setPurgeTarget(null)}
            disabled={busy?.startsWith("purge:")}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void purge()}
            disabled={busy?.startsWith("purge:")}
          >
            {busy?.startsWith("purge:") ? "Purging…" : "Permanently purge"}
          </Button>
        </div>
      </Modal>

      <Modal
        open={grantPreview !== null}
        onOpenChange={(open) => !open && setGrantPreview(null)}
        title="Approve Personal Vault access"
        description="Review the exact personal scopes declared by this plan template before granting access."
        contentStyle={{
          width: "min(560px, calc(100vw - 4rem))",
          padding: 22,
          borderRadius: 12,
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
        }}
      >
        <h2>Approve access for {grantPreview?.principalId}</h2>
        <p className="pc-settings-note">
          Plan <code>{grantPreview?.planSlug}</code> in{" "}
          <code>{grantPreview?.harnessSlug}</code> declares:
        </p>
        {grantPreview?.declaredScopes.length ? (
          <ul>
            {grantPreview.declaredScopes.map((scope) => (
              <li key={scope}>
                <code>{scope}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p role="alert" style={{ color: "var(--bad)" }}>
            This plan declares no Personal Vault scopes. Add{" "}
            <code>personalScopes: [personal:gmail]</code> to its frontmatter
            first.
          </p>
        )}
        <p>
          The grant is bound to this plan-template identity. Coding and review
          agents remain denied even if a matching grant exists.
        </p>
        <div
          className="pc-settings-actions"
          style={{ justifyContent: "flex-end" }}
        >
          <Button
            onClick={() => setGrantPreview(null)}
            disabled={busy === "grant-approve"}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void approvePlanGrant()}
            disabled={
              !grantPreview?.declaredScopes.length || busy === "grant-approve"
            }
          >
            {busy === "grant-approve"
              ? "Approving…"
              : "Approve declared scopes"}
          </Button>
        </div>
      </Modal>

      <Modal
        open={directConfirmOpen}
        onOpenChange={(open) => !open && setDirectConfirmOpen(false)}
        title="Grant Personal Vault access"
        description="Review exactly who this authorizes, and to read what, before granting."
        contentStyle={{
          width: "min(560px, calc(100vw - 4rem))",
          padding: 22,
          borderRadius: 12,
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
        }}
      >
        <h2>Grant access to {directPrincipalId.trim()}</h2>
        <p className="pc-settings-note">
          This authorizes {PRINCIPAL_TYPE_META[directType].who} to read:
        </p>
        <ul>
          {directScopes.map((scope) => (
            <li key={scope}>
              <code>{scope}</code>
            </li>
          ))}
        </ul>
        <p>
          {GRANT_EXPIRY_CHOICES.find((c) => c.id === directExpiry)?.ms === null
            ? "It stays active until you revoke it."
            : `It expires in ${GRANT_EXPIRY_CHOICES.find((c) => c.id === directExpiry)?.label ?? directExpiry}.`}{" "}
          You can revoke it at any time from Grant history below. Coding and
          review agents remain denied even while this grant is live.
        </p>
        {directType === "agent-role" &&
        isCodingAgentRole(directPrincipalId) ? (
          <p role="alert" style={{ color: "var(--bad)" }}>
            <code>{directPrincipalId.trim()}</code> is one of those denied
            roles, so this grant would authorize nothing.
          </p>
        ) : null}
        <div
          className="pc-settings-actions"
          style={{ justifyContent: "flex-end" }}
        >
          <Button
            onClick={() => setDirectConfirmOpen(false)}
            disabled={busy === "grant-direct"}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void createDirectGrant()}
            disabled={
              !directPrincipalId.trim() ||
              !directScopes.length ||
              busy === "grant-direct"
            }
          >
            {busy === "grant-direct" ? "Granting…" : "Grant access"}
          </Button>
        </div>
      </Modal>
    </main>
  );
}
