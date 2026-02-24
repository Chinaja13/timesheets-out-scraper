// src/scrapeTimesheets.js
import fs from "fs";
import path from "path";

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
  const s = envVal == null ? "" : String(envVal);
  return s
    .split(/[\n,]/g)
    .map((x) => norm(x))
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

async function login(page, username, password) {
  await page.goto("https://secure.timesheets.com/default.cfm?page=Login", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await saveArtifacts(page, "01-login-page");

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {}),
    page.locator('button.loginButton[type="submit"]').click({ timeout: 60000 }),
  ]);

  await page.locator("text=Dashboard").first().waitFor({ state: "visible", timeout: 60000 });
  await saveArtifacts(page, "02-after-login");
}

async function waitForScheduleGrid(page) {
  await page.locator(".print-wrapper, .ts-schedule, .ts-schedule-table, .tsWeek").first().waitFor({
    state: "visible",
    timeout: 90000,
  });
}

async function ensureRowsRendered(page, minRows = 20) {
  const rowLoc = page.locator(".schedule-row-item");
  const scroller = page.locator(".table-off.ts-schedule-table.schedule-row-container");

  const readRowCount = async () => await rowLoc.count();

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.waitForTimeout(1200);

    let count = await readRowCount();
    console.log(`Row count check (attempt ${attempt}): ${count}`);

    if (count >= minRows) return count;

    if (await scroller.count()) {
      console.log("Scrolling schedule container to force row render...");
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(600);
      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(1200);
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(1200);

      count = await readRowCount();
      console.log(`Row count after scroll (attempt ${attempt}): ${count}`);
      if (count >= minRows) return count;
    }

    if (attempt === 2) {
      console.log("Row count still too low — reloading schedules page once...");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
      await waitForScheduleGrid(page);
    }
  }

  await saveArtifacts(page, "98-rows-too-low");
  return await page.locator(".schedule-row-item").count();
}

async function waitForUpdateComplete(page) {
  const counter = page.locator("span.float-right").first();

  const timeoutMs = 120000;
  const start = Date.now();
  let lastSeen = "";

  while (Date.now() - start < timeoutMs) {
    const txt = ((await counter.innerText().catch(() => "")) || "").trim();
    if (txt) lastSeen = txt;

    if (txt === "100%") return txt;
    if (/^\d+\s*\/\s*\d+$/.test(txt) && txt !== "0 / 0") return txt;

    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for selection counter after Update. Last seen: "${lastSeen}"`);
}

async function openSchedulesSelectAllUpdate(page) {
  await page.goto("https://secure.timesheets.com/default.cfm?page=Schedules", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await waitForScheduleGrid(page);
  await saveArtifacts(page, "03-on-schedules");

  const peopleIcon = page.locator("i.open-menu.tour-BTS-Users, i.fa-users-medical-pos.open-menu").first();
  await peopleIcon.waitFor({ state: "visible", timeout: 60000 });
  await safeClick(peopleIcon);

  const selectAll = page.locator("span.checkmark.cb-container-category.select-all").first();
  await selectAll.waitFor({ state: "visible", timeout: 60000 });
  await safeClick(selectAll);

  const updateBtn = page.locator("div.menu-link-item.update-menu-item").first();
  await updateBtn.waitFor({ state: "visible", timeout: 60000 });
  await safeClick(updateBtn);

  const status = await waitForUpdateComplete(page);
  await waitForScheduleGrid(page);

  const rows = await ensureRowsRendered(page, 20);
  console.log(`Rows rendered after update: ${rows}`);

  await saveArtifacts(page, "04-after-update");
  return status;
}

async function getHeaderDates(page) {
  const labels = page.locator(".grid-day-header .date_label");
  const count = await labels.count();
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(((await labels.nth(i).innerText().catch(() => "")) || "").trim());
  }
  return out; // index aligns to data-day-index
}

function ymdToUtcDate(ymd) {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function headerLabelToUtcDate(label) {
  const t = Date.parse(label);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function sameUtcDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function parseHoursAndType(raw) {
  const txt = (raw || "").replace(/\s+/g, " ").trim();

  // Expect “8.00 PTO”, “4.00 Sick”, etc.
  const m = txt.match(/(\d+(?:\.\d+)?)\s*(PTO|Sick|Time Off|Unavailable)/i);
  const hours = m ? Number(m[1]) : null;
  const type = m ? m[2].toUpperCase() : "TIME OFF";

  // Normalize type labels
  let t = type;
  if (t === "TIME OFF") t = "TIME OFF";
  if (t === "UNAVAILABLE") t = "TIME OFF";
  if (t === "SICK") t = "SICK";
  if (t === "PTO") t = "PTO";

  return { hours, type: t, raw: txt };
}

/**
 * Extract ALL time off blocks from the weekly grid:
 * row -> .grid-day[data-day-index] -> blocks inside
 */
async function extractTimeOffFromGrid(page) {
  const rows = page.locator(".schedule-row-item .grid-row-off, .schedule-row-item .schedule_row");
  const rowCount = await rows.count();

  const results = [];

  for (let r = 0; r < rowCount; r++) {
    const row = rows.nth(r);

    const name = ((await row.locator(".name-ellipses").first().innerText().catch(() => "")) || "").trim();
    if (!name) continue;

    for (let dayIdx = 0; dayIdx <= 6; dayIdx++) {
      const dayCell = row.locator(`.grid-day[data-day-index="${dayIdx}"]`).first();
      if (!(await dayCell.count())) continue;

      const blocks = dayCell.locator(".timeOff, .default.schedule-item");
      const blockCount = await blocks.count();
      if (!blockCount) continue;

      for (let b = 0; b < blockCount; b++) {
        const blk = blocks.nth(b);
        const txt = ((await blk.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (!txt) continue;
        if (!/pto|sick|time off|unavailable/i.test(txt)) continue;

        const cls = ((await blk.getAttribute("class").catch(() => "")) || "").toLowerCase();
        const approved = !cls.includes("unpublished");

        const parsed = parseHoursAndType(txt);
        results.push({
          name,
          dayIdx,
          hours: parsed.hours,
          type: parsed.type,
          approved,
          raw: parsed.raw,
        });
      }
    }
  }

  return results;
}

export async function scrapeWhoIsOutToday(page, opts) {
  const { tsUsername, tsPassword, dateYmd, supportTeamNames } = opts;
  const supportNames = parseSupportNames(supportTeamNames);

  if (!tsUsername || !tsPassword) throw new Error("Missing Timesheets credentials in scraper call.");
  if (!dateYmd) throw new Error("Missing dateYmd (YYYY-MM-DD).");
  if (!supportNames.length) throw new Error("SUPPORT_TEAM_NAMES is empty.");

  await login(page, tsUsername, tsPassword);
  const status = await openSchedulesSelectAllUpdate(page);
  console.log(`Selection status after Update: ${status}`);

  const headerDates = await getHeaderDates(page);
  const target = ymdToUtcDate(dateYmd);
  const headerParsed = headerDates.map(headerLabelToUtcDate);
  const targetIdx = headerParsed.findIndex((d) => d && sameUtcDay(d, target));

  if (targetIdx === -1) {
    await saveArtifacts(page, "99-target-not-in-week");
    throw new Error(`Target date ${dateYmd} not found in visible week header.`);
  }

  const allBlocks = await extractTimeOffFromGrid(page);
  const dayBlocks = allBlocks.filter((b) => b.dayIdx === targetIdx);
  const supportOnly = dayBlocks.filter((b) => isSupportName(b.name, supportNames));

  await saveArtifacts(page, "06-after-scrape");

  return {
    dateYmd,
    headerLabel: headerDates[targetIdx],
    targetIdx,
    supportOnly,
  };
}

export async function scrapeSupportWeek(page, opts) {
  const { tsUsername, tsPassword, supportTeamNames } = opts;
  const supportNames = parseSupportNames(supportTeamNames);

  if (!tsUsername || !tsPassword) throw new Error("Missing Timesheets credentials in scraper call.");
  if (!supportNames.length) throw new Error("SUPPORT_TEAM_NAMES is empty.");

  await login(page, tsUsername, tsPassword);
  const status = await openSchedulesSelectAllUpdate(page);
  console.log(`Selection status after Update: ${status}`);

  const headerDates = await getHeaderDates(page);
  const allBlocks = await extractTimeOffFromGrid(page);
  const supportOnly = allBlocks.filter((b) => isSupportName(b.name, supportNames));

  await saveArtifacts(page, "06-week-after-scrape");

  return {
    headerDates,
    supportOnly,
  };
}
