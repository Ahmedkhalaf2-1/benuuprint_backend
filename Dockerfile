ARG NODE_VERSION=22
ARG PNPM_VERSION=12.14.0

# ---- base: pinned Node + pnpm ----
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

# ---- build: full deps, generate Prisma client, compile ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: runtime dependencies only ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Private file storage; mount a volume here (see docker-compose.yml).
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
