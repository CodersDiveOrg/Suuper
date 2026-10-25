import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import axios from "axios";
import { prisma } from "@platform/database";
import { decryptJson, encryptJson } from "@platform/shared-auth";
import type { AiKeyTestResult, AiModelsOverview, AiProviderKey, BusinessContext } from "@platform/shared-types";
import { CLOUD_PROVIDERS, cloudProvider, findModel, modelAvailability, ollamaReachable, providerKey } from "../agents/runtime/models";

const TEST_TIMEOUT_MS = 10_000;

function mask(secret: string) {
  return secret.length <= 4 ? "••••" : `••••${secret.slice(-4)}`;
}

/**
 * Checks a key by listing the provider's models: free, no tokens used.
 * 401/403 means the key is wrong; anything else that isn't an outage counts as working.
 */
async function testKey(provider: AiProviderKey, apiKey: string): Promise<AiKeyTestResult> {
  const request =
    provider === "anthropic"
      ? { url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } }
      : provider === "openai"
        ? { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${apiKey}` } }
        : { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": apiKey } };
  try {
    const response = await axios.get(request.url, { headers: request.headers, timeout: TEST_TIMEOUT_MS, validateStatus: () => true });
    if (response.status < 300) return { ok: true, message: "The key works." };
    if (response.status === 401 || response.status === 403 || (provider === "gemini" && response.status === 400)) {
      return { ok: false, message: "The provider rejected this key. Check that you copied all of it and that it's active." };
    }
    if (response.status === 429) return { ok: true, message: "The key works, but the provider is rate-limiting it right now." };
    return { ok: false, message: `The provider answered with an error (HTTP ${response.status}). Try again in a minute.` };
  } catch {
    return { ok: false, message: "Couldn't reach the provider to check the key. Try again in a minute." };
  }
}

@Injectable()
export class AiModelsService {
  async overview(businessId: string): Promise<AiModelsOverview> {
    const [connections, business, models, localAvailable] = await Promise.all([
      prisma.integrationConnection.findMany({ where: { businessId, provider: { in: CLOUD_PROVIDERS.map((p) => p.key) } } }),
      prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { defaultModel: true } }),
      modelAvailability(businessId),
      ollamaReachable(),
    ]);
    const providers = await Promise.all(
      CLOUD_PROVIDERS.map(async (p) => {
        const connection = connections.find((c) => c.provider === p.key);
        let hint: string | undefined;
        if (connection?.enabled) {
          try {
            hint = mask(decryptJson<{ apiKey?: string }>(connection.secretsEncrypted).apiKey ?? "");
          } catch {
            hint = undefined;
          }
        }
        const active = await providerKey(businessId, p.key);
        return {
          key: p.key,
          name: p.name,
          keysUrl: p.keysUrl,
          platformKey: !!process.env[p.platformEnv],
          businessKey: hint && connection ? { hint, updatedAt: connection.updatedAt.toISOString() } : null,
          active: active ? (active.ownKey ? ("business" as const) : ("platform" as const)) : null,
        };
      }),
    );
    return { providers, models, defaultModel: business.defaultModel, localAvailable };
  }

  /** Saves the business's own key after checking it with the provider. */
  async saveKey(ctx: BusinessContext, provider: string, apiKey: unknown) {
    const p = this.validProvider(provider);
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!key) throw new BadRequestException("apiKey is required");
    if (key.length > 500) throw new BadRequestException("That doesn't look like an API key");
    const test = await testKey(p, key);
    if (!test.ok) throw new BadRequestException(test.message);
    const data = { config: {}, secretsEncrypted: encryptJson({ apiKey: key }), enabled: true };
    await prisma.integrationConnection.upsert({
      where: { businessId_provider: { businessId: ctx.businessId, provider: p } },
      update: data,
      create: { ...data, businessId: ctx.businessId, provider: p, connectedByUserId: ctx.userId ?? "api" },
    });
    return this.overview(ctx.businessId);
  }

  /** Removes the business's key; calls go back to Suuper's key (if there is one). */
  async removeKey(businessId: string, provider: string) {
    const p = this.validProvider(provider);
    const deleted = await prisma.integrationConnection.deleteMany({ where: { businessId, provider: p } });
    if (deleted.count === 0) throw new NotFoundException("No key saved for this provider");
    return this.overview(businessId);
  }

  /** Tests the key calls would use right now (theirs, else Suuper's). */
  async test(businessId: string, provider: string): Promise<AiKeyTestResult> {
    const p = this.validProvider(provider);
    const key = await providerKey(businessId, p);
    if (!key) return { ok: false, message: `There's no ${cloudProvider(p)!.name} key to test. Add one first.` };
    const result = await testKey(p, key.apiKey);
    return key.ownKey || !result.ok ? result : { ...result, message: "Suuper's key works." };
  }

  /** null: pick automatically (the first model with a usable key). */
  async setDefaultModel(businessId: string, model: unknown) {
    if (model !== null && (typeof model !== "string" || !findModel(model))) {
      throw new BadRequestException("model must be one of the listed models, or null");
    }
    await prisma.business.update({ where: { id: businessId }, data: { defaultModel: model } });
    return this.overview(businessId);
  }

  private validProvider(provider: string): AiProviderKey {
    if (!cloudProvider(provider)) throw new BadRequestException(`provider must be one of: ${CLOUD_PROVIDERS.map((p) => p.key).join(", ")}`);
    return provider as AiProviderKey;
  }
}
