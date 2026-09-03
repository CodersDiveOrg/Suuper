import { TenantId } from "./tenant";

export interface Bot {
  id: string;
  tenantId: TenantId;
  name: string;
  systemPrompt: string;
  model: string;
  mcpServerIds: string[];
  knowledgeBaseIds: string[];
  createdAt: string;
}

export interface McpServer {
  id: string;
  tenantId: TenantId;
  name: string;
  /** "hosted": platform runs this server for the tenant. "external": tenant points to a server they run themselves. */
  mode: "hosted" | "external";
  endpointUrl?: string;
  status: "provisioning" | "running" | "stopped" | "error";
  createdAt: string;
}

export interface KnowledgeBase {
  id: string;
  tenantId: TenantId;
  name: string;
  sourceType: "upload" | "crawl" | "connector";
  status: "syncing" | "ready" | "error";
  createdAt: string;
}
