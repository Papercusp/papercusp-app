/**
 * Desktop streaming egress accounting for the BYOC cost model (P-014 / D-035).
 *
 * Every constant here is MEASURED, not modelled: D-035 ran a four-cell matrix through the real
 * ssh tunnel against GCP VM abar-desktop-c6 with a real browser viewer on the production grant
 * path, with two independent instruments per cell (bytes counted on the wire by the relay, and
 * KasmVNC's own EncodeManager accounting) that agreed within ~2% on the calibration cell.
 *
 * The module's SHAPE is as load-bearing as its numbers, because D-035 produced two findings that
 * are easy to state and easy to quietly violate later. Both are made structurally unavailable
 * rather than written down and hoped for:
 *
 *   1. AN IDLE DESKTOP COSTS EXACTLY ZERO. Not "little" — zero, confirmed independently by the
 *      server (`ComparingUpdateTracker: 0 pixels in / 0 pixels out` across a whole 60s window).
 *      So egress must be billed on ACTIVE VIEWER-SECONDS, never on session wall-clock. There is
 *      deliberately no `attachedSeconds` / `startedAt`+`endedAt` input anywhere in this file: a
 *      caller who wants to bill an idle hour has to first pass it through
 *      `activeViewerSecondsFromFrameActivity`, which returns 0 for it.
 *
 *   2. RESOLUTION IS NOT A COST LEVER. At equal changed area the two geometries landed 8% apart,
 *      with 1080p marginally LOWER. So desktop geometry does not enter the steady-state term at
 *      all — it is used only for the per-attach first paint, which is the one cost that really
 *      does scale with pixels. "Downscale the desktop to save money" therefore cannot be
 *      expressed as a saving by this module, and a test pins that.
 *
 * ⚠ WHAT THE ACTIVE NUMBER IS. It is a SATURATION CEILING, not a demand measurement. The active
 * workload was `glxgears` rendering as fast as it was allowed to, and both cells pinned the
 * encoder at ~0.9-1.0 MiB/s with ~4,400 framebuffer updates in 60s. That is this VM shape's
 * software-encode throughput ceiling (4 vCPU, GPU-less), not what a typical agent desktop
 * demands. Estimates from this module are therefore UPPER BOUNDS per active viewer-second; the
 * honest planning range for real use is bounded below by 0 (idle) and above by these figures.
 *
 * ⚠ WHAT IS NOT MEASURED, and is deliberately not guessed here: KasmVNC's explicit video-mode
 * codec path (`videoCodec` / `VideoTime=0`), the x11vnc local baseline, and any multi-viewer
 * fan-out case. All three need a KasmVNC-bearing host (D-029). Nothing in this file models them.
 */

/** A desktop framebuffer geometry, in pixels. */
export interface DesktopGeometry {
  width: number;
  height: number;
}

/** One measured cell of D-035's egress matrix. */
export interface DesktopEgressCell {
  /** The cell's name in D-035's table. */
  cell: string;
  geometry: DesktopGeometry;
  /** Steady-state wire bytes per second over the 60s measurement window. */
  steadyBytesPerSec: number;
  /** Bytes to first paint plus the 12s settle window, i.e. the per-attach cost. */
  attachBytes: number;
  /** Framebuffer pixels the server reported as CHANGED over the 60s window. */
  changedPixels: number;
}

/**
 * D-035's matrix, verbatim. Steady rates are converted from the recorded KiB/s at 1024 B/KiB.
 *
 * The idle rows are the most important two rows in this file and the reason the model has no
 * idle term at all: there is nothing to multiply, because the measured rate is 0.
 */
export const DESKTOP_EGRESS_MEASUREMENT: readonly DesktopEgressCell[] = [
  {
    cell: 'xga-idle',
    geometry: { width: 1024, height: 768 },
    steadyBytesPerSec: 0,
    attachBytes: 24_367,
    changedPixels: 0,
  },
  {
    cell: 'xga-active',
    geometry: { width: 1024, height: 768 },
    steadyBytesPerSec: Math.round(991.21 * 1024),
    attachBytes: 12_065_639,
    changedPixels: 2_131_000_000,
  },
  {
    cell: 'hd-idle',
    geometry: { width: 1920, height: 1080 },
    steadyBytesPerSec: 0,
    attachBytes: 40_218,
    changedPixels: 0,
  },
  {
    cell: 'hd-active',
    geometry: { width: 1920, height: 1080 },
    steadyBytesPerSec: Math.round(913.69 * 1024),
    attachBytes: 12_102_068,
    changedPixels: 2_085_000_000,
  },
] as const;

/** Provenance every estimate produced here carries, so a number can be traced back to its run. */
export const DESKTOP_EGRESS_EVIDENCE_REF =
  'plan://agent-virtual-desktops-2026-08-23/D-035';

/**
 * Upper bound on steady-state egress per ACTIVE viewer-second, in bytes.
 *
 * The WORSE of the two measured active cells, deliberately: this is a ceiling used for budgeting,
 * so the arithmetic must not quietly pick the friendlier number. Geometry-independent by
 * construction — see finding 2 in the module header.
 */
export const ACTIVE_VIEWER_SECOND_CEILING_BYTES: number = Math.max(
  ...DESKTOP_EGRESS_MEASUREMENT.map((entry) => entry.steadyBytesPerSec),
);

/**
 * Egress per IDLE viewer-second, in bytes. Measured as exactly zero at both geometries.
 *
 * Present as a named constant only so the measurement is legible and so a future change that
 * believes idle costs something has to edit a value the tests pin, rather than adding a term.
 */
export const IDLE_VIEWER_SECOND_BYTES = 0;

const XGA = DESKTOP_EGRESS_MEASUREMENT[0];
const HD = DESKTOP_EGRESS_MEASUREMENT[2];

function pixels(geometry: DesktopGeometry): number {
  return geometry.width * geometry.height;
}

const XGA_PIXELS = pixels(XGA.geometry);
const HD_PIXELS = pixels(HD.geometry);

/**
 * Bytes per pixel and fixed overhead of a first paint, as a two-point linear fit through the two
 * measured IDLE cells.
 *
 * The idle cells are the right two points because their attach figure is a first paint followed
 * by 12 seconds of nothing — so it is a clean per-attach cost. The ACTIVE cells' attach figures
 * (~12 MB) include 12 seconds of animation and measure the encoder, not the paint.
 */
const FIRST_PAINT_BYTES_PER_PIXEL = (HD.attachBytes - XGA.attachBytes) / (HD_PIXELS - XGA_PIXELS);
const FIRST_PAINT_FIXED_BYTES = XGA.attachBytes - FIRST_PAINT_BYTES_PER_PIXEL * XGA_PIXELS;

export interface FirstPaintEstimate {
  bytes: number;
  /**
   * True when the requested geometry lies outside the two measured points, so the figure is an
   * extrapolation rather than an interpolation. Never silently folded away: only two geometries
   * were ever measured, and a caller budgeting for a 4K desktop deserves to know that.
   */
  extrapolated: boolean;
}

/**
 * Per-attach first-paint cost for a geometry.
 *
 * This is the one cost that genuinely scales with pixels (24 KB at XGA, 40 KB at 1080p), and it
 * is charged per ATTACH. The policy consequence recorded in D-035 follows from that shape: rapid
 * re-attach cycling is the expensive viewer behaviour, not long attachment.
 */
export function estimateFirstPaintBytes(geometry: DesktopGeometry): FirstPaintEstimate {
  const px = pixels(geometry);
  if (!Number.isFinite(px) || px <= 0) {
    throw new Error('desktop-egress-accounting — geometry must have positive finite dimensions');
  }
  const bytes = Math.max(0, Math.round(FIRST_PAINT_FIXED_BYTES + FIRST_PAINT_BYTES_PER_PIXEL * px));
  return { bytes, extrapolated: px < XGA_PIXELS || px > HD_PIXELS };
}

/**
 * Convert an observed viewer timeline into the only duration this module will bill on.
 *
 * This exists so that a caller holding a wall-clock attachment window has a legitimate, honest
 * route to an active figure — and so that route yields ZERO for an idle attachment. It is the
 * structural expression of D-035 finding 1: an idle hour cannot be turned into a bill by any
 * path through this file.
 *
 * `framebufferUpdateSeconds` is the number of seconds in which the server sent at least one
 * framebuffer update. It is clamped to the attachment window because a viewer cannot be active
 * for longer than it was attached.
 */
export function activeViewerSecondsFromFrameActivity(input: {
  attachedSeconds: number;
  framebufferUpdateSeconds: number;
}): number {
  const attached = Math.max(0, input.attachedSeconds);
  const active = Math.max(0, input.framebufferUpdateSeconds);
  if (!Number.isFinite(attached) || !Number.isFinite(active)) {
    throw new Error('desktop-egress-accounting — viewer activity seconds must be finite');
  }
  return Math.min(attached, active);
}

/** One viewer's contribution to a billing window. */
export interface DesktopViewerEgressUsage {
  /** Geometry the viewer was attached at — used for first paint only. */
  geometry: DesktopGeometry;
  /**
   * How many times a viewer attached during the window. Each attach pays a first paint.
   * A single long watch is one attach; a flapping reconnect loop is many.
   */
  attaches: number;
  /**
   * Seconds during which the framebuffer was CHANGING while a viewer was attached.
   *
   * NOT the attachment's wall-clock duration. Derive it with
   * `activeViewerSecondsFromFrameActivity` rather than passing a session length.
   */
  activeViewerSeconds: number;
}

export interface DesktopEgressEstimate {
  bytes: number;
  breakdown: {
    firstPaintBytes: number;
    steadyStateBytes: number;
  };
  /**
   * Always `saturation-ceiling`: the steady term uses the measured encoder ceiling, so the total
   * is an upper bound on this shape, not an expected value (D-035 finding 3).
   */
  basis: 'saturation-ceiling';
  /** True when any viewer's geometry fell outside the two measured points. */
  extrapolatedGeometry: boolean;
  evidenceRef: string;
}

/**
 * Estimate the streaming egress of one or more attached desktop viewers over a billing window.
 *
 * Note what is absent: the window's own length. A billing window contributes nothing on its own —
 * only attaches and active viewer-seconds do. That is the point.
 */
export function estimateDesktopStreamEgressBytes(
  usage: readonly DesktopViewerEgressUsage[],
): DesktopEgressEstimate {
  let firstPaintBytes = 0;
  let steadyStateBytes = 0;
  let extrapolatedGeometry = false;

  for (const viewer of usage) {
    const attaches = Math.max(0, Math.trunc(viewer.attaches));
    const activeSeconds = Math.max(0, viewer.activeViewerSeconds);
    if (!Number.isFinite(attaches) || !Number.isFinite(activeSeconds)) {
      throw new Error('desktop-egress-accounting — viewer usage must be finite and non-negative');
    }
    const paint = estimateFirstPaintBytes(viewer.geometry);
    if (paint.extrapolated) extrapolatedGeometry = true;
    firstPaintBytes += paint.bytes * attaches;
    steadyStateBytes += Math.round(activeSeconds * ACTIVE_VIEWER_SECOND_CEILING_BYTES);
  }

  return {
    bytes: firstPaintBytes + steadyStateBytes,
    breakdown: { firstPaintBytes, steadyStateBytes },
    basis: 'saturation-ceiling',
    extrapolatedGeometry,
    evidenceRef: DESKTOP_EGRESS_EVIDENCE_REF,
  };
}

const BYTES_PER_GIB = 1024 ** 3;

export interface DesktopEgressCostEstimate {
  cents: number;
  currency: string;
  source: string;
  evidenceRef: string;
  estimatedAt: string;
  bytes: number;
  basis: 'saturation-ceiling';
}

/**
 * Price a desktop-streaming egress window into the shape the hosted lifecycle cost model consumes
 * (`HostedCostEstimate` in hosted-lifecycle-policy.ts).
 *
 * `centsPerGiB` is REQUIRED and deliberately un-defaulted. Egress pricing is provider-, region-
 * and tier-specific, and D-035 measured bytes, not money — so a default here would be an invented
 * number wearing measured provenance. A caller without a real price should not be producing a
 * cost estimate at all.
 *
 * `cents` is rounded UP: this is a budget ceiling, and a sub-cent window that rounds to zero would
 * let unbounded viewer activity accumulate no committed cost.
 */
export function estimateDesktopEgressCost(input: {
  usage: readonly DesktopViewerEgressUsage[];
  centsPerGiB: number;
  currency: string;
  /** Where the price came from, e.g. 'gcp-network-egress-2026-08'. */
  priceSource: string;
  estimatedAt: string;
}): DesktopEgressCostEstimate {
  if (!Number.isFinite(input.centsPerGiB) || input.centsPerGiB < 0) {
    throw new Error('desktop-egress-accounting — centsPerGiB must be a non-negative finite number');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error('desktop-egress-accounting — currency must be an ISO-4217 code');
  }
  if (input.priceSource.trim().length === 0) {
    throw new Error('desktop-egress-accounting — priceSource is required');
  }
  if (!Number.isFinite(Date.parse(input.estimatedAt))) {
    throw new Error('desktop-egress-accounting — estimatedAt must be an ISO timestamp');
  }

  const estimate = estimateDesktopStreamEgressBytes(input.usage);
  const cents = Math.ceil((estimate.bytes / BYTES_PER_GIB) * input.centsPerGiB);
  return {
    cents,
    currency: input.currency,
    source: `desktop-egress:${input.priceSource}`,
    evidenceRef: estimate.evidenceRef,
    estimatedAt: input.estimatedAt,
    bytes: estimate.bytes,
    basis: estimate.basis,
  };
}
