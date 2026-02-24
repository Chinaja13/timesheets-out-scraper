// src/runDaily.js
import { chromium } from "playwright";
import { scrapeWhoIsOutToday } from "./scrapeTimesheets.js";
import { postToSlack } from "./slack.js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

function formatDailyMessage(items, dateYmd) {
  if (!items || items.length === 0) {
    return `TEST (Support | Out Today) (${dateYmd})\nNobody is marked out today.`;
  }

  const lines = items.map((i) => {
    const hrs = i.hours != null ? `${i.hours}h` : "";
    const appr = i.approved === false ? " (UNAPPROVED)" : "";
    const type = i.type || "Time Off";
    return `${i.name} — ${hrs} ${type}${appr}`.replace(/\s+/g, " ").trim();
  });

  return `TEST (Support | Out Today) (${dateYmd})\n` + lines.join("\n");
}

async function main() {
  const TS_USERNAME = required("TS_USERNAME");
  const TS_PASSWORD = required("TS_PASSWORD");

  const SLACK_BOT_TOKEN = required("SLACK_BOT_TOKEN");
  const SLACK_CHANNEL_ID_TARGET = required("SLACK_CHANNEL_ID_TARGET");

  const SUPPORT_TEAM_NAMES = required("SUPPORT_TEAM_NAMES");
  const DATE_YMD = (process.env.DATE_YMD || "").trim(); // optional

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    const result = await scrapeWhoIsOutToday(page, {
      // ✅ These key names MUST match scrapeTimesheets.js
      tsUsername: TS_USERNAME,
      tsPassword: TS_PASSWORD,
      dateYmd: DATE_YMD || undefined,
      supportTeamNames: SUPPORT_TEAM_NAMES,
    });

    const msg = formatDailyMessage(result.supportOnly ?? result.found ?? [], result.dateYmd || DATE_YMD || "today");

    await postToSlack({
      token: SLACK_BOT_TOKEN,
      channel: SLACK_CHANNEL_ID_TARGET,
      text: msg,
    });

    console.log("Posted to Slack OK.");
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("RUN ERROR:", err?.message || err);
  process.exit(1);
});
