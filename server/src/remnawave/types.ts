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
  /** поле «Описание» из панели — админы хранят там инфо о юзере (имя, TG и т.п.) */
  description: string | null;
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

export interface HwidDevice {
  hwid: string;
  /** панель 2.7.x отдаёт uuid юзера, панель 3.x — числовой id; присутствует одно из двух */
  userUuid?: string;
  userId?: number;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  userAgent: string | null;
}

/** Версия API панели: '2' — ветка 2.7.x, '3' — ветка 3.x (другие пути и идентификаторы) */
export type PanelApiVersion = '2' | '3';

/** Ссылка на юзера для действий: 2.7.x адресует по uuid, 3.x — по числовому id */
export interface UserRef {
  id: number;
  uuid: string;
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
  getHwidDeviceCount(user: UserRef): Promise<number | null>;
  /** Страница общего списка HWID-устройств (HWID Inspector панели) */
  getAllHwidDevices(start: number, size: number): Promise<{ devices: HwidDevice[]; total: number }>;
}

/** Карательные действия. Вызывается ТОЛЬКО из обработчиков кнопок (TG/веб) с подтверждением. */
export interface RemnaEnforcer {
  disableUser(user: UserRef): Promise<void>;
  enableUser(user: UserRef): Promise<void>;
  /** Перегенерация ключей: утёкший vless умирает */
  revokeSubscription(user: UserRef): Promise<void>;
  dropConnectionsByIps(ips: string[]): Promise<void>;
  dropConnectionsByUser(user: UserRef): Promise<void>;
}
