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

  async function waitForOverlayToClear(timeoutMs = 60000) {
    // Overlay often shows "Loading..." in the middle
    const overlay = page.locator("text=/Loading\\.\\.\\./i");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if ((await overlay.count()) === 0) return;
        const visible = await overlay.first().isVisible().catch(() => false);
        if (!visible) return;
      } catch {
        return;
      }
      await page.waitForTimeout(500);
    }
    // Don't hard fail; just log and keep going
    console.log("WARN: Loading overlay still visible after timeout");
  }

  function parseCounter(txt) {
    const m = String(txt || "").match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return null;
    return { selected: Number(m[1]), total: Number(m[2]) };
  }

  async function readCounter() {
    const counterLoc = page.locator(
      "#app > div > div.menu-link.no-print.wide-counter-layout > span > div > span.float-right"
    );
    if ((await counterLoc.count()) === 0) return null;
    const txt = await counterLoc.first().innerText().catch(() => "");
    return parseCounter(txt);
  }

  async function waitForCounterNN(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const c = await readCounter();
      if (c && c.total > 0 && c.selected === c.total) return c;
      await page.waitForTimeout(500);
    }
    return await readCounter();
  }

  async function clickWithRetry(locator, label, attempts = 3, delayMs = 700) {
    for (let i = 1; i <= attempts; i++) {
      try {
        await locator.first().scrollIntoViewIfNeeded();
        await locator.first().click({ timeout: 15000 });
        console.log(`Clicked: ${label} (attempt ${i})`);
        return true;
      } catch (e) {
        console.log(`Click failed: ${label} (attempt ${i})`, String(e));
        if (i < attempts) await page.waitForTimeout(delayMs);
      }
    }
    return false;
  }

  async function ensureAllUsersSelected() {
    // These are YOUR selectors (stable)
    const peopleIcon = page.locator(
      "#app > div > div.menu-link.no-print.wide-counter-layout > div > div.menu-link-container.icon > i"
    );

    const selectAllCheckmark = page.locator(
      "#app > div > div.noPrint > div.slide-menu > nav > div.menu-links.menu-select-all > div.align-left > div > label > span.checkmark.cb-container-category.select-all"
    );

    const updateBtn = page.locator(
      "#app > div > div.noPrint > div.slide-menu > nav > div.menu-links.top-bar > div.menu-link-item.update-menu-item.indent-1.tour-BTS-Update"
    );

    // Wait for page to be usable
    await waitForOverlayToClear(60000);

    const before = await readCounter();
    console.log("Counter before:", before);

    // If already N/N, we're good
    if (before && before.total > 0 && before.selected === before.total) {
      console.log("Already selected all users.");
      return before;
    }

    // If 0/0, the UI isn't populated yet. Wait for it to become something real (0/39)
    if (!before || (before.total === 0 && before.selected === 0)) {
      console.log("Counter is 0/0 — waiting for it to populate...");
      const populated = await waitForCounterToHaveTotal(60000);
      console.log("Counter after populate wait:", populated);
    }

    // Open the slide-menu (people icon)
    await clickWithRetry(peopleIcon, "People icon (open user picker)", 4, 900);
    await page.waitForTimeout(800);

    // Click Select All
    await clickWithRetry(selectAllCheckmark, "Select All checkmark", 4, 900);

    // Click Update
    await clickWithRetry(updateBtn, "Update button", 4, 900);

    // After update, there is often a loading overlay and the counter updates
    await waitForOverlayToClear(90000);

    const after = await waitForCounterNN(90000);
    console.log("Counter after:", after);

    return after;
  }

  async function waitForCounterToHaveTotal(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const c = await readCounter();
      if (c && c.total > 0) return c;
      await page.waitForTimeout(500);
    }
    return await readCounter();
  }

  try {
    // 1) Login
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await snap("01-login-page");

    await page.locator("#username, input[name='username']").first().fill(String(username || "").trim());
    await page.locator("#password, input[name='password']").first().fill(String(password || "").trim());

    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.locator("button.loginButton:has-text('Login'), button:has-text('Login')").first().click(),
    ]);

    // Let redirects / app boot happen
    await page.waitForLoadState("networkidle").catch(() => {});
    await waitForOverlayToClear(60000);

    await snap("02-after-login");
    await dumpHtml("02-after-login");

    // 2) Go to Schedules directly
    await page.goto(SCHEDULES_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await waitForOverlayToClear(90000);

    await snap("03-schedules-loaded");
    await dumpHtml("03-schedules-loaded");

    // 3) Ensure all users selected (wait for 39/39)
    const counter = await ensureAllUsersSelected();
    await snap("04-after-update");
    await dumpHtml("04-after-update");

    if (!counter || !counter.total || counter.selected !== counter.total) {
      console.log("WARN: Did not reach N/N selection. Counter=", counter);
      // continue anyway; maybe still loads enough to scrape
    }

    // 4) Go to Week view
    const weekTab = page.locator("a.tab-week:has-text('Week'), a.tab.tab-week, button:has-text('Week')");
    if (await weekTab.count()) {
      await clickWithRetry(weekTab, "Week tab", 3, 900);
      await page.waitForLoadState("networkidle").catch(() => {});
      await waitForOverlayToClear(90000);
    }

    await snap("05-week-view");
    await dumpHtml("05-week-view");

    // 5) Scrape (kept simple; your formatters handle filtering support)
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

      // Headers (works with both old/new schedule table variants)
      const headerEls = Array.from(document.querySelectorAll(
        ".grid-day-header .date_label, .grid-day-header.master-grid-cell .date_label, thead th, .tsWeek th, .table ts-schedule-table-header th"
      ));

      const headers = headerEls
        .map((el, idx) => {
          const text = norm(el.textContent);
          const ymd = parseHeaderDateToYmd(text);
          return { idx, text, ymd };
        })
        .filter(h => h.text);

      const targetHeader = headers.find(h => h.ymd === dateYmd) || null;

      function parseHoursAndType(text) {
        const t = lower(text);
        const isSick = t.includes("sick");
        const isPto = t.includes("pto") || t.includes("paid time off");
        const isVac = t.includes("vac");
        const isHol = t.includes("holiday");

        let type = "Out";
        if (isSick) type = "Sick";
        else if (isPto) type = "PTO";
        else if (isVac) type = "Vacation";
        else if (isHol) type = "Holiday";

        const nums = Array.from(t.matchAll(/(\d+(?:\.\d+)?)/g)).map(m => Number(m[1])).filter(n => !Number.isNaN(n));
        let hours = nums.length ? Math.max(...nums) : 0;

        const looksOut = isPto || isSick || isVac || isHol || t.includes("time off") || t.includes("unavailable");
        if (looksOut && hours === 0) hours = 8;

        return { looksOut, hours, type };
      }

      const out = [];

      // Strategy A: schedule grid table rows
      const tables = Array.from(document.querySelectorAll("table"));
      const table = tables.length ? tables[0] : null;
      const trs = table ? Array.from(table.querySelectorAll("tr")) : [];

      for (const tr of trs) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds.length < 3) continue;

        const name = norm(tds[0].innerText || tds[0].textContent);
        if (!name) continue;

        if (!targetHeader) continue;

        // try a couple offsets
        const idxs = [targetHeader.idx, targetHeader.idx + 1, targetHeader.idx - 1].filter(i => i >= 1 && i < tds.length);
        let cellText = "";
        for (const i of idxs) {
          const txt = norm(tds[i].innerText || tds[i].textContent || "");
          if (txt) { cellText = txt; break; }
        }
        if (!cellText) continue;

        const parsed = parseHoursAndType(cellText);
        if (!parsed.looksOut || parsed.hours <= 0) continue;

        out.push({ name, hours: parsed.hours, type: parsed.type });
      }

      return {
        out,
        debug: {
          targetHeader,
          headerSample: headers.slice(0, 12),
          foundTables: tables.length,
          rowsConsidered: trs.length
        }
      };
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
