/**
 * undeliverable-guard-rail.ts — flag a safety-slot fact that CANNOT REACH the agent
 * it was written for, because its own delivery path traverses the very surface it is
 * warning about (EI-21228381584914967).
 *
 * THE BUG THIS EXISTS TO KILL. A guard-rail whose DELIVERY PATH runs through the
 * surface it warns about has an effective reach of zero — and it fails SILENTLY,
 * because from the author's side it looks fully distributed: `facts:assert` returns
 * ok, `facts:list` shows the row, every fold renders it. Nothing anywhere reports
 * that the one population who needs it is precisely the population that cannot
 * receive it.
 *
 * MEASURED INSTANCE, end to end (2026-08-23). WI-40869 — Codex `exec_command` yields
 * at its 10s `yield_time_ms` default, so a slow `ptool` call returns zero bytes and
 * reads as empty success — was diagnosed, closed, broadcast hive-wide five times, and
 * pinned as standing fact `guard-rail:ptool-empty-success-is-codex-exec-not-the-tool`
 * (asserted 07:07Z, refreshed 07:24Z). At 07:30Z, six minutes after that refresh, a
 * Codex session filed EI-21228030266559986: "coord:orient exits with an empty
 * payload" — the exact misreading the fact existed to prevent, by an agent that could
 * not receive it.
 *
 * WHY THE SECOND DELIVERY PATH DOES NOT FIX IT. There are two fact-delivery paths,
 * not one: the `coord:orient` fact fold, and the turn-start orientation fold
 * (`endpoint-route/routes/agent-mcp/turn-start-memory.ts`, which folds the never-drop
 * `dead-end:`/`wall:`/`guard-rail:` slots on any agent-mcp call, default ON and
 * host-agnostic). Both are returned INSIDE the agent-mcp HTTP response
 * (`Response.json({ ok, text })`). So they share one failure mode: a transport that
 * empties or truncates that response empties the fact fold with it. Adding delivery
 * paths does not help while every path rides the same envelope.
 *
 * WHAT ACTUALLY REACHES A STRANDED SESSION. Only the LAUNCH CONTEXT — the prompts
 * under `apps/operator/prompts/`, assembled at spawn, before the agent makes any tool
 * call. That is why the real remedy for WI-40869 is a section in the Codex playbook
 * and not a fact row, and it is the placement this advisory points authors toward.
 *
 * WHY ADVISORY AND NOT A REFUSAL. The fact row is still worth writing: it reaches
 * every agent whose transport is healthy, and it is the durable record of the
 * finding. The defect is not "this fact is wrong" but "this fact alone is not
 * enough" — so the write proceeds and the author is told what else is required.
 * Refusing would delete a useful row to punish an incomplete remedy.
 *
 * SCOPED DELIBERATELY TIGHT. Firing requires BOTH a response-envelope SUBJECT and a
 * silent-FAILURE mode, because either alone is ordinary prose: a guard-rail may name
 * `coord:orient` while being about scoping rules, and may say "empty" while being
 * about an empty result set. A false advisory here is not free — it trains authors to
 * skim past the receipt, which is the same channel that carries the eviction and
 * truncation warnings.
 */
import type { SafetySlot } from './safety-slot-key-intent';

/**
 * Terms naming the agent-mcp RESPONSE ENVELOPE or a transport that carries it.
 * A guard-rail about one of these is a guard-rail about its own delivery path.
 */
export const RESPONSE_ENVELOPE_SUBJECTS: readonly RegExp[] = [
  /\bexec_command\b/i,
  /\byield_time_ms\b/i,
  /\bptool\b/i,
  /\bagent-mcp\b/i,
  /\bmcp\s+(?:call|tool|response|transport|server|client)\b/i,
  /\btool[- ]call\s+(?:result|response|output|envelope)\b/i,
  /\bresponse\s+envelope\b/i,
  /\bcoord:orient\b/i,
  /\btools:invoke\b/i,
];

/**
 * Terms naming a SILENT failure — one that returns a well-formed answer rather than
 * an error. These are the failures a stranded agent cannot self-diagnose, which is
 * what makes undelivered guidance about them expensive.
 */
export const SILENT_FAILURE_MODES: readonly RegExp[] = [
  /\bempty\s+(?:success|payload|output|result|response|string)\b/i,
  /\breturns?\s+nothing\b/i,
  /\bzero\s+bytes\b/i,
  /\byields?\b/i,
  /\byielded\b/i,
  /\btruncat/i,
  /\bswallow/i,
  /\bsilently\s+(?:drops?|fails?|lost|lose)/i,
  /\bhangs?\b/i,
  /\btimes?\s+out\b/i,
  /\bno\s+output\b/i,
];

/** The advisory attached to a safety-slot fact that cannot reach a stranded session. */
export interface UndeliverableGuardRail {
  /** Which never-drop slot the fact was written into. */
  slot: SafetySlot;
  /** The response-envelope subject that matched, for the author to recognize. */
  subjectMatch: string;
  /** The silent-failure mode that matched. */
  failureMatch: string;
  /** Rendered on the assert receipt; the write still succeeds. */
  note: string;
}

/** First matching substring for a pattern set, or null when none match. */
function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m && m[0]) return m[0];
  }
  return null;
}

/**
 * Detect a safety-slot fact whose subject is the delivery path that would carry it.
 *
 * Returns null for every fact that is not in a never-drop slot, and for any fact
 * that names a transport WITHOUT a silent-failure mode (or the reverse) — see the
 * scoping note in the module header.
 */
export function detectUndeliverableGuardRail(
  slot: SafetySlot | null | undefined,
  key: string,
  body: string,
): UndeliverableGuardRail | null {
  if (!slot) return null;
  const text = `${key ?? ''}\n${body ?? ''}`;
  if (!text.trim()) return null;

  const subjectMatch = firstMatch(text, RESPONSE_ENVELOPE_SUBJECTS);
  if (!subjectMatch) return null;
  const failureMatch = firstMatch(text, SILENT_FAILURE_MODES);
  if (!failureMatch) return null;

  return {
    slot,
    subjectMatch,
    failureMatch,
    note:
      `This ${slot} fact is about the agent-mcp RESPONSE TRANSPORT itself ` +
      `("${subjectMatch}" + "${failureMatch}"), which is the path that would deliver it. ` +
      `Both fact-delivery paths — the coord:orient fact fold and the turn-start ` +
      `orientation fold — are returned inside that same response, so a transport ` +
      `failure that empties the response empties this fact with it. The agents who ` +
      `most need this guard-rail are exactly the ones who cannot receive it, and ` +
      `nothing reports the miss: the write succeeds and the row folds normally for ` +
      `everyone whose transport is healthy. KEEP this fact (it reaches healthy ` +
      `sessions and is the durable record), but it is NOT sufficient on its own — ` +
      `put the operative instruction in the LAUNCH CONTEXT under ` +
      `apps/operator/prompts/ for the affected host, which is assembled at spawn ` +
      `before the agent makes any tool call and is the only delivery path that does ` +
      `not traverse the surface you are warning about.`,
  };
}
