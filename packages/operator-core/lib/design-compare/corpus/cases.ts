/**
 * The committed design-compare validation corpus (P-002).
 *
 * WHAT THIS CORPUS IS, AND WHAT IT IS NOT
 * ---------------------------------------
 * Every image here is SYNTHETIC. None of it is a real screenshot, a real Figma
 * export, or a real model-painted mockup. That is deliberate and it bounds the
 * claim this corpus is allowed to support.
 *
 * D-007 asserts that pixel-diff gateability is a property of the REFERENCE CLASS,
 * because the three classes fail in different ways. That assertion needs two
 * separate things to become true, and they are separable:
 *
 *   1. A calibration METHOD that can tell a gateable class from an ungateable one
 *      at all, and that reports a number rather than an opinion.
 *   2. Real per-class measurements from real surfaces.
 *
 * This corpus delivers (1) and only (1). Each class is modelled by its
 * characteristic NOISE PROFILE — the difference a *faithful* implementation still
 * produces against that kind of reference — and the corpus then asks whether any
 * threshold separates faithful from drifted. (2) is P-008's real-surface cohort,
 * and until P-008 lands, no class may be promoted to `gateable` on the strength
 * of these fixtures alone. The numbers below are properties of a model, not
 * measurements of production.
 *
 * The noise models, and why each is drawn the way it is:
 *
 *   artifact-capture  Two real renders of the same DOM at a contracted
 *                     environment. Geometry is identical; only glyph edges
 *                     disagree, because rasterisers antialias differently.
 *                     Modelled by changing `edgeAlpha` alone.
 *
 *   figma-export      A vector export against a browser render. Geometry is
 *                     nominally identical but stem weights and edge treatment
 *                     differ more than between two browser renders. Modelled by a
 *                     larger `edgeAlpha` delta plus a stem-width change.
 *
 *   raster-mockup     A painted image against a real render. The model
 *                     hallucinates letterforms (glyphs land in different PLACES,
 *                     not merely with different edges), shifts the palette of
 *                     every large fill, and tints the background. A perfectly
 *                     faithful implementation still differs from it almost
 *                     everywhere. Modelled by pitch change + palette shift + wash.
 */
import type { ReferenceClass } from '../contract';
import {
  type RGB,
  type Raster,
  applyVerticalWash,
  createRaster,
  drawGlyphRun,
  fillRect,
  strokeRect,
} from './synthesize';

export const CORPUS_CANVAS = { width: 320, height: 240 } as const;

/** The palette a real render would produce. */
const TRUE_PALETTE = {
  background: [255, 255, 255] as RGB,
  header: [37, 99, 235] as RGB,
  sidebar: [241, 245, 249] as RGB,
  cardBorder: [226, 232, 240] as RGB,
  button: [37, 99, 235] as RGB,
  glyph: [51, 65, 85] as RGB,
  headerGlyph: [255, 255, 255] as RGB,
} as const;

/**
 * The palette a generative model produces when asked to paint the SAME design.
 * Every value is close enough that a reviewer would call it correct and far
 * enough that no pixel of a large fill matches.
 */
const PAINTED_PALETTE = {
  background: [255, 255, 255] as RGB,
  header: [47, 107, 224] as RGB,
  sidebar: [238, 243, 248] as RGB,
  cardBorder: [222, 229, 238] as RGB,
  button: [45, 105, 226] as RGB,
  glyph: [56, 69, 88] as RGB,
  headerGlyph: [253, 253, 255] as RGB,
} as const;

interface ScenePalette {
  readonly background: RGB;
  readonly header: RGB;
  readonly sidebar: RGB;
  readonly cardBorder: RGB;
  readonly button: RGB;
  readonly glyph: RGB;
  readonly headerGlyph: RGB;
}

interface SceneParams {
  readonly palette: ScenePalette;
  /** Vertical origin of the content card. A change here is a real layout regression. */
  readonly cardY: number;
  /** Antialiasing model for glyph edges. A change here is legitimate render noise. */
  readonly edgeAlpha: number;
  /** Glyph stem width. A change here is a rasteriser/weight difference. */
  readonly glyphWidth: number;
  /** Glyph advance. A change here means letterforms land in different PLACES. */
  readonly glyphPitch: number;
  /** Vertical offset applied to card text only. Models a baseline regression. */
  readonly textBaselineOffset: number;
  /** Global tint, present only for painted references. */
  readonly wash?: { readonly top: RGB; readonly bottom: RGB };
  /** Canvas width override, used only by the dimension-precondition fixtures. */
  readonly width?: number;
}

const BASE_SCENE: SceneParams = {
  palette: TRUE_PALETTE,
  cardY: 56,
  edgeAlpha: 0.5,
  glyphWidth: 4,
  glyphPitch: 8,
  textBaselineOffset: 0,
};

/**
 * Paint the reference UI: header bar, sidebar with nav items, a content card with
 * three lines of text, and a primary button. Small enough to compare quickly,
 * structured enough that a layout regression and an antialiasing difference are
 * genuinely different kinds of change.
 */
export function paintScene(params: SceneParams): Raster {
  const width = params.width ?? CORPUS_CANVAS.width;
  const { height } = CORPUS_CANVAS;
  const { palette, glyphWidth, glyphPitch, edgeAlpha } = params;
  const raster = createRaster(width, height, palette.background);

  // Header bar with a title run.
  fillRect(raster, 0, 0, width, 32, palette.header);
  drawGlyphRun(raster, {
    x: 12,
    y: 11,
    glyphCount: 10,
    glyphWidth,
    glyphHeight: 10,
    pitch: glyphPitch,
    colour: palette.headerGlyph,
    edgeAlpha,
  });

  // Sidebar with three nav rows.
  fillRect(raster, 0, 32, 64, height - 32, palette.sidebar);
  for (let row = 0; row < 3; row += 1) {
    drawGlyphRun(raster, {
      x: 10,
      y: 48 + row * 24,
      glyphCount: 5,
      glyphWidth,
      glyphHeight: 8,
      pitch: glyphPitch,
      colour: palette.glyph,
      edgeAlpha,
    });
  }

  // Content card.
  const cardX = 80;
  const cardWidth = 220;
  const cardHeight = 84;
  fillRect(raster, cardX, params.cardY, cardWidth, cardHeight, palette.background);
  strokeRect(raster, cardX, params.cardY, cardWidth, cardHeight, palette.cardBorder);
  for (let line = 0; line < 3; line += 1) {
    drawGlyphRun(raster, {
      x: cardX + 12,
      y: params.cardY + 14 + line * 20 + params.textBaselineOffset,
      glyphCount: 22,
      glyphWidth,
      glyphHeight: 9,
      pitch: glyphPitch,
      colour: palette.glyph,
      edgeAlpha,
    });
  }

  // Primary button with a label run.
  fillRect(raster, cardX, 160, 80, 30, palette.button);
  drawGlyphRun(raster, {
    x: cardX + 10,
    y: 170,
    glyphCount: 6,
    glyphWidth,
    glyphHeight: 9,
    pitch: glyphPitch,
    colour: palette.headerGlyph,
    edgeAlpha,
  });

  if (params.wash) {
    applyVerticalWash(raster, params.wash.top, params.wash.bottom);
  }
  return raster;
}

/** Every image in the corpus, keyed. Each renders deterministically from code. */
export interface CorpusImage {
  readonly key: string;
  readonly description: string;
  readonly render: () => Raster;
}

const scene = (overrides: Partial<SceneParams> = {}): (() => Raster) => {
  return () => paintScene({ ...BASE_SCENE, ...overrides });
};

export const CORPUS_IMAGES: readonly CorpusImage[] = [
  // ---- artifact-capture: two real renders of the same DOM ----
  {
    key: 'artifact/reference',
    description: 'Ratified capture of the design at the contracted environment.',
    render: scene({ edgeAlpha: 0.5 }),
  },
  {
    key: 'artifact/faithful',
    description:
      'Faithful re-implementation. Identical geometry; glyph edges antialias differently.',
    render: scene({ edgeAlpha: 0.62 }),
  },
  {
    key: 'artifact/drifted',
    description: 'Real regression: the content card sits 6px lower than the reference.',
    render: scene({ edgeAlpha: 0.5, cardY: 62 }),
  },

  // ---- figma-export: vector export against a browser render ----
  {
    key: 'figma/reference',
    description: 'Figma node exported at exact dimensions with matching fonts.',
    render: scene({ edgeAlpha: 0.4, glyphWidth: 4 }),
  },
  {
    key: 'figma/faithful',
    description:
      'Faithful browser render of the same node. Heavier edge treatment than the vector export.',
    render: scene({ edgeAlpha: 0.72, glyphWidth: 4 }),
  },
  {
    key: 'figma/drifted',
    description: 'Real regression: wrong button colour and a 3px text baseline shift.',
    render: scene({
      edgeAlpha: 0.4,
      glyphWidth: 4,
      textBaselineOffset: 3,
      palette: { ...TRUE_PALETTE, button: [220, 38, 38] },
    }),
  },

  // ---- raster-mockup: a painted image against a real render ----
  {
    key: 'mockup/reference',
    description:
      'Model-painted mockup: hallucinated letterform pitch, shifted palette, background tint.',
    render: scene({
      palette: PAINTED_PALETTE,
      glyphPitch: 9,
      edgeAlpha: 0.55,
      wash: { top: [252, 250, 248], bottom: [246, 248, 252] },
    }),
  },
  {
    key: 'mockup/faithful',
    description:
      'CORRECT implementation of the painted design. Still differs almost everywhere from it.',
    render: scene({}),
  },
  {
    key: 'mockup/drifted',
    description: 'Incorrect implementation: card 10px low and the wrong button colour.',
    render: scene({
      cardY: 66,
      palette: { ...TRUE_PALETTE, button: [220, 38, 38] },
    }),
  },

  // ---- dimension-precondition fixtures (engine proof, not calibration) ----
  {
    key: 'dimension/reference',
    description: 'Baseline at the contracted 320x240 viewport.',
    render: scene({}),
  },
  {
    key: 'dimension/wider-same-content',
    description:
      'Identical content on a 360px-wide canvas. The engine-divergence fixture: proves a size change can read as a clean pass.',
    render: scene({ width: 360 }),
  },
] as const;

export type CorpusImageKey = (typeof CORPUS_IMAGES)[number]['key'];

/** A reference/candidate pair the calibration harness measures. */
export interface CorpusPair {
  readonly id: string;
  readonly referenceClass: ReferenceClass;
  /**
   * `faithful` — a correct implementation. Its diff is the class's NOISE FLOOR.
   * `drifted`  — a genuine regression. Its diff is what a gate must catch.
   */
  readonly kind: 'faithful' | 'drifted';
  readonly reference: string;
  readonly candidate: string;
}

export const CORPUS_PAIRS: readonly CorpusPair[] = [
  {
    id: 'artifact-capture/faithful',
    referenceClass: 'artifact-capture',
    kind: 'faithful',
    reference: 'artifact/reference',
    candidate: 'artifact/faithful',
  },
  {
    id: 'artifact-capture/drifted',
    referenceClass: 'artifact-capture',
    kind: 'drifted',
    reference: 'artifact/reference',
    candidate: 'artifact/drifted',
  },
  {
    id: 'figma-export/faithful',
    referenceClass: 'figma-export',
    kind: 'faithful',
    reference: 'figma/reference',
    candidate: 'figma/faithful',
  },
  {
    id: 'figma-export/drifted',
    referenceClass: 'figma-export',
    kind: 'drifted',
    reference: 'figma/reference',
    candidate: 'figma/drifted',
  },
  {
    id: 'raster-mockup/faithful',
    referenceClass: 'raster-mockup',
    kind: 'faithful',
    reference: 'mockup/reference',
    candidate: 'mockup/faithful',
  },
  {
    id: 'raster-mockup/drifted',
    referenceClass: 'raster-mockup',
    kind: 'drifted',
    reference: 'mockup/reference',
    candidate: 'mockup/drifted',
  },
] as const;

/** The classes the corpus carries calibration pairs for. */
export const CALIBRATED_CLASSES: readonly ReferenceClass[] = [
  'artifact-capture',
  'figma-export',
  'raster-mockup',
] as const;

export function imageByKey(key: string): CorpusImage {
  const found = CORPUS_IMAGES.find((image) => image.key === key);
  if (!found) throw new Error(`corpus: no image registered under key '${key}'`);
  return found;
}
