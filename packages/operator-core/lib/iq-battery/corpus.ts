import { z } from 'zod';
import crypto from 'crypto';
import type postgres from 'postgres';

export const TaskVariant = z.enum([
  'fix-injected-bug',
  'build-spec',
  'find-the-flaw',
  'answer-from-colony-memory',
]);

export type TaskVariant = z.infer<typeof TaskVariant>;

export const GroundTruthSchema = z.record(z.string(), z.unknown());

export const RubricSchema = z.object({
  dimensions: z.array(z.object({
    name: z.string(),
    description: z.string(),
    weight: z.number().min(0).max(1),
    scoring: z.enum(['binary', 'numeric', 'qualitative']),
  })),
});

export type Rubric = z.infer<typeof RubricSchema>;

export interface CorpusCase {
  id: string;
  variant: TaskVariant;
  title: string;
  prompt: string;
  groundTruth: Record<string, unknown>;
  rubric: Rubric;
  rotationIndex: number;
  createdAt: Date;
}

/**
 * A corpus seed — a {@link CorpusCase} minus the fields assigned at seed time
 * (`id` via generateStableCaseId, `rotationIndex`, `createdAt`). The seed
 * arrays below carry `satisfies CorpusSeedCase[]` so shape drift (a bad
 * rubric scoring value, a missing field) is a compile error while element
 * types stay narrowly inferred.
 */
export type CorpusSeedCase = Omit<CorpusCase, 'id' | 'rotationIndex' | 'createdAt'>;

// v1 IQ Battery Corpus seed data — 20 cases (5 per variant)

/**
 * `fix-injected-bug` cases are SELF-CONTAINED (EI-162 / audit P-014): the buggy
 * code ships INSIDE the prompt as a fenced snippet, and `groundTruth.bugLocation`
 * references that snippet (`snippet:<symbol>`), NEVER a repo path. There is no
 * bug-injection step — earlier seeds pointed groundTruth at fictional repo
 * symbols (e.g. `work-items.ts:rankItems`, which never existed), which made the
 * cases unwinnable-as-stated and sent bees hunting the real tree for bugs that
 * were not there. A case must be solvable from its own prompt alone.
 */
export const FixInjectedBugCases = [
  {
    variant: 'fix-injected-bug' as const,
    title: 'Off-by-one in work-item rank calculation',
    prompt: `A work-item ranking function is giving incorrect order. Ranked items should get dense, sequential ranks (0, 1, 2, …) while unranked (null-rank) items are left alone — but some rank values are skipped and the sequence starts at 1. Identify the bug in the code below and fix it.

\`\`\`ts
interface WorkItem { id: string; rank: number | null }

export function rankItems(items: WorkItem[]): WorkItem[] {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.rank === null) {
      continue; // unranked items keep null
    }
    item.rank = i + 1;
  }
  return items;
}
\`\`\``,
    groundTruth: {
      bugLocation: 'snippet:rankItems',
      bugDescription:
        'Rank is assigned from the overall loop index (i + 1), so every skipped null-rank item leaves a gap in the sequence, and ranks start at 1 instead of 0',
      expectedFix:
        'Track a separate counter incremented only when a rank is actually assigned (starting at 0), instead of reusing the loop index; null-rank items keep null',
    },
    rubric: {
      dimensions: [
        {
          name: 'Bug Detection',
          description: 'Correctly identified the location and nature of the bug',
          weight: 0.4,
          scoring: 'binary',
        },
        {
          name: 'Fix Quality',
          description: 'The proposed fix is correct and handles edge cases',
          weight: 0.4,
          scoring: 'binary',
        },
        {
          name: 'Explanation',
          description: 'Clear explanation of why the bug occurred',
          weight: 0.2,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'fix-injected-bug' as const,
    title: 'Race condition in fleet assignment',
    prompt: `Two agents can simultaneously claim the same work item, resulting in duplicate assignments. Find and fix the race condition in the claim function below.

\`\`\`ts
async function claimItem(sql: Sql, itemId: string, agentId: string): Promise<boolean> {
  const rows = await sql\`SELECT assignee FROM work_items WHERE id = \${itemId}\`;
  if (rows[0]?.assignee) {
    return false; // already claimed
  }
  await sql\`UPDATE work_items SET assignee = \${agentId} WHERE id = \${itemId}\`;
  return true;
}
\`\`\``,
    groundTruth: {
      bugLocation: 'snippet:claimItem',
      bugDescription:
        'Check-then-act across two statements without locking: two concurrent callers can both read assignee as empty, then both run the UPDATE — the second silently overwrites the first claim',
      expectedFix:
        'Make the claim atomic: a single conditional UPDATE (… SET assignee = $agent WHERE id = $id AND assignee IS NULL RETURNING …, claimed iff a row came back), or SELECT … FOR UPDATE inside one transaction',
    },
    rubric: {
      dimensions: [
        {
          name: 'Root Cause Analysis',
          description: 'Identified the concurrent access pattern causing the issue',
          weight: 0.5,
          scoring: 'binary',
        },
        {
          name: 'Fix Appropriateness',
          description: 'Chose the right concurrency control mechanism',
          weight: 0.4,
          scoring: 'binary',
        },
        {
          name: 'Documentation',
          description: 'Explained why the fix prevents the race condition',
          weight: 0.1,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'fix-injected-bug' as const,
    title: 'Memory leak in event listener subscription',
    prompt: `An inbox watcher is growing memory usage over time: listeners accumulate and are never cleaned up when agents unsubscribe. Find and fix the leak in the code below.

\`\`\`ts
import { EventEmitter } from 'node:events';

interface Msg { to: string; body: string }

class InboxWatcher {
  private emitter = new EventEmitter();

  publish(m: Msg): void {
    this.emitter.emit('message', m);
  }

  subscribe(agentId: string, onMessage: (m: Msg) => void): () => void {
    const handler = (m: Msg) => {
      if (m.to === agentId) onMessage(m);
    };
    this.emitter.on('message', handler);
    return () => {
      // cleanup
    };
  }
}
\`\`\``,
    groundTruth: {
      bugLocation: 'snippet:InboxWatcher.subscribe',
      bugDescription:
        'The unsubscribe function returned by subscribe() is an empty body — the message handler registered with emitter.on() is never removed, so every subscribe leaks a listener forever',
      expectedFix:
        "The returned cleanup must remove the exact handler it registered: this.emitter.off('message', handler) (or removeListener)",
    },
    rubric: {
      dimensions: [
        {
          name: 'Issue Localization',
          description: 'Found the exact file and function with the leak',
          weight: 0.35,
          scoring: 'binary',
        },
        {
          name: 'Root Cause',
          description: 'Explained the memory leak mechanism',
          weight: 0.35,
          scoring: 'binary',
        },
        {
          name: 'Solution Correctness',
          description: 'Proposed fix completely eliminates the leak',
          weight: 0.3,
          scoring: 'binary',
        },
      ],
    },
  },
  {
    variant: 'fix-injected-bug' as const,
    title: 'Incorrect timestamp comparison in deadline check',
    prompt: `Harness tasks are being marked as overdue when they should still be pending. The deadline checking logic below is wrong. Fix it.

\`\`\`ts
interface Task { id: string; deadline: string } // deadline is an ISO-8601 string

function isOverdue(task: Task, now: Date): boolean {
  return task.deadline < now;
}
\`\`\``,
    groundTruth: {
      bugLocation: 'snippet:isOverdue',
      bugDescription:
        'An ISO-8601 deadline STRING is compared directly against a Date OBJECT with <, so JavaScript coerces both to primitives and compares lexically/NaN-ily — the result does not reflect chronological order',
      expectedFix:
        'Compare like with like: new Date(task.deadline).getTime() < now.getTime() (parse the ISO string to a Date / epoch millis before comparing)',
    },
    rubric: {
      dimensions: [
        {
          name: 'Type Issue Recognition',
          description: 'Identified the type mismatch causing incorrect comparison',
          weight: 0.5,
          scoring: 'binary',
        },
        {
          name: 'Fix Correctness',
          description: 'Solution handles ISO string parsing correctly',
          weight: 0.4,
          scoring: 'binary',
        },
        {
          name: 'Test Coverage',
          description: 'Suggested a test case to prevent regression',
          weight: 0.1,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'fix-injected-bug' as const,
    title: 'SQL injection vulnerability in feature search',
    prompt: `The feature search function below is vulnerable to SQL injection — a user can craft a search query to read rows they should never see. Find and fix the vulnerability.

\`\`\`ts
async function executeSearch(sql: Sql, userQuery: string) {
  return sql.unsafe(
    "SELECT id, title FROM features WHERE title ILIKE '%" + userQuery + "%' LIMIT 50",
  );
}
\`\`\``,
    groundTruth: {
      bugLocation: 'snippet:executeSearch',
      bugDescription:
        "User input is concatenated directly into the SQL string handed to sql.unsafe() — a query like `%' OR '1'='1` (or a UNION SELECT) escapes the ILIKE literal and rewrites the statement",
      expectedFix:
        'Use a parameterized query (tagged-template bind or placeholders), e.g. sql`SELECT id, title FROM features WHERE title ILIKE ${"%" + userQuery + "%"} LIMIT 50` — never concatenate user input into SQL text',
    },
    rubric: {
      dimensions: [
        {
          name: 'Vulnerability Detection',
          description: 'Correctly identified the SQL injection point',
          weight: 0.45,
          scoring: 'binary',
        },
        {
          name: 'Fix Quality',
          description: 'Proposed parameterized solution is correct',
          weight: 0.45,
          scoring: 'binary',
        },
        {
          name: 'Security Awareness',
          description: 'Explained the security impact and best practices',
          weight: 0.1,
          scoring: 'qualitative',
        },
      ],
    },
  },
] satisfies CorpusSeedCase[];

export const BuildSpecCases = [
  {
    variant: 'build-spec' as const,
    title: 'Spreadsheet cell editing feature',
    prompt: `Design a complete feature spec for: Users should be able to click on a spreadsheet cell and edit its value inline, with auto-save after 500ms of inactivity.`,
    groundTruth: {
      requiredSections: [
        'Overview',
        'User Stories',
        'Acceptance Criteria',
        'Technical Details',
        'Edge Cases',
        'Performance Constraints',
      ],
      expectedCriteria: [
        'Cell click enters edit mode',
        'Auto-save triggers 500ms after last keystroke',
        'Escape cancels edit',
        'Enter commits and moves to next row',
        'Concurrent edits show last-write-wins conflict resolution',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Completeness',
          description: 'Spec covers all required sections and details',
          weight: 0.4,
          scoring: 'numeric',
        },
        {
          name: 'Clarity',
          description: 'Requirements are unambiguous and testable',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Realism',
          description: 'Spec considers implementation complexity and edge cases',
          weight: 0.25,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'build-spec' as const,
    title: 'Agent fleet resource limiting',
    prompt: `Design a spec for: The fleet governor should enforce per-workspace resource limits (max 10 concurrent agents, 1000 tokens/min global rate limit).`,
    groundTruth: {
      requiredSections: [
        'Goals',
        'Resource Limits Definition',
        'Enforcement Mechanism',
        'Behavior When Limit Exceeded',
        'Configuration',
        'Metrics',
      ],
      expectedCriteria: [
        'Concurrency limit prevents spawning beyond max',
        'Rate limit is measured per minute window',
        'Excess requests are queued or rejected (decision needed)',
        'Limits are per-workspace, not global',
        'Operators can view current utilization',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Scope Definition',
          description: 'Clearly defines what is and is not covered by limits',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Technical Feasibility',
          description: 'Spec is implementable with current infrastructure',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Detail Level',
          description: 'Sufficient detail for eng to build without further clarification',
          weight: 0.3,
          scoring: 'numeric',
        },
      ],
    },
  },
  {
    variant: 'build-spec' as const,
    title: 'Harness escalation workflow',
    prompt: `Build a spec for: When a harness issue is escalated, the system should notify the harness owner and assign it to a human reviewer. The reviewer can re-assign to an agent or mark as resolved.`,
    groundTruth: {
      requiredSections: [
        'Trigger Conditions',
        'Notification Flow',
        'Assignment Logic',
        'Reviewer Actions',
        'Audit Trail',
      ],
      expectedCriteria: [
        'Escalation is triggered by agent or policy',
        'Owner receives notification within 5 seconds',
        'Issue is locked from agent re-assignment during review',
        'Reviewer can add notes before re-assigning',
        'All actions are logged',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Process Design',
          description: 'Workflow is logically sound and complete',
          weight: 0.4,
          scoring: 'qualitative',
        },
        {
          name: 'User Experience',
          description: 'Considers both owner and reviewer needs',
          weight: 0.3,
          scoring: 'qualitative',
        },
        {
          name: 'System Impact',
          description: 'Accounts for notification load, locking, and atomicity',
          weight: 0.3,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'build-spec' as const,
    title: 'Feature rollback policy',
    prompt: `Specify how the system should handle feature rollback: When a new feature causes regressions, how is it detected and reverted? Who approves rollback?`,
    groundTruth: {
      requiredSections: [
        'Regression Detection Criteria',
        'Approval Process',
        'Rollback Procedure',
        'Rollback Scope',
        'Post-Rollback Actions',
      ],
      expectedCriteria: [
        'Regression is detected via metrics degradation (e.g., 20% failure rate increase)',
        'Rollback requires 2-person approval',
        'Rollback resets DB to last-good state',
        'Rolled-back feature is marked as blocked for 24 hours',
        'Incident report is auto-generated',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Safety',
          description: 'Spec prevents accidental rollback and ensures data safety',
          weight: 0.4,
          scoring: 'qualitative',
        },
        {
          name: 'Automation',
          description: 'Defines what is automated vs. manual',
          weight: 0.3,
          scoring: 'qualitative',
        },
        {
          name: 'Accountability',
          description: 'Clear audit trail of who approved what and when',
          weight: 0.3,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'build-spec' as const,
    title: 'Agent memory persistence',
    prompt: `Spec a feature for: Agents should be able to persist and recall facts from previous runs (e.g., workspace structure, common patterns, failure modes).`,
    groundTruth: {
      requiredSections: [
        'Memory Types',
        'Persistence Strategy',
        'Recall Mechanism',
        'Memory Lifecycle',
        'Isolation and Privacy',
      ],
      expectedCriteria: [
        'Facts persist across runs in agent-scoped storage',
        'Memory is queried by semantic similarity',
        'Memory older than 30 days is archived',
        'Memory is private to the agent; not shared across workspaces',
        'Operators can audit memory contents',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Utility',
          description: 'Memory mechanism actually helps agent performance',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Practicality',
          description: 'Spec avoids over-engineering; implementable in 1-2 sprints',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Governance',
          description: 'Privacy and audit controls are clear',
          weight: 0.3,
          scoring: 'qualitative',
        },
      ],
    },
  },
] satisfies CorpusSeedCase[];

export const FindTheFlawCases = [
  {
    variant: 'find-the-flaw' as const,
    title: 'Harness blueprint is too rigid',
    prompt: `Review this harness blueprint design: All harnesses use a fixed spine (scoper → worker → validator) with 5-role slots. What architectural flaws do you see?`,
    groundTruth: {
      flaws: [
        {
          flaw: 'No customization for different task types (e.g., research is different from coding)',
          severity: 'high',
          impact: 'Forced fit leads to bad role assignments',
        },
        {
          flaw: 'Validator cannot spawn sub-harnesses (no recursion)',
          severity: 'high',
          impact: 'Complex tasks cannot decompose',
        },
        {
          flaw: 'No early-exit for simple tasks (5 roles is overkill)',
          severity: 'medium',
          impact: 'Unnecessary latency and cost',
        },
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Flaw Coverage',
          description: 'Identified at least 2 major architectural flaws',
          weight: 0.4,
          scoring: 'numeric',
        },
        {
          name: 'Depth of Analysis',
          description: 'Explained impact and root cause of each flaw',
          weight: 0.4,
          scoring: 'qualitative',
        },
        {
          name: 'Constructiveness',
          description: 'Suggested directions for improvement',
          weight: 0.2,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'find-the-flaw' as const,
    title: 'IQ battery corpus design flaws',
    prompt: `You are designing an IQ battery for evaluating agents. The plan is to use 4 task variants, 5 instances per variant (20 total), with round-robin rotation. What design flaws should you flag?`,
    groundTruth: {
      flaws: [
        {
          flaw: 'Small corpus (20 cases) will memorize fast; no longitudinal signal',
          severity: 'high',
          impact: 'Cannot detect overfitting or skill progression',
        },
        {
          flaw: 'No task difficulty scaling; all cases treated equally',
          severity: 'medium',
          impact: 'Cannot distinguish between basic and advanced capabilities',
        },
        {
          flaw: 'Round-robin rotation does not balance variance in task outcome',
          severity: 'medium',
          impact: 'Some task types may artificially inflate scores',
        },
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Issue Identification',
          description: 'Found at least 2 significant design flaws',
          weight: 0.5,
          scoring: 'numeric',
        },
        {
          name: 'Technical Reasoning',
          description: 'Explained why each flaw is problematic',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Feasibility of Fixes',
          description: 'Proposed fixes are realistic given time/resource constraints',
          weight: 0.15,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'find-the-flaw' as const,
    title: 'Concurrency control in orchestrator loop',
    prompt: `The orchestrator runs in a loop, dispatching features from the queue. Each feature is assigned to an agent and dispatched. What concurrency flaws exist?`,
    groundTruth: {
      flaws: [
        {
          flaw: 'Same feature can be dispatched to multiple agents if the loop runs in parallel',
          severity: 'critical',
          impact: 'Duplicate work, inconsistent state',
        },
        {
          flaw: 'No deadlock prevention if agent A waits for agent B and vice versa',
          severity: 'high',
          impact: 'System can hang indefinitely',
        },
        {
          flaw: 'Feature status updates are not atomic; multiple agents can see inconsistent state',
          severity: 'high',
          impact: 'Lost updates, incorrect dispatch decisions',
        },
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Severity Ranking',
          description: 'Correctly ranked flaws by impact (critical > high > medium)',
          weight: 0.35,
          scoring: 'numeric',
        },
        {
          name: 'Root Cause Analysis',
          description: 'Explained the concurrency scenario that triggers each flaw',
          weight: 0.4,
          scoring: 'qualitative',
        },
        {
          name: 'Mitigation Strategy',
          description: 'Proposed fixes (e.g., locking, versioning, consensus)',
          weight: 0.25,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'find-the-flaw' as const,
    title: 'Metrics collection is slow',
    prompt: `The metrics collection job runs every minute, joining metrics from 5 tables, computing 50+ aggregations. It takes 15s per run, blocking other operations. What is wrong?`,
    groundTruth: {
      flaws: [
        {
          flaw: 'Metrics are computed from raw data on every run; no materialization',
          severity: 'high',
          impact: 'O(n) scan of 5 tables every minute',
        },
        {
          flaw: 'No indexes on join keys; table scans are not optimized',
          severity: 'high',
          impact: 'Cartesian product explodes query cost',
        },
        {
          flaw: 'Metrics blocking other operations; should be async',
          severity: 'medium',
          impact: 'Latency spikes every minute',
        },
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Performance Root Cause',
          description: 'Identified the actual perf bottleneck',
          weight: 0.45,
          scoring: 'numeric',
        },
        {
          name: 'Solution Appropriateness',
          description: 'Proposed solution addresses root cause, not symptoms',
          weight: 0.4,
          scoring: 'qualitative',
        },
        {
          name: 'Trade-off Awareness',
          description: 'Acknowledged trade-offs (e.g., staleness vs. latency)',
          weight: 0.15,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'find-the-flaw' as const,
    title: 'Agent authorization model',
    prompt: `The current auth model: agents have a token, token is used for all API calls. Agents can read/write any workspace data. What security flaws do you see?`,
    groundTruth: {
      flaws: [
        {
          flaw: 'No scope isolation; agent token grants access to all workspaces',
          severity: 'critical',
          impact: 'Data leakage between customers',
        },
        {
          flaw: 'No per-action authorization; all API calls have same privileges',
          severity: 'high',
          impact: 'Agent can delete critical data it should only read',
        },
        {
          flaw: 'Token never expires; compromised token is valid forever',
          severity: 'high',
          impact: 'Long-term breach if token is leaked',
        },
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Security Awareness',
          description: 'Identified critical and high-severity issues',
          weight: 0.4,
          scoring: 'numeric',
        },
        {
          name: 'Flaw Clarity',
          description: 'Explained why each issue is a security problem',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Fix Direction',
          description: 'Proposed direction toward least-privilege model',
          weight: 0.25,
          scoring: 'qualitative',
        },
      ],
    },
  },
] satisfies CorpusSeedCase[];

export const AnswerFromColonyMemoryCases = [
  {
    variant: 'answer-from-colony-memory' as const,
    title: 'What is the naming convention for plan files?',
    prompt: `You are given access to the workspace memory and documentation. Answer: What is the naming convention for plan files in the Papercusp system?`,
    groundTruth: {
      expectedAnswers: [
        'Plan files are in apps/operator/docs/plans/ and named {slug}-{YYYY-MM-DD}.md',
        'Slug is a kebab-case descriptor of the plan',
        'Date is the creation date of the plan',
      ],
      sources: [
        'CLAUDE.md',
        'apps/operator/docs/plans/',
        'agent-insights documentation',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Correctness',
          description: 'Answer matches the expected answers',
          weight: 0.5,
          scoring: 'numeric',
        },
        {
          name: 'Source Citation',
          description: 'Cited correct source documents',
          weight: 0.35,
          scoring: 'numeric',
        },
        {
          name: 'Completeness',
          description: 'Mentioned both slug and date format',
          weight: 0.15,
          scoring: 'numeric',
        },
      ],
    },
  },
  {
    variant: 'answer-from-colony-memory' as const,
    title: 'What are the four canonical testing frameworks?',
    prompt: `From the CLAUDE.md documentation, list the four canonical testing frameworks used in this project.`,
    groundTruth: {
      expectedAnswers: [
        'Vitest (unit/integration/E2E)',
        'Playwright (browser E2E)',
        'Cargo (Rust tests)',
        'LLM scenarios (judge-scored prompts)',
      ],
      sources: [
        'CLAUDE.md section "Where new tests go"',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Answer Accuracy',
          description: 'All four frameworks correctly identified',
          weight: 0.6,
          scoring: 'numeric',
        },
        {
          name: 'Source Awareness',
          description: 'Cited CLAUDE.md as the source',
          weight: 0.4,
          scoring: 'numeric',
        },
      ],
    },
  },
  {
    variant: 'answer-from-colony-memory' as const,
    title: 'How should new durable state be stored?',
    prompt: `What does the storage policy say about where new durable state should be stored by default?`,
    groundTruth: {
      expectedAnswers: [
        'New durable state goes in Postgres by default',
        'Only use files if there is a specific reason it must be a file',
        'Default helpers are in operator-state-pg.ts',
      ],
      sources: [
        'CLAUDE.md section "Storage policy"',
        'apps/operator-docs/src/content/docs/system/storage-policy.mdx',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Policy Knowledge',
          description: 'Correctly stated the storage default',
          weight: 0.5,
          scoring: 'numeric',
        },
        {
          name: 'Reasoning',
          description: 'Explained why Postgres is the default (file drift problem)',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Source Accuracy',
          description: 'Cited the right docs',
          weight: 0.15,
          scoring: 'numeric',
        },
      ],
    },
  },
  {
    variant: 'answer-from-colony-memory' as const,
    title: 'What is the purpose of the gym blueprint?',
    prompt: `Explain what the gym blueprint is and why it exists. What is its role in the harness orchestration system?`,
    groundTruth: {
      expectedAnswers: [
        'The gym is a third built-in harness blueprint (alongside coding and research)',
        'Its work is to improve another harness by running evals and proposing prompt changes',
        'It enables self-improving harnesses through eval-driven optimization',
        'The gym itself is gym-able (recursive)',
      ],
      sources: [
        'apps/operator-docs/src/content/docs/agent-insights/gym-as-blueprint.mdx',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Concept Understanding',
          description: 'Correctly explained the gym\'s purpose and role',
          weight: 0.5,
          scoring: 'qualitative',
        },
        {
          name: 'Detail Accuracy',
          description: 'Mentioned key features (eval-driven, self-improving, recursive)',
          weight: 0.4,
          scoring: 'numeric',
        },
        {
          name: 'Context',
          description: 'Explained relationship to other blueprints',
          weight: 0.1,
          scoring: 'qualitative',
        },
      ],
    },
  },
  {
    variant: 'answer-from-colony-memory' as const,
    title: 'What is the difference between staging and main branches?',
    prompt: `What is the git branch model used in this project? Describe the difference between staging and main, and how changes flow between them.`,
    groundTruth: {
      expectedAnswers: [
        'Staging is the integration branch (agent firehose)',
        'Main is the green branch (tested, auto-deployed)',
        'Git-sync commits and pushes to staging; developers never push directly',
        'Green-checkpoint tests staging and fast-forwards main only when green',
        'Release-trigger auto-deploys green main to :3070',
      ],
      sources: [
        'CLAUDE.md section "Branch discipline"',
        'CLAUDE.md section "Commit discipline"',
      ],
    },
    rubric: {
      dimensions: [
        {
          name: 'Model Comprehension',
          description: 'Correctly described both branches and their roles',
          weight: 0.5,
          scoring: 'qualitative',
        },
        {
          name: 'Flow Understanding',
          description: 'Explained the commit and test flow accurately',
          weight: 0.35,
          scoring: 'qualitative',
        },
        {
          name: 'Key Details',
          description: 'Mentioned automation tools (git-sync, green-checkpoint)',
          weight: 0.15,
          scoring: 'numeric',
        },
      ],
    },
  },
] satisfies CorpusSeedCase[];

export const AllCases = [
  ...FixInjectedBugCases,
  ...BuildSpecCases,
  ...FindTheFlawCases,
  ...AnswerFromColonyMemoryCases,
];

export function getNextCase(variant: TaskVariant): CorpusCase | null {
  const variantCases = AllCases.filter((c) => c.variant === variant);
  if (!variantCases.length) return null;
  return variantCases[0] as unknown as CorpusCase;
}

export function getCasesByVariant(variant: TaskVariant): CorpusCase[] {
  return AllCases.filter((c) => c.variant === variant) as unknown as CorpusCase[];
}

function generateStableCaseId(variant: string, title: string, index: number): string {
  const hash = crypto.createHash('sha256').update(`${variant}|${title}|${index}`).digest('hex');
  const uuidBytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    uuidBytes[i] = parseInt(hash.substr(i * 2, 2), 16);
  }
  return (
    uuidBytes.toString('hex', 0, 4) +
    '-' +
    uuidBytes.toString('hex', 4, 6) +
    '-' +
    uuidBytes.toString('hex', 6, 8) +
    '-' +
    uuidBytes.toString('hex', 8, 10) +
    '-' +
    uuidBytes.toString('hex', 10, 16)
  );
}

export async function seedCorpus(sql: postgres.Sql): Promise<void> {
  const now = new Date().toISOString();
  const variantCounts: Record<string, number> = {};

  for (const caseData of AllCases) {
    variantCounts[caseData.variant] = (variantCounts[caseData.variant] ?? 0) + 1;
    const index = variantCounts[caseData.variant] - 1;
    const caseId = generateStableCaseId(caseData.variant, caseData.title, index);

    await sql`
      INSERT INTO iq_battery_cases
        (id, variant, title, prompt, ground_truth, rubric, rotation_index, created_at, updated_at)
      VALUES
        (
          ${caseId},
          ${caseData.variant},
          ${caseData.title},
          ${caseData.prompt},
          ${JSON.stringify(caseData.groundTruth)}::text::jsonb,
          ${JSON.stringify(caseData.rubric)}::text::jsonb,
          ${index},
          ${now},
          ${now}
        )
      ON CONFLICT (id) DO UPDATE SET
        prompt = EXCLUDED.prompt,
        ground_truth = EXCLUDED.ground_truth,
        rubric = EXCLUDED.rubric,
        rotation_index = EXCLUDED.rotation_index,
        updated_at = ${now}
    `;
  }
}
