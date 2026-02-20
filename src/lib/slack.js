import { WebClient } from "@slack/web-api";

export async function postSlack(channel, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN");
  const client = new WebClient(token);
  await client.chat.postMessage({ channel, text });
}
