# Architecture

## What this is

A platform for enterprises to automate their existing operations with AI. The platform hosts many
**businesses**; within one business its members can:

1. **Create bots** — AI agents with a system prompt, a model, and a set of tools/knowledge.
2. **Create MCP servers** — either hosted by the platform (wrapping the business's internal
   systems/APIs as tools) or external (the business points at an MCP server they already run).
   Bots use these as their tool layer.
3. **Add knowledge bases** — the business's existing data (documents, crawled sites, connectors),
   ingested and made retrievable so bots can ground answers/actions in it (RAG).

Businesses are enterprises, so identity, isolation, and audit are first-class, not bolted on
later.

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
| `identity-service` | Businesses, users, memberships, roles/permissions, invitations, enterprise SSO (SAML/OIDC), JWT issuance. |
| `bot-service` | Bot definitions; runs the agent loop (LLM + tool calls) per conversation. |
| `mcp-gateway` | Registry of a business's MCP servers; proxies MCP protocol calls; provisions/lifecycles hosted MCP servers. |
| `knowledge-service` | Knowledge base CRUD, ingestion pipeline coordination, retrieval API (RAG) used by `bot-service`. |
| `worker` | Async job runner behind a queue: document ingestion, embedding generation, MCP server provisioning. Keeps slow AI/IO work off the request path. |

The business dashboard (Next.js) lives in a separate repo, `ai-automation-platform-web`, and talks
to this backend exclusively through `api-gateway` — see that repo's README for its architecture
(Redux Toolkit + Axios, route protection, API contract).

Internal services are not reachable from outside the cluster; only `api-gateway` is. Services
call each other over plain HTTP internally to start — no service mesh, no gRPC — because the
operational cost isn't justified yet. Revisit if inter-service call volume becomes a bottleneck.

## Businesses & membership

- A **business** is an organisation on the platform. A **user** is a single global account
  (`email` is globally unique). A **membership** links one user to one business with a `role`
  (`owner` / `admin` / `member` / `viewer`); `@@unique([userId, businessId])`. The same user can
  be a member of many businesses with a different role in each.
- Roles map to a fixed permission set in code (`packages/shared-types/src/business.ts`,
  `permissionsForRole`). When roles need to be configurable per business, that map becomes the
  default seeded on business creation and nothing else changes.
- Every business-owned table has a `businessId` column and an index on it (see
  `packages/database/prisma/schema.prisma`).
- Default isolation: **shared database, shared schema, Postgres row-level security** keyed on
  `businessId` (RLS policies not written yet). This scales cleanly to thousands of businesses
  without a connection-pool or migration-fanout explosion.
- `Business.isolationTier` (`shared` | `dedicated`) exists so a specific large business can be
  promoted to a dedicated schema/database later for compliance reasons, without changing
  application code — just where that business's rows physically live.

### Auth flow

- `POST /auth/login` verifies email/password and returns a **user token** (JWT, `typ: "user"`)
  plus the list of businesses the user belongs to.
- `POST /auth/businesses/:id/session` exchanges the user token for a **business-scoped access
  token** (JWT, `typ: "business"`) carrying `userId`, `businessId`, `role`, and the resolved
  `permissions`. Switching business = requesting a new access token.
- Every business-scoped route uses `BusinessContextGuard` + `@RequirePermission(...)`
  (`packages/shared-auth`). The `businessId` always comes from the token, so those routes are
  pathed at `/businesses/current/...` — a client-supplied business id is never trusted.
- Invitations: an `owner`/`admin` invites an email at a role; the invitee (after registering if
  needed) calls `POST /invitations/accept`, which creates the membership. Email must match.
- Self-serve creation: any logged-in user can call `POST /businesses` with a `name` to start a new
  business; they become its first `owner`. The slug is derived from the name (deduplicated with a
  numeric suffix on collision).

## AI / MCP layer

- **Model provider**: bots reach the model behind a single abstraction point (`packages/shared-ai`)
  so a given bot's provider can change without touching orchestration logic elsewhere. The first
  bot type (product recommendation, below) uses **Ollama** running locally
  (`infra/docker-compose.yml`) — free, no API key, no external account — for both embeddings
  (`nomic-embed-text`) and chat replies (`llama3.2:3b`). Claude (`ANTHROPIC_API_KEY`) stays wired
  for other/future bots; nothing here forecloses using it.
- **Tools**: bots reach tools exclusively through MCP (`@modelcontextprotocol/sdk`). `mcp-gateway`
  is the only service that speaks MCP directly to a business's servers — `bot-service` asks it for
  "the tools this bot has" and gets back a normalized list, so bot orchestration logic doesn't
  need to know whether a given MCP server is hosted or external.
- **Knowledge/RAG**: `knowledge-service` owns ingestion + embeddings + retrieval. `bot-service`
  calls it for context, it never touches the vector store directly. Uses `pgvector` inside the
  same Postgres instance — one less moving part — and would split to a dedicated vector store only
  if retrieval latency or index size demands it; `bot-service` never touching the DB directly means
  that split, if it ever happens, doesn't touch `bot-service` at all.

### Product recommendation flow (v1)

The first end-to-end bot type: point it at a store URL, it ingests the catalog, and a bot answers
shopping questions grounded in what it found. Stateless single-turn for now — no conversation
history is persisted, each message is answered independently.

1. `POST /businesses/current/knowledge-bases { name, sourceUrl }` creates a `KnowledgeBase`
   (`status: "syncing"`) and enqueues an `ingest-knowledge-base` BullMQ job (Redis-backed) — scraping
   and embedding never happen on the request path.
2. `worker` consumes the job and tries ingestion tiers in order of reliability, stopping at the
   first that yields products (`apps/worker/src/ingestion`):
   1. Shopify's public `/products.json`
   2. WooCommerce's public Store API (`/wp-json/wc/store/v1/products`)
   3. schema.org `Product` JSON-LD markup (platform-agnostic — most storefronts, including custom
      ones, emit this for SEO), crawling a bounded set of same-origin product-like links
   4. Local-LLM best-effort extraction from the homepage text, as a last resort
   - If every tier comes up empty, `KnowledgeBase.status` becomes `"error"` with a reason instead
     of failing silently.
3. Each product found is embedded (`packages/shared-ai`) and written to `Product`
   (`packages/database/prisma/schema.prisma`) — `embedding` is a pgvector column, declared via
   Prisma's `Unsupported("vector(768)")` since Prisma has no native vector type; both the insert
   and the similarity search go through raw SQL. `KnowledgeBase.status` flips to `"ready"` with a
   product count.
4. `POST /businesses/current/bots { name, systemPrompt, knowledgeBaseIds }` creates a `Bot` scoped
   to one or more ready knowledge bases.
5. `POST /businesses/current/bots/:id/messages { message }` (the playground endpoint): `bot-service`
   asks `knowledge-service` to embed the question and return the closest products (pgvector
   cosine-distance nearest-neighbor, scoped to the bot's knowledge bases), builds one prompt from
   the bot's system prompt + those products + the question, and returns the local model's reply
   alongside the matched products.

## Data & infra (AWS)

- **Postgres (RDS) + pgvector** — primary datastore and vector store, single instance to start.
- **Redis (ElastiCache)** — caching, session data, light job queues.
- **SQS/SNS** — cross-service async events and the `worker` job queue (managed, no ops burden;
  revisit Kafka/NATS only if event volume outgrows it).
- **S3** — uploaded knowledge base files. (For now, uploads are held in `KnowledgeDocument.fileData`
  only until the worker extracts their text, so no object store is needed yet.)
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
  shared-types/        # Domain types shared by every service (Business, Membership, Bot, ...)
  shared-config/        # Env loading
  shared-auth/            # JWT sign/verify, BusinessContextGuard, @RequirePermission
  shared-ai/               # Model provider abstraction (Ollama client: embed, chat)
infra/
  docker-compose.yml   # Local Postgres+pgvector, Redis, Ollama
  terraform/            # AWS IaC (to be built out)
```

## What's built so far

- `identity-service`: register/login, user + business tokens, business session exchange,
  self-serve business creation, membership listing, role changes (with last-owner protection),
  invitations (create / list / revoke / public preview / accept).
- `knowledge-service`: knowledge base CRUD (`businesses/current/knowledge-bases`), document sources
  for "documents" knowledge bases (file / FAQ / text / website), enqueues ingestion jobs, internal
  `/search` endpoint (embed query once -> pgvector nearest-neighbor over `Product` and
  `KnowledgeChunk`).
- `bot-service`: bot CRUD (`businesses/current/bots`) and the stateless single-turn playground
  chat endpoint (`POST .../bots/:id/messages`) — see "Product recommendation flow" above. Also
  workflows (`businesses/current/workflows`, public `hooks/workflows/:key`): CRUD, plus an in-process
  BullMQ worker on the `run-workflow` queue that executes runs and schedule triggers (job
  schedulers, reconciled against the database on startup). They live here because steps reuse the
  agent runtime's models, knowledge search and integration actions. And apps
  (`businesses/current/apps`, public `public/apps/:slug`): small business apps (tickets, CRM,
  bookings, expenses) run by one engine from a stored definition. Records live in `AppRecord` with a
  timeline in `AppRecordActivity`; dashboards are computed on request; automations start workflows;
  AI helpers read the app's numbers and linked knowledge bases. The web app serves the public forms
  at `/a/<slug>`. Agents (`businesses/current/agents`, `agent-runs`, `agent-skills`,
  `agent-schedules`): CRUD, private per-user conversations and the tool-calling runtime; run history
  with an `agent-runs/analytics` rollup (runs, success rate, tokens, estimated cost from
  `AGENT_MODELS[].pricing`); skills (`AgentSkill`: instructions + built-in tools appended to an
  agent's own at run time via `Agent.skillIds`); a static template catalog (`agents/templates`); and
  schedules (`AgentSchedule`), fired by job schedulers on the `run-agent-schedule` queue (one run
  at a time, at most hourly). Each firing opens a new conversation owned by the schedule's creator
  and records an `AgentRun` with `trigger: "schedule"` and `scheduleId`. The website widget's look
  (`Bot.widgetAppearance`: color, title, greeting, placeholder, position) lives on the bot: the embed
  script first calls `GET public/widget/:widgetKey/config` (same key + Origin check as messages) and
  renders nothing when the widget is off or the site isn't allowed, so dashboard changes reach live
  sites without a new snippet. `GET businesses/current/bots/widgets` lists every bot's widget with
  30-day widget conversation stats and the origins it ran on. Bot chats (widget and playground) are
  logged to `BotConversation` / `BotMessage`, grouped by a client session id (the widget keeps one
  per tab in sessionStorage; requests without one become one-message conversations). Each reply is
  tagged `answered`, `unanswered` (the bot said it couldn't help, or found nothing in its knowledge;
  see `bots/chat-log.ts`) or `error`. Logging is best-effort and never fails a chat. Workspace
  analytics (`businesses/current/analytics/overview`) roll up bot conversations, agent runs,
  workflow runs, app records and MCP tool calls per day in the viewer's timezone, including only the
  sections the caller has read permission for. Outgoing webhooks (`businesses/current/webhooks`,
  `webhooks:read` / `webhooks:write`): a business registers up to 20 `WebhookEndpoint`s, each
  subscribed to event types from `WEBHOOK_EVENTS` (shared-types: app record created/updated/deleted,
  bot conversation started / question unanswered, agent and workflow run succeeded/failed). Code
  paths call `emitWebhookEvent` (`webhooks/delivery.ts`), which writes a `WebhookDelivery` per
  subscribed endpoint and queues it on `webhook-delivery`; the worker POSTs JSON signed the Standard
  Webhooks way (`webhook-id` / `webhook-timestamp` / `webhook-signature`, HMAC-SHA256 with the
  endpoint's `whsec_` secret, AES-GCM encrypted at rest), through the SSRF guard, no redirects, 15s
  timeout. Non-2xx responses are retried 5 times (1, 2, 4, 8, 16 minutes); after 15 deliveries in a
  row fail every retry the endpoint is turned off. https is required unless `MCP_ALLOW_PRIVATE_URLS`
  is set, and URLs pointing at this platform's own `/hooks/` are refused (loops). Deliveries
  (payload and response) are pruned after 30 days by a daily job. Usage and plans: every model
  call in bot-service is written to `UsageEvent` (`usage/meter.ts`): callers set the business and
  feature once with `withUsage()` (an AsyncLocalStorage context), and both model providers plus
  `meteredChat` record tokens from it; each bot answer also records a `bot_reply`. `Business.plan`
  picks limits from `PLANS` (shared-types `plans.ts`): monthly bot replies, AI tokens, agent runs
  and workflow runs (UTC calendar month), and current bots, seats, knowledge storage and app
  records. Limits are checked before the work starts and answer 402 `quota_exceeded`: bot replies
  and creation (bot-service), agent runs and chats, workflow runs (the run fails with the reason)
  and their AI steps, app AI and new records, invitations (identity-service) and new knowledge
  sources (knowledge-service, via `knowledgeStorageBytes` in `@platform/database`). The widget
  shows visitors a neutral "unavailable" message instead of the plan text.
  `businesses/current/usage` serves the Usage page; `PATCH usage/plan` (business:manage) changes the
  plan directly until billing exists.
- Audit log (`AuditEvent`): bot-service, identity-service, knowledge-service and mcp-gateway each
  mount `auditMiddleware` from `@platform/database` (`audit.ts`). It recognises the resource and
  verb from the URL of every POST/PATCH/PUT/DELETE under `/businesses/current/...`, looks up the
  item's name before the handler runs (so deletes keep it), and writes the event only when the
  response succeeded for a member of that business. It keeps changed field names, values for a few
  safe fields (role, plan, enabled, name…), never secrets, and the client IP and User-Agent that
  api-gateway forwards. Chats, app record edits, searches, AI helpers and tests are skipped, as are
  public routes (no member context). identity-service also records workspace sign-ins and
  invitation joins explicitly, and serves `businesses/current/audit-log` (list with filters,
  `facets`, `export`), behind the `audit:read` permission (owners and admins by default).
- `worker`: BullMQ consumer for `ingest-knowledge-base` jobs; tiered store scraper (Shopify /
  WooCommerce / JSON-LD / local-LLM fallback) + embedding + `Product` write-back. Jobs with a
  `documentId` instead extract text (pdf-parse, mammoth, or a same-host website crawl capped at 25
  pages and checked by the SSRF guard on every hop), chunk it, embed it, and replace that document's
  `KnowledgeChunk`s. Uploaded file bytes are dropped once extracted. A store re-sync replaces the
  catalog's `Product`s in one transaction (a failed sync keeps the last good catalog and records the
  error). Store catalogs (`KnowledgeBase.autoSync`) and website documents
  (`KnowledgeDocument.autoSync`) can re-sync daily or weekly: a repeating `auto-sync` job on the same
  queue runs every 10 minutes and queues whatever is past its `nextSyncAt`, and each finished sync
  sets the next one. knowledge-service also serves the workspace-wide document list
  (`knowledge-bases/documents`), the data sources list (`knowledge-bases/sources`), document detail
  and edit (rename; text and FAQ edits re-index), `POST :id/sync` for stores, and search results with
  a cosine similarity `score` per passage.
- `api-gateway`: proxies `/auth`, `/businesses`, `/invitations` to `identity-service`,
  `/businesses/current/knowledge-bases` to `knowledge-service`, and `/businesses/current/bots` to
  `bot-service`.
- `packages/shared-auth`: JWT sign/verify, `BusinessContextGuard`, `UserContextGuard`,
  `@RequirePermission`.
- `packages/shared-ai`: Ollama client (`embed`, `embedBatch`, `chat`, `toPgVector`).
- `packages/database`: `Business`, `User`, `Membership`, `Invitation`, `Product` (pgvector
  embedding column, HNSW index) + `businessId` on `Bot` / `McpServer` / `KnowledgeBase`; seed with
  two businesses and a shared user.

## What's deliberately not built yet

`mcp-gateway` still exposes only `/health` — no MCP provisioning yet, so bots can't call tools,
only retrieve knowledge. The bot chat endpoint is stateless for answering (bot conversations are logged for analytics, but
past turns aren't fed back to the model from the server).
Ingestion is one-shot on creation — no re-sync/refresh trigger for an existing knowledge base yet.
Also pending: enterprise SSO, gateway-side JWT validation + rate limiting, and the Postgres RLS
policies.
