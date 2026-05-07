# --- Build stage -----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Copy manifests first for better layer caching.
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/

# Install both workspaces.
RUN npm --prefix server install --no-audit --no-fund \
 && npm --prefix client install --no-audit --no-fund

# Copy source and build the client.
COPY server ./server
COPY client ./client
RUN npm --prefix client run build

# --- Runtime stage ---------------------------------------------------------
FROM node:20-alpine
WORKDIR /app

# Copy only what the runtime needs.
COPY --from=build /app/server                    ./server
COPY --from=build /app/client/dist               ./client/dist

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Healthcheck so platforms know when we're up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1

CMD ["node", "server/src/index.js"]
