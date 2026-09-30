/**
 * LearningInfraHealthChip — the ONE composite "learning system offline /
 * degraded / up" status chip on the Learning tab
 * (self-improvement-consume-edges-2026-06-12 P-003 / D-002).
 *
 * Reads `learning.health` (the 2-min learning-infra tick's snapshot: LLM
 * transport resolvability + runner spawn path + gym fire circuit) and renders a single
 * tone-dotted chip with the per-leg evidence in the hover hint — the standing
 * Learning-tab face of the status whose offline transition also notifies the
 * owner (infra failures escalate, they don't queue).
 *
 * Renders only actionable degraded/offline snapshots. Healthy, flag-off,
 * loading, error, and foreign payload states stay quiet — a health chip must
 * never add noise of its own. Styles are scoped here
 * (pc-lihealth__*) so the LearningTab hotspot wiring stays at two lines.
 */
import { useSyncQuery } from "@papercusp/sync";
import { HeartPulse } from "lucide-react";
import type { LearningInfraHealth } from "@papercusp/operator-core/lib/harness/improvements/learning-infra-health";

const TONES = { ok: "good", degraded: "warn", offline: "bad" } as const;

const LABELS: Record<keyof typeof TONES, string> = {
  ok: "learning infra up",
  degraded: "learning infra degraded",
  offline: "learning system OFFLINE",
};

function evaluatedAgo(evaluatedAt: number, nowMs: number): string {
  const min = Math.max(0, (nowMs - evaluatedAt) / 60_000);
  if (min < 1) return "just now";
  if (min < 90) return `${Math.round(min)}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

export default function LearningInfraHealthChip() {
  const sync = useSyncQuery<LearningInfraHealth>({
    queryName: "learning.health",
    args: {},
    staleTime: 30_000,
  });
  const health = sync.data?.[0];
  if (!health || !(health.status in TONES) || health.status === "ok")
    return null;
  const tone = TONES[health.status];
  const hint =
    `The learning system's own infrastructure — the LLM spine (gym judge, llm-testing — the stateless anthropic-direct transport), ` +
    `the runner spawn path (auto-implement workers), and the gym fire circuit. ` +
    `When this goes offline you are notified directly: these failures can't be auto-fixed by the improvement queue.\n\n` +
    health.legs.map((l) => `${l.name}: ${l.status} — ${l.detail}`).join("\n") +
    `\n\nchecked ${evaluatedAgo(health.evaluatedAt, Date.now())}`;
  return (
    <span
      className={`pc-lihealth pc-lihealth--${tone}`}
      title={hint}
      aria-label={LABELS[health.status]}
    >
      <span
        className={`pc-lihealth__dot pc-lihealth__dot--${tone}`}
        aria-hidden
      />
      <HeartPulse size={11} aria-hidden />
      {LABELS[health.status]}
      {/* `status` is already narrowed to degraded|offline by the early return
          above, so the old `status !== "ok"` guard here was dead (TS2367) — it
          could never be false. Show the reason when there IS one. */}
      {health.reason ? <em>{health.reason}</em> : null}
      <style>{`
        .pc-lihealth {
          display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
          max-width: 340px; padding: 4px 10px; font-size: 11px; font-weight: 600;
          border-radius: 999px; white-space: nowrap;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
          background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
        }
        .pc-lihealth em {
          font-style: normal; font-size: 9.5px; overflow: hidden; text-overflow: ellipsis;
          letter-spacing: 0; color: var(--fg-mute, #7f9bb4);
        }
        .pc-lihealth--good { border-color: rgba(52, 211, 153, 0.4); }
        .pc-lihealth--warn { border-color: rgba(252, 211, 77, 0.45); color: var(--fg-dim, #b9d4e8); }
        .pc-lihealth--bad { border-color: rgba(248, 113, 113, 0.5); color: var(--fg-dim, #b9d4e8); }
        .pc-lihealth__dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .pc-lihealth__dot--good { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.7); }
        .pc-lihealth__dot--warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251, 191, 36, 0.6); }
        .pc-lihealth__dot--bad { background: #f87171; box-shadow: 0 0 5px rgba(248, 113, 113, 0.6); }
      `}</style>
    </span>
  );
}
