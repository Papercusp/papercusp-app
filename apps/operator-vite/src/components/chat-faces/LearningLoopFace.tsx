/**
 * LearningLoopFace — the 🎓 Learning face for the Papercup chat sidebar
 * (owner pick 2026-07-26: mockup option C "Loop" of three rendered mockups —
 * the loop's SHAPE with live counts + bottleneck, the release-readiness meter,
 * and a needs-attention list; a decision surface, not a directory).
 *
 * Composes FOUR existing precomputed sync queries (learning.releaseReadiness,
 * learning.gym, learning.improvements, learning.retain) — the same reads the
 * full Learning tab's views run, so this face can never drift from what the
 * tab shows. Every element deep-links into the full tab by setting the SAME
 * nuqs params the tab owns (?tab=learning + ?lview=…); the face itself stays
 * lit, so the summary remains visible beside the detail it opened.
 *
 * Graded/revision counts ride the readiness report's grader-feedback-revised
 * criterion, which exposes them only in its observed STRING — parsed
 * defensively and rendered as "—" when the wording drifts, never invented.
 */
import { useMemo } from "react";
import { useFlag } from "@papercusp/flags/client";
import { FLAGS } from "@papercusp/flags";
import { useQueryState, parseAsString } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
// The shared design primitive — a bare `title=` on a <button> is blocked by
// app/_lints/design-primitives.test.ts ("blocks title-only tooltips on
// buttons"): it is invisible to keyboard/touch users and unstyled.
import { Tooltip } from "@/app/harness/Tooltip";
import type { ReleaseReadinessSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-release-readiness-read";
// WI-7279: the wire shape is narrower than the server-side ImprovementDigest —
// this face reads only `humanQueue.length`, but typing it to the wire keeps that
// honest if it ever reads a field.
import type { LearningImprovementsRow } from "@papercusp/operator-core/lib/harness/improvements/learning-digest-snapshot";
import type { RetainExtrasSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-retain-read";

/** The slices of learning.gym this face reads (the full shape is LearningTab-local). */
interface GymFaceSnapshot {
  proposals?: Array<{ status?: string }>;
  autoloops?: Array<{ enabled?: boolean; status?: string; spentUsd?: number; budgetUsd?: number | null }>;
  runs?: Array<{ states?: string[] }>;
}

const STAGE_LINKS: ReadonlyArray<{ id: string; label: string; lview: string }> = [
  { id: "observe", label: "Observe", lview: "signals" },
  { id: "analyze", label: "Analyze", lview: "pipeline" },
  // `ideas` was retired 2026-07-27 (learning-tab-surface-public-release P-003):
  // the Ideas ledger merged into Improvements. The tab redirects a stale id, so
  // this kept working — but it would have written a URL naming a dead view.
  { id: "improve", label: "Improve", lview: "improvements" },
  { id: "retain", label: "Retain", lview: "learnings" },
  { id: "verify", label: "Verify", lview: "benchmark" },
];

export default function LearningLoopFace() {
  const [, setTab] = useQueryState("tab", parseAsString);
  const [, setLview] = useQueryState("lview", parseAsString);
  // The Gym rides FLAGS.TESTING (LearningTab's TESTING_ONLY_VIEWS).
  const testingOn = useFlag(FLAGS.TESTING);

  const readiness = useSyncQuery<ReleaseReadinessSnapshot>({
    queryName: "learning.releaseReadiness",
    staleTime: 30_000,
  });
  const gym = useSyncQuery<GymFaceSnapshot>({ queryName: "learning.gym", staleTime: 30_000 });
  const improvements = useSyncQuery<LearningImprovementsRow>({
    queryName: "learning.improvements",
    staleTime: 30_000,
  });
  const retain = useSyncQuery<RetainExtrasSnapshot | undefined>({
    queryName: "learning.retain",
    staleTime: 60_000,
  });

  const report = readiness.data?.[0]?.report ?? null;
  const gymSnap = gym.data?.[0];
  const digest = improvements.data?.[0];
  const banked = retain.data?.[0]?.banked;

  const open = (lview: string) => {
    void setTab("learning");
    void setLview(lview);
  };

  const derived = useMemo(() => {
    const criteria = report?.criteria ?? [];
    const grader = criteria.find((c) => c.key === "grader-feedback-revised");
    const graded = grader ? /\/\s*(\d+)\s+graded/.exec(grader.observed ?? "")?.[1] ?? null : null;
    const revised = grader ? /^(\d+)\s+routed idea/.exec(grader.observed ?? "")?.[1] ?? null : null;
    const routed = report?.window?.routedIdeas ?? null;
    const kept =
      banked && (banked.improvementsFiled7d != null || banked.plansDrafted7d != null)
        ? (banked.improvementsFiled7d ?? 0) + (banked.plansDrafted7d ?? 0)
        : null;
    const bars = criteria.map((c) => c.status);
    const passed = report?.passed ?? 0;

    // Bottleneck: the loop's weakest live conversion. Grade→revision starving
    // (<5% of graded ideas produce a typed revision) outranks an evidence-
    // starved Verify bar; a healthy loop highlights nothing.
    const gradedN = graded ? Number(graded) : null;
    const revisedN = revised ? Number(revised) : null;
    let bottleneck: string | null = null;
    let bottleneckNote: string | null = null;
    if (gradedN != null && revisedN != null && gradedN >= 20 && revisedN / gradedN < 0.05) {
      bottleneck = "improve";
      bottleneckNote = `grade → typed-revision conversion (${revisedN} of ${gradedN})`;
    } else if ((report?.unknown ?? 0) > 0) {
      bottleneck = "verify";
      bottleneckNote = "a readiness bar still lacks evidence";
    }

    const pendingProposals = (gymSnap?.proposals ?? []).filter((p) => p.status === "pending").length;
    const reviewQueue = digest?.humanQueue?.length ?? 0;
    const runningLoops = (gymSnap?.autoloops ?? []).filter(
      (a) => a.enabled || a.status === "running",
    ).length;

    const attention: Array<{ text: string; lview: string; tone: "warn" | "dim" }> = [];
    if ((report?.unknown ?? 0) > 0)
      attention.push({
        text: `Release readiness incomplete — ${passed}/${bars.length} bars, soak at ${report?.window?.ticks ?? 0} ticks`,
        lview: "benchmark",
        tone: "warn",
      });
    // Gated with the Gym view itself (LearningTab's TESTING_ONLY_VIEWS): with
    // FLAGS.TESTING off the Gym is not in the tab, so this row would advertise a
    // decision on a surface the user cannot open — and its `lview: "gym"` link
    // would bounce to the default view.
    if (testingOn && pendingProposals > 0)
      attention.push({ text: `${pendingProposals} gym proposal(s) pending decision`, lview: "gym", tone: "warn" });
    if (reviewQueue > 0)
      attention.push({ text: `${reviewQueue} backlog item(s) await human review`, lview: "improvements", tone: "dim" });

    return {
      routed,
      graded,
      revised,
      kept,
      bars,
      passed,
      verdict: report?.verdict ?? null,
      ticks: report?.window?.ticks ?? null,
      bottleneck,
      bottleneckNote,
      runningLoops,
      attention: attention.slice(0, 3),
    };
  }, [report, gymSnap, digest, banked, testingOn]);

  const loading = !report && !readiness.error && readiness.data === undefined;

  const nodeValue = (id: string): string => {
    switch (id) {
      case "observe":
        return derived.routed != null ? String(derived.routed) : "—";
      case "analyze":
        return derived.graded ?? "—";
      case "improve":
        return derived.revised ?? "—";
      case "retain":
        return derived.kept != null ? String(derived.kept) : "—";
      case "verify":
        return derived.bars.length > 0 ? `${derived.passed}/${derived.bars.length}` : "—";
      default:
        return "—";
    }
  };
  const nodeSub = (id: string): string =>
    ({ observe: "signals", analyze: "graded", improve: "revisions", retain: "kept · 7d", verify: "bars" })[id] ?? "";

  return (
    <div className="pc-lf" data-testid="learning-loop-face">
      <style>{LEARNING_FACE_CSS}</style>
      {loading ? (
        <p className="pc-lf__empty">Loading the learning loop…</p>
      ) : (
        <>
          <section className="pc-lf__card" aria-label="Learning loop stages">
            <h3 className="pc-lf__h">
              The loop <span className="pc-lf__hn">counts · live window</span>
            </h3>
            <div className="pc-lf__loop">
              {STAGE_LINKS.map((s) => (
                <Tooltip key={s.id} label={`Open Learning → ${s.label}`}>
                  <button
                    type="button"
                    className={`pc-lf__node${derived.bottleneck === s.id ? " is-hot" : ""}`}
                    onClick={() => open(s.lview)}
                  >
                    <span className="pc-lf__nk">{s.label}</span>
                    <span className="pc-lf__nv">{nodeValue(s.id)}</span>
                    <span className="pc-lf__ns">{nodeSub(s.id)}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
            {derived.bottleneckNote ? (
              <p className="pc-lf__note">
                Bottleneck: {derived.bottleneckNote} —{" "}
                <button type="button" className="pc-lf__link" onClick={() => open(derived.bottleneck === "improve" ? "ideas" : "benchmark")}>
                  open {derived.bottleneck === "improve" ? "Ideas" : "Verify"}
                </button>
              </p>
            ) : null}
          </section>

          <section className="pc-lf__card pc-lf__card--verify" aria-label="Release readiness">
            <h3 className="pc-lf__h">
              Release readiness{" "}
              <span className="pc-lf__hn">{derived.verdict ?? "unreadable"}</span>
            </h3>
            <Tooltip label="Open Learning → Verify">
              <button type="button" className="pc-lf__meterbtn" onClick={() => open("benchmark")}>
                <span className="pc-lf__meter" role="img" aria-label={`${derived.passed} of ${derived.bars.length} readiness bars pass`}>
                  {derived.bars.map((s, i) => (
                    <span key={i} className={`pc-lf__seg pc-lf__seg--${s}`} />
                  ))}
                </span>
              </button>
            </Tooltip>
            {derived.ticks != null ? (
              <p className="pc-lf__note">
                live window <strong>{derived.ticks} tick(s)</strong>
                {testingOn && derived.runningLoops > 0 ? (
                  <> · {derived.runningLoops} gym loop(s) armed</>
                ) : null}
              </p>
            ) : null}
          </section>

          {derived.attention.length > 0 ? (
            <section className="pc-lf__card" aria-label="Needs attention">
              <h3 className="pc-lf__h">
                Needs attention <span className="pc-lf__hn">{derived.attention.length}</span>
              </h3>
              {derived.attention.map((a) => (
                <button key={a.text} type="button" className={`pc-lf__row pc-lf__row--${a.tone}`} onClick={() => open(a.lview)}>
                  {a.text}
                </button>
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

const LEARNING_FACE_CSS = `
.pc-lf { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; }
.pc-lf__empty { color: var(--fg-mute); font-size: 12px; padding: 12px 4px; }
.pc-lf__card {
  border: 1px solid var(--border); border-radius: 10px;
  background: color-mix(in srgb, var(--bg-raised), transparent 40%);
  padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
}
.pc-lf__card--verify { border-left: 3px solid color-mix(in srgb, #f59e0b, transparent 55%); }
.pc-lf__h {
  display: flex; align-items: baseline; gap: 7px; margin: 0;
  color: var(--fg-dim); font-size: 10px; font-weight: 750; text-transform: uppercase;
}
.pc-lf__hn { margin-left: auto; color: var(--fg-mute); text-transform: none; font-weight: 500; }
.pc-lf__loop { display: flex; align-items: stretch; }
.pc-lf__node {
  flex: 1; min-width: 0; text-align: center; padding: 7px 2px 6px; cursor: pointer;
  border: 1px solid var(--border); background: color-mix(in srgb, var(--bg-raised), transparent 20%);
  color: inherit; display: flex; flex-direction: column; gap: 1px;
}
.pc-lf__node:first-child { border-radius: 9px 0 0 9px; }
.pc-lf__node:last-child { border-radius: 0 9px 9px 0; }
.pc-lf__node + .pc-lf__node { border-left: none; }
.pc-lf__node:hover, .pc-lf__node:focus-visible { background: color-mix(in srgb, var(--bg-raised), transparent 0%); outline: none; }
.pc-lf__node.is-hot { box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.5); }
.pc-lf__node.is-hot .pc-lf__nk { color: #34d399; }
/* letter-spacing stays 0 — nonzero tracking is blocked by the design-primitive
   lint (/internal/docs/design: stable type sizes, letter-spacing: 0). */
.pc-lf__nk { font-size: 9px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute); }
.pc-lf__nv { font: 700 15px ui-monospace, monospace; font-variant-numeric: tabular-nums; color: var(--fg); }
.pc-lf__ns { font-size: 9px; color: var(--fg-mute); }
.pc-lf__note { margin: 0; font-size: 10.5px; color: var(--fg-mute); }
.pc-lf__note strong { color: var(--fg-dim); font-weight: 600; }
.pc-lf__link { background: none; border: none; padding: 0; cursor: pointer; color: #34d399; font-size: 10.5px; }
.pc-lf__link:hover, .pc-lf__link:focus-visible { text-decoration: underline; outline: none; }
.pc-lf__meterbtn { background: none; border: none; padding: 0; cursor: pointer; width: 100%; }
.pc-lf__meter { display: flex; gap: 3px; }
.pc-lf__seg { flex: 1; height: 7px; border-radius: 2px; background: rgba(52, 211, 153, 0.75); }
.pc-lf__seg--unknown { background: rgba(245, 158, 11, 0.55); }
.pc-lf__seg--fail { background: rgba(239, 68, 68, 0.7); }
.pc-lf__row {
  display: block; width: 100%; text-align: left; cursor: pointer;
  background: none; border: none; padding: 3px 0; font-size: 11.5px; color: var(--fg-dim);
}
.pc-lf__row:hover, .pc-lf__row:focus-visible { text-decoration: underline; outline: none; }
.pc-lf__row--warn { color: #f59e0b; }
`;
