// Shared types for the structured Issues tracker.

export type IssueSeverity = 'critical' | 'major' | 'minor' | 'nit';
export type IssueSource = 'validator' | 'worker' | 'human';
export type IssueStatus = 'open' | 'acknowledged' | 'fixing' | 'closed' | 'wontfix' | 'passed';

export interface IssueNote {
  ts: string;
  by: string;
  text: string;
}

export interface Issue {
  id: string;
  title: string;
  severity: IssueSeverity;
  source: IssueSource;
  foundAt: string;
  foundDuring?: string;
  status: IssueStatus;
  repro?: string;
  evidence?: string;
  suggestedFix?: string;
  codePointer?: string;
  linkedFeatureId?: string;
  attempts: number;
  notes: IssueNote[];
}

export interface IssuesFile {
  issues: Issue[];
  nextId: number;
}
