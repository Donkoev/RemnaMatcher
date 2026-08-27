import type Database from 'better-sqlite3';
import type { RemnaEnforcer } from './remnawave/types.js';

export type ActionName = 'revoke' | 'disable' | 'enable' | 'drop' | 'whitelist' | 'unwhitelist';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Единственная точка, из которой выполняются карательные действия.
 * Всегда пишет журнал. Вызывается только по явному действию человека (кнопка в TG или в вебе).
 */
export class Actions {
  constructor(
    private db: Database.Database,
    private enforcer: RemnaEnforcer,
  ) {}

  private userByid(userId: number): { uuid: string; username: string } | undefined {
    return this.db
      .prepare<[number], { uuid: string; username: string }>('SELECT uuid, username FROM users WHERE id = ?')
      .get(userId);
  }

  private log(userId: number | null, action: string, source: string, ok: boolean, error?: string): void {
    this.db
      .prepare('INSERT INTO actions_log (ts, user_id, action, source, ok, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), userId, action, source, ok ? 1 : 0, error ?? null);
  }

  private markIncidents(userId: number, status: 'actioned' | 'ignored'): void {
    this.db.prepare("UPDATE incidents SET status = ? WHERE user_id = ? AND status = 'open'").run(status, userId);
  }

  async run(action: ActionName, userId: number, source: 'telegram' | 'web'): Promise<ActionResult> {
    const user = this.userByid(userId);
    if (!user) return { ok: false, message: `Юзер id ${userId} не найден в локальной базе` };

    try {
      switch (action) {
        case 'revoke':
          await this.enforcer.revokeSubscription(user.uuid);
          await this.enforcer.dropConnectionsByUser(user.uuid);
          this.markIncidents(userId, 'actioned');
          this.log(userId, action, source, true);
          return { ok: true, message: `🔄 Ключи ${user.username} перегенерированы, активные соединения сброшены. Утёкший vless мёртв.` };

        case 'disable':
          await this.enforcer.disableUser(user.uuid);
          await this.enforcer.dropConnectionsByUser(user.uuid);
          // статус локально сразу, не дожидаясь синка — отключённый тут же уходит с главной
          this.db.prepare("UPDATE users SET status = 'DISABLED' WHERE id = ?").run(userId);
          this.markIncidents(userId, 'actioned');
          this.log(userId, action, source, true);
          return { ok: true, message: `⛔ ${user.username} отключён, соединения сброшены.` };

        case 'enable':
          await this.enforcer.enableUser(user.uuid);
          this.db.prepare("UPDATE users SET status = 'ACTIVE' WHERE id = ?").run(userId);
          this.log(userId, action, source, true);
          return { ok: true, message: `✅ ${user.username} снова включён.` };

        case 'drop':
          await this.enforcer.dropConnectionsByUser(user.uuid);
          this.log(userId, action, source, true);
          return { ok: true, message: `🔌 Активные соединения ${user.username} сброшены на всех нодах.` };

        case 'whitelist':
          this.db
            .prepare('INSERT OR REPLACE INTO whitelist (user_id, reason, added_at) VALUES (?, ?, ?)')
            .run(userId, `via ${source}`, Date.now());
          this.markIncidents(userId, 'ignored');
          this.log(userId, action, source, true);
          return { ok: true, message: `🤍 ${user.username} в белом списке — уведомления по нему отключены.` };

        case 'unwhitelist':
          this.db.prepare('DELETE FROM whitelist WHERE user_id = ?').run(userId);
          this.log(userId, action, source, true);
          return { ok: true, message: `${user.username} убран из белого списка.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(userId, action, source, false, msg);
      return { ok: false, message: `Ошибка действия «${action}» для ${user.username}: ${msg}` };
    }
  }
}
