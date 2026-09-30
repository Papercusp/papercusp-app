'use client';

import { useSyncExternalStore } from 'react';
import { applyTheme, getServerSnapshot, getSnapshot, subscribe } from './theme-runtime';

/** Read + set the active theme. Re-renders on change (this tab or another). */
export function useTheme(): { theme: string; setTheme: (id: string) => void } {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { theme, setTheme: applyTheme };
}
