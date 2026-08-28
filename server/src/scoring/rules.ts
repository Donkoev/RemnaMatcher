import type { IpMeta } from '../geo/index.js';

export interface ActiveIp extends IpMeta {
  lastSeen: number;
  nodes: string[];
}

export interface Signal {
  key: string;
  label: string;
  points: number;
  evidence: string;
  /** число активных IP на момент срабатывания — для самоисцеления памяти при досинке HWID-лимита */
  ipsCount?: number;
}

export interface ScoringConfig {
  /** IP считается активным, если lastSeen не старше этого окна (мин) */
  activeWindowMin: number;
  /** окно счётчика «уникальные IP» на карточке и в отчёте (мин) */
  uniqueWindowMin: number;
  /** параметры сбора данных: правятся в панели, одноимённые env-переменные — дефолты первого запуска */
  collector: {
    /** полный цикл опроса всех нод, сек */
    pollIntervalSec: number;
    /** пауза между нодами внутри цикла, мс */
    nodePollGapMs: number;
    /** синхронизация справочника юзеров (и HWID-лимитов), сек */
    userSyncIntervalSec: number;
    /** сколько часов хранить сырые наблюдения */
    retentionHours: number;
  };
  /** пороги уровней */
  thresholds: { yellow: number; orange: number; red: number };
  /** период полураспада скора, часов */
  decayHalfLifeHours: number;
  /** скорость трафика (байт/сек), выше которой срабатывает слабый сигнал */
  trafficRateBps: number;
  /** не слать повторное уведомление по юзеру чаще, чем раз в N часов (если уровень не вырос) */
  alertCooldownHours: number;
  /** автобан: устройство из HWID-блэклиста всплыло в живой подписке — отключить её */
  hwidAutobanEnabled: boolean;
  /** слать ли уведомления в Telegram вообще */
  telegramAlertsEnabled: boolean;
  /** настройки сигналов: подписку легально могут делить 5–10 человек, поэтому пороги сдвигаемые */
  signals: {
    /** одновременные разные провайдеры; ниже minAsns не срабатывает */
    multiAsn: { enabled: boolean; minAsns: number };
    /** одновременные разные страны (слабый сигнал) */
    multiCountry: { enabled: boolean };
    /** датацентровые IP */
    datacenter: { enabled: boolean };
    /**
     * число одновременных IP. Если у юзера задан HWID-лимит, персональный порог =
     * лимит × perDeviceIps (устройство легально может засветить пару IP при смене сети);
     * minIps — запасной глобальный порог для юзеров без лимита.
     */
    ipCount: { enabled: boolean; minIps: number; perDeviceIps: number };
    /** аномальная скорость трафика (только как усилитель) */
    trafficRate: { enabled: boolean };
    /** блокировки торрент-блокером панели */
    torrent: { enabled: boolean };
  };
}

export const DEFAULT_CONFIG: ScoringConfig = {
  activeWindowMin: 5,
  uniqueWindowMin: 10,
  collector: { pollIntervalSec: 60, nodePollGapMs: 1500, userSyncIntervalSec: 300, retentionHours: 48 },
  thresholds: { yellow: 40, orange: 70, red: 100 },
  decayHalfLifeHours: 6,
  trafficRateBps: 3 * 1024 * 1024,
  alertCooldownHours: 6,
  hwidAutobanEnabled: true,
  telegramAlertsEnabled: true,
  signals: {
    multiAsn: { enabled: true, minAsns: 4 },
    multiCountry: { enabled: true },
    datacenter: { enabled: true },
    ipCount: { enabled: true, minIps: 10, perDeviceIps: 2 },
    trafficRate: { enabled: true },
    torrent: { enabled: true },
  },
};

export type Level = 'green' | 'yellow' | 'orange' | 'red';

export function levelFor(score: number, cfg: ScoringConfig): Level {
  if (score >= cfg.thresholds.red) return 'red';
  if (score >= cfg.thresholds.orange) return 'orange';
  if (score >= cfg.thresholds.yellow) return 'yellow';
  return 'green';
}

/**
 * Все правила работают только по IP, активным в данный момент (окно activeWindowMin) —
 * Xray-Core держит сессии «действительными» дольше реального, поэтому фильтр по lastSeen обязателен.
 *
 * Приоритет проверок (задан владельцем):
 *   1) много одновременных IP  2) всплеск трафика  3) при превышении порога IP — разные провайдеры
 *   4) страны  5) датацентры  6) торрент-блокер
 *
 * Гео-«перемещения» (impossible travel, разные города) намеренно НЕ используются:
 * подписку легально могут делить друзья из разных городов, а CGNAT мобильных
 * операторов геолоцируется скачками.
 */
export function computeSignals(
  ips: ActiveIp[],
  trafficRateBps: number | null,
  torrentBlocks24h: number,
  hwidLimit: number | null,
  cfg: ScoringConfig,
): Signal[] {
  const signals: Signal[] = [];
  if (ips.length === 0) return signals;
  const s = cfg.signals;

  // --- 1. Число одновременных IP (главный сигнал): персональный порог от HWID-лимита юзера ---
  const personalLimit = hwidLimit !== null && hwidLimit > 0;
  const ipThreshold = personalLimit ? hwidLimit * s.ipCount.perDeviceIps : s.ipCount.minIps;
  const tooManyIps = personalLimit ? ips.length > ipThreshold : ips.length >= ipThreshold;
  if (s.ipCount.enabled && tooManyIps) {
    signals.push({
      key: 'ip_count',
      label: 'Много одновременных IP',
      points: Math.min(40 + (ips.length - ipThreshold) * 5, 60),
      evidence: personalLimit
        ? `${ips.length} активных IP при лимите ${hwidLimit} устройств (порог ${ipThreshold}) в окне ${cfg.activeWindowMin} мин`
        : `${ips.length} активных IP в окне ${cfg.activeWindowMin} мин`,
      ipsCount: ips.length,
    });
  }

  // --- 2. Всплеск трафика ---
  if (s.trafficRate.enabled && trafficRateBps !== null && trafficRateBps > cfg.trafficRateBps) {
    const extreme = trafficRateBps > cfg.trafficRateBps * 2;
    signals.push({
      key: 'traffic_rate',
      label: 'Всплеск трафика',
      points: extreme ? 55 : 30,
      evidence: `${(trafficRateBps / 1024 / 1024).toFixed(1)} МБ/с в среднем за час (порог ${(cfg.trafficRateBps / 1024 / 1024).toFixed(1)})`,
    });
  }

  // --- 3. Разные провайдеры — проверяется только при превышении порога числа IP ---
  const asns = new Map<number, string>();
  for (const ip of ips) if (ip.asn !== null) asns.set(ip.asn, ip.asnOrg ?? String(ip.asn));
  const asnCount = asns.size;
  if (s.multiAsn.enabled && tooManyIps && asnCount >= s.multiAsn.minAsns) {
    const over = asnCount - s.multiAsn.minAsns;
    const points = over >= 2 ? 50 : over === 1 ? 35 : 25;
    signals.push({
      key: 'multi_asn',
      label: 'Одновременно с разных провайдеров',
      points,
      evidence: `${asnCount} ASN: ${[...asns.values()].slice(0, 6).join(', ')}${asnCount > 6 ? '…' : ''}`,
      ipsCount: ips.length,
    });
  }

  // --- 4. Одновременные разные страны ---
  if (s.multiCountry.enabled) {
    const countries = new Set(ips.map((i) => i.country).filter((c): c is string => !!c));
    if (countries.size >= 2) {
      signals.push({
        key: 'multi_country',
        label: 'Одновременно из разных стран',
        points: countries.size >= 3 ? 30 : 15,
        evidence: [...countries].join(', '),
      });
    }
  }

  // --- 5. Датацентровые IP ---
  if (s.datacenter.enabled) {
    const dcIps = ips.filter((i) => i.isDatacenter);
    if (dcIps.length > 0) {
      const dcAsns = new Set(dcIps.map((i) => i.asnOrg ?? String(i.asn)));
      signals.push({
        key: 'datacenter',
        label: 'Подключения из датацентров',
        points: Math.min(20 + (dcAsns.size - 1) * 8, 35),
        evidence: `${dcIps.length} IP (${[...dcAsns].slice(0, 4).join(', ')})`,
      });
    }
  }

  // --- 6. Торрент-блокировки ---
  if (s.torrent.enabled && torrentBlocks24h > 0) {
    signals.push({
      key: 'torrent',
      label: 'Ловится торрент-блокером',
      points: Math.min(10 + (torrentBlocks24h - 1) * 5, 20),
      evidence: `${torrentBlocks24h} блокировок за сутки`,
    });
  }

  return signals;
}
