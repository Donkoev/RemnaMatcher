import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import type Database from 'better-sqlite3';
import type { Actions, ActionName } from '../actions.js';
import { loadScoringConfig } from '../api/server.js';
import { bus, type IncidentEvent } from '../events.js';

const LEVEL_EMOJI: Record<string, string> = { yellow: '🟡', orange: '🟠', red: '🔴' };

/** вероятность утечки нормируется на порог красного уровня */
const leakPct = (score: number, red: number): number => Math.min(100, Math.floor((score / red) * 100));

function fmtIncident(ev: IncidentEvent, red: number): string {
  const checks = ev.signals
    .map((s) => `▪️ <b>${escapeHtml(s.label)}</b>\n${escapeHtml(s.evidence)}`)
    .join('\n');
  return [
    `${LEVEL_EMOJI[ev.level] ?? '⚠️'} <b>Вероятность утечки — ${leakPct(ev.score, red)}%</b>`,
    `👤 <code>${escapeHtml(ev.username)}</code> · id ${ev.userId} · ${ev.activeIps} активных IP`,
    '',
    `<blockquote>${checks}</blockquote>`,
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Бот-уведомлятор. Действия только через явное нажатие + подтверждение.
 * Если токен не задан — модуль тихо не запускается (уведомления идут в лог).
 */
export function startTelegram(opts: {
  token: string | undefined;
  adminChatId: number | undefined;
  db: Database.Database;
  actions: Actions;
}): { started: boolean } {
  const { token, adminChatId, db, actions } = opts;

  if (!token) {
    bus.on('incident', (ev) => {
      console.log(`[alert] (no bot token) ${ev.level.toUpperCase()} ${ev.username}: ${ev.signals.map((s) => s.label).join(', ')}`);
    });
    return { started: false };
  }

  const bot = new Bot(token);

  const isAllowed = (chatId: number | undefined): boolean =>
    adminChatId === undefined || chatId === adminChatId;

  bot.command('start', (ctx) => {
    const suffix = isAllowed(ctx.chat?.id)
      ? 'Уведомления будут приходить сюда.'
      : 'Этот чат не в списке разрешённых — задай TELEGRAM_ADMIN_CHAT_ID в .env.';
    return ctx.reply(`RemnaMatcher на связи. Твой chat id: <code>${ctx.chat.id}</code>\n${suffix}`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('status', (ctx) => {
    if (!isAllowed(ctx.chat?.id)) return;
    const nodes = db
      .prepare<[], { name: string; last_ok_at: number | null; last_err: string | null; users_seen: number; ips_seen: number }>(
        'SELECT name, last_ok_at, last_err, users_seen, ips_seen FROM node_status ORDER BY name',
      )
      .all();
    const suspects = db
      .prepare<[], { level: string; n: number }>(
        "SELECT level, COUNT(*) AS n FROM score_state WHERE level != 'green' GROUP BY level",
      )
      .all();
    const lines = ['<b>Статус нод:</b>'];
    for (const n of nodes) {
      const ok = n.last_ok_at ? `✅ ${new Date(n.last_ok_at).toLocaleTimeString('ru-RU')}` : `❌ ${n.last_err ?? '—'}`;
      lines.push(`${escapeHtml(n.name)}: ${ok} · юзеров ${n.users_seen}, IP ${n.ips_seen}`);
    }
    lines.push('', '<b>Подозрительные:</b> ' + (suspects.map((s) => `${LEVEL_EMOJI[s.level] ?? ''} ${s.n}`).join(' · ') || 'нет'));
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // Кнопки на уведомлении: сначала выбор действия, затем подтверждение
  bot.on('callback_query:data', async (ctx) => {
    if (!isAllowed(ctx.chat?.id)) {
      await ctx.answerCallbackQuery({ text: 'Не разрешено' });
      return;
    }
    const data = ctx.callbackQuery.data;
    const [kind, action, userIdStr] = data.split(':');
    const userId = Number(userIdStr);
    if (!action || !Number.isFinite(userId)) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (kind === 'ask') {
      // шаг подтверждения
      const kb = new InlineKeyboard()
        .text(`✅ Да, ${labelFor(action as ActionName)}`, `do:${action}:${userId}`)
        .text('↩️ Отмена', `cancel:_:${userId}`);
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: kb });
      return;
    }

    if (kind === 'cancel') {
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      await ctx.editMessageReplyMarkup({ reply_markup: actionKeyboard(userId) });
      return;
    }

    if (kind === 'do') {
      await ctx.answerCallbackQuery({ text: 'Выполняю…' });
      const res = await actions.run(action as ActionName, userId, 'telegram');
      const original = ctx.callbackQuery.message?.text ?? '';
      await ctx.editMessageText(`${original}\n\n${res.ok ? '' : '⚠️ '}${res.message}`, {
        reply_markup: res.ok ? undefined : actionKeyboard(userId),
      });
    }
  });

  // Очередь алертов: шлём по одному с паузой; при заторе (>5) — один дайджест вместо бомбардировки.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const queue: IncidentEvent[] = [];
  let draining = false;

  const sendSafe = async (text: string, keyboard?: InlineKeyboard): Promise<void> => {
    if (adminChatId === undefined) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await bot.api.sendMessage(adminChatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 429) {
          const wait = (err.parameters.retry_after ?? 5) + 1;
          await sleep(wait * 1000);
          continue;
        }
        console.error('[alert] send failed:', err instanceof Error ? err.message : err);
        return;
      }
    }
    console.error('[alert] send dropped after retries (rate limit)');
  };

  const fmtDigest = (batch: IncidentEvent[], red: number): string => {
    const byLevel = { red: 0, orange: 0, yellow: 0, green: 0 };
    for (const ev of batch) byLevel[ev.level]++;
    const top = [...batch].sort((a, b) => b.score - a.score).slice(0, 10);
    const rows = top
      .map(
        (ev) =>
          `${LEVEL_EMOJI[ev.level] ?? ''} <code>${escapeHtml(ev.username)}</code> — <b>${leakPct(ev.score, red)}%</b> · ${ev.activeIps} IP`,
      )
      .join('\n');
    const lines = [
      `⚠️ <b>Новые инциденты: ${batch.length}</b>  (🔴 ${byLevel.red} · 🟠 ${byLevel.orange})`,
      '',
      `<blockquote>${rows}${batch.length > top.length ? `\n…и ещё ${batch.length - top.length}` : ''}</blockquote>`,
      '',
      '<i>Разбор и действия — в веб-панели</i>',
    ];
    return lines.join('\n');
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const red = loadScoringConfig(db).thresholds.red;
        if (queue.length > 5) {
          const batch = queue.splice(0, queue.length);
          await sendSafe(fmtDigest(batch, red));
        } else {
          const ev = queue.shift()!;
          await sendSafe(fmtIncident(ev, red), actionKeyboard(ev.userId));
        }
        await sleep(1500);
      }
    } finally {
      draining = false;
    }
  };

  bus.on('incident', (ev) => {
    if (!loadScoringConfig(db).telegramAlertsEnabled) return; // выключено в настройках панели
    if (adminChatId === undefined) {
      console.log('[alert] TELEGRAM_ADMIN_CHAT_ID не задан — уведомление не отправлено. Напиши боту /start, чтобы узнать chat id.');
      return;
    }
    queue.push(ev);
    void drain();
  });

  // автобан по HWID-блэклисту: шлём всегда, даже при выключенных обычных алертах —
  // это исполнение приговора, о нём надо знать
  bus.on('hwid_autoban', (ev) => {
    if (adminChatId === undefined) return;
    const src = ev.sourceUsername ? ` (устройство из бана ${ev.sourceUsername})` : '';
    const text = ev.ok
      ? `🚫 Автобан по HWID: ${ev.username} отключён${src}.\nHWID: ${ev.hwid}`
      : `⚠️ Автобан по HWID не сработал для ${ev.username}${src} — проверь журнал.`;
    void bot.api.sendMessage(adminChatId, text).catch((err) => console.error('[alert] hwid autoban:', err));
  });

  bot.catch((err) => console.error('[telegram]', err));

  // long-polling не должен ронять процесс: при сетевых сбоях ретраим сами
  void (async () => {
    for (;;) {
      try {
        await bot.start({ onStart: () => console.log('[telegram] polling started') });
        return; // штатная остановка
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[telegram] polling failed (${msg}), retry in 30s`);
        await sleep(30_000);
      }
    }
  })();
  return { started: true };
}

function labelFor(action: ActionName): string {
  switch (action) {
    case 'revoke': return 'перегенерировать ключи';
    case 'disable': return 'отключить';
    case 'drop': return 'сбросить соединения';
    case 'whitelist': return 'в белый список';
    default: return action;
  }
}

function actionKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Revoke', `ask:revoke:${userId}`)
    .text('⛔ Отключить', `ask:disable:${userId}`)
    .text('🔌 Сброс', `ask:drop:${userId}`)
    .row()
    .text('🤍 Whitelist', `ask:whitelist:${userId}`);
}
