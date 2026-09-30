import type { ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';

export default function PiLayout({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
      {children}
    </Tooltip.Provider>
  );
}
