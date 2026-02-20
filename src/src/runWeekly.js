import { scrapeWhoIsOut } from "./scrapeTimesheets.js";
import { postSlack } from "./lib/slack.js";
import { ymdInDenver, addDaysYmd } from "./lib/date.js";
import { makeSupportSetFromEnv, isSupportName } from "./lib/supportFilter.js";
import { buildLeadsDayBlock, sortOutList } from "./lib/format.js";

function labelForYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    weekday: "long",
    month: "numeric",
    day: "numeric",
  }).format(dt);
}

async function main() {
  const username = process.env.TS_USERNAME;
  const password = process.env.TS_PASSWORD;
  if (!username || !password) throw new Error("Missing TS_USERNAME / TS_PASSWORD");

  const leadsChannel = process.env.SLACK_CHANNEL_ID_LEADS;
  if (!leadsChannel) throw new Error("Missing SLACK_CHANNEL_ID_LEADS");

  const supportSet = makeSupportSetFromEnv();

  // Determine Monday of current week in Denver
  const today = new Date();
  const todayYmd = ymdInDenver(today);

  // Find Monday by checking weekday label (simple approach)
  // We'll step backwards up to 6 days until we hit Monday.
  let mondayYmd = todayYmd;
  for (let i = 0; i < 7; i++) {
    const [yy, mm, dd] = mondayYmd.split("-").map(Number);
    const dt = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short" }).format(dt);
    if (weekday === "Mon") break;
    mondayYmd = addDaysYmd(mondayYmd, -1);
  }

  const blocks = [];
  for (let i = 0; i < 5; i++) {
    const dayYmd = addDaysYmd(mondayYmd, i);
    const raw = await scrapeWhoIsOut({ dateYmd: dayYmd, username, password });
    const filtered = raw.filter(p => isSupportName(p.name, supportSet));
    const outList = sortOutList(filtered);
    blocks.push(buildLeadsDayBlock(labelForYmd(dayYmd), outList));
  }

  const msg =
    `*Support coverage this week* (${labelForYmd(mondayYmd)}–${labelForYmd(addDaysYmd(mondayYmd, 4))})\n\n` +
    blocks.join("\n\n");

  await postSlack(leadsChannel, msg);
  console.log("Posted Leads weekly.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
