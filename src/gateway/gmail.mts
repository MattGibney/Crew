import type { JsonObject } from "../agents/contracts.mjs";
import { boundedResponse } from "./credentials.mjs";
import { jsonObject } from "./json.mjs";

/** Fixed first-party Gmail REST adapter. Credentials stay in the trusted gateway;
 * agents select operations, never endpoints, accounts, headers or access tokens. */
export const gmailTools = [
  {
    name: "gmail_profile",
    description:
      "Read the connected Gmail mailbox identity and message counts.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_messages_list",
    description:
      "Search the connected mailbox using Gmail search syntax. Returns message/thread IDs and a bounded next-page token; call gmail_message_read to read a result.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 2048 },
        pageToken: { type: "string", maxLength: 2048 },
        maxResults: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_message_read",
    description:
      "Read one message from the connected mailbox by Gmail message ID. Returns Gmail full message data, including MIME parts with base64url bodies; attachments are not downloaded.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,256}$" },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_draft_create",
    description:
      "Create a plain-text email draft in the connected Gmail mailbox. Does not send. Requires a separately granted draft capability.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          maxLength: 320,
          pattern: "^[^\\s<>@,;]+@[^\\s<>@,;]+$",
        },
        subject: { type: "string", maxLength: 120, pattern: "^[^\\r\\n]*$" },
        body: { type: "string", maxLength: 100000 },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_message_send",
    description:
      "Send a new plain-text email from the connected Gmail mailbox to one recipient. This is an external communication; confirm the intended content and recipient under the project instructions before invoking. Requires a separately granted send capability.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          maxLength: 320,
          pattern: "^[^\\s<>@,;]+@[^\\s<>@,;]+$",
        },
        subject: { type: "string", maxLength: 120, pattern: "^[^\\r\\n]*$" },
        body: { type: "string", maxLength: 100000 },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_draft_send",
    description:
      "Send one existing Gmail draft by its draft ID. Review the draft before sending. Requires a separately granted send-draft capability.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,256}$" },
      },
      required: ["draftId"],
      additionalProperties: false,
    },
  },
] as const;

export async function gmailRequest(
  token: string,
  operation: string,
  args: JsonObject,
  signal?: AbortSignal,
  senderEmail?: string,
): Promise<JsonObject> {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me/";
  let url: URL;
  let payload: JsonObject | null = null;
  if (operation === "gmail_profile") url = new URL("profile", base);
  else if (operation === "gmail_messages_list") {
    url = new URL("messages", base);
    if (typeof args.query === "string") url.searchParams.set("q", args.query);
    if (typeof args.pageToken === "string")
      url.searchParams.set("pageToken", args.pageToken);
    url.searchParams.set("maxResults", String(args.maxResults ?? 25));
  } else if (
    operation === "gmail_message_read" &&
    typeof args.messageId === "string" &&
    /^[a-zA-Z0-9_-]{1,256}$/.test(args.messageId)
  ) {
    url = new URL(`messages/${encodeURIComponent(args.messageId)}`, base);
    url.searchParams.set("format", "full");
  } else if (
    ["gmail_draft_create", "gmail_message_send"].includes(operation) &&
    typeof args.to === "string" &&
    /^[^\s<>@,;]+@[^\s<>@,;]+$/.test(args.to) &&
    typeof args.subject === "string" &&
    !/[\r\n]/.test(args.subject) &&
    typeof args.body === "string"
  ) {
    url = new URL(
      operation === "gmail_draft_create" ? "drafts" : "messages/send",
      base,
    );
    if (!senderEmail || !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(senderEmail))
      throw new Error("Verified Gmail sender identity is required.");
    const raw = Buffer.from(
      `From: ${senderEmail}\r\nTo: ${args.to}\r\nSubject: =?UTF-8?B?${Buffer.from(args.subject).toString("base64")}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${
        Buffer.from(args.body)
          .toString("base64")
          .match(/.{1,76}/g)
          ?.join("\r\n") ?? ""
      }\r\n`,
    ).toString("base64url");
    payload =
      operation === "gmail_draft_create" ? { message: { raw } } : { raw };
  } else if (
    operation === "gmail_draft_send" &&
    typeof args.draftId === "string" &&
    /^[a-zA-Z0-9_-]{1,256}$/.test(args.draftId)
  ) {
    url = new URL("drafts/send", base);
    payload = { id: args.draftId };
  } else throw new Error("Unsupported Gmail operation.");
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    redirect: "error",
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      "Gmail account authorization or request failed. Reverify the owner connection if needed.",
    );
  }
  return jsonObject(
    JSON.parse(await boundedResponse(response, 2 * 1024 * 1024)),
  );
}

/** Explicit owner-entered OAuth bundle, never personal connector/session import. */
export function gmailOAuthBundle(material: string): JsonObject {
  const value = jsonObject(JSON.parse(material));
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "access_token",
          "expires_at",
          "refresh_token",
          "client_id",
          "client_secret",
        ].includes(key),
    ) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    /\s/.test(value.access_token) ||
    typeof value.expires_at !== "number" ||
    !Number.isFinite(value.expires_at) ||
    value.expires_at <= 0
  )
    throw new Error(
      "Gmail OAuth bundle needs access_token and expires_at (Unix milliseconds).",
    );
  for (const key of ["refresh_token", "client_id", "client_secret"])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" ||
        !value[key] ||
        /\s/.test(value[key] as string))
    )
      throw new Error("Invalid Gmail OAuth bundle field.");
  if (value.refresh_token && !value.client_id)
    throw new Error("Gmail refresh requires the owner's OAuth client_id.");
  return value;
}
