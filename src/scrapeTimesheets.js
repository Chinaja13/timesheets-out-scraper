import { chromium } from "playwright";
import fs from "fs";

export async function scrapeWhoIsOut({ dateYmd, username, password }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const BASE = "https://secure.timesheets.com";
  const LOGIN_URL = `${BASE}/default.cfm?page=Login`;
  const SCHEDULES_URL = `${BASE}/default.cfm?page=Schedules`;

  // Make sure screenshots folder exists for GitHub artifact upload
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

  try {
    // -----------------------
    // 1) Login (use the exact login page you provided)
    // -----------------------
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await snap("01-login-page");

    await page.locator("#username, input[name='username']").first().fill(username);
    await page.locator("#password, input[name='password']").first().fill(password);

    // Click Login and wait for navigation/settle
    await Promise.all([
      page.waitForLoadState("networkidle"),
      page.locator("button.loginButton:has-text('Login'), button:has-text('Login')").first().click(),
    ]);

    await snap("02-after-login");
    await dumpHtml("02-after-login");

    // -----------------------
    // 2) Go to Schedules
    // -----------------------
    await page.goto(SCHEDULES_URL, { waitUntil: "domcontentloaded" });

    // Some Timesheets pages keep loading async; wait for something schedule-ish.
    // We know names appear as .name-ellipses in your inspected DOM
    await page.waitForTimeout(1200);

    // Wait up to 30s for either schedule wrapper or any schedule row name.
    const scheduleReady = page.locator(".print-wrapper, .ts-schedule-table, .table-off, .name-ellipses");
    await scheduleReady.first().waitFor({ timeout: 30000 });

    await snap("03-schedules-loaded");
    await dumpHtml("03-schedules-loaded");

    // -----------------------
    // 3) Attempt: Users menu -> Select All -> Update (but don't hard-fail if UI differs)
    // -----------------------
    const menuIcon = page.locator(".menu-link-container.icon, .menu-link-container:has(i.fa-users-medical)");
    if (await menuIcon.count()) {
      // Ensure it's visible/clickable
      await menuIcon.first().scrollIntoViewIfNeeded();
      await menuIcon.first().click({ timeout: 15000 });
      await page.waitForTimeout(700);

      // Click "Select All" (prefer the span you showed)
      const selectAll = page.locator("span.cb-container-category.select-all, span.checkmark.cb-container-category.select-all");
      if (await selectAll.count()) {
        await selectAll.first().click({ timeout: 15000 });
        await page.waitForTimeout(300);
      } else {
        // Fallback: first checkbox inside the opened menu
        const anyCheckbox = page.locator("input[type='checkbox']").first();
        if (await anyCheckbox.count()) await anyCheckbox.click({ timeout: 15000 });
      }

      // Click Update
      const updateBtn = page.locator("div.update-menu-item:has-text('Update'), div.menu-link-item:has-text('Update')");
      if (await updateBtn.count()) {
        await updateBtn.first().click({ timeout: 15000 });
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1200);
      }

      await snap("04-after-update");
    } else {
      console.log("WARN: Users menu icon not found on this page. Skipping SelectAll/Update.");
      await snap("04-menu-icon-not-found");
    }

    // -----------------------
    // 4) Force Week view (if tab exists)
    // -----------------------
    const weekTab = page.locator("a.tab-week:has-text('Week'), a.tab.tab-week");
    if (await weekTab.count()) {
      await weekTab.first().click({ timeout: 15000 });
      await page.waitForTimeout(1200);
      await snap("05-week-view");
    } else {
      console.log("WARN: Week tab not found. Continuing with current view.");
      await snap("05-week-tab-not-found");
    }

    // -----------------------
    // 5) Scrape target day from headers + rows
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

      // Headers (your DOM shows .grid-day-header .date_label)
      const headerEls = Array.from(document.querySelectorAll(".grid-day-header .date_label, .grid-day-header.master-grid-cell .date_label"));
      const headers = headerEls.map((el, idx) => ({
        idx,
        text: norm(el.textContent),
        ymd: parseHeaderDateToYmd(norm(el.textContent)),
      }));

      const target = headers.find((h) => h.ymd === dateYmd);
      const targetIdx = target ? target.idx : null;

      // Rows: your DOM shows [data-row-id] + .name-ellipses for the name
      const table =
        document.querySelector(".print-wrapper, .table-off.ts-schedule-table, .ts-schedule-table") || document.body;

      const rowEls = Array.from(table.querySelectorAll("[data-row-id]"));

      function getDayCells(rowEl) {
        // Try common cell classes first
        const a = Array.from(rowEl.querySelectorAll(".grid-cell, .grid-day-cell, .schedule-cell"));
        if (a.length >= 7) return a;

        // If the row is a flex row, children often represent columns
        const kids = Array.from(rowEl.children).filter((c) => c.tagName === "DIV");
        if (kids.length >= 7) return kids;

        return [];
      }

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

        const nums = Array.from(t.matchAll(/(\d+(?:\.\d+)?)(?:\s*h|\s*hr|\s*hrs|\b)/g)).map((m) => Number(m[1]));
        let hours = 0;
        if (nums.length) hours = Math.max(...nums);
        else if (type !== "Out" || t.includes("out")) hours = 8;

        const looksLikeOut =
          isPto || isSick || isVac || isHol || t.includes("out") || t.includes("leave") || t.includes("off");

        return { looksLikeOut, hours, type };
      }

      const out = [];
      const debug = {
        headers,
        targetIdx,
        rowCount: rowEls.length,
        sampleRowName: "",
        sampleCellsCount: 0,
        sampleCellText: "",
      };

      for (const rowEl of rowEls) {
        const nameEl = rowEl.querySelector(".name-ellipses");
        const name = norm(nameEl ? nameEl.textContent : "");
        if (!name) continue;

        if (!debug.sampleRowName) debug.sampleRowName = name;

        const cells = getDayCells(rowEl);
        if (!debug.sampleCellsCount && cells.length) debug.sampleCellsCount = cells.length;

        if (targetIdx == null || !cells.length) continue;

        const cell = cells[targetIdx] || null;
        if (!cell) continue;

        const cellText = norm(cell.innerText || cell.textContent || "");
        if (!debug.sampleCellText && cellText) debug.sampleCellText = cellText;

        if (!cellText) continue;

        const parsed = parseHoursAndType(cellText);
        if (!parsed.looksLikeOut) continue;
        if (!(parsed.hours > 0)) continue;

        out.push({ name, hours: parsed.hours, type: parsed.type, raw: cellText });
      }

      return { out, debug };
    }, { dateYmd });

    // Log debug into Actions output
    console.log("DEBUG headers:", result?.debug?.headers);
    console.log("DEBUG targetIdx:", result?.debug?.targetIdx);
    console.log("DEBUG rowCount:", result?.debug?.rowCount);
    console.log("DEBUG sampleRowName:", result?.debug?.sampleRowName);
    console.log("DEBUG sampleCellsCount:", result?.debug?.sampleCellsCount);
    console.log("DEBUG sampleCellText:", result?.debug?.sampleCellText);
    console.log("DEBUG outCount:", (result?.out || []).length);
    if (result?.out?.length) console.log("DEBUG outSample:", result.out.slice(0, 5));

    await snap("06-after-scrape");
    await dumpHtml("06-after-scrape");

    return (result?.out || []).map(({ name, hours, type }) => ({ name, hours, type }));
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
