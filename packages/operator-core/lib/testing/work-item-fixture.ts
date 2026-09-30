/**
 * One canonical, schema-COMPLETE {@link WorkItem} fixture for tests.
 *
 * Why this is shared rather than copied: `WorkItem` is a wide exported interface,
 * and every required field it grows strands every literal that constructs one — in
 * files `test:affected` will not select, because the fixture's own diff never
 * touched them (WI-6867; EI-19374535041074908 catalogues the repeats). Two byte-
 * identical hand-rolled copies of this object already existed. Each additional copy
 * multiplies the cost of a legitimate field addition and makes it likelier that the
 * next author reaches for `as never`, which silences the strand instead of fixing it.
 *
 * Keep this returning a FULLY-populated `WorkItem`, never a `Partial`: the compile
 * error a new required field produces here is the whole point — it fires once, in
 * one place, instead of at some peer's green-checkpoint hours later.
 */
import type { WorkItem } from '../work-items';

export const workItemFixture = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'WI-1',
  kind: 'bug',
  family: 'issue',
  harness: 'papercup',
  title: 'test item',
  summary: '',
  state: 'open',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  goalId: null,
  parent: null,
  payload: null,
  origin: null,
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  ...over,
});
