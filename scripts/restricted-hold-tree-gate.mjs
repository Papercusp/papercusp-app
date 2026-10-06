#!/usr/bin/env node
// Restricted-write gate for the SHELL doors that boot the app from the live shared tree
// (WI-10005763 — residue of WI-10005745, plan personal-data-reader-set-labels-2026-10-01, D-012).
//
// papercusp-desktop/bin/tauri-guarded (`dev`, the chokepoint every `npm run dev` / `dev:hmr` /
// verifier launch passes) and scripts/verify-tauri-headless.sh call this before they boot
// anything. A session holding an active personal disclosure has no network, but code it wrote
// into the tree would run WITH the network here (cargo build.rs, the operator sidecar, the host
// bundle), so any held restricted write under a root refuses. The census is the operator-core
// one (restricted-hold-preflight-cli.ts --tree), reached through the shared wrapper, which
// fails closed on a crash, a timeout, or a missing verdict.
//
// Usage: node scripts/restricted-hold-tree-gate.mjs --door <name> <checkout-root> [<root> ...]
// Exit:  0 admit or skipped (the skip reason is printed) · 3 refuse · 2 misuse.
import {
  RESTRICTED_HOLD_PREFLIGHT_EXIT,
  formatTreeRestrictedHoldRefusal,
  runTreeRestrictedHoldPreflight,
} from './lib/restricted-hold-preflight.mjs';

const args = process.argv.slice(2);
let door = 'shell';
if (args[0] === '--door') {
  door = args[1] ?? '';
  args.splice(0, 2);
}
if (!door || args.length === 0) {
  console.error('usage: node scripts/restricted-hold-tree-gate.mjs --door <name> <checkout-root> [<root> ...]');
  process.exit(RESTRICTED_HOLD_PREFLIGHT_EXIT.misuse);
}

const verdict = runTreeRestrictedHoldPreflight({ roots: args });
if (verdict.verdict === 'refuse') {
  console.error(formatTreeRestrictedHoldRefusal(door, verdict));
  process.exit(RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse);
}
if (verdict.verdict === 'skipped') console.error(`RESTRICTED_HOLD_SKIPPED door=${door} reason=${verdict.reason}`);
process.exit(RESTRICTED_HOLD_PREFLIGHT_EXIT.admit);
