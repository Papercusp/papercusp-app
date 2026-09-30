/**
 * Authoring diagnostics for acceptance-rubric methods.
 *
 * Acceptance judges can inspect cited files and invoke MCP tools, but their role
 * does not grant native shell execution. A method that tells the judge to run a
 * shell command therefore produces an ungradeable criterion. This stays advisory:
 * the criterion may still be intentionally manual, and MCP instructions such as
 * `testing:run` are valid judge actions.
 */

export type AcceptanceMethodLintMarker = 'npm-run' | 'proc-path' | 'pgrep' | 'backticked-shell';

export interface AcceptanceMethodLintFinding {
  code: 'acceptance-method-native-shell';
  criterionKey: string;
  markers: AcceptanceMethodLintMarker[];
  message: string;
}

export interface CriterionMethodForLint {
  key: string;
  method?: string | null;
}

const NPM_RUN_RE = /\bnpm\s+run\b/i;
const PROC_PATH_RE = /(?:^|[\s`])\/proc(?:\/|[\s`]|$)/i;
const PGREP_RE = /\bpgrep\b/i;

// Keep this list deliberately narrow. It catches a command-shaped inline shell
// instruction without treating a backticked MCP tool name (`testing:run`,
// `plans:audit`, …) as a native command.
const BACKTICKED_SHELL_RE =
  /`\s*(?:npm|npx|pnpm|yarn|bun|node|bash|sh|zsh|cargo|git|curl|wget|ps|cat|sed|awk|grep|find|kill|systemctl|python(?:3)?|tsx)\b[^`]*`/i;

const METHOD_ADVICE =
  'Acceptance judges cannot run native shell commands. Use MCP evidence instead: testing:run/testing:runs for test outcomes, plans:audit or cited source/tests for code truth, and state:read or a recorded artifact for runtime facts. MCP tool instructions such as testing:run remain valid.';

/**
 * Return advisory findings for acceptance criteria whose method asks for a
 * native-shell action. Standard rubrics are intentionally handled by the caller
 * and are not included in this acceptance-specific lint.
 */
export function lintAcceptanceCriterionMethods(
  criteria: readonly CriterionMethodForLint[],
): AcceptanceMethodLintFinding[] {
  const findings: AcceptanceMethodLintFinding[] = [];
  for (const criterion of criteria) {
    const method = criterion.method?.trim();
    if (!method) continue;

    const markers: AcceptanceMethodLintMarker[] = [];
    if (NPM_RUN_RE.test(method)) markers.push('npm-run');
    if (PROC_PATH_RE.test(method)) markers.push('proc-path');
    if (PGREP_RE.test(method)) markers.push('pgrep');
    if (BACKTICKED_SHELL_RE.test(method)) markers.push('backticked-shell');
    if (markers.length === 0) continue;

    findings.push({
      code: 'acceptance-method-native-shell',
      criterionKey: criterion.key,
      markers,
      message: `${METHOD_ADVICE} Rewrite the method as a readable evidence procedure, or leave it explicitly manual; this is an authoring advisory, not a rejection.`,
    });
  }
  return findings;
}

