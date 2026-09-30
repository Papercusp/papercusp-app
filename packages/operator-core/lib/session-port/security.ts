import { redactSensitiveText } from '../sensitive-text';

export const SESSION_PORT_FRAME_OPEN = '<PAPERCUSP_SESSION_PORT_DATA>';
export const SESSION_PORT_FRAME_CLOSE = '</PAPERCUSP_SESSION_PORT_DATA>';

export interface SanitizedText {
  text: string;
  redactions: number;
  controlBytesRemoved: number;
  delimiterEscapes: number;
}

const countRedactionMarkers = (text: string): number => text.split('[redacted]').length - 1;

/** Redact before a byte can enter an artifact or summarizer request, strip
 * terminal controls, and neutralize our own framing delimiters. */
export function sanitizePortableText(input: unknown): SanitizedText {
  let text = String(input ?? '');
  const beforeControls = text.length;
  text = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const controlBytesRemoved = beforeControls - text.length;
  const existingRedactions = countRedactionMarkers(text);
  text = redactSensitiveText(text);
  const redactions = Math.max(0, countRedactionMarkers(text) - existingRedactions);
  let delimiterEscapes = 0;
  for (const delimiter of [SESSION_PORT_FRAME_OPEN, SESSION_PORT_FRAME_CLOSE]) {
    text = text.split(delimiter).join(delimiter.replace('<', '&lt;'));
    delimiterEscapes += String(input ?? '').split(delimiter).length - 1;
  }
  return { text, redactions, controlBytesRemoved, delimiterEscapes };
}
