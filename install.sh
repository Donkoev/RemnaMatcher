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

# ask <вопрос> <переменная> [дефолт]
ask() {
  local prompt="$1" var="$2" def="${3:-}" input
  while true; do
    if [ -n "$def" ]; then
      echo -ne "  ${CYAN}?${NC} ${prompt} ${DIM}[${def}]${NC}: "
    else
      echo -ne "  ${CYAN}?${NC} ${prompt}: "
    fi
    read -r input
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
  say "  ${GRAY}Это адрес существующей панели Remnawave, откуда берутся данные —${NC}"
  say "  ${GRAY}НЕ домен, на котором будет висеть сам RemnaMatcher (его спросим позже).${NC}"
  ask "URL панели Remnawave (https://panel.example.com)" PANEL_URL
  PANEL_URL="${PANEL_URL%/}"
  case "$PANEL_URL" in
    http://*|https://*) ;;
    *) PANEL_URL="https://${PANEL_URL}"; say "  ${GRAY}Добавил https:// → ${PANEL_URL}${NC}" ;;
  esac
  ask "API-токен панели (создай отдельный под RemnaMatcher)" PANEL_TOKEN
  say "  ${GRAY}Если панель прикрыта nginx-секретом в ссылке (?key=value) — введи его. У большинства его нет.${NC}"
  echo -ne "  ${CYAN}?${NC} Секрет nginx-защиты key=value ${DIM}[Enter — пропустить]${NC}: "; read -r PANEL_SECRET

  say ""
  say "${BOLD}  Telegram-уведомления${NC}"
  ask "Токен бота от @BotFather" TG_TOKEN
  ask "Твой chat id (напиши боту /start — он покажет)" TG_CHAT

  say ""
  say "${BOLD}  Дополнительно${NC}"
  echo -ne "  ${CYAN}?${NC} Токен ipinfo.io для уточнения городов ${DIM}[Enter — без токена]${NC}: "; read -r IPINFO
  ask "Порт веб-панели" PORT "3300"

  cat > "$ENV_FILE" <<EOF
# --- Режим ---
MODE=live                                    # mock — сгенерированные данные без панели; live — боевой режим
PORT=${PORT}                                 # порт веб-панели и API

# --- Remnawave ---
REMNAWAVE_URL=${PANEL_URL}                   # URL панели (без слэша на конце)
REMNAWAVE_TOKEN=${PANEL_TOKEN}               # API-токен из панели
REMNAWAVE_SECRET=${PANEL_SECRET}             # секрет nginx-защиты панели key=value; пусто — не используется

# --- Сервисы ---
IPINFO_TOKEN=${IPINFO}                       # токен ipinfo.io для точных городов; пусто — анонимный режим

# --- Telegram ---
TELEGRAM_BOT_TOKEN=${TG_TOKEN}               # токен бота от @BotFather
TELEGRAM_ADMIN_CHAT_ID=${TG_CHAT}            # chat id администратора

# Периоды опроса/синка и хранение данных правятся в панели: Настройки -> Сбор данных
EOF
  chmod 600 "$ENV_FILE"
  ok "Конфиг записан в ${ENV_FILE}"

  # порт в docker-compose
  sed -i "s/127\.0\.0\.1:[0-9]*:[0-9]*/127.0.0.1:${PORT}:${PORT}/" docker-compose.yml
fi

# --- запуск: пробуем готовый образ из ghcr, нет — собираем на месте ---
say ""
say "${BOLD}  Запускаю…${NC}"
if docker compose pull 2>/dev/null; then
  docker compose up -d
else
  say "  ${GRAY}Готового образа нет — собираю локально (пара минут)${NC}"
  docker compose up -d --build
fi

# --- хост-хелпер самообновления: кнопка «Обновить» в панели пишет флаг, таймер подбирает ---
chmod +x "$INSTALL_DIR/update.sh"
cat > /etc/systemd/system/remnamatcher-updater.service <<EOF
[Unit]
Description=RemnaMatcher self-update helper
[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/update.sh
EOF
cat > /etc/systemd/system/remnamatcher-updater.timer <<EOF
[Unit]
Description=RemnaMatcher update watcher
[Timer]
OnBootSec=60
OnUnitActiveSec=20
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now remnamatcher-updater.timer >/dev/null 2>&1
ok "Самообновление включено (кнопка «Обновить» в панели)"

PORT_NOW=$(grep -oP 'PORT=\K[0-9]+' "$ENV_FILE" || echo 3300)

# --- реверс-прокси: nginx + Let's Encrypt (опционально) ---
PROXY_DOMAIN=""
NGINX_CONF=""
for c in /etc/nginx/sites-available/remnamatcher /etc/nginx/conf.d/remnamatcher.conf; do
  [ -f "$c" ] && NGINX_CONF="$c"
done

if [ -n "$NGINX_CONF" ]; then
  PROXY_DOMAIN=$(grep -oP 'server_name \K[^;]+' "$NGINX_CONF" | head -1 || true)
  ok "Реверс-прокси уже настроен (${PROXY_DOMAIN:-домен не найден})"
else
  say ""
  if confirm "Открыть панель наружу по домену (nginx + бесплатный HTTPS)?" "N"; then
    say "  ${GRAY}A-запись домена уже должна указывать на IP этого сервера — иначе сертификат не выпустится.${NC}"
    ask "Домен панели (например match.example.com)" PROXY_DOMAIN
    ask "E-mail для Let's Encrypt (уведомления об истечении)" LE_EMAIL

    say "  ${GRAY}Ставлю nginx и certbot…${NC}"
    if command -v apt-get >/dev/null; then
      apt-get update -qq && apt-get install -yqq nginx certbot python3-certbot-nginx
    else
      yum install -y nginx certbot python3-certbot-nginx
    fi

    if [ -d /etc/nginx/sites-available ]; then
      NGINX_CONF=/etc/nginx/sites-available/remnamatcher
    else
      NGINX_CONF=/etc/nginx/conf.d/remnamatcher.conf
    fi
    cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${PROXY_DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT_NOW};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # SSE: живые обновления панели не должны буферизоваться
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
EOF
    [ -d /etc/nginx/sites-enabled ] && ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/remnamatcher
    nginx -t && systemctl enable --now nginx >/dev/null 2>&1 && systemctl reload nginx

    # файрвол, если включён ufw
    command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; }

    if certbot --nginx -d "$PROXY_DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect; then
      ok "HTTPS выпущен, автопродление включено (systemd-таймер certbot)"
    else
      warn "Сертификат не выпустился (обычно — домен ещё не указывает на этот сервер)"
      say "  ${GRAY}Направь DNS и повтори: certbot --nginx -d ${PROXY_DOMAIN} --redirect${NC}"
    fi
  fi
fi

say ""
say "${TEAL}${BOLD}  ╔══════════════════════════════════════════╗${NC}"
say "${TEAL}${BOLD}  ║           Готово — работает!             ║${NC}"
say "${TEAL}${BOLD}  ╚══════════════════════════════════════════╝${NC}"
say ""
if [ -n "$PROXY_DOMAIN" ]; then
  say "  Панель:   ${CYAN}https://${PROXY_DOMAIN}${NC}"
else
  say "  Панель:   ${CYAN}http://127.0.0.1:${PORT_NOW}${NC}  ${DIM}(только localhost)${NC}"
fi
say "  Логи:     ${GRAY}docker logs -f remnamatcher${NC}"
say "  Рестарт:  ${GRAY}cd ${INSTALL_DIR} && docker compose restart${NC}"
say "  Обновить: ${GRAY}кнопкой в панели или повторным запуском этого скрипта${NC}"
say ""
say "  ${YELLOW}▲${NC} При первом входе панель попросит придумать пароль администратора"
if [ -z "$PROXY_DOMAIN" ]; then
  say "  ${GRAY}Доступ со своей машины — через SSH-туннель:${NC}"
  say "  ${DIM}ssh -L ${PORT_NOW}:127.0.0.1:${PORT_NOW} root@сервер  →  открыть http://localhost:${PORT_NOW}${NC}"
fi
say ""
