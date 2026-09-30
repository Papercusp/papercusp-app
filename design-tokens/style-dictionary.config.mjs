// SPDX-License-Identifier: Elastic-2.0
// Style Dictionary v4 config for papercup (desktop + harness).
//
// Emits two CSS files imported by apps/operator/app/globals.css:
//   _brand-primitives.css  — workspace brand palette as CSS variables (--sky-400 etc.)
//   _semantic.css          — desktop's semantic + ink layer as CSS variables (--bg, --accent etc.)
//
// Tooling (transforms + preflight) comes from @papercusp/token-kit — generic,
// brand-value-free, shared with Restart's @papercusp/design-tokens. Only the
// papercup-specific *.tokens.json values + the platform wiring below live here.
//
// Mobile mirrors primitives.tokens.json (see Phase 4); each platform's
// semantic/component layers stay local.

import { globSync } from "node:fs";
import StyleDictionary from "style-dictionary";
import { transforms, preflight } from "@papercusp/token-kit";

preflight(globSync("design-tokens/*.tokens.json"));

for (const t of transforms) StyleDictionary.registerTransform(t);

// Theme-variant name transform. Theme platforms (css-semantic-<theme>) are each
// filtered to a single namespace (e.g. `black.*`), so dropping the leading path
// segment makes their tokens emit the SAME var names as the base semantic layer
// (`black.bg` → `--bg`). That's what lets a `[data-theme]` block override the
// `:root` values rather than introduce parallel `--black-bg` vars.
StyleDictionary.registerTransform({
  name: "tokenkit/name-theme",
  type: "name",
  transform: (t) => t.path.slice(1).join("-").toLowerCase(),
});

// Theme namespaces — each is a top-level key holding a semantic-override set,
// emitted to its own `[data-theme="<name>"]` block. Frost is NOT here: it is the
// base `:root` layer (top-level semantic keys), not a variant.
const THEME_NAMESPACES = ["black", "honeycomb", "portal-light", "portal-dark"];
const isThemeToken = (t) => THEME_NAMESPACES.includes(t.path[0]);

// Filter: primitives layer only (anything under `color.*`).
const isPrimitive = (t) => t.path[0] === "color";

// Filter: base semantic layer — top-level non-color, non-meta, non-theme keys.
// Includes motion tokens (ease/dur), elevation (card-shadow), and overlays
// (frost), which share the desktop CSS-var namespace. Theme namespaces are
// excluded so they only flow to their own css-semantic-<theme> platform.
const isSemantic = (t) => t.path[0] !== "color" && !t.path[0].startsWith("_") && !isThemeToken(t);

const sharedTransforms = ["attribute/cti", "tokenkit/srgb", "tokenkit/name"];
const themeTransforms = ["attribute/cti", "tokenkit/srgb", "tokenkit/name-theme"];

export default {
  source: ["design-tokens/*.tokens.json"],
  platforms: {
    "css-primitives": {
      transforms: sharedTransforms,
      buildPath: "apps/operator/app/",
      files: [
        {
          destination: "_brand-primitives.css",
          format: "css/variables",
          options: { outputReferences: false, selector: ":root" },
          filter: isPrimitive,
        },
      ],
    },
    "css-semantic": {
      transforms: sharedTransforms,
      buildPath: "apps/operator/app/",
      files: [
        {
          destination: "_semantic.css",
          format: "css/variables",
          options: { outputReferences: true, selector: ":root" },
          filter: isSemantic,
        },
        // Frost as an EXPLICITLY scopable theme block. Frost is the :root default
        // (the block above), but a `[data-theme="frost"]` selector lets a subtree
        // render frost even when an ancestor (e.g. <html>) is on another theme —
        // needed for the per-theme preview swatches in the settings picker and the
        // Phase-4 custom-theme editor. Colors only (matches what themes override);
        // literals (outputReferences:false) so the block is self-contained.
        {
          destination: "_semantic.frost.css",
          format: "css/variables",
          options: { outputReferences: false, selector: '[data-theme="frost"], [data-theme-base="frost"]' },
          filter: (t) => isSemantic(t) && t.$type === "color",
        },
      ],
    },
    // Black theme — semantic-override set emitted under [data-theme="black"].
    // outputReferences:false because the black values are literals (no aliases);
    // name-theme strips the `black.` namespace so vars match the base layer.
    "css-semantic-black": {
      transforms: themeTransforms,
      buildPath: "apps/operator/app/",
      files: [
        {
          destination: "_semantic.black.css",
          format: "css/variables",
          options: { outputReferences: false, selector: '[data-theme="black"], [data-theme-base="black"]' },
          filter: (t) => t.path[0] === "black",
        },
      ],
    },
    // Honeycomb theme — selectable The Swarm color system, using the darker
    // ominous amber/charcoal palette from the swarm identity demo.
    "css-semantic-honeycomb": {
      transforms: themeTransforms,
      buildPath: "apps/operator/app/",
      files: [
        {
          destination: "_semantic.honeycomb.css",
          format: "css/variables",
          options: { outputReferences: false, selector: '[data-theme="honeycomb"], [data-theme-base="honeycomb"]' },
          filter: (t) => t.path[0] === "honeycomb",
        },
      ],
    },
    // Hosted-portal companions. These are real Papercusp semantic themes, not
    // iframe-only CSS aliases: portalEmbed selects them before paint, and the
    // ordinary theme picker may select them directly too.
    "css-semantic-portal-light": {
      transforms: themeTransforms,
      buildPath: "apps/operator/app/",
      files: [
        {
          destination: "_semantic.portal-light.css",
          format: "css/variables",
          options: { outputReferences: false, selector: '[data-theme="portal-light"], [data-theme-base="portal-light"]' },
          filter: (t) => t.path[0] === "portal-light",
        },
      ],
    },
    "css-semantic-portal-dark": {
      transforms: themeTransforms,
      buildPath: "apps/operator/app/",
      files: [
        {
          destination: "_semantic.portal-dark.css",
          format: "css/variables",
          options: { outputReferences: false, selector: '[data-theme="portal-dark"], [data-theme-base="portal-dark"]' },
          filter: (t) => t.path[0] === "portal-dark",
        },
      ],
    },
  },
  log: {
    verbosity: "default",
    warnings: "warn",
    errors: { brokenReferences: "throw" },
  },
};
