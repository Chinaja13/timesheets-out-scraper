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
  try {
    await locator.click({ timeout: 45000 });
  } catch {
    // fallback JS click if Timesheets overlay intercepts
    await locator.evaluate((el) => el.click());
  }
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

/**
 * Wait until the schedules page is "usable" (header/rows appear),
 * not just "loaded".
 */
async function waitForScheduleUsable(page) {
  // container
  await page.locator(".print-wrapper, .ts-schedule, .ts-schedule-table, .tsWeek").first().waitFor({
    state: "visible",
    timeout: 120000,
  });

  // Wait for either header dates or at least one row item
  const headerDates = page.locator(".grid-day-header .date_label");
  const rows = page.locator(".schedule-row-item");

  const start = Date.now();
  while (Date.now() - start < 120000) {
    const hc = await headerDates.count().catch(() => 0);
    const rc = await rows.count().catch(() => 0);
    if (hc >= 5 || rc >= 1) return;
    await page.waitForTimeout(400);
  }

  throw new Error("Schedules page never became usable (no headers/rows).");
}

/**
 * IMPORTANT: If preset is "My Schedule" it will show 1/1 and only you.
 * We must switch preset back to an unfiltered view.
 */
async function ensurePresetIsUnfiltered(page) {
  // The presets dropdown lives in the header toolbar
  const presetSelect = page.locator("div.calendar-header-toolbar select").first();
  if (!(await presetSelect.count())) return;

  const current = (await presetSelect.inputValue().catch(() => "")) || "";

  // Try to switch by LABEL first (most reliable)
  // Common labels: "Select View", "All", "All Schedules" etc
  const tryLabels = ["Select View", "All", "All Schedules", "Company", "Everyone"];

  for (const label of tryLabels) {
    try {
      await presetSelect.selectOption({ label });
      await page.waitForTimeout(1200);
      return;
    } catch {}
  }

  // If label switch didn't work, try selecting first option (often "Select View")
  try {
    const opts = presetSelect.locator("option");
    const n = await opts.count();
    if (n > 0) {
      const firstValue = await opts.nth(0).getAttribute("value");
      if (firstValue != null) {
        await presetSelect.selectOption(firstValue);
        await page.waitForTimeout(1200);
      }
    }
  } catch {
    // If we can't change it, keep going — but this is usually the cause of 1/1
  }
}

/**
 * Open the people menu.
 * You gave a rock-solid selector; use it first, then fall back.
 */
async function openPeopleMenu(page) {
  const candidates = [
    page.locator("#contentPad > div.page-header.noPrint > div.calendar-header-toolbar.noPrint > div > div.icon-container > div.menu-link-container.icon > i").first(),
    page.locator("div.menu-link-container.icon i").first(),
    page.locator("i.open-menu.tour-BTS-Users, i.fa-users-medical-pos.open-menu").first(),
  ];

  for (const loc of candidates) {
    try {
      if (await loc.isVisible({ timeout: 1500 })) {
        await safeClick(loc);
        // confirm slide menu opened
        const slide = page.locator("div.slide-menu, div.noPrint div.slide-menu").first();
        await slide.waitFor({ state: "visible", timeout: 8000 });
        return;
      }
    } catch {}
  }

  throw new Error("Could not open People menu (slide menu never appeared).");
}

async function clickSelectAll(page) {
  // Prefer the actual input if it exists; otherwise click the span
  const input = page.locator("div.menu-select-all input[type='checkbox']").first();
  if (await input.count()) {
    await safeClick(input);
    return;
  }

  const span = page.locator("span.checkmark.cb-container-category.select-all").first();
  await span.waitFor({ state: "visible", timeout: 15000 });
  await safeClick(span);
}

async function clickUpdate(page) {
  const updateBtn = page.locator("div.menu-link-item.update-menu-item").first();
  await updateBtn.waitFor({ state: "visible", timeout: 15000 });
  await safeClick(updateBtn);
}

/**
 * After Update, the counter may show 100% or X/Y.
 * But the most important thing is that rows render (>= 20).
 */
async function ensureCompanyRowsRendered(page, minRows = 20) {
  const rows = page.locator(".schedule-row-item");

  // Use scrolling to force virtualization to render
  const scroller = page.locator(".table-off.ts-schedule-table.schedule-row-container").first();

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.waitForTimeout(1500);

    const count = await rows.count().catch(() => 0);
    console.log(`Row count check (attempt ${attempt}): ${count}`);
    if (count >= minRows) return count;

    if (await scroller.count()) {
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(500);
      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(1200);
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(1200);
    }
  }

  // one recovery reload
  console.log("Rows still low — reloading schedules once...");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  await waitForScheduleUsable(page);
  await page.waitForTimeout(1500);

  const finalCount = await rows.count().catch(() => 0);
  if (finalCount < minRows) {
    throw new Error(`After Update, rows still not rendered (count=${finalCount}). Likely still filtered (Preset).`);
  }
  return finalCount;
}

async function openSchedulesSelectAllUpdate(page) {
  await page.goto("https://secure.timesheets.com/default.cfm?page=Schedules", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await waitForScheduleUsable(page);
  await ensurePresetIsUnfiltered(page); // 🔥 critical for the 1/1 issue
  await waitForScheduleUsable(page);

  await saveArtifacts(page, "03-on-schedules");

  await openPeopleMenu(page);
  await clickSelectAll(page);
  await clickUpdate(page);

  // Wait for usable again
  await waitForScheduleUsable(page);

  // ✅ the real guarantee: rows should be ~36/36 etc
  const rowsRendered = await ensureCompanyRowsRendered(page, 20);
  console.log(`Rows rendered after update: ${rowsRendered}`);

  await saveArtifacts(page, "04-after-update");
}

async function getHeaderDates(page) {
  const labels = page.locator(".grid-day-header .date_label");
  const count = await labels.count();
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(((await labels.nth(i).innerText().catch(() => "")) || "").trim());
  }
  return out;
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
  const m = txt.match(/(\d+(?:\.\d+)?)\s*(PTO|Sick|Time Off|Unavailable)/i);
  const hours = m ? Number(m[1]) : null;
  const type = m ? m[2].toUpperCase() : "TIME OFF";

  let t = type;
  if (t === "UNAVAILABLE") t = "TIME OFF";
  return { hours, type: t, raw: txt };
}

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
  await openSchedulesSelectAllUpdate(page);

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
  await openSchedulesSelectAllUpdate(page);

  const headerDates = await getHeaderDates(page);
  const allBlocks = await extractTimeOffFromGrid(page);
  const supportOnly = allBlocks.filter((b) => isSupportName(b.name, supportNames));

  await saveArtifacts(page, "06-week-after-scrape");

  return {
    headerDates,
    supportOnly,
  };
}
