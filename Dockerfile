# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app

# Install deps (including dev) against the lockfile, then build and prune.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as an unprivileged user.
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./

USER app

# MCP uses stdio — no ports exposed. Run with `docker run -i` so stdin stays open.
ENTRYPOINT ["node", "dist/index.js"]
