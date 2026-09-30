/**
 * The locked benchmark-arm vocabulary (impartial-benchmark-suite-2026-06-15).
 *
 * These exact strings are the cross-brief contract (locked by BRIEF 7/P-011):
 * the run-result schema, the Evaluation surface (P-020), and these shared viz
 * components (P-021) all key arm → series/color on them. `papercusp` is the
 * treatment; the three `baseline-*` are the controls (A ablation, B native
 * harness — the headline, C best-of-N). See plan D-001/D-002.
 *
 * The viz props type `arm` as a plain `string` (not this union) on purpose —
 * unknown arms still render (neutral color), so a new arm never crashes the
 * chart and the canonical type can be owned/published by P-011 without a
 * type-ownership conflict here. This module just gives the KNOWN arms stable
 * labels + colors so both the gym and the evals surface look identical.
 */
export type ArmId =
  // L1 per-task arms (Phase 2)
  | 'papercusp'
  | 'baseline-a-ablation'
  | 'baseline-b-native'
  | 'baseline-c-bestofn'
  // L2–L5 fleet arms (Phase 5 / D-010 reframe). PROVISIONAL strings — confirm
  // against the fleet arm vocab locked by P-025/P-011 (su-4ac61) + P-023 (su-136a4).
  | 'hive'
  | 'queen-ablated'
  | 'native-serial'
  | 'openhands-async'
  | 'crewai'
  | 'langgraph'
  // Real run-engine arm ids (benchmark-evaluation-ui-2026-06-16 D-004). These are
  // the EXACT strings the live engine + preserved/operational store emit
  // (hive-backlog-realqueen.ts HIVE_REALQUEEN_ARM/FIFO_NOQUEEN_ARM) + the
  // SWE-bench Pro reference harness. The m3 real-Queen pass is `hive-realqueen`;
  // the headline comparison is hive-realqueen (treatment) vs mini-swe-agent (the
  // standard-harness baseline, same model + same tasks).
  | 'hive-realqueen'
  | 'fifo-noqueen'
  | 'mini-swe-agent'
  // The independent-su-agents arm (benchmark-arms-su-vs-queen-expansion-2026-06-16 P-001): N
  // independent su/worker agents, one SWE-bench-Pro task each, NO queen + NO hive coordination — the
  // honest "our agent system, no orchestration" pole, compared against hive-realqueen + mini-swe-agent.
  | 'su-independent';

export const ARM_IDS: readonly ArmId[] = [
  'papercusp',
  'baseline-a-ablation',
  'baseline-b-native',
  'baseline-c-bestofn',
  'hive',
  'queen-ablated',
  'native-serial',
  'openhands-async',
  'crewai',
  'langgraph',
  'hive-realqueen',
  'fifo-noqueen',
  'mini-swe-agent',
  'su-independent',
] as const;

/** Short human label for an arm; falls back to the raw id for unknown arms. */
export function armLabel(arm: string): string {
  switch (arm) {
    case 'papercusp': return 'Papercusp';
    case 'baseline-a-ablation': return 'Baseline A · ablation';
    case 'baseline-b-native': return 'Baseline B · native';
    case 'baseline-c-bestofn': return 'Baseline C · best-of-N';
    // Fleet arms (Phase 5)
    case 'hive': return 'Pot';
    case 'queen-ablated': return 'Mug-ablated';
    case 'native-serial': return 'Native (serial)';
    case 'openhands-async': return 'OpenHands';
    case 'crewai': return 'CrewAI';
    case 'langgraph': return 'LangGraph';
    // Real run-engine arms (D-004).
    case 'hive-realqueen': return 'Pot (real Mug)';
    case 'fifo-noqueen': return 'FIFO (no Mug)';
    case 'mini-swe-agent': return 'mini-SWE-agent';
    case 'su-independent': return 'SU agents (independent)';
    default: return arm;
  }
}

/**
 * Series color for an arm. These exact values are the canonical arm palette —
 * the Evaluation surface's legend + per-arm scoreboard key on the same values
 * (AdvEvalsTab `ARM_COLOR`), so the Frontier scatter dots match the legend.
 * This is the single source of truth: the surface should import `armColor` from
 * here rather than re-declaring it. Cyan/sky slots use the semantic accent token
 * so the chart follows the active theme; other categorical slots keep fixed hues.
 * Unknown arms get the neutral muted color.
 */
export function armColor(arm: string): string {
  switch (arm) {
    case 'papercusp': return '#eab308'; // gold — the L1 treatment (matches the active-subtab accent)
    case 'baseline-a-ablation': return '#a78bfa'; // violet
    case 'baseline-b-native': return 'var(--accent, #38bdf8)'; // accent — native arm
    case 'baseline-c-bestofn': return '#34d399'; // emerald
    // Fleet arms (Phase 5). hive = the treatment (gold, like papercusp — they
    // never share a chart). queen-ablated = the headline baseline control (rose).
    // native-serial reuses the native accent. Competitors get distinct hues.
    case 'hive': return '#eab308'; // gold — the L2+ treatment (D-010)
    case 'queen-ablated': return '#fb7185'; // rose — the headline baseline (Queen OFF)
    case 'native-serial': return 'var(--accent, #38bdf8)'; // accent — serial floor (native, serial)
    case 'openhands-async': return '#a78bfa'; // violet
    case 'crewai': return '#f97316'; // orange
    case 'langgraph': return '#2dd4bf'; // teal
    // Real run-engine arms (D-004). hive-realqueen = treatment (gold, like hive);
    // fifo-noqueen = the Queen-OFF control (rose, like queen-ablated); mini-swe-agent
    // = the standard-harness reference baseline (accent — the harness floor).
    case 'hive-realqueen': return '#eab308'; // gold — real-Queen treatment
    case 'fifo-noqueen': return '#fb7185'; // rose — no-Queen control
    case 'mini-swe-agent': return 'var(--accent, #38bdf8)'; // accent — reference standard harness
    // su-independent (P-001): N independent agents, no orchestration — the honest "our agent system"
    // pole vs the Queen system + the reference harness. Lime, distinct from gold/rose/sky.
    case 'su-independent': return '#84cc16'; // lime — independent-agents pole
    default: return 'var(--fg-mute, #7f9bb4)';
  }
}
