import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma, Prisma } from "@platform/database";
import { assertPublicUrl, decryptJson, encryptJson } from "@platform/shared-auth";
import { loadServiceConfig } from "@platform/shared-config";
import type { McpAuthType, McpTransport } from "@platform/shared-types";
import { discoverTools } from "../mcp/external-client";
import { ToolRunnerService } from "../mcp/tool-runner.service";

const config = loadServiceConfig("mcp-gateway", 3003);
const TRANSPORTS: McpTransport[] = ["auto", "streamable_http", "sse"];
const AUTH_TYPES: McpAuthType[] = ["none", "bearer", "header"];
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

type ServerRow = Prisma.McpServerGetPayload<object>;

export interface ServerInput {
  name?: unknown;
  description?: unknown;
  mode?: unknown;
  endpointUrl?: unknown;
  transport?: unknown;
  authType?: unknown;
  authHeaderName?: unknown;
  /** Bearer token / header value. Omit to keep the stored one; "" to clear. */
  authSecret?: unknown;
  enabled?: unknown;
}

export function hashAccessKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

@Injectable()
export class ServersService {
  constructor(private readonly runner: ToolRunnerService) {}

  async list(businessId: string) {
    const servers = await prisma.mcpServer.findMany({
      where: { businessId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { hostedTools: true } } },
    });
    return Promise.all(servers.map((s) => this.serialize(s)));
  }

  async get(businessId: string, id: string) {
    const server = await this.require(businessId, id);
    const hostedTools =
      server.mode === "hosted"
        ? await prisma.mcpHostedTool.findMany({ where: { serverId: id }, orderBy: { name: "asc" } })
        : [];
    return {
      ...(await this.serialize(server)),
      hostedTools: hostedTools.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        method: t.method,
        urlTemplate: t.urlTemplate,
        headers: t.headers,
        // Names only — secret header values never leave the server.
        secretHeaderNames: t.secretHeadersEncrypted ? Object.keys(decryptJson<Record<string, string>>(t.secretHeadersEncrypted)) : [],
        timeoutMs: t.timeoutMs,
      })),
    };
  }

  /** Creating an external server connects right away so the user sees tools (or the error) immediately. */
  async create(businessId: string, input: ServerInput) {
    const name = this.validName(input.name);
    const mode = input.mode === "hosted" ? "hosted" : input.mode === "external" ? "external" : null;
    if (!mode) throw new BadRequestException('mode must be "hosted" or "external"');

    if (mode === "hosted") {
      const server = await prisma.mcpServer.create({
        data: { businessId, name, description: this.validDescription(input.description), mode, status: "connected" },
      });
      // Hosted servers get an access key for outside MCP clients; shown once in the response.
      const accessKey = await this.issueAccessKey(server.id);
      return { ...(await this.get(businessId, server.id)), accessKey };
    }

    const external = await this.externalFields(input, true);
    const server = await prisma.mcpServer.create({
      data: { businessId, name, description: this.validDescription(input.description), mode, ...external },
    });
    await this.refreshExternal(server.id);
    return this.get(businessId, server.id);
  }

  async update(businessId: string, id: string, input: ServerInput) {
    const server = await this.require(businessId, id);
    const data: Prisma.McpServerUpdateInput = {};
    if (input.name !== undefined) data.name = this.validName(input.name);
    if (input.description !== undefined) data.description = this.validDescription(input.description);
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw new BadRequestException("enabled must be a boolean");
      data.enabled = input.enabled;
    }
    const connectionChanged =
      server.mode === "external" &&
      ["endpointUrl", "transport", "authType", "authHeaderName", "authSecret"].some((k) => input[k as keyof ServerInput] !== undefined);
    if (connectionChanged) Object.assign(data, await this.externalFields({ ...this.currentExternal(server), ...input }, false, server));

    await prisma.mcpServer.update({ where: { id }, data });
    if (connectionChanged) await this.refreshExternal(id);
    return this.get(businessId, id);
  }

  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    // Detach from agents and bots so they don't keep a dangling id.
    await prisma.$transaction([
      prisma.$executeRaw`UPDATE "Agent" SET "mcpServerIds" = array_remove("mcpServerIds", ${id}) WHERE "businessId" = ${businessId}`,
      prisma.$executeRaw`UPDATE "Bot" SET "mcpServerIds" = array_remove("mcpServerIds", ${id}) WHERE "businessId" = ${businessId}`,
      prisma.mcpServer.delete({ where: { id } }),
    ]);
  }

  /** Re-connect and re-discover tools (external). Hosted servers are always current. */
  async refresh(businessId: string, id: string) {
    const server = await this.require(businessId, id);
    if (server.mode === "external") await this.refreshExternal(id);
    else await prisma.mcpServer.update({ where: { id }, data: { lastCheckedAt: new Date(), status: "connected", lastError: null } });
    return this.get(businessId, id);
  }

  async rotateAccessKey(businessId: string, id: string) {
    const server = await this.require(businessId, id);
    if (server.mode !== "hosted") throw new BadRequestException("Only hosted servers have access keys");
    return { accessKey: await this.issueAccessKey(id) };
  }

  async listCalls(businessId: string, filters: { serverId?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
    const calls = await prisma.mcpToolCall.findMany({
      where: { businessId, ...(filters.serverId ? { serverId: filters.serverId } : {}) },
      include: { server: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return calls.map((c) => ({
      id: c.id,
      serverId: c.serverId,
      serverName: c.server.name,
      toolName: c.toolName,
      source: c.source,
      input: c.input,
      output: (c.output as { content?: string } | null)?.content ?? "",
      isError: c.isError,
      durationMs: c.durationMs,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async require(businessId: string, id: string) {
    const server = await prisma.mcpServer.findUnique({
      where: { id },
      include: { _count: { select: { hostedTools: true } } },
    });
    if (!server || server.businessId !== businessId) throw new NotFoundException("MCP server not found");
    return server;
  }

  private async refreshExternal(id: string) {
    const server = await prisma.mcpServer.findUniqueOrThrow({ where: { id } });
    try {
      const { tools, transport } = await discoverTools(server);
      await prisma.mcpServer.update({
        where: { id },
        data: {
          tools: tools as unknown as Prisma.InputJsonValue,
          status: "connected",
          lastError: null,
          lastCheckedAt: new Date(),
          // Remember what worked so later calls skip the fallback attempt.
          ...(server.transport === "auto" ? { transport } : {}),
        },
      });
    } catch (err) {
      await prisma.mcpServer.update({
        where: { id },
        data: { status: "error", lastError: ((err as Error).message || "Connection failed").slice(0, 500), lastCheckedAt: new Date() },
      });
    }
  }

  private async issueAccessKey(id: string) {
    const key = `mcp_${randomBytes(24).toString("base64url")}`;
    await prisma.mcpServer.update({
      where: { id },
      data: { accessKeyHash: hashAccessKey(key), accessKeyPrefix: key.slice(0, 12) },
    });
    return key;
  }

  private currentExternal(server: ServerRow): ServerInput {
    return {
      endpointUrl: server.endpointUrl,
      transport: server.transport,
      authType: server.authType,
      authHeaderName: server.authHeaderName,
    };
  }

  private async externalFields(input: ServerInput, creating: boolean, existing?: ServerRow) {
    if (typeof input.endpointUrl !== "string" || !input.endpointUrl.trim()) throw new BadRequestException("endpointUrl is required");
    const endpointUrl = input.endpointUrl.trim();
    try {
      await assertPublicUrl(endpointUrl, { allowPrivate: config.mcpAllowPrivateUrls });
    } catch (err) {
      throw new BadRequestException(`endpointUrl: ${(err as Error).message}`);
    }
    const transport = (input.transport ?? "auto") as McpTransport;
    if (!TRANSPORTS.includes(transport)) throw new BadRequestException(`transport must be one of: ${TRANSPORTS.join(", ")}`);
    const authType = (input.authType ?? "none") as McpAuthType;
    if (!AUTH_TYPES.includes(authType)) throw new BadRequestException(`authType must be one of: ${AUTH_TYPES.join(", ")}`);

    let authHeaderName: string | null = null;
    if (authType === "header") {
      if (typeof input.authHeaderName !== "string" || !HEADER_NAME_RE.test(input.authHeaderName)) {
        throw new BadRequestException("authHeaderName must be a valid header name");
      }
      authHeaderName = input.authHeaderName;
    }

    let secretsEncrypted: string | null | undefined = undefined; // undefined = keep
    if (authType === "none") secretsEncrypted = null;
    else if (typeof input.authSecret === "string" && input.authSecret.length > 0) {
      if (input.authSecret.length > 4000) throw new BadRequestException("authSecret is too long");
      secretsEncrypted = encryptJson({ secret: input.authSecret });
    } else if (creating || !existing?.secretsEncrypted) {
      throw new BadRequestException("authSecret is required for this auth type");
    }

    return {
      endpointUrl,
      transport,
      authType,
      authHeaderName,
      ...(secretsEncrypted !== undefined ? { secretsEncrypted } : {}),
      status: "pending",
    };
  }

  private validName(name: unknown) {
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 60) {
      throw new BadRequestException("name must be between 2 and 60 characters");
    }
    return name.trim();
  }

  private validDescription(value: unknown) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 500) throw new BadRequestException("description must be under 500 characters");
    return value.trim() || null;
  }

  private async serialize(server: ServerRow & { _count?: { hostedTools: number } }) {
    const tools = await this.runner.toolsFor(server);
    return {
      id: server.id,
      name: server.name,
      description: server.description ?? undefined,
      mode: server.mode,
      endpointUrl: server.mode === "external" ? (server.endpointUrl ?? undefined) : undefined,
      transport: server.transport,
      authType: server.authType,
      authHeaderName: server.authHeaderName ?? undefined,
      hasAuthSecret: !!server.secretsEncrypted,
      enabled: server.enabled,
      status: server.mode === "hosted" ? "connected" : server.status,
      lastError: server.lastError ?? undefined,
      lastCheckedAt: server.lastCheckedAt?.toISOString(),
      tools,
      // Where outside MCP clients connect to a hosted server.
      mcpUrl: server.mode === "hosted" ? `${config.publicApiUrl}/mcp/${server.id}` : undefined,
      accessKeyPrefix: server.accessKeyPrefix ?? undefined,
      createdAt: server.createdAt.toISOString(),
      updatedAt: server.updatedAt.toISOString(),
    };
  }
}
