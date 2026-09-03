# AI Automation Platform

Multi-tenant platform for enterprises to automate their operations with AI: create bots, give
them tools via MCP servers, and ground them in the tenant's own knowledge base.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## Stack

TypeScript everywhere — NestJS microservices, Next.js frontend, PostgreSQL (+ pgvector) via
Prisma, Redis, targeting AWS (ECS Fargate, RDS, SQS/SNS, S3).

## Getting started

```bash
pnpm install

# start local Postgres + Redis
docker compose -f infra/docker-compose.yml up -d

cp .env.example .env

# generate the Prisma client, then create the initial migration
pnpm --filter @platform/database run generate
pnpm --filter @platform/database run migrate:dev --name init

# run everything (each service + the dashboard) in dev mode
pnpm dev
```

Services and default ports:

| Service | Port |
|---|---|
| `web` (dashboard) | 3100 |
| `api-gateway` | 3010 |
| `identity-service` | 3001 |
| `bot-service` | 3002 |
| `mcp-gateway` | 3003 |
| `knowledge-service` | 3004 |

Each backend service exposes `GET /health`.

## Repo layout

```
apps/       one folder per deployable service + the web dashboard
packages/   shared code: database (Prisma), types, config, auth
infra/      docker-compose for local dev, Terraform for AWS (WIP)
docs/       architecture and design docs
```
