// src/runWeekly.js
import { chromium } from "playwright";
import { scrapeSupportWeek } from "./scrapeTimesheets.js";
import { postToSlack } from "./slack.js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

function firstName(full) {
  const t = (full || "").trim();
  if (!t) return "";
  return t.split(/\s+/)[0];
}

function fmtHours(n) {
  const x = Math.round((Number(n) || 0) * 100) / 100;
  let s = String(x);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function parseHeaderToYmd(label) {
  // label like "Feb 26, 2026"
  const t = Date.parse(label);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayNameFromYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(dt);
}

function mdFromYmd(ymd) {
  const [, m, d] = ymd.split("-");
  return `${Number(m)}/${Number(d)}`;
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
  const SLACK_CHANNEL_ID_LEADS = required("SLACK_CHANNEL_ID_LEADS");
  const SLACK_CHANNEL_ID_TEST = required("SLACK_CHANNEL_ID_TEST");

  const SUPPORT_TEAM_NAMES = required("SUPPORT_TEAM_NAMES");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    const { headerDates, supportOnly } = await scrapeSupportWeek(page, {
      tsUsername: TS_USERNAME,
      tsPassword: TS_PASSWORD,
      supportTeamNames: SUPPORT_TEAM_NAMES,
    });

    // Map dayIdx -> ymd for this visible week
    const ymdByIdx = (headerDates || []).map(parseHeaderToYmd);

    // We want Mon–Fri only. In this UI the columns are Sunday..Saturday (0..6).
    // Monday=1 ... Friday=5
    const days = [
      { idx: 1, label: "Monday" },
      { idx: 2, label: "Tuesday" },
      { idx: 3, label: "Wednesday" },
      { idx: 4, label: "Thursday" },
      { idx: 5, label: "Friday" },
    ];

    const monYmd = ymdByIdx[1];
    const friYmd = ymdByIdx[5];

    const rangeLabel =
      monYmd && friYmd
        ? `Support coverage this coming week (Mon ${mdFromYmd(monYmd)}–Fri ${mdFromYmd(friYmd)})`
        : "Support coverage this coming week";

    // Build by dayIdx and by person (take max hours per person for that day)
    const byDay = new Map(); // idx -> Map(name -> {hours,type})
    for (const d of days) byDay.set(d.idx, new Map());

    for (const it of supportOnly || []) {
      if (!byDay.has(it.dayIdx)) continue;
      const m = byDay.get(it.dayIdx);

      const h = Number(it.hours || 0) || 0;
      const t = (it.type || "TIME OFF").toUpperCase();

      const existing = m.get(it.name);
      if (!existing || h > existing.hours) m.set(it.name, { hours: h, type: t });
    }

    const lines = [];
    lines.push(`*${rangeLabel}*`);
    lines.push("");

    for (const d of days) {
      const ymd = ymdByIdx[d.idx];
      const md = ymd ? mdFromYmd(ymd) : "";
      lines.push(`${d.label} ${md}`.trim());

      const m = byDay.get(d.idx);
      if (!m || m.size === 0) {
        lines.push("No one out");
        lines.push("");
        continue;
      }

      // Sort by hours desc then name
      const arr = Array.from(m.entries()).map(([name, info]) => ({ name, ...info }));
      arr.sort((a, b) => (b.hours - a.hours) || a.name.localeCompare(b.name));

      for (const p of arr) {
        const fn = firstName(p.name) || p.name;
        lines.push(`${fn} is out ${fmtHours(p.hours)} Hours ${p.type}`);
      }
      lines.push("");
    }

    await postToSlack({
      token: SLACK_BOT_TOKEN,
      channel: SLACK_CHANNEL_ID_LEADS,
      text: lines.join("\n").trim(),
    });

    console.log("Posted Leads weekly OK.");
  } catch (err) {
    await postFailToTest(err, "Leads");
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
