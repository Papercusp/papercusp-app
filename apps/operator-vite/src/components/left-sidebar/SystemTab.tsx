/**
 * SystemTab — everything that runs on a schedule and does NOT run a model.
 *
 * WHY IT EXISTS (owner, 2026-07-26): "its an 'agents' tab, only the actual llm runs
 * should show there, other things that run in a schedule lets make a new tab for all
 * the routines that are deterministic." The Agents tab was carrying 85 deterministic
 * rows — git commits, garbage collection, canary probes, outbox drains, release
 * gating — at equal weight to the ~55 that spend the owner's weekly Claude limit.
 *
 * WHAT IS IN HERE: git & release (git-sync ×19, green-checkpoint ×14, pr-poll,
 * release-trigger, cargo-test), cleanup (GC, reapers, retention, knowledge-pack
 * maintenance), health (claim/coord invariant sweeps, canaries, p2p benches) and
 * federation (cross-hive outbox drains, foreign-harness supervision). None of them
 * can bill a model — that is not a curated claim but a derived one: a row lands here
 * iff `spend === 'none'`, computed from its `target_role`.
 *
 * WHY IT DEFAULTS TO ALMOST NOTHING: the Running bucket is FOLDED here (see
 * `bucketRows` in AutomationPane) so ~30 healthy sweeps read as one line —
 * "✓ 31 running · last 2m ago" — and a row promotes itself into Needs-you the moment
 * it stalls. Giving the plumbing its own tab is not about giving it a room; it is
 * about giving it a room the owner never has to enter.
 *
 * There is deliberately NO "Pause all" here. It is a money control, and nothing in
 * this pane costs money — a bulk stop of git-sync and the release gate is not an
 * affordance worth one click. Per-row pause still works.
 *
 * TWO THINGS HERE ARE NOT SCHEDULES: `PotFederationStatus` and `PotPeerRoster`.
 * Both were re-homed into this tab by P-077 (retire-mug-kettle-su-only-2026-08-09)
 * when the Pots tab that hosted them was removed. Neither is retired tier code —
 * they read the SHARED POT SUBSTRATE, which D-003 says SURVIVES the mug/kettle
 * retirement, and P-074 left them with no surface at all (D-069 §2 recorded that
 * loss for the first; the second turned out to be the app's only reader of
 * `shared_presence`, so it would have gone the same way).
 *
 * This tab is their home because p2p reach, peer presence and substrate health are
 * WORKSPACE-scoped infrastructure status — the same class as the federation drains
 * already listed below them — whereas the HUD, the alternative D-069 floated, is
 * pot/goal-scoped and would have handed them a scope selector they do not want.
 * They sit in the pane's `children` slot, directly under the blurb, so ~85 folded
 * schedule rows cannot push them below the fold.
 */
import { Cog } from 'lucide-react';
import AutomationPane from './AutomationPane';
import PotFederationStatus from './PotFederationStatus';
import PotPeerRoster from './PotPeerRoster';

export default function SystemTab({ active }: { active: boolean }) {
  return (
    <AutomationPane
      active={active}
      lens="system"
      title="System"
      subtitle="Runs without a model"
      icon={Cog}
      blurb="Deterministic scheduled work — git sync, the release gate, garbage collection, health probes and federation drains. None of it spends money. Healthy rows stay folded; anything stalled or unregistered surfaces at the top."
    >
      {/* Both collapsible, like every other rail section: closed by default, but
          each header still carries its own worst-first signal, so a closed
          section never hides a stalled drain, a stranded publish, or a peer that
          has gone quiet. */}
      <PotFederationStatus collapsible />
      <PotPeerRoster />
    </AutomationPane>
  );
}
