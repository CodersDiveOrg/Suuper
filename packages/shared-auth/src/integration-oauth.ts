import { createHash, randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "./secret-box";

// "Connect with <provider>" for integrations. identity-service starts the flow
// and exchanges the code; bot-service refreshes expiring tokens when it reads
// credentials. Tokens are stored under the same field names the manual form
// uses (e.g. HubSpot's access token as privateAppToken), so integration
// actions work the same whichever way the business connected.
//
// Each provider needs its own developer app: set <ENV>_OAUTH_CLIENT_ID and
// <ENV>_OAUTH_CLIENT_SECRET (e.g. SLACK_OAUTH_CLIENT_ID) and register
// <WEB_APP_URL>/oauth/callback as the redirect URL. Providers without both
// variables keep only the manual form.

type Values = Record<string, string>;
type TokenResponse = Record<string, any>;

export interface OAuthPreField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
}

interface OAuthProviderDef {
  env: string;
  authorizeUrl: (extra: Values) => string;
  tokenUrl: (extra: Values) => string;
  scopes?: string[];
  scopeSeparator?: string;
  /** Extra query params on the authorize URL. */
  authorizeParams?: Record<string, string>;
  pkce?: boolean;
  /** How client_id/secret reach the token endpoint. */
  clientAuth?: "body" | "basic";
  bodyFormat?: "form" | "json" | "query";
  tokenHeaders?: Record<string, string>;
  /** Asked before redirecting (Shopify's store domain). normalize returns null when invalid. */
  preFields?: (OAuthPreField & { normalize: (value: string) => string | null })[];
  /** The secret field that holds the access token (what refresh updates). */
  accessField: string;
  /** Turns the token response into the connection's config + secrets. */
  toCredentials?: (tokens: TokenResponse, extra: Values) => Promise<{ config?: Values; secrets?: Values }>;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function getJson(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json() as Promise<any>;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  slack: {
    env: "SLACK",
    authorizeUrl: () => "https://slack.com/oauth/v2/authorize",
    tokenUrl: () => "https://slack.com/api/oauth.v2.access",
    scopes: ["chat:write", "chat:write.public", "channels:read", "groups:read"],
    scopeSeparator: ",",
    accessField: "botToken",
    toCredentials: async (t) => ({
      config: { account: t.team?.name ?? "" },
      // The app's signing secret verifies Slack's requests to us; it's the same for every workspace.
      secrets: { botToken: t.access_token, signingSecret: process.env.SLACK_SIGNING_SECRET ?? "" },
    }),
  },
  hubspot: {
    env: "HUBSPOT",
    authorizeUrl: () => "https://app.hubspot.com/oauth/authorize",
    tokenUrl: () => "https://api.hubapi.com/oauth/v1/token",
    scopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"],
    accessField: "privateAppToken",
    toCredentials: async (t) => {
      const info = await getJson(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(t.access_token)}`, {}).catch(() => null);
      return { config: { account: info?.hub_domain ?? "" }, secrets: { privateAppToken: t.access_token } };
    },
  },
  notion: {
    env: "NOTION",
    authorizeUrl: () => "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: () => "https://api.notion.com/v1/oauth/token",
    authorizeParams: { owner: "user" },
    clientAuth: "basic",
    bodyFormat: "json",
    accessField: "integrationToken",
    toCredentials: async (t) => ({ config: { account: t.workspace_name ?? "" }, secrets: { integrationToken: t.access_token } }),
  },
  airtable: {
    env: "AIRTABLE",
    authorizeUrl: () => "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: () => "https://airtable.com/oauth2/v1/token",
    scopes: ["data.records:read", "data.records:write", "schema.bases:read"],
    pkce: true,
    clientAuth: "basic",
    accessField: "accessToken",
  },
  asana: {
    env: "ASANA",
    authorizeUrl: () => "https://app.asana.com/-/oauth_authorize",
    tokenUrl: () => "https://app.asana.com/-/oauth_token",
    accessField: "accessToken",
    toCredentials: async (t) => ({ config: { account: t.data?.email ?? "" }, secrets: { accessToken: t.access_token } }),
  },
  clickup: {
    env: "CLICKUP",
    authorizeUrl: () => "https://app.clickup.com/api",
    tokenUrl: () => "https://api.clickup.com/api/v2/oauth/token",
    bodyFormat: "query",
    accessField: "apiToken",
  },
  calendly: {
    env: "CALENDLY",
    authorizeUrl: () => "https://auth.calendly.com/oauth/authorize",
    tokenUrl: () => "https://auth.calendly.com/oauth/token",
    pkce: true,
    accessField: "accessToken",
  },
  github: {
    env: "GITHUB",
    authorizeUrl: () => "https://github.com/login/oauth/authorize",
    tokenUrl: () => "https://github.com/login/oauth/access_token",
    scopes: ["repo"],
    accessField: "token",
    toCredentials: async (t) => {
      const user = await getJson("https://api.github.com/user", { ...bearer(t.access_token), "User-Agent": "Suuper" }).catch(() => null);
      return { config: { account: user?.login ?? "", defaultOwner: user?.login ?? "" }, secrets: { token: t.access_token } };
    },
  },
  linear: {
    env: "LINEAR",
    authorizeUrl: () => "https://linear.app/oauth/authorize",
    tokenUrl: () => "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
    scopeSeparator: ",",
    accessField: "accessToken",
  },
  pipedrive: {
    env: "PIPEDRIVE",
    authorizeUrl: () => "https://oauth.pipedrive.com/oauth/authorize",
    tokenUrl: () => "https://oauth.pipedrive.com/oauth/token",
    clientAuth: "basic",
    accessField: "accessToken",
    toCredentials: async (t) => {
      const apiDomain = String(t.api_domain ?? "").replace(/\/+$/, "");
      const companyDomain = apiDomain ? new URL(apiDomain).hostname.split(".")[0] : "";
      return { config: { apiDomain, companyDomain, account: companyDomain }, secrets: { accessToken: t.access_token } };
    },
  },
  jira: {
    env: "ATLASSIAN",
    authorizeUrl: () => "https://auth.atlassian.com/authorize",
    tokenUrl: () => "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work", "write:jira-work", "offline_access"],
    authorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
    bodyFormat: "json",
    accessField: "accessToken",
    toCredentials: async (t) => {
      const sites = (await getJson("https://api.atlassian.com/oauth/token/accessible-resources", bearer(t.access_token))) as {
        id: string;
        url: string;
        name: string;
      }[];
      const site = sites[0];
      if (!site) throw new Error("This Atlassian account has no Jira site Suuper can access.");
      return { config: { siteUrl: site.url, cloudId: site.id, account: site.name }, secrets: { accessToken: t.access_token } };
    },
  },
  shopify: {
    env: "SHOPIFY",
    authorizeUrl: (x) => `https://${x.shopDomain}/admin/oauth/authorize`,
    tokenUrl: (x) => `https://${x.shopDomain}/admin/oauth/access_token`,
    scopes: ["read_products", "read_orders", "read_customers"],
    scopeSeparator: ",",
    bodyFormat: "json",
    accessField: "adminApiToken",
    preFields: [
      {
        key: "shopDomain",
        label: "Store domain",
        placeholder: "yourstore.myshopify.com",
        help: "Your store's .myshopify.com address.",
        normalize: (value) => {
          const host = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
          const full = host.includes(".") ? host : `${host}.myshopify.com`;
          return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(full) ? full : null;
        },
      },
    ],
    toCredentials: async (t, x) => ({ config: { shopDomain: x.shopDomain, account: x.shopDomain }, secrets: { adminApiToken: t.access_token } }),
  },
  dropbox: {
    env: "DROPBOX",
    authorizeUrl: () => "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: () => "https://api.dropboxapi.com/oauth2/token",
    authorizeParams: { token_access_type: "offline" },
    accessField: "accessToken",
  },
  intercom: {
    env: "INTERCOM",
    authorizeUrl: () => "https://app.intercom.com/oauth",
    tokenUrl: () => "https://api.intercom.io/auth/eagle/token",
    accessField: "accessToken",
    toCredentials: async (t) => ({ secrets: { accessToken: t.access_token ?? t.token } }),
  },
  square: {
    env: "SQUARE",
    authorizeUrl: () => "https://connect.squareup.com/oauth2/authorize",
    tokenUrl: () => "https://connect.squareup.com/oauth2/token",
    scopes: ["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "ORDERS_READ", "ITEMS_READ", "CUSTOMERS_READ"],
    authorizeParams: { session: "false" },
    bodyFormat: "json",
    tokenHeaders: { "Square-Version": "2024-10-17" },
    accessField: "accessToken",
  },
  gitlab: {
    env: "GITLAB",
    authorizeUrl: () => "https://gitlab.com/oauth/authorize",
    tokenUrl: () => "https://gitlab.com/oauth/token",
    scopes: ["api"],
    pkce: true,
    accessField: "token",
    toCredentials: async (t) => ({ config: { baseUrl: "https://gitlab.com" }, secrets: { token: t.access_token } }),
  },
};

function clientCredentials(provider: string) {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return null;
  const id = process.env[`${def.env}_OAUTH_CLIENT_ID`];
  const secret = process.env[`${def.env}_OAUTH_CLIENT_SECRET`];
  return id && secret ? { id, secret } : null;
}

/** OAuth info for the integrations catalog: undefined when the provider has no OAuth flow. */
export function oauthInfo(provider: string): { configured: boolean; preFields: OAuthPreField[] } | undefined {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return undefined;
  return {
    configured: !!clientCredentials(provider),
    preFields: (def.preFields ?? []).map(({ key, label, placeholder, help }) => ({ key, label, placeholder, help })),
  };
}

interface OAuthState {
  businessId: string;
  userId: string;
  provider: string;
  verifier?: string;
  extra: Values;
  expiresAt: number;
}

const STATE_TTL_MS = 15 * 60_000;
const base64url = (buf: Buffer) => buf.toString("base64url");

/** The provider's consent-screen URL. State is encrypted, so it can carry the PKCE verifier. */
export function buildAuthorizeUrl(params: {
  provider: string;
  businessId: string;
  userId: string;
  redirectUri: string;
  input?: Values;
}): string {
  const def = OAUTH_PROVIDERS[params.provider];
  const client = clientCredentials(params.provider);
  if (!def || !client) throw new Error(`Connecting ${params.provider} with OAuth isn't set up on this server.`);

  const extra: Values = {};
  for (const field of def.preFields ?? []) {
    const value = field.normalize(params.input?.[field.key] ?? "");
    if (!value) throw new Error(`${field.label} is required${field.placeholder ? ` (e.g. ${field.placeholder})` : ""}`);
    extra[field.key] = value;
  }

  const verifier = def.pkce ? base64url(randomBytes(32)) : undefined;
  const state: OAuthState = {
    businessId: params.businessId,
    userId: params.userId,
    provider: params.provider,
    verifier,
    extra,
    expiresAt: Date.now() + STATE_TTL_MS,
  };

  const url = new URL(def.authorizeUrl(extra));
  url.searchParams.set("client_id", client.id);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", encryptJson(state));
  if (def.scopes?.length) url.searchParams.set("scope", def.scopes.join(def.scopeSeparator ?? " "));
  for (const [k, v] of Object.entries(def.authorizeParams ?? {})) url.searchParams.set(k, v);
  if (verifier) {
    url.searchParams.set("code_challenge", base64url(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Decrypts and checks the state from the callback. Throws when it's forged, expired or for someone else. */
export function readOAuthState(raw: string, expect: { businessId: string; userId: string }): OAuthState {
  let state: OAuthState;
  try {
    state = decryptJson<OAuthState>(raw);
  } catch {
    throw new Error("This sign-in link isn't valid. Start connecting again.");
  }
  if (state.expiresAt < Date.now()) throw new Error("The sign-in took too long. Start connecting again.");
  if (state.businessId !== expect.businessId || state.userId !== expect.userId) {
    throw new Error("This sign-in was started from a different business or account. Switch back to it and try again.");
  }
  return state;
}

async function tokenRequest(provider: string, extra: Values, params: Values): Promise<TokenResponse> {
  const def = OAUTH_PROVIDERS[provider];
  const client = clientCredentials(provider);
  if (!def || !client) throw new Error(`OAuth for ${provider} isn't set up on this server.`);

  const body: Values = { ...params };
  const headers: Record<string, string> = { Accept: "application/json", ...(def.tokenHeaders ?? {}) };
  if (def.clientAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`;
  } else {
    body.client_id = client.id;
    body.client_secret = client.secret;
  }

  let url = def.tokenUrl(extra);
  let payload: string | undefined;
  if (def.bodyFormat === "json") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  } else if (def.bodyFormat === "query") {
    url = `${url}?${new URLSearchParams(body)}`;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body).toString();
  }

  const response = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let data: TokenResponse;
  try {
    data = JSON.parse(text);
  } catch {
    data = Object.fromEntries(new URLSearchParams(text));
  }
  // Slack answers 200 with ok:false; GitHub answers 200 with error.
  if (!response.ok || data.ok === false || data.error || !(data.access_token ?? data.token)) {
    const reason = data.error_description ?? data.error?.message ?? data.error ?? data.message ?? `HTTP ${response.status}`;
    throw new Error(`${provider} didn't accept the sign-in: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
  }
  return data;
}

function expiryOf(tokens: TokenResponse): string | undefined {
  if (tokens.expires_in) return String(Date.now() + Number(tokens.expires_in) * 1000);
  if (tokens.expires_at) {
    const at = Date.parse(tokens.expires_at);
    if (!Number.isNaN(at)) return String(at);
  }
  return undefined;
}

/** Exchanges the callback's code for tokens, as { config, secrets } ready to store. */
export async function completeOAuth(state: OAuthState, code: string, redirectUri: string) {
  const def = OAUTH_PROVIDERS[state.provider];
  if (!def) throw new Error(`Unknown integration: ${state.provider}`);
  const tokens = await tokenRequest(state.provider, state.extra, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    ...(state.verifier ? { code_verifier: state.verifier } : {}),
  });

  const mapped: { config?: Values; secrets?: Values } = def.toCredentials
    ? await def.toCredentials(tokens, state.extra)
    : { secrets: { [def.accessField]: String(tokens.access_token) } };
  const config: Values = { ...(mapped.config ?? {}), connectedVia: "oauth" };
  const secrets: Values = { ...(mapped.secrets ?? {}) };
  if (tokens.refresh_token) secrets.oauthRefreshToken = String(tokens.refresh_token);
  const expiresAt = expiryOf(tokens);
  if (expiresAt) secrets.oauthExpiresAt = expiresAt;
  // Empty strings would only confuse the UI and actions.
  for (const record of [config, secrets]) for (const [k, v] of Object.entries(record)) if (!v) delete record[k];
  return { config, secrets };
}

const REFRESH_MARGIN_MS = 2 * 60_000;

/**
 * New secrets when the stored access token has expired or is about to, else
 * null (nothing to do). Throws when the provider refuses the refresh.
 */
export async function refreshOAuthSecrets(provider: string, config: Values, secrets: Values): Promise<Values | null> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def || config.connectedVia !== "oauth" || !secrets.oauthRefreshToken || !secrets.oauthExpiresAt) return null;
  if (Number(secrets.oauthExpiresAt) - Date.now() > REFRESH_MARGIN_MS) return null;

  const tokens = await tokenRequest(provider, config, { grant_type: "refresh_token", refresh_token: secrets.oauthRefreshToken });
  const next: Values = { ...secrets, [def.accessField]: String(tokens.access_token ?? tokens.token) };
  if (tokens.refresh_token) next.oauthRefreshToken = String(tokens.refresh_token);
  const expiresAt = expiryOf(tokens);
  if (expiresAt) next.oauthExpiresAt = expiresAt;
  else delete next.oauthExpiresAt;
  return next;
}
