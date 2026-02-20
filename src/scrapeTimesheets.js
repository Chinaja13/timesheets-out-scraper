import { chromium } from "playwright";

/**
 * Scrape "who is out" for a given date (yyyy-MM-dd)
 * Returns: [{ name, hours, type }]
 *
 * IMPORTANT:
 * - This is built to be resilient: it extracts visible text in each day-cell.
 * - If your time-off entries are only shown via tooltip, we’ll adjust in one follow-up.
 */
export async function scrapeWhoIsOut({ dateYmd, username, password }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const BASE = "https://secure.timesheets.com";

  // -----------------------
  // 1) Login
  // -----------------------
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

  // Your fields (stable: id + name)
  await page.locator("#username, input[name='username']").first().fill(username);
  await page.locator("#password, input[name='password']").first().fill(password);

  // Your login button (stable: button text + class)
  await page.locator("button.loginButton:has-text('Login'), button:has-text('Login')").first().click();

  // Wait until logged in (networkidle is usually okay here)
  await page.waitForLoadState("networkidle");

  // -----------------------
  // 2) Go to Scheduling > Schedules
  // -----------------------
  // Instead of clicking the dropdown, we can go straight to the page you found:
  await page.goto(`${BASE}/default.cfm?page=Schedules`, { waitUntil: "networkidle" });

  // -----------------------
  // 3) Open "Users" menu, Select All, Update
  // -----------------------
  // Menu opener (stable by class + icon)
  await page
    .locator(".menu-link-container.icon, .menu-link-container:has(i.fa-users-medical)")
    .first()
    .click();

  // Select All checkbox
  // (Your markup shows an <input type="checkbox"> + span.checkmark.select-all)
  // We'll click the span (usually easier than the hidden input).
  const selectAll = page.locator("span.cb-container-category.select-all, span.checkmark.cb-container-category.select-all");
  if (await selectAll.count()) {
    await selectAll.first().click();
  } else {
    // fallback: click first checkbox inside that menu
    await page.locator(".menu-link-container input[type='checkbox'], input[type='checkbox']").first().click();
  }

  // Click Update
  await page.locator("div.update-menu-item:has-text('Update'), div.menu-link-item:has-text('Update')").first().click();

  // Wait for calendar to load
  await page.waitForLoadState("networkidle");

  // -----------------------
  // 4) Force Week view
  // -----------------------
  const weekTab = page.locator("a.tab-week:has-text('Week'), a.tab.tab-week");
  if (await weekTab.count()) {
    await weekTab.first().click();
  }
  await page.waitForTimeout(1200);

  // -----------------------
  // 5) Scrape: map day index -> date label
  // -----------------------
  // Headers look like: .grid-day-header ... .date_label "Feb 15, 2026"
  // We'll read all header labels and find which column matches dateYmd
  const result = await page.evaluate(({ dateYmd }) => {
    // Helpers
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const lower = (s) => norm(s).toLowerCase();

    function parseHeaderDateToYmd(label) {
      // label example: "Feb 15, 2026"
      // We'll try to parse in the browser locale.
      const t = Date.parse(label);
      if (Number.isNaN(t)) return null;
      const d = new Date(t);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }

    // 1) Find the week header dates
    const headerEls = Array.from(document.querySelectorAll(".grid-day-header .date_label, .grid-day-header.master-grid-cell .date_label"));
    const headers = headerEls.map((el, idx) => ({
      idx,
      text: norm(el.textContent),
      ymd: parseHeaderDateToYmd(norm(el.textContent)),
    }));

    // Find target day column index by matching ymd
    const target = headers.find((h) => h.ymd === dateYmd);
    const targetIdx = target ? target.idx : null;

    // 2) Find the schedule table
    const table = document.querySelector(".table-off.ts-schedule-table, .ts-schedule-table, .print-wrapper");
    if (!table) {
      return {
        headers,
        targetIdx,
        out: [],
        debug: { error: "Could not find schedule table container" },
      };
    }

    // 3) Each person row: you showed [data-row-id="SCHEDULE-..."] with a nested .name-ellipses
    const rowEls = Array.from(table.querySelectorAll("[data-row-id]"));

    // Heuristic: inside each row, there will be "cells" for each day.
    // We don’t know the exact selector yet, so we try a few common patterns.
    function getDayCells(rowEl) {
      // Likely there are 7 day cells after the name column
      // Try likely classes
      const candidates = [
        Array.from(rowEl.querySelectorAll(".grid-cell, .grid-day-cell, .schedule-cell")),
        Array.from(rowEl.querySelectorAll("div")).filter((d) => d.className && /cell/i.test(d.className)),
      ];
      for (const arr of candidates) {
        if (arr && arr.length >= 7) return arr;
      }
      // Fallback: grab direct children divs (minus the name container)
      const kids = Array.from(rowEl.children).filter((c) => c.tagName === "DIV");
      if (kids.length >= 7) return kids;
      return [];
    }

    function parseHoursAndType(text) {
      // Very forgiving:
      // looks for "8", "8h", "7.5", etc and keywords PTO/Sick/Vac/Holiday
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

      // hours: pick best number looking like hours
      // If your UI shows "8", "8h", "8.00", etc, this catches it.
      const nums = Array.from(t.matchAll(/(\d+(?:\.\d+)?)(?:\s*h|\s*hr|\s*hrs|\b)/g)).map((m) => Number(m[1]));
      let hours = 0;

      // If it says "full day" or has keywords but no number, default to 8
      if (nums.length) {
        // take the largest number on the cell (usually hours)
        hours = Math.max(...nums);
      } else if (type !== "Out" || t.includes("out")) {
        hours = 8;
      }

      // Only count if it truly looks like time off
      const looksLikeOut =
        isPto || isSick || isVac || isHol || t.includes("out") || t.includes("leave") || t.includes("off");

      return { looksLikeOut, hours, type };
    }

    const out = [];

    for (const rowEl of rowEls) {
      const nameEl = rowEl.querySelector(".name-ellipses");
      const name = norm(nameEl ? nameEl.textContent : "");
      if (!name) continue;

      const cells = getDayCells(rowEl);
      if (targetIdx == null || !cells.length) {
        // If we can't map the column yet, skip
        continue;
      }

      const cell = cells[targetIdx] || null;
      if (!cell) continue;

      const cellText = norm(cell.innerText || cell.textContent || "");
      if (!cellText) continue;

      const parsed = parseHoursAndType(cellText);
      if (!parsed.looksLikeOut) continue;
      if (!(parsed.hours > 0)) continue;

      out.push({ name, hours: parsed.hours, type: parsed.type, raw: cellText });
    }

    return { headers, targetIdx, out };
  }, { dateYmd });

  await browser.close();

  // Return just the clean list
  // (You can temporarily log result.headers + targetIdx if debugging)
  return (result?.out || []).map(({ name, hours, type }) => ({ name, hours, type }));
}
