// src/slack.js
export async function postToSlack({ token, channel, text }) {
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN.");
  if (!channel) throw new Error("Missing Slack channel id.");

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error || "unknown_error"}`);
  }
  return data;
}
