import { readFile, writeFile } from 'node:fs/promises';

const path = '/Users/Payton/web-development/pbj-scraper/output/pbj-detailed.json';
const data = JSON.parse(await readFile(path, 'utf8'));

for (const listing of data.listings || []) {
  const entryFees = listing?.fields?.entryFees;
  if (!Array.isArray(entryFees)) continue;
  for (const fee of entryFees) {
    if (typeof fee?.fees !== 'string') continue;
    const match = fee.fees.match(/^\$([\d,]+(?:\.\d+)?)$/);
    if (match) {
      fee.fees = Number(match[1].replace(/,/g, ''));
    }
  }
}

await writeFile(path, JSON.stringify(data, null, 2));
console.log('converted');
