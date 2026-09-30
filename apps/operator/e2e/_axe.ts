import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Run an axe-core accessibility scan against the current page and assert
 * zero `serious` or `critical` violations (testing-spec §1.4).
 *
 * Pass `disableRules` for known-noisy rules tied to upstream libs we can't
 * fix (Monaco, Vditor, etc.) — keep the list short and review periodically.
 */
export async function expectNoA11yViolations(
  page: Page,
  opts: { disableRules?: string[] } = {},
): Promise<void> {
  const builder = new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);

  if (opts.disableRules?.length) builder.disableRules(opts.disableRules);

  const { violations } = await builder.analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');

  if (blocking.length > 0) {
    const summary = blocking
      .map((v) => `  - [${v.impact}] ${v.id} (${v.nodes.length} nodes): ${v.help}`)
      .join('\n');
    expect(blocking, `axe-core blocking violations:\n${summary}`).toEqual([]);
  }
}
