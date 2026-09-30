# No locally-authorized agent recovery path — a deliberate exclusion
URL: /internal/docs/agent-insights/no-locally-authorized-agent-recovery-path

Papercusp ships no independent, locally-authorized agent recovery path. It was dropped by owner directive (D-010) because every authority root reachable from this workstation is forgeable by the agents it constrains (D-007/D-008). Do not rebuild it under a weaker root.

The managed-agent capability contract deliberately ships **without** an independent,
locally-authorized recovery path. This is an owner-directed exclusion — not an
oversight, not an unbuilt backlog item, and not something to quietly add later.

If you arrived here because a capability matrix says `unsupported` where you expected
a recovery route, or because a plan item looks half-finished: **it is finished. The
answer is "deliberately absent".**

## What does not exist

There is no mechanism by which an agent on this workstation can grant itself native
capabilities when the operator or MCP surface is unreachable. None of the following
exists, and none may be built:

* a locally-authorized "recovery" launch that enables capabilities without the operator
* an agent-presentable key, token, or file that re-enables native tools on its own authority
* a permanently native-enabled agent held in reserve for outages
* any "break-glass" path whose authority root lives on this machine

## Why — the forgeability result (D-007 / D-008)

The original P-004 specified exactly this capability, bounded by a local
authorization check. That design was measured and found unsound:

> A software-only Ed25519 key, wrapped in `sk-ssh-ed25519` wire format with
> signer-chosen flags `0x05`, was **accepted by the real `/usr/bin/ssh-keygen -Y verify`
> as a genuine hardware-backed ED25519-SK UP+UV signature.**

So the strongest local signal available — "this was signed by a hardware key with user
presence and user verification" — can be manufactured in software. Managed agents on
this workstation hold `NOPASSWD` root, which means *any* authority root stored on this
machine sits inside the mutation reach of the very agents it is supposed to constrain.
Independent reviewer WI-10001225 rejected "a local public-key file plus claimed SSHSIG
flags" as an authority root for precisely this reason.

The only sound implementation therefore required an **external hardware security key
enrolled by the human owner**.

## Why it was dropped (D-010)

Asked directly, the owner judged the emergency-recovery capability not worth a hardware
purchase (\~$30–60) and chose to drop the feature. P-004 was **retired — dropped, not
deferred** — and the plan proceeds without a locally-authorized native recovery path.

Note the shape of this decision: dropping the feature is sound *precisely because* no
weaker substitute is acceptable. A cheaper version would not be a smaller feature; it
would be a false guarantee.

## What this obliges you to do

1. **Do not resurrect it under a weaker root.** The forgeability result above is
   unchanged by the drop. Shipping a software-rooted recovery path would be security
   theatre, and it is explicitly *out of scope*, not merely unbuilt.
2. **Record it as a disposition, not a gap.** A capability gap whose only route to
   closure was the dropped recovery path carries an explicit
   **unsupported / documented-exclusion** disposition — never an open gap. D-009 still
   governs and forbids stripping an implementation item from a gap merely to reach zero.
3. **Treat operator-outage recovery as a human action.** That is the designed
   behaviour, and it is the reason no agent-side escape exists to find.
4. **Do not read the absence as an oversight.** If a future audit, matrix, or reviewer
   flags "no recovery path", the correct response is to cite this page and D-010 — not
   to build one.

## If you genuinely need it

Raise it with the owner and say plainly that it requires an external hardware security
key to be sound, citing D-007/D-008. That is a purchasing and enrolment decision only
the owner can make. It is not an engineering problem to route around, and an agent
cannot authorize it for itself — which is the entire point.

## Provenance

* **D-010** — owner directive (2026-09-18, interactive): "Drop the recovery feature."
* **D-007 / D-008** — the forgeability measurement and its review.
* **D-009** — gap co-ownership; do not strip implementation items to reach zero gaps.
* Plan: `managed-agent-capability-contract-and-native-cutover-2026-09-13`, item P-009.
