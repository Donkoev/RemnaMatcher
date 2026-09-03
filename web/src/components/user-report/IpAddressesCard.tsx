import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Box,
  Card,
  Divider,
  Grid,
  Group,
  ScrollArea,
  Switch,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  TbArrowsSort,
  TbBuilding,
  TbClockCheck,
  TbClockExclamation,
  TbClockPause,
  TbExternalLink,
  TbFingerprint,
  TbHistory,
  TbNetwork,
  TbSitemap,
  TbSortAscending,
  TbSortDescending,
  TbSum,
  TbWifi,
} from 'react-icons/tb';
import { cleanCity, flagEmoji, timeAgo, type ScoringConfig, type UserDetail, type UserIp } from '../../api';
import { AsnMark } from '../AsnMark';
import { BlockHeader } from './BlockHeader';
import { sortIps, subnetOf, type IpSort } from './ipSort';

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

const getLastSeenIndicator = (lastSeen: number) => {
  const diffMinutes = (Date.now() - lastSeen) / 60_000;
  if (diffMinutes <= 5) return { color: 'var(--mantine-color-teal-6)', Icon: TbClockCheck };
  if (diffMinutes <= 60) return { color: 'var(--mantine-color-yellow-6)', Icon: TbClockPause };
  return { color: 'var(--mantine-color-red-6)', Icon: TbClockExclamation };
};

// дефолт по просьбе владельца: только активные, по подсетям, внутри — сначала недавние
const DEFAULT_CHAIN: IpSort[] = ['ip_subnet', 'recent'];

/**
 * Блок «IP-адреса»: плитки-счётчики и таблица с многоуровневой сортировкой.
 * Состояние сортировки живёт здесь — родитель монтирует блок с key по юзеру,
 * чтобы при переходе на другого юзера всё сбрасывалось к дефолту.
 */
export function IpAddressesCard({ data, cfg, isMobile }: { data: UserDetail; cfg: ScoringConfig | undefined; isMobile: boolean }) {
  const [sortChain, setSortChain] = useState<IpSort[]>(DEFAULT_CHAIN);
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

  // «активен» считаем по текущему времени, а не по флагу на момент запроса —
  // иначе при подвисших данных фильтр и часики противоречат друг другу
  const activeWindowMs = (cfg?.activeWindowMin ?? 5) * 60_000;
  const uniqueWindowMs = (cfg?.uniqueWindowMin ?? 10) * 60_000;
  const isIpActive = (ip: UserIp): boolean => Date.now() - ip.lastSeen <= activeWindowMs;
  const activeCount = data.ips.filter(isIpActive).length;

  const visibleIps = useMemo(() => {
    const now = Date.now();
    let list = data.ips;
    if (onlyActive) list = list.filter((ip) => now - ip.lastSeen <= activeWindowMs);
    return sortIps(list, sortChain, now);
  }, [data, onlyActive, sortChain, activeWindowMs]);

  // имя ноды → страна для флага в колонке «Нода»
  const nodeCountry = useMemo(() => new Map(data.nodeCatalog.map((n) => [n.name, n.country])), [data]);

  // в режиме «по подсетям» подсвечиваем РЕАЛЬНЫЕ группы (2+ IP из одной /24) своим цветом
  const subnetColors = useMemo(() => {
    if (!sortChain.includes('ip_subnet')) return null;
    const palette = ['cyan', 'grape', 'orange', 'teal', 'yellow', 'blue', 'pink', 'lime'];
    const counts = new Map<string, number>();
    for (const ip of visibleIps) counts.set(subnetOf(ip.ip), (counts.get(subnetOf(ip.ip)) ?? 0) + 1);
    const colors = new Map<string, string>();
    let i = 0;
    for (const ip of visibleIps) {
      const s = subnetOf(ip.ip);
      if ((counts.get(s) ?? 0) > 1 && !colors.has(s)) colors.set(s, palette[i++ % palette.length]!);
    }
    return colors;
  }, [sortChain, visibleIps]);

  const tiles = [
    {
      // как на карточке: отпечаток красится в уровень юзера
      color: data.score ? { green: 'teal', yellow: 'yellow', orange: 'orange', red: 'red' }[data.score.level] : 'gray',
      icon: <TbFingerprint size={18} />,
      value: data.ips.filter((ip) => Date.now() - ip.lastSeen <= uniqueWindowMs).length,
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
  ] as const;

  return (
    <Card
      className="rw-section-card"
      p="md"
      radius="md"
      style={isMobile ? undefined : { flex: 1, minHeight: 200, display: 'flex', flexDirection: 'column' }}
      withBorder={false}
    >
      <BlockHeader color="blue" icon={<TbNetwork size={18} />} title="IP-адреса" />

      <Grid gutter={8} mb="sm" mt="sm">
        {tiles.map((tile) => {
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
              <SortTh chain={sortChain} hints={['А - Я', 'Я - А']} label="Нода" onToggle={toggleSort} states={['node_asc', 'node_desc']} />
              <SortTh chain={sortChain} hints={['А - Я', 'Я - А']} label="Город" onToggle={toggleSort} states={['city_asc', 'city_desc']} />
              <SortTh chain={sortChain} hints={['А - Я', 'Я - А']} label="Провайдер" onToggle={toggleSort} states={['org_asc', 'org_desc']} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visibleIps.map((ip) => {
              const { color, Icon } = getLastSeenIndicator(ip.lastSeen);
              const subnet = subnetOf(ip.ip);
              const groupColor = subnetColors?.get(subnet);
              const names = (ip.nodes ?? '').split(',').filter(Boolean);
              const nodeLabel = (
                <Text
                  fz={{ base: 'xs', sm: 'sm' }}
                  style={{ cursor: names.length > 1 ? 'help' : undefined, whiteSpace: 'nowrap' }}
                  truncate
                >
                  {flagEmoji(nodeCountry.get(names[0] ?? '') ?? null)} {names[0]}
                  {names.length > 1 && (
                    <Text c="dimmed" component="span" fw={600} fz="xs">
                      {' '}
                      +{names.length - 1}
                    </Text>
                  )}
                </Text>
              );
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
                    {names.length === 0 ? (
                      <Text c="dimmed" fz={{ base: 'xs', sm: 'sm' }}>
                        —
                      </Text>
                    ) : names.length === 1 ? (
                      nodeLabel
                    ) : (
                      <Tooltip
                        label={names.map((n) => `${flagEmoji(nodeCountry.get(n) ?? null)} ${n}`.trim()).join(' · ')}
                        radius="md"
                      >
                        {nodeLabel}
                      </Tooltip>
                    )}
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
  );
}
