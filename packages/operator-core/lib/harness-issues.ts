/**
 * Harness issues store — **PG-canonical** (engineer-issues-2026-06-03 D-004, Phase 3).
 *
 * The curated issue set is stored in `harness_shared.harness_issues_consolidated`,
 * read/written through the per-harness `harness_<slug>.harness_issues` VIEW. The
 * validator's structured findings live in `harness_pending_issues`; `/triage`
 * merges them into the curated set.
 *
 * Phase 3 removed the old `.papercusp/issues.json` FS-canonical file + the
 * best-effort PG mirror ("JSON authoritative, PG via Zero" — Zero is retired and
 * the file always drifted). PG is now the store-of-record: `loadIssuesOrSeed`
 * reads from PG (async), `saveIssues` writes to PG only and a failure PROPAGATES
 * (no silent swallow). `issues.md` remains a read-only seed source for harnesses
 * that have a validator issues.md but no persisted rows yet.
 *
 * Severity/status are clamped to the canonical enums (`lib/harness/issue-types`)
 * before write, so a non-canonical validator finding can't violate the DB CHECK
 * (migration 130) and silently drop a row.
 */
import { join } from "node:path";
// harnessQuery: PgBouncer-safe per-harness queries (C1-2) — a transaction with a
// per-tx search_path under PgBouncer, the existing getHarnessPg pool otherwise.
import { harnessQuery } from "@papercusp/db-org";
import { safeRead, harnessDir } from "./harness-core";
import type { Issue, IssueSeverity, IssueStatus } from "./harness/issue-types";
import type { ProjectEntry } from "./harness-registry";

export interface IssuesFile {
  issues: Issue[];
  nextId: number;
}

const SEVERITIES: readonly IssueSeverity[] = [
  "critical",
  "major",
  "minor",
  "nit",
];
const STATUSES: readonly IssueStatus[] = [
  "open",
  "acknowledged",
  "fixing",
  "closed",
  "wontfix",
];

// Known non-canonical drift → canonical, consistent with migration 130's one-time
// data normalization (info→nit, resolved→closed). Anything else falls back to a
// safe generic (minor / open). Keeps a stray validator finding from violating the
// DB CHECK while preserving its intent.
const SEVERITY_ALIASES: Record<string, IssueSeverity> = {
  info: "nit",
  informational: "nit",
  trivial: "nit",
  normal: "minor",
  medium: "minor",
  low: "minor",
  high: "major",
};
const STATUS_ALIASES: Record<string, IssueStatus> = {
  resolved: "closed",
  done: "closed",
  fixed: "closed",
  reopened: "open",
  new: "open",
  wont_fix: "wontfix",
  wontfix: "wontfix",
};

/** Clamp a possibly-non-canonical severity to the DB-CHECK'd enum (migration 130). */
export function clampSeverity(s: unknown): IssueSeverity {
  const v = String(s);
  if ((SEVERITIES as readonly string[]).includes(v)) return v as IssueSeverity;
  return SEVERITY_ALIASES[v] ?? "minor";
}
/** Clamp a possibly-non-canonical status to the DB-CHECK'd enum (migration 130). */
export function clampStatus(s: unknown): IssueStatus {
  const v = String(s);
  if ((STATUSES as readonly string[]).includes(v)) return v as IssueStatus;
  return STATUS_ALIASES[v] ?? "open";
}

/**
 * Next `I-NNNN` id (the curated allocator). Scans only numeric-suffixed ids;
 * hashed (`I-<hash>`), `PENDING-*`, and named (`I-STUCK`) ids don't participate.
 */
export function computeNextId(issues: readonly Issue[]): number {
  let max = 0;
  for (const i of issues) {
    const m = /^I-(\d+)$/.exec(i.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Robustly coerce a jsonb `notes` value to the note array. postgres-js may hand
 * back a parsed array OR the raw JSON string depending on how it infers the
 * column type through the per-harness VIEW — handle both.
 */
function parseNotes(v: unknown): Issue["notes"] {
  if (Array.isArray(v)) return v as Issue["notes"];
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? (p as Issue["notes"]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Load the curated issue set for a harness from PG (the store-of-record). */
export async function loadIssuesFromPg(
  project: ProjectEntry,
): Promise<Issue[]> {
  const rows = (await harnessQuery(
    project.slug,
    (q) => q`
    SELECT issue_id, title, severity, source, status, found_at, found_during, repro,
           evidence, suggested_fix, code_pointer, linked_feature_id, attempts, notes,
           created_ts
      FROM harness_issues
     WHERE harness_slug = ${project.slug}
     ORDER BY created_ts DESC, issue_id DESC
  `,
  )) as Array<{
    issue_id: string;
    title: string;
    severity: string;
    source: string;
    status: string;
    found_at: string | Date;
    found_during: string | null;
    repro: string | null;
    evidence: string | null;
    suggested_fix: string | null;
    code_pointer: string | null;
    linked_feature_id: string | null;
    attempts: number | string;
    notes: unknown;
  }>;
  return rows.map(
    (r): Issue => ({
      id: r.issue_id,
      title: r.title,
      severity: clampSeverity(r.severity),
      source: r.source as Issue["source"],
      foundAt:
        r.found_at instanceof Date
          ? r.found_at.toISOString()
          : String(r.found_at),
      foundDuring: r.found_during ?? undefined,
      status: clampStatus(r.status),
      repro: r.repro ?? undefined,
      evidence: r.evidence ?? undefined,
      suggestedFix: r.suggested_fix ?? undefined,
      codePointer: r.code_pointer ?? undefined,
      linkedFeatureId: r.linked_feature_id ?? undefined,
      attempts: Number(r.attempts) || 0,
      notes: parseNotes(r.notes),
    }),
  );
}

/**
 * Load the curated issue set; store-of-record = PG. When PG has no rows for the
 * harness AND a validator `issues.md` exists, synthesize a read-only seed from it
 * (the migration aid for un-triaged harnesses — not persisted until a mutation).
 */
export async function loadIssuesOrSeed(
  project: ProjectEntry,
): Promise<IssuesFile> {
  const issues = await loadIssuesFromPg(project);
  if (issues.length > 0) return { issues, nextId: computeNextId(issues) };
  const md = safeRead(join(harnessDir(project), "issues.md")) ?? "";
  const seeded = parseIssuesMdLocal(md);
  return { issues: seeded, nextId: computeNextId(seeded) };
}

/**
 * Persist the curated issue set to PG (store-of-record). The whole set is
 * upserted through the per-harness `harness_<slug>.harness_issues` VIEW into the
 * `harness_issues_consolidated` base; rows absent from `file` are deleted (cheap
 * — issue counts are O(100s)). Severity/status are clamped to the canonical enums
 * first (migration 130 CHECK). Unlike the old best-effort mirror, a PG failure
 * PROPAGATES — PG is the source of truth, so a failed write must surface.
 */
export async function saveIssues(
  project: ProjectEntry,
  file: IssuesFile,
): Promise<void> {
  const now = Date.now();
  const ids = file.issues.map((i) => i.id);
  // C1-2: one harnessQuery() so the upsert loop + reconcile DELETE share one
  // transaction (and one per-tx search_path) under PgBouncer. Param named `sql`
  // keeps the inner template refs unchanged.
  await harnessQuery(project.slug, async (sql) => {
    if (ids.length === 0) {
      await sql`DELETE FROM harness_issues WHERE harness_slug = ${project.slug}`;
      return;
    }
    // Per-row upsert with an explicit ${…}::jsonb cast for `notes` — the bulk
    // `sql(rows, …)` helper can't bind a jsonb column reliably through the
    // per-harness VIEW (postgres-js jsonb-binding insight). Counts are O(100s) and
    // saves are infrequent, so the N round-trips are fine.
    for (const i of file.issues) {
      await sql`
      INSERT INTO harness_issues
        (harness_slug, issue_id, title, severity, source, status, found_at, found_during,
         repro, evidence, suggested_fix, code_pointer, linked_feature_id, attempts, notes,
         created_ts, updated_ts)
      VALUES (${project.slug}, ${i.id}, ${i.title}, ${clampSeverity(i.severity)}, ${i.source},
              ${clampStatus(i.status)}, ${i.foundAt}, ${i.foundDuring ?? null}, ${i.repro ?? null},
              ${i.evidence ?? null}, ${i.suggestedFix ?? null}, ${i.codePointer ?? null},
              ${i.linkedFeatureId ?? null}, ${i.attempts ?? 0}, ${JSON.stringify(i.notes ?? [])}::text::jsonb,
              ${now}, ${now})
      ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
        title             = EXCLUDED.title,
        severity          = EXCLUDED.severity,
        source            = EXCLUDED.source,
        status            = EXCLUDED.status,
        found_at          = EXCLUDED.found_at,
        found_during      = EXCLUDED.found_during,
        repro             = EXCLUDED.repro,
        evidence          = EXCLUDED.evidence,
        suggested_fix     = EXCLUDED.suggested_fix,
        code_pointer      = EXCLUDED.code_pointer,
        linked_feature_id = EXCLUDED.linked_feature_id,
        attempts          = EXCLUDED.attempts,
        notes             = EXCLUDED.notes,
        updated_ts        = EXCLUDED.updated_ts
    `;
    }
    await sql`
    DELETE FROM harness_issues
    WHERE harness_slug = ${project.slug}
      AND issue_id <> ALL(${ids})
  `;
  });
}

/**
 * Inline re-implementation of the legacy harness UI's `parse-md.ts` parser —
 * extracts structured Issues from `issues.md`. The original now lives at
 * `libs/papercusp/_retired/apps-web/app/harness/issues/parse-md.ts` (app
 * retired 2026-06-10, audit P-079) — this copy is the live one. Synthesizes
 * Issue rows
 * when PG has no curated rows yet on a harness (read-only seed — not
 * persisted until a mutation happens).
 */
export function parseIssuesMdLocal(md: string): Issue[] {
  if (!md || !md.trim()) return [];
  const out: Issue[] = [];
  const seen = new Set<string>();

  const shortHash = (s: string): string => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36).padStart(7, "0").slice(-7);
  };

  const headerRe =
    /^## (F-[A-Z0-9-]+)\s+—\s+Validation round (\d+)\s+—\s+(\S+)\s*$/gm;
  const matches = [...md.matchAll(headerRe)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    const body = md.slice(start, end).trim();
    const feature = m[1];
    const ts = m[3];

    const sectRe =
      /###\s+OUT-OF-SCOPE[^\n]*\n([\s\S]*?)(?=\n### |\n---|\n## |$)/gi;
    let sm;
    while ((sm = sectRe.exec(body)) !== null) {
      const section = sm[1].trim();
      const items: string[] = [];
      const lines = section.split("\n");
      let cur = "";
      for (const line of lines) {
        if (/^\d+\.\s+/.test(line) || /^[-*]\s+\*\*/.test(line)) {
          if (cur.trim()) items.push(cur.trim());
          cur = line.replace(/^\d+\.\s+|^[-*]\s+/, "");
        } else {
          cur += "\n" + line;
        }
      }
      if (cur.trim()) items.push(cur.trim());

      for (const raw of items) {
        if (raw.length < 10) continue;
        const bold = raw.match(/\*\*(.+?)\*\*/);
        const title = bold
          ? bold[1].trim().replace(/[.:]\s*$/, "")
          : raw
              .split("\n")[0]
              .split(/(?<=[.!?])\s/)[0]
              .slice(0, 140)
              .trim();
        const codeM = raw.match(
          /([a-zA-Z0-9_./+-]+(?:\.[a-zA-Z0-9]+)?):(\d+)(?::\d+)?/,
        );
        const codePointer = codeM?.[0];
        const severity: IssueSeverity =
          /\bcrash|panic|corrupt|data loss|security|inject|RCE|auth bypass/i.test(
            raw,
          )
            ? "critical"
            : /\bblock|break|broken|fail\b|5\d\d|500\b|hang|deadlock|preflight\b/i.test(
                  raw,
                )
              ? "major"
              : /\bnit|typo|style|nitpick|cosmetic|wording/i.test(raw)
                ? "nit"
                : "minor";
        const id = `I-${shortHash(`${feature}|${title}|${codePointer ?? ""}`)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const reproM = raw.match(
          /Repro[s]?:\s*\n?((?:.+\n?)+?)(?=\n\n|\nObserved:|\nRoot cause:|\nImpact|\nSuggested|\nVerified|$)/i,
        );
        const evidenceM = raw.match(
          /(?:Observed|Evidence):\s*\n?((?:.+\n?)+?)(?=\n\n|\nRoot cause:|\nImpact|\nSuggested|\nVerified|$)/i,
        );
        const fixM = raw.match(
          /Suggested fix:\s*\n?((?:.+\n?)+?)(?=\n\n|\nFiled|$)/i,
        );

        out.push({
          id,
          title,
          severity,
          source: "validator",
          foundAt: ts,
          foundDuring: feature,
          status: "open",
          repro: reproM?.[1]?.trim(),
          evidence: evidenceM?.[1]?.trim() ?? raw.slice(0, 400),
          suggestedFix: fixM?.[1]?.trim(),
          codePointer,
          attempts: 0,
          notes: [],
        });
      }
    }
  }
  return out;
}

/**
 * Read the validator's un-merged structured findings from PG (mirror of
 * `.papercusp/pending-issues.jsonl`, populated by the harness-fs-watcher).
 * Lines without an explicit `id` get the same `PENDING-<n>` synthesis the
 * watcher applies, so the row set matches what the disk reader produced.
 * Read-only from the UI's perspective — promotion goes through the curator.
 */
export async function readPendingIssues(
  project: ProjectEntry,
): Promise<Issue[]> {
  const { db } = (await import("@papercusp/db-org")).getOrgPg();
  const { generated } = await import("@papercusp/db-org");
  const { asc, eq } = await import("drizzle-orm");
  const hpi = generated.harnessPendingIssuesInHarnessShared;
  const rows = await db
    .select({ issue_id: hpi.issueId, payload: hpi.payload, ts: hpi.ts })
    .from(hpi)
    .where(eq(hpi.harnessSlug, project.slug))
    .orderBy(asc(hpi.ts));
  const out: Issue[] = [];
  for (const r of rows) {
    const p = (r.payload as Record<string, unknown>) ?? {};
    if (!p.title || !p.severity) continue;
    out.push({
      id: r.issue_id,
      title: String(p.title),
      severity: clampSeverity(p.severity),
      source: "validator",
      foundAt:
        (p.foundAt as string) ?? new Date(Number(r.ts) || 0).toISOString(),
      foundDuring: p.foundDuring as string | undefined,
      status: "open",
      repro: p.repro as string | undefined,
      evidence: p.evidence as string | undefined,
      suggestedFix: p.suggestedFix as string | undefined,
      codePointer: p.codePointer as string | undefined,
      attempts: 0,
      notes: [],
    });
  }
  return out;
}
