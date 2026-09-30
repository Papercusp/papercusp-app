export function shouldClearStaleBusyClass(isPending: boolean): boolean {
  return !isPending;
}

export function shouldHideIdleProgressBar(isPending: boolean): boolean {
  return !isPending;
}

export function shouldMaintainIdleProgress(isPending: boolean): boolean {
  return !isPending;
}

export function shouldSuppressNavigationProgress(origin: string): boolean {
  return origin === 'http://localhost:3070'
    || origin === 'http://127.0.0.1:3070'
    || origin === 'http://localhost:4173'
    || origin === 'http://127.0.0.1:4173';
}
