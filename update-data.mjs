import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

const ROOT_DIR = process.env.ROOT_DIR || process.cwd();
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const BATCHED_FILE = resolve(ROOT_DIR, "scrape-batched.mjs");
const OUTPUT_DIR = process.env.OUTPUT_DIR || resolve(ROOT_DIR, "output");
const SCRAPED_JSON = resolve(OUTPUT_DIR, "pbj-detailed.json");
const DATA_FILE = process.env.DATA_FILE || resolve(ROOT_DIR, "docs", "pbj-detailed.json");

function toRunDateISO() {
  if (process.env.RUN_DATE) return process.env.RUN_DATE;
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function listingKey(listing) {
  const location = normalize(listing.location);
  const eventDates = normalize(listing.eventDates);
  const eventName = normalize(listing.eventName);
  const arena = normalize(listing?.fields?.arena);
  const address = normalize(listing?.fields?.address);
  return `${location}|${eventDates}|${eventName}|${arena}|${address}`;
}

function isCompleted(listing, runDateISO) {
  const end = listing?.fields?.eventDateRange?.endDate;
  return Boolean(end && end < runDateISO);
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
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

function flattenListing(item) {
  return {
    index: item.index,
    publishDate: item.publishDate,
    location: item.location,
    eventDates: item.eventDates,
    eventName: item.eventName,
    tour: item.tour || null,
    summaryText: item.summaryText,
    arena: item?.fields?.arena || null,
    address: item?.fields?.address || null,
    startDate: item?.fields?.eventDateRange?.startDate || null,
    endDate: item?.fields?.eventDateRange?.endDate || null,
    entriesOpen: item?.fields?.entriesOpen || null,
    entriesClose: item?.fields?.entriesClose || null
  };
}

async function readJsonIfExists(path) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function dedupeListings(listings) {
  const map = new Map();
  for (const listing of listings || []) {
    const key = listingKey(listing);
    if (!map.has(key)) {
      map.set(key, listing);
      continue;
    }
    const prev = map.get(key);
    // Prefer entry with a tour label when available.
    if (!prev?.tour && listing?.tour) {
      map.set(key, listing);
    }
  }
  return [...map.values()];
}

function runBatchedScrape() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(NODE_BIN, [BATCHED_FILE], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (buf) => process.stdout.write(buf));
    child.stderr.on("data", (buf) => process.stderr.write(buf));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`scrape-batched exited with code ${code}`));
    });
  });
}

async function main() {
  const runDateISO = toRunDateISO();
  console.log(`Run date: ${runDateISO}`);

  await runBatchedScrape();

  const scraped = await readJsonIfExists(SCRAPED_JSON);
  if (!scraped) {
    throw new Error(`Missing scraped output: ${SCRAPED_JSON}`);
  }

  const existing = (await readJsonIfExists(DATA_FILE)) || { listings: [] };

  const activeExisting = dedupeListings(
    (existing.listings || []).filter((l) => !isCompleted(l, runDateISO))
  );
  const activeScraped = (scraped.listings || []).filter((l) => !isCompleted(l, runDateISO));

  const existingMap = new Map(activeExisting.map((l) => [listingKey(l), l]));
  const merged = [...activeExisting];
  let addedCount = 0;

  for (const listing of activeScraped) {
    const key = listingKey(listing);
    if (existingMap.has(key)) continue;
    merged.push(listing);
    existingMap.set(key, listing);
    addedCount += 1;
  }

  merged.sort((a, b) => {
    const aEnd = a?.fields?.eventDateRange?.endDate || "9999-12-31";
    const bEnd = b?.fields?.eventDateRange?.endDate || "9999-12-31";
    if (aEnd !== bEnd) return aEnd.localeCompare(bEnd);
    return String(a.location || "").localeCompare(String(b.location || ""));
  });

  const mergedPayload = {
    scrapedAt: new Date().toISOString(),
    source: scraped.source || "https://pbj.prorodeo.org/longlistings",
    runDate: runDateISO,
    listingCount: merged.length,
    addedCount,
    skippedExistingCount: activeScraped.length - addedCount,
    prunedCount: (existing.listings || []).length - activeExisting.length,
    listings: merged
  };

  await mkdir(dirname(DATA_FILE), { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(mergedPayload, null, 2));
  await writeFile(resolve(OUTPUT_DIR, "pbj-detailed.json"), JSON.stringify(mergedPayload, null, 2));
  await writeFile(resolve(OUTPUT_DIR, "pbj-detailed.csv"), toCsv(merged.map(flattenListing)));

  console.log(`Merged listings: ${merged.length}`);
  console.log(`Added new listings: ${addedCount}`);
  console.log(`Skipped existing listings: ${activeScraped.length - addedCount}`);
  console.log(`Pruned completed listings: ${(existing.listings || []).length - activeExisting.length}`);
  console.log(`Wrote ${DATA_FILE}`);
}

main().catch((error) => {
  console.error("update-data failed:");
  console.error(error);
  process.exit(1);
});
