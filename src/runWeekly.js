// src/runWeekly.js
import { scrapeSupportWeek } from "./scrapeTimesheets.js";
import { postToSlack } from "./slack.js";

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) return null;
  return String(v).trim();
}

function parseSupportNames(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const TS_USERNAME = mustEnv("TS_USERNAME");
  const TS_PASSWORD = mustEnv("TS_PASSWORD");

  const SLACK_BOT_TOKEN = mustEnv("SLACK_BOT_TOKEN");
  const SLACK_CHANNEL_ID_TEST = mustEnv("SLACK_CHANNEL_ID_TEST");

  const SUPPORT_TEAM_NAMES = parseSupportNames(mustEnv("SUPPORT_TEAM_NAMES"));

  if (!TS_USERNAME || !TS_PASSWORD) throw new Error("RUN ERROR: Missing TS_USERNAME or TS_PASSWORD.");
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID_TEST)
    throw new Error("RUN ERROR: Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID_TEST.");
  if (!SUPPORT_TEAM_NAMES.length) throw new Error("RUN ERROR: SUPPORT_TEAM_NAMES is empty.");

  const weekStartYmd = (process.env.WEEK_START_YMD || "").trim() || null;

  const result = await scrapeSupportWeek({
    username: TS_USERNAME,
    password: TS_PASSWORD,
    supportNames: SUPPORT_TEAM_NAMES,
    weekStartYmd,
  });

  const lines = [];
  lines.push(`*TEST (Leads | Support week view)*`);
  lines.push(`Week: ${result.weekLabel}`);
  lines.push("");

  if (!result.entries.length) {
    lines.push("No support time-off found for this week.");
  } else {
    for (const e of result.entries) {
      const approvedTxt = e.approved === true ? "Approved" : e.approved === false ? "Unapproved" : "Unknown";
      const dayTxt = e.dayLabel ? `${e.dayLabel}` : "";
      const hoursTxt = e.hours ? `${e.hours}h` : "";
      const typeTxt = e.type || "Time Off";
      lines.push(`• ${dayTxt} — *${e.name}* — ${hoursTxt} (${typeTxt}) — ${approvedTxt}`.replace(" —  ", " — "));
    }
  }

  await postToSlack({
    token: SLACK_BOT_TOKEN,
    channel: SLACK_CHANNEL_ID_TEST,
    text: lines.join("\n"),
  });

  console.log("Posted weekly to Slack test channel:", SLACK_CHANNEL_ID_TEST);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
