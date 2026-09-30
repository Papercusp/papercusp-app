export interface ButtonTitleTooltipFinding {
  line: number;
  snippet: string;
  key: string;
}

export function buttonTitleTooltipRe(): RegExp;
export function findButtonTitleTooltips(rawText: string): ButtonTitleTooltipFinding[];
