# Architecture

## What this is

A multi-tenant platform for enterprises to automate their existing operations with AI. Each
tenant can, within one platform:

1. **Create bots** — AI agents with a system prompt, a model, and a set of tools/knowledge.
2. **Create MCP servers** — either hosted by the platform (wrapping the tenant's internal
   systems/APIs as tools) or external (the tenant points at an MCP server they already run).
   Bots use these as their tool layer.
3. **Add knowledge bases** — the tenant's existing data (documents, crawled sites, connectors),
   ingested and made retrievable so bots can ground answers/actions in it (RAG).

Tenants are enterprises, so identity, isolation, and audit are first-class, not bolted on later.

## Guiding principle: scale-ready, not scale-first

Target is 50k+ users eventually, reached gradually. The service boundaries below are drawn as if
at scale from day one (so splitting/scaling later doesn't require a rewrite), but the *infra*
underneath starts minimal — one small Postgres, one small ECS cluster, low replica counts — and
scales out horizontally as load actually demands it. Don't provision for 50k users on day one;
provision to not have to re-architect for them.

## Services

| Service | Responsibility |
|---|---|
| `api-gateway` | Single public entry point. AuthN/Z enforcement, rate limiting, routes to internal services. Only service exposed to the internet. |
| `identity-service` | Tenants, users, roles, enterprise SSO (SAML/OIDC), JWT issuance. |
| `bot-service` | Bot definitions; runs the agent loop (LLM + tool calls) per conversation. |
| `mcp-gateway` | Registry of tenant MCP servers; proxies MCP protocol calls; provisions/lifecycles hosted MCP servers. |
| `knowledge-service` | Knowledge base CRUD, ingestion pipeline coordination, retrieval API (RAG) used by `bot-service`. |
| `worker` | Async job runner behind a queue: document ingestion, embedding generation, MCP server provisioning. Keeps slow AI/IO work off the request path. |

The tenant dashboard (Next.js) lives in a separate repo, `ai-automation-platform-web`, and talks
to this backend exclusively through `api-gateway` — see that repo's README for its architecture
(Redux Toolkit + Axios, route protection, API contract).

Internal services are not reachable from outside the cluster; only `api-gateway` is. Services
call each other over plain HTTP internally to start — no service mesh, no gRPC — because the
operational cost isn't justified yet. Revisit if inter-service call volume becomes a bottleneck.

## Multi-tenancy

- Every tenant-owned table has a `tenantId` column and an index on it (see
  `packages/database/prisma/schema.prisma`).
- Default isolation: **shared database, shared schema, Postgres row-level security** keyed on
  `tenantId`. This is what scales cleanly to thousands of tenants without a connection-pool or
  migration-fanout explosion.
- `Tenant.isolationTier` (`shared` | `dedicated`) exists so a specific large enterprise tenant can
  be promoted to a dedicated schema/database later for compliance reasons, without changing
  application code — just where that tenant's rows physically live.
- The JWT issued by `identity-service` carries `tenantId` + `roles`. `api-gateway` validates it
  and every downstream service trusts the resulting `TenantContext`
  (`packages/shared-auth/src/tenant-context.guard.ts`) — never trust a client-supplied tenant id.

## AI / MCP layer

- **Model provider**: Claude, via a single abstraction point in `bot-service` so a different or
  additional provider can be added later without touching bot logic elsewhere.
- **Tools**: bots reach tools exclusively through MCP (`@modelcontextprotocol/sdk`). `mcp-gateway`
  is the only service that speaks MCP directly to tenant servers — `bot-service` asks it for
  "the tools this bot has" and gets back a normalized list, so bot orchestration logic doesn't
  need to know whether a given MCP server is hosted or external.
- **Knowledge/RAG**: `knowledge-service` owns ingestion + embeddings + retrieval. `bot-service`
  calls it for context, it never touches the vector store directly. Start with `pgvector` inside
  the same Postgres instance — one less moving part — and split to a dedicated vector store only
  if retrieval latency or index size demands it.

## Data & infra (AWS)

- **Postgres (RDS) + pgvector** — primary datastore and vector store, single instance to start.
- **Redis (ElastiCache)** — caching, session data, light job queues.
- **SQS/SNS** — cross-service async events and the `worker` job queue (managed, no ops burden;
  revisit Kafka/NATS only if event volume outgrows it).
- **S3** — uploaded knowledge base files.
- **ECS Fargate** — container hosting to start (lower ops overhead than EKS). Services are plain
  containers with no Fargate-specific code, so moving to EKS later, if/when team size or scaling
  needs justify the added complexity, is an infra change, not an app change.
- **Terraform** (`infra/terraform`, placeholder) — IaC for the above, built out as each piece is
  actually deployed rather than upfront.

## Repo layout

Monorepo (pnpm workspaces + Turborepo) so services and shared packages share tooling and can be
built/tested incrementally with caching, while still deploying independently.

```
apps/
  api-gateway/       identity-service/   bot-service/
  mcp-gateway/        knowledge-service/  worker/
packages/
  database/           # Prisma schema + client (packages/database/prisma/schema.prisma)
  shared-types/        # Domain types shared by every service (Tenant, Bot, McpServer, ...)
  shared-config/        # Env loading
  shared-auth/            # TenantContextGuard (JWT -> TenantContext)
infra/
  docker-compose.yml   # Local Postgres+pgvector, Redis
  terraform/            # AWS IaC (to be built out)
```

## What's deliberately not built yet

Every service currently exposes only a `/health` endpoint. No bot orchestration logic, MCP
provisioning, or ingestion pipeline — those get built feature by feature on top of this skeleton,
starting with `identity-service` (auth has to exist before anything else is meaningful) then
`bot-service` + `mcp-gateway` together (a bot is only useful once it can call a tool).
