/**
 * Типы под контракт @remnawave/backend-contract@2.7.3 (панель 2.7.4).
 * Все читающие операции и все действия описаны здесь единым интерфейсом,
 * но реализация намеренно разделена: HttpRemnaReader не умеет ничего, кроме чтения.
 */

export interface RemnaNode {
  uuid: string;
  name: string;
  countryCode: string;
  isConnected: boolean;
  isDisabled: boolean;
}

export interface RemnaUser {
  /** числовой id панели, приходит и в fetch-users-ips (там строкой) */
  id: number;
  uuid: string;
  shortUuid: string;
  username: string;
  status: 'ACTIVE' | 'DISABLED' | 'LIMITED' | 'EXPIRED';
  telegramId: number | null;
  email: string | null;
  tag: string | null;
  usedTrafficBytes: number;
  trafficLimitBytes: number;
  hwidDeviceLimit: number | null;
  subscriptionUrl: string | null;
  onlineAt: string | null;
  expireAt: string | null;
}

export interface UserIps {
  userId: string;
  ips: { ip: string; lastSeen: string }[];
}

export interface NodeSessions {
  nodeUuid: string;
  success: boolean;
  users: UserIps[];
}

export interface TorrentReport {
  id: number;
  userId: number;
  ip: string;
  nodeName: string;
  createdAt: number;
}

/** Только чтение. Коллектор получает ровно этот интерфейс и физически не может ничего изменить. */
export interface RemnaReader {
  getNodes(): Promise<RemnaNode[]>;
  /** Все юзеры панели, постранично внутри */
  getAllUsers(): Promise<RemnaUser[]>;
  /** Запустить job сбора сессий на ноде и дождаться результата */
  fetchNodeSessions(nodeUuid: string): Promise<NodeSessions>;
  /** Свежие репорты торрент-блокера (страница последних) */
  getTorrentReports(): Promise<TorrentReport[]>;
  /** Число HWID-устройств юзера (null — не удалось получить) */
  getHwidDeviceCount(userUuid: string): Promise<number | null>;
}

/** Карательные действия. Вызывается ТОЛЬКО из обработчиков кнопок (TG/веб) с подтверждением. */
export interface RemnaEnforcer {
  disableUser(uuid: string): Promise<void>;
  enableUser(uuid: string): Promise<void>;
  /** Перегенерация ключей: утёкший vless умирает */
  revokeSubscription(uuid: string): Promise<void>;
  dropConnectionsByIps(ips: string[]): Promise<void>;
  dropConnectionsByUser(uuid: string): Promise<void>;
}
