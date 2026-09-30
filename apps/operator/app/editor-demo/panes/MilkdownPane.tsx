'use client';
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';
import { useEffect, useRef } from 'react';

export default function MilkdownPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const initial = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!ref.current) return;
    let crepe: Crepe | null = null;
    let cancelled = false;
    (async () => {
      crepe = new Crepe({ root: ref.current!, defaultValue: initial.current });
      await crepe.create();
      if (cancelled) { crepe.destroy(); return; }
      crepe.on(listener => {
        listener.markdownUpdated((_ctx, md) => onChangeRef.current(md));
      });
    })();
    return () => { cancelled = true; crepe?.destroy(); };
  }, []);

  return <div ref={ref} style={{ height: '100%', overflow: 'auto', padding: 16 }} />;
}
