// src/runDaily.js
import { chromium } from "playwright";
import { scrapeWhoIsOut, buildResultsForDate, filterSupportOnly } from "./scrapeTimesheets.js";
import { postSlackMessage } from "./slack.js";

function fmtHours(n) {
  const x = Math.round((Number(n) || 0) * 100) / 100;
  return String(x).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function buildTier2Message(list) {
  if (!list.length) return null;

  const parts = list.map((p) => {
    if (p.hours >= 7.99) return `${p.name} is out today`;
    return `${p.name} is out ${fmtHours(p.hours)} hours today`;
  });

  if (parts.length === 1) return `@channel ${parts[0]}.`;
  if (parts.length === 2) return `@channel ${parts[0]}, and ${parts[1]}.`;
  return `@channel ${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}.`;
}

async function main() {
  const artifactsDir = "artifacts";
  const ymd = process.env.DATE_YMD;
  if (!ymd) throw new Error("Missing DATE_YMD env var (yyyy-mm-dd).");

  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackChannel = process.env.SLACK_CHANNEL_ID_TEST; // ALWAYS TEST CHANNEL
  if (!slackToken || !slackChannel) throw new Error("Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID_TEST.");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    const { counter, grid } = await scrapeWhoIsOut(page, { artifactsDir });

    const allOut = buildResultsForDate(grid, ymd);
    const supportOut = filterSupportOnly(allOut);

    const msg = buildTier2Message(supportOut);

    const header =
      `*TEST DAILY* (${ymd}) | Selected ${counter.selected}/${counter.total}\n` +
      (msg ? msg : "_No support team members marked out today._");

    await postSlackMessage({ token: slackToken, channel: slackChannel, text: header });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("RUN ERROR:", e);
  process.exit(1);
});
