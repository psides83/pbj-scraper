import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT_DIR = process.env.ROOT_DIR || process.cwd();
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const SCRAPER_FILE = process.env.SCRAPER_FILE || resolve(ROOT_DIR, "scrape.mjs");
const OUTPUT_DIR = process.env.OUTPUT_DIR || resolve(ROOT_DIR, "output");
const OUTPUT_JSON = `${OUTPUT_DIR}/pbj-detailed.json`;
const OUTPUT_CSV = `${OUTPUT_DIR}/pbj-detailed.csv`;

const TOTAL_CARDS = Number(process.env.TOTAL_CARDS || 173);
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 20);
const CHUNK_RETRIES = Number(process.env.CHUNK_RETRIES || 3);
const REFRESH_EVERY = Number(process.env.REFRESH_EVERY || 20);

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const header = columns.map(csvEscape).join(",");
  const body = rows
    .map((row) => columns.map((col) => csvEscape(row[col])).join(","))
    .join("\n");
  return `${header}\n${body}\n`;
}

function runChunk(start, end) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      START_INDEX: String(start),
      MAX_CARDS: String(end),
      REFRESH_EVERY: String(REFRESH_EVERY)
    };
    const child = spawn(NODE_BIN, [SCRAPER_FILE], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (buf) => process.stdout.write(buf));
    child.stderr.on("data", (buf) => process.stderr.write(buf));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Chunk ${start}-${end} failed with exit code ${code}`));
    });
  });
}

function flattenListing(item) {
  return {
    index: item.index,
    publishDate: item.publishDate,
    location: item.location,
    eventDates: item.eventDates,
    eventName: item.eventName,
    tour: item.tour || null,
    summaryText: item.summaryText,
    arena: item.fields?.arena || null,
    address: item.fields?.address || null,
    startDate: item.fields?.eventDateRange?.startDate || null,
    endDate: item.fields?.eventDateRange?.endDate || null,
    entriesOpen: item.fields?.entriesOpen || null,
    entriesClose: item.fields?.entriesClose || null
  };
}

async function loadCurrentOutput() {
  const raw = await readFile(OUTPUT_JSON, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const ranges = [];
  for (let start = 1; start <= TOTAL_CARDS; start += CHUNK_SIZE) {
    ranges.push({ start, end: Math.min(start + CHUNK_SIZE - 1, TOTAL_CARDS) });
  }

  const segmentResults = [];
  for (const { start, end } of ranges) {
    let success = false;
    let lastPayload = null;
    let discoveredTotal = null;

    for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt += 1) {
      console.log(`\n=== Chunk ${start}-${end} (attempt ${attempt}/${CHUNK_RETRIES}) ===`);
      try {
        await runChunk(start, end);
        const payload = await loadCurrentOutput();
        lastPayload = payload;
        discoveredTotal = payload.attemptedCount;
        const expected = Math.max(0, Math.min(end, discoveredTotal) - start + 1);
        const chunkSuccess = payload.failureCount === 0 && payload.listingCount === expected;
        if (chunkSuccess) {
          console.log(`Chunk ${start}-${end} complete (${payload.listingCount}/${expected}).`);
          success = true;
          break;
        }
        console.log(
          `Chunk ${start}-${end} partial (${payload.listingCount}/${expected}, failures=${payload.failureCount}).`
        );
      } catch (error) {
        console.error(String(error?.message || error));
      }
    }

    if (!lastPayload) {
      throw new Error(`No output produced for chunk ${start}-${end}.`);
    }

    segmentResults.push({
      start,
      end,
      success,
      discoveredTotal,
      payload: lastPayload
    });
  }

  const listingMap = new Map();
  const failureMap = new Map();
  for (const segment of segmentResults) {
    for (const listing of segment.payload.listings || []) {
      listingMap.set(listing.index, listing);
      failureMap.delete(listing.index);
    }
    for (const failure of segment.payload.failures || []) {
      if (!listingMap.has(failure.index)) {
        failureMap.set(failure.index, failure);
      }
    }
  }

  const listings = [...listingMap.values()].sort((a, b) => a.index - b.index);
  const failures = [...failureMap.values()].sort((a, b) => a.index - b.index);
  const flattened = listings.map(flattenListing);
  const discoveredTotal = segmentResults
    .map((s) => s.discoveredTotal || 0)
    .reduce((max, cur) => Math.max(max, cur), 0);

  const merged = {
    scrapedAt: new Date().toISOString(),
    source: "https://pbj.prorodeo.org/longlistings",
    attemptedCount: discoveredTotal || TOTAL_CARDS,
    listingCount: listings.length,
    failureCount: Math.max(0, (discoveredTotal || TOTAL_CARDS) - listings.length),
    failures,
    listings
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_JSON, JSON.stringify(merged, null, 2));
  await writeFile(OUTPUT_CSV, toCsv(flattened));

  console.log("\n=== Final Summary ===");
  console.log(`Listings captured: ${merged.listingCount}/${TOTAL_CARDS}`);
  console.log(`Listings failed: ${merged.failureCount}`);
  console.log(`Wrote ${OUTPUT_JSON}`);
  console.log(`Wrote ${OUTPUT_CSV}`);
}

main().catch((error) => {
  console.error("Batched scrape failed:");
  console.error(error);
  process.exit(1);
});
