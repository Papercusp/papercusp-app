import { useCallback, useEffect, useState } from 'react';
import { Square, Play } from 'lucide-react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { FLAGS } from '@papercusp/flags';
import { useLexicon } from '@/lib/useLexicon';
import { Tooltip } from '@/app/harness/Tooltip';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { runHiveControl } from './pot-control';
// This bar's OWN styles (.pc-advshell__harness-bar / __idle and the
// --start/--stop/--waiting button variants). They used to live in AdvShell's
// inline <style>, which only worked while this rendered inside AdvShell's header;
// it renders inside AdvPotBar now (owner ask 2026-07-27), so it carries its own
// stylesheet like the sibling pills do (quick-panel-status-pills D-001).
import './adv-header-pills.css';

interface Props {
  slug: string | null;
}

/** One row of the `hive.controlState` sync query (per registered hive). */
interface HiveControlRow {
  slug: string;
  started: boolean;
}

/**
 * Harness status bar above the tab strip — now purely the hive Start/Stop
 * control.
 *
 * The "N plans waiting" nudge USED to live here; it was removed 2026-08-10 by
 * owner directive ([owner 2026-08-10] "remove the 'plans waiting' button and
 * 'pots running' button", plan retire-mug-kettle-su-only-2026-08-09 P-075). It
 * was a pot-tier affordance: it only ever rendered while the pot was STOPPED,
 * and its whole proposition was "started plans are waiting for a running pot to
 * pick them up" — which is the retired autonomous tier (D-010). Its
 * server-side `plans.waitingCount` aggregate was retired in the same change
 * rather than left as a live query feeding nothing; if a waiting-plans surface
 * is ever wanted again it should be re-derived for the su/GOAL model, not
 * restored from here.
 *
 * The per-agent run pills + the "Active — N agents running" label USED to live
 * here; they were removed once the unified, workspace-wide agent roster shipped
 * (AgentsRunningPill in the header) — that is now the single place agents are
 * listed, so per-Pot pills here were redundant.
 *
 * The Start/Stop button IS the hive control (replaced the retired global-header
 * HiveStartPauseButton): Start boots the brain (`pot:start`); Stop pauses it
 * (`pot:pause { drainCups:true }`). "Active" = the persisted per-hive
 * `started` bit (live via the hive.controlState invalidation) or a just-clicked
 * Start. Hidden when no hive is registered.
 *
 * START IS FLAG-GATED, STOP IS NOT — AND THE ASYMMETRY IS DELIBERATE
 * (retire-mug-kettle-su-only-2026-08-09 P-043, D-010 + D-017):
 *   - D-010 [owner 2026-08-09] retires "the gui buttons driving that
 *     functionality", so while the tier is retired there is no Start affordance.
 *     `pot:start` already refuses server-side via the _mug-kettle-gate; showing a
 *     button whose only possible outcome is a toasted refusal is a worse answer
 *     than not showing it.
 *   - D-017 keeps the STOPPERS reachable: "refusing a stop is never the safe
 *     direction". A pot left started when the flag flips ON -> OFF must still be
 *     stoppable, so Stop renders on `effectivelyAlive` REGARDLESS of the flag.
 * POLARITY IS INVERTED (D-016): flag OFF is the delivered, retired state; ON is
 * the reversible testing escape hatch that restores the Start button.
 */
export default function AdvNowRunning({ slug }: Props) {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  // P-068/D-098: the tier flag is DELETED and the retirement is permanent, so
  // there is no longer a read here — Start is gone unconditionally, Stop stays.
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [starting, setStarting] = useState(false);
  // Optimistic post-launch state: the started bit arrives a beat after
  // pot:start (via the hive.controlState invalidation); a 20s safety net clears
  // this flag if it doesn't.
  const [awaitingAgent, setAwaitingAgent] = useState(false);

  // The registered hive. The hive control tools key on the HIVE's home slug, not
  // the selected harness; `started` is the bar's active/paused state, live via
  // the pot:start / pot:pause invalidation.
  const { data: hiveData } = useSyncQuery({ queryName: 'hive.controlState', args: {} });
  const hive = (hiveData as HiveControlRow[] | undefined)?.[0];
  const started = hive?.started === true;

  // Active = the persisted per-hive started bit, or a just-clicked Start. Per-
  // agent liveness now lives in the unified header roster, not here.
  const effectivelyAlive = started || awaitingAgent;

  // Safety net: clear the optimistic "just started" flag after 20s (by then the
  // real started bit has arrived via the hive.controlState invalidation, or the
  // hive genuinely had nothing to start).
  useEffect(() => {
    if (!awaitingAgent) return;
    const id = window.setTimeout(() => setAwaitingAgent(false), 20_000);
    return () => window.clearTimeout(id);
  }, [awaitingAgent]);

  // START = boot the brain: pot:start persists the started bit, re-affirms the
  // Queen's event-wake subscriptions, flips wake-mode to auto, and wakes her now.
  const startHive = useCallback(async () => {
    if (!hive || starting) return;
    setStarting(true);
    try {
      await runHiveControl('pot:start', hive.slug);
      toast.success(`${t('pot')} started`, { description: `${t('brain')} woken — autonomous wakes enabled` });
      setAwaitingAgent(true);
    } catch (e) {
      toast.error('Start failed', { description: String(e) });
    }
    setStarting(false);
  }, [hive, starting]);

  // STOP = pause the brain: wake-mode manual stages every autonomous wake, the
  // Queen's time wake is cleared, and live bees get the graceful drain cue.
  const stopHive = useCallback(async () => {
    if (!hive) return;
    const ok = await askConfirm({
      title: `Pause ${t('pot', { lower: true })} (${hive.slug})?`,
      body: `Live ${t('contributor', { plural: true, lower: true })} are asked to wrap up; no new wakes fire until Start.`,
      confirmLabel: `Pause ${t('pot', { lower: true })}`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await runHiveControl('pot:pause', hive.slug, { drainCups: true });
      toast.success(`${t('pot')} paused`, { description: `Autonomous wakes staged; ${t('contributor', { plural: true, lower: true })} draining` });
      setAwaitingAgent(false);
    } catch (e) {
      toast.error('Pause failed', { description: String(e) });
    }
  }, [askConfirm, hive]);

  if (!slug) return null;

  const isLoading = hiveData === undefined && !awaitingAgent;
  const stateClass = isLoading ? 'is-checking' : effectivelyAlive ? 'is-active' : 'is-stopped';

  return (
    <>
    {confirmEl}
    <div className={`pc-advshell__harness-bar pc-advshell__harness-bar--${stateClass}`} aria-label={`${t('pot')} status`}>
      {/* Stop (when started) — THE hive control, hidden when no hive is
          registered. START IS GONE: it was hidden while the tier was retired
          (D-010) and P-068/D-098 deleted the flag that made that reversible, so
          the button can never render again. Stop is NOT gated (D-017) — refusing
          a stop is never the safe direction, and it stays reachable to wind down
          any pot still started from before the retirement. */}
      {hive && effectivelyAlive && (
        <Tooltip label={`Pause ${t('pot', { lower: true })} (${hive.slug}) — stage autonomous wakes and drain live ${t('contributor', { plural: true, lower: true })}`}>
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--stop"
            onClick={stopHive}
          >
            <Square size={11} aria-hidden />
            {`Stop ${t('pot', { lower: true })}`}
          </button>
        </Tooltip>
      )}
    </div>
    </>
  );
}
