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
git pull --ff-only || echo "[remnamatcher-updater] git pull не удался — продолжаю с образом"
docker compose pull
docker compose up -d
echo "[remnamatcher-updater] готово"
