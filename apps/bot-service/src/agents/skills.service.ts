import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@platform/database";
import { isToolKey, toolCatalog } from "./runtime/tools";

export interface SkillInput {
  name?: string;
  description?: string;
  instructions?: string;
  tools?: unknown;
}

const MAX_INSTRUCTIONS = 20_000;

@Injectable()
export class SkillsService {
  /** Skills with the agents using each one. */
  async list(businessId: string) {
    const [skills, agents] = await Promise.all([
      prisma.agentSkill.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } }),
      prisma.agent.findMany({ where: { businessId, skillIds: { isEmpty: false } }, select: { id: true, name: true, skillIds: true } }),
    ]);
    return skills.map((skill) => ({
      ...this.serialize(skill),
      agents: agents.filter((a) => a.skillIds.includes(skill.id)).map((a) => ({ id: a.id, name: a.name })),
    }));
  }

  async create(businessId: string, input: SkillInput) {
    const skill = await prisma.agentSkill.create({
      data: {
        businessId,
        name: this.validName(input.name),
        description: input.description?.trim() || null,
        instructions: this.validInstructions(input.instructions),
        tools: input.tools !== undefined ? this.validTools(input.tools) : [],
      },
    });
    return { ...this.serialize(skill), agents: [] };
  }

  async update(businessId: string, id: string, input: SkillInput) {
    await this.require(businessId, id);
    const skill = await prisma.agentSkill.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: this.validName(input.name) } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
        ...(input.instructions !== undefined ? { instructions: this.validInstructions(input.instructions) } : {}),
        ...(input.tools !== undefined ? { tools: this.validTools(input.tools) } : {}),
      },
    });
    return this.serialize(skill);
  }

  /** Also detaches the skill from every agent that had it. */
  async remove(businessId: string, id: string) {
    await this.require(businessId, id);
    await prisma.$transaction([
      prisma.$executeRaw`UPDATE "Agent" SET "skillIds" = array_remove("skillIds", ${id}) WHERE "businessId" = ${businessId} AND ${id} = ANY("skillIds")`,
      prisma.agentSkill.delete({ where: { id } }),
    ]);
  }

  private async require(businessId: string, id: string) {
    const skill = await prisma.agentSkill.findUnique({ where: { id } });
    if (!skill || skill.businessId !== businessId) throw new NotFoundException("Skill not found");
    return skill;
  }

  private validName(name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw new BadRequestException("name is required");
    return name.trim().slice(0, 80);
  }

  private validInstructions(value: unknown) {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException("instructions are required");
    if (value.length > MAX_INSTRUCTIONS) throw new BadRequestException(`instructions must be at most ${MAX_INSTRUCTIONS.toLocaleString()} characters`);
    return value.trim();
  }

  private validTools(tools: unknown) {
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && isToolKey(t))) {
      throw new BadRequestException(`tools must be an array of: ${toolCatalog().map((t) => t.key).join(", ")}`);
    }
    return [...new Set(tools as string[])];
  }

  private serialize(skill: {
    id: string;
    name: string;
    description: string | null;
    instructions: string;
    tools: string[];
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description ?? undefined,
      instructions: skill.instructions,
      tools: skill.tools,
      createdAt: skill.createdAt.toISOString(),
      updatedAt: skill.updatedAt.toISOString(),
    };
  }
}
