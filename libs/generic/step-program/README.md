# @papercusp/step-program

A generic, pure **declarative step-program interpreter + runner**. Zero I/O, zero
domain coupling — the consumer injects the ops.

A *program* is an ordered list of **steps** followed by a conditional **gate**:

- A **step** invokes a named `op` with `{{ path }}`-interpolated `args`, an
  optional `when` guard (a boolean condition over the bound scope), and an
  optional `bind` (the scope key the op's result is stored under).
- The **gate** is the decision after the steps run: the first branch whose `when`
  is true (or the `else`/no-`when` fallback) fires its `op`.

```ts
import { runProgram, type Program, type RunOp } from '@papercusp/step-program';

const program: Program = {
  steps: [
    { id: 'open',    op: 'open-thread', args: {}, bind: 'thread' },
    { id: 'collect', op: 'collect', args: { conversation_id: '{{ thread.conversation_id }}' }, bind: 'collected' },
  ],
  gate: [
    { when: 'collected.posts >= payload.quorum', op: 'resolve', args: { decision: '{{ collected.winner }}' } },
    { else: true, op: 'escalate', args: {} },
  ],
};

// The injected seam: resolve `call.op` against YOUR registry and run it.
const runOp: RunOp<MyCtx> = async (call, ctx) => myRegistry.get(call.op).run(call.args, ctx);

const outcome = await runProgram({
  program,
  scope: { payload: { quorum: 2 } },   // you build the initial scope
  ctx,
  runOp,                                // ← the op registry / durability boundary
  maxDepth: 2,                          // recursion guard (optional)
});
// → { outcome: 'resolve' | 'escalate' | 'recursion-exceeded' | 'no-gate-match', resolved, decision, scope }
```

## The seam

`runOp` is the only thing you must inject. It is the **op registry** *and* the
**durability boundary**:

- An **inline** runner (nested programs / tests) resolves the op and runs it
  directly.
- A **durable** runner wraps each op in a checkpointed step (e.g. a workflow
  step), so a top-level program survives a restart and resumes from the last
  completed step. The runner threads an opaque `ctx` to every `runOp` call; the
  runner never reads it, the ops do.

`runProgram` is generic over `Ctx`, so a host's rich step/gate objects (carrying
more fields than `Step`/`GateBranch`) are assignable and run unchanged.

## Modules

| Module | Exports | What |
|---|---|---|
| `expr` | `evalExpr`, `parseExpr`, `isValidExpr`, `readPath`, `truthy` | A safe, **no-`eval`** boolean/comparison expression evaluator over a scope (paths, literals, the six comparisons, `AND`/`OR`/`NOT`, parens). |
| `interpolate` | `interpolate`, `interpolateArgs` | Type-preserving `{{ path }}` substitution (a whole-string placeholder keeps the raw value's type). |
| `interpreter` | `planStep`, `selectGateBranch`, `isProgramSpine` | The pure "what op to run" decisions. |
| `runner` | `runProgram` | Walk steps → injected `runOp` → bind → gate. |
| `aggregate` | `aggregateVotes`, `parsePost` | A structured-fenced-block poll reducer (confidence-weighted votes + an advocate veto) — a ready-made reducer op for a vote/deliberate program. |

## Dependencies

None at runtime (vitest for tests only). Borrowable standalone.
