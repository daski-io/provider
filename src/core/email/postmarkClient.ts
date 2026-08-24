import { boundedFetch } from "../security/outboundHttp.js";

export interface PostmarkSendResponse {
  ok: boolean;
  status: number;
  messageId: string | null;
}

export async function sendPostmarkMessage(
  token: string,
  body: Record<string, unknown>,
): Promise<PostmarkSendResponse> {
  const response = await boundedFetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify(body),
  }, {
    maxResponseBytes: 64 * 1_024,
    allowedContentTypes: ["application/json"],
  });
  let parsed: { MessageID?: string } = {};
  const text = response.text();
  try {
    parsed = text ? JSON.parse(text) as { MessageID?: string } : {};
  } catch {
    parsed = {};
  }
  return {
    ok: response.ok,
    status: response.status,
    messageId: parsed.MessageID ?? null,
  };
}
