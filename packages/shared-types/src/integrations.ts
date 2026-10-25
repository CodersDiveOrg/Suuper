// Catalog of third-party providers a business can connect. Connecting stores
// the provider's credentials per business (secrets encrypted at rest); actually
// calling each provider is wired up per integration as features need it.

export type IntegrationCategory =
  | "messaging"
  | "email"
  | "crm"
  | "support"
  | "ecommerce"
  | "payments"
  | "productivity"
  | "scheduling"
  | "storage"
  | "developer"
  | "analytics"
  | "automation"
  | "ai";

export type IntegrationFieldType = "text" | "url" | "secret";

export interface IntegrationField {
  key: string;
  label: string;
  type: IntegrationFieldType;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface IntegrationProvider {
  key: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  docsUrl?: string;
  fields: IntegrationField[];
}

export const INTEGRATION_CATEGORIES: Record<IntegrationCategory, string> = {
  messaging: "Messaging",
  email: "Email",
  crm: "CRM",
  support: "Customer support",
  ecommerce: "E-commerce",
  payments: "Payments",
  productivity: "Productivity",
  scheduling: "Scheduling",
  storage: "Storage",
  developer: "Developer",
  analytics: "Analytics",
  automation: "Automation",
  ai: "AI models",
};

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  {
    key: "slack",
    name: "Slack",
    category: "messaging",
    description: "Let bots and agents answer in Slack channels and DMs.",
    docsUrl: "https://api.slack.com/apps",
    fields: [
      { key: "botToken", label: "Bot token", type: "secret", required: true, placeholder: "xoxb-…" },
      { key: "signingSecret", label: "Signing secret", type: "secret", required: true },
      { key: "defaultChannel", label: "Default channel", type: "text", required: false, placeholder: "#support" },
    ],
  },
  {
    key: "whatsapp",
    name: "WhatsApp Business",
    category: "messaging",
    description: "Reply to customers on WhatsApp through the Cloud API.",
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    fields: [
      { key: "phoneNumberId", label: "Phone number ID", type: "text", required: true },
      { key: "businessAccountId", label: "Business account ID", type: "text", required: true },
      { key: "accessToken", label: "Access token", type: "secret", required: true },
      {
        key: "appSecret",
        label: "App secret",
        type: "secret",
        required: false,
        help: "Meta app → Settings → Basic. Used to check that incoming messages really come from WhatsApp.",
      },
    ],
  },
  {
    key: "telegram",
    name: "Telegram",
    category: "messaging",
    description: "Run a bot as a Telegram bot.",
    docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
    fields: [{ key: "botToken", label: "Bot token", type: "secret", required: true, help: "From @BotFather." }],
  },
  {
    key: "smtp",
    name: "Email (SMTP)",
    category: "email",
    description: "Send emails from agents — follow-ups, summaries and notifications.",
    fields: [
      { key: "host", label: "SMTP host", type: "text", required: true, placeholder: "smtp.example.com" },
      { key: "port", label: "Port", type: "text", required: true, placeholder: "587" },
      { key: "username", label: "Username", type: "text", required: true },
      { key: "password", label: "Password", type: "secret", required: true },
      { key: "fromAddress", label: "From address", type: "text", required: true, placeholder: "support@yourco.com" },
    ],
  },
  {
    key: "hubspot",
    name: "HubSpot",
    category: "crm",
    description: "Look up contacts and log conversations as CRM activity.",
    docsUrl: "https://developers.hubspot.com/docs/api/private-apps",
    fields: [{ key: "privateAppToken", label: "Private app token", type: "secret", required: true }],
  },
  {
    key: "shopify",
    name: "Shopify",
    category: "ecommerce",
    description: "Sync products and look up orders so bots can answer order questions.",
    docsUrl: "https://shopify.dev/docs/apps/auth/admin-app-access-tokens",
    fields: [
      { key: "shopDomain", label: "Shop domain", type: "url", required: true, placeholder: "your-store.myshopify.com" },
      { key: "adminApiToken", label: "Admin API access token", type: "secret", required: true },
    ],
  },
  {
    key: "stripe",
    name: "Stripe",
    category: "payments",
    description: "Look up customers, subscriptions and invoices.",
    docsUrl: "https://dashboard.stripe.com/apikeys",
    fields: [{ key: "secretKey", label: "Restricted API key", type: "secret", required: true, placeholder: "rk_live_…" }],
  },
  {
    key: "notion",
    name: "Notion",
    category: "productivity",
    description: "Use Notion pages as a knowledge source for your agents.",
    docsUrl: "https://www.notion.so/my-integrations",
    fields: [{ key: "integrationToken", label: "Integration token", type: "secret", required: true }],
  },
  {
    key: "anthropic",
    name: "Anthropic (Claude)",
    category: "ai",
    description: "Use your own Claude API key for this business's bots and agents.",
    docsUrl: "https://console.anthropic.com/settings/keys",
    fields: [{ key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "sk-ant-…" }],
  },
  // --- Messaging ---------------------------------------------------------------
  {
    key: "discord",
    name: "Discord",
    category: "messaging",
    description: "Let bots and agents reply in your Discord server's channels.",
    docsUrl: "https://discord.com/developers/applications",
    fields: [
      { key: "botToken", label: "Bot token", type: "secret", required: true },
      { key: "applicationId", label: "Application ID", type: "text", required: true },
      { key: "guildId", label: "Server (guild) ID", type: "text", required: false, help: "Limit the bot to one server." },
    ],
  },
  {
    key: "microsoft_teams",
    name: "Microsoft Teams",
    category: "messaging",
    description: "Post agent updates and alerts into a Teams channel.",
    docsUrl: "https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook",
    fields: [{ key: "webhookUrl", label: "Incoming webhook URL", type: "secret", required: true, placeholder: "https://…webhook.office.com/…" }],
  },
  {
    key: "twilio",
    name: "Twilio SMS",
    category: "messaging",
    description: "Send and receive SMS so customers can text your bot.",
    docsUrl: "https://console.twilio.com/",
    fields: [
      { key: "accountSid", label: "Account SID", type: "text", required: true, placeholder: "AC…" },
      { key: "authToken", label: "Auth token", type: "secret", required: true },
      { key: "fromNumber", label: "From number", type: "text", required: true, placeholder: "+15551234567" },
    ],
  },
  {
    key: "messenger",
    name: "Facebook Messenger",
    category: "messaging",
    description: "Answer customers who message your Facebook Page.",
    docsUrl: "https://developers.facebook.com/docs/messenger-platform",
    fields: [
      { key: "pageId", label: "Page ID", type: "text", required: true },
      { key: "pageAccessToken", label: "Page access token", type: "secret", required: true },
      { key: "appSecret", label: "App secret", type: "secret", required: true, help: "Used to verify incoming webhooks." },
    ],
  },
  {
    key: "instagram",
    name: "Instagram",
    category: "messaging",
    description: "Reply to Instagram direct messages from your business account.",
    docsUrl: "https://developers.facebook.com/docs/instagram-platform",
    fields: [
      { key: "accountId", label: "Instagram business account ID", type: "text", required: true },
      { key: "accessToken", label: "Access token", type: "secret", required: true },
    ],
  },

  // --- Email -------------------------------------------------------------------
  {
    key: "sendgrid",
    name: "SendGrid",
    category: "email",
    description: "Send transactional email at scale through SendGrid.",
    docsUrl: "https://app.sendgrid.com/settings/api_keys",
    fields: [
      { key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "SG.…" },
      { key: "fromAddress", label: "From address", type: "text", required: true, placeholder: "hello@yourco.com" },
    ],
  },
  {
    key: "mailgun",
    name: "Mailgun",
    category: "email",
    description: "Send email through your Mailgun domain.",
    docsUrl: "https://app.mailgun.com/settings/api_security",
    fields: [
      { key: "apiKey", label: "API key", type: "secret", required: true },
      { key: "domain", label: "Sending domain", type: "text", required: true, placeholder: "mg.yourco.com" },
      { key: "region", label: "Region", type: "text", required: false, placeholder: "us or eu", help: "Defaults to us." },
    ],
  },
  {
    key: "postmark",
    name: "Postmark",
    category: "email",
    description: "Fast, reliable transactional email.",
    docsUrl: "https://account.postmarkapp.com/servers",
    fields: [
      { key: "serverToken", label: "Server API token", type: "secret", required: true },
      { key: "fromAddress", label: "From address", type: "text", required: true },
    ],
  },
  {
    key: "resend",
    name: "Resend",
    category: "email",
    description: "Developer-friendly email sending.",
    docsUrl: "https://resend.com/api-keys",
    fields: [
      { key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "re_…" },
      { key: "fromAddress", label: "From address", type: "text", required: true },
    ],
  },
  {
    key: "mailchimp",
    name: "Mailchimp",
    category: "email",
    description: "Add contacts to audiences and tag them from conversations.",
    docsUrl: "https://mailchimp.com/help/about-api-keys/",
    fields: [
      { key: "apiKey", label: "API key", type: "secret", required: true, help: "Ends with your data center, e.g. -us21." },
      { key: "audienceId", label: "Default audience ID", type: "text", required: false },
    ],
  },

  // --- CRM ---------------------------------------------------------------------
  {
    key: "salesforce",
    name: "Salesforce",
    category: "crm",
    description: "Look up accounts and contacts, and log conversations as activities.",
    docsUrl: "https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm",
    fields: [
      { key: "instanceUrl", label: "Instance URL", type: "url", required: true, placeholder: "https://yourco.my.salesforce.com" },
      { key: "clientId", label: "Connected app consumer key", type: "text", required: true },
      { key: "clientSecret", label: "Connected app consumer secret", type: "secret", required: true },
    ],
  },
  {
    key: "pipedrive",
    name: "Pipedrive",
    category: "crm",
    description: "Create leads and deals from conversations that look like sales.",
    docsUrl: "https://pipedrive.readme.io/docs/how-to-find-the-api-token",
    fields: [
      { key: "companyDomain", label: "Company domain", type: "text", required: true, placeholder: "yourco (from yourco.pipedrive.com)" },
      { key: "apiToken", label: "API token", type: "secret", required: true },
    ],
  },
  {
    key: "zoho_crm",
    name: "Zoho CRM",
    category: "crm",
    description: "Sync leads and contacts with Zoho CRM.",
    docsUrl: "https://www.zoho.com/crm/developer/docs/api/v6/oauth-overview.html",
    fields: [
      { key: "clientId", label: "Client ID", type: "text", required: true },
      { key: "clientSecret", label: "Client secret", type: "secret", required: true },
      { key: "refreshToken", label: "Refresh token", type: "secret", required: true },
      { key: "dataCenter", label: "Data center", type: "text", required: false, placeholder: "com, eu, in, com.au…" },
    ],
  },

  // --- Customer support --------------------------------------------------------
  {
    key: "zendesk",
    name: "Zendesk",
    category: "support",
    description: "Create and update tickets, and hand conversations to your support team.",
    docsUrl: "https://support.zendesk.com/hc/en-us/articles/4408889192858",
    fields: [
      { key: "subdomain", label: "Subdomain", type: "text", required: true, placeholder: "yourco (from yourco.zendesk.com)" },
      { key: "email", label: "Agent email", type: "text", required: true },
      { key: "apiToken", label: "API token", type: "secret", required: true },
    ],
  },
  {
    key: "intercom",
    name: "Intercom",
    category: "support",
    description: "Answer Intercom conversations and hand off to your team.",
    docsUrl: "https://developers.intercom.com/docs/build-an-integration/learn-more/authentication",
    fields: [{ key: "accessToken", label: "Access token", type: "secret", required: true }],
  },
  {
    key: "freshdesk",
    name: "Freshdesk",
    category: "support",
    description: "Create tickets and look up ticket status for customers.",
    docsUrl: "https://support.freshdesk.com/support/solutions/articles/215517",
    fields: [
      { key: "domain", label: "Freshdesk domain", type: "text", required: true, placeholder: "yourco.freshdesk.com" },
      { key: "apiKey", label: "API key", type: "secret", required: true },
    ],
  },

  // --- E-commerce --------------------------------------------------------------
  {
    key: "woocommerce",
    name: "WooCommerce",
    category: "ecommerce",
    description: "Look up products and orders from your WordPress store.",
    docsUrl: "https://woocommerce.com/document/woocommerce-rest-api/",
    fields: [
      { key: "storeUrl", label: "Store URL", type: "url", required: true, placeholder: "https://yourstore.com" },
      { key: "consumerKey", label: "Consumer key", type: "text", required: true, placeholder: "ck_…" },
      { key: "consumerSecret", label: "Consumer secret", type: "secret", required: true, placeholder: "cs_…" },
    ],
  },
  {
    key: "bigcommerce",
    name: "BigCommerce",
    category: "ecommerce",
    description: "Sync catalog and answer order questions for your BigCommerce store.",
    docsUrl: "https://developer.bigcommerce.com/docs/start/authentication/api-accounts",
    fields: [
      { key: "storeHash", label: "Store hash", type: "text", required: true },
      { key: "accessToken", label: "Access token", type: "secret", required: true },
    ],
  },

  // --- Payments ----------------------------------------------------------------
  {
    key: "paypal",
    name: "PayPal",
    category: "payments",
    description: "Look up payments and refunds.",
    docsUrl: "https://developer.paypal.com/dashboard/applications",
    fields: [
      { key: "clientId", label: "Client ID", type: "text", required: true },
      { key: "clientSecret", label: "Secret", type: "secret", required: true },
      { key: "environment", label: "Environment", type: "text", required: false, placeholder: "live or sandbox", help: "Defaults to live." },
    ],
  },
  {
    key: "square",
    name: "Square",
    category: "payments",
    description: "Look up payments, orders and customers.",
    docsUrl: "https://developer.squareup.com/apps",
    fields: [
      { key: "accessToken", label: "Access token", type: "secret", required: true },
      { key: "locationId", label: "Location ID", type: "text", required: false },
    ],
  },

  // --- Productivity ------------------------------------------------------------
  {
    key: "google_sheets",
    name: "Google Sheets",
    category: "productivity",
    description: "Read and append rows — log leads, orders or survey answers.",
    docsUrl: "https://cloud.google.com/iam/docs/keys-create-delete",
    fields: [
      { key: "serviceAccountJson", label: "Service account key (JSON)", type: "secret", required: true, help: "Share the sheet with the service account's email." },
      { key: "spreadsheetId", label: "Default spreadsheet ID", type: "text", required: false },
    ],
  },
  {
    key: "airtable",
    name: "Airtable",
    category: "productivity",
    description: "Read and write records in your Airtable bases.",
    docsUrl: "https://airtable.com/create/tokens",
    fields: [
      { key: "accessToken", label: "Personal access token", type: "secret", required: true, placeholder: "pat…" },
      { key: "baseId", label: "Default base ID", type: "text", required: false, placeholder: "app…" },
    ],
  },
  {
    key: "trello",
    name: "Trello",
    category: "productivity",
    description: "Create cards from conversations and track work on boards.",
    docsUrl: "https://trello.com/power-ups/admin",
    fields: [
      { key: "apiKey", label: "API key", type: "text", required: true },
      { key: "token", label: "Token", type: "secret", required: true },
    ],
  },
  {
    key: "asana",
    name: "Asana",
    category: "productivity",
    description: "Turn requests into Asana tasks and check their status.",
    docsUrl: "https://app.asana.com/0/my-apps",
    fields: [{ key: "accessToken", label: "Personal access token", type: "secret", required: true }],
  },
  {
    key: "clickup",
    name: "ClickUp",
    category: "productivity",
    description: "Create and update ClickUp tasks.",
    docsUrl: "https://clickup.com/api/developer-portal/authentication/",
    fields: [{ key: "apiToken", label: "Personal API token", type: "secret", required: true, placeholder: "pk_…" }],
  },

  // --- Scheduling --------------------------------------------------------------
  {
    key: "calendly",
    name: "Calendly",
    category: "scheduling",
    description: "Share booking links and look up upcoming meetings.",
    docsUrl: "https://calendly.com/integrations/api_webhooks",
    fields: [{ key: "accessToken", label: "Personal access token", type: "secret", required: true }],
  },
  {
    key: "cal_com",
    name: "Cal.com",
    category: "scheduling",
    description: "Check availability and book meetings.",
    docsUrl: "https://cal.com/docs/api-reference/v2/introduction",
    fields: [{ key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "cal_…" }],
  },

  // --- Storage -----------------------------------------------------------------
  {
    key: "aws_s3",
    name: "Amazon S3",
    category: "storage",
    description: "Read documents from a bucket and store generated files.",
    docsUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
    fields: [
      { key: "bucket", label: "Bucket", type: "text", required: true },
      { key: "region", label: "Region", type: "text", required: true, placeholder: "us-east-1" },
      { key: "accessKeyId", label: "Access key ID", type: "text", required: true },
      { key: "secretAccessKey", label: "Secret access key", type: "secret", required: true },
    ],
  },
  {
    key: "dropbox",
    name: "Dropbox",
    category: "storage",
    description: "Use files in Dropbox as a knowledge source.",
    docsUrl: "https://www.dropbox.com/developers/apps",
    fields: [{ key: "accessToken", label: "Access token", type: "secret", required: true }],
  },

  // --- Developer ---------------------------------------------------------------
  {
    key: "github",
    name: "GitHub",
    category: "developer",
    description: "Read repositories, open issues and comment on pull requests.",
    docsUrl: "https://github.com/settings/personal-access-tokens",
    fields: [
      { key: "token", label: "Fine-grained personal access token", type: "secret", required: true, placeholder: "github_pat_…" },
      { key: "defaultOwner", label: "Default organization or user", type: "text", required: false },
    ],
  },
  {
    key: "gitlab",
    name: "GitLab",
    category: "developer",
    description: "Read projects, open issues and comment on merge requests.",
    docsUrl: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
    fields: [
      { key: "baseUrl", label: "GitLab URL", type: "url", required: false, placeholder: "https://gitlab.com", help: "Change for self-managed GitLab." },
      { key: "token", label: "Personal access token", type: "secret", required: true, placeholder: "glpat-…" },
    ],
  },
  {
    key: "jira",
    name: "Jira",
    category: "developer",
    description: "Create and look up Jira issues from conversations.",
    docsUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { key: "siteUrl", label: "Site URL", type: "url", required: true, placeholder: "https://yourco.atlassian.net" },
      { key: "email", label: "Account email", type: "text", required: true },
      { key: "apiToken", label: "API token", type: "secret", required: true },
    ],
  },
  {
    key: "linear",
    name: "Linear",
    category: "developer",
    description: "File bugs and feature requests straight into Linear.",
    docsUrl: "https://linear.app/settings/account/security",
    fields: [
      { key: "apiKey", label: "Personal API key", type: "secret", required: true, placeholder: "lin_api_…" },
      { key: "teamKey", label: "Default team key", type: "text", required: false, placeholder: "ENG" },
    ],
  },

  // --- Analytics ---------------------------------------------------------------
  {
    key: "google_analytics",
    name: "Google Analytics 4",
    category: "analytics",
    description: "Send conversation events (leads, purchases) to GA4.",
    docsUrl: "https://developers.google.com/analytics/devguides/collection/protocol/ga4",
    fields: [
      { key: "measurementId", label: "Measurement ID", type: "text", required: true, placeholder: "G-XXXXXXX" },
      { key: "apiSecret", label: "Measurement Protocol API secret", type: "secret", required: true },
    ],
  },
  {
    key: "segment",
    name: "Segment",
    category: "analytics",
    description: "Track conversation events in Segment.",
    docsUrl: "https://segment.com/docs/connections/find-writekey/",
    fields: [{ key: "writeKey", label: "Write key", type: "secret", required: true }],
  },
  {
    key: "mixpanel",
    name: "Mixpanel",
    category: "analytics",
    description: "Track how customers use your bots and agents.",
    docsUrl: "https://docs.mixpanel.com/docs/orgs-and-projects/managing-projects",
    fields: [
      { key: "projectToken", label: "Project token", type: "secret", required: true },
      { key: "region", label: "Data residency", type: "text", required: false, placeholder: "us or eu" },
    ],
  },

  // --- Automation --------------------------------------------------------------
  {
    key: "zapier",
    name: "Zapier",
    category: "automation",
    description: "Trigger a Zap from an agent to reach 7,000+ apps.",
    docsUrl: "https://help.zapier.com/hc/en-us/articles/8496288690317",
    fields: [{ key: "webhookUrl", label: "Catch Hook URL", type: "secret", required: true, placeholder: "https://hooks.zapier.com/hooks/catch/…" }],
  },
  {
    key: "make",
    name: "Make",
    category: "automation",
    description: "Trigger a Make scenario from an agent.",
    docsUrl: "https://www.make.com/en/help/tools/webhooks",
    fields: [{ key: "webhookUrl", label: "Webhook URL", type: "secret", required: true, placeholder: "https://hook.eu1.make.com/…" }],
  },
  {
    key: "n8n",
    name: "n8n",
    category: "automation",
    description: "Trigger an n8n workflow from an agent.",
    docsUrl: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/",
    fields: [
      { key: "webhookUrl", label: "Webhook URL", type: "secret", required: true },
      { key: "authHeader", label: "Header auth value", type: "secret", required: false, help: "If the webhook uses header auth." },
    ],
  },
];

export function findIntegrationProvider(key: string): IntegrationProvider | undefined {
  return INTEGRATION_PROVIDERS.find((p) => p.key === key);
}

/** A provider plus this business's connection to it, if any. Secrets are never returned. */
export interface IntegrationDto extends IntegrationProvider {
  connection: {
    enabled: boolean;
    config: Record<string, string>;
    /** Masked secret values, e.g. { botToken: "••••a1b2" }. */
    secretHints: Record<string, string>;
    connectedAt: string;
    updatedAt: string;
    connectedBy?: string;
  } | null;
}
