'use client';

/**
 * GoalPackagesRail — installed/bundled goal packages above the Goals board
 * (work-on-everything-goal-2026-08-23 P-009).
 *
 * One card per package from `goals.list`'s `goalPackages` (the server-side fold
 * in operator-core's goals/package-board.ts): "Work on everything" arrives
 * featured-first from that fold. A package with no live (non-stub) instance
 * offers ONE-CLICK START — POST /api/admin/goals/start-from-package — which
 * adopts the seeded install stub (or mints a fresh instance) and spawns the
 * goal-mode holder in the same act (P-017; D-002: install ≠ start). A package
 * with a live instance renders a READOUT instead: the instance's status, its
 * recent spend, and the package's declared budget; clicking the card opens that
 * goal on the board.
 *
 * ── NO OPTIMISTIC STATE (GoalStatusControl's P-016 property, inherited) ──────
 * The Start button reports in-flight and nothing else. The admin route
 * invalidates `goals.list`/`goals.detail` after a 200, the store re-pulls, and
 * the card flips to its readout because the STORE moved — a failed write
 * therefore cannot leave a lying card behind, because nothing was ever moved
 * locally. A `degraded` success surfaces as a sticky warning toast, exactly as
 * the status control does (EI-19995648221353323's lesson).
 *
 * ── SPEND SEMANTICS (the label trap this file must not fall into) ────────────
 * `spendRecentUsd` is a TRAILING-WINDOW figure labeled by ITS OWN
 * `spendRecentWindowDays`, read off the same payload row; the budget is labeled
 * by the PACKAGE's own declared `budgetWindowSec` (P-004). The two windows may
 * genuinely differ and each figure renders under its own label only. Lifetime
 * spend (`metadata.spentCents`) is deliberately NOT rendered here — never
 * present a lifetime figure under a window label. And an ABSENT spend reading
 * renders NO spend line, never `$0` (hud-entity-board's goalBurn rule).
 *
 * ⚠ Payload shapes are INLINED (endpoint JSON is the contract): importing the
 * server's GoalPackageBoardEntry would drag operator-core server modules (and
 * their node builtins) into the SPA bundle — the recurring ":3055 white-screen"
 * class HudView's RosterPayload docblock names.
 */

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { HudGoalInput } from './hud-entity-board';

/** One `harness_shared.goals` row stamped with this package's ref, as the
 *  resolver's fold reports it. */
export interface GoalPackageRailInstance {
  goalId: string;
  status: string;
  /** The seeded, never-started install stub — Start ADOPTS it, so its presence
   *  still renders the Start card, not a readout. */
  adoptableStub: boolean;
}

/** Inlined mirror of the resolver's GoalPackageBoardEntry (see the docblock). */
export interface GoalPackageRailEntry {
  ref: string;
  title: string;
  description: string;
  layer: 'bundled' | 'user';
  version: string;
  standing: boolean;
  budgetCents: number | null;
  /** The package's DECLARED budget window (P-004) — the budget label's
   *  denominator, never the spend figure's. */
  budgetWindowSec: number | null;
  instances: GoalPackageRailInstance[];
  /** The live instance the readout (and card click) targets; null is exactly
   *  the one-click-start case. */
  activeGoalId: string | null;
  featured: boolean;
}

/** The route reply, verbatim from the tool (admin/goals.ts keeps `degraded` /
 *  `degradedReasons` at the top level on purpose — see that route's docblock). */
interface StartReply {
  data?: { id?: string; warning?: string };
  degraded?: boolean;
  degradedReasons?: string[];
  error?: { code?: string; message?: string };
}

async function postStart(ref: string): Promise<StartReply> {
  const res = await fetch('/api/admin/goals/start-from-package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref }),
  });
  // A refusal still carries our JSON body; read it rather than throwing the
  // reason away (a `no-harness` / `inputs-not-ready` refusal names its fix).
  let body: StartReply;
  try {
    body = (await res.json()) as StartReply;
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

/** 604800 → "7d"; 3600 → "1h"; anything odd stays exact in seconds. */
function windowLabel(sec: number): string {
  if (sec % 86_400 === 0) return `${sec / 86_400}d`;
  if (sec % 3_600 === 0) return `${sec / 3_600}h`;
  return `${sec}s`;
}

function PackageCard({
  entry,
  goal,
  busy,
  starting,
  onStart,
  onOpenGoal,
}: {
  entry: GoalPackageRailEntry;
  /** The payload row behind `activeGoalId`, when the capped goals list carries
   *  it — the spend readout's source. Its absence only mutes the spend line. */
  goal: HudGoalInput | undefined;
  busy: boolean;
  starting: boolean;
  onStart: (ref: string) => void;
  onOpenGoal?: (goalId: string) => void;
}) {
  const chips = (
    <span className="hud__pkgcard-meta">
      <span className="hud__chip">{entry.layer}</span>
      <span className="hud__chip">v{entry.version}</span>
      {entry.standing ? <span className="hud__chip hud__chip--accent">standing</span> : null}
    </span>
  );

  const budget =
    entry.budgetCents != null ? (
      <span className="hud__pkgcard-fig" data-testid={`pkg-budget-${entry.ref}`}>
        {/* Labeled by the PACKAGE's declared window — never the spend row's. */}
        budget ${(entry.budgetCents / 100).toFixed(2)}
        {entry.budgetWindowSec != null ? ` / ${windowLabel(entry.budgetWindowSec)}` : ''}
      </span>
    ) : null;

  if (entry.activeGoalId) {
    const instance = entry.instances.find((i) => i.goalId === entry.activeGoalId);
    const status = instance?.status ?? goal?.status ?? 'active';
    return (
      <button
        type="button"
        className="hud__pkgcard"
        data-testid={`pkg-card-${entry.ref}`}
        data-featured={entry.featured ? 'true' : undefined}
        onClick={() => onOpenGoal?.(entry.activeGoalId as string)}
        aria-label={`Open goal ${entry.activeGoalId} — ${entry.title}`}
      >
        {/* Layout lives on this inner span: the design-primitives lint forbids
            display:flex on a <button> selector in the HUD (see hud.css). */}
        <span className="hud__pkgcard-in">
          <span className="hud__pkgcard-title" title={entry.description || undefined}>
            {entry.title}
          </span>
          {chips}
          <span className="hud__pkgcard-read">
            <span
              className={`hud__chip ${status === 'active' ? 'hud__chip--good' : 'hud__chip--warn'}`}
              data-testid={`pkg-status-${entry.ref}`}
            >
              {status}
            </span>
            {/* Both halves of the reading must be present — a figure without its
                window is exactly the mislabeling this rail must not commit, and
                an absent reading renders NOTHING, never $0. */}
            {goal?.spendRecentUsd != null && goal?.spendRecentWindowDays != null ? (
              <span className="hud__pkgcard-fig" data-testid={`pkg-spend-${entry.ref}`}>
                ${goal.spendRecentUsd.toFixed(2)} last {goal.spendRecentWindowDays}d
              </span>
            ) : null}
            {budget}
          </span>
        </span>
      </button>
    );
  }

  return (
    <article
      className="hud__pkgcard"
      data-testid={`pkg-card-${entry.ref}`}
      data-featured={entry.featured ? 'true' : undefined}
    >
      <span className="hud__pkgcard-in">
        <span className="hud__pkgcard-title" title={entry.description || undefined}>
          {entry.title}
        </span>
        {chips}
        <span className="hud__pkgcard-read">
          <button
          type="button"
          className="pc-ctl-act pc-ctl-act--primary"
          data-testid={`pkg-start-${entry.ref}`}
          disabled={busy}
          aria-label={`Start goal package ${entry.title}`}
          onClick={(e) => {
            // The rail sits inside the board surface; the click must start the
            // goal, not also select/open whatever the parent listens for.
            e.stopPropagation();
            onStart(entry.ref);
          }}
        >
            {starting ? '…' : 'Start'}
          </button>
          {budget}
        </span>
      </span>
    </article>
  );
}

export default function GoalPackagesRail({
  entries,
  goals,
  onOpenGoal,
}: {
  entries: GoalPackageRailEntry[];
  /** The goals rows off the SAME payload — the spend readout correlates
   *  `activeGoalId` against them, reading window + figure together. */
  goals: HudGoalInput[];
  onOpenGoal?: (goalId: string) => void;
}) {
  const [pendingRef, setPendingRef] = useState<string | null>(null);

  const goalsById = useMemo(() => {
    const m = new Map<string, HudGoalInput>();
    for (const g of goals) if (g.id) m.set(g.id, g);
    return m;
  }, [goals]);

  const start = useCallback(
    async (ref: string) => {
      if (pendingRef) return;
      setPendingRef(ref);
      try {
        const reply = await postStart(ref);
        // A degraded write is a SUCCESS that did less than its label implies —
        // it keeps a sticky warning, same seam as GoalStatusControl.
        if (reply.degraded && reply.degradedReasons?.length) {
          toast.warning('Goal started — but not completely', {
            description: reply.degradedReasons.join(' · '),
            duration: Infinity,
          });
        } else {
          toast.success(
            'Goal started',
            reply.data?.warning ? { description: reply.data.warning } : undefined,
          );
        }
        // No local flip: the route's goals.list invalidation repaints the card
        // from the store (see the docblock).
      } catch (e) {
        // Nothing to roll back — no local state was ever moved.
        toast.error('Could not start this goal package', { description: String(e) });
      } finally {
        setPendingRef(null);
      }
    },
    [pendingRef],
  );

  // Older payloads (no goalPackages yet) and empty stores render NO rail at
  // all — the plain board, not an empty strip that reads as a failed load.
  if (entries.length === 0) return null;

  return (
    <section
      className="hud__pkgrail"
      aria-label="Installed goal packages"
      data-testid="goal-packages-rail"
    >
      {entries.map((e) => (
        <PackageCard
          key={e.ref}
          entry={e}
          goal={e.activeGoalId ? goalsById.get(e.activeGoalId) : undefined}
          busy={pendingRef !== null}
          starting={pendingRef === e.ref}
          onStart={(ref) => void start(ref)}
          onOpenGoal={onOpenGoal}
        />
      ))}
    </section>
  );
}
