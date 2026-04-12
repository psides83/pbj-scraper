import { readFile, writeFile } from 'node:fs/promises';

const p = '/Users/Payton/web-development/pbj-scraper/output/pbj-detailed.json';
const d = JSON.parse(await readFile(p, 'utf8'));

for (const listing of d.listings || []) {
  const fees = listing?.fields?.entryFees;
  if (!Array.isArray(fees)) continue;
  for (const fee of fees) {
    if (typeof fee?.fees === 'number') {
      fee.fees = `$${fee.fees}`;
    }
  }
}

await writeFile(p, JSON.stringify(d, null, 2));
console.log('restored');
