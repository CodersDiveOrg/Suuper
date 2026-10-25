// Settings → AI Models (GET /businesses/current/ai-models).

export type AiProviderKey = "anthropic" | "openai" | "gemini";
export type AiModelProvider = AiProviderKey | "ollama";

export interface AiProviderStatus {
  key: AiProviderKey;
  name: string;
  /** Where to create a key at the provider. */
  keysUrl: string;
  /** Suuper has its own key for this provider on the server. */
  platformKey: boolean;
  /** The business's own key, masked ("••••a1b2"); null when they haven't added one. */
  businessKey: { hint: string; updatedAt: string } | null;
  /** Which key calls use right now: theirs wins over Suuper's. null: the provider can't be used. */
  active: "business" | "platform" | null;
}

export interface AiModelInfo {
  id: string;
  label: string;
  provider: AiModelProvider;
  description: string;
  /** USD per million input / output tokens. */
  pricing: { input: number; output: number };
  available: boolean;
  keySource?: "business" | "platform" | "local";
  unavailableReason?: string;
}

export interface AiModelsOverview {
  providers: AiProviderStatus[];
  models: AiModelInfo[];
  /** Model new bots, agents, app helpers and workflow steps start with; null: chosen automatically. */
  defaultModel: string | null;
  /** The local Ollama server answers (free local models). */
  localAvailable: boolean;
}

export interface AiKeyTestResult {
  ok: boolean;
  message: string;
}
