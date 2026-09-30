/**
 * store.ts — the telemetry-store seam for the activity bridge.
 *
 * `normalize.ts` turns a raw CLI hook event into a uniform `{ kind, summary,
 * detail }`. This module defines WHERE those records go: a narrow `TelemetryStore`
 * port the host implements (over Postgres / SQLite / an in-memory array / …), plus
 * `recordActivity()` — the generic flow that ties normalization to the store.
 *
 * Zero host coupling: the lib owns "normalize a raw report → an ActivityRecord →
 * append it"; the host owns the store implementation (the persistence + how it
 * reads/streams the records back, which is host-shaped and intentionally out of
 * this port). Inject the store; the lib names no consuming app.
 */
import { summariseActivity, clip, type ToolInput, type TodoItem } from './normalize';

export type ActivityKind = 'tool' | 'lifecycle' | 'todos';
export type ActivityPhase = 'pre' | 'post';

/**
 * A raw activity report as a CLI hook forwards it (pre-normalization). The host
 * maps its own hook payload onto this shape; the lib normalizes it.
 */
export interface RawActivityReport {
  /** The reporting agent's stable identity (the per-pane grouping key, NOT a recipient). */
  owner: string;
  /** Which CLI produced it (e.g. 'claude' | 'codex' | 'omp'); best-effort. */
  agent?: string | null;
  /** The CLI's native session id, for resume correlation. */
  sessionId?: string | null;
  /** A host-domain scope tag (e.g. the repo/project the agent is operating in). */
  scope?: string | null;
  /** Override the derived kind; otherwise inferred (todos > tool > lifecycle). */
  kind?: ActivityKind | null;
  /** The native tool name (Edit / Bash / apply_patch / …). */
  toolName?: string | null;
  /** 'pre' (PreToolUse/tool_call) | 'post' (PostToolUse/tool_result). */
  phase?: ActivityPhase | null;
  /** The CLI's per-call id, correlating a pre/post pair. */
  toolUseId?: string | null;
  /** Raw (host-capped) native tool input — summarised here. */
  toolInput?: ToolInput;
  /** A TodoWrite/TaskCreate/TaskUpdate snapshot — summarised here. */
  todos?: TodoItem[] | null;
  /** A pre-formatted one-liner; overrides the derived summary. */
  summary?: string | null;
  /** 'ok' | 'error' when the report carries an outcome. */
  status?: string | null;
  /** The agent's cwd at report time. */
  cwd?: string | null;
  /** Optional fleet/workspace partition (the store may default or ignore it). */
  workspaceId?: string;
}

/** A normalized activity record, ready for the store to persist. */
export interface ActivityRecord {
  owner: string;
  agent: string | null;
  sessionId: string | null;
  scope: string | null;
  kind: ActivityKind;
  toolName: string | null;
  phase: ActivityPhase | null;
  toolUseId: string | null;
  summary: string;
  status: string | null;
  detail: Record<string, unknown> | null;
  cwd: string | null;
  workspaceId?: string;
}

/**
 * The injected persistence seam. The host implements `append` over its own store.
 * Reading the records back is host-shaped (filters, time windows, wire format) and
 * deliberately NOT part of this port — keep the ingest seam narrow.
 */
export interface TelemetryStore {
  append(record: ActivityRecord): Promise<{ id: string | null }>;
}

/** The cap a stored summary must fit (matches a typical single-line display). */
export const SUMMARY_CAP = 512;

/**
 * Normalize a raw report into a store-ready `ActivityRecord` (pure, no I/O). An
 * explicit `summary`/`kind` on the report overrides the derived value; everything
 * else is derived from `toolName`/`toolInput`/`todos`.
 */
export function normalizeReport(report: RawActivityReport): ActivityRecord {
  const derived = summariseActivity({
    toolName: report.toolName,
    toolInput: report.toolInput,
    todos: report.todos,
  });
  const kind = report.kind ?? derived.kind;
  const summary = clip((report.summary && report.summary.trim()) || derived.summary, SUMMARY_CAP);
  return {
    owner: report.owner,
    agent: report.agent ?? null,
    sessionId: report.sessionId ?? null,
    scope: report.scope ?? null,
    kind,
    toolName: report.toolName ?? null,
    phase: report.phase ?? null,
    toolUseId: report.toolUseId ?? null,
    summary,
    status: report.status ?? null,
    detail: derived.detail,
    cwd: report.cwd ?? null,
    workspaceId: report.workspaceId,
  };
}

/** Normalize + persist one report through the injected store. */
export async function recordActivity(
  store: TelemetryStore,
  report: RawActivityReport,
): Promise<{ id: string | null; owner: string; kind: ActivityKind; summary: string }> {
  const record = normalizeReport(report);
  const { id } = await store.append(record);
  return { id, owner: record.owner, kind: record.kind, summary: record.summary };
}
