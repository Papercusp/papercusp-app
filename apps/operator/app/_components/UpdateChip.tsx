'use client';


import { Popover } from '../harness/Popover';
import { Tooltip } from '../harness/Tooltip';
// Footer chip + Update Center for the desktop app.
//
// The chip shows the running version and, when a newer release is out, an
// accent one-click "Update to vX" button. Clicking the version opens the
// Update Center popover — the home for everything channel/history/rollback
// related (desktop-update-center-and-release-tooling-2026-07-10 P-3):
//   • the running version and the active release channel;
//   • a channel switcher (alpha / beta / stable) that PATCHes the saved
//     update_channel and re-reads the release list for the new channel;
//   • an available-update card (reuses checkForUpdate / installUpdate);
//   • the release HISTORY for the channel (GET /api/updates/history) — which
//     release you're on, and which prior releases you could roll back to.
// Renders null in web mode.
//
// On mount: reads the current version from Tauri, then polls the configured
// updater endpoint (GitHub Releases /latest/download/latest.json per
// tauri.conf.json) for a newer release. Polls again every 10 minutes so users
// running long-lived sessions see new releases promptly. Opening the Update
// Center also force-checks.
//
// One-click install: invokes `install_update`, which:
//   1. kills the sidecar + embedded-postgres-server (no orphans)
//   2. downloads the platform tarball, verifies the minisign signature
//      against the pubkey embedded in tauri.conf.json
//   3. atomically swaps the binary
//   4. calls app.restart() — the Tauri shell relaunches with the new
//      version, the workspace and registry are untouched.
// Nothing ever installs on its own — every install path is behind a confirm.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSyncConnectivity } from '@papercusp/sync';
import {
  UpdateInfo,
  appVersion,
  checkForUpdate,
  installUpdate,
  revertTo,
} from '@papercusp/operator-core/lib/version-tauri';
import { canUseContentOriginDesktopActions } from '@/lib/ipc-status-tauri';
import { useConfirmDialog } from '../harness/useConfirmDialog';

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10m

/** Mirrors the Rust `UpdateDownloadProgressPayload` (main.rs) emitted on the
 *  `update-download-progress` webview event during install_update/revert_to's
 *  download phase. `total` is null when the release host omitted
 *  Content-Length (rare) — the bar falls back to a byte-count-only display. */
interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  let v = n;
  let unit = 0;
  while (v >= 1024 && unit < BYTE_UNITS.length - 1) {
    v /= 1024;
    unit += 1;
  }
  return `${v.toFixed(unit === 0 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** "1.2 GB / 3.4 GB (35%)", or just the downloaded count when the host never
 *  sent a total. */
function fmtProgress(p: DownloadProgress): string {
  if (!p.total || p.total <= 0) return fmtBytes(p.downloaded);
  const pct = Math.min(100, Math.round((p.downloaded / p.total) * 100));
  return `${fmtBytes(p.downloaded)} / ${fmtBytes(p.total)} (${pct}%)`;
}

/**
 * The update LANES of this app — deliberately not every channel that can be cut.
 * `nightly` is omitted on purpose: it is a side-by-side build with its own bundle
 * id and data home, so it installs alongside this app rather than updating it,
 * and offering it here would offer to replace someone's desktop with a different
 * application. Do not "complete" this list from the release kit's `CHANNELS`.
 */
type Channel = 'alpha' | 'beta' | 'stable';

const CHANNELS: readonly Channel[] = ['alpha', 'beta', 'stable'];
const CHANNEL_BLURB: Record<Channel, string> = {
  alpha: 'Latest fixes, fastest cadence — may have rough edges.',
  beta: 'Newer features, sanity-checked. Weekly-ish.',
  stable: 'Conservative. Updated when a release is ready for everyone.',
};

/**
 * Human copy for a cannot_check update result (WI-5010). `no_candidate` means
 * the release host WAS reached but has published nothing visible to this
 * channel (e.g. a beta user while every release is still alpha) — rendering
 * that as "couldn't reach the release host" is false and alarming, and every
 * beta/stable user would see it until the first beta/stable cut. Only genuine
 * transport/credential failures should read as unreachable.
 */
function describeCheckFailure(reason: string | null | undefined, channel: Channel): string {
  if (reason === 'no_candidate') {
    return `No releases are published for the ${channel} channel yet — update status unknown.`;
  }
  if (reason === 'manifest_unconfigured') {
    return 'The release host manifest is misconfigured (manifest_unconfigured) — update status unknown.';
  }
  return `Couldn’t reach the release host${reason ? ` (${reason})` : ''} — update status unknown.`;
}

/** One release row from GET /api/updates/history. Mirrors the server's
 *  `UpdateHistoryEntry` (updates-history.ts) — kept as a local shape so the
 *  client doesn't import the server route module. */
interface HistoryEntry {
  tag: string;
  version: string;
  channel: Channel;
  notes: string;
  pub_date: string;
  prerelease: boolean;
  is_current: boolean;
  installable: boolean;
}

interface HistoryState {
  releases: HistoryEntry[];
  reason: string | null;
  loading: boolean;
}

/**
 * Best-effort client platform for the history query, so `installable`
 * reflects THIS machine (which "Revert to vX" buttons to offer) rather than
 * the server's linux/x86_64 default. Derived from the user-agent — no extra
 * Tauri command. Arch is a hint only: Apple-Silicon webviews often report an
 * Intel UA, but darwin releases are typically `universal`, which pickAsset
 * treats as installable regardless of arch. Until P-4 wires the actual
 * `revert_to` command this only gates which revert buttons appear, so a wrong
 * guess is cosmetic.
 */
function detectClientPlatform(): { target: string; arch: string } {
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase();
  let target = 'linux';
  if (ua.includes('mac')) target = 'darwin';
  else if (ua.includes('win')) target = 'windows';
  let arch = 'x86_64';
  if (ua.includes('aarch64') || ua.includes('arm64') || ua.includes('arm')) arch = 'aarch64';
  return { target, arch };
}

/** WI-5011: a real progress bar for install_update/revert_to's download
 *  phase, replacing the bare "Installing…"/"Reverting…" spinner text that
 *  previously gave no feedback for a multi-GB, multi-minute download.
 *  `progress === null` (no chunk has landed yet, or the listener never
 *  attached) falls back to an indeterminate bar + "Starting download…" so
 *  the caller never has to branch on progress being absent. */
function DownloadProgressBar({ progress }: { progress: DownloadProgress | null }) {
  const pct = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 5,
          borderRadius: 3,
          background: 'var(--border, #2a2a2a)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: pct === null ? '35%' : `${pct}%`,
            borderRadius: 3,
            background: 'var(--accent, #2d7a40)',
            transition: 'width 150ms ease-out',
          }}
        />
      </div>
      <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
        {progress ? fmtProgress(progress) : 'Starting download…'}
      </span>
    </div>
  );
}

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function UpdateChip() {
  const [desktop, setDesktop] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  // The tag currently being reverted to (null = idle) — gates re-entry and
  // drives the per-row button label/disabled state.
  const [reverting, setReverting] = useState<string | null>(null);
  // Download progress for the in-flight install/revert (WI-5011). Populated
  // from the `update-download-progress` webview event Rust emits while
  // `download_and_install` streams bytes; null before the first chunk lands
  // or once installing/reverting clears (so a stale bar never lingers into
  // the next attempt).
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>('alpha');
  const [savingChannel, setSavingChannel] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ releases: [], reason: null, loading: false });
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  // The operator's live-transport state (SSE/REST). Used to skip BACKGROUND
  // update checks while the operator is unreachable — see `poll`.
  const { offline } = useSyncConnectivity();

  useEffect(() => {
    let cancelled = false;
    void canUseContentOriginDesktopActions().then((allowed) => {
      if (!cancelled) setDesktop(allowed);
    });
    return () => { cancelled = true; };
  }, []);

  // Subscribe to download-progress events for the lifetime of the chip (not
  // just while installing/reverting) — installUpdate() fires the download
  // almost immediately after invoke(), so a listener registered only inside
  // onInstall/onRevert would race the first chunk. Cheap: the event fires
  // only during an active install/revert, never in steady state.
  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<DownloadProgress>('update-download-progress', (event) => {
        setProgress(event.payload);
      }),
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {
      /* no listener available (e.g. very old webview) — falls back to the
       * plain spinner copy below */
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [desktop]);

  const refreshVersion = useCallback(() => {
    appVersion().then(setVersion).catch(() => {});
  }, []);

  const poll = useCallback(async (silent: boolean) => {
    if (!desktop) return;
    // Skip BACKGROUND (silent) checks while the operator is unreachable. The
    // check would just race a down / not-yet-ready operator and make the
    // tauri_plugin_updater crate log a scary `failed to check for updates:
    // error sending request` — which recovers on the next attempt anyway and
    // correlates 1:1 with operator restart churn (the chip remounts on the
    // SPA's reconnect re-render, each remount firing this poll). A user-
    // initiated check (silent=false) still attempts, so a manual click always
    // gives feedback. When the transport recovers, this effect re-runs (poll's
    // `offline` dep) and a catch-up check fires against a confirmed-reachable
    // operator.
    if (silent && offline) return;
    setChecking(true);
    try {
      const u = await checkForUpdate();
      setInfo(u);
      if (!silent && u) {
        // `available: false` alone does NOT mean "you are current" — the updater
        // protocol reports an unreachable/throttled/unconfigured release host as
        // a plain "no update" too. Claiming "(latest)" there tells the user they
        // are up to date when we never actually managed to ask, which is how an
        // app can sit on a stale version forever and never say a word.
        if (u.check_failed) {
          // no_candidate = the host answered, this channel just has nothing
          // published yet (WI-5010) — an informational state, not a failure.
          if (u.check_reason === 'no_candidate') {
            toast.info('No releases published for your channel yet', {
              description:
                'The release host is reachable, but nothing has been published to your current channel so far.',
            });
          } else {
            toast.error("Couldn't check for updates", {
              description: `The release host could not be reached${
                u.check_reason ? ` (${u.check_reason})` : ''
              } — you may not be on the latest version. Retry, or check your connection.`,
            });
          }
        } else {
          toast.success(
            u.available
              ? `Update available: v${u.new_version}`
              : `You're on v${u.current_version} (latest)`,
          );
        }
      }
      // Notify — once per version per session — when a BACKGROUND check first surfaces a
      // new release. The footer button alone is easy to miss, and the owner wants users
      // actively notified ("I want them to be notified when there is an update"). Nothing
      // installs on its own — the toast points at the button, install stays a click+confirm.
      if (silent && u?.available && u.new_version) {
        const notifyKey = `pc:update-notified:${u.new_version}`;
        let firstThisSession = true;
        try {
          firstThisSession = !sessionStorage.getItem(notifyKey);
          if (firstThisSession) sessionStorage.setItem(notifyKey, '1');
        } catch {
          /* sessionStorage unavailable (private mode) — still notify, just no dedupe */
        }
        if (firstThisSession) {
          toast.info(`Update available: v${u.new_version}`, {
            description: `Open the version menu in the footer to review and install — nothing installs on its own.`,
          });
        }
      }
    } catch (e: any) {
      if (!silent) toast.error(`update check failed: ${e?.message ?? e}`);
    } finally {
      setChecking(false);
    }
  }, [desktop, offline]);

  // Load the release history for a channel. Passed the channel explicitly so a
  // just-switched channel doesn't read stale state. `installable` is scoped to
  // THIS machine via the detected platform.
  const loadHistory = useCallback(async (ch: Channel, currentVersion: string | null) => {
    setHistory((h) => ({ ...h, loading: true }));
    try {
      const { target, arch } = detectClientPlatform();
      const params = new URLSearchParams({
        channel: ch,
        product: 'gui',
        target,
        arch,
        current_version: currentVersion ?? '',
        limit: '20',
      });
      const r = await fetch(`/api/updates/history?${params.toString()}`, { cache: 'no-store' });
      const j = await r.json();
      setHistory({
        releases: Array.isArray(j?.releases) ? (j.releases as HistoryEntry[]) : [],
        reason: typeof j?.reason === 'string' ? j.reason : null,
        loading: false,
      });
    } catch {
      setHistory({ releases: [], reason: 'fetch_failed', loading: false });
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    refreshVersion();
    poll(true);
    // Read the saved channel so the switcher opens on the right selection.
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' });
        const j = await r.json();
        if (j?.update_channel === 'alpha' || j?.update_channel === 'beta' || j?.update_channel === 'stable') {
          setChannel(j.update_channel);
        }
      } catch {
        /* keep default */
      }
    })();
    const id = window.setInterval(() => poll(true), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [desktop, refreshVersion, poll]);

  // Opening the Update Center force-checks and (re)loads history against a
  // confirmed intent to look. Closing is a no-op.
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      void poll(false);
      void loadHistory(channel, version);
    }
  }, [poll, loadHistory, channel, version]);

  const pickChannel = useCallback(async (c: Channel) => {
    if (c === channel) return;
    setChannel(c);
    setSavingChannel(true);
    try {
      await fetch('/api/desktop/setup-wizard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ update_channel: c }),
      });
    } catch {
      /* the switcher already reflects the choice optimistically */
    } finally {
      setSavingChannel(false);
    }
    // The visible release set + "is there a newer one" both depend on the
    // channel, so re-read them for the new selection.
    void loadHistory(c, version);
    void poll(false);
  }, [channel, version, loadHistory, poll]);

  const onInstall = useCallback(async () => {
    if (installing) return;
    if (!await askConfirm({
      title: `Install v${info?.new_version ?? '?'} and restart?`,
      body: 'Papercusp will quit, swap binaries, and relaunch. In-flight work is interrupted.',
      confirmLabel: 'Install and restart',
    })) return;
    setInstalling(true);
    setProgress(null);
    try {
      await installUpdate();
      // The promise typically never resolves — Tauri restarts the process.
    } catch (e: any) {
      // Linux currently has no AppImage swap target (CI build of AppImage is
      // blocked by linuxdeploy/FUSE friction), so install_update fails on
      // Linux with `no_compatible_assets`. Fall back to opening the GitHub
      // releases page so the user can download a fresh .deb / .rpm manually.
      const msg = String(e?.message ?? e);
      if (msg.includes('no_compatible_assets') || msg.includes('compatible')) {
        toast.info('Auto-install isn’t available on this platform yet — opening releases page.');
        window.open(
          'https://github.com/Papercusp/papercusp-desktop/releases/latest',
          '_blank',
          'noopener,noreferrer',
        );
      } else {
        toast.error(`install failed: ${msg}`);
      }
      setInstalling(false);
      setProgress(null);
    }
  }, [installing, info, askConfirm]);

  // Roll back to an older release. The Tauri `revert_to(tag)` command (P-4)
  // resolves the tag via GET /api/updates/rollback, minisign-verifies the
  // asset against the baked pubkey, swaps the binary, and relaunches — the
  // deliberate-downgrade sibling of installUpdate. On success the app restarts
  // (so we never reach the post-await code); a returned error surfaces as a
  // toast, mirroring onInstall's fallbacks.
  const onRevert = useCallback(async (entry: HistoryEntry) => {
    if (reverting) return;
    if (!await askConfirm({
      title: `Revert to v${entry.version}?`,
      body: `Reinstall the older v${entry.version} build and restart Papercusp. Rolling back can lose data written by the newer version.`,
      confirmLabel: 'Revert',
    })) return;
    setReverting(entry.tag);
    setProgress(null);
    try {
      await revertTo(entry.tag);
      // revert_to ends in app.restart(); if we're still here the swap didn't
      // relaunch — tell the user rather than leaving the button spinning.
      toast.info(`Reverting to v${entry.version}… restarting Papercusp.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('no_compatible_assets')) {
        toast.error(`This install can't auto-revert (not an AppImage). Reinstall v${entry.version} manually.`);
      } else {
        toast.error(`Revert to v${entry.version} failed: ${msg}`);
      }
      setReverting(null);
      setProgress(null);
    }
  }, [reverting, askConfirm]);

  if (!desktop) return null;
  if (!version) return null;

  const updateAvailable = Boolean(info?.available && info.new_version);

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const center = (
    <div
      style={{
        width: 340,
        maxWidth: '90vw',
        maxHeight: '70vh',
        overflowY: 'auto',
        background: 'var(--bg-1, #1a1a1a)',
        border: '1px solid var(--border, #2a2a2a)',
        borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        color: 'var(--fg, #ddd)',
        font: 'inherit',
        fontSize: 13,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>Update Center</strong>
        <span style={{ color: 'var(--fg-mute, #888)' }}>
          v{version} · <span style={{ textTransform: 'capitalize' }}>{channel}</span>
        </span>
      </div>

      {/* Channel switcher */}
      <div>
        <div style={{ color: 'var(--fg-mute, #888)', marginBottom: 6, fontSize: 12 }}>Release channel</div>
        <div role="radiogroup" aria-label="Release channel" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {CHANNELS.map((c) => {
            const active = c === channel;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={savingChannel}
                onClick={() => void pickChannel(c)}
                style={{
                  textAlign: 'left',
                  background: active ? 'color-mix(in srgb, var(--accent, #2d7a40), transparent 82%)' : 'transparent',
                  border: `1px solid ${active ? 'var(--accent, #2d7a40)' : 'var(--border, #2a2a2a)'}`,
                  color: 'inherit',
                  borderRadius: 6,
                  padding: '7px 10px',
                  cursor: savingChannel ? 'wait' : 'pointer',
                  font: 'inherit',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      border: `1px solid ${active ? 'var(--accent, #2d7a40)' : 'var(--fg-mute, #888)'}`,
                      background: active ? 'var(--accent, #2d7a40)' : 'transparent',
                    }}
                  />
                  {cap(c)}
                </div>
                <div style={{ color: 'var(--fg-mute, #888)', fontSize: 12, marginTop: 2, paddingLeft: 14 }}>
                  {CHANNEL_BLURB[c]}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Available-update card */}
      <div
        style={{
          border: '1px solid var(--border, #2a2a2a)',
          borderRadius: 6,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {checking ? (
          <span style={{ color: 'var(--fg-mute, #888)' }}>Checking for updates…</span>
        ) : updateAvailable ? (
          <>
            <div>
              <strong>Update available.</strong>{' '}
              <span style={{ color: 'var(--fg-mute, #888)' }}>v{version} → v{info!.new_version}</span>
            </div>
            {info?.notes && (
              <div
                style={{
                  color: 'var(--fg-mute, #888)',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 96,
                  overflowY: 'auto',
                }}
              >
                {info.notes}
              </div>
            )}
            <button
              type="button"
              onClick={onInstall}
              disabled={installing}
              style={{
                alignSelf: 'flex-start',
                background: 'var(--accent, #2d7a40)',
                border: '1px solid var(--accent, #2d7a40)',
                color: 'var(--accent-ink, #fff)',
                padding: '5px 12px',
                borderRadius: 5,
                cursor: installing ? 'wait' : 'pointer',
                font: 'inherit',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {installing ? 'Installing…' : `Install v${info!.new_version} and restart`}
            </button>
            {installing && <DownloadProgressBar progress={progress} />}
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>
              {info?.check_failed
                ? describeCheckFailure(info.check_reason, channel)
                : `You’re on the latest (${channel}).`}
            </span>
            <button
              type="button"
              onClick={() => void poll(false)}
              disabled={checking}
              style={{
                background: 'transparent',
                border: '1px solid var(--border, #2a2a2a)',
                color: 'inherit',
                padding: '4px 10px',
                borderRadius: 5,
                cursor: checking ? 'wait' : 'pointer',
                font: 'inherit',
                fontSize: 12,
              }}
            >
              Check now
            </button>
          </div>
        )}
      </div>

      {/* Release history */}
      <div>
        <div style={{ color: 'var(--fg-mute, #888)', marginBottom: 6, fontSize: 12 }}>
          Release history · {channel}
        </div>
        {history.loading ? (
          <div style={{ color: 'var(--fg-mute, #888)', fontSize: 12 }}>Loading releases…</div>
        ) : history.releases.length === 0 ? (
          <div style={{ color: 'var(--fg-mute, #888)', fontSize: 12 }}>
            {history.reason === 'no_token'
              ? 'Release history unavailable (releases repo not reachable from here).'
              : history.reason === 'fetch_failed'
                ? 'Couldn’t reach the releases list — try again shortly.'
                : 'No releases found for this channel.'}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {history.releases.map((e) => (
              <li
                key={e.tag}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '6px 8px',
                  borderRadius: 5,
                  background: e.is_current ? 'color-mix(in srgb, var(--accent, #2d7a40), transparent 88%)' : 'transparent',
                  border: '1px solid transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600 }}>v{e.version}</span>
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--fg-mute, #888)',
                          border: '1px solid var(--border, #2a2a2a)',
                          borderRadius: 4,
                          padding: '0 5px',
                          textTransform: 'capitalize',
                        }}
                      >
                        {e.channel}
                      </span>
                    </div>
                    <div style={{ color: 'var(--fg-mute, #888)', fontSize: 11 }}>{fmtDate(e.pub_date)}</div>
                  </div>
                  {e.is_current ? (
                    <span style={{ color: 'var(--accent, #2d7a40)', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      ● Current
                    </span>
                  ) : e.installable ? (
                    <button
                      type="button"
                      onClick={() => void onRevert(e)}
                      disabled={reverting !== null}
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--border, #2a2a2a)',
                        color: 'var(--fg-mute, #aaa)',
                        padding: '3px 9px',
                        borderRadius: 5,
                        cursor: reverting !== null ? 'default' : 'pointer',
                        opacity: reverting !== null && reverting !== e.tag ? 0.5 : 1,
                        font: 'inherit',
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {reverting === e.tag ? 'Reverting…' : 'Revert'}
                    </button>
                  ) : null}
                </div>
                {reverting === e.tag && <DownloadProgressBar progress={progress} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  const triggerLabel = updateAvailable ? `Update available — currently v${version}` : 'Version and updates';

  return (
    <>
      {confirmEl}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Popover
          open={open}
          onOpenChange={onOpenChange}
          side="top"
          align="end"
          ariaLabel="Update Center"
          // Popover composes Tooltip.Trigger OUTSIDE Popover.Trigger around the
          // same button — the sanctioned trigger-tooltip route (a native title=
          // trips the design-primitives lint; a <Tooltip> wrapper inside
          // `trigger` breaks Slot prop-forwarding, per Popover's doc-comment).
          tooltipLabel={triggerLabel}
          trigger={
            <button
              type="button"
              style={{
                background: 'transparent',
                border: `1px solid ${updateAvailable ? 'var(--accent, #2d7a40)' : 'var(--border, #2a2a2a)'}`,
                color: updateAvailable ? 'var(--accent, #2d7a40)' : 'var(--fg-mute, #777)',
                padding: '3px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              {updateAvailable && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
              )}
              v{version}
              {checking && <span style={{ opacity: 0.6 }}>…</span>}
            </button>
          }
        >
          {center}
        </Popover>

        {updateAvailable && (
          // Label is constant-truthy for the button's lifetime (it only renders
          // while updateAvailable), so the WI-4059 falsy<->truthy Tooltip
          // remount trap does not apply here.
          <Tooltip label={info?.notes ?? `New version v${info!.new_version} available`}>
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            style={{
              background: 'var(--accent)',
              border: '1px solid var(--accent, #2d7a40)',
              color: 'var(--accent-ink)',
              padding: '3px 10px',
              borderRadius: 4,
              cursor: installing ? 'wait' : 'pointer',
              font: 'inherit',
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
            {installing
              ? progress?.total
                ? `Installing… ${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`
                : 'Installing…'
              : `Update to v${info!.new_version}`}
          </button>
          </Tooltip>
        )}
      </span>
    </>
  );
}
