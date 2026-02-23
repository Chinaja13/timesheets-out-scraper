// src/slack.js
export async function postToSlack({ token, channel, text }) {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok || !data || data.ok !== true) {
    const msg = data?.error ? `Slack API error: ${data.error}` : `Slack HTTP error: ${resp.status}`;
    throw new Error(msg);
  }

  return data;
}
