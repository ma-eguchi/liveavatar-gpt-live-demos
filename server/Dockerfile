# Orchestrator image. Build from the REPO ROOT (it needs shared/):
#   docker build -f server/Dockerfile -t talk-orchestrator .
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json server/
RUN pnpm install --filter server --frozen-lockfile
COPY shared shared
COPY server server
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["pnpm", "--filter", "server", "start"]
