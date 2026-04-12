import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://pbj.prorodeo.org/longlistings', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(8000);

const data = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cards = Array.from(document.querySelectorAll('div.mud-paper.mud-elevation-1.mud-card.h-full')).slice(0, 20);
  return cards.map((card, i) => ({
    i: i + 1,
    header: clean(card.querySelector('.mud-card-header')?.textContent || ''),
    summary: clean(card.textContent || '').slice(0, 140)
  }));
});

console.log(JSON.stringify(data, null, 2));
await browser.close();
