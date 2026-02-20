import { scrapeWhoIsOut } from "./scrapeTimesheets.js";
import { postSlack } from "./lib/slack.js";
import { ymdInDenver } from "./lib/date.js";
import { makeSupportSetFromEnv, isSupportName } from "./lib/supportFilter.js";
import { buildTier2Daily, sortOutList } from "./lib/format.js";

async function main() {
  const dateYmd = process.env.DATE_YMD || ymdInDenver(new Date());

  const username = process.env.TS_USERNAME;
  const password = process.env.TS_PASSWORD;
  if (!username || !password) throw new Error("Missing TS_USERNAME / TS_PASSWORD");

  const tier2Channel = process.env.SLACK_CHANNEL_ID_TIER2;
  if (!tier2Channel) throw new Error("Missing SLACK_CHANNEL_ID_TIER2");

  const supportSet = makeSupportSetFromEnv();

  const raw = await scrapeWhoIsOut({ dateYmd, username, password });

  const filtered = raw.filter(p => isSupportName(p.name, supportSet));
  const outList = sortOutList(filtered);

  if (!outList.length) {
    console.log("Nobody out — no post.");
    return;
  }

  const msg = buildTier2Daily(outList);
  await postSlack(tier2Channel, msg);
  console.log("Posted Tier2:", msg);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
