# @papercusp/control-mutation

The **D-005 control-mutation harness** — the cross-cutting wrapper every mutating
control tool composes so that unsupervised self-correction is safe. Four guarantees
on every mutation:

1. **dryRun preview** — what WOULD change, without applying.
2. **post-apply verify** — auto-revert on failure when `verifyMustPass`.
3. **audit record** — who / what / prev / next, via an **injected** `writeAudit` port.
4. **one-call revert** — re-apply the captured prior value.

```ts
import { runControlMutation } from '@papercusp/control-mutation';

const outcome = await runControlMutation(
  {
    action: 'gateway:set-aimd',
    subject: 'pool',
    capturePrev: () => readCurrentAimd(),
    apply: () => writeAndReloadAimd(next),
    revertTo: (prev) => writeAndReloadAimd(prev),
    verify: (applied) => ({ ok: poolReflects(applied) }),
    describe: (prev) => ({ from: prev, to: next }),
  },
  { dryRun: false },
  { writeAudit: (rec) => insertAuditRow(rec) }, // inject your audit surface
);
// outcome.revert?.() → one-call undo
```

## Design

Pure logic + an **injected** audit-write port — the harness knows nothing about
accounts, money, DBs, or transports. The consumer supplies the `capturePrev` /
`apply` / `revertTo` / `verify` / `describe` callbacks and the `writeAudit` port. So a
papercusp gateway-control tool wires `writeAudit` to its `audit_log` DB write; an
oddsmith treasury control wires it to its own audit surface — same orchestration,
zero coupling. With no `writeAudit` wired it records a local id (a paper/test rig).

Extracted from papercusp's `gateway-control/control-harness.ts` so both papercusp
and oddsmith consume ONE implementation. Host-seam pattern; fully unit-testable
(`src/index.test.ts`).
