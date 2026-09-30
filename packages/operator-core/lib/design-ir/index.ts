export {
  IR_VERSION,
  uiIrSchema,
  type UiIr,
  type UiNode,
  type Copy,
  type ComponentBinding,
  type ProposedToken,
  type A11yNode,
  type Motion,
} from './schema';
export {
  validateIr,
  assertValidIr,
  IrValidationError,
  type ValidationResult,
  type ValidationError,
} from './validate';
export {
  lintIr,
  lintErrors,
  type LintIssue,
  type LintContext,
  type Severity,
} from './lint';
