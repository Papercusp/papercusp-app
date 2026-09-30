/**
 * Doc claim: the dev bridge's `/eval` contract, as stated to agents in
 * `testing/agent-e2e` §1.7 (EI-15751).
 *
 * §1.7 tells every agent driving the operator headlessly two things it will act on:
 *
 *   1. a single `tauri-agent-tools eval` round-trip dies at FIVE SECONDS, so a long
 *      async operation must be fired-and-forgotten into a page global and polled; and
 *   2. an in-page exception comes back as a normal 200 whose RESULT is the string
 *      `"ERROR: <message>"` — which is why an unguarded `wait --eval` predicate reads
 *      as SATISFIED instead of failing (EI-22415283260541891).
 *
 * Both are properties of OUR Rust bridge, so both are pinnable here. If someone raises
 * the deadline, changes the status code, or gives `/eval` a real error channel, this
 * guard fails and the prose gets corrected instead of silently rotting into a lie that
 * agents keep acting on.
 *
 * DELIBERATELY NOT PINNED: the second 5 s cap, in `tauri-agent-tools`'
 * `BridgeClient.eval(js, timeout = 5000)`. That package is third-party and installed
 * globally on the host (`~/.local/node25/lib/node_modules`), outside the repo and
 * outside CI's dependency graph — a guard on it would make this suite depend on an
 * unmanaged host artifact, and would either red-pin the gate where the package is
 * absent or skip (a false green). §1.7 states that half as a version-stamped
 * observation instead; the rung this file occupies is the half we own.
 */

export interface DocSubject {
  label: string;
  text: string;
}

export interface BridgeEvalContract {
  /** Seconds the `/eval` handler waits before giving up on the webview. */
  deadlineSecs: number | null;
  /** Status codes it answers with on that timeout (expected: every one of them 504). */
  timeoutStatusCodes: number[];
  /** True when an in-page exception is reported as a RESULT VALUE, not an error channel. */
  reportsExceptionsAsValue: boolean;
  problems: string[];
  ok: boolean;
}

/**
 * Read the `/eval` contract out of `dev_bridge.rs`.
 *
 * Regex rather than an import because the subject is Rust: a failed extraction is
 * reported as "the anchor moved", which is itself the thing a reader needs to know —
 * never as a silent `undefined` that would let the claim pass unexamined.
 */
export function judgeBridgeEvalContract(rustSource: string): BridgeEvalContract {
  const problems: string[] = [];

  const deadlineMatch = rustSource.match(
    /let\s+deadline\s*=\s*std::time::Duration::from_secs\((\d+)\)/,
  );
  const deadlineSecs = deadlineMatch ? Number(deadlineMatch[1]) : null;
  if (deadlineSecs === null) {
    problems.push(
      'no `let deadline = std::time::Duration::from_secs(N)` in dev_bridge.rs — the /eval ' +
        'deadline moved or was renamed; re-point this guard at its new home rather than ' +
        'deleting the assertion, and re-check testing/agent-e2e §1.7 against it.',
    );
  }

  const timeoutStatusCodes = [
    ...rustSource.matchAll(
      /Response::from_string\("Eval timeout"\)\s*\.with_status_code\((\d+)\)/g,
    ),
  ].map((m) => Number(m[1]));
  if (timeoutStatusCodes.length === 0) {
    problems.push(
      'no `Response::from_string("Eval timeout").with_status_code(...)` in dev_bridge.rs — ' +
        '§1.7 tells agents to expect `Bridge error (504): Eval timeout` as one of the two ' +
        'faces of this trap.',
    );
  } else if (timeoutStatusCodes.some((code) => code !== 504)) {
    problems.push(
      `/eval answers its timeout with status ${timeoutStatusCodes.join(', ')}; §1.7 states 504.`,
    );
  }

  // The wrapper built by `build_eval_callback_js` catches every in-page exception and
  // hands it back as the RESULT. That single line is what makes a thrown predicate
  // indistinguishable from a value to any caller that does not string-match the prefix.
  const reportsExceptionsAsValue = /value:\s*"ERROR: "\s*\+\s*e\.message/.test(rustSource);
  if (!reportsExceptionsAsValue) {
    problems.push(
      'dev_bridge.rs no longer reports in-page exceptions as a `"ERROR: " + e.message` result ' +
        'value. If /eval grew a real error channel that is GOOD NEWS — but §1.7 and ' +
        'EI-22415283260541891 both describe the old contract and must be rewritten, not just ' +
        'left standing.',
    );
  }

  return {
    deadlineSecs,
    timeoutStatusCodes,
    reportsExceptionsAsValue,
    problems,
    ok: problems.length === 0,
  };
}

export interface ProseVerdict {
  ok: boolean;
  problems: string[];
}

/**
 * Assert the agent-facing prose still agrees with the contract above.
 *
 * The numbers are taken FROM the code and looked for IN the doc — never the reverse —
 * so raising the deadline in Rust fails here until the prose is updated to match.
 */
export function judgeBridgeEvalProse(
  subjects: DocSubject[],
  contract: BridgeEvalContract,
): ProseVerdict {
  const problems: string[] = [];

  for (const subject of subjects) {
    if (subject.text.trim().length === 0) {
      problems.push(`${subject.label}: empty — the guard read nothing, so it proved nothing.`);
      continue;
    }

    if (contract.deadlineSecs !== null) {
      // The doc must state the real number both as prose ("5 s") and as the cited
      // Rust expression, so a reader can find the source of the claim.
      if (!subject.text.includes(`${contract.deadlineSecs} s`)) {
        problems.push(
          `${subject.label}: does not state the real /eval deadline of ${contract.deadlineSecs} s.`,
        );
      }
      if (!subject.text.includes(`Duration::from_secs(${contract.deadlineSecs})`)) {
        problems.push(
          `${subject.label}: does not cite \`Duration::from_secs(${contract.deadlineSecs})\`, so a ` +
            'reader cannot check the claim against the code it came from.',
        );
      }
    }

    if (contract.timeoutStatusCodes.length > 0) {
      const code = contract.timeoutStatusCodes[0];
      if (!subject.text.includes(String(code))) {
        problems.push(`${subject.label}: does not mention the ${code} timeout response.`);
      }
    }

    if (contract.reportsExceptionsAsValue && !subject.text.includes('ERROR: ')) {
      problems.push(
        `${subject.label}: does not describe the \`"ERROR: ..."\` result-as-value contract, which ` +
          'is what makes an unguarded `wait --eval` predicate read as satisfied.',
      );
    }
  }

  return { ok: problems.length === 0, problems };
}
