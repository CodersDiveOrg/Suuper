import { BadRequestException } from "@nestjs/common";
import { prisma } from "@platform/database";

/** Validates MCP server ids for an agent or bot: an array of this business's own servers. */
export async function validMcpServerIds(businessId: string, value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new BadRequestException("mcpServerIds must be an array of ids");
  }
  const ids = [...new Set(value as string[])];
  if (ids.length === 0) return [];
  const found = await prisma.mcpServer.count({ where: { id: { in: ids }, businessId } });
  if (found !== ids.length) throw new BadRequestException("One or more MCP servers don't exist in this business");
  return ids;
}
