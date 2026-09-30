/**
 * Minimal type surface for @novnc/novnc 1.7 (no bundled or @types typings).
 * The package's exports map exposes exactly one module — core/rfb.js — as the
 * bare specifier. API per node_modules/@novnc/novnc/docs/API.md.
 */
declare module '@novnc/novnc' {
  export interface RFBOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    focusOnClick: boolean;
    readonly capabilities: { power?: boolean };
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    blur(): void;
    focus(): void;
    clipboardPasteFrom(text: string): void;
  }
}
