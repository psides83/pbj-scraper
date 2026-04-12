import { chromium } from 'playwright';

const indices = [1, 10, 22, 23, 24, 30, 50, 80, 120, 170];
const sel = 'div.mud-paper.mud-elevation-1.mud-card.h-full';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('https://pbj.prorodeo.org/longlistings', { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForTimeout(9000);

const results = [];
for (const idx1 of indices) {
  const i = idx1 - 1;
  const card = p.locator(sel).nth(i);
  const summary = ((await card.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  let opened = false;
  let err = null;
  try {
    await card.scrollIntoViewIfNeeded();
    await card.click({ force: true, timeout: 10000 });
    await p.waitForSelector('[role="dialog"] .mud-dialog-content', { timeout: 12000 });
    opened = true;
  } catch (e) {
    err = String(e.message || e).split('\n')[0];
  }
  if (opened) {
    await p.locator('button[aria-label="Close"]').click({ timeout: 10000 }).catch(() => {});
    await p.waitForSelector('[role="dialog"] .mud-dialog-content', { state: 'detached', timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(300);
  }
  results.push({ index: idx1, opened, err, summary });
}

console.log(JSON.stringify(results, null, 2));
await b.close();
