import type { ComponentType } from 'react';

export type PanelComponentProps = {
  panelId: string;
  panelType: string;
  params: Record<string, unknown>;
  api: {
    setParams: (next: Record<string, unknown>) => void;
    setTitle: (title: string) => void;
    close: () => void;
  };
};

export type PanelComponent = ComponentType<PanelComponentProps>;

export type PanelMetadata = {
  title?: string;
  keepAlive?: boolean;
  defaultGroup?: string;
};

export type RegistryEntry = {
  type: string;
  component: PanelComponent;
  meta: PanelMetadata;
};

type RegistryListener = () => void;

export class PanelRegistry {
  private map = new Map<string, RegistryEntry>();
  private listeners = new Set<RegistryListener>();

  register(type: string, component: PanelComponent, meta: PanelMetadata = {}): void {
    this.map.set(type, { type, component, meta });
    this.notify();
  }

  unregister(type: string): boolean {
    const ok = this.map.delete(type);
    if (ok) this.notify();
    return ok;
  }

  get(type: string): RegistryEntry | undefined {
    return this.map.get(type);
  }

  has(type: string): boolean {
    return this.map.has(type);
  }

  list(): string[] {
    return Array.from(this.map.keys()).sort();
  }

  subscribe(fn: RegistryListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  _reset(): void {
    this.map.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[panel-registry] listener threw:', err);
      }
    }
  }
}

export function createPanelRegistry(): PanelRegistry {
  return new PanelRegistry();
}

export const panelRegistry = createPanelRegistry();
