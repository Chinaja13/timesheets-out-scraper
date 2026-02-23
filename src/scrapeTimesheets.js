// src/scrapeTimesheets.js
import fs from "fs";
import path from "path";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function saveDebug(page, artifactsDir, name) {
  ensureDir(artifactsDir);
  await page.screenshot({ path: path.join(artifactsDir, `${name}.png`), fullPage: true });
  const html = await page.content();
  fs.writeFileSync(path.join(artifactsDir, `${name}.html`), html, "utf8");
  console.log(`Saved screenshot: artifacts/${name}.png`);
  console.log(`Saved HTML: artifacts/${name}.html`);
}

function parseSupportNames(envVal) {
  // Expected: "Andrew Graff, Melissa Zurun, Dillon Janes" etc
  // We match case-insensitive and allow exact match or "Last, First" etc.
  const raw = (envVal || "").split(",").map(s => s.trim()).filter(Boolean);
  const set = new Set(raw.map(s => s.toLowerCase()));
  return { raw, set };
}

function normalizeName(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function ymdInTimeZone(date = new Date(), timeZone = "America/Denver") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`; // YYYY-MM-DD
}

function tryParseHeaderToYMD(label) {
  // Example label: "Feb 25, 2026"
  // We'll parse via Date. This assumes English month names (it is, for your UI).
  const d = new Date(label);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function clickIfVisible(locator) {
  try {
    if (await locator.first().isVisible({ timeout: 1500 })) {
      await locator.first().click();
      return true;
    }
  } catch {}
  return false;
}

async function waitForSelectionCounter(page, { timeoutMs = 90000 } = {}) {
  // Counter element you gave:
  // #app > div > div.menu-link.no-print.wide-counter-layout > span > div > span.float-right
  const counter = page.locator("span.float-right").first();

  const start = Date.now();
  let lastText = "";

  while (Date.now() - start < timeoutMs) {
    try {
      const txt = normalizeName(await counter.textContent());
      if (txt) lastText = txt;

      // Expect format "39 / 39" or "0 / 39"
      const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) {
        const left = Number(m[1]);
        const right = Number(m[2]);

        // We want it to be non-zero and fully loaded.
        // In practice, when Update finishes, you get 39/39.
        if (right > 0 && left === right) {
          return { left, right, txt };
        }
      }
    } catch {}

    await page.waitForTimeout(750);
  }

  throw new Error(`Timed out waiting for selection counter to reach X / X after Update. Last seen: "${lastText}"`);
}

async function waitForGridReady(page, { timeoutMs = 90000 } = {}) {
  // Things that reliably exist on the week grid
  const grid = page.locator(".ts-schedule.wrapperBox, .print-wrapper, .tsWeek, .ts-schedule-table").first();
  await grid.waitFor({ state: "visible", timeout: timeoutMs });
}

async function gotoSchedules(page) {
  // You gave:
  // Scheduling dropdown handler: a.dropdown-handler.tour-Scheduling
  // Schedules link: a[href="default.cfm?page=Schedules"]
  await page.locator("a.dropdown-handler.tour-Scheduling").first().click({ timeout: 30000 });
  await page.locator('a[href="default.cfm?page=Schedules"]').first().click({ timeout: 30000 });
}

async function openPeopleMenu(page) {
  // You gave a very specific CSS path; we'll use a stable class-based selector:
  // i.fa-users-medical.open-menu
  const icon = page.locator("i.open-menu.fa-users-medical, i.open-menu.fa-users-medical-pos").first();
  await icon.waitFor({ state: "visible", timeout: 30000 });
  await icon.click();
}

async function selectAllInMenu(page) {
  // You gave selector for the span.checkmark.select-all; clicking that is fine.
  const selectAll = page.locator("span.checkmark.cb-container-category.select-all").first();
  await selectAll.waitFor({ state: "visible", timeout: 30000 });
  await selectAll.click();
}

async function clickUpdate(page) {
  const updateBtn = page.locator("div.menu-link-item.update-menu-item").first();
  await updateBtn.waitFor({ state: "visible", timeout: 30000 });
  await updateBtn.click();
}

async function login(page, { username, password }) {
  await page.goto("https://secure.timesheets.com/default.cfm?page=Login", { waitUntil: "domcontentloaded" });

  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"].loginButton').click();

  // Wait for post-login UI: left nav exists
  await page.locator("text=Dashboard").first().waitFor({ state: "visible", timeout: 30000 });
}

async function getHeaderDates(page) {
  // In your DOM: .date_label (inside grid-day-header)
  const labels = page.locator(".date_label");
  const count = await labels.count();
  const out = [];
  for (let i = 0; i < count; i++) {
    const txt = normalizeName(await labels.nth(i).textContent());
    const ymd = tryParseHeaderToYMD(txt);
    if (ymd) out.push({ index: i, label: txt, ymd });
  }
  return out;
}

async function scrapeDayColumn(page, targetYmd, supportSet) {
  // Rows: .schedule-row-item exists; inside name container we’ve seen:
  // .name-ellipses OR .calendar-name-sched (from your DOM snippets)
  const rows = page.locator(".schedule-row-item");
  const rowCount = await rows.count();

  // Header dates to map column index
  const headerDates = await getHeaderDates(page);
  const target = headerDates.find(d => d.ymd === targetYmd);

  if (!target) {
    return {
      targetYmd,
      found: [],
      meta: { error: `Could not find target date column header for ${targetYmd}`, headerDates },
    };
  }

  const dayIndex = target.index; // 0..6-ish depending on layout
  const found = [];

  for (let r = 0; r < rowCount; r++) {
    const row = rows.nth(r);

    const name =
      normalizeName(await row.locator(".name-ellipses").first().textContent().catch(() => "")) ||
      normalizeName(await row.locator(".calendar-name-sched").first().textContent().catch(() => ""));

    if (!name) continue;

    // Filter to support only
    const nameLower = name.toLowerCase();
    let isSupport = false;

    // exact match on known names
    if (supportSet.size > 0) {
      for (const s of supportSet) {
        if (s && (nameLower === s || nameLower.includes(s))) {
          isSupport = true;
          break;
        }
      }
      if (!isSupport) continue;
    }

    // The day cell container in your snippet uses data-day-index on .grid-day elements.
    // We'll find the cell for this row for the given day index.
    const cell = row.locator(`.grid-day[data-day-index="${dayIndex}"], .grid-day-flex-cell[data-day-index="${dayIndex}"]`).first();

    const hasEvent = await cell.locator(".has-event, .timeOff").first().isVisible().catch(() => false);
    if (!hasEvent) continue;

    // Events blocks
    const events = cell.locator(".default.schedule-item, .timeOff, .has-event");
    const eventCount = await events.count();

    for (let e = 0; e < eventCount; e++) {
      const ev = events.nth(e);

      const cls = (await ev.getAttribute("class").catch(() => "")) || "";
      const approved = !cls.toLowerCase().includes("unpublished");

      const text = normalizeName(await ev.textContent().catch(() => ""));
      // Usually contains "8.00 PTO" or "4.00 Sick"
      const m = text.match(/(\d+(?:\.\d+)?)\s*(PTO|Sick|Unavailable|Time Off)/i);
      const hours = m ? Number(m[1]) : null;
      const type = m ? m[2].toUpperCase() : text;

      found.push({
        name,
        date: targetYmd,
        type,
        hours,
        approved,
        raw: text,
      });
    }
  }

  return { targetYmd, dayIndex, found, meta: { headerDates } };
}

export async function scrapeWhoIsOutToday(page, opts) {
  const {
    username,
    password,
    supportTeamNames,
    artifactsDir = "artifacts",
    targetYmd,
  } = opts;

  const { set: supportSet } = parseSupportNames(supportTeamNames);

  try {
    await login(page, { username, password });
    await saveDebug(page, artifactsDir, "02-after-login");

    await gotoSchedules(page);

    // Wait for schedules UI to appear
    await page.locator("text=Calendars & Schedules").first().waitFor({ state: "visible", timeout: 45000 });

    await openPeopleMenu(page);
    await selectAllInMenu(page);
    await clickUpdate(page);

    // Big important waits
    await waitForGridReady(page, { timeoutMs: 90000 });
    const counter = await waitForSelectionCounter(page, { timeoutMs: 90000 });
    console.log(`Selection counter ready: ${counter.txt}`);

    await saveDebug(page, artifactsDir, "04-after-update");

    // DO NOT click "Week" tab — you’re already in the weekly grid view after update.
    const effectiveYmd = targetYmd || ymdInTimeZone(new Date(), "America/Denver");

    const dayResult = await scrapeDayColumn(page, effectiveYmd, supportSet);
    await saveDebug(page, artifactsDir, "06-after-scrape");

    return {
      mode: "daily",
      selectionCounter: counter,
      ...dayResult,
    };
  } catch (err) {
    console.log("SCRAPE ERROR:", err?.message || err);
    await saveDebug(page, artifactsDir, "99-error");
    throw err;
  }
}
