# syntax=docker/dockerfile:1
# Stage 1: build the web app.
FROM node:22-alpine AS web
WORKDIR /build/apps/web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

# Stage 2: API production dependencies only.
FROM node:22-alpine AS deps
WORKDIR /build/apps/api
COPY apps/api/package*.json ./
RUN npm ci --omit=dev

# Stage 3: runtime image. One container serves the API and the built web app on the same origin.
FROM node:22-alpine
ENV NODE_ENV=production IBMP_PORT=4000
WORKDIR /app/apps/api
COPY --from=deps /build/apps/api/node_modules ./node_modules
COPY apps/api/package.json ./
COPY apps/api/src ./src
COPY apps/api/migrations ./migrations
COPY apps/api/scripts ./scripts
COPY --from=web /build/apps/web/dist ../web/dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/v1/health || exit 1
CMD ["node", "src/server.js"]
