#!/usr/bin/env bash
# Хост-хелпер самообновления RemnaMatcher.
# Панель (в контейнере) пишет файл-флаг server/data/update-request,
# systemd-таймер дёргает этот скрипт каждые 20 секунд: флаг есть → обновляемся.
# Так контейнер не имеет доступа к Docker — обновляет только хост.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLAG="$DIR/server/data/update-request"

[ -f "$FLAG" ] || exit 0
rm -f "$FLAG"

cd "$DIR"
echo "[remnamatcher-updater] $(date -Is) обновление запрошено из панели"

# Миграция старых установок: раньше установщик правил порт прямо в docker-compose.yml,
# из-за чего git pull падал на каждом обновлении. Теперь порт живёт в .env (PORT=…) —
# переносим его туда и возвращаем compose-файл к репозиторному виду.
if ! git diff --quiet -- docker-compose.yml 2>/dev/null; then
  OLD_PORT=$(grep -oP '127\.0\.0\.1:\K[0-9]+' docker-compose.yml | head -1 || true)
  if [ -n "$OLD_PORT" ] && ! grep -q '^PORT=' .env 2>/dev/null; then
    echo "PORT=${OLD_PORT}" >> .env
    echo "[remnamatcher-updater] порт ${OLD_PORT} перенесён в .env"
  fi
  git checkout -- docker-compose.yml
fi

git pull --ff-only || echo "[remnamatcher-updater] git pull не удался — продолжаю с образом"
docker compose pull
docker compose up -d
echo "[remnamatcher-updater] готово"
