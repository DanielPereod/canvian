# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Por si better-sqlite3 no tiene binario precompilado para la arquitectura.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build
RUN rm -rf node_modules && npm ci --omit=dev --workspace server

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3210 \
    CANVIAN_DB=/data/canvian.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/drizzle ./server/drizzle
COPY --from=build /app/web/dist ./web/dist
VOLUME /data
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:3210/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
