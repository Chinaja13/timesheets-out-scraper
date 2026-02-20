import { chromium } from "playwright";

/**
 * Scrape "who is out" for a given date (yyyy-MM-dd)
 * Returns: [{ name, hours, type }]
 */
export async function scrapeWhoIsOut({ dateYmd, username, password }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 1) Login
  await page.goto("https://secure.timesheets.com/", { waitUntil: "domcontentloaded" });

  // ✅ YOU WILL ADJUST THESE SELECTORS to match your login page
  await page.fill('input[name="username"], input#username, input[type="email"]', username);
  await page.fill('input[name="password"], input#password, input[type="password"]', password);
  await page.click('button[type="submit"], input[type="submit"], button:has-text("Login")');

  await page.waitForLoadState("networkidle");

  // 2) Navigate to the time-off/calendar view
  // ✅ YOU WILL SET THIS to the exact page where you see time off
  // Examples could be /app/timeoff, /app/schedule, etc depending on tenant
  await page.goto("https://secure.timesheets.com/", { waitUntil: "networkidle" });

  // 3) Select the date
  // ✅ YOU WILL IMPLEMENT based on how the UI chooses a day (date picker, arrows, URL param, etc)
  // A common pattern:
  // await page.fill('input[type="date"]', dateYmd);
  // await page.press('input[type="date"]', 'Enter');

  // 4) Scrape rows
  // ✅ YOU WILL ADJUST selectors below based on the table/list Timesheets renders.
  const out = await page.evaluate(() => {
    // Example: find elements that represent a person out.
    // Update these selectors after you inspect the DOM.
    const rows = document.querySelectorAll(".timeoff-row, [data-timeoff-row], tr");
    const results = [];

    rows.forEach(r => {
      const name = (r.querySelector(".name, [data-name]")?.textContent || "").trim();
      const hoursText = (r.querySelector(".hours, [data-hours]")?.textContent || "").trim();
      const type = (r.querySelector(".type, [data-type]")?.textContent || "PTO").trim();

      const hours = Number(hoursText.replace(/[^\d.]/g, "")) || 0;

      if (name && hours > 0) results.push({ name, hours, type });
    });

    return results;
  });

  await browser.close();
  return out;
}
