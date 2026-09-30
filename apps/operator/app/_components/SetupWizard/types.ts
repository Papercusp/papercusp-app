export type StepStatus = 'ok' | 'needs-attention' | 'unknown';

export interface StepDef {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly required?: boolean;
  readonly platforms?: ReadonlyArray<'mac' | 'linux' | 'windows'>;
}


