/**
 * @papercusp/template-kit — pure schema + validation kit for the templates
 * system (plan app-templates-2026-07-04).
 *
 * P-004: the component-manifest format + validator + the curated catalog.
 * P-005: the template.yaml schema + validator + catalog cross-validation.
 * P-014: multi-template composition semantics (validateTemplateSet,
 *        composeTemplates — the union-of-checks) + the reference 3-way split.
 * P-007: the checks-config seam — the JSON schema an app provides to
 *        parameterize the portable template checks (templates/<id>/checks/).
 */
export {
  parseComponentManifest,
  validateCatalog,
  validateComponentManifest,
  type ComponentKind,
  type ComponentManifest,
  type ComponentSource,
  type ComponentTier,
} from "./component-manifest.js";
export { COMPONENT_CATALOG } from "./catalog.js";
export {
  isOptionalSelect,
  MUST_PROSE_ONLY,
  parseTemplateManifest,
  selectingDecisionPoints,
  TEMPLATE_CATEGORIES,
  unenforcedMusts,
  validateTemplateAgainstCatalog,
  validateTemplateManifest,
  type TemplateCategory,
  type TemplateCheck,
  type TemplateComponentRef,
  type TemplateDecisionOption,
  type TemplateDecisionPoint,
  type TemplateDecisionSelect,
  type TemplateManifest,
  type TemplateMust,
  type TemplateRequireRef,
  type TemplateScope,
} from "./template-manifest.js";
export {
  composeTemplates,
  resolveRequiresClosure,
  resolveSelection,
  validateTemplateSet,
  type ComposedFrom,
  type ResolvedSelection,
  type TemplateComposition,
} from "./composition.js";
export {
  lintTemplateProse,
  type TemplateProseFile,
  type TemplateProseLintInput,
} from "./guide-lint.js";
export {
  parseChecksConfig,
  validateChecksConfig,
  type ChecksBootSection,
  type ChecksNativeDesktopSection,
  type ChecksComponentsSection,
  type ChecksCompositionSection,
  type ChecksConfinementSection,
  type ChecksGymSection,
  type ChecksIphoneAssertionCommand,
  type ChecksIphoneShellPaths,
  type ChecksIphoneShellSection,
  type ChecksMobileBaseSection,
  type ChecksMobileCommand,
  type ChecksSeamSection,
  type TemplateChecksConfig,
} from "./checks-config.js";
export {
  PAPERCUSP_APP_TEMPLATE,
  PAPERCUSP_DATA_LAYER_TEMPLATE,
  PAPERCUSP_DATA_SYNC_TEMPLATE,
  PAPERCUSP_MOBILE_BASE_TEMPLATE,
  PAPERCUSP_ANDROID_SHELL_TEMPLATE,
  PAPERCUSP_ANDROID_APP_TEMPLATE,
  PAPERCUSP_IPHONE_SHELL_TEMPLATE,
  PAPERCUSP_IPHONE_APP_TEMPLATE,
  PAPERCUSP_OPS_HIVES_TEMPLATE,
  PAPERCUSP_SEARCH_TEMPLATE,
  PAPERCUSP_UI_TEMPLATE,
  REFERENCE_TEMPLATES,
  RELEASE_PIPELINE_TEMPLATE,
  TAURI_DESKTOP_SHELL_TEMPLATE,
} from "./reference-templates.js";
