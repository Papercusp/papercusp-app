export type {
  ComponentCheckResult,
  ComponentEvaluation,
  ComponentRawVerdict,
  ComponentSpec,
  ComponentVerdict,
  EvidenceRef,
  LineageStamp,
  ReleaseProfileSpec,
  ReleaseProfileVerdict,
} from './types';
export { evaluateReleaseProfile, lineageMismatches, type EvaluateReleaseProfileOpts } from './evaluate';
