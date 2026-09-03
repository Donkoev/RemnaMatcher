# --- Сборка: веб-панель (vite) и сервер (tsc → dist) ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run build -w web
COPY server server
RUN npm run build -w server

# --- Рантайм: один контейнер = API + коллектор + бот + статика веб-панели ---
# Только production-зависимости и скомпилированный JS: без tsx и typescript в образе
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci -w server --omit=dev
COPY --from=build /app/server/dist server/dist
COPY server/agent server/agent
COPY --from=build /app/web/dist web/dist

WORKDIR /app/server
EXPOSE 3300
# гео-базы качаются при первом старте (лежат в volume вместе с БД и кэшем иконок)
CMD ["sh", "-c", "[ -f data/dbip-city-lite.mmdb ] || node dist/scripts/download-geoip.js; exec node dist/index.js"]
