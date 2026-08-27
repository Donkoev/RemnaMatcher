# --- Сборка веб-панели ---
FROM node:22-alpine AS webbuild
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run build -w web

# --- Рантайм: один контейнер = API + коллектор + бот + статика веб-панели ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci -w server --omit=dev
COPY server server
COPY --from=webbuild /app/web/dist web/dist

WORKDIR /app/server
EXPOSE 3300
# гео-базы качаются при первом старте (лежат в volume вместе с БД и кэшем иконок)
CMD ["sh", "-c", "[ -f data/dbip-city-lite.mmdb ] || npm run geoip; exec npx tsx src/index.ts"]
