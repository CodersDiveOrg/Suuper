import { prisma } from "@platform/database";

export interface SkillForRun {
  name: string;
  instructions: string;
  tools: string[];
}

/** The agent's attached skills, in the order they were attached. Ids of deleted skills are skipped. */
export async function loadSkills(businessId: string, skillIds: string[]): Promise<SkillForRun[]> {
  if (skillIds.length === 0) return [];
  const skills = await prisma.agentSkill.findMany({
    where: { businessId, id: { in: skillIds } },
    select: { id: true, name: true, instructions: true, tools: true },
  });
  return skillIds.flatMap((id) => skills.filter((s) => s.id === id));
}

/** The agent's own instructions, followed by one section per skill. */
export function withSkills(systemPrompt: string, skills: SkillForRun[]) {
  if (skills.length === 0) return systemPrompt;
  const sections = skills.map((s) => `## Skill: ${s.name}\n\n${s.instructions}`);
  return `${systemPrompt}\n\n# Skills\n\nYou also have these skills. Follow a skill's instructions whenever the request is one it covers.\n\n${sections.join("\n\n")}`;
}
