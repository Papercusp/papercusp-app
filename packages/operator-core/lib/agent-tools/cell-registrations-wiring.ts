/**
 * cell-registrations-wiring.ts — register the built-in cells into the live
 * registry at tool-registration time (unified-agent-state-plane-2026-07-27).
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 *
 * `cell-registrations.ts` declares five cells and exports `registerBuiltinCells()`
 * to install them. Until this file, that function's ONLY callers were tests.
 *
 * So in every running operator the cell registry was EMPTY, and nothing said so:
 *
 *   • `state:read { }` returned an empty directory — a well-formed, cheerful
 *     `{ ok: true, cells: [], count: 0 }` that reads as "no cells exist"
 *     rather than "the registry was never populated".
 *   • `state:read { cell: 'deploy.3070.sha' }` returned `absent`, which P-019
 *     makes DELIBERATELY indistinguishable from "you may not see it" — so the
 *     one surface that could have exposed the emptiness is the one designed
 *     not to.
 *
 * That is the D-010 failure mode stated in `cell-registry.ts`'s own header,
 * arrived at from the other side: not "nobody registers into it", but "the
 * registrations exist and are never installed". Found by P-008 (b)'s live
 * verification, where every declared fact dependency came back `absent` —
 * including a workspace-visible cell no audience check could have refused.
 *
 * ── WHY A SIDE-EFFECT IMPORT, AND WHY HERE ───────────────────────────────────
 *
 * Same convention as `pre-prompt-registry-config` / `delta-flag-wiring` /
 * `context-gauge-wiring` above it in `agent-tools/index.ts`: importing that
 * index once at startup is what installs the operator's tool surface, and the
 * cell registry is part of that surface (`state:read` serves it, and the
 * standing-facts fold now re-reads through it). Registering here means the
 * registry is populated exactly when the tools that read it become available —
 * there is no window where a tool is dispatchable and its registry is not.
 *
 * `registerBuiltinCells()` is idempotent (re-registering an identical resolver
 * is a no-op), so a second import cannot double-register or throw.
 */
import { registerBuiltinCells } from '../cell-registrations';

registerBuiltinCells();
