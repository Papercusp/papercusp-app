export function inspectHostDebuggerCapture(stdout: string, debuggerTerminal: {
  eof: boolean; exitCode: number | null; signal: string | null;
}): {
  processId: number;
  source: 'gdb-events';
  exitCode: number | null;
  signal: string | null;
  signalDelivered: true;
  debuggerPipeEof: true;
  hostBacktraceCaptured: boolean;
  embeddingModelInferencePerformed: false;
};

export function inspectAllocatorDetectorCapture(stdout: string, stderr: string, terminal: {
  processId: number; eof: boolean; captureStartedBeforeExec: boolean;
  exitCode: number | null; signal: string | null;
}, expected: {
  fault: 'clean' | 'tail-overwrite';
  binding: { path: string; bytes: number; sha256: string };
  debugAllocator: { path: string; bytes: number; sha256: string };
  serializedAdmissionContext: string | null;
}): {
  processId: number; source: 'native-allocator-control'; fault: 'clean' | 'tail-overwrite';
  exitCode: number | null; signal: string | null; pipeEof: true; debugAllocatorMapped: true;
  detectorTriggered: boolean; requestedBytes: 64;
  embeddingModelInferencePerformed: false; heapCorruptionRootCauseConfirmed: false;
};

type NativePin = { path: string; bytes: number; sha256: string };
export function inspectNativeOwnershipCapture(stdout: string, debuggerTerminal: {
  eof: boolean; exitCode: number | null; signal: string | null;
}, expected: { binding: NativePin; symbols: Record<string, string>; relativeAddresses: Record<string, number> }): {
  processId: number; source: 'native-ownership-calls'; exitCode: number | null; signal: string | null;
  calls: Array<{ operation: string; nativeThreadId: number; symbol: string; programCounter: string; relativeAddress: number;
    enteredAt: number; returnedAt: number | null; unwoundAt: number | null }>;
  missingOperations: string[]; completeOwnershipBoundariesObserved: boolean;
  initializerNativeThreadId: number; heapCorruptionRootCauseConfirmed: false; scope: string;
};
export function inspectNativeLifecycleCapture(stderr: string, terminal: {
  processId: number; eof: boolean; captureStartedBeforeExec: boolean;
  exitCode: number | null; signal: string | null;
}, expected: {
  source: NativePin; node: NativePin; ortEntry: NativePin;
  configuration: { device: 'cpu' | 'cuda'; outcome: 'success' | 'shape-error';
    release: 'dispose' | 'environment'; parentLogLevel: 'warning' | 'info' | null;
    terminal: 'settled' | 'uncaught' | 'exit-code' | 'abort-control' };
  serializedAdmissionContext: string | null;
}): {
  processId: number; source: 'native-lifecycle-boundaries'; pipeEof: true;
  exitCode: number | null; signal: string | null; completeLifecycleObserved: boolean;
  threads: Array<{ threadId: number; completedOperations: string[]; failedOperations: string[];
    pendingOperation: string | null; lastBoundary: { operation: string; boundary: string } | null }>;
  embeddingModelInferencePerformed: false; heapCorruptionRootCauseConfirmed: false; scope: string;
};
