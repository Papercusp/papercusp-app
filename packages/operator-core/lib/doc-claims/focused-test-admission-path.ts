/**
 * Doc claim: `testing:run` reaches the Vitest router WITHOUT the pc-heavy admission ticket.
 *
 * Three prose sites now route agents to `testing:run { files }` for focused verification
 * *specifically because* it does not queue behind the shared heavy-command semaphore:
 *
 *   1. `scripts/pc-heavy.sh` header, under PC_HEAVY_GATE_RESERVE — "For a FOCUSED TEST, do
 *      not reach for this at all: `testing:run { files }` spawns the test router directly
 *      and takes no admission ticket."
 *   2. `agent-tools/testing/affected-plan.ts` — surfaces "testing:run { files } (no
 *      admission ticket)" to the caller in its remediation string.
 *   3. The repo `CLAUDE.md` tool-routing table's exact-file test row, whose `not` column
 *      measures the wrapped path at 14+ min-without-starting against 1471ms via the tool.
 *
 * That advice is load-bearing in an unusual direction. It is the *fix* for
 * EI-20223211961308878, where `npm run test:file` was correctly routed by the exact-file
 * router and then queued because the release gate held the only heavy slot — so targeted
 * verification never started at all. If `testing:run` is ever wrapped back into
 * `pc-heavy.sh`, none of the three sites goes merely stale: each keeps promising a
 * non-queuing path that no longer exists, and sends the next agent to reproduce exactly
 * the bug it was written to retire. That is worse than saying nothing.
 *
 * So pin the property to the code rather than to prose (the derived-truth ladder's PIN rung).
 *
 * SCOPE — deliberately narrow, and the narrowness is the point:
 *
 *   - This judge pins ONLY that the router is launched as a direct `process.execPath`
 *     spawn and that no pc-heavy wrapper appears as a spawn target.
 *   - It deliberately does NOT pin the resource-governor admission that `runTestProcess`
 *     also passes through (`admissionClass: 'process'`). That path admits immediately
 *     today only because the active driver is `AdmitImmediatelyDriver` — documented in
 *     `resource-governor/admission.ts` as "deliberately capless and keeps no queue;
 *     P-003 replaces it with the durable driver". Pinning today's capless behaviour would
 *     fight a planned roadmap change rather than protect a doc claim.
 *   - It must keep ALLOWING the `delete childEnv.PC_HEAVY_*` scrubs in `run.ts`. Those
 *     remove a parent wrapper's one-shot readiness markers so a nested run does not try to
 *     publish into an already-owned barrier (EEXIST). They are the opposite of a wrapper
 *     invocation, so a judge that simply banned the substring `PC_HEAVY` would block the
 *     very fix that makes the direct spawn safe under nesting.
 *
 * This judge is a PURE function over source text so the test can prove it is falsifiable
 * against fixtures before trusting it against the live tree.
 */

/** The wrapper whose reintroduction as a spawn target would void the doc claim. */
export const PC_HEAVY_WRAPPER = 'pc-heavy.sh';

/** The router the tool must reach directly. */
export const TEST_ROUTER = 'test-files.mjs';

export interface FocusedTestAdmissionVerdict {
  ok: boolean;
  problems: string[];
  /** The router is launched with the node binary itself (`process.execPath`). */
  routerLaunchedWithNodeBinary: boolean;
  /** No pc-heavy wrapper appears as a spawn target in executable code. */
  freeOfPcHeavyWrapper: boolean;
}

/**
 * Strip `//` line comments AND block comments.
 *
 * BOTH halves matter here, in opposite directions. `run.ts` carries a long block comment
 * that names "the repository's pc-heavy wrapper" in prose, so a scan that did not strip
 * comments would report a wrapper spawn that does not exist — a detector that cannot pass.
 * Conversely, the JSDoc around the router names `test-files.mjs` repeatedly, so an
 * unstripped scan would keep finding the router long after the actual spawn was rewritten
 * — a detector that cannot fail. Only stripping both makes either verdict mean anything.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function judgeFocusedTestAdmissionPath(args: {
  runSource: string;
}): FocusedTestAdmissionVerdict {
  const problems: string[] = [];
  const code = stripComments(args.runSource);

  // (1) The router must be launched by the node binary directly. The live shape is
  //     `runTestProcess(process.execPath, [join(cwd, 'scripts', 'test-files.mjs')], ...)`.
  //     Requiring the two to be ADJACENT is what makes this specific: a stray
  //     `process.execPath` elsewhere in the file cannot satisfy it, and neither can a
  //     router path handed to some other, wrapped launcher.
  //
  //     The router must sit inside the FIRST `join(...)` of the argv array — i.e. it is
  //     the program node executes, not merely a string somewhere in the arguments. An
  //     earlier draft scanned the whole array (`[^\]]*`) and PASSED the fixture where the
  //     wrapper is the first element and the router is handed to it as an argument
  //     (`[join(cwd,'scripts','pc-heavy.sh'), '--', 'test-files.mjs']`) — precisely the
  //     regression this judge exists to catch. Anchoring inside one `join(` call is what
  //     makes the leg independently load-bearing rather than leaning on check (2).
  const directLaunch = new RegExp(
    `process\\.execPath\\s*,\\s*\\[\\s*join\\([^)]*${TEST_ROUTER.replace('.', '\\.')}`,
  );
  const routerLaunchedWithNodeBinary = directLaunch.test(code);
  if (!routerLaunchedWithNodeBinary) {
    problems.push(
      `testing:run no longer launches ${TEST_ROUTER} directly via process.execPath. ` +
        'The three prose sites (pc-heavy.sh header, affected-plan.ts remediation, CLAUDE.md ' +
        'routing table) promise a focused-test path that takes no admission ticket; if the ' +
        'router is now reached through a wrapper, fix those sites in the same change or ' +
        'restore the direct spawn. See EI-20223211961308878.',
    );
  }

  // (2) No pc-heavy wrapper as a spawn target. Env-var scrubs (`PC_HEAVY_PREEMPT_READY_FILE`,
  //     `PC_HEAVY_PSI_FINALIZATION_FILE`) are deliberately NOT matched — see the scope note.
  const freeOfPcHeavyWrapper = !code.includes(PC_HEAVY_WRAPPER);
  if (!freeOfPcHeavyWrapper) {
    problems.push(
      `${PC_HEAVY_WRAPPER} appears in testing:run's executable code, so the focused-test ` +
        'path now takes the shared heavy-command admission ticket and can queue behind the ' +
        'release gate — the exact failure EI-20223211961308878 records.',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    routerLaunchedWithNodeBinary,
    freeOfPcHeavyWrapper,
  };
}
