// @papercusp/ui-primitives — self-contained, domain-agnostic UI primitives.
//
// Pure peer-dep React components. No internal coupling beyond npm packages.
// Intended for cross-app reuse via git submodule.

export {
  ACTIVITY_FILTERS,
  ActivityTimelineView,
  activityDayLabel,
  filterActivityEvents,
  formatEventTime,
  formatRelativeTime,
  groupActivityEventsByDay,
  type ActivityDayGroup,
  type ActivityEventKind,
  type ActivityFilter,
  type ActivityTimelineEvent,
  type ActivityTimelineViewProps,
} from './ActivityTimelineView';
export { JsonTree } from './JsonTree';
export { LogView, type LogEvent, type LogTab, type LogViewProps, type AppLinkConfig } from './LogView';
export { MarkdownView } from './MarkdownView';
export {
  PlanDocumentView,
  PlanDocumentJump,
  PlanDocumentFrontmatter,
  attachPlanDocumentRefClickHandler,
  decoratePlanDocumentDom,
  expandPlanDocumentWikiLinks,
  findPlanDocumentHeading,
  neutralizePlanDocumentPlantuml,
  planDocumentFallbackSurface,
  rankPlanDocumentCandidates,
  scrollPlanDocumentTarget,
  stripPlanFrontmatter,
  PLANTUML_NEUTRALIZED_CLASS,
  type PlanDocumentCandidate,
  type PlanDocumentDecision,
  type PlanDocumentItem,
  type PlanDocumentTheme,
  type PlanDocumentViewProps,
} from './PlanDocumentView';
export { Panel } from './Panel';
export { StatCard } from './StatCard';
export { StatusPill, type FeatureStatus } from './StatusPill';
export {
  BuildHistoryList,
  ProjectHistoryView,
  filterBuildHistory,
  formatBuildDate,
  historyDocumentCloseHref,
  historyDocumentHref,
  historyHref,
  historyWorkItemCloseHref,
  historyWorkItemHref,
  planCommits,
  summarizeBuildHistory,
  summarizeBuildItemEvidence,
  type BuildHistoryCommit,
  type BuildHistoryDateFilter,
  type BuildHistoryDecision,
  type BuildHistoryFilters,
  type BuildHistoryPlan,
  type BuildHistoryPlanItem,
  type BuildHistoryProject,
  type BuildHistoryRepository,
  type BuildHistorySnapshotSource,
  type BuildHistoryTarget,
  type BuildHistoryValidationAssertion,
  type BuildHistoryValidationStatus,
  type BuildHistoryValidationSummary,
  type BuildHistoryWorkItem,
  type ProjectHistoryPlan,
  type ProjectHistoryTarget,
  type ProjectHistoryWorkItem,
} from './ProjectHistoryView';

// Theme system — headless [data-theme] switcher + framework-agnostic runtime.
export {
  ThemeSwitcher,
  type ThemeOption,
  type ThemeSwitcherProps,
  useTheme,
  applyTheme,
  getActiveTheme,
  subscribe as subscribeTheme,
  STORAGE_KEY as THEME_STORAGE_KEY,
  THEME_EVENT,
  DEFAULT_THEME,
  PREPAINT_SNIPPET,
} from './theme';

// The "workspace default vs session override" primitive (isOverridden /
// effectiveValue / <OverridableSetting>) lives in the dedicated './override'
// subpath, NOT this top-level barrel — importing it must not drag in the heavy
// peer deps (react-markdown, react-virtuoso, anser) the components above pull.
// Consumers import from '@papercusp/ui-primitives/override'. Lifted out of
// apps/operator-vite in sentinel-herald P-035 so both operator apps share ONE copy.
