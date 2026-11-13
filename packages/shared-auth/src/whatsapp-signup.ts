import { randomInt } from "node:crypto";

// WhatsApp "Connect with Facebook" — Meta's Embedded Signup. The browser runs
// Facebook's popup (FB.login with a WhatsApp configuration) and gets back a
// code plus the WhatsApp Business account (WABA) and phone number the person
// picked; identity-service finishes here. bot-service then points that WABA's
// webhooks at the bot's channel when the channel is turned on.
//
// Needs a Meta app with Facebook Login for Business + WhatsApp, approved for
// whatsapp_business_management and whatsapp_business_messaging:
//   META_APP_ID, META_APP_SECRET, WHATSAPP_SIGNUP_CONFIG_ID (Login for Business configuration)
//   META_GRAPH_VERSION (optional, default below)

const DEFAULT_GRAPH_VERSION = "v23.0";

export function graphVersion() {
  return process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
}

const graph = (path: string) => `https://graph.facebook.com/${graphVersion()}${path}`;

/** What the web app needs to open the popup, or undefined when the server isn't set up for it. */
export function whatsappSignupInfo(): { appId: string; configId: string; graphVersion: string } | undefined {
  const appId = process.env.META_APP_ID;
  const configId = process.env.WHATSAPP_SIGNUP_CONFIG_ID;
  if (!appId || !configId || !process.env.META_APP_SECRET) return undefined;
  return { appId, configId, graphVersion: graphVersion() };
}

async function graphRequest<T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(graph(path), {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (!response.ok || data.error) {
    const err = new Error(data.error?.message ?? `Meta answered ${response.status}`) as Error & { code?: number };
    err.code = data.error?.code;
    throw err;
  }
  return data;
}

const ID = /^\d{5,30}$/;

/**
 * Exchanges the popup's code for the business's token, checks the WABA and
 * phone number it reported really belong to that token, and registers the
 * number for the Cloud API. Returns { config, secrets } in the WhatsApp
 * integration's field names.
 */
export async function completeWhatsAppSignup(input: { code: string; wabaId: string; phoneNumberId: string }) {
  const info = whatsappSignupInfo();
  if (!info) throw new Error("WhatsApp sign-up isn't set up on this server.");
  if (!ID.test(input.wabaId) || !ID.test(input.phoneNumberId)) {
    throw new Error("Meta didn't report which WhatsApp number was chosen. Finish every step of the popup and try again.");
  }

  // Embedded Signup codes are exchanged without a redirect_uri.
  const params = new URLSearchParams({
    client_id: info.appId,
    client_secret: process.env.META_APP_SECRET!,
    code: input.code,
  });
  const { access_token: token } = await graphRequest<{ access_token: string }>(`/oauth/access_token?${params}`).catch((err) => {
    throw new Error(`Meta didn't accept the sign-in: ${(err as Error).message}`);
  });

  // The ids come from the browser: only trust them if this token can see them.
  const numbers = await graphRequest<{ data: { id: string; display_phone_number: string; verified_name?: string }[] }>(
    `/${input.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
    { token },
  ).catch(() => {
    throw new Error("The WhatsApp Business account from sign-up isn't accessible. Try connecting again.");
  });
  const number = numbers.data.find((n) => n.id === input.phoneNumberId);
  if (!number) throw new Error("That phone number isn't in the WhatsApp Business account you signed in with.");

  // New numbers have to be registered for the Cloud API before they can send.
  // A number that's already registered answers with an error we can ignore.
  const pin = String(randomInt(100000, 1000000));
  let registered = true;
  await graphRequest(`/${input.phoneNumberId}/register`, {
    method: "POST",
    token,
    body: { messaging_product: "whatsapp", pin },
  }).catch(() => {
    registered = false;
  });

  return {
    config: {
      connectedVia: "oauth",
      phoneNumberId: input.phoneNumberId,
      businessAccountId: input.wabaId,
      account: [number.verified_name, number.display_phone_number].filter(Boolean).join(" · "),
    } as Record<string, string>,
    secrets: {
      accessToken: token,
      // Our app's secret signs the webhooks Meta sends for every connected business.
      appSecret: process.env.META_APP_SECRET!,
      ...(registered ? { oauthTwoStepPin: pin } : {}),
    } as Record<string, string>,
  };
}

/**
 * Sends this WABA's webhooks (incoming messages) to the bot's channel URL.
 * Meta immediately calls the URL to verify it, so it must be publicly reachable.
 */
export async function subscribeWhatsAppWebhook(creds: Record<string, string>, callbackUrl: string, verifyToken: string) {
  await graphRequest(`/${creds.businessAccountId}/subscribed_apps`, {
    method: "POST",
    token: creds.accessToken,
    body: { override_callback_uri: callbackUrl, verify_token: verifyToken },
  });
}

export async function unsubscribeWhatsAppWebhook(creds: Record<string, string>) {
  await graphRequest(`/${creds.businessAccountId}/subscribed_apps`, { method: "DELETE", token: creds.accessToken });
}
