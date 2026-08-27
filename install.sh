#!/usr/bin/env bash
# ============================================================================
#  RemnaMatcher — интерактивный установщик
#  Использование: bash <(curl -fsSL https://raw.githubusercontent.com/Donkoev/RemnaMatcher/main/install.sh)
# ============================================================================
set -euo pipefail

REPO_URL="${REMNAMATCHER_REPO:-https://github.com/Donkoev/RemnaMatcher}"
INSTALL_DIR="${REMNAMATCHER_DIR:-/opt/remnamatcher}"

# --- палитра (в тон панели) ---
CYAN='\033[38;5;44m'; TEAL='\033[38;5;36m'; GRAY='\033[38;5;245m'
RED='\033[38;5;203m'; YELLOW='\033[38;5;221m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

say()  { echo -e "$1"; }
ok()   { say "  ${TEAL}✔${NC} $1"; }
warn() { say "  ${YELLOW}▲${NC} $1"; }
die()  { say "  ${RED}✖ $1${NC}"; exit 1; }

banner() {
  say ""
  say "${CYAN}${BOLD}  ╔══════════════════════════════════════════╗${NC}"
  say "${CYAN}${BOLD}  ║        RemnaMatcher · установка          ║${NC}"
  say "${CYAN}${BOLD}  ╚══════════════════════════════════════════╝${NC}"
  say "${GRAY}  Антифрод для Remnawave: детект раздачи vless-ключей${NC}"
  say ""
}

# ask <вопрос> <переменная> [дефолт] [secret]
ask() {
  local prompt="$1" var="$2" def="${3:-}" secret="${4:-}" input
  while true; do
    if [ -n "$def" ]; then
      echo -ne "  ${CYAN}?${NC} ${prompt} ${DIM}[${def}]${NC}: "
    else
      echo -ne "  ${CYAN}?${NC} ${prompt}: "
    fi
    if [ "$secret" = "secret" ]; then read -rs input; echo; else read -r input; fi
    input="${input:-$def}"
    [ -n "$input" ] && { printf -v "$var" '%s' "$input"; break; }
    warn "поле обязательное"
  done
}

confirm() { # confirm <вопрос> [Y|N]
  local prompt="$1" def="${2:-Y}" reply hint
  [ "$def" = "Y" ] && hint="Y/n" || hint="y/N"
  echo -ne "  ${CYAN}?${NC} ${prompt} ${DIM}[${hint}]${NC}: "
  read -r reply; reply="${reply:-$def}"
  [[ "$reply" =~ ^[YyДд] ]]
}

banner

# --- проверки окружения ---
[ "$(id -u)" -eq 0 ] || die "запусти от root (или через sudo)"
command -v curl >/dev/null || die "нужен curl"

if ! command -v docker >/dev/null; then
  warn "Docker не найден"
  if confirm "Установить Docker автоматически (get.docker.com)?"; then
    curl -fsSL https://get.docker.com | sh
    ok "Docker установлен"
  else
    die "без Docker не поедем"
  fi
fi
docker compose version >/dev/null 2>&1 || die "нужен docker compose v2 (плагин compose)"
ok "Docker на месте: $(docker --version | cut -d, -f1)"

# --- код ---
if [ -d "$INSTALL_DIR/.git" ]; then
  say "  ${GRAY}Обнаружена установка в ${INSTALL_DIR} — обновляю код${NC}"
  git -C "$INSTALL_DIR" pull --ff-only
else
  command -v git >/dev/null || { warn "ставлю git"; apt-get update -qq && apt-get install -yqq git || yum install -y git; }
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
ok "Код в ${INSTALL_DIR}"

# --- конфигурация ---
ENV_FILE="$INSTALL_DIR/server/.env"
if [ -f "$ENV_FILE" ] && ! confirm "Найден существующий .env — перезаписать?" "N"; then
  ok "Оставляю текущий .env"
else
  say ""
  say "${BOLD}  Подключение к панели Remnawave${NC}"
  ask "URL панели (https://panel.example.com)" PANEL_URL
  PANEL_URL="${PANEL_URL%/}"
  ask "API-токен панели (создай отдельный под RemnaMatcher)" PANEL_TOKEN "" secret
  say "  ${GRAY}Если панель прикрыта nginx-секретом в ссылке (?key=value) — введи его. У большинства его нет.${NC}"
  echo -ne "  ${CYAN}?${NC} Секрет nginx-защиты key=value ${DIM}[Enter — пропустить]${NC}: "; read -r PANEL_SECRET

  say ""
  say "${BOLD}  Telegram-уведомления${NC}"
  ask "Токен бота от @BotFather" TG_TOKEN "" secret
  ask "Твой chat id (напиши боту /start — он покажет)" TG_CHAT

  say ""
  say "${BOLD}  Дополнительно${NC}"
  echo -ne "  ${CYAN}?${NC} Токен ipinfo.io для уточнения городов ${DIM}[Enter — без токена]${NC}: "; read -r IPINFO
  ask "Порт веб-панели" PORT "3300"

  cat > "$ENV_FILE" <<EOF
MODE=live
PORT=${PORT}

REMNAWAVE_URL=${PANEL_URL}
REMNAWAVE_TOKEN=${PANEL_TOKEN}
REMNAWAVE_SECRET=${PANEL_SECRET}

IPINFO_TOKEN=${IPINFO}

TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_ADMIN_CHAT_ID=${TG_CHAT}

# Периоды опроса/синка и хранение данных правятся в панели: Настройки -> Сбор данных
EOF
  chmod 600 "$ENV_FILE"
  ok "Конфиг записан в ${ENV_FILE}"

  # порт в docker-compose
  sed -i "s/127\.0\.0\.1:[0-9]*:[0-9]*/127.0.0.1:${PORT}:${PORT}/" docker-compose.yml
fi

# --- сборка и запуск ---
say ""
say "${BOLD}  Собираю и запускаю (первая сборка занимает пару минут)…${NC}"
docker compose up -d --build

PORT_NOW=$(grep -oP 'PORT=\K[0-9]+' "$ENV_FILE" || echo 3300)
say ""
say "${TEAL}${BOLD}  ╔══════════════════════════════════════════╗${NC}"
say "${TEAL}${BOLD}  ║           Готово — работает!             ║${NC}"
say "${TEAL}${BOLD}  ╚══════════════════════════════════════════╝${NC}"
say ""
say "  Панель:   ${CYAN}http://127.0.0.1:${PORT_NOW}${NC}  ${DIM}(только localhost)${NC}"
say "  Логи:     ${GRAY}docker logs -f remnamatcher${NC}"
say "  Рестарт:  ${GRAY}cd ${INSTALL_DIR} && docker compose restart${NC}"
say "  Обновить: ${GRAY}cd ${INSTALL_DIR} && git pull && docker compose up -d --build${NC}"
say ""
say "  ${YELLOW}▲${NC} При первом входе панель попросит придумать пароль администратора"
say "  ${GRAY}Доступ с своей машины — через SSH-туннель:${NC}"
say "  ${DIM}ssh -L ${PORT_NOW}:127.0.0.1:${PORT_NOW} root@сервер  →  открыть http://localhost:${PORT_NOW}${NC}"
say ""
