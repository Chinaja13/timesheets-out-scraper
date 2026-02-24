// src/runDaily.js
import { chromium } from "playwright";
import { scrapeWhoIsOutToday } from "./scrapeTimesheets.js";
import { postToSlack } from "./slack.js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

function ymdNowDenver() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${o.year}-${o.month}-${o.day}`;
}

function fmtDayLabel(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wk = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(dt);
  return `${wk} ${m}/${d}`;
}

function firstName(full) {
  const t = (full || "").trim();
  if (!t) return "";
  return t.split(/\s+/)[0];
}

async function postFailToTest(err, contextLabel) {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    const testChannel = process.env.SLACK_CHANNEL_ID_TEST;
    if (!token || !testChannel) return;

    const msg = `*${contextLabel} run did not work*\n${String(err?.message || err).slice(0, 1200)}`;
    await postToSlack({ token, channel: testChannel, text: msg });
  } catch {}
}

async function main() {
  const TS_USERNAME = required("TS_USERNAME");
  const TS_PASSWORD = required("TS_PASSWORD");

  const SLACK_BOT_TOKEN = required("SLACK_BOT_TOKEN");
  const SLACK_CHANNEL_ID_TIER2 = required("SLACK_CHANNEL_ID_TIER2");
  const SLACK_CHANNEL_ID_TEST = required("SLACK_CHANNEL_ID_TEST");

  const SUPPORT_TEAM_NAMES = required("SUPPORT_TEAM_NAMES");

  const DATE_YMD = (process.env.DATE_YMD || "").trim() || ymdNowDenver();
  const dayLabel = fmtDayLabel(DATE_YMD);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    const result = await scrapeWhoIsOutToday(page, {
      tsUsername: TS_USERNAME,
      tsPassword: TS_PASSWORD,
      dateYmd: DATE_YMD,
      supportTeamNames: SUPPORT_TEAM_NAMES,
    });

    // Decide whether to post (only if someone out)
    const items = result.supportOnly || [];
    if (!items.length) {
      console.log("No one out — no Tier2 post.");
      return;
    }

    // Daily format: no PTO/Sick
    // Full day if >=8, else “part of the day”
    const lines = [];
    lines.push(`*${dayLabel}*`);

    // One line per person; if multiple blocks for same person, choose max hours
    const byName = new Map();
    for (const it of items) {
      const cur = byName.get(it.name);
      const h = Number(it.hours || 0) || 0;
      if (!cur || h > cur) byName.set(it.name, h);
    }

    for (const [name, hours] of byName.entries()) {
      const n = firstName(name) || name;
      if (hours >= 7.99) lines.push(`${n} is out today`);
      else lines.push(`${n} will be out part of the day.`);
    }

    await postToSlack({
      token: SLACK_BOT_TOKEN,
      channel: SLACK_CHANNEL_ID_TIER2,
      text: lines.join("\n"),
    });

    console.log("Posted Tier2 daily OK.");
  } catch (err) {
    await postFailToTest(err, "Tier2");
    throw err;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("RUN ERROR:", err?.message || err);
  process.exit(1);
});
