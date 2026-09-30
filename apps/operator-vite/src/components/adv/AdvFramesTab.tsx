import { useEffect, useMemo, useRef, useState } from 'react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { Eye, Hand, MonitorPlay, MonitorOff, RefreshCw, X } from 'lucide-react';
import { createResilientEventSource, type ResilientEventSource } from '@papercusp/sse';
import FrameVncView from './FrameVncView';
import FrameScreenTrackView from './FrameScreenTrackView';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';

/**
 * AdvFramesTab — the Swarm live view
 * (`hive-frame-desktops-live-view-2026-06-06` P-006, D-001/D-003/D-005).
 *
 * One tile per agent-display across every DEPLOYED frame in the workspace:
 * the frame-side capture loop writes a JPEG per active display, the operator
 * pulls them over SSH while ≥1 of these tabs is open (viewer-driven, D-003),
 * and `/api/deploy/:slug/frame-view` fans them out here as SSE `thumb` events.
 *
 * Selection rides nuqs (`?frame=<slug>:<display>`) so agents can drive the
 * viewer (`ui:dispatch`) and deep links survive reload. The enlarged panel is
 * Phase 3's mount point for the noVNC live view (P-009).
 */

export interface DeployedFrameRow {
  slug: string;
  frame: { id: string; host?: string; region?: string; kind?: string; target: string };
  desktop: boolean | { displays?: number; geometry?: string };
}

export interface FrameThumbEvent {
  slug: string;
  display: number;
  jpegBase64: string;
  capturedAtMs: number;
  role?: string;
  leaseSinceMs?: number;
}

export interface FrameStatusEvent {
  slug: string;
  state: 'polling' | 'no-frame' | 'error';
  frameId?: string;
  host?: string;
  displays?: number[];
  error?: string;
  /** Live VNC viewers on this frame (D-002 session indicator). */
  viewers?: { display: number; mode: string; sinceMs: number }[];
}

/** A thumb is stale once it's older than ~3 capture intervals. */
export const STALE_AFTER_MS = 20_000;

/** A local (this-host) desktop session, from GET /api/deploy/local-desktops. */
export interface LocalDesktopRow {
  id: string;
  slug: string | null;
  kind: string;
  scope: string;
  scopeRef: string;
  display: number;
  displayRaw: string;
  state: string;
  viewerMode: 'none' | 'watch' | 'takeover';
  viewerActor: string | null;
  captureGeometry?: { width: number; height: number };
  displayGeometry?: { width: number; height: number; depth?: number };
}

const tileKey = (slug: string, display: number) => `${slug}:${display}`;
/**
 * Selection keys for local desktops carry a `local:` prefix so one nuqs param
 * addresses both populations. A frame's `h1:99` and a local `h1:99` are
 * genuinely different desktops, so the key must distinguish them — the same
 * reason the audit subject does.
 */
const LOCAL_KEY_PREFIX = 'local:';
const localTileKey = (slug: string | null, display: number) =>
  `${LOCAL_KEY_PREFIX}${slug ?? '-'}:${display}`;

export default function AdvFramesTab() {
  const t = useLexicon();
  // ── deployed-frame roster (registry; cheap, refetched on a slow interval) ──
  const [rows, setRows] = useState<DeployedFrameRow[]>([]);
  const [rosterErr, setRosterErr] = useState<string | null>(null);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  useEffect(() => {
    let cancel = false;
    const pull = () => {
      fetch('/api/deploy/frames', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          if (cancel) return;
          setRows(Array.isArray(d?.frames) ? d.frames : []);
          setRosterErr(null);
          setRosterLoaded(true);
        })
        .catch((e) => {
          if (cancel) return;
          setRosterErr(String(e?.message ?? e));
          setRosterLoaded(true);
        });
    };
    pull();
    const t = setInterval(pull, 30_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, []);

  // ── local desktop roster (P-004) ───────────────────────────────────────
  // The Xvfb displays THIS host leases to pots and frame slots, from the
  // DesktopSession registry. Registry-backed, so a desktop leased by a sibling
  // operator process shows up here too. These have no thumbnail stream (a frame's
  // JPEG loop is a frame-side agent); they are watch/takeover targets, and the
  // panel below mounts noVNC against them exactly as it does for a frame.
  const [localDesktops, setLocalDesktops] = useState<LocalDesktopRow[]>([]);
  useEffect(() => {
    let cancel = false;
    const pull = () => {
      fetch('/api/deploy/local-desktops', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          if (cancel) return;
          setLocalDesktops(Array.isArray(d?.desktops) ? d.desktops : []);
        })
        .catch(() => {
          // Non-fatal: the frames roster carries its own error surface, and a
          // missing local roster must not blank the tab.
          if (!cancel) setLocalDesktops([]);
        });
    };
    pull();
    const t = setInterval(pull, 10_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, []);

  // ── per-slug SSE streams → thumbs + statuses ───────────────────────────
  const [thumbs, setThumbs] = useState<Map<string, FrameThumbEvent>>(() => new Map());
  const [statuses, setStatuses] = useState<Map<string, FrameStatusEvent>>(() => new Map());
  const sourcesRef = useRef<Map<string, ResilientEventSource>>(new Map());
  const slugsKey = useMemo(() => rows.map((r) => r.slug).sort().join(','), [rows]);
  useEffect(() => {
    const want = new Set(slugsKey ? slugsKey.split(',') : []);
    const sources = sourcesRef.current;
    // close streams for frames that left the roster
    for (const [slug, src] of sources) {
      if (!want.has(slug)) {
        src.close();
        sources.delete(slug);
      }
    }
    // open streams for new frames
    for (const slug of want) {
      if (sources.has(slug)) continue;
      sources.set(
        slug,
        createResilientEventSource({
          url: `/api/deploy/${encodeURIComponent(slug)}/frame-view`,
          withCredentials: true,
          handlers: {
            thumb: (raw) => {
              try {
                const t = JSON.parse(raw) as FrameThumbEvent;
                setThumbs((prev) => new Map(prev).set(tileKey(t.slug, t.display), t));
              } catch {
                /* skip a malformed event */
              }
            },
            status: (raw) => {
              try {
                const s = JSON.parse(raw) as FrameStatusEvent;
                setStatuses((prev) => new Map(prev).set(s.slug, s));
              } catch {
                /* skip */
              }
            },
          },
        }),
      );
    }
    return undefined;
  }, [slugsKey]);
  // unmount → close everything (last viewer gone stops the SSH pull server-side)
  useEffect(
    () => () => {
      for (const src of sourcesRef.current.values()) src.close();
      sourcesRef.current.clear();
    },
    [],
  );

  // re-render on a slow tick so "Ns ago" ages + staleness flips without events
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 2_000);
    return () => clearInterval(t);
  }, []);

  // ── selection + live/drive in nuqs (?frame=<slug>:<display>&live=&drive=)
  //    so agents can drive the viewer and deep links survive reload ────────
  const [selectedKey, setSelectedKey] = useQueryState('frame', parseAsString);
  const [live, setLive] = useQueryState('live', parseAsBoolean.withDefault(false));
  const [drive, setDrive] = useQueryState('drive', parseAsBoolean.withDefault(false));
  const selection = useMemo(() => {
    if (!selectedKey) return undefined;
    // Strip the local marker BEFORE splitting: `local:h1:110` must parse as
    // slug 'h1' on the local target, not as slug 'local:h1' on a frame — which
    // is what a bare lastIndexOf(':') would produce.
    const isLocal = selectedKey.startsWith(LOCAL_KEY_PREFIX);
    const rest = isLocal ? selectedKey.slice(LOCAL_KEY_PREFIX.length) : selectedKey;
    const i = rest.lastIndexOf(':');
    if (i <= 0) return undefined;
    const display = Number(rest.slice(i + 1));
    if (!Number.isInteger(display)) return undefined;
    return { slug: rest.slice(0, i), display, target: isLocal ? ('local' as const) : ('frame' as const) };
  }, [selectedKey]);
  const selected = useMemo(
    () => (selectedKey ? thumbs.get(selectedKey) : undefined),
    [selectedKey, thumbs],
  );
  const closePanel = async () => {
    await setDrive(null);
    await setLive(null);
    await setSelectedKey(null);
  };
  // P-013: watch path tries the holepunch SCREEN TRACK first and falls back to
  // VNC transparently; VNC remains the input (takeover) path. Transient
  // per-attempt state — reset whenever the target or mode changes.
  const [trackFallback, setTrackFallback] = useState<string | null>(null);
  useEffect(() => {
    setTrackFallback(null);
  }, [selectedKey, live, drive]);

  const tiles = useMemo(() => {
    const list = [...thumbs.values()];
    list.sort((a, b) => a.slug.localeCompare(b.slug) || a.display - b.display);
    return list;
  }, [thumbs]);

  const now = Date.now();

  return (
    <div className="pc-frames">
      <div className="pc-frames__topbar">
        <MonitorPlay size={14} aria-hidden />
        <span className="pc-frames__title">{t('fleet')} live view</span>
        <span className="pc-frames__sub">
          {/* "0 live displays" is kept deliberately: with frames deployed, zero
              is the informative reading (they are up, nothing is on screen). The
              local count is appended only when there are any, so a box with no
              local desktops reads exactly as it did before P-004. */}
          {rows.length === 0 && localDesktops.length === 0
            ? 'no deployed frames'
            : [
                rows.length > 0 &&
                  `${rows.length} frame${rows.length === 1 ? '' : 's'} · ${tiles.length} live display${tiles.length === 1 ? '' : 's'}`,
                localDesktops.length > 0 &&
                  `${localDesktops.length} local desktop${localDesktops.length === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
        <div className="pc-frames__spacer" />
      </div>

      {/* Local desktops render INDEPENDENTLY of the deployed-frame roster: on a
          dev box there are usually no frames at all, and gating them behind
          rows.length would hide every desktop this host is actually running. */}
      {localDesktops.length > 0 && (
        <div className="pc-frames__grid" aria-label="Local desktops">
          {localDesktops.map((d) => {
            const key = localTileKey(d.slug, d.display);
            const watched = d.viewerMode !== 'none';
            return (
              <Tooltip
                key={d.id}
                label={`${d.slug ?? 'workspace'} ${d.displayRaw} — ${d.kind} · ${d.state}${
                  d.viewerActor ? ` · ${d.viewerMode} by ${d.viewerActor}` : ''
                }`}
              >
                <button
                  type="button"
                  className="pc-frames__tile pc-frames__tile--local"
                  data-selected={selectedKey === key}
                  aria-label={`${d.slug ?? 'workspace'} ${d.displayRaw} (local ${d.kind})`}
                  onClick={() => void setSelectedKey(selectedKey === key ? null : key)}
                >
                  <span className="pc-frames__tile-placeholder" aria-hidden>
                    <MonitorPlay size={20} />
                  </span>
                  <span className="pc-frames__tile-meta">
                    <span className="pc-frames__tile-slug">{d.slug ?? 'workspace'}</span>
                    <span className="pc-frames__tile-display">{d.displayRaw}</span>
                    <span className="pc-frames__tile-role">{d.kind}</span>
                    {watched && (
                      <span className="pc-frames__chip-watch" data-drive={d.viewerMode === 'takeover'}>
                        {d.viewerMode === 'takeover' ? <Hand size={10} aria-hidden /> : <Eye size={10} aria-hidden />}
                      </span>
                    )}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}

      {rosterErr ? (
        <div className="pc-frames__state" data-error="true">
          {rosterErr}
        </div>
      ) : !rosterLoaded ? (
        <div className="pc-frames__state">Loading deployed frames…</div>
      ) : rows.length === 0 ? (
        localDesktops.length === 0 ? (
          <div className="pc-frames__state">
            No deployed frames and no local desktops. Deploy a harness with{' '}
            <code>deployment.desktop: true</code>, or lease a local desktop, and agents' screens
            appear here.
          </div>
        ) : null
      ) : (
        <>
          {/* per-frame status strip (no-desktop / connecting / errors) */}
          <div className="pc-frames__statusrow">
            {rows.map((r) => {
              const s = statuses.get(r.slug);
              const polling = s?.state === 'polling' && (s.displays?.length ?? 0) > 0;
              const watchers = s?.viewers ?? [];
              const driving = watchers.some((v) => v.mode === 'takeover');
              return (
                <span key={r.slug} className="pc-frames__chip" data-live={polling} title={s?.error ?? s?.host ?? r.frame.host ?? ''}>
                  <span className="pc-frames__chip-dot" data-state={s?.state ?? 'connecting'} aria-hidden />
                  {r.slug}
                  <span className="pc-frames__chip-meta">
                    {!r.desktop
                      ? 'no desktop'
                      : s?.state === 'error'
                        ? 'unreachable'
                        : s?.state === 'no-frame'
                          ? 'no frame'
                          : polling
                            ? `${s?.displays?.length} active`
                            : 'idle'}
                  </span>
                  {watchers.length > 0 && (
                    // D-002 session indicator: somebody is watching/driving this frame
                    <span className="pc-frames__chip-watch" data-drive={driving} title={driving ? 'a human is DRIVING a display' : 'a human is watching (read-only)'}>
                      {driving ? <Hand size={10} aria-hidden /> : <Eye size={10} aria-hidden />}
                      {watchers.length}
                    </span>
                  )}
                </span>
              );
            })}
          </div>

          {tiles.length === 0 ? (
            <div className="pc-frames__state">
              <MonitorOff size={14} aria-hidden /> No active displays — agents aren't driving a GUI
              right now. Tiles appear when an agent opens something on its display.
            </div>
          ) : (
            <div className="pc-frames__grid">
              {tiles.map((t) => {
                const key = tileKey(t.slug, t.display);
                const ageMs = now - t.capturedAtMs;
                return (
                  <Tooltip key={key} label={`${t.slug} :${t.display}${t.role ? ` — ${t.role}` : ''}`}>
                    <button
                      type="button"
                      className="pc-frames__tile"
                      data-selected={selectedKey === key}
                      data-stale={ageMs > STALE_AFTER_MS}
                      aria-label={`${t.slug} :${t.display}${t.role ? ` — ${t.role}` : ''}`}
                      onClick={() => void setSelectedKey(selectedKey === key ? null : key)}
                    >
                      <img
                        src={`data:image/jpeg;base64,${t.jpegBase64}`}
                        alt={`${t.slug} display :${t.display}`}
                      />
                      <span className="pc-frames__tile-meta">
                        <span className="pc-frames__tile-slug">{t.slug}</span>
                        <span className="pc-frames__tile-display">:{t.display}</span>
                        {t.role && <span className="pc-frames__tile-role">{t.role}</span>}
                        <span className="pc-frames__tile-age">{formatAge(ageMs)}</span>
                      </span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* enlarged panel — stills by default; "Watch live" mounts noVNC (P-009) */}
      {selection && (
        <div className="pc-frames__panel" role="region" aria-label="Frame live view">
          <div className="pc-frames__panel-head">
            <MonitorPlay size={13} aria-hidden />
            <span>
              {selection.slug} <code>:{selection.display}</code>
              {selected?.role ? ` — ${selected.role}` : ''}
            </span>
            {live && (
              <span className="pc-frames__mode" data-drive={drive}>
                {drive ? (
                  <>
                    <Hand size={11} aria-hidden /> DRIVING
                  </>
                ) : (
                  <>
                    <Eye size={11} aria-hidden /> read-only
                  </>
                )}
              </span>
            )}
            {!live && selected && (
              <span className="pc-frames__tile-age">{formatAge(now - selected.capturedAtMs)}</span>
            )}
            <span className="pc-frames__panel-actions">
              <button
                type="button"
                className="pc-frames__panel-btn"
                data-active={live}
                onClick={() => {
                  if (live) void setDrive(null);
                  void setLive(live ? null : true);
                }}
              >
                {live ? 'Back to stills' : 'Watch live'}
              </button>
              {live && (
                <Tooltip
                  label={
                    drive
                      ? 'Hand the mouse/keyboard back to the agent'
                      : 'Take the mouse/keyboard — disruptive to a working agent; audited (D-002)'
                  }
                >
                  <button
                    type="button"
                    className="pc-frames__panel-btn"
                    data-danger={!drive}
                    data-active={drive}
                    onClick={() => void setDrive(drive ? null : true)}
                  >
                    {drive ? 'Release control' : 'Take control'}
                  </button>
                </Tooltip>
              )}
            </span>
            <button
              type="button"
              className="pc-frames__panel-close"
              onClick={() => void closePanel()}
              aria-label="Close live view"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          {live ? (
            drive || trackFallback !== null || selection.target === 'local' ? (
              // VNC: the input path (takeover), the watch fallback (P-013), and a
              // LOCAL desktop — which is not a deployed frame and can never publish
              // the holepunch screen track FrameScreenTrackView waits on, so trying
              // it first only pays its FIRST_FRAME_TIMEOUT_MS (8s) for a guaranteed
              // fallback. Route straight to VNC instead (EI-21881516933069798).
              <FrameVncView
                slug={selection.slug}
                display={selection.display}
                drive={drive}
                target={selection.target}
              />
            ) : (
              <FrameScreenTrackView
                slug={selection.slug}
                display={selection.display}
                onUnavailable={(reason) => setTrackFallback(reason)}
              />
            )
          ) : selected ? (
            <img
              className="pc-frames__panel-img"
              src={`data:image/jpeg;base64,${selected.jpegBase64}`}
              alt={`${selection.slug} display :${selection.display} (enlarged)`}
            />
          ) : (
            <div className="pc-frames__panel-img pc-frames__panel-idle">display is idle — no frame yet</div>
          )}
          <div className="pc-frames__panel-foot">
            <RefreshCw size={11} aria-hidden />
            {live
              ? drive
                ? 'live VNC session — you are driving this display (audited)'
                : trackFallback !== null
                  ? `live VNC session (read-only) — screen track unavailable: ${trackFallback}`
                  : 'holepunch screen track — read-only; "Take control" switches to VNC for input (audited)'
              : 'stills refresh every few seconds — "Watch live" opens the live view'}
          </div>
        </div>
      )}

      <style>{`
        .pc-frames { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; padding: 14px 16px 16px; position: relative; }
        .pc-frames__topbar {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 12px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
          border-radius: 12px;
          background: var(--bg-2, rgba(255, 255, 255, 0.04));
          color: var(--fg, #e7f7ff);
        }
        .pc-frames__topbar svg { color: var(--accent, #38bdf8); }
        .pc-frames__title { font-size: 12px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; }
        .pc-frames__sub { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-frames__spacer { flex: 1; }
        .pc-frames__state {
          display: flex; align-items: center; gap: 7px;
          font-size: 12px; color: var(--fg-mute, #7f9bb4); padding: 10px 2px;
        }
        .pc-frames__state[data-error='true'] { color: #fca5a5; }
        .pc-frames__state code { font-size: 11px; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__statusrow { display: flex; flex-wrap: wrap; gap: 6px; }
        .pc-frames__chip {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 11px; font-weight: 600; color: var(--fg-dim, #b9d4e8);
          border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
          border-radius: 999px; padding: 3px 9px;
          background: rgba(255, 255, 255, 0.03);
        }
        .pc-frames__chip-dot { width: 7px; height: 7px; border-radius: 50%; background: #475569; }
        .pc-frames__chip-dot[data-state='polling'] { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.5); }
        .pc-frames__chip-dot[data-state='error'] { background: #f87171; }
        .pc-frames__chip-meta { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
        .pc-frames__grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 12px;
          overflow-y: auto;
          min-height: 0;
        }
        .pc-frames__tile {
          position: relative;
          aspect-ratio: 16 / 9;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
          border-radius: 12px;
          overflow: hidden;
          background: var(--bg-2, rgba(255, 255, 255, 0.035));
          cursor: pointer;
          padding: 0;
          transition: border-color 150ms, box-shadow 150ms, opacity 150ms;
        }
        .pc-frames__tile:hover { border-color: var(--accent, #38bdf8); box-shadow: none; }
        .pc-frames__tile[data-selected='true'] { border-color: var(--accent, #38bdf8); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent, #38bdf8), transparent 60%); }
        .pc-frames__tile[data-stale='true'] { opacity: 0.55; }
        .pc-frames__tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
        /* A local desktop has no thumbnail stream — a frame's JPEG loop is a
           frame-side agent. The placeholder keeps the tile the same size as a
           thumbnailed one so the grid does not reflow when frames appear. */
        .pc-frames__tile--local .pc-frames__tile-placeholder {
          display: flex; align-items: center; justify-content: center;
          width: 100%; aspect-ratio: 4 / 3;
          color: var(--fg-mute, #7f9bb4);
          background: rgb(from var(--bg, #07101d) r g b / 0.5);
        }
        .pc-frames__tile-meta {
          position: absolute; left: 0; right: 0; bottom: 0;
          display: flex; align-items: center; gap: 6px;
          padding: 14px 10px 7px;
          background: linear-gradient(to top, rgba(7, 16, 29, 0.92), transparent);
          font-size: 11px; color: var(--fg, #e7f7ff); text-align: left;
        }
        .pc-frames__tile-slug { font-weight: 700; }
        .pc-frames__tile-display { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__tile-role {
          font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
          color: var(--accent, #38bdf8); border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%); border-radius: 5px; padding: 0 5px;
        }
        .pc-frames__tile-age { margin-left: auto; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-frames__panel {
          position: absolute; inset: 56px 16px 16px;
          display: flex; flex-direction: column;
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 14px;
          background: rgba(7, 16, 29, 0.97);
          box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
          z-index: 5;
          overflow: hidden;
        }
        .pc-frames__panel-head {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 12px;
          font-size: 12px; font-weight: 600; color: var(--fg, #e7f7ff);
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        }
        .pc-frames__panel-head svg { color: var(--accent, #38bdf8); }
        .pc-frames__panel-head code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__chip-watch {
          display: inline-flex; align-items: center; gap: 3px;
          font-size: 9.5px; font-weight: 700;
          color: var(--accent, #38bdf8); border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 999px; padding: 0 5px;
        }
        .pc-frames__chip-watch[data-drive='true'] { color: #f87171; border-color: rgba(248, 113, 113, 0.5); }
        .pc-frames__mode {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 9.5px; font-weight: 800; letter-spacing: 0;
          color: var(--accent, #38bdf8); border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 5px; padding: 1px 6px;
        }
        .pc-frames__mode[data-drive='true'] {
          color: #fca5a5; border-color: rgba(248, 113, 113, 0.6);
          background: rgba(239, 68, 68, 0.14);
        }
        .pc-frames__panel-actions { margin-left: auto; display: inline-flex; gap: 6px; }
        .pc-frames__panel-btn {
          font-size: 10.5px; font-weight: 700;
          color: var(--fg-dim, #b9d4e8);
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--border, rgba(125, 211, 252, 0.25));
          border-radius: 6px; padding: 3px 9px; cursor: pointer;
        }
        .pc-frames__panel-btn:hover { color: var(--fg, #e7f7ff); border-color: var(--accent, #38bdf8); }
        .pc-frames__panel-btn[data-active='true'] { color: var(--accent, #38bdf8); border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 50%); }
        .pc-frames__panel-btn[data-danger='true']:hover { color: #fca5a5; border-color: rgba(248, 113, 113, 0.6); }
        .pc-frames__panel-idle { display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--fg-mute, #7f9bb4); }
        .pc-frames__panel-close { background: transparent; border: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; }
        .pc-frames__panel-close:hover { color: var(--fg, #e7f7ff); }
        .pc-frames__panel-img { flex: 1; min-height: 0; object-fit: contain; background: #000; }
        .pc-frames__panel-foot {
          display: flex; align-items: center; gap: 6px;
          padding: 7px 12px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4);
          border-top: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        }
      `}</style>
    </div>
  );
}

export function formatAge(ms: number): string {
  if (ms < 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}
