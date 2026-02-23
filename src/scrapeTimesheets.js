// src/scrapeTimesheets.js
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const LOGIN_URL = "https://secure.timesheets.com/default.cfm?page=Login";
const SCHEDULES_URL = "https://secure.timesheets.com/default.cfm?page=Schedules";

async function ensureArtifactsDir() {
  await fs.mkdir("artifacts", { recursive: true });
}

async function saveDebug(page, name) {
  await ensureArtifactsDir();
  const pngPath = path.join("artifacts", `${name}.png`);
  const htmlPath = path.join("artifacts", `${name}.html`);
  await page.screenshot({ path: pngPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  console.log(`Saved screenshot: ${pngPath}`);
  console.log(`Saved HTML: ${htmlPath}`);
}

async function waitForAnyVisible(locators, timeoutMs = 45000) {
  const start = Date.now();
  let lastErr = null;

  while (Date.now() - start < timeoutMs) {
    for (const loc of locators) {
      try {
        if (await loc.first().isVisible({ timeout: 500 })) return;
      } catch (e) {
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const err = lastErr ? (lastErr.stack || String(lastErr)) : "Timed out waiting for any locator to be visible.";
  throw new Error(err);
}

function normalizeName(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function login(page, { username, password }) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await saveDebug(page, "01-login-page");

  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);

  // Click login and wait for navigation-ish
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.locator("button.loginButton").click(),
  ]);

  // After login, either we see the app shell or an error message.
  // Wait for something that only appears when logged in:
  await waitForAnyVisible(
    [
      page.locator("text=Dashboard"),
      page.locator("text=Scheduling"),
      page.locator("text=Calendars & Schedules"),
    ],
    45000
  );

  await saveDebug(page, "02-after-login");
}

async function openSchedulesAndSelectAll(page) {
  // Go directly to Schedules (more reliable than clicking side-nav)
  await page.goto(SCHEDULES_URL, { waitUntil: "domcontentloaded" });

  // Wait for the Schedules page shell
  await waitForAnyVisible(
    [
      page.locator("text=Calendars & Schedules"),
      page.locator("text=Schedule"),
      page.locator("text=Month"),
      page.locator("text=Week"),
      page.locator("#app"),
    ],
    60000
  );

  // Open people menu icon (your selector)
  const peopleIcon = page.locator("i.open-menu.tour-BTS-Users, i.fa-users-medical-pos.open-menu");
  await peopleIcon.first().click({ timeout: 30000 });

  // Click Select All checkbox (your selector)
  const selectAll = page.locator("span.checkmark.cb-container-category.select-all");
  await selectAll.first().click({ timeout: 30000 });

  // Click Update button (your selector)
  const updateBtn = page.locator("div.menu-link-item.update-menu-item");
  await updateBtn.first().click({ timeout: 30000 });

  // Wait until the counter shows X / X where X > 0 and left == right
  const counter = page.locator("span.float-right");
  const start = Date.now();
  const timeoutMs = 90000;

  while (Date.now() - start < timeoutMs) {
    const txt = (await counter.first().textContent().catch(() => "")) || "";
    const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (b > 0 && a === b) {
        await saveDebug(page, "04-after-update");
        return { selected: a, total: b };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await saveDebug(page, "99-error");
  throw new Error("Timed out waiting for selection counter to reach X / X after Update.");
}

/**
 * NOTE: Since Timesheets' DOM is complex and varies by view,
 * this is written to be *defensive*:
 * - It looks for rows containing names
 * - It looks for "PTO" / "Sick" tokens on the same row
 *
 * If you want absolute precision by column/day, we can tighten it after
 * we confirm the stable selectors for header dates + row cells.
 */
async function extractVisibleTimeOff(page, supportNames) {
  const supportSet = new Set(supportNames.map((n) => normalizeName(n)));

  // The week grid in your screenshots shows names on the left.
  // Grab visible text and look for PTO/Sick blocks.
  const rows = await page.evaluate(() => {
    // Try common row containers first; fallback to all table rows.
    const candidates = Array.from(document.querySelectorAll("table tr"));
    return candidates.map((tr) => tr.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
  });

  const entries = [];
  for (const rowText of rows) {
    // Find which support person this row belongs to
    const matchedName = supportNames.find((n) => rowText.toLowerCase().includes(n.toLowerCase()));
    if (!matchedName) continue;
    if (!supportSet.has(normalizeName(matchedName))) continue;

    // Find time-off types in the row
    const hasPto = /PTO/i.test(rowText);
    const hasSick = /\bSick\b/i.test(rowText);

    if (!hasPto && !hasSick) continue;

    // Hours often appear like "8.00" or "4.00"
    const hoursMatch = rowText.match(/\b(\d+(?:\.\d+)?)\b/);
    const hours = hoursMatch ? hoursMatch[1] : null;

    entries.push({
      name: matchedName,
      type: hasPto ? "PTO" : hasSick ? "Sick" : "Time Off",
      hours,
      approved: null, // we can tighten this once we confirm where Approved/Unapproved shows in this UI
      dayLabel: null,
    });
  }

  // De-dupe by name+type+hours
  const seen = new Set();
  const deduped = [];
  for (const e of entries) {
    const key = `${normalizeName(e.name)}|${e.type}|${e.hours || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  return deduped;
}

function formatDateLabel(ymd) {
  if (!ymd) return "Today";
  return ymd;
}

export async function scrapeWhoIsOutToday({ username, password, supportNames, dateYmd }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page, { username, password });

    const { selected, total } = await openSchedulesAndSelectAll(page);
    console.log(`Selected users: ${selected}/${total}`);

    // At this point, DO NOT click Week tab (it seems to reset selection sometimes).
    // Just scrape what's visible now.
    await saveDebug(page, "05-ready-to-scrape");

    const entries = await extractVisibleTimeOff(page, supportNames);

    return {
      dateLabel: formatDateLabel(dateYmd),
      entries,
    };
  } catch (err) {
    console.error("SCRAPE ERROR:", err?.message || err);
    try {
      await saveDebug(page, "99-error");
    } catch {}
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function scrapeSupportWeek({ username, password, supportNames, weekStartYmd }) {
  // For now, this uses the same visible-week scraping approach.
  // Once we confirm stable selectors for day headers + cells, we can map entries to exact days.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page, { username, password });

    const { selected, total } = await openSchedulesAndSelectAll(page);
    console.log(`Selected users: ${selected}/${total}`);

    await saveDebug(page, "05-ready-to-scrape-week");

    const entries = await extractVisibleTimeOff(page, supportNames);

    return {
      weekLabel: weekStartYmd || "This week",
      entries,
    };
  } catch (err) {
    console.error("SCRAPE ERROR:", err?.message || err);
    try {
      await saveDebug(page, "99-error");
    } catch {}
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}
