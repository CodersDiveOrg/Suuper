# One image for every backend service (api-gateway, identity, bot, knowledge,
# mcp-gateway, worker). docker-compose.prod.yml picks the service by working_dir.
# Built by GitHub Actions (.github/workflows/docker.yml), never on the server.
FROM node:22-alpine

RUN apk add --no-cache openssl && corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

# Prisma client must exist before anything that imports @platform/database compiles.
RUN pnpm --filter @platform/database run generate

# Workspace packages export their TypeScript source, which is fine for
# ts-node-dev in development. Production runs plain `node`, so compile each
# package here and point its `main` at the JS (image only, repo is unchanged).
# noCheck: emit only. The apps' build below type-checks these sources, and some
# packages rely on the apps for @types/node.
RUN for p in packages/*; do \
      printf '{"extends":"../../tsconfig.base.json","compilerOptions":{"outDir":"dist","rootDir":"src","sourceMap":false,"noCheck":true},"include":["src/**/*.ts"]}' > "$p/tsconfig.docker.json" && \
      ./node_modules/.bin/tsc -p "$p/tsconfig.docker.json" && \
      (cd "$p" && npm pkg set main=dist/index.js) || exit 1; \
    done

# Apps (tsc) and the embed widget (esbuild).
RUN pnpm -r run build

ENV NODE_ENV=production
USER node
