// src/scrapeTimesheets.js
import fs from "fs";
import path from "path";

/**
 * Debug artifacts
 */
async function saveArtifacts(page, name) {
  const dir = path.resolve("artifacts");
  fs.mkdirSync(dir, { recursive: true });

  const pngPath = path.join(dir, `${name}.png`);
  const htmlPath = path.join(dir, `${name}.html`);

  await page.screenshot({ path: pngPath, fullPage: true });
  fs.writeFileSync(htmlPath, await page.content(), "utf8");

  console.log(`Saved screenshot: artifacts/${name}.png`);
  console.log(`Saved HTML: artifacts/${name}.html`);
}

function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseSupportNames(envVal) {
  if (!envVal) return [];
  return envVal
    .split(/[\n,]/g)
    .map((s) => norm(s))
    .filter(Boolean);
}

function isSupportName(fullName, supportNames) {
  const n = norm(fullName);
  return supportNames.some((sn) => n === sn || n.includes(sn));
}

async function safeClick(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 60000 });
}

/**
 * Wait until the schedule grid exists
 */
async function waitForScheduleGrid(page) {
  // These are stable “big container” anchors in your markup/screenshots
  const grid = page.locator(".print-wrapper, .ts-schedule, .ts-schedule-table, .tsWeek").first();
  await grid.waitFor({ state: "visible", timeout: 90000 });
}

/**
 * After Update, the UI sometimes shows "39 / 39" and sometimes "100%".
 * Your current code was waiting ONLY for X / X, but your logs show it often sits at "100%".
 * We accept BOTH as success.
 */
async function waitForUpdateComplete(page) {
  const counter = page.locator("span.float-right").first(); // you gave this exact selector target

  const timeoutMs = 120000;
  const start = Date.now();
  let lastSeen = "";

  while (Date.now() - start < timeoutMs) {
    const txt = ((await counter.innerText().catch(() => "")) || "").trim();
    if (txt) lastSeen = txt;

    // Good states:
    // - "39 / 39" (or any N / N, or N / M) as long as it's not 0/0
    // - "100%"
    if (txt === "100%") return { ok: true, value: txt };
    if (/^\d+\s*\/\s*\d+$/.test(txt) && txt !== "0 / 0") return { ok: true, value: txt };

    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for selection counter after Update. Last seen: "${lastSeen}"`);
}

/**
 * Opens Schedules, Select All, Update, waits until done.
 * Uses the selectors YOU pasted (tour-BTS-Users, select-all, update-menu-item, etc.)
 */
async function openSchedulesSelectAllUpdate(page) {
  // Go straight to schedules page (no sidebar clicking needed)
  await page.goto("https://secure.timesheets.com/default.cfm?page=Schedules", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await waitForScheduleGrid(page);
  await saveArtifacts(page, "03-on-schedules");

  // People icon (you gave outerHTML with these classes)
  const peopleIcon = page.locator("i.open-menu.tour-BTS-Users, i.fa-users-medical-pos.open-menu").first();
  await peopleIcon.waitFor({ state: "visible", timeout: 60000 });
  await safeClick(peopleIcon);

  // Select All checkbox (your selector: span.checkmark.cb-container-category.select-all)
  const selectAll = page.locator("span.checkmark.cb-container-category.select-all").first();
  await selectAll.waitFor({ state: "visible", timeout: 60000 });
  await safeClick(selectAll);

  // Update button (your selector: div.menu-link-item.update-menu-item.indent-1.tour-BTS-Update)
  const updateBtn = page.locator("div.menu-link-item.update-menu-item").first();
  await updateBtn.waitFor({ state: "visible", timeout: 60000 });
  await safeClick(updateBtn);

  // Wait for completion (accepts 39/39 OR 100%)
  const done = await waitForUpdateComplete(page);

  await saveArtifacts(page, "04-after-update");
  return done.value;
}

/**
 * Get the header dates in order (Sun..Sat) so we can map today's date to a column index.
 * Your markup shows .grid-day-header .date_label
 */
async function getHeaderDates(page) {
  const labels = page.locator(".grid-day-header .date_label");
  const count = await labels.count();
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(((await labels.nth(i).innerText().catch(() => "")) || "").trim());
  }
  return out; // ["Feb 22, 2026", ...]
}

function ymdToDate(ymd) {
  // ymd like 2026-02-20
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function sameUtcDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function headerLabelToDate(label) {
  // label like "Feb 25, 2026"
  const t = Date.parse(label);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  // normalize to UTC day
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/**
 * Extract time off blocks from the weekly grid using the actual grid structure:
 * - each row has the name
 * - each day cell is .grid-day[data-day-index="0..6"]
 * - time off blocks live under .timeOff and include text like "8.00 PTO" / "4.00 Sick"
 */
async function extractTimeOffFromGrid(page) {
  const rows = page.locator(".schedule-row-item .grid-row-off, .schedule-row-item .schedule_row");
  const rowCount = await rows.count();

  const results = [];

  for (let r = 0; r < rowCount; r++) {
    const row = rows.nth(r);

    const name = ((await row.locator(".name-ellipses").first().innerText().catch(() => "")) || "").trim();
    if (!name) continue;

    // For each day column 0..6, check if there is a timeOff block
    for (let dayIdx = 0; dayIdx <= 6; dayIdx++) {
      const dayCell = row.locator(`.grid-day[data-day-index="${dayIdx}"]`).first();
      if (!(await dayCell.count())) continue;

      const timeOffBlock = dayCell.locator(".timeOff, .default.schedule-item").first();
      if (!(await timeOffBlock.count())) continue;

      const txt = ((await timeOffBlock.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!txt) continue;

      // We only care about Time Off types (PTO/Sick/Time Off)
      if (!/pto|sick|time off/i.test(txt)) continue;

      results.push({
        name,
        dayIdx,
        raw: txt,
      });
    }
  }

  return results;
}

/**
 * LOGIN
 */
async function login(page, username, password) {
  await page.goto("https://secure.timesheets.com/default.cfm?page=Login", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.locator("#username").fill(username, { timeout: 60000 });
  await page.locator("#password").fill(password, { timeout: 60000 });
  await saveArtifacts(page, "01-login-page");

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {}),
    page.locator('button.loginButton[type="submit"]').click({ timeout: 60000 }),
  ]);

  await saveArtifacts(page, "02-after-login");
}

/**
 * DAILY: return only people out on DATE_YMD (env passed by workflow)
 */
export async function scrapeWhoIsOutToday(page, opts) {
  const { tsUsername, tsPassword, dateYmd, supportTeamNames } = opts;
  const supportNames = parseSupportNames(supportTeamNames);

  await login(page, tsUsername, tsPassword);

  // Select all + update and wait until done (39/39 OR 100%)
  const status = await openSchedulesSelectAllUpdate(page);
  console.log(`Selection status after Update: ${status}`);

  await waitForScheduleGrid(page);

  const headerDates = await getHeaderDates(page);
  if (!headerDates.length) {
    await saveArtifacts(page, "99-error");
    throw new Error("Could not find header dates (.grid-day-header .date_label).");
  }

  const target = ymdToDate(dateYmd);
  const headerParsed = headerDates.map(headerLabelToDate);

  const targetIdx = headerParsed.findIndex((d) => d && sameUtcDay(d, target));
  if (targetIdx === -1) {
    // Not in this visible week (or header parse failed)
    console.log("Header dates:", headerDates);
    await saveArtifacts(page, "99-error");
    throw new Error(`Target date ${dateYmd} not found in visible week header.`);
  }

  const allBlocks = await extractTimeOffFromGrid(page);

  // filter to the target day
  const todayBlocks = allBlocks.filter((b) => b.dayIdx === targetIdx);

  // filter support-only
  const supportOnly = todayBlocks.filter((b) => isSupportName(b.name, supportNames));

  return {
    dateYmd,
    targetIdx,
    headerLabel: headerDates[targetIdx],
    supportOnly,
    allToday: todayBlocks,
  };
}

/**
 * WEEKLY: return support-only time off blocks for the whole visible week
 * (Used by weekly-leads job)
 */
export async function scrapeWhoIsOutThisWeek(page, opts) {
  const { tsUsername, tsPassword, supportTeamNames } = opts;
  const supportNames = parseSupportNames(supportTeamNames);

  await login(page, tsUsername, tsPassword);

  const status = await openSchedulesSelectAllUpdate(page);
  console.log(`Selection status after Update: ${status}`);

  await waitForScheduleGrid(page);

  const headerDates = await getHeaderDates(page);
  const allBlocks = await extractTimeOffFromGrid(page);

  const supportOnly = allBlocks.filter((b) => isSupportName(b.name, supportNames));

  return {
    headerDates,
    supportOnly,
  };
}
