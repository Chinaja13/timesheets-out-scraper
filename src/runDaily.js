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

  // One line per person
  const lines = items.map(i => {
    const hrs = i.hours != null ? `${i.hours}h` : "";
    const appr = i.approved ? "" : " (UNAPPROVED)";
    return `${i.name} — ${hrs} ${i.type}${appr}`.replace(/\s+/g, " ").trim();
  });

  return `TEST (Support | Out Today) (${dateYmd})\n` + lines.join("\n");
}

async function main() {
  const TS_USERNAME = required("TS_USERNAME");
  const TS_PASSWORD = required("TS_PASSWORD");
  const SLACK_BOT_TOKEN = required("SLACK_BOT_TOKEN");
  const SLACK_CHANNEL_ID_TARGET = required("SLACK_CHANNEL_ID_TARGET"); // always set by workflow
  const SUPPORT_TEAM_NAMES = process.env.SUPPORT_TEAM_NAMES || "";
  const DATE_YMD = process.env.DATE_YMD || ""; // optional

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const result = await scrapeWhoIsOutToday(page, {
      username: TS_USERNAME,
      password: TS_PASSWORD,
      supportTeamNames: SUPPORT_TEAM_NAMES,
      artifactsDir: "artifacts",
      targetYmd: DATE_YMD || undefined,
    });

    const dateYmd = result.targetYmd || DATE_YMD || "unknown-date";
    const msg = formatDailyMessage(result.found, dateYmd);

    await postToSlack({
      token: SLACK_BOT_TOKEN,
      channel: SLACK_CHANNEL_ID_TARGET,
      text: msg,
    });

    console.log("Posted to Slack OK.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("RUN ERROR:", err?.message || err);
  process.exit(1);
});
