import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });

await page.route('**/api/harness/projects/lite', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: [{ slug: 'e2e-nav-pot', path: '/tmp/e2e-nav-pot', hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false }] }) });
});

const res = await page.goto('http://127.0.0.1:34871/adv/?slug=e2e-nav-pot&scope=expanded', { waitUntil: 'domcontentloaded' });
console.log('STATUS', res?.status());
await page.waitForTimeout(10000);
const tablist = await page.getByRole('tablist', { name: 'Adv sections' }).count();
console.log('TABLIST_COUNT', tablist);
const advShellCount = await page.evaluate(() => document.querySelectorAll('[class*="pc-advshell"]').length);
console.log('ADVSHELL_ELS', advShellCount);
const errBoundary = await page.evaluate(() => document.body.innerText.includes('This view hit an error') || document.body.innerText.includes('Something went wrong'));
console.log('ERROR_BOUNDARY', errBoundary);
const url = page.url();
console.log('FINAL_URL', url);
const h1 = await page.evaluate(() => document.querySelector('h1')?.textContent ?? 'NO_H1');
console.log('H1', h1);
console.log('CONSOLE_ERRORS', JSON.stringify(errors, null, 2));
await browser.close();
