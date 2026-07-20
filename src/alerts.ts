// Alert adapter: Slack webhook (§17.3).
//
// Posts a compact message when a dead-letter row is created. Same adapter
// pattern as MICT-PIPE-001.
//
// Environment:
//   SLACK_WEBHOOK_URL: the incoming webhook URL.
//   If unset, alerts are silently dropped (safe default for dev/test).

export interface AlertPayload {
  traceId?: string;
  stage: string;
  error: string;
  itemType: string;
}

export async function sendSlackAlert(payload: AlertPayload): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.log(`[ALERT-DRY-RUN] stage=${payload.stage} error=${payload.error.slice(0, 80)}`);
    return;
  }

  const body = JSON.stringify({
    text: `*Document Intelligence Alert* - ${payload.stage}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Document Intelligence Alert*`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Stage:*\n${payload.stage}` },
          { type: "mrkdwn", text: `*Item:*\n${payload.itemType}` },
          {
            type: "mrkdwn",
            text: `*Trace ID:*\n${payload.traceId ?? "N/A"}`,
          },
          {
            type: "mrkdwn",
            text: `*Error:*\n${payload.error.slice(0, 200)}`,
          },
        ],
      },
    ],
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack alert failed: ${res.status} ${body}`);
  }
}
