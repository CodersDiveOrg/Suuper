import { BusinessId } from "./business";

/** An internal AI assistant for the business owner/team — not a customer-facing
 * embeddable widget like Bot. Same shape as Bot minus the widget fields. */
export interface Agent {
  id: string;
  businessId: BusinessId;
  name: string;
  description?: string;
  systemPrompt: string;
  /** "claude-*" (Anthropic) or a local Ollama model — see bot-service runtime/models.ts. */
  model: string;
  /** Enabled built-in tool keys — see bot-service runtime/tools.ts. */
  tools: string[];
  /** Max model calls per run. */
  maxSteps: number;
  mcpServerIds: string[];
  knowledgeBaseIds: string[];
  /** AgentSkill ids; their instructions and tools are added at run time. */
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type AgentRunStatus = "running" | "succeeded" | "failed";
