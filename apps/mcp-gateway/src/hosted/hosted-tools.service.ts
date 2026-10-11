import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma, Prisma } from "@platform/database";
import { decryptJson, encryptJson } from "@platform/shared-auth";
import { HOSTED_TOOL_METHODS, type HostedToolParam, type HostedToolParamType } from "@platform/shared-types";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PARAM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const PARAM_TYPES: HostedToolParamType[] = ["string", "number", "integer", "boolean"];
const MAX_TOOLS_PER_SERVER = 100;

export interface HostedToolInput {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  method?: unknown;
  urlTemplate?: unknown;
  headers?: unknown;
  /** Secret headers to set; a "" value removes that header. Omitted headers are kept. */
  secretHeaders?: unknown;
  timeoutMs?: unknown;
}

@Injectable()
export class HostedToolsService {
  async create(businessId: string, serverId: string, input: HostedToolInput) {
    await this.requireHostedServer(businessId, serverId);
    const count = await prisma.mcpHostedTool.count({ where: { serverId } });
    if (count >= MAX_TOOLS_PER_SERVER) throw new BadRequestException(`A server can have at most ${MAX_TOOLS_PER_SERVER} tools`);
    const data = this.validate(input, true);
    try {
      const tool = await prisma.mcpHostedTool.create({
        data: {
          serverId,
          ...data,
          secretHeadersEncrypted: this.mergeSecrets(null, input.secretHeaders),
        } as Prisma.McpHostedToolUncheckedCreateInput,
      });
      return { id: tool.id };
    } catch (err) {
      throw this.uniqueError(err);
    }
  }

  async update(businessId: string, serverId: string, toolId: string, input: HostedToolInput) {
    await this.requireHostedServer(businessId, serverId);
    const existing = await prisma.mcpHostedTool.findUnique({ where: { id: toolId } });
    if (!existing || existing.serverId !== serverId) throw new NotFoundException("Tool not found");
    const data = this.validate(input, false);
    try {
      await prisma.mcpHostedTool.update({
        where: { id: toolId },
        data: {
          ...data,
          ...(input.secretHeaders !== undefined
            ? { secretHeadersEncrypted: this.mergeSecrets(existing.secretHeadersEncrypted, input.secretHeaders) }
            : {}),
        },
      });
      return { id: toolId };
    } catch (err) {
      throw this.uniqueError(err);
    }
  }

  async remove(businessId: string, serverId: string, toolId: string) {
    await this.requireHostedServer(businessId, serverId);
    const existing = await prisma.mcpHostedTool.findUnique({ where: { id: toolId } });
    if (!existing || existing.serverId !== serverId) throw new NotFoundException("Tool not found");
    await prisma.mcpHostedTool.delete({ where: { id: toolId } });
  }

  private async requireHostedServer(businessId: string, serverId: string) {
    const server = await prisma.mcpServer.findUnique({ where: { id: serverId } });
    if (!server || server.businessId !== businessId) throw new NotFoundException("MCP server not found");
    if (server.mode !== "hosted") throw new BadRequestException("Tools can only be defined on hosted servers");
    return server;
  }

  private validate(input: HostedToolInput, creating: boolean) {
    const data: Record<string, unknown> = {};
    const need = (key: keyof HostedToolInput) => creating || input[key] !== undefined;

    if (need("name")) {
      if (typeof input.name !== "string" || !NAME_RE.test(input.name)) {
        throw new BadRequestException("name must be 1–64 letters, numbers, _ or -");
      }
      data.name = input.name;
    }
    if (need("description")) {
      if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 1000) {
        throw new BadRequestException("description is required (max 1000 characters) — models read it to decide when to call the tool");
      }
      data.description = input.description.trim();
    }
    if (need("method")) {
      const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET";
      if (!(HOSTED_TOOL_METHODS as readonly string[]).includes(method)) {
        throw new BadRequestException(`method must be one of: ${HOSTED_TOOL_METHODS.join(", ")}`);
      }
      data.method = method;
    }
    if (need("urlTemplate")) {
      if (typeof input.urlTemplate !== "string" || !/^https?:\/\//i.test(input.urlTemplate) || input.urlTemplate.length > 2000) {
        throw new BadRequestException("urlTemplate must be an http(s) URL; use {{param}} for parameters");
      }
      data.urlTemplate = input.urlTemplate.trim();
    }
    if (need("parameters")) data.parameters = this.validParams(input.parameters ?? []) as unknown as Prisma.InputJsonValue;
    if (need("headers")) data.headers = this.validHeaders(input.headers ?? {}, "headers");
    if (input.timeoutMs !== undefined) {
      if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 60_000) {
        throw new BadRequestException("timeoutMs must be between 1000 and 60000");
      }
      data.timeoutMs = input.timeoutMs;
    }

    // Every {{placeholder}} must be a declared parameter.
    const template = (data.urlTemplate as string | undefined) ?? undefined;
    const params = data.parameters as HostedToolParam[] | undefined;
    if (template && params) {
      const missing = [...template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)]
        .map((m) => m[1])
        .filter((name) => !params.some((p) => p.name === name));
      if (missing.length) throw new BadRequestException(`URL uses undeclared parameter(s): ${missing.join(", ")}`);
    }
    return data;
  }

  private validParams(value: unknown): HostedToolParam[] {
    if (!Array.isArray(value) || value.length > 30) throw new BadRequestException("parameters must be an array (max 30)");
    const seen = new Set<string>();
    return value.map((raw, i) => {
      const p = raw as Partial<HostedToolParam>;
      if (typeof p?.name !== "string" || !PARAM_NAME_RE.test(p.name)) {
        throw new BadRequestException(`parameters[${i}].name must be a valid identifier`);
      }
      if (seen.has(p.name)) throw new BadRequestException(`Duplicate parameter: ${p.name}`);
      seen.add(p.name);
      if (!PARAM_TYPES.includes(p.type as HostedToolParamType)) {
        throw new BadRequestException(`parameters[${i}].type must be one of: ${PARAM_TYPES.join(", ")}`);
      }
      const enumValues = Array.isArray(p.enum) ? p.enum.filter((v): v is string => typeof v === "string" && v.length > 0) : undefined;
      if (enumValues?.length && p.type !== "string") {
        throw new BadRequestException(`parameters[${i}] (${p.name}): allowed values only apply to string parameters`);
      }
      return {
        name: p.name,
        type: p.type as HostedToolParamType,
        description: typeof p.description === "string" && p.description.trim() ? p.description.trim().slice(0, 500) : undefined,
        required: p.required === true,
        ...(enumValues?.length ? { enum: enumValues } : {}),
      };
    });
  }

  private validHeaders(value: unknown, field: string): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(`${field} must be an object`);
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 20) throw new BadRequestException(`${field}: at most 20 headers`);
    for (const [k, v] of entries) {
      if (!HEADER_NAME_RE.test(k)) throw new BadRequestException(`${field}: invalid header name "${k}"`);
      if (typeof v !== "string" || v.length > 4000) throw new BadRequestException(`${field}: "${k}" must be a string`);
    }
    return value as Record<string, string>;
  }

  private mergeSecrets(existingEncrypted: string | null, update: unknown): string | null {
    if (update === undefined) return existingEncrypted;
    const changes = this.validHeaders(update, "secretHeaders");
    const merged = existingEncrypted ? decryptJson<Record<string, string>>(existingEncrypted) : {};
    for (const [k, v] of Object.entries(changes)) {
      if (v === "") delete merged[k];
      else merged[k] = v;
    }
    return Object.keys(merged).length ? encryptJson(merged) : null;
  }

  private uniqueError(err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return new ConflictException("A tool with that name already exists on this server");
    }
    return err;
  }
}
