import type Anthropic from "@anthropic-ai/sdk";

// The runtime speaks Anthropic's message/content-block format everywhere
// (it's what gets persisted). Other providers translate to and from it.
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
export type ClientTool = Anthropic.Beta.BetaTool;

export interface TurnRequest {
  model: string;
  system: string;
  messages: MessageParam[];
  /** Tools the runtime executes. */
  tools: ClientTool[];
  /** Provider-hosted tools by key (e.g. "web_search"); ignored by providers without them. */
  serverTools: string[];
}

export interface TurnResult {
  content: ContentBlockParam[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelProvider {
  /** One model call. Text is streamed through onText as it's generated. */
  runTurn(request: TurnRequest, onText: (delta: string) => void): Promise<TurnResult>;
}
