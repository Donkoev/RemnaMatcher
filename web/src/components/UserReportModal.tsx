import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Drawer,
  Grid,
  Group,
  LoadingOverlay,
  Menu,
  Modal,
  Progress,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  TbArrowsSort,
  TbBan,
  TbBrandAndroid,
  TbBrandApple,
  TbBrandWindows,
  TbBuilding,
  TbDeviceDesktop,
  TbChartBar,
  TbCheck,
  TbClockCheck,
  TbClockExclamation,
  TbClockPause,
  TbCalendarTime,
  TbDevices,
  TbDotsVertical,
  TbExternalLink,
  TbFingerprint,
  TbHistory,
  TbNotes,
  TbNetwork,
  TbSitemap,
  TbSortAscending,
  TbSortDescending,
  TbSum,
  TbWifi,
} from 'react-icons/tb';
import { PiUserCircle, PiWarningDuotone } from 'react-icons/pi';
import { useMediaQuery } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  cleanCity,
  flagEmoji,
  formatBytes,
  hwidApi,
  plural,
  timeAgo,
  type ActionName,
  type HwidDeviceInfo,
  type HwidLookupEntry,
  type UserIp,
} from '../api';
import { useUserModal } from '../userModal';
import { AsnMark } from './AsnMark';
import { CopyableField } from './rw/CopyableField';
import { LevelBadge } from './LevelBadge';
import { SectionCard } from './rw/SectionCard';
import { USER_ACTIONS, type ActionDef } from './userActions';

const ACTION_LABELS: Record<string, string> = {
  revoke: 'Revoke',
  disable: 'Отключение',
  enable: 'Включение',
  drop: 'Сброс соединений',
  whitelist: 'В белый список',
  unwhitelist: 'Из белого списка',
};

/** Чек-лист проверок в порядке приоритета: короткие однозначные названия */
const CHECKS: { cfgKey: 'trafficRate' | 'ipCount' | 'multiAsn' | 'multiCountry' | 'datacenter' | 'torrent'; key: string; label: string }[] = [
  { key: 'ip_count', cfgKey: 'ipCount', label: 'Слишком много IP' },
  { key: 'traffic_rate', cfgKey: 'trafficRate', label: 'Всплеск трафика' },
  { key: 'multi_asn', cfgKey: 'multiAsn', label: 'Разные провайдеры' },
  { key: 'multi_country', cfgKey: 'multiCountry', label: 'Разные страны' },
  { key: 'datacenter', cfgKey: 'datacenter', label: 'IP датацентров' },
  { key: 'torrent', cfgKey: 'torrent', label: 'Торренты' },
];

type IpSort =
  | 'recent'
  | 'oldest'
  | 'ip_asc'
  | 'ip_desc'
  | 'ip_subnet'
  | 'node_asc'
  | 'node_desc'
  | 'city_asc'
  | 'city_desc'
  | 'org_asc'
  | 'org_desc';

/**
 * Заголовок колонки, как в таблице юзеров Remnawave, но с МНОГОУРОВНЕВОЙ сортировкой:
 * клик добавляет колонку в цепочку критериев (первая — главный), повторные клики
 * переключают направление, прокрутка цикла до конца убирает колонку из цепочки.
 * Номер у иконки — позиция критерия в цепочке.
 */
function SortTh({
  label,
  states,
  hints,
  chain,
  onToggle,
  children,
}: {
  chain: IpSort[];
  children?: React.ReactNode;
  hints?: string[];
  label: string;
  onToggle: (states: IpSort[]) => void;
  states: IpSort[];
}) {
  const active = states.find((s) => chain.includes(s));
  const idx = active !== undefined ? states.indexOf(active) : -1;
  const chainPos = active !== undefined ? chain.indexOf(active) : -1;
  const icon =
    active === undefined ? (
      <TbArrowsSort size={17} />
    ) : active === 'ip_subnet' ? (
      <TbSitemap size={17} />
    ) : active.endsWith('_asc') || active === 'recent' ? (
      <TbSortAscending size={17} />
    ) : (
      <TbSortDescending size={17} />
    );
  const header = (
    <Group
      gap={4}
      onClick={() => onToggle(states)}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      wrap="nowrap"
    >
      <Text fw={600} fz={{ base: 'sm', sm: 'md' }} style={{ whiteSpace: 'nowrap' }}>
        {label}
      </Text>
      <Box style={{ display: 'flex', color: idx !== -1 ? 'var(--mantine-color-cyan-4)' : 'var(--mantine-color-dark-3)' }}>
        {icon}
      </Box>
      {chainPos !== -1 && chain.length > 1 && (
        <Text c="cyan.4" fw={700} fz={10} lh={1}>
          {chainPos + 1}
        </Text>
      )}
    </Group>
  );
  return (
    <Table.Th style={{ verticalAlign: 'top' }}>
      {hints && idx !== -1 ? <Tooltip label={hints[idx]}>{header}</Tooltip> : header}
      {children && <Box mt={6}>{children}</Box>}
    </Table.Th>
  );
}

/** числовое сравнение IP по октетам — заодно группирует подсети по первым трём октетам */
function compareIp(a: string, b: string): number {
  const oa = a.split('.').map(Number);
  const ob = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (oa[i] ?? 0) - (ob[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** компаратор для одного критерия */
function compareBy(sort: IpSort, subnetCounts: Map<string, number>, now: number): (a: UserIp, b: UserIp) => number {
  const subnet = (ip: string) => ip.split('.').slice(0, 3).join('.');
  // активность сравниваем по возрасту в минутах — ровно так, как она показана в строке:
  // иначе секунды всегда различаются и до следующих критериев цепочки очередь не доходит
  const ageMin = (t: number) => Math.floor(Math.max(0, now - t) / 60_000);
  switch (sort) {
    case 'recent': return (a, b) => ageMin(a.lastSeen) - ageMin(b.lastSeen);
    case 'oldest': return (a, b) => ageMin(b.lastSeen) - ageMin(a.lastSeen);
    case 'ip_asc': return (a, b) => compareIp(a.ip, b.ip);
    case 'ip_desc': return (a, b) => compareIp(b.ip, a.ip);
    case 'ip_subnet':
      // подсети с наибольшим числом IP — сверху, внутри по адресу
      return (a, b) => {
        const d = (subnetCounts.get(subnet(b.ip)) ?? 0) - (subnetCounts.get(subnet(a.ip)) ?? 0);
        if (d !== 0) return d;
        const sa = subnet(a.ip);
        const sb = subnet(b.ip);
        if (sa !== sb) return compareIp(a.ip, b.ip);
        return 0;
      };
    case 'node_asc': return (a, b) => (a.nodes ?? 'я').localeCompare(b.nodes ?? 'я', 'ru');
    case 'node_desc': return (a, b) => (b.nodes ?? 'я').localeCompare(a.nodes ?? 'я', 'ru');
    case 'city_asc': return (a, b) => (a.city ?? 'я').localeCompare(b.city ?? 'я', 'ru');
    case 'city_desc': return (a, b) => (b.city ?? 'я').localeCompare(a.city ?? 'я', 'ru');
    case 'org_asc': return (a, b) => (a.asnOrg ?? 'я').localeCompare(b.asnOrg ?? 'я', 'ru');
    case 'org_desc': return (a, b) => (b.asnOrg ?? 'я').localeCompare(a.asnOrg ?? 'я', 'ru');
  }
}

/**
 * Многоуровневая сортировка. «По подсетям» во главе цепочки — это ГРУППИРОВКА:
 * строки внутри группы и порядок самих групп подчиняются остальным критериям
 * (группы сперва по размеру, при равенстве — по верхней строке группы).
 */
function sortIps(ips: UserIp[], chain: IpSort[]): UserIp[] {
  const now = Date.now();
  const subnetOf = (ip: string) => ip.split('.').slice(0, 3).join('.');
  const subnetCounts = new Map<string, number>();
  for (const i of ips) subnetCounts.set(subnetOf(i.ip), (subnetCounts.get(subnetOf(i.ip)) ?? 0) + 1);

  // когда все критерии цепочки равны — добиваем точным временем и адресом,
  // чтобы порядок был строгим сверху вниз, без «как получится»
  const finalCmp = (a: UserIp, b: UserIp): number => {
    const d = b.lastSeen - a.lastSeen;
    if (d !== 0) return d;
    return compareIp(a.ip, b.ip);
  };

  if (chain[0] === 'ip_subnet') {
    const rest = chain.slice(1).filter((c) => c !== 'ip_subnet');
    const restCmp = (a: UserIp, b: UserIp): number => {
      for (const c of rest) {
        const d = compareBy(c, subnetCounts, now)(a, b);
        if (d !== 0) return d;
      }
      return finalCmp(a, b);
    };
    const groups = new Map<string, UserIp[]>();
    for (const ip of ips) {
      const s = subnetOf(ip.ip);
      const g = groups.get(s) ?? [];
      g.push(ip);
      groups.set(s, g);
    }
    const sorted = [...groups.values()].map((rows) => [...rows].sort(restCmp));
    sorted.sort((ga, gb) => {
      const d = gb.length - ga.length;
      if (d !== 0) return d;
      return restCmp(ga[0]!, gb[0]!);
    });
    return sorted.flat();
  }

  const comparators = chain.map((c) => compareBy(c, subnetCounts, now));
  return [...ips].sort((a, b) => {
    for (const cmp of comparators) {
      const d = cmp(a, b);
      if (d !== 0) return d;
    }
    return finalCmp(a, b);
  });
}

const getLastSeenIndicator = (lastSeen: number) => {
  const diffMinutes = (Date.now() - lastSeen) / 60_000;
  if (diffMinutes <= 5) return { color: 'var(--mantine-color-teal-6)', Icon: TbClockCheck };
  if (diffMinutes <= 60) return { color: 'var(--mantine-color-yellow-6)', Icon: TbClockPause };
  return { color: 'var(--mantine-color-red-6)', Icon: TbClockExclamation };
};

const PLATFORM_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  ios: TbBrandApple,
  macos: TbBrandApple,
  android: TbBrandAndroid,
  windows: TbBrandWindows,
  linux: TbDeviceDesktop,
};

/** Дата истечения подписки: дата + бейдж «сколько осталось»; 2098+ считаем бессрочной */
function ExpireRow({ expireAt }: { expireAt: number | null }) {
  if (!expireAt) {
    return (
      <Group gap="sm" wrap="nowrap">
        <TbCalendarTime color="var(--mantine-color-dark-2)" size={18} />
        <Text c="dimmed" fz="sm">
          Дата истечения не задана
        </Text>
      </Group>
    );
  }
  const endless = new Date(expireAt).getFullYear() >= 2098;
  const daysLeft = Math.ceil((expireAt - Date.now()) / 864e5);
  const expired = daysLeft < 0;
  const color = endless ? 'teal' : expired ? 'red' : daysLeft <= 7 ? 'orange' : 'teal';
  return (
    <Group gap="sm" wrap="nowrap">
      <TbCalendarTime color={`var(--mantine-color-${color}-5)`} size={18} style={{ flexShrink: 0 }} />
      <Text fz="sm">
        {endless ? 'Бессрочная подписка' : `Истекает ${new Date(expireAt).toLocaleDateString('ru-RU')}`}
      </Text>
      {!endless && (
        <Badge color={color} size="sm" variant="soft">
          {expired
            ? 'истекла'
            : daysLeft === 0
              ? 'сегодня'
              : `${daysLeft} ${plural(daysLeft, ['день', 'дня', 'дней'])}`}
        </Badge>
      )}
    </Group>
  );
}

/**
 * Карточка HWID-устройства в стиле панели Remnawave: иконка платформы
 * в soft-квадрате, номер и модель, копируемое поле HWID, пересечения и метка ЧС.
 */
function DeviceCard({ device, index }: { device: HwidDeviceInfo; index: number }) {
  const { openUser } = useUserModal();
  const [shared, setShared] = useState<HwidLookupEntry[] | null>(null);
  const Icon = PLATFORM_ICONS[(device.platform ?? '').toLowerCase()] ?? TbDevices;
  return (
    <SectionCard.Root dividerOpacity={0} gap={0} p="sm">
      <SectionCard.Section>
        <Group gap="sm" justify="space-between" wrap="nowrap">
          <Group gap="sm" style={{ minWidth: 0 }} wrap="nowrap">
            <ThemeIcon color={device.blacklisted ? 'red' : 'indigo'} size="lg" variant="soft">
              <Icon size={18} />
            </ThemeIcon>
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={600} fz="sm" truncate>
                #{index + 1} · {device.deviceModel ?? device.platform ?? 'устройство'}
              </Text>
              <Text c="dimmed" fz="xs" truncate>
                {[device.platform, device.osVersion].filter(Boolean).join(' ') || 'платформа неизвестна'} ·{' '}
                {timeAgo(device.lastSeen)}
              </Text>
            </Stack>
          </Group>
          <Group gap={6} style={{ flexShrink: 0 }} wrap="nowrap">
            {device.blacklisted && (
              <Badge color="red" size="sm" variant="soft">
                в ЧС
              </Badge>
            )}
            {device.sharedWith > 0 && (
              <Tooltip label="Этот HWID светился и в других подписках — показать" radius="md">
                <Badge
                  color="orange"
                  onClick={() => {
                    if (shared) return setShared(null);
                    void hwidApi.lookup(device.hwid).then((r) => setShared(r.entries));
                  }}
                  size="sm"
                  style={{ cursor: 'pointer' }}
                  variant="soft"
                >
                  ещё в {device.sharedWith}
                </Badge>
              </Tooltip>
            )}
          </Group>
        </Group>

        <Box mt={8}>
          <CopyableField size="xs" value={device.hwid} />
        </Box>

        {shared && (
          <Stack gap={2} mt={6}>
            {shared.map((e) => (
              <Group gap={6} key={`${e.userId}-${e.firstSeen}`} wrap="nowrap">
                <Text c="cyan" fz="xs" onClick={() => openUser(e.userId)} style={{ cursor: 'pointer' }}>
                  {e.username ?? `id ${e.userId}`}
                </Text>
                <Text c="dimmed" fz="xs">
                  {e.status === 'DISABLED' ? 'отключён' : (e.status?.toLowerCase() ?? '')}
                  {e.deletedAt ? ' · устройство удалено' : ''} · {timeAgo(e.lastSeen)}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </SectionCard.Section>
    </SectionCard.Root>
  );
}

/** Заголовок блока в стиле Remnawave: иконка в soft-квадрате + название */
function BlockHeader({ color, icon, title }: { color: string; icon: React.ReactNode; title: string }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <ThemeIcon color={color} size="lg" variant="soft">
        {icon}
      </ThemeIcon>
      <Title c="white" order={5}>
        {title}
      </Title>
    </Group>
  );
}

const TRAFFIC_SLOTS = 96;

/**
 * Отчёт по юзеру — только антифрод-данные, которых НЕТ в панели Remnawave.
 * Раскладка: сетка компактных блоков сверху (2×2), IP-адреса — вниз на всю ширину.
 */
export function UserReportModal({ userId, onClose }: { userId: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [confirm, setConfirm] = useState<ActionDef | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => api.user(userId!),
    enabled: userId !== null,
  });
  const { data: cfg } = useQuery({ queryKey: ['settings'], queryFn: api.settings });

  // модалка открывается мгновенно: сначала каркас с крутилкой,
  // тяжёлый контент монтируется следующим кадром
  const [contentReady, setContentReady] = useState(false);

  // дефолт по просьбе владельца: только активные, по подсетям, внутри — сначала недавние
  const [sortChain, setSortChain] = useState<IpSort[]>(['ip_subnet', 'recent']);
  const [onlyActive, setOnlyActive] = useState(true);

  // клик по колонке: нет в цепочке → добавить в конец; есть → следующий режим колонки;
  // прокрутили все режимы → колонка выбывает из цепочки
  const toggleSort = (states: IpSort[]): void => {
    setSortChain((chain) => {
      const active = states.find((s) => chain.includes(s));
      if (active === undefined) return [...chain, states[0]!];
      const next = states.indexOf(active) + 1;
      if (next < states.length) return chain.map((s) => (s === active ? states[next]! : s));
      const rest = chain.filter((s) => s !== active);
      return rest.length > 0 ? rest : ['ip_subnet'];
    });
  };

  useEffect(() => {
    setContentReady(false);
    setSortChain(['ip_subnet', 'recent']);
    setOnlyActive(true);
    setDevicesOpen(false);
    if (userId === null) return;
    const t = setTimeout(() => setContentReady(true), 30);
    return () => clearTimeout(t);
  }, [userId]);

  const mutation = useMutation({
    mutationFn: (action: ActionName) => api.action(action, userId!),
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: ['user', userId] });
      void qc.invalidateQueries({ queryKey: ['suspects'] });
      void qc.invalidateQueries({ queryKey: ['incidents'] });
      void qc.invalidateQueries({ queryKey: ['actions-log'] });
      void qc.invalidateQueries({ queryKey: ['lists'] });
    },
    onError: (err: Error) => setResult({ ok: false, message: err.message }),
  });

  const hourlyRate = useMemo(() => {
    if (!data || data.traffic.length < 2) return null;
    const hourAgo = Date.now() - 3600_000;
    const recent = data.traffic.filter((t) => t.ts >= hourAgo);
    if (recent.length < 2) return null;
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    if (last.ts === first.ts) return null;
    return Math.max(0, (last.used - first.used) / ((last.ts - first.ts) / 1000));
  }, [data]);

  // бары потребления на реальной шкале времени: 96 слотов по 15 минут за сутки,
  // каждый замер ложится в свой слот — пустота слева честно показывает «данных ещё не было»
  const traffic24 = useMemo(() => {
    const slots = new Array<number>(TRAFFIC_SLOTS).fill(0);
    let total = 0;
    if (!data) return { slots, total, points: 0 };
    const now = Date.now();
    const dayAgo = now - 24 * 3600_000;
    const slotMs = (24 * 3600_000) / TRAFFIC_SLOTS;
    const pts = data.traffic.filter((t) => t.ts >= dayAgo);
    for (let i = 1; i < pts.length; i++) {
      const bytes = Math.max(0, pts[i]!.used - pts[i - 1]!.used);
      const slot = Math.min(TRAFFIC_SLOTS - 1, Math.max(0, Math.floor((pts[i]!.ts - dayAgo) / slotMs)));
      slots[slot]! += bytes;
      total += bytes;
    }
    return { slots, total, points: pts.length };
  }, [data]);

  const maxBar = Math.max(...traffic24.slots, 1);
  // «активен» считаем по текущему времени, а не по флагу на момент запроса —
  // иначе при подвисших данных фильтр и часики противоречат друг другу
  const activeWindowMs = (cfg?.activeWindowMin ?? 5) * 60_000;
  const isIpActive = (ip: UserIp): boolean => Date.now() - ip.lastSeen <= activeWindowMs;
  const activeCount = data?.ips.filter(isIpActive).length ?? 0;

  const visibleIps = useMemo(() => {
    let list = data?.ips ?? [];
    if (onlyActive) list = list.filter(isIpActive);
    return sortIps(list, sortChain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, onlyActive, sortChain, activeWindowMs]);

  // имя ноды → страна для флага в колонке «Нода»
  const nodeCountry = useMemo(
    () => new Map((data?.nodeCatalog ?? []).map((n) => [n.name, n.country])),
    [data],
  );

  // в режиме «по подсетям» подсвечиваем РЕАЛЬНЫЕ группы (2+ IP из одной /24) своим цветом
  const subnetColors = useMemo(() => {
    if (!sortChain.includes('ip_subnet')) return null;
    const palette = ['cyan', 'grape', 'orange', 'teal', 'yellow', 'blue', 'pink', 'lime'];
    const counts = new Map<string, number>();
    for (const ip of visibleIps) {
      const s = ip.ip.split('.').slice(0, 3).join('.');
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const colors = new Map<string, string>();
    let i = 0;
    for (const ip of visibleIps) {
      const s = ip.ip.split('.').slice(0, 3).join('.');
      if ((counts.get(s) ?? 0) > 1 && !colors.has(s)) colors.set(s, palette[i++ % palette.length]!);
    }
    return colors;
  }, [sortChain, visibleIps]);

  const visibleActions = data
    ? USER_ACTIONS.filter((a) => {
        if (a.action === 'enable') return data.user.status === 'DISABLED';
        if (a.action === 'disable') return data.user.status !== 'DISABLED';
        if (a.action === 'whitelist') return !data.whitelisted;
        if (a.action === 'unwhitelist') return data.whitelisted;
        if (a.action === 'hwid_ban') return data.hwid.devices.length > 0;
        return true;
      })
    : [];

  return (
    <Modal
      onClose={() => {
        setResult(null);
        onClose();
      }}
      fullScreen={isMobile}
      opened={userId !== null}
      size={1080}
      styles={
        isMobile
          ? {
              // на мобиле — обычная вертикальная прокрутка всего содержимого
              content: { height: '100dvh', display: 'flex', flexDirection: 'column' },
              body: { flex: 1, overflowY: 'auto' },
            }
          : {
              // на десктопе модалка фиксированной высоты и сама НЕ листается — скроллится только список IP
              content: {
                display: 'flex',
                flexDirection: 'column',
                height: 'calc(100dvh - 6rem)',
                overflow: 'hidden',
              },
              body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
            }
      }
      title={
        data ? (
          <Group gap="sm">
            <PiUserCircle size={22} />
            <Text fw={700} fz="lg">
              {data.user.username}
            </Text>
            {data.score && <LevelBadge level={data.score.level} score={data.score.score} size="md" />}
            {data.whitelisted && (
              <Badge color="gray" size="sm" variant="outline">
                whitelist
              </Badge>
            )}
            <Text c="dimmed" fz="sm">
              id {data.user.id}
            </Text>
          </Group>
        ) : (
          'Отчёт по юзеру'
        )
      }
    >
      {!contentReady || isLoading || !data ? (
        <Box pos="relative" style={{ flex: 1, minHeight: 300 }}>
          <LoadingOverlay visible />
        </Box>
      ) : (
        <Stack gap="md" pt="xs" style={isMobile ? undefined : { flex: 1, minHeight: 0 }}>
          {result && (
            <Alert
              color={result.ok ? 'teal' : 'red'}
              icon={result.ok ? <TbCheck size={16} /> : <TbBan size={16} />}
              onClose={() => setResult(null)}
              variant="light"
              withCloseButton
            >
              {result.message}
            </Alert>
          )}

          {/* сетка компактных блоков: каждый — отдельная карточка */}
          <Grid gutter="md">
            <Grid.Col span={{ base: 12, md: 6 }}>
              <SectionCard.Root gap="sm" h="100%">
                <SectionCard.Section>
                  <BlockHeader color="orange" icon={<PiWarningDuotone size={18} />} title="Проверки" />
                </SectionCard.Section>
                <SectionCard.Section>
                  <Stack gap={6}>
                    {CHECKS.filter((c) => !cfg || cfg.signals[c.cfgKey].enabled).map((c) => {
                      const hit = data.score?.signals.find((s) => s.key === c.key);
                      // проверка сейчас чистая, но срабатывала раньше — её очки ещё затухают
                      const seen = !hit ? data.score?.signalsSeen?.[c.key] : undefined;
                      return (
                        <Group gap="sm" justify="space-between" key={c.key} wrap="nowrap">
                          <Text c={hit || seen ? undefined : 'dimmed'} fz="sm" lh={1.3}>
                            {c.label}
                          </Text>
                          {hit ? (
                            <Tooltip label={hit.evidence} maw={360} multiline radius="md">
                              <Badge color="red" size="sm" style={{ cursor: 'help', flexShrink: 0 }} variant="soft">
                                есть
                              </Badge>
                            </Tooltip>
                          ) : seen ? (
                            <Tooltip
                              label={`Срабатывало ${timeAgo(seen.at)}: ${seen.evidence}. Очки фрода за это ещё не затухли — поэтому уровень держится.`}
                              maw={360}
                              multiline
                              radius="md"
                            >
                              <Badge color="yellow" size="sm" style={{ cursor: 'help', flexShrink: 0 }} variant="soft">
                                было
                              </Badge>
                            </Tooltip>
                          ) : (
                            <Badge color="teal" size="sm" style={{ flexShrink: 0 }} variant="soft">
                              нет
                            </Badge>
                          )}
                        </Group>
                      );
                    })}
                  </Stack>
                </SectionCard.Section>
              </SectionCard.Root>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <SectionCard.Root gap="sm" h="100%">
                <SectionCard.Section>
                  <Group justify="space-between">
                    <BlockHeader color="cyan" icon={<TbChartBar size={18} />} title="Потребление трафика" />
                    {hourlyRate !== null && (
                      <Tooltip label="Средняя скорость скачивания за последний час">
                        <Badge color="cyan" size="sm" variant="soft">
                          ≈ {(hourlyRate / 1024 / 1024).toFixed(1)} МБ/с
                        </Badge>
                      </Tooltip>
                    )}
                  </Group>
                </SectionCard.Section>
                <SectionCard.Section>
                  <Text fw={700} fz="lg" mb={6}>
                    {formatBytes(traffic24.total)}{' '}
                    <Text c="dimmed" component="span" fw={400} fz="sm">
                      скачано за сутки
                    </Text>
                  </Text>
                  {traffic24.points > 1 ? (
                    <>
                      <svg
                        height={64}
                        preserveAspectRatio="none"
                        style={{ display: 'block' }}
                        viewBox={`0 0 ${TRAFFIC_SLOTS * 6} 64`}
                        width="100%"
                      >
                        <line stroke="var(--mantine-color-dark-5)" strokeWidth={1} x1={0} x2={TRAFFIC_SLOTS * 6} y1={63.5} y2={63.5} />
                        {traffic24.slots.map((bytes, i) =>
                          bytes > 0 ? (
                            <rect
                              fill="var(--mantine-color-cyan-6)"
                              height={Math.max(2, (bytes / maxBar) * 58)}
                              key={i}
                              opacity={0.4 + 0.6 * (bytes / maxBar)}
                              rx={1.5}
                              width={4.4}
                              x={i * 6}
                              y={63 - Math.max(2, (bytes / maxBar) * 58)}
                            />
                          ) : null,
                        )}
                      </svg>
                      <Group justify="space-between" mt={2}>
                        <Text c="dimmed" fz="sm">
                          −24 ч
                        </Text>
                        <Text c="dimmed" fz="sm">
                          −12 ч
                        </Text>
                        <Text c="dimmed" fz="sm">
                          сейчас
                        </Text>
                      </Group>
                    </>
                  ) : (
                    <Text c="dimmed" fz="sm">
                      График накопится за пару часов работы: каждый столбик — сколько юзер скачал за
                      15 минут. Постоянная высокая полка = ключом пользуется толпа.
                    </Text>
                  )}
                </SectionCard.Section>
              </SectionCard.Root>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <SectionCard.Root gap="sm" h="100%">
                <SectionCard.Section>
                  <Group justify="space-between" wrap="nowrap">
                    <BlockHeader color="orange" icon={<TbNotes size={18} />} title="Описание" />
                    {data.user.tag && (
                      <Badge color="gray" size="sm" variant="outline">
                        {data.user.tag}
                      </Badge>
                    )}
                  </Group>
                </SectionCard.Section>
                <SectionCard.Section style={{ flex: 1, minHeight: 0 }}>
                  <Stack gap="sm">
                    <ExpireRow expireAt={data.user.expire_at} />
                    {data.user.description ? (
                      <ScrollArea.Autosize mah={110}>
                        <Text fz="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {data.user.description}
                        </Text>
                      </ScrollArea.Autosize>
                    ) : (
                      <Text c="dimmed" fz="sm">
                        Описание в панели пустое
                      </Text>
                    )}
                  </Stack>
                </SectionCard.Section>
                <SectionCard.Section>
                  <Button
                    fullWidth
                    justify="space-between"
                    leftSection={<TbDevices size={16} />}
                    onClick={() => setDevicesOpen(true)}
                    rightSection={
                      <Badge
                        color={data.hwid.limit && (data.hwid.count ?? 0) >= data.hwid.limit ? 'red' : 'teal'}
                        size="sm"
                        variant="soft"
                      >
                        {data.hwid.count ?? '—'}
                        {data.hwid.limit ? ` / ${data.hwid.limit}` : ''}
                      </Badge>
                    }
                    variant="default"
                  >
                    Устройства HWID
                  </Button>
                </SectionCard.Section>
              </SectionCard.Root>
            </Grid.Col>

            {(data.incidents.length > 0 || data.log.length > 0) && (
              <Grid.Col span={{ base: 12, md: 6 }}>
                <SectionCard.Root gap="sm" h="100%">
                  <SectionCard.Section>
                    <BlockHeader color="violet" icon={<TbHistory size={18} />} title="История" />
                  </SectionCard.Section>
                  <SectionCard.Section>
                    <ScrollArea.Autosize mah={130}>
                      <Stack gap={6}>
                        {data.incidents.map((inc) => (
                          <Group gap="sm" key={`i${inc.id}`} wrap="nowrap">
                            <LevelBadge level={inc.level} score={inc.score} size="sm" />
                            <Text c="dimmed" fz="sm">
                              {new Date(inc.createdAt).toLocaleString('ru-RU')}
                            </Text>
                            <Badge color={inc.status === 'open' ? 'red' : 'gray'} size="sm" variant="soft">
                              {inc.status === 'open' ? 'открыт' : inc.status === 'actioned' ? 'обработан' : 'закрыт'}
                            </Badge>
                          </Group>
                        ))}
                        {data.log.map((l, i) => (
                          <Text c={l.ok ? 'dimmed' : 'red'} fz="sm" key={`l${i}`}>
                            {new Date(l.ts).toLocaleString('ru-RU')} · {ACTION_LABELS[l.action] ?? l.action} ·{' '}
                            {l.source === 'telegram' ? 'Telegram' : 'веб'}
                            {l.error ? ` · ${l.error}` : ''}
                          </Text>
                        ))}
                      </Stack>
                    </ScrollArea.Autosize>
                  </SectionCard.Section>
                </SectionCard.Root>
              </Grid.Col>
            )}
          </Grid>

          {/* IP-адреса — на всю ширину, занимают остаток высоты; скролл только внутри */}
          <Card
            className="rw-section-card"
            p="md"
            radius="md"
            style={isMobile ? undefined : { flex: 1, minHeight: 200, display: 'flex', flexDirection: 'column' }}
            withBorder={false}
          >
            <BlockHeader color="blue" icon={<TbNetwork size={18} />} title="IP-адреса" />

            <Grid gutter={8} mb="sm" mt="sm">
              {(
                [
                  {
                    // как на карточке: отпечаток красится в уровень юзера
                    color: data.score ? { green: 'teal', yellow: 'yellow', orange: 'orange', red: 'red' }[data.score.level] : 'gray',
                    icon: <TbFingerprint size={18} />,
                    value: data.ips.filter((ip) => Date.now() - ip.lastSeen <= (cfg?.uniqueWindowMin ?? 10) * 60_000).length,
                    label: `Уникальные за ${cfg?.uniqueWindowMin ?? 10} мин`,
                    hint: null,
                  },
                  {
                    color: 'teal',
                    icon: <TbWifi size={18} />,
                    value: activeCount,
                    label: `Онлайн IP за ${cfg?.activeWindowMin ?? 5} мин`,
                    hint: null,
                  },
                  {
                    color: 'gray',
                    icon: <TbSum size={18} />,
                    value: data.activePerNode ?? '—',
                    label: `По нодам за ${cfg?.activeWindowMin ?? 5} мин`,
                    hint: 'Один IP на двух нодах считается дважды',
                  },
                  {
                    color: 'indigo',
                    icon: <TbHistory size={18} />,
                    value: data.ips.length,
                    label: 'Всего за историю',
                    hint: `Все уникальные IP за последние ${data.retentionHours ?? 48} часов`,
                  },
                ] as const
              ).map((tile) => {
                const body = (
                  <Group
                    gap="sm"
                    h="100%"
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                      borderRadius: 'var(--mantine-radius-md)',
                      cursor: tile.hint ? 'help' : undefined,
                      padding: '8px 12px',
                    }}
                    wrap="nowrap"
                  >
                    <ThemeIcon color={tile.color} size="lg" variant="soft">
                      {tile.icon}
                    </ThemeIcon>
                    <div>
                      <Text c="white" fw={700} fz="lg" lh={1.1}>
                        {tile.value}
                      </Text>
                      <Text c="dimmed" fz="sm">
                        {tile.label}
                      </Text>
                    </div>
                  </Group>
                );
                return (
                  <Grid.Col key={tile.label} span={{ base: 6, sm: 3 }}>
                    {tile.hint ? (
                      <Tooltip label={tile.hint} radius="md">
                        {body}
                      </Tooltip>
                    ) : (
                      body
                    )}
                  </Grid.Col>
                );
              })}
            </Grid>

            <Divider mb={0} style={{ opacity: 0.3 }} />
            <ScrollArea style={isMobile ? undefined : { flex: 1, minHeight: 0 }} type="auto">
                <Table
                  horizontalSpacing={isMobile ? 'xs' : 'md'}
                  miw={isMobile ? 620 : 760}
                  stickyHeader
                  style={{ tableLayout: 'fixed' }}
                  verticalSpacing={6}
                >
                  <colgroup>
                    <col style={{ width: 44 }} />
                    <col style={{ width: '16%' }} />
                    <col style={{ width: '19%' }} />
                    <col style={{ width: '20%' }} />
                    <col style={{ width: '17%' }} />
                    <col />
                  </colgroup>
                  <Table.Thead style={{ background: 'var(--mantine-color-dark-7)' }}>
                    <Table.Tr>
                      <Table.Th />
                      <SortTh
                        chain={sortChain}
                        hints={['сначала недавние', 'сначала давние']}
                        label="Активность"
                        onToggle={toggleSort}
                        states={['recent', 'oldest']}
                      >
                        <Tooltip label="Показывать только активные сейчас IP">
                          <Switch
                            checked={onlyActive}
                            label="активные"
                            onChange={(e) => setOnlyActive(e.currentTarget.checked)}
                            size="sm"
                            styles={{
                              label: { paddingInlineStart: 6, fontWeight: 400, fontSize: 'var(--mantine-font-size-sm)' },
                            }}
                          />
                        </Tooltip>
                      </SortTh>
                      <SortTh
                        chain={sortChain}
                        hints={['по подсетям /24 — крупные кластеры сверху', 'по возрастанию', 'по убыванию']}
                        label="IP-адрес"
                        onToggle={toggleSort}
                        states={['ip_subnet', 'ip_asc', 'ip_desc']}
                      />
                      <SortTh
                        chain={sortChain}
                        hints={['А - Я', 'Я - А']}
                        label="Нода"
                        onToggle={toggleSort}
                        states={['node_asc', 'node_desc']}
                      />
                      <SortTh
                        chain={sortChain}
                        hints={['А - Я', 'Я - А']}
                        label="Город"
                        onToggle={toggleSort}
                        states={['city_asc', 'city_desc']}
                      />
                      <SortTh
                        chain={sortChain}
                        hints={['А - Я', 'Я - А']}
                        label="Провайдер"
                        onToggle={toggleSort}
                        states={['org_asc', 'org_desc']}
                      />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {visibleIps.map((ip) => {
                      const { color, Icon } = getLastSeenIndicator(ip.lastSeen);
                      const subnet = ip.ip.split('.').slice(0, 3).join('.');
                      const groupColor = subnetColors?.get(subnet);
                      return (
                        <Table.Tr key={ip.ip}>
                          <Table.Td
                            style={groupColor ? { boxShadow: `inset 3px 0 0 var(--mantine-color-${groupColor}-5)` } : undefined}
                            width={36}
                          >
                            <Tooltip label="Проверить IP на ipinfo.io">
                              <ActionIcon
                                color="cyan"
                                component="a"
                                href={`https://ipinfo.io/${ip.ip}`}
                                rel="noopener noreferrer"
                                size="sm"
                                target="_blank"
                                variant="soft"
                              >
                                <TbExternalLink size={13} />
                              </ActionIcon>
                            </Tooltip>
                          </Table.Td>
                          <Table.Td>
                            <Tooltip label={new Date(ip.lastSeen).toLocaleString('ru-RU')}>
                              <Group gap={6} style={{ cursor: 'help' }} wrap="nowrap">
                                <span style={{ display: 'flex', color }}>
                                  <Icon size={16} />
                                </span>
                                <Text c="dimmed" fz={{ base: 'xs', sm: 'sm' }} style={{ whiteSpace: 'nowrap' }}>
                                  {timeAgo(ip.lastSeen)}
                                </Text>
                              </Group>
                            </Tooltip>
                          </Table.Td>
                          <Table.Td>
                            {groupColor ? (
                              <span className="mono">
                                <span style={{ color: `var(--mantine-color-${groupColor}-4)`, fontWeight: 600 }}>
                                  {subnet}.
                                </span>
                                {ip.ip.split('.')[3]}
                              </span>
                            ) : (
                              <span className="mono">{ip.ip}</span>
                            )}
                          </Table.Td>
                          <Table.Td>
                            {(() => {
                              const names = (ip.nodes ?? '').split(',').filter(Boolean);
                              if (names.length === 0)
                                return (
                                  <Text c="dimmed" fz={{ base: 'xs', sm: 'sm' }}>
                                    —
                                  </Text>
                                );
                              const label = (
                                <Text
                                  fz={{ base: 'xs', sm: 'sm' }}
                                  style={{ cursor: names.length > 1 ? 'help' : undefined, whiteSpace: 'nowrap' }}
                                  truncate
                                >
                                  {flagEmoji(nodeCountry.get(names[0]!) ?? null)} {names[0]}
                                  {names.length > 1 && (
                                    <Text c="dimmed" component="span" fw={600} fz="xs">
                                      {' '}
                                      +{names.length - 1}
                                    </Text>
                                  )}
                                </Text>
                              );
                              if (names.length === 1) return label;
                              const full = names
                                .map((n) => `${flagEmoji(nodeCountry.get(n) ?? null)} ${n}`.trim())
                                .join(' · ');
                              return (
                                <Tooltip label={full} radius="md">
                                  {label}
                                </Tooltip>
                              );
                            })()}
                          </Table.Td>
                          <Table.Td>
                            <Text fz={{ base: 'xs', sm: 'sm' }} style={{ whiteSpace: 'nowrap' }} truncate>
                              {flagEmoji(ip.country)} {cleanCity(ip.city) ?? ip.country ?? '—'}
                            </Text>
                          </Table.Td>
                          <Table.Td maw={280}>
                            <Group gap={6} wrap="nowrap">
                              <AsnMark asn={ip.asn} org={ip.asnOrg} />
                              <Text c="dimmed" fz={{ base: 'xs', sm: 'sm' }} truncate>
                                {ip.asnOrg ?? (ip.asn ? `AS${ip.asn}` : '—')}
                              </Text>
                              {ip.isDc === 1 && (
                                <Tooltip label="Датацентр">
                                  <TbBuilding color="var(--mantine-color-red-5)" size={14} style={{ flexShrink: 0 }} />
                                </Tooltip>
                              )}
                            </Group>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
          </Card>

          {/* модалка не листается — футер всегда на виду */}
          <Group justify="flex-end">
            <Menu position="top-end" radius="md" shadow="md" width={240}>
              <Menu.Target>
                <Button leftSection={<TbDotsVertical size={16} />} variant="default">
                  Действия
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {data.user.username} · id {data.user.id}
                </Menu.Label>
                {visibleActions.map((a) => (
                  <Menu.Item
                    color={a.color === 'gray' ? undefined : a.color}
                    key={a.action}
                    leftSection={<a.Icon size={16} />}
                    onClick={() => setConfirm(a)}
                  >
                    {a.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Stack>
      )}

      {/* выдвижная панель устройств — как drawer «Устройства HWID» в Remnawave */}
      <Drawer
        onClose={() => setDevicesOpen(false)}
        opened={devicesOpen}
        position="right"
        size={420}
        title={
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon color="indigo" size="lg" variant="soft">
              <TbDevices size={18} />
            </ThemeIcon>
            <Text fw={700} fz="lg">
              Устройства HWID
            </Text>
            {data && (
              <Badge
                color={data.hwid.limit && (data.hwid.count ?? 0) >= data.hwid.limit ? 'red' : 'teal'}
                size="lg"
                variant="soft"
              >
                {data.hwid.count ?? '—'}
                {data.hwid.limit ? ` / ${data.hwid.limit}` : ''}
              </Badge>
            )}
          </Group>
        }
        zIndex={300}
      >
        {data && (
          <Stack gap="sm" pt="xs">
            {!!data.hwid.limit && (
              <Progress
                color={(data.hwid.count ?? 0) >= data.hwid.limit ? 'red' : 'teal'}
                size="sm"
                value={Math.min(100, ((data.hwid.count ?? 0) / data.hwid.limit) * 100)}
              />
            )}
            {data.hwid.devices.length === 0 ? (
              <Text c="dimmed" fz="sm" py="lg" ta="center">
                Устройств в зеркале пока нет — появятся после ближайшей синхронизации
              </Text>
            ) : (
              data.hwid.devices.map((d, i) => <DeviceCard device={d} index={i} key={d.hwid} />)
            )}
          </Stack>
        )}
      </Drawer>

      <Modal onClose={() => setConfirm(null)} opened={confirm !== null} title={confirm?.label} zIndex={300}>
        <Text mb="lg" size="sm">
          {confirm?.confirm}
        </Text>
        <Group justify="flex-end">
          <Button onClick={() => setConfirm(null)} variant="default">
            Отмена
          </Button>
          <Button
            color={confirm?.color === 'gray' ? 'cyan' : confirm?.color}
            loading={mutation.isPending}
            onClick={() => {
              if (confirm) {
                mutation.mutate(confirm.action);
                setConfirm(null);
              }
            }}
            variant="soft"
          >
            Выполнить
          </Button>
        </Group>
      </Modal>
    </Modal>
  );
}
