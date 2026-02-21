// src/runWeeklyLeads.js
import { chromium } from "playwright";
import { scrapeWhoIsOut, filterSupportOnly } from "./scrapeTimesheets.js";
import { postSlackMessage } from "./slack.js";

function toYmdFromLabel(label) {
  const d = new Date(label);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtHours(n) {
  const x = Math.round((Number(n) || 0) * 100) / 100;
  return String(x).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function classifyFromBreakdown(b) {
  const pto =
    (b.PTO || 0) +
    (b.Vacation || 0) +
    (b.Holiday || 0) +
    (b["Time Off"] || 0) +
    (b.Out || 0);
  const sick = b.Sick || 0;
  if (pto > 0 && sick > 0) return "PTO+Sick";
  if (sick > 0) return "Sick";
  if (pto > 0) return "PTO";
  return "Out";
}

async function main() {
  const artifactsDir = "artifacts";

  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackChannel = process.env.SLACK_CHANNEL_ID_TEST; // ALWAYS TEST CHANNEL
  if (!slackToken || !slackChannel) throw new Error("Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID_TEST.");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    const { counter, grid } = await scrapeWhoIsOut(page, { artifactsDir });

    // Build a weekly message from whatever week is visible on the grid.
    // We group items by dayLabel.
    const byDay = {}; // ymd -> [{name,hours,breakdown}]
    for (const row of grid.rows || []) {
      for (const it of row.items || []) {
        const ymd = toYmdFromLabel(it.dayLabel);
        if (!ymd) continue;

        const m = String(it.text || "").match(/(\d+(?:\.\d+)?)/);
        const hours = m ? Number(m[1]) : 0;
        if (!hours) continue;

        let type = "Out";
        if (/sick/i.test(it.text)) type = "Sick";
        else if (/pto/i.test(it.text)) type = "PTO";
        else if (/vacat/i.test(it.text)) type = "Vacation";
        else if (/holiday/i.test(it.text)) type = "Holiday";
        else if (/time off/i.test(it.text)) type = "Time Off";

        if (!byDay[ymd]) byDay[ymd] = [];
        byDay[ymd].push({
          name: row.name,
          hours,
          breakdown: { [type]: hours },
        });
      }
    }

    // Roll up per person per day, then filter to support
    const dayKeys = Object.keys(byDay).sort();
    const blocks = [];

    for (const ymd of dayKeys) {
      const merged = {};
      for (const entry of byDay[ymd]) {
        const k = entry.name;
        if (!merged[k]) merged[k] = { name: entry.name, hours: 0, breakdown: {} };
        merged[k].hours += entry.hours;
        for (const bt of Object.keys(entry.breakdown)) {
          merged[k].breakdown[bt] = (merged[k].breakdown[bt] || 0) + entry.breakdown[bt];
        }
      }

      const list = filterSupportOnly(Object.values(merged)).sort((a, b) => b.hours - a.hours);

      if (!list.length) {
        blocks.push(`*${ymd}*\nNo one out`);
      } else {
        const lines = list.map(
          (p) => `${p.name} — ${fmtHours(p.hours)}h (${classifyFromBreakdown(p.breakdown)})`
        );
        blocks.push(`*${ymd}*\n${lines.join("\n")}`);
      }
    }

    const msg =
      `*TEST WEEKLY* | Selected ${counter.selected}/${counter.total}\n\n` +
      (blocks.length ? blocks.join("\n\n") : "_No results found on the week grid._");

    await postSlackMessage({ token: slackToken, channel: slackChannel, text: msg });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("RUN ERROR:", e);
  process.exit(1);
});
