import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

const ROOT_DIR = process.env.ROOT_DIR || process.cwd();
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const BATCHED_FILE = resolve(ROOT_DIR, "scrape-batched.mjs");
const OUTPUT_DIR = process.env.OUTPUT_DIR || resolve(ROOT_DIR, "output");
const DATA_FILE = process.env.DATA_FILE || resolve(ROOT_DIR, "docs", "pbj-detailed.json");

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
  await runBatchedScrape();
  const scrapedRaw = await readFile(resolve(OUTPUT_DIR, "pbj-detailed.json"), "utf8");
  const scrapedPayload = JSON.parse(scrapedRaw);

  await mkdir(dirname(DATA_FILE), { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(scrapedPayload, null, 2));
  await writeFile(
    resolve(OUTPUT_DIR, "pbj-detailed.csv"),
    toCsv((scrapedPayload.listings || []).map(flattenListing))
  );

  console.log(`Listings replaced from fresh scrape: ${scrapedPayload.listingCount ?? 0}`);
  console.log(`Wrote ${DATA_FILE}`);
}

main().catch((error) => {
  console.error("update-data failed:");
  console.error(error);
  process.exit(1);
});
