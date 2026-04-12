import { readFile, writeFile } from 'node:fs/promises';

const FILE = '/Users/Payton/web-development/pbj-scraper/output/pbj-detailed.json';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

const pad = (n) => String(n).padStart(2, '0');

function toIsoLocal(year, month, day, hour24, minute = 0, second = 0) {
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour24)}:${pad(minute)}:${pad(second)}`;
}

function to24h(hour12, ampm) {
  let h = Number(hour12);
  const upper = (ampm || '').toUpperCase();
  if (upper === 'AM' && h === 12) h = 0;
  if (upper === 'PM' && h !== 12) h += 12;
  return h;
}

function yearFromPublishDate(publishDate) {
  const m = String(publishDate || '').match(/(\d{4})/);
  return m ? Number(m[1]) : new Date().getFullYear();
}

function parseMonthDayTime(text, year) {
  const m = String(text || '').match(/\b([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const hour24 = to24h(m[3], m[5]);
  const minute = Number(m[4]);
  return toIsoLocal(year, month, day, hour24, minute, 0);
}

function parseUsDateTime(text) {
  const m = String(text || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  const hour24 = to24h(m[4], m[7]);
  const minute = Number(m[5]);
  const second = Number(m[6] || 0);
  return toIsoLocal(year, month, day, hour24, minute, second);
}

function parseEventDatesRange(eventDates, year) {
  const text = String(eventDates || '').trim();
  if (!text) return null;

  let m = text.match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    return {
      startDate: `${year}-${pad(month)}-${pad(Number(m[2]))}`,
      endDate: `${year}-${pad(month)}-${pad(Number(m[3]))}`
    };
  }

  m = text.match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)\s+(\d{1,2})$/);
  if (m) {
    const month1 = MONTHS[m[1].toLowerCase()];
    const month2 = MONTHS[m[3].toLowerCase()];
    if (!month1 || !month2) return null;
    return {
      startDate: `${year}-${pad(month1)}-${pad(Number(m[2]))}`,
      endDate: `${year}-${pad(month2)}-${pad(Number(m[4]))}`
    };
  }

  return null;
}

function parsePerfs(perfsRaw, year) {
  const raw = String(perfsRaw || '').trim();
  if (!raw) return null;
  const countMatch = raw.match(/^(\d+)\s+Perfs?:/i);
  const perfsCount = countMatch ? Number(countMatch[1]) : null;
  const listText = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
  const parts = listText.split(';').map((x) => x.trim()).filter(Boolean);
  const perfDates = parts.map((part) => parseMonthDayTime(part, year)).filter(Boolean);
  return {
    perfsCount,
    perfDates
  };
}

function parseEvents(eventsRaw) {
  const text = String(eventsRaw || '').trim();
  if (!text) return [];
  const events = [];
  const regex = /([^@]+?)@\s*\$?([\d,]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const group = match[1].replace(/\s+/g, ' ').trim();
    const addedMoney = Number(String(match[2]).replace(/,/g, ''));
    const eventCodes = group
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);

    for (const code of eventCodes) {
      events.push({ event: code, addedMoney });
    }
  }
  return events;
}

function parseEntryFees(rawFees) {
  const text = String(rawFees || '').trim();
  if (!text) return [];
  return text
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^([A-Z-]+)\s*-\s*(.+)$/i);
      if (!m) return { event: null, fees: entry };
      return { event: m[1], fees: m[2].trim() };
    });
}

const raw = await readFile(FILE, 'utf8');
const data = JSON.parse(raw);

for (const listing of data.listings || []) {
  const src = listing.fields || {};
  const year = yearFromPublishDate(listing.publishDate);

  const perfs = parsePerfs(src['PERFS'], year);
  const slacksIso = String(src['SLACKS'] || '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => parseMonthDayTime(x, year))
    .filter(Boolean);

  const eventDateRange = parseEventDatesRange(listing.eventDates, year);

  listing.fields = {
    arena: src['ARENA'] || null,
    address: src['ADDRESS'] || null,
    eventDateRange,
    perfs,
    slacks: {
      raw: src['SLACKS'] || null,
      isoDateTimes: slacksIso
    },
    events: parseEvents(src['EVENTS']),
    entryFees: parseEntryFees(src['SPECIAL ENTRY FEES']),
    permits: src['PERMITS'] || null,
    groundRules: src['GROUND RULES'] || null,
    stockContractor: src['STK CONT.'] || null,
    subContractors: src['SUB. CONT.'] || null,
    entriesOpen: parseUsDateTime(src['EOO']) || null,
    entriesClose: parseUsDateTime(src['EC']) || null
  };
}

await writeFile(FILE, JSON.stringify(data, null, 2));
console.log(`Updated ${FILE}`);
console.log(`Listings transformed: ${(data.listings || []).length}`);
