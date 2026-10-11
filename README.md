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

The first working bot type: point a knowledge base at a store URL, it ingests the catalog, then a
bot answers shopping questions grounded in what it found. See docs/ARCHITECTURE.md's "Product
recommendation flow" for the full pipeline (scrape tiers, embeddings, retrieval).

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /businesses/current/knowledge-bases` | `knowledge:write` | `{ name, sourceUrl }` — starts async ingestion |
| `GET /businesses/current/knowledge-bases` | `knowledge:read` | List knowledge bases + status/product count |
| `GET /businesses/current/knowledge-bases/:id` | `knowledge:read` | One knowledge base's status/error |
| `GET /businesses/current/knowledge-bases/:id/products` | `knowledge:read` | Products ingested into it |
| `DELETE /businesses/current/knowledge-bases/:id` | `knowledge:write` | Delete it + its products, and detach it from any bot |
| `POST /businesses/current/bots` | `bots:write` | `{ name, systemPrompt, knowledgeBaseIds }` |
| `GET /businesses/current/bots` | `bots:read` | List bots |
| `PATCH /businesses/current/bots/:id` | `bots:write` | Update name/prompt/knowledge bases |
| `DELETE /businesses/current/bots/:id` | `bots:write` | Remove a bot |
| `POST /businesses/current/bots/:id/messages` | `bots:run` | The playground endpoint: `{ message }` -> `{ reply, products }` |

A knowledge base's `status` is `syncing` -> `ready` (with a `productCount`) or `error` (with an
`errorMessage`) — poll `GET .../knowledge-bases/:id` until it leaves `syncing` before attaching it
to a bot. Chat is stateless single-turn for now: no conversation history is persisted between
calls to `.../messages`.

## Repo layout

```
apps/       one folder per deployable service
packages/   shared code: database (Prisma), types, config, auth, ai (model provider client)
infra/      docker-compose for local dev (Postgres+pgvector, Redis, Ollama), Terraform for AWS (WIP)
docs/       architecture and design docs
```
