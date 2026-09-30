// @papercusp/ui-primitives/override — the "workspace default vs session
// override" primitive (sentinel-herald P-035).
//
// A standalone subpath barrel so consumers can adopt the override pattern
// WITHOUT pulling the package's heavy peer deps (react-markdown, react-virtuoso,
// anser, …) that the top-level index re-exports. Import from
// '@papercusp/ui-primitives/override', not the package root.
//
// The value backbone (isOverridden / effectiveValue / defaultEq), the
// presentational <OverridableSetting> badge+reset chrome, and its injected
// pc-override-* styles.

export { default as OverridableSetting, OverridableSettingStyle } from './OverridableSetting';
export type { OverridableSettingProps, OverrideBadgeStyle } from './OverridableSetting';
export { isOverridden, effectiveValue, defaultEq } from './isOverridden';
export { OVERRIDE_CSS } from './override.styles';
