// src/scrapeTimesheets.js
import fs from "fs";
import path from "path";

/**
 * Timesheets.com schedule scraper
 * - Logs in
 * - Goes to Schedules
 * - Select All + Update
 * - Waits for N/N counter (e.g. 39 / 39)
 * - Scrapes time-off blocks from the week grid
 *
 * NOTE: We intentionally do NOT click the "Week" tab anymore because
 * it can reset the selection state (39/39 -> 0/39).
 */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function saveDebug(page, artifactsDir, name) {
  ensureDir(artifactsDir);
  await page.screenshot({
    path: path.join(artifactsDir, `${name}.png`),
    fullPage: true,
  });
  fs.writeFileSync(
    path.join(artifactsDir, `${name}.html`),
    await page.content(),
    "utf8"
  );
}

async function waitForAnyVisible(page, selectors, opts = {}) {
  const timeout = opts.timeout ?? 60000;
  const pollMs = opts.pollMs ?? 250;
  const start = Date.now();
  const errs = [];

  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          if (await loc.isVisible().catch(() => false)) return sel;
        }
      } catch (e) {
        errs.push(`${sel}: ${String(e).slice(0, 160)}`);
      }
    }
    await page.waitForTimeout(pollMs);
  }

  throw new Error(
    `waitForAnyVisible timeout (${timeout}ms). Tried:\n- ${selectors.join(
      "\n- "
    )}\n` +
      (errs.length
        ? `\nRecent errors:\n${errs.slice(-8).join("\n")}\n`
        : "")
  );
}

async function safeClick(page, selector, opts = {}) {
  const timeout = opts.timeout ?? 60000;

  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout });
  await loc.scrollIntoViewIfNeeded();

  // Some icon-only elements are "covered"—force helps.
  await loc.click({ timeout, force: true });
}

function parseSupportNamesEnv() {
  const raw = process.env.SUPPORT_TEAM_NAMES || "";
  // allow JSON array OR newline OR comma separated
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed.map(String).map((s) => s.trim()).filter(Boolean);
  } catch (e) {}

  return raw
    .split(/\r?\n|,/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function waitForCounterReady(page, opts = {}) {
  const timeout = opts.timeout ?? 120000;
  const counterSel = opts.counterSel;

  const start = Date.now();

  while (Date.now() - start < timeout) {
    // if a loading overlay exists, wait for it to disappear
    const loading = page.locator("text=Loading...").first();
    if ((await loading.count().catch(() => 0)) > 0) {
      const isVis = await loading.isVisible().catch(() => false);
      if (isVis) {
        await page.waitForTimeout(300);
        continue;
      }
    }

    const txt = await page
      .locator(counterSel)
      .first()
      .textContent()
      .catch(() => "");

    const m = String(txt || "").match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      // ready means "b>0 and a===b"
      if (b > 0 && a === b) return { selected: a, total: b, raw: String(txt || "").trim() };
    }

    await page.waitForTimeout(350);
  }

  throw new Error(
    `Counter never reached N/N ready state within timeout. Selector: ${counterSel}`
  );
}

async function scrapeGrid(page) {
  // We’ll extract:
  // - Header date labels and their screen positions
  // - Each row name
  // - Any blocks whose text contains PTO/Sick/etc, mapped to the correct day by X position
  return await page.evaluate(() => {
    function norm(s) {
      return String(s || "").replace(/\s+/g, " ").trim();
    }

    // header labels (dates)
    const headerEls = Array.from(
      document.querySelectorAll(".grid-day-header .date_label")
    );
    const headers = headerEls
      .map((el) => ({
        label: norm(el.textContent),
        rect: el.getBoundingClientRect(),
      }))
      .filter((h) => h.label && h.rect && h.rect.width > 0);

    // row containers (robust-ish across their variants)
    const rowEls = Array.from(
      document.querySelectorAll(
        ".schedule-row-item .grid-row-off, .schedule-row-item .schedule-row, .grid-row-off.schedule-row"
      )
    );

    const rows = [];

    for (const rowEl of rowEls) {
      const nameEl = rowEl.querySelector(".name-ellipses");
      const name = norm(nameEl ? nameEl.textContent : "");
      if (!name) continue;

      // Find candidate blocks inside the row by text content
      const candidates = Array.from(rowEl.querySelectorAll("div, span"))
        .map((el) => {
          const t = norm(el.textContent);
          if (!t) return null;
          // must contain time-off keywords and a number
          if (!/(pto|sick|vacation|holiday|time off)/i.test(t)) return null;
          if (!/\d/.test(t)) return null;
          const r = el.getBoundingClientRect();
          if (!r || r.width < 5 || r.height < 5) return null;
          return { text: t, rect: r };
        })
        .filter(Boolean);

      const items = [];

      for (const c of candidates) {
        const cx = c.rect.left + c.rect.width / 2;

        // map to header by horizontal containment
        let dayLabel = null;
        for (const h of headers) {
          // allow some padding since headers may not perfectly align
          const left = h.rect.left - 8;
          const right = h.rect.right + 8;
          if (cx >= left && cx <= right) {
            dayLabel = h.label;
            break;
          }
        }
        if (!dayLabel) continue;

        items.push({
          dayLabel,
          text: c.text,
        });
      }

      if (items.length) rows.push({ name, items });
    }

    return { headers: headers.map((h) => h.label), rows };
  });
}

function parseHoursAndType(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const m = t.match(/(\d+(?:\.\d+)?)/);
  const hours = m ? Number(m[1]) : null;

  let type = "Out";
  if (/sick/i.test(t)) type = "Sick";
  else if (/pto/i.test(t)) type = "PTO";
  else if (/vacat/i.test(t)) type = "Vacation";
  else if (/holiday/i.test(t)) type = "Holiday";
  else if (/time off/i.test(t)) type = "Time Off";

  return { hours, type, raw: t };
}

export function buildResultsForDate(grid, targetYmd) {
  // Map each header label -> ymd
  const headerYmd = {};
  for (const lbl of grid.headers || []) {
    const d = new Date(lbl);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      headerYmd[lbl] = `${y}-${m}-${day}`;
    }
  }

  const out = [];
  for (const r of grid.rows || []) {
    const hits = (r.items || [])
      .filter((it) => headerYmd[it.dayLabel] === targetYmd)
      .map((it) => parseHoursAndType(it.text))
      .filter((x) => x.hours && x.hours > 0);

    if (!hits.length) continue;

    // roll up hours by type
    const totals = {
      PTO: 0,
      Sick: 0,
      Vacation: 0,
      Holiday: 0,
      "Time Off": 0,
      Out: 0,
    };
    for (const h of hits) totals[h.type] = (totals[h.type] || 0) + h.hours;

    const totalHours = Object.values(totals).reduce((a, b) => a + b, 0);

    out.push({
      name: r.name,
      hours: Math.round(totalHours * 100) / 100,
      breakdown: totals,
      raw: hits.map((h) => h.raw),
    });
  }

  return out;
}

export function filterSupportOnly(list) {
  const support = parseSupportNamesEnv();
  const allow = new Set(support.map(normalizeName));
  return (list || []).filter((p) => allow.has(normalizeName(p.name)));
}

export async function scrapeWhoIsOut(page, { artifactsDir = "artifacts" } = {}) {
  const LOGIN_URL = "https://secure.timesheets.com/default.cfm?page=Login";
  const SCHEDULES_URL = "https://secure.timesheets.com/default.cfm?page=Schedules";

  const sel = {
    username: "#username",
    password: "#password",
    loginBtn: "button.loginButton",

    // Your provided selectors:
    usersIcon: ".menu-link-container.icon i.open-menu.tour-BTS-Users",
    selectAll: "span.checkmark.cb-container-category.select-all",
    updateBtn: "div.menu-link-item.update-menu-item.indent-1.tour-BTS-Update",
    counter: "span.float-right",
  };

  const username = process.env.TS_USERNAME;
  const password = process.env.TS_PASSWORD;
  if (!username || !password) throw new Error("Missing TS_USERNAME / TS_PASSWORD env vars.");

  // Go to login
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await saveDebug(page, artifactsDir, "01-login-page");

  // Fill + login
  await page.locator(sel.username).fill(username);
  await page.locator(sel.password).fill(password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
    page.locator(sel.loginBtn).click({ force: true }),
  ]);

  await page.waitForTimeout(800);
  await saveDebug(page, artifactsDir, "02-after-login");

  // Go straight to schedules
  await page.goto(SCHEDULES_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  // Wait for schedules area to exist (ANY of these)
  await waitForAnyVisible(
    page,
    [
      "text=Calendars & Schedules",
      "text=Schedules",
      ".tsWeek",
      ".print-wrapper",
      ".ts-schedule-table",
      "table",
    ],
    { timeout: 90000 }
  );

  await saveDebug(page, artifactsDir, "03-schedules-page");

  // Open users menu
  await safeClick(page, sel.usersIcon, { timeout: 90000 });
  await page.waitForTimeout(500);

  // Select all
  await safeClick(page, sel.selectAll, { timeout: 90000 });
  await page.waitForTimeout(300);

  // Update
  await safeClick(page, sel.updateBtn, { timeout: 90000 });

  // Wait for N/N
  const counter = await waitForCounterReady(page, { counterSel: sel.counter, timeout: 150000 });
  await page.waitForTimeout(800);
  await saveDebug(page, artifactsDir, "04-after-update");

  // IMPORTANT: do NOT click Week tab (it can reset selection)
  // Instead, just wait for the grid to be stable.
  const loading = page.locator("text=Loading...").first();
  if ((await loading.count().catch(() => 0)) > 0) {
    await loading.waitFor({ state: "hidden", timeout: 120000 }).catch(() => {});
  }
  await page.waitForTimeout(1200);

  // Ensure some row names exist
  await waitForAnyVisible(page, [".name-ellipses", ".schedule-row-item", ".grid-row-off"], {
    timeout: 120000,
  });

  await saveDebug(page, artifactsDir, "05-ready-to-scrape");

  const grid = await scrapeGrid(page);

  return { counter, grid };
}
