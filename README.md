# AI Automation Platform

Platform for enterprises to automate their operations with AI: create bots, give them tools via
MCP servers, and ground them in the business's own knowledge base.

Each **business** is an organisation on the platform. Users join a business through a
**membership** that carries their role (`owner` / `admin` / `member` / `viewer`); the same user
can belong to several businesses at once with a different role in each.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

The frontend lives in a separate repo: [`ai-automation-platform-web`](../ai-automation-platform-web).

## Stack

TypeScript everywhere — NestJS microservices, PostgreSQL (+ pgvector) via Prisma, Redis,
targeting AWS (ECS Fargate, RDS, SQS/SNS, S3).

## Getting started

```bash
pnpm install

# start local Postgres + Redis + Ollama
docker compose -f infra/docker-compose.yml up -d

cp .env.example .env

# generate the Prisma client, apply migrations, seed local businesses + users
pnpm --filter @platform/database run generate
pnpm --filter @platform/database run migrate:dev
pnpm --filter @platform/database run seed

# one-time: pull the local models the product-recommendation bot flow uses
docker compose -f infra/docker-compose.yml exec ollama ollama pull nomic-embed-text
docker compose -f infra/docker-compose.yml exec ollama ollama pull llama3.2:3b

# run every backend service in dev mode
pnpm dev
```

Services and default ports:

| Service | Port |
|---|---|
| `api-gateway` | 3010 |
| `identity-service` | 3001 |
| `bot-service` | 3002 |
| `mcp-gateway` | 3003 |
| `knowledge-service` | 3004 |

Each backend service exposes `GET /health`. Everything else goes through `api-gateway`.

## Identity API (via `api-gateway`)

Login is two steps: the password, then a 4-digit code emailed via SMTP (`SMTP_*` / `MAIL_FROM`
in `.env`; with no `SMTP_HOST` emails print to the identity-service console, and `MAIL_LOG=true`
prints them too — handy for the seeded `@acme.test` users, which can't receive mail). That
returns a **user token**; exchange it for a **business-scoped access token** to act inside
one business. The business id always comes from that token — never from the client.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/register` | — | Create a user account |
| `POST /auth/login` | — | Checks password, emails a 4-digit code → `{ challengeId, email (masked), codeLength, expiresInSeconds, resendInSeconds }` |
| `POST /auth/login/verify` | — | `{ challengeId, code }` → `{ userToken, user, businesses[] }` (5 attempts, 10 min expiry, single use) |
| `POST /auth/login/resend` | — | `{ challengeId }` — new code (30 s cooldown) |
| `GET /auth/me` | user token | Current user + their businesses |
| `POST /auth/businesses/:id/session` | user token | `{ accessToken, business, role, permissions }` |
| `GET /businesses` | user token | Businesses the user belongs to |
| `POST /businesses` | user token | Create a business; caller becomes its `owner` |
| `GET /businesses/current` | access token | Current business details + caller's role/permissions |
| `GET /businesses/current/members` | `members:read` | List memberships |
| `PATCH /businesses/current/members/:userId` | `members:manage` | Change a member's role |
| `DELETE /businesses/current/members/:userId` | `members:manage` | Remove a member |
| `POST /businesses/current/invitations` | `members:invite` | Invite an email at a role; emails an "Accept invite" link → `{ …invitation, emailSent }` |
| `POST /businesses/current/invitations/:id/resend` | `members:invite` | New link + 7-day expiry, re-emailed; the old link stops working |
| `GET /businesses/current/invitations` | `members:read` | Pending invitations |
| `DELETE /businesses/current/invitations/:id` | `members:invite` | Revoke an invitation |
| `GET /invitations/:token` | — | Public preview (business name, email, role) |
| `POST /invitations/accept` | user token | Accept an invite (email must match) |
| `POST /invitations/:token/register` | — | `{ name, password }` — no account yet: create one and join in one step → `{ userToken, user, businessId }` |
| `GET /businesses/current/roles` | `members:read` | Built-in + custom roles, with member counts |
| `POST /businesses/current/roles` | `roles:manage` | `{ name, description?, permissions[] }` — create a custom role |
| `PATCH /businesses/current/roles/:key` | `roles:manage` | Edit a custom role (built-ins are read-only) |
| `DELETE /businesses/current/roles/:key` | `roles:manage` | Delete a custom role (409 while assigned) |
| `GET /businesses/current/integrations` | `integrations:read` | Integration catalog + this business's connections (secrets masked) |
| `PUT /businesses/current/integrations/:provider` | `integrations:write` | `{ values }` — connect/update; blank secrets keep the stored value |
| `PATCH /businesses/current/integrations/:provider` | `integrations:write` | `{ enabled }` — pause/resume |
| `DELETE /businesses/current/integrations/:provider` | `integrations:write` | Disconnect |
| `GET /businesses/current/onboarding` | `business:read` | Setup checklist status (derived from real data) + profile |
| `PATCH /businesses/current/profile` | `business:manage` | `{ name?, industry?, companySize?, website?, primaryGoal? }` |
| `POST /businesses/current/onboarding/dismiss` | `business:manage` | `{ dismissed }` — hide/show the checklist |

Invitation links (`${WEB_APP_URL}/invite/<token>`) carry a random 256-bit token; only its sha256
is stored, links are single-use and expire after 7 days, and the link is never returned to the
inviter — receiving it is what proves the invitee owns the address, so registering from it needs
no separate email code.

Built-in role → permission mapping lives in `packages/shared-types/src/business.ts`; custom roles
store their own permission list (`Role` table). Nobody can create or assign a role carrying
permissions they don't hold themselves, and only owners grant `owner`. Permissions are baked into
the business token, so a role edit reaches a user when they next switch business or their token
renews (≤ 1 day). Integration credentials are AES-256-GCM encrypted with
`INTEGRATIONS_ENCRYPTION_KEY` (falls back to `JWT_SECRET` in dev). The seed script
(`pnpm --filter @platform/database run seed`) creates two starter businesses — see its output for
login credentials — but any logged-in user can also create their own via `POST /businesses`.

## Agent runtime API (via `api-gateway`)

Agents run in `bot-service` (`src/agents/runtime`): a tool-use loop over one provider interface —
**Claude** (`claude-opus-5-5` default, `claude-sonnet-5-5`, `claude-haiku-4-5`; key from the
business's Anthropic integration, else `ANTHROPIC_API_KEY`) or **Ollama** (`llama3.2:3b/1b`, free
and local). Conversations are persisted as exact Messages-API content blocks (append-only, so
prompt caching works), and every run records its model calls and tool calls as steps.

Built-in tools (opt-in per agent): `search_knowledge`, `current_time`, `http_request` (public URLs
only — private/internal addresses, literal IPs and redirects to them are blocked), `send_email`
(business's SMTP integration, max 3 per run), and on Claude models `web_search` / `web_fetch`.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /businesses/current/agents/models` | `agents:read` | Models + whether each is usable now |
| `GET /businesses/current/agents/tools` | `agents:read` | Built-in tool catalog |
| `POST/PATCH /businesses/current/agents[/:id]` | `agents:write` | Now also `description`, `model`, `tools[]`, `maxSteps` (1–20) |
| `GET/POST /businesses/current/agents/:id/conversations` | `agents:run` | The caller's own conversations (private per user) |
| `GET/PATCH/DELETE …/conversations/:cid` | `agents:run` | Transcript (UI-friendly) / rename / delete |
| `POST …/conversations/:cid/messages` | `agents:run` | `{ message }` — runs the agent. `Accept: text/event-stream` streams SSE: `run_started`, `text_delta`, `tool_call`, `tool_result`, `run_finished` (`error` if it dies mid-stream); otherwise JSON. 409 while a run is active. |
| `GET /businesses/current/agent-runs` | `agents:read` | `?agentId&status&limit&before` — own runs, or everyone's with `agents:write` |
| `GET /businesses/current/agent-runs/:runId` | `agents:read` | Run + ordered steps (model calls, tool inputs/outputs, timings, tokens) |

**Integration actions** (`src/agents/runtime/integrations`): agents and bots can attach connected
integrations (`integrations[]`) and call their actions as tools named `provider__action` — e.g.
`slack__send_message`, `zendesk__create_ticket`, `shopify__get_order`, `hubspot__search_contacts`,
`make__trigger`. 30 providers have actions; only connected + enabled ones are offered to the model,
inputs are validated, requests to user-entered domains are SSRF-guarded, and message/email-sending
actions are capped at 5 per answer. `GET /businesses/current/agents/integration-tools` lists them.

`POST /businesses/current/agents/:id/messages` (old one-shot Playground call) still works; it now
runs through the same runtime in a fresh conversation.



## MCP API (via `api-gateway`, served by `mcp-gateway`)

Two kinds of MCP server per business:

- **External** — a server the business runs; `mcp-gateway` connects as an MCP client
  (Streamable HTTP, falling back to legacy HTTP+SSE), with optional bearer / custom-header auth
  (encrypted). Tools are discovered on create/reconnect and cached.
- **Hosted** — tools defined in the dashboard, each wrapping one HTTP request
  (`{{param}}` URL templates, headers, encrypted secret headers). The platform serves them as a
  real MCP endpoint at `POST /mcp/:serverId` (stateless Streamable HTTP) for outside clients
  using `Authorization: Bearer <access key>` (key shown once, stored hashed, rotatable).

Agents and bots get the tools of their attached `mcpServerIds` (namespaced `server__tool`) via
`mcp-gateway`'s internal API (`/internal/mcp/*`, not routed by `api-gateway`). Every call — test,
agent, bot or outside client — is logged. User-supplied URLs are SSRF-guarded (private/internal
addresses blocked) unless `MCP_ALLOW_PRIVATE_URLS=true` (local dev only).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET/POST /businesses/current/mcp-servers` | `mcp:read` / `mcp:write` | List / create (`mode`, `endpointUrl`, `transport`, `authType`, `authSecret`…) — hosted create returns `accessKey` once |
| `GET/PATCH/DELETE …/mcp-servers/:id` | `mcp:read` / `mcp:write` | Detail (+ hosted tool definitions) / edit / delete (detaches from agents & bots) |
| `POST …/mcp-servers/:id/refresh` | `mcp:write` | Reconnect and re-discover tools |
| `POST …/mcp-servers/:id/tools/:tool/call` | `mcp:write` | **Test a tool** with `{ arguments }` → `{ content, isError, durationMs, raw }` |
| `POST/PATCH/DELETE …/mcp-servers/:id/hosted-tools[/:toolId]` | `mcp:write` | Build hosted tools |
| `POST …/mcp-servers/:id/access-key` | `mcp:write` | Rotate a hosted server's access key |
| `GET …/mcp-servers/calls` | `mcp:read` | `?serverId&limit` — call log |
| `POST /mcp/:serverId` | access key | The hosted MCP endpoint itself |

## Knowledge base & bot API (via `api-gateway`)

Two kinds of knowledge base. A **store catalog** (`sourceType: "crawl"`) points at a store URL and
ingests its products. See docs/ARCHITECTURE.md's "Product recommendation flow" for that pipeline
(scrape tiers, embeddings, retrieval). A **documents** knowledge base (`sourceType: "documents"`)
starts empty and takes sources: uploaded files (PDF, DOCX, TXT, MD, CSV up to 5 MB, sent base64),
FAQ lists, pasted text, and websites (up to 25 same-site pages). The worker extracts each source,
splits it into ~1,000-character passages and embeds them. Search returns both products and passages.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /businesses/current/knowledge-bases` | `knowledge:write` | `{ name, sourceType: "crawl", sourceUrl }` starts async ingestion; `{ name, sourceType: "documents" }` creates an empty one |
| `GET /businesses/current/knowledge-bases` | `knowledge:read` | List knowledge bases + status/product count |
| `GET /businesses/current/knowledge-bases/:id` | `knowledge:read` | One knowledge base's status/error |
| `GET /businesses/current/knowledge-bases/:id/products` | `knowledge:read` | Products ingested into it |
| `GET /businesses/current/knowledge-bases/:id/documents` | `knowledge:read` | Sources of a documents knowledge base, each with status/passage count |
| `POST /businesses/current/knowledge-bases/:id/documents` | `knowledge:write` | `{ type: "file", fileName, dataBase64 }` / `{ type: "faq", title?, items: [{ question, answer }] }` / `{ type: "text", title, text }` / `{ type: "website", url, title? }` — queued for processing |
| `POST /businesses/current/knowledge-bases/:id/documents/:documentId/reprocess` | `knowledge:write` | Re-read a source (e.g. re-crawl a website) |
| `DELETE /businesses/current/knowledge-bases/:id/documents/:documentId` | `knowledge:write` | Remove a source and its passages |
| `POST /businesses/current/knowledge-bases/search` | `knowledge:read` | `{ query, knowledgeBaseIds }` -> `{ products, passages }` (used by bot-service) |
| `DELETE /businesses/current/knowledge-bases/:id` | `knowledge:write` | Delete it + its products and documents, and detach it from any bot |
| `POST /businesses/current/bots` | `bots:write` | `{ name, systemPrompt, knowledgeBaseIds }` |
| `GET /businesses/current/bots` | `bots:read` | List bots |
| `PATCH /businesses/current/bots/:id` | `bots:write` | Update name/prompt/knowledge bases |
| `DELETE /businesses/current/bots/:id` | `bots:write` | Remove a bot |
| `POST /businesses/current/bots/:id/messages` | `bots:run` | The playground endpoint: `{ message }` -> `{ reply, products, passages }` |

A store catalog's `status` is `syncing` -> `ready` (with a `productCount`) or `error` (with an
`errorMessage`). Poll `GET .../knowledge-bases/:id` until it leaves `syncing` before attaching it
to a bot. A documents knowledge base is `syncing` while any source is processing; each source has
its own `processing` -> `ready` / `error` status. Chat is stateless single-turn for now: no conversation history is persisted between
calls to `.../messages`.

## Workflows API (via `api-gateway`, served by `bot-service`)

A workflow is one trigger plus up to 15 steps, built in the dashboard's Workflows section. Shapes
are in `packages/shared-types/src/workflow.ts`.

- **Triggers:** `manual` (Run button / API), `schedule` (every 5–30 minutes, hourly, daily or
  weekly, in a timezone; BullMQ job schedulers), `webhook` (public URL, 60 calls/min per workflow).
  Schedules and webhooks only fire while the workflow is turned on.
- **Steps:** `ai` (prompt -> `{ text }`, any agent model, optional knowledge bases), `action` (any
  integration action, with the business's connected credentials; max 10 sends per run), `http`
  (SSRF-guarded request -> `{ status, body }`), `condition` (stops the run, as "stopped", unless true).
- **Data:** step fields take `{{trigger.path}}` and `{{steps.<stepId>.path}}` placeholders.
  Values inserted into a JSON HTTP body are JSON-escaped.

Runs execute in bot-service on the `run-workflow` queue (concurrency 2); each step's input, output
and error are stored on the `WorkflowRun` as it finishes.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /businesses/current/workflows` | `workflows:read` | List workflows with their last run |
| `POST /businesses/current/workflows` | `workflows:write` | `{ name, trigger?, steps? }` (created turned off) |
| `GET /businesses/current/workflows/catalog` | `workflows:read` | Models and app actions (with fields and connection status) for the builder |
| `GET /businesses/current/workflows/:id` | `workflows:read` | One workflow, including its `webhookUrl` |
| `PATCH /businesses/current/workflows/:id` | `workflows:write` | Update name / trigger / steps / `enabled` (syncs its schedule) |
| `DELETE /businesses/current/workflows/:id` | `workflows:write` | Delete it, its runs and its schedule |
| `POST /businesses/current/workflows/:id/webhook/regenerate` | `workflows:write` | New webhook URL; the old one stops working |
| `POST /businesses/current/workflows/:id/run` | `workflows:run` | `{ triggerData? }` — queue a run now, on or off |
| `GET /businesses/current/workflows/:id/runs` | `workflows:read` | Recent runs with per-step results |
| `GET /businesses/current/workflows/:id/runs/:runId` | `workflows:read` | One run |
| `POST /hooks/workflows/:webhookKey` | — (key in URL) | Start a webhook workflow; the JSON body becomes `{{trigger.…}}` |

## Apps API (via `api-gateway`, served by `bot-service`)

Apps are small business apps (Ticket Manager, CRM & Leads, Appointments & Bookings, Expense
Tracker) run by one engine from a definition: record types and fields, views (table, board,
calendar), dashboard widgets, public forms and automations. Templates live in
`apps/bot-service/src/apps/templates/`; the engine (filters, dashboard maths, record rules such as
SLA due times and completion stamps) in `apps/bot-service/src/apps/engine/`. Dashboards are
computed on the server in the viewer's timezone (`?tz=` minutes east of UTC).

AI is a helper, not the app: "Ask AI" answers from the dashboard's numbers, matching records and
the knowledge bases linked in the app's settings; choice fields can be suggested; records have
actions like "Draft a reply". It uses Claude Haiku when an Anthropic key exists, else the local
model. Automations run a workflow (Slack, email, WhatsApp…) when a record is created or changes.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /businesses/current/apps/catalog` | `apps:read` | Templates with setup questions and their definition |
| `GET /businesses/current/apps/catalog/:key/preview` | `apps:read` | A template's dashboard and records on sample data (nothing stored) |
| `POST /businesses/current/apps/suggest` | `apps:write` | `{ description }` -> best template + setup answers (AI App Builder) |
| `POST /businesses/current/apps` | `apps:write` | `{ templateKey, answers, look?, sampleData? }` — install |
| `GET/PATCH/DELETE /businesses/current/apps/:id` | read / write | App; PATCH takes look, `status` (public page on/off), `settings`, `fieldOptions`, `publicForms`, `automations` |
| `DELETE /businesses/current/apps/:id/samples` | `apps:write` | Remove the sample records added at install |
| `GET /businesses/current/apps/:id/dashboard` | `apps:read` | Computed widgets |
| `GET /businesses/current/apps/:id/members` | `apps:read` | People records can be assigned to |
| `GET /businesses/current/apps/:id/records` | `apps:read` | `?entity=` or `?view=` (its filters and sort), `?q=` search |
| `POST /businesses/current/apps/:id/records` | `apps:records` | `{ entity, data }` |
| `PATCH/DELETE /businesses/current/apps/:id/records/:recordId` | `apps:records` | `{ data }` with only the changed fields |
| `GET /businesses/current/apps/:id/records/:recordId/activity` | `apps:read` | Timeline: created, changes, comments |
| `POST /businesses/current/apps/:id/records/:recordId/comments` | `apps:records` | `{ text }` |
| `POST /businesses/current/apps/:id/ai/ask` | `apps:read` | `{ question, tz }` -> `{ answer }` |
| `POST /businesses/current/apps/:id/ai/suggest` | `apps:records` | `{ entity, field, data }` -> `{ value }` |
| `POST /businesses/current/apps/:id/records/:recordId/ai/:action` | `apps:records` | -> `{ text }` |
| `GET /public/apps/:slug` | — | Enabled public forms of a live app (60/min per app) |
| `POST /public/apps/:slug/forms/:formKey` | — | `{ data }` — only the form's fields; returns the record `reference` (10/min per app) |

## Repo layout

```
apps/       one folder per deployable service
packages/   shared code: database (Prisma), types, config, auth, ai (model provider client)
infra/      docker-compose for local dev (Postgres+pgvector, Redis, Ollama), Terraform for AWS (WIP)
docs/       architecture and design docs
```
