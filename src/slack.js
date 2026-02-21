// src/slack.js
export async function postSlackMessage({ token, channel, text }) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });

  const json = await res.json().catch(() => null);
  if (!json || json.ok !== true) {
    throw new Error(`Slack post failed: ${JSON.stringify(json)}`);
  }
}
