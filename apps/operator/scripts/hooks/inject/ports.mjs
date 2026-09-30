/**
 * INJECTION PORT REGISTRY — the context-injection boundaries, and the
 * transport contract each one carries.
 *
 * Plan: codex-context-injection-parity-2026-08-09, D-001 (FROZEN, shared
 * verbatim with omp-context-injection-parity-2026-08-09).
 *
 * The three identity hook ports (pre-tool, stop, compaction) were added by
 * portable-identity-packages-2026-09-26 P-011 (D-023 §2). They carry a worn
 * identity's synchronous rules and nothing else; turn start and post-tool
 * rules ride the two original ports.
 *
 * A "port" is a MOMENT in a turn at which the operator is allowed to push
 * context into the model, not a client event. Client events map ONTO ports
 * (that mapping is each adapter's `portForEvent`); the properties here are the
 * same for every client, which is exactly why they live in one file instead of
 * being re-derived per adapter.
 *
 * ⚠ EVERY NUMBER HERE IS CONTRACT, NOT TUNING (D-001 invariants 2 + 5).
 * The clamps bound the SERVER's query construction, so changing one changes
 * retrieval behaviour for every client at once. The timeouts bound what a slow
 * or down operator is allowed to cost a turn. Both were migrated verbatim from
 * the two claude shell hooks these ports generalise. Do not "round them off".
 */

/**
 * @typedef {'turn-start' | 'mid-turn' | 'pre-tool' | 'stop' | 'compaction'} InjectionPort
 */

/**
 * ⚠ THE TWO KILL-SWITCHES ARE NOT THE SAME KIND OF SWITCH — do not unify them.
 *
 * This asymmetry is the single most likely thing to be "cleaned up" by someone
 * reading only D-001's one-line summary ("PER-PORT KILL-SWITCH env:
 * PAPERCUSP_TURN_START_MEMORY=off, PAPERCUSP_MID_TURN_CONTEXT=off"), which
 * reads as though both simply disable their port. They do not, and flattening
 * them would silently delete a safety property:
 *
 *   PAPERCUSP_MID_TURN_CONTEXT=off  -> 'suppress'. The whole port goes away.
 *       Mid-turn carries recall only. Nothing is lost by not calling.
 *
 *   PAPERCUSP_TURN_START_MEMORY=off -> 'degrade'. The call STILL HAPPENS, with
 *       memoryEnabled=false. Turn-start carries TWO payloads on one request:
 *       the memory delta AND the one-shot CTRL transition (mode / loop / route
 *       changes). The env var is a MEMORY preference. A memory preference must
 *       never be able to hide a safety-critical control transition, so turning
 *       memory off must not stop the request.
 *
 * Verbatim source: apps/operator/scripts/hooks/cc/userpromptsubmit-memory.sh
 * ("PAPERCUSP_TURN_START_MEMORY=off disables only memory recall. CTRL
 * transitions remain enabled: a memory preference must never hide a
 * safety-critical mode / loop / route transition.") vs
 * posttoolbatch-midturn-context.sh (bare `exit 0` on off).
 *
 * @typedef {'suppress' | 'degrade'} KillSwitchMode
 */

/**
 * @typedef {object} PortSpec
 * @property {string} endpoint            Operator path. CLIENT-AGNOSTIC by design (D-001 invariant 6) — never fork this per client.
 * @property {number} timeoutMs           Hard wall. After this the turn proceeds un-augmented.
 * @property {string} killSwitchEnv       Env var that disables/degrades this port.
 * @property {KillSwitchMode} killSwitchMode  See the warning above.
 * @property {number} [promptClamp]       turn-start: max chars of prompt shipped.
 * @property {number} [maxCalls]          mid-turn: max tool calls shipped.
 * @property {number} [fieldClamp]        mid-turn: max chars per call field.
 * @property {number} [guardInputMaxBytes] pre-tool: tool input shipped whole up to this, else not at all.
 */

/** @type {Record<InjectionPort, PortSpec>} */
export const PORTS = {
  'turn-start': {
    endpoint: '/api/agent-mcp/turn-start-memory',
    timeoutMs: 2500,
    killSwitchEnv: 'PAPERCUSP_TURN_START_MEMORY',
    killSwitchMode: 'degrade',
    promptClamp: 4000,
  },
  'mid-turn': {
    endpoint: '/api/agent-mcp/mid-turn-context',
    timeoutMs: 1500,
    killSwitchEnv: 'PAPERCUSP_MID_TURN_CONTEXT',
    killSwitchMode: 'suppress',
    maxCalls: 12,
    fieldClamp: 400,
  },
  // ⚠ pre-tool is a GUARD port, not a context port. Its response text is a
  // refusal reason: non-empty means deny this one call, empty means no verdict.
  // Adapters render it ONLY as a deny — never allow, never updatedInput, never
  // additionalContext — so a context hook can still never vote (D-027). A slow
  // or down operator costs no verdict, and the client's own permission flow
  // decides; evaluation failures fail closed server-side, where a rule is named.
  'pre-tool': {
    endpoint: '/api/agent-mcp/tool-guard',
    timeoutMs: 1500,
    killSwitchEnv: 'PAPERCUSP_IDENTITY_HOOKS',
    killSwitchMode: 'suppress',
    // Must equal SYNC_HOOK_GUARD_INPUT_MAX_BYTES (sync-hook-rules.ts). Never a
    // lossy prefix: a cut input could hide exactly the tail a deny would match.
    guardInputMaxBytes: 64 * 1024,
  },
  stop: {
    endpoint: '/api/agent-mcp/stop-context',
    timeoutMs: 2500,
    killSwitchEnv: 'PAPERCUSP_IDENTITY_HOOKS',
    killSwitchMode: 'suppress',
  },
  compaction: {
    endpoint: '/api/agent-mcp/compaction-context',
    timeoutMs: 2500,
    killSwitchEnv: 'PAPERCUSP_IDENTITY_HOOKS',
    killSwitchMode: 'suppress',
  },
};

/** @type {InjectionPort[]} */
export const PORT_NAMES = /** @type {InjectionPort[]} */ (Object.keys(PORTS));

/** @param {unknown} value @returns {value is InjectionPort} */
export function isPort(value) {
  return typeof value === 'string' && Object.hasOwn(PORTS, value);
}

/**
 * Resolve a port's spec. Returns null for an unknown port rather than throwing:
 * every caller here is on a fail-silent path (D-001 invariant 1), and a thrown
 * error at this layer would have to be caught one frame later anyway.
 * @param {unknown} port
 * @returns {PortSpec | null}
 */
export function specFor(port) {
  return isPort(port) ? PORTS[port] : null;
}

/* ------------------------------------------------------------------ */
/* DELIVERY SEAMS — how a payload reaches the model, and whether that   */
/* act can destroy work in flight.                                      */
/* Plan: omp-context-injection-and-behavior-2026-08-12, P-002 + P-012.  */
/* ------------------------------------------------------------------ */

/**
 * WHY THIS EXISTS. Every adapter in this directory decides WHAT to say. None of
 * them used to declare HOW it gets said — that lived only in each client-native
 * artifact, in prose, in three different files. So when OMP's artifact delivered
 * through a channel that PRE-EMPTS the agent loop, nothing compared it to the
 * other two and nothing failed.
 *
 * The cost, measured over one Gemini session (2026-08-11): 13 tool calls were
 * DISCARDED mid-flight and replaced with a synthesised "Skipped due to pending
 * system advisory" result. 13 of 13 immediately followed one of our injections;
 * no cancellation had any other cause. The model then explained the loss to
 * itself and got it wrong — it concluded its whole tool-calling convention was
 * rejected and switched conventions for the remaining ~220 calls.
 *
 * That is the property this registry names: an injection may only ever ADD to
 * something the client is already assembling. It may never enqueue an event the
 * agent loop has to drain, because draining is what cancels pending work.
 *
 * @typedef {'hook-return-value' | 'tool-result-merge' | 'queued-message' | 'steer-interrupt'} DeliveryMechanism
 */

/**
 * The known delivery mechanisms and whether each can pre-empt in-flight work.
 *
 * The pre-empting entries are deliberately KEPT rather than deleted. A new
 * adapter author reaches for exactly these, and a named mechanism carrying its
 * own measured verdict is a better guardrail than an absence they would have to
 * infer. `validateDeliverySeam` refuses them; this table explains why.
 *
 * @type {Record<DeliveryMechanism, { canPreempt: boolean, why: string }>}
 */
export const DELIVERY_MECHANISMS = {
  'hook-return-value': {
    canPreempt: false,
    why:
      'The payload is the hook process\'s own RETURN VALUE, which the client merges into ' +
      'content it is already assembling. There is no queue and no event, so there is ' +
      'nothing for an agent loop to drain and nothing it can cancel.',
  },
  'tool-result-merge': {
    canPreempt: false,
    why:
      'The payload is returned FROM a tool-result handler and merged into that tool ' +
      'result. The call it rides on has already completed, so appending to it cannot ' +
      'displace work — the same additive property as a hook return value, reached ' +
      'through an in-process module seam instead of stdout.',
  },
  'queued-message': {
    canPreempt: true,
    why:
      'REFUSED. Enqueuing a message makes the agent loop drain the queue, and draining ' +
      'DISCARDS the tool calls it was about to run, handing the model a synthesised ' +
      '"skipped" result. Measured 13/13 cancellations in one session. Note that a ' +
      'deferred variant ("deliver on the next turn") is not a repair: it lands in a ' +
      'buffer whose only drain is a later turn-triggering delivery, which trades a ' +
      'loud, countable tax for a silent hole.',
  },
  'steer-interrupt': {
    canPreempt: true,
    why:
      'REFUSED. Interrupting is the entire point of a steer. It is a legitimate ' +
      'mechanism for an operator deliberately redirecting an agent, and never a ' +
      'legitimate one for delivering context the agent did not ask for.',
  },
};

/**
 * A seam declaration, exported by each adapter as `deliverySeam`.
 *
 * `artifact` names the client-native file that actually performs the delivery —
 * the adapters themselves are pure, so the seam is implemented one layer out.
 * Requiring the path keeps the declaration falsifiable: a reviewer can open the
 * named file and check it, rather than trusting an adjective.
 *
 * @typedef {object} DeliverySeam
 * @property {DeliveryMechanism} mechanism
 * @property {string} artifact   repo-relative path to the file that delivers.
 * @property {string} evidence   what was READ or MEASURED to classify it.
 */

/**
 * Validate one adapter's seam declaration.
 *
 * Returns a result rather than throwing: the caller is a test that wants to
 * report every offending client at once, not stop at the first.
 *
 * @param {unknown} seam
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDeliverySeam(seam) {
  const errors = [];
  if (!seam || typeof seam !== 'object') {
    return { ok: false, errors: ['no deliverySeam declared'] };
  }
  const { mechanism, artifact, evidence } = /** @type {any} */ (seam);
  const spec = typeof mechanism === 'string' ? DELIVERY_MECHANISMS[mechanism] : undefined;
  if (!spec) {
    errors.push(
      `unknown delivery mechanism ${JSON.stringify(mechanism)} — add it to ` +
        'DELIVERY_MECHANISMS with a measured verdict before using it',
    );
  } else if (spec.canPreempt) {
    errors.push(`mechanism '${mechanism}' can pre-empt in-flight work: ${spec.why}`);
  }
  if (typeof artifact !== 'string' || !artifact) {
    errors.push('artifact must name the client-native file that delivers the payload');
  }
  if (typeof evidence !== 'string' || !evidence) {
    errors.push('evidence must say what was read or measured to classify the seam');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Is this port switched off, and how?
 *
 * Returns the MODE rather than a boolean so callers cannot collapse 'degrade'
 * into 'suppress' by accident — a boolean here is what would silently drop CTRL
 * transitions when a user turns memory off.
 *
 * @param {InjectionPort} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ off: boolean, mode: KillSwitchMode | null }}
 */
export function killSwitchState(port, env = process.env) {
  const spec = specFor(port);
  if (!spec) return { off: false, mode: null };
  const off = env[spec.killSwitchEnv] === 'off';
  return { off, mode: off ? spec.killSwitchMode : null };
}
