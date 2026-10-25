import { createHmac, timingSafeEqual } from "crypto";
import { request } from "../agents/runtime/integrations/http";

type Creds = Record<string, string>;
const json = { "Content-Type": "application/json" };
// Both providers cap a text message at 4096 characters.
const MAX_TEXT = 4096;

/** A customer message pulled out of a provider webhook payload. */
export interface InboundMessage {
  externalId: string;
  contact: string;
  contactName?: string;
  text: string;
  /** Not a text message (photo, voice note…): we answer with a short notice instead. */
  unsupported?: boolean;
}

export interface ChannelAdapter {
  parse(body: unknown, creds: Creds): InboundMessage[];
  send(creds: Creds, contact: string, text: string): Promise<void>;
}

// --- WhatsApp Cloud API ------------------------------------------------------

interface WhatsAppPayload {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: { id: string; from: string; type: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } } }[];
      };
    }[];
  }[];
}

/** Meta signs the raw request body with the app secret (X-Hub-Signature-256: sha256=<hex>). */
export function validWhatsAppSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody).digest("hex"));
  const given = Buffer.from(header.slice("sha256=".length));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const whatsapp: ChannelAdapter = {
  parse(body, creds) {
    const out: InboundMessage[] = [];
    for (const entry of (body as WhatsAppPayload)?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        // One Meta app can serve several numbers; only answer for the connected one.
        if (!value?.messages || value.metadata?.phone_number_id !== creds.phoneNumberId) continue;
        for (const message of value.messages) {
          const name = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
          const text =
            message.text?.body ??
            message.button?.text ??
            message.interactive?.button_reply?.title ??
            message.interactive?.list_reply?.title;
          out.push({ externalId: `wa:${message.id}`, contact: message.from, contactName: name, text: text ?? "", unsupported: !text });
        }
      }
    }
    return out;
  },
  async send(creds, contact, text) {
    await request({
      url: `https://graph.facebook.com/v21.0/${encodeURIComponent(creds.phoneNumberId)}/messages`,
      method: "POST",
      headers: { ...json, Authorization: `Bearer ${creds.accessToken}` },
      data: { messaging_product: "whatsapp", to: contact, type: "text", text: { body: text.slice(0, MAX_TEXT) } },
    });
  },
};

// --- Telegram Bot API --------------------------------------------------------

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { first_name?: string; last_name?: string; username?: string };
    text?: string;
  };
}

const telegram: ChannelAdapter = {
  parse(body) {
    const update = body as TelegramUpdate;
    const message = update?.message;
    // Private chats only — in groups the bot would answer everyone's messages.
    if (!message || message.chat.type !== "private") return [];
    const from = message.from;
    const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username;
    // "/start" is what Telegram sends when someone opens the bot for the first time.
    const text = message.text === "/start" ? "Hi!" : message.text;
    return [
      {
        externalId: `tg:${message.chat.id}:${message.message_id}`,
        contact: String(message.chat.id),
        contactName: name,
        text: text ?? "",
        unsupported: !text,
      },
    ];
  },
  async send(creds, contact, text) {
    await request({
      url: `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      method: "POST",
      headers: json,
      data: { chat_id: contact, text: text.slice(0, MAX_TEXT) },
    });
  },
};

/** Points the Telegram bot's updates at our webhook; secretToken comes back in a header on every update. */
export async function setTelegramWebhook(creds: Creds, url: string, secretToken: string) {
  await request({
    url: `https://api.telegram.org/bot${creds.botToken}/setWebhook`,
    method: "POST",
    headers: json,
    data: { url, secret_token: secretToken, allowed_updates: ["message"] },
  });
}

export async function deleteTelegramWebhook(creds: Creds) {
  await request({ url: `https://api.telegram.org/bot${creds.botToken}/deleteWebhook`, method: "POST", headers: json, data: {} });
}

export const CHANNEL_ADAPTERS: Record<string, ChannelAdapter> = { whatsapp, telegram };
export const CHANNEL_PROVIDERS = Object.keys(CHANNEL_ADAPTERS) as ("whatsapp" | "telegram")[];
