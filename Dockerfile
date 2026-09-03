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
# su-exec: под root контейнер лишь отдаёт data/ пользователю node и сразу сбрасывает права
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci -w server --omit=dev
COPY --from=build /app/server/dist server/dist
COPY server/agent server/agent
COPY --from=build /app/web/dist web/dist

WORKDIR /app/server
EXPOSE 3300
# data/ — volume с базой, ключами, кэшем и гео-базами; у старых установок он принадлежит root —
# забираем под node и запускаем сервер без прав root. Гео-базы сервер качает и обновляет сам
CMD ["sh", "-c", "mkdir -p data && chown -R node:node data && exec su-exec node node dist/index.js"]
