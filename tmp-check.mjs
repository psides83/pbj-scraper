import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('https://pbj.prorodeo.org/longlistings', { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForTimeout(9000);

const sel = 'div.mud-paper.mud-elevation-1.mud-card.h-full';
const count0 = await p.locator(sel).count();
const vis0 = await p.locator(`${sel}:visible`).count();

await p.locator(sel).first().click({ force: true });
await p.waitForSelector('[role="dialog"] .mud-dialog-content', { timeout: 15000 });
await p.locator('button[aria-label="Close"]').click({ timeout: 10000 });
await p.waitForTimeout(1200);

const count1 = await p.locator(sel).count();
const vis1 = await p.locator(`${sel}:visible`).count();

console.log(JSON.stringify({ count0, vis0, count1, vis1 }, null, 2));
await b.close();
