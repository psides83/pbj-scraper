import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const URL = "https://pbj.prorodeo.org/longlistings";
const OUTPUT_DIR = "output";
const CARD_SELECTOR = "div.mud-paper.mud-elevation-1.mud-card.h-full";
const DETAIL_SELECTOR = "[role='dialog'] .mud-dialog-content";
const DEFAULT_MAX_CARDS = Number.POSITIVE_INFINITY;
const START_INDEX = Math.max(1, Number(process.env.START_INDEX || 1));
const REFRESH_EVERY = Math.max(1, Number(process.env.REFRESH_EVERY || 20));
const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

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

function pad(n) {
  return String(n).padStart(2, "0");
}

function toIsoLocal(year, month, day, hour24, minute = 0, second = 0) {
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour24)}:${pad(minute)}:${pad(second)}`;
}

function to24h(hour12, ampm) {
  let h = Number(hour12);
  const upper = String(ampm || "").toUpperCase();
  if (upper === "AM" && h === 12) h = 0;
  if (upper === "PM" && h !== 12) h += 12;
  return h;
}

function yearFromPublishDate(publishDate) {
  const m = String(publishDate || "").match(/(\d{4})/);
  return m ? Number(m[1]) : new Date().getFullYear();
}

function parseMonthDayTime(text, year) {
  const m = String(text || "").match(
    /\b([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)\b/i
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return toIsoLocal(year, month, Number(m[2]), to24h(m[3], m[5]), Number(m[4]), 0);
}

function parseUsDateTime(text) {
  const m = String(text || "").match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i
  );
  if (!m) return null;
  return toIsoLocal(
    Number(m[3]),
    Number(m[1]),
    Number(m[2]),
    to24h(m[4], m[7]),
    Number(m[5]),
    Number(m[6] || 0)
  );
}

function parseEventDatesRange(eventDates, year) {
  const text = String(eventDates || "").trim();
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
  const raw = String(perfsRaw || "").trim();
  if (!raw) return null;
  const countMatch = raw.match(/^(\d+)\s+Perfs?:/i);
  const listText = raw.includes(":") ? raw.split(":").slice(1).join(":") : raw;
  const parts = listText
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    perfsCount: countMatch ? Number(countMatch[1]) : null,
    perfDates: parts.map((part) => parseMonthDayTime(part, year)).filter(Boolean)
  };
}

function parseEvents(eventsRaw) {
  const text = String(eventsRaw || "").trim();
  if (!text) return [];
  const events = [];
  const regex = /([^@]+?)@\s*\$?([\d,]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const eventCodes = match[1]
      .replace(/\s+/g, " ")
      .trim()
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const addedMoney = Number(String(match[2]).replace(/,/g, ""));
    for (const code of eventCodes) {
      events.push({ event: code, addedMoney });
    }
  }
  return events;
}

function parseEntryFees(rawFees) {
  const text = String(rawFees || "").trim();
  if (!text) return [];
  return text
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^([A-Z-]+)\s*-\s*(.+)$/i);
      return m ? { event: m[1], fees: m[2].trim() } : { event: null, fees: entry };
    });
}

function inferTourFromLocation(location) {
  const text = String(location || "").toUpperCase();
  if (/\bNPP\b/.test(text)) return "NPP";
  if (/\bCN\b/.test(text)) return "CN";
  return null;
}

function resolveTour(headerTour, location) {
  const header = String(headerTour || "").trim();
  if (header) return header;
  return inferTourFromLocation(location);
}

function formatListingFields(listing) {
  const src = listing.fields || {};
  const year = yearFromPublishDate(listing.publishDate);
  const slacksIso = String(src["SLACKS"] || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => parseMonthDayTime(x, year))
    .filter(Boolean);

  return {
    ...listing,
    tour: resolveTour(listing.tour, listing.location),
    fields: {
      tour: resolveTour(listing.tour, listing.location),
      arena: src["ARENA"] || null,
      address: src["ADDRESS"] || null,
      eventDateRange: parseEventDatesRange(listing.eventDates, year),
      perfs: parsePerfs(src["PERFS"], year),
      slacks: {
        raw: src["SLACKS"] || null,
        isoDateTimes: slacksIso
      },
      events: parseEvents(src["EVENTS"]),
      entryFees: parseEntryFees(src["SPECIAL ENTRY FEES"]),
      permits: src["PERMITS"] || null,
      groundRules: src["GROUND RULES"] || null,
      stockContractor: src["STK CONT."] || null,
      subContractors: src["SUB. CONT."] || null,
      entriesOpen: parseUsDateTime(src["EOO"]) || null,
      entriesClose: parseUsDateTime(src["EC"]) || null
    }
  };
}

async function gotoWithRetries(page, url, attempts = 4) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(5000);
      await page.waitForSelector(CARD_SELECTOR, { timeout: 60000 });
      return;
    } catch (error) {
      lastError = error;
      if (i < attempts) {
        await page.waitForTimeout(2000 * i);
      }
    }
  }
  throw lastError;
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await gotoWithRetries(page, URL);

  const maxCards = Number(process.env.MAX_CARDS || DEFAULT_MAX_CARDS);
  const totalCards = await page.locator(CARD_SELECTOR).count();
  const targetCount = Number.isFinite(maxCards)
    ? Math.min(maxCards, totalCards)
    : totalCards;

  const details = [];
  const failures = [];

  for (let index = START_INDEX - 1; index < targetCount; index += 1) {
    if (index > START_INDEX - 1 && index % REFRESH_EVERY === 0) {
      console.log(`Refreshing page before listing ${index + 1}...`);
      await gotoWithRetries(page, URL);
    }

    console.log(`Opening listing ${index + 1}/${targetCount}...`);
    let card = page.locator(CARD_SELECTOR).nth(index);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(100);

    // Ensure no stale modal is still present from a previous iteration.
    const staleDialog = page.locator("[role='dialog'] .mud-dialog-content");
    if ((await staleDialog.count()) > 0) {
      await page.keyboard.press("Escape").catch(() => {});
      await staleDialog.first().waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    }

    const summaryText = ((await card.innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim();
    const tourTag = ((await card.locator(".mud-card-header").first().innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim();

    let dialogOpened = false;
    let openError = null;
    for (let cycle = 1; cycle <= 2 && !dialogOpened; cycle += 1) {
      if (cycle === 2) {
        console.log(`Retrying listing ${index + 1} after page reload...`);
        await gotoWithRetries(page, URL);
        card = page.locator(CARD_SELECTOR).nth(index);
      }

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await card.scrollIntoViewIfNeeded().catch(() => {});
          if (attempt === 1) {
            await card.click({ timeout: 6000 });
          } else if (attempt === 2) {
            await card.click({ force: true, timeout: 6000 });
          } else {
            await page.evaluate(
              ({ selector, idx }) => {
                const el = document.querySelectorAll(selector)[idx];
                el?.click();
              },
              { selector: CARD_SELECTOR, idx: index }
            );
          }

          await page.waitForSelector(DETAIL_SELECTOR, { timeout: 6000 });
          dialogOpened = true;
          break;
        } catch (error) {
          openError = error;
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(300);
        }
      }
    }

    if (!dialogOpened) {
      failures.push({
        index: index + 1,
        summaryText,
        error: String(openError?.message || openError || "Dialog did not open")
      });
      continue;
    }

    const detail = await page.evaluate(() => {
      const cleanText = (value) =>
        (value || "")
          .replace(/\u00a0/g, " ")
          .replace(/(^| )!(?= |$)/g, " ")
          .replace(/^!+/, "")
          .replace(/!+$/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const dialog = document.querySelector("[role='dialog'], .mud-dialog");
      if (!dialog) return null;

      const title = cleanText(dialog.querySelector(".mud-dialog-title h6")?.textContent);
      const content = dialog.querySelector(".mud-dialog-content");
      const allStrong = Array.from(content?.querySelectorAll("strong") || []).map((node) =>
        cleanText(node.textContent)
      );
      const topLines = allStrong.filter((line) => line && !line.endsWith(":")).slice(0, 3);

      const clone = content ? content.cloneNode(true) : null;
      if (clone) {
        clone.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
      }
      const lines = (clone?.textContent || "")
        .replace(/\u00a0/g, " ")
        .split(/\n+/)
        .map((line) => cleanText(line))
        .filter(Boolean);

      const fields = {};
      if (content) {
        const strongNodes = Array.from(content.querySelectorAll("strong"));
        for (const strong of strongNodes) {
          const rawLabel = cleanText(strong.textContent);
          if (!rawLabel.endsWith(":")) continue;
          const label = rawLabel.replace(/:$/, "");
          let value = "";
          let current = strong.nextSibling;
          while (current && current.nodeName !== "BR") {
            value += current.textContent || "";
            current = current.nextSibling;
          }
          const normalizedValue = cleanText(value);
          if (normalizedValue) {
            fields[label] = normalizedValue;
          }
        }
      }

      return {
        publishDate: title.replace(/^Publish Date:\s*/i, "") || null,
        location: topLines[0] || null,
        eventDates: topLines[1] || null,
        eventName: topLines[2] || null,
        fields,
        detailLines: lines,
        detailText: cleanText(content?.textContent || "")
      };
    });

    details.push({
      index: index + 1,
      tour: tourTag || null,
      summaryText,
      ...(detail || {})
    });

    await page.locator("button[aria-label='Close']").click({ timeout: 6000 });
    await page.waitForSelector(DETAIL_SELECTOR, { state: "detached", timeout: 6000 }).catch(
      async () => {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForSelector(DETAIL_SELECTOR, { state: "detached", timeout: 2000 }).catch(
          () => {}
        );
      }
    );

    if ((index + 1) % 10 === 0 || index + 1 === targetCount) {
      console.log(`Scraped details for ${index + 1}/${targetCount} listings...`);
    }
  }

  await browser.close();

  const timestamp = new Date().toISOString();
  const normalizedDetails = details.map(formatListingFields);

  const flattened = normalizedDetails.map((item) => ({
    index: item.index,
    publishDate: item.publishDate,
    location: item.location,
    eventDates: item.eventDates,
    eventName: item.eventName,
    tour: item.tour || null,
    summaryText: item.summaryText,
    arena: item.fields.arena,
    address: item.fields.address,
    startDate: item.fields.eventDateRange?.startDate || null,
    endDate: item.fields.eventDateRange?.endDate || null,
    entriesOpen: item.fields.entriesOpen,
    entriesClose: item.fields.entriesClose
  }));

  const payload = {
    scrapedAt: timestamp,
    source: URL,
    attemptedCount: targetCount,
    listingCount: details.length,
    failureCount: failures.length,
    failures,
    listings: normalizedDetails
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(`${OUTPUT_DIR}/pbj-detailed.json`, JSON.stringify(payload, null, 2));
  await writeFile(`${OUTPUT_DIR}/pbj-detailed.csv`, toCsv(flattened));

  console.log(`Scraped detailed data for ${payload.listingCount} listings.`);
  console.log(`Wrote ${OUTPUT_DIR}/pbj-detailed.json`);
  console.log(`Wrote ${OUTPUT_DIR}/pbj-detailed.csv`);
}

scrape().catch((error) => {
  console.error("Scrape failed:");
  console.error(error);
  process.exit(1);
});
