import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import {
  buildAuthorizeUrl,
  completeOAuth,
  completeWhatsAppSignup,
  whatsappSignupInfo,
  decryptJson,
  encryptJson,
  oauthInfo,
  readOAuthState,
} from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import {
  INTEGRATION_PROVIDERS,
  type IntegrationDto,
  type IntegrationProvider,
  findIntegrationProvider,
} from "@platform/shared-types";

type Values = Record<string, string>;

interface ConnectInput {
  values?: unknown;
  enabled?: unknown;
}

const MAX_FIELD_LENGTH = 4000;

const config = loadServiceConfig("identity-service", 3001);
/** Where providers send the browser back. Register this URL in each provider's OAuth app. */
const OAUTH_REDIRECT_URI = `${config.webAppUrl}/oauth/callback`;

function mask(secret: string) {
  return secret.length <= 4 ? "••••" : `••••${secret.slice(-4)}`;
}

@Injectable()
export class IntegrationsService {
  /** The full catalog, each provider annotated with this business's connection (secrets masked). */
  async list(businessId: string): Promise<IntegrationDto[]> {
    const connections = await prisma.integrationConnection.findMany({ where: { businessId } });
    const connectedByIds = [...new Set(connections.map((c) => c.connectedByUserId))];
    const users = await prisma.user.findMany({
      where: { id: { in: connectedByIds } },
      select: { id: true, email: true },
    });

    return INTEGRATION_PROVIDERS.map((provider) => {
      const connection = connections.find((c) => c.provider === provider.key);
      return this.toDto(provider, connection, users.find((u) => u.id === connection?.connectedByUserId)?.email);
    });
  }

  /**
   * Create or update a connection. Secret fields left blank on update keep their
   * stored value, so the client never needs to (or can) read secrets back.
   */
  async connect(businessId: string, userId: string, providerKey: string, input: ConnectInput) {
    const provider = this.requireProvider(providerKey);
    const values = this.validValues(input.values);
    const existing = await prisma.integrationConnection.findUnique({
      where: { businessId_provider: { businessId, provider: provider.key } },
    });
    const storedSecrets = existing ? this.tryDecrypt(existing.secretsEncrypted) : {};

    // Connected with OAuth: the tokens aren't the form's secret fields, so keep
    // them all and only let the plain settings (default channel, base ID…) change.
    const viaOAuth = (existing?.config as Values | undefined)?.connectedVia === "oauth";
    const config: Values = viaOAuth ? { ...(existing!.config as Values) } : {};
    const secrets: Values = viaOAuth ? { ...storedSecrets } : {};
    for (const field of provider.fields) {
      if (viaOAuth && field.type === "secret") continue;
      const value = values[field.key]?.trim() ?? "";
      const resolved = field.type === "secret" ? value || storedSecrets[field.key] || "" : value;
      if (viaOAuth) {
        if (resolved) config[field.key] = resolved;
        else if (field.key in values) delete config[field.key];
        continue;
      }
      if (field.required && !resolved) {
        throw new BadRequestException(`${field.label} is required`);
      }
      if (!resolved) continue;
      if (field.type === "secret") secrets[field.key] = resolved;
      else config[field.key] = resolved;
    }

    const enabled = typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true);
    const data = { config, secretsEncrypted: encryptJson(secrets), enabled };
    await prisma.integrationConnection.upsert({
      where: { businessId_provider: { businessId, provider: provider.key } },
      update: data,
      create: { ...data, businessId, provider: provider.key, connectedByUserId: userId },
    });
    return this.getOne(businessId, provider);
  }

  /** Step 1 of "Connect with …": the provider's consent-screen URL to send the browser to. */
  startOAuth(businessId: string, userId: string, providerKey: string, input: unknown) {
    const provider = this.requireProvider(providerKey);
    if (!oauthInfo(provider.key)) throw new BadRequestException(`${provider.name} can't be connected with OAuth`);
    try {
      return {
        url: buildAuthorizeUrl({
          provider: provider.key,
          businessId,
          userId,
          redirectUri: OAUTH_REDIRECT_URI,
          input: this.validValues((input as { values?: unknown } | undefined)?.values),
        }),
      };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /** Step 2: the web app's /oauth/callback page hands over the code; store the tokens. */
  async completeOAuth(businessId: string, userId: string, body: { code?: unknown; state?: unknown }) {
    if (typeof body.code !== "string" || typeof body.state !== "string" || !body.code || !body.state) {
      throw new BadRequestException("code and state are required");
    }
    let result: Awaited<ReturnType<typeof completeOAuth>>;
    let providerKey: string;
    try {
      const state = readOAuthState(body.state, { businessId, userId });
      providerKey = state.provider;
      result = await completeOAuth(state, body.code, OAUTH_REDIRECT_URI);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    return this.storeSignedInConnection(businessId, userId, this.requireProvider(providerKey), result);
  }

  /** WhatsApp's Embedded Signup popup finished: { code, wabaId, phoneNumberId } from the browser. */
  async completeWhatsAppSignup(businessId: string, userId: string, body: { code?: unknown; wabaId?: unknown; phoneNumberId?: unknown }) {
    if (typeof body.code !== "string" || !body.code) throw new BadRequestException("code is required");
    let result: Awaited<ReturnType<typeof completeWhatsAppSignup>>;
    try {
      result = await completeWhatsAppSignup({
        code: body.code,
        wabaId: String(body.wabaId ?? ""),
        phoneNumberId: String(body.phoneNumberId ?? ""),
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return this.storeSignedInConnection(businessId, userId, this.requireProvider("whatsapp"), result);
  }

  /** Saves a connection made by signing in (OAuth / Embedded Signup), replacing any manual one. */
  private async storeSignedInConnection(
    businessId: string,
    userId: string,
    provider: IntegrationProvider,
    result: { config: Values; secrets: Values },
  ) {
    const existing = await prisma.integrationConnection.findUnique({
      where: { businessId_provider: { businessId, provider: provider.key } },
    });
    // Keep plain settings the business already set (default channel, base ID…).
    const previousConfig = (existing?.config ?? {}) as Values;
    const keep = Object.fromEntries(
      provider.fields
        .filter((f) => f.type !== "secret" && previousConfig[f.key] && !(f.key in result.config))
        .map((f) => [f.key, previousConfig[f.key]]),
    );
    const data = {
      config: { ...keep, ...result.config },
      secretsEncrypted: encryptJson(result.secrets),
      enabled: true,
    };
    await prisma.integrationConnection.upsert({
      where: { businessId_provider: { businessId, provider: provider.key } },
      update: { ...data, connectedByUserId: userId },
      create: { ...data, businessId, provider: provider.key, connectedByUserId: userId },
    });
    return this.getOne(businessId, provider);
  }

  async setEnabled(businessId: string, providerKey: string, enabled: unknown) {
    const provider = this.requireProvider(providerKey);
    if (typeof enabled !== "boolean") {
      throw new BadRequestException("enabled must be a boolean");
    }
    await this.requireConnection(businessId, provider.key);
    await prisma.integrationConnection.update({
      where: { businessId_provider: { businessId, provider: provider.key } },
      data: { enabled },
    });
    return this.getOne(businessId, provider);
  }

  async disconnect(businessId: string, providerKey: string) {
    const provider = this.requireProvider(providerKey);
    await this.requireConnection(businessId, provider.key);
    await prisma.integrationConnection.delete({
      where: { businessId_provider: { businessId, provider: provider.key } },
    });
  }

  /**
   * Decrypted credentials for server-side use by other services once they
   * start calling providers. Never exposed over HTTP.
   */
  async credentials(businessId: string, providerKey: string): Promise<Values | null> {
    const connection = await prisma.integrationConnection.findUnique({
      where: { businessId_provider: { businessId, provider: providerKey } },
    });
    if (!connection?.enabled) return null;
    return { ...(connection.config as Values), ...decryptJson<Values>(connection.secretsEncrypted) };
  }

  private async getOne(businessId: string, provider: IntegrationProvider) {
    const connection = await prisma.integrationConnection.findUnique({
      where: { businessId_provider: { businessId, provider: provider.key } },
    });
    const user = connection
      ? await prisma.user.findUnique({ where: { id: connection.connectedByUserId }, select: { email: true } })
      : null;
    return this.toDto(provider, connection, user?.email);
  }

  private toDto(
    provider: IntegrationProvider,
    connection:
      | { enabled: boolean; config: unknown; secretsEncrypted: string; createdAt: Date; updatedAt: Date }
      | null
      | undefined,
    connectedBy: string | undefined,
  ): IntegrationDto {
    const oauth = oauthInfo(provider.key);
    const whatsappSignup = provider.key === "whatsapp" ? whatsappSignupInfo() : undefined;
    const base = { ...provider, ...(oauth ? { oauth } : {}), ...(whatsappSignup ? { whatsappSignup } : {}) };
    if (!connection) return { ...base, connection: null };

    const secrets = this.tryDecrypt(connection.secretsEncrypted);
    return {
      ...base,
      connection: {
        enabled: connection.enabled,
        config: (connection.config ?? {}) as Values,
        secretHints: Object.fromEntries(
          Object.entries(secrets)
            .filter(([k]) => !k.startsWith("oauth"))
            .map(([k, v]) => [k, mask(v)]),
        ),
        connectedAt: connection.createdAt.toISOString(),
        updatedAt: connection.updatedAt.toISOString(),
        connectedBy,
      },
    };
  }

  /** {} if the encryption key changed since these were stored; re-entering the secrets fixes it. */
  private tryDecrypt(payload: string): Values {
    try {
      return decryptJson<Values>(payload);
    } catch {
      return {};
    }
  }

  private requireProvider(key: string) {
    const provider = findIntegrationProvider(key);
    if (!provider) throw new NotFoundException(`Unknown integration: ${key}`);
    return provider;
  }

  private async requireConnection(businessId: string, provider: string) {
    const connection = await prisma.integrationConnection.findUnique({
      where: { businessId_provider: { businessId, provider } },
    });
    if (!connection) throw new NotFoundException("That integration isn't connected");
    return connection;
  }

  private validValues(value: unknown): Values {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("values must be an object of field -> string");
    }
    const out: Values = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== "string" || v.length > MAX_FIELD_LENGTH) {
        throw new BadRequestException(`${k} must be a string under ${MAX_FIELD_LENGTH} characters`);
      }
      out[k] = v;
    }
    return out;
  }
}
