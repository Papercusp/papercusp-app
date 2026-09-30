import type { ManagedCategory, TimerClassification } from '@papercusp/scheduled-registry';

export interface ExternalScheduleDescriptor {
  readonly process: string;
  readonly name: string;
  readonly defaultIntervalMs: number;
  readonly source: string;
  readonly category: ManagedCategory;
  readonly classification: TimerClassification;
}

export interface SyncTriggeredScheduleDescriptor {
  readonly name: string;
  readonly cadence: string;
  readonly armed: boolean | null;
  readonly flag?: string;
  readonly source: string;
  readonly trigger?: string;
  readonly spends: 'llm' | 'none';
  readonly note: string;
}

export const EXTERNAL_SCHEDULES: Readonly<Record<string, ExternalScheduleDescriptor>>;
export const EXTERNAL_PROCESS_TIMERS: readonly ExternalScheduleDescriptor[];
export const SYNC_TRIGGERED_SCHEDULES: Readonly<Record<string, SyncTriggeredScheduleDescriptor>>;
export const SYNC_TRIGGERED_SWEEPS: readonly SyncTriggeredScheduleDescriptor[];
