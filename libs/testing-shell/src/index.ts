/**
 * @papercusp/testing-shell — public surface.
 *
 * - registry: defineTestDomain + TestDomain/TestSection/TestRunner types (P-001)
 * - DomainTestPanel: the shared subtab shell, parameterized by dataSource (P-002)
 * - data-source: the TestingDataSource interface + wire types + the
 *   default adminTestingDataSource (P-002)
 * - TestingShell: the left-rail + panel host, parameterized by tabs /
 *   tierLabels / dataSource / customTabs (P-003)
 * - run-status: parseRunnerStatus — the per-runner result→ChipStatus
 *   contract a backend calls after running a test (P-013)
 * - junit: aggregateJUnitCases — the pure JUnit rollup both projects'
 *   CI-results views share (P-012 data layer)
 * - k6: category taxonomy + filter helpers for the DomainTestPanel k6
 *   controls (P-010, ported from Restart /load-tests)
 * - sse: readSSEStream + pure frame helpers, so a host TestingDataSource can
 *   implement the optional streamRun live-log path (P-011)
 * - AdoptionMatrixPanel: the testing-spec adoption matrix, host-injected via
 *   load(signal)/reloadKey (promoted from Restart for cross-project use)
 */
export * from './registry';
export * from './data-source';
export * from './run-status';
export * from './junit';
export * from './k6';
export * from './sse';
export { default as JUnitRollupPanel, type JUnitRollupPanelProps } from './JUnitRollupPanel';
export * from './platform';
export * from './web/observer';
export { default as LiveWebPanel } from './web/LiveWebPanel';
export { default as ChaosWebPanel, type ChaosWebPanelProps } from './web/ChaosWebPanel';
export { default as LoadTestPanel, type LoadTestPanelProps } from './web/LoadTestPanel';
export { default as AiExplorePanel, type AiExplorePanelProps, type AiExploreModelOption } from './web/AiExplorePanel';
export {
  default as AdoptionMatrixPanel,
  type AdoptionMatrix,
  type AdoptionMatrixPanelProps,
  type AdoptionPackageStatus,
} from './AdoptionMatrix';
export { default as DomainTestPanel } from './DomainTestPanel';
export { default as TestingShell, tabsFromRegistry } from './TestingShell';
export type { TestingShellTab, TestingShellProps } from './TestingShell';
export { buildUniversalTesting, type UniversalTestingConfig, type UniversalTesting } from './registry/universal-tabs';
export { default as ChaosDesktopPanel, type ChaosDesktopPanelProps } from './desktop/ChaosDesktopPanel';
export { default as RecorderHost } from './desktop/RecorderHost';
export * from './desktop/recorder-channel';
export { default as LlmTestPanel, type LlmTestPanelProps } from './llm/LlmTestPanel';
