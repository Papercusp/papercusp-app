/**
 * Dispatch-scoped answer to "does the CURRENT dispatch peel Papercusp's ambient
 * dispatch-level args?" (EI-22295290349236847).
 *
 * `ambient-args-wiring.ts` registers the keys this host's transport strips before a
 * tool's own schema validates the call. That registration is a PROCESS-WIDE constant,
 * but the question `unknownArgHint` asks is PER-DISPATCH — and the two answers differ:
 * `projection`/`view` are peeled only in `_mcp-handler.ts` (the MCP transport), so on a
 * dispatch running BENEATH that transport — tooldef's own `runToolOrchestration`, which
 * is what a `code:run` or `recipes:run` script calls — neither key is peeled and both
 * are rejected by the target schema like any other unknown arg.
 *
 * EI-22283734191872163 removed the SELF-CONTRADICTING half of that gap: `unknownArgHint`
 * subtracts any ambient key that arrived as an UNRECOGNIZED key on the call being
 * reported, because the rejection is itself per-dispatch evidence the key was not peeled.
 * That leaves the residue this module closes — when the caller fumbles some OTHER arg,
 * the call carries no evidence about `projection`/`view` at all, so the subtraction has
 * nothing to work with and the hint still advertises both as "also accepted".
 *
 * The seam needs no change to carry this: tooldef's resolver contract already says
 * "return the LITERAL keys the transport strips before dispatch", and inside an
 * orchestration dispatch the transport strips NONE. So `[]` is the correct answer under
 * the EXISTING contract — the host's implementation of it was simply over-broad. The
 * library keeps the seam, the host keeps the policy, and `libs/generic/tooldef` gains no
 * mechanism and learns no key names.
 *
 * WHY A DEDICATED ALS rather than reusing one of the four already here: the store must
 * mean exactly one thing. `agent-mcp`'s `validation-context` is the near-miss — it looks
 * like the right context and is not, because `runWithValidationWorkspace` SKIPS entering
 * the store for an absent or `'*'` workspace. "Is there a store?" there answers "did this
 * dispatch carry a concrete workspace?", which is a different question that merely
 * correlates. Reusing it would reproduce the exact defect this fixes: a surface accurate
 * about what it directly describes, wired to a consumer asking something subtly different.
 * `workspace-als` fails the same way through `runWithWorkspaceIfConcrete`.
 *
 * A plain module-scoped boolean is NOT an option: orchestrations and transport calls run
 * concurrently and interleave across `await`s, so a flag would leak one dispatch's answer
 * into another. That is the same reason the sibling contexts here are AsyncLocalStorage.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

// Guarded construction + safe client-side degradation, matching the `workspace-als.ts`
// precedent: this module is server-only by intent, but a bare `new AsyncLocalStorage()`
// at module load throws in a browser bundle. Under Node the behavior is unchanged.
const nonPeelingDispatch =
  typeof AsyncLocalStorage === 'function' ? new AsyncLocalStorage<true>() : undefined;

/**
 * True unless we are inside a dispatch known NOT to peel ambient args.
 *
 * Defaults to TRUE so every path that has not opted out keeps the behavior
 * EI-22174225494240206 established (the transport path, which is the common case, and
 * where naming the dispatch-level args is what stops the message telling a caller to
 * re-send without a capability that actually works).
 */
export function dispatchPeelsAmbientArgs(): boolean {
  return nonPeelingDispatch?.getStore() !== true;
}

/**
 * Run `fn` marked as a dispatch that peels NO ambient dispatch-level args.
 *
 * Entered by `bindCurrentCallerDispatch` — the one wrapper every nested orchestration
 * call is contractually required to pass through — around the whole dispatch, so the
 * target tool's argument validation (and therefore `unknownArgHint`) runs inside it.
 */
export function runWithoutAmbientArgPeeling<T>(fn: () => T): T {
  return nonPeelingDispatch ? nonPeelingDispatch.run(true, fn) : fn();
}
