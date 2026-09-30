/**
 * plan_items:* tool group — plan-item assignment / claim / liveness.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04.
 *
 * Side-effect imports register each tool (defineTool self-registers on import), and
 * we install the swarm-backed claim authority so claim leases ride the per-harness
 * lock authority (Track B) in production (tests of the stores keep the pure local
 * default). We also register the AUTHORITY-side claim op handlers
 * (plan-item.claim.*), so when THIS operator is the elected authority it can execute
 * claim ops routed from remote peers (Phase-4 legs b/c — two-peer contention +
 * failover). Both are idempotent.
 */
import './adopt-name';
import './assign';
import './unassign';
import './my-items';
import './claim';
import './convert';
import './release';
import './heartbeat';
import './status';
import './join-group';
import './leave-group';
// Reflect rules: work_item lifecycle → plan-item status (convert-at-pickup D-015).
// Importing registers them on the event-reaction engine, like lifecycle-rules.
import '../../plan-items/reflect-rules';
// Reconcile rule (EI-5925): the reverse mirror — plan-item → done reconciles
// any OTHER linked work-item still non-terminal. Importing registers it.
import '../../plan-items/reconcile-rule';
// Lane-sync rule (EI-18732669095544832): plans:set-item-blocked-by changing a
// blocked-by edge re-syncs the item's effective lane onto linked work-items
// RIGHT NOW instead of waiting up to 15 min for the periodic sweep. Importing
// registers it.
import '../../plan-items/lane-sync-rule';
// Plan-drain rule (P-004, deterministic-plan-state-derivation-2026-08-31): a
// plans:set-status flip that crosses the terminal boundary re-derives the
// PLAN's lifecycle status, so a plan whose last live item just went terminal
// stops advertising work that no longer exists. Importing registers it.
import '../../plan-items/plan-drain-rule';
import { installSwarmClaimAuthority } from '../../plan-items/claim-authority-swarm';
import { registerPlanItemClaimAuthorityOps } from '../../plan-items/plan-item-claim-authority-ops';

installSwarmClaimAuthority();
registerPlanItemClaimAuthorityOps();
