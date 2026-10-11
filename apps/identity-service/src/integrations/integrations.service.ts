import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { decryptJson, encryptJson } from "@platform/shared-auth";
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

    const config: Values = {};
    const secrets: Values = {};
    for (const field of provider.fields) {
      const value = values[field.key]?.trim() ?? "";
      const resolved = field.type === "secret" ? value || storedSecrets[field.key] || "" : value;
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
    if (!connection) return { ...provider, connection: null };

    const secrets = this.tryDecrypt(connection.secretsEncrypted);
    return {
      ...provider,
      connection: {
        enabled: connection.enabled,
        config: (connection.config ?? {}) as Values,
        secretHints: Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, mask(v)])),
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
