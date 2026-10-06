export declare function isExactRadiusGlobalInput(rel: string): boolean;

export type ExactRadiusAdmission =
  | { admitted: true }
  | { admitted: false; reason: string; path?: string };

export declare function exactRadiusAdmission(input: {
  everyTaskNarrowable: boolean;
  affectedFileCount: number;
  changedPaths: readonly string[];
}): ExactRadiusAdmission;
