import { chromium } from "playwright";
import fs from "fs";

export async function scrapeWhoIsOut({ dateYmd, username, password }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const BASE = "https://secure.timesheets.com";
  const LOGIN_URL = `${BASE}/default.cfm?page=Login`;
  const SCHEDULES_URL = `${BASE}/default.cfm?page=Schedules`;

  const shotsDir = "artifacts";
  if (!fs.existsSync(shotsDir)) fs.mkdirSync(shotsDir);

  async function snap(name) {
    const path = `${shotsDir}/${name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log("Saved screenshot:", path);
  }

  async function dumpHtml(name) {
    const path = `${shotsDir}/${name}.html`;
    const html = await page.content();
    fs.writeFileSync(path, html, "utf8");
    console.log("Saved HTML:", path);
  }

  async function safeClick(locator, label, timeout = 15000) {
    try {
      if (await locator.count()) {
        await locator.first().scrollIntoViewIfNeeded();
        await locator.first().click({ timeout });
        console.log("Clicked:", label);
        return true;
      }
    } catch (e) {
      console.log("Click failed:", label, String(e));
    }
    return false;
  }

  async function waitForAnyVisible(selectors, timeout = 30000) {
    const loc = page.locator(selectors);
    await loc.first().waitFor({ timeout, state: "visible" });
    return loc;
  }

  function reCounterText(txt) {
    // matches "0 / 39" or "39/39"
    const m = String(txt || "").match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return null;
    return { a: Number(m[1]), b: Number(m[2]) };
  }

  async function readSelectedCounter() {
    // The counter appears top-right in schedules view.
    // We’ll search for a small "x / y" text on the page and pick the one with the biggest total.
    const candidates = await page.locator("text=/\\d+\\s*\\/\\s*\\d+/").allTextContents();
    let best = null;
    for (const t of candidates) {
      const c = reCounterText(t);
      if (!c) continue;
      if (!best || c.b > best.b) best = c;
    }
    return best; // {a,b} or null
  }

  async function openUserPickerAndSelectAll() {
    // We’re trying to get from 0/39 -> 39/39

    // 1) Try clicking an icon near the counter (common patterns: fa-users, fa-user-group, etc.)
    // We’ll just click the most likely “people” icon variants on the page (schedules header area).
    const iconCandidates = [
      "i.fa-users",
      "i[class*='fa-users']",
      "i.fa-user-group",
      "i[class*='user-group']",
      "i[class*='users']",
      "i[class*='people']",
      "i[class*='group']",
      // also sometimes it’s an svg or button:
      "button:has(i[class*='users'])",
      "button:has(i[class*='group'])",
      "a:has(i[class*='users'])",
      "a:has(i[class*='group'])",
      // worst-case: click the counter itself
      "text=/\\d+\\s*\\/\\s*\\d+/"
    ];

    let opened = false;
    for (const sel of iconCandidates) {
      const ok = await safeClick(page.locator(sel), `open-user-picker via ${sel}`, 8000);
      if (ok) {
        opened = true;
        await page.waitForTimeout(600);
        break;
      }
    }

    await snap(opened ? "04a-after-open-user-picker" : "04a-user-picker-not-opened");
    await dumpHtml(opened ? "04a-after-open-user-picker" : "04a-user-picker-not-opened");

    // 2) Try "Select All"
    // Your other UI had a span.checkmark with select-all class.
    // This UI might have a checkbox label, menu item, or button.
    const selectAllCandidates = [
      "text=/select\\s*all/i",
      "label:has-text('Select All')",
      "span.cb-container-category.select-all",
      "span.checkmark.cb-container-category.select-all",
      "input[type='checkbox'] >> nth=0"
    ];

    let selected = false;
    for (const sel of selectAllCandidates) {
      const ok = await safeClick(page.locator(sel), `select-all via ${sel}`, 8000);
      if (ok) {
        selected = true;
        await page.waitForTimeout(400);
        break;
      }
    }

    // 3) Click "Update"
    const updateCandidates = [
      "text=/\\bupdate\\b/i",
      "button:has-text('Update')",
      "div:has-text('Update')"
    ];

    let updated = false;
    for (const sel of updateCandidates) {
      const ok = await safeClick(page.locator(sel), `update via ${sel}`, 8000);
      if (ok) {
        updated = true;
        // allow any loading/progress
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(1200);
        break;
      }
    }

    await snap("04b-after-selectall-update");
    await dumpHtml("04b-after-selectall-update");

    // 4) Wait for counter to reflect selection (not 0/x)
    // We’ll poll up to 30s.
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const c = await readSelectedCounter();
      if (c && c.b >= 10 && c.a > 0) {
        console.log("Counter now:", c);
        return { opened, selected, updated, counter: c };
      }
      await page.waitForTimeout(1000);
    }

    const cFinal = await readSelectedCounter();
    console.log("Counter final:", cFinal);
    return { opened, selected, updated, counter: cFinal };
  }

  try {
    // -----------------------
    // 1) Login
    // -----------------------
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await snap("01-login-page");

    await page.locator("#username, input[name='username']").first().fill(String(username || "").trim());
    await page.locator("#password, input[name='password']").first().fill(String(password || "").trim());

    await Promise.all([
      page.waitForLoadState("networkidle"),
      page.locator("button.loginButton:has-text('Login'), button:has-text('Login')").first().click(),
    ]);

    await snap("02-after-login");
    await dumpHtml("02-after-login");

    // If login failed, bail early with readable message
    const loginFailed = page.locator("text=/login failed|invalid credentials/i");
    if (await loginFailed.count()) {
      throw new Error("Login failed (invalid credentials shown on page). Check TS_USERNAME/TS_PASSWORD secrets.");
    }

    // -----------------------
    // 2) Go to Schedules
    // -----------------------
    await page.goto(SCHEDULES_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    // Wait for the Calendars & Schedules header OR any schedule grid element
    await waitForAnyVisible("text=/Calendars\\s*&\\s*Schedules/i, text=/Schedules/i, .tsWeek, .print-wrapper, table", 30000);

    await snap("03-schedules-loaded");
    await dumpHtml("03-schedules-loaded");

    // -----------------------
    // 3) Make sure users are selected (0/39 -> 39/39)
    // -----------------------
    const before = await readSelectedCounter();
    console.log("Counter before:", before);

    // If we detect 0/xx, try to open picker and select all
    if (before && before.b >= 10 && before.a === 0) {
      console.log("Detected 0 selected; attempting Select All + Update...");
      const res = await openUserPickerAndSelectAll();
      console.log("SelectAll/Update result:", res);
    } else {
      console.log("Counter does not look like 0/xx; skipping Select All step.");
    }

    // -----------------------
    // 4) Force Week view (if tab exists)
    // -----------------------
    const weekTab = page.locator("a.tab-week:has-text('Week'), a.tab.tab-week, button:has-text('Week')");
    if (await weekTab.count()) {
      await weekTab.first().click({ timeout: 15000 });
      await page.waitForTimeout(1200);
      await snap("05-week-view");
      await dumpHtml("05-week-view");
    } else {
      console.log("WARN: Week tab not found. Continuing with current view.");
      await snap("05-week-tab-not-found");
      await dumpHtml("05-week-tab-not-found");
    }

    // -----------------------
    // 5) Scrape day cells (same logic as before)
    // -----------------------
    const result = await page.evaluate(({ dateYmd }) => {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const lower = (s) => norm(s).toLowerCase();

      function parseHeaderDateToYmd(label) {
        const t = Date.parse(label);
        if (Number.isNaN(t)) return null;
        const d = new Date(t);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      }

      // Try multiple header patterns (your UI varies)
      const headerEls = Array.from(document.querySelectorAll(
        ".grid-day-header .date_label, .grid-day-header.master-grid-cell .date_label, th, .tsWeek th"
      ));

      const headers = headerEls
        .map((el, idx) => {
          const text = norm(el.textContent);
          const ymd = parseHeaderDateToYmd(text);
          return { idx, text, ymd };
        })
        .filter(h => h.text && (h.ymd || /feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|jan/i.test(h.text)));

      const target = headers.find((h) => h.ymd === dateYmd);
      const targetIdx = target ? target.idx : null;

      // Row names: in your screenshot it’s a left column with names (not .name-ellipses in this view)
      const rowNameCells = Array.from(document.querySelectorAll("td:first-child, .name-ellipses"));
      const debug = {
        headers: headers.slice(0, 20),
        targetIdx,
        rowNameCount: rowNameCells.length,
        sampleRowName: rowNameCells[0] ? norm(rowNameCells[0].textContent) : ""
      };

      function parseHoursAndType(text) {
        const t = lower(text);
        const isSick = t.includes("sick");
        const isVac = t.includes("vac");
        const isPto = t.includes("pto") || t.includes("paid time off");
        const isHol = t.includes("holiday");

        let type = "Out";
        if (isSick) type = "Sick";
        else if (isPto) type = "PTO";
        else if (isVac) type = "Vacation";
        else if (isHol) type = "Holiday";

        const nums = Array.from(t.matchAll(/(\d+(?:\.\d+)?)/g)).map((m) => Number(m[1])).filter(n => !Number.isNaN(n));
        let hours = 0;
        if (nums.length) {
          // In your cells it’s like "8.00 PTO"
          hours = Math.max(...nums);
        }

        const looksLikeOut = isPto || isSick || isVac || isHol || t.includes("out") || t.includes("leave") || t.includes("off");
        if (looksLikeOut && hours === 0) hours = 8;

        return { looksLikeOut, hours, type };
      }

      // Attempt to read the schedule grid from table rows if present
      const table = document.querySelector("table") || document.querySelector(".tsWeek") || document.body;
      const trs = Array.from(table.querySelectorAll("tr"));

      const out = [];

      for (const tr of trs) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds.length < 3) continue;

        const name = norm(tds[0].innerText || tds[0].textContent);
        if (!name) continue;

        if (targetIdx == null) continue;

        // targetIdx is based on headers array; in table form, the date columns start at td[1]
        // This mapping varies; we try a safe offset:
        const possibleCells = [
          tds[targetIdx],         // if headers include name col
          tds[targetIdx + 1],     // if headers exclude name col
          tds[targetIdx - 1]      // if headers include extra
        ].filter(Boolean);

        let cellText = "";
        for (const c of possibleCells) {
          const txt = norm(c.innerText || c.textContent || "");
          if (txt) { cellText = txt; break; }
        }
        if (!cellText) continue;

        const parsed = parseHoursAndType(cellText);
        if (!parsed.looksLikeOut) continue;
        if (!(parsed.hours > 0)) continue;

        out.push({ name, hours: parsed.hours, type: parsed.type });
      }

      return { out, debug };
    }, { dateYmd });

    console.log("DEBUG scrape:", result.debug);
    console.log("DEBUG outCount:", (result.out || []).length);

    await snap("06-after-scrape");
    await dumpHtml("06-after-scrape");

    return (result.out || []);
  } catch (e) {
    console.error("SCRAPE ERROR:", e);
    try {
      await snap("99-error");
      await dumpHtml("99-error");
    } catch {}
    throw e;
  } finally {
    await browser.close();
  }
}
