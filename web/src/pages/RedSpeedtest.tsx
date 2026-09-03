import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Center,
  Checkbox,
  Grid,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  TbActivity,
  TbArrowsDownUp,
  TbArrowsSplit2,
  TbChevronRight,
  TbClockHour3,
  TbDownload,
  TbGauge,
  TbPlayerPlay,
  TbPlayerStop,
  TbServer2,
  TbUpload,
} from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { useQuery } from '@tanstack/react-query';
import {
  formatBytes,
  plural,
  redApi,
  type RedServer,
  type RedSpeedStatus,
  type RedSubServer,
  type RedSubscription,
} from '../api';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';

// Speedtest в три шага: слева выбор сервера подписки (раскладка как в «Конфигурациях» —
// балансировщики раскрываются в пул, видно, из какого конфига сервер), в центре ноды
// (можно несколько — каждая гоняет свой трафик сама), справа живые показатели.
// Замер непрерывный: нода держит постоянную загрузку и отдачу через outbound сервера,
// пока не нажать «Остановить»; страница поллит статус и рисует текущую/пиковую/среднюю
// скорость и прошедший трафик. Без опросов нода сама глушит замер через 30 с.

const POLL_MS = 1500;

interface SelServer {
  subId: number;
  key: string; // «address:port»
  s: RedSubServer;
}

function tagLine(s: RedSubServer): string {
  const parts = [s.protocol];
  if (s.transport) parts.push(s.transport);
  if (s.security && s.security !== 'none') parts.push(s.security);
  if (s.fromJson) parts.push('json');
  if (s.pool) parts.push(`${s.pool.length} ${plural(s.pool.length, ['сервер', 'сервера', 'серверов'])}`);
  return parts.join(' | ');
}

function RowBody({ s, small }: { s: RedSubServer; small?: boolean }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <div className={small ? 'rr-flag rr-flag-sm' : 'rr-flag'}>{s.flag ?? '🌐'}</div>
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Text fw={600} fz="sm" truncate="end">
            {s.name}
          </Text>
          {s.pool && <TbArrowsSplit2 color="var(--mantine-color-red-4)" size={17} style={{ flexShrink: 0 }} />}
        </Group>
        <div className="rr-sub-tags">{tagLine(s)}</div>
      </Stack>
      {s.address && (
        <Text c="dimmed" ff="monospace" fz="xs" style={{ flexShrink: 0 }}>
          {s.address}
          {s.port ? `:${s.port}` : ''}
        </Text>
      )}
    </Group>
  );
}

/** карточка подписки с выбираемыми серверами; балансировщик кликом раскрывает пул */
function PickCard({
  sub,
  sel,
  locked,
  onSelect,
}: {
  sub: RedSubscription;
  sel: SelServer | null;
  locked: boolean;
  onSelect: (s: SelServer) => void;
}) {
  const [openPools, setOpenPools] = useState<Set<number>>(new Set());
  const togglePool = (i: number) =>
    setOpenPools((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const isSel = (s: RedSubServer) => sel?.subId === sub.id && sel.key === `${s.address}:${s.port}`;
  const pick = (s: RedSubServer) => {
    if (locked) return; // пока идёт замер, сервер не переключаем
    if (s.address && s.port != null && s.port > 1) onSelect({ subId: sub.id, key: `${s.address}:${s.port}`, s });
  };

  return (
    <div>
      <Text c="dimmed" fw={600} fz="xs" mb={6} tt="uppercase">
        {sub.name}
      </Text>
      <Stack gap={6}>
        {sub.servers.map((s, i) =>
          s.pool ? (
            <div key={i}>
              {/* балансировщик: замер требует конкретный сервер — клик раскрывает пул */}
              <div className="rr-sub-server rr-sub-server-bal" onClick={() => togglePool(i)}>
                <Group gap="sm" wrap="nowrap">
                  <TbChevronRight
                    className="rr-pool-caret"
                    size={16}
                    style={{
                      flexShrink: 0,
                      transform: openPools.has(i) ? 'rotate(90deg)' : 'none',
                      transition: 'transform 120ms ease',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <RowBody s={s} />
                  </div>
                </Group>
              </div>
              {openPools.has(i) && (
                <div className="rr-pool">
                  {s.pool.map((p, j) => (
                    <div
                      className={`rr-selectable${isSel(p) ? ' rr-pool-sel' : ''}`}
                      key={j}
                      onClick={() => pick(p)}
                    >
                      <RowBody s={p} small />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div
              className={`rr-sub-server rr-selectable${isSel(s) ? ' rr-sub-server-sel' : ''}`}
              key={i}
              onClick={() => pick(s)}
            >
              <RowBody s={s} />
            </div>
          ),
        )}
      </Stack>
    </div>
  );
}

/** скорость: до 1000 — Мбит/с, дальше — Гбит/с (10-гигабитные ноды) */
function fmtSpeed(x: number | null | undefined): { value: string; unit: string } {
  if (x == null) return { value: '—', unit: 'Мбит/с' };
  if (x >= 1000) return { value: (x / 1000).toFixed(2), unit: 'Гбит/с' };
  return { value: x >= 100 ? String(Math.round(x)) : x.toFixed(1), unit: 'Мбит/с' };
}

/** короткая запись для строки «пик · сред» */
function fmtShort(x: number | null | undefined): string {
  if (x == null) return '—';
  if (x >= 1000) return `${(x / 1000).toFixed(1)}G`;
  return x >= 100 ? String(Math.round(x)) : x.toFixed(1);
}

function fmtElapsed(s: number | undefined): string {
  const total = Math.floor(s ?? 0);
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

/** плитка направления: крупное текущее (или среднее после остановки), под ним пик и среднее */
function SpeedTile({
  icon,
  title,
  color,
  running,
  cur,
  peak,
  avg,
  error,
}: {
  icon: React.ReactNode;
  title: string;
  color: string;
  running: boolean;
  cur?: number | null;
  peak?: number | null;
  avg?: number | null;
  error?: string | null;
}) {
  const main = fmtSpeed(running ? (cur ?? avg) : avg);
  // направление стоит (данных нет), а агент запомнил причину — показываем её
  const stalled = error != null && !(running ? cur : avg);
  return (
    <div className="rr-speed-tile">
      <Group gap={6} mb={6} wrap="nowrap">
        <ThemeIcon color={color} radius="sm" size="sm" variant="soft">
          {icon}
        </ThemeIcon>
        <Text c="dimmed" fw={700} fz={10} tt="uppercase">
          {title}
        </Text>
      </Group>
      <Group align="baseline" gap={5} wrap="nowrap">
        <Text c={`${color}.4`} ff="monospace" fw={700} fz={24} lh={1}>
          {main.value}
        </Text>
        <Text c="dimmed" fz={10}>
          {main.unit}
          {running ? '' : ' · сред'}
        </Text>
      </Group>
      {stalled ? (
        <Tooltip label={error} multiline radius="md" w={260}>
          <Text c="red.4" fz={10} lineClamp={1} mt={4}>
            {error}
          </Text>
        </Tooltip>
      ) : (
        <Text c="dimmed" fz={10} mt={4}>
          пик <b>{fmtShort(peak)}</b> · сред <b>{fmtShort(avg)}</b>
        </Text>
      )}
    </div>
  );
}

/** живая карточка результата по одной ноде */
function ResultRow({
  node,
  st,
  startError,
  live,
}: {
  node: RedServer;
  st?: RedSpeedStatus;
  startError?: string;
  live: boolean;
}) {
  const running = live && !!st?.running;
  return (
    <div className="rr-speed-card">
      <Group justify="space-between" mb={st || startError ? 10 : 0} wrap="nowrap">
        <Group gap={8} style={{ minWidth: 0 }} wrap="nowrap">
          <ThemeIcon color="red" radius="sm" size="sm" variant="soft">
            <TbServer2 size={14} />
          </ThemeIcon>
          <Text fw={700} fz="sm" truncate="end">
            {node.name}
          </Text>
          {running ? (
            <Group gap={6} wrap="nowrap">
              <div className="rr-live-dot" />
              <Text c="red.4" fw={700} fz={10} tt="uppercase">
                live
              </Text>
            </Group>
          ) : st ? (
            <Badge color="gray" size="xs" variant="soft">
              остановлен
            </Badge>
          ) : null}
        </Group>
        {st && (
          <Group gap={10} style={{ flexShrink: 0 }} wrap="nowrap">
            {st.pingMs != null && (
              <Group gap={4} wrap="nowrap">
                <TbActivity color="var(--mantine-color-teal-4)" size={13} />
                <Text c="dimmed" ff="monospace" fz="xs">
                  {st.pingMs} мс
                </Text>
              </Group>
            )}
            <Group gap={4} wrap="nowrap">
              <TbClockHour3 color="var(--mantine-color-red-4)" size={13} />
              <Text c="dimmed" ff="monospace" fz="xs">
                {fmtElapsed(st.elapsedS)}
              </Text>
            </Group>
          </Group>
        )}
      </Group>

      {startError ? (
        <Text c="red.4" fz="xs">
          {startError}
        </Text>
      ) : st ? (
        <>
          <SimpleGrid cols={2} spacing={8}>
            <SpeedTile
              avg={st.downAvgMbps}
              color="teal"
              cur={st.downCurrentMbps}
              error={st.downError}
              icon={<TbDownload size={13} />}
              peak={st.downPeakMbps}
              running={running}
              title="Загрузка"
            />
            <SpeedTile
              avg={st.upAvgMbps}
              color="cyan"
              cur={st.upCurrentMbps}
              error={st.upError}
              icon={<TbUpload size={13} />}
              peak={st.upPeakMbps}
              running={running}
              title="Отдача"
            />
          </SimpleGrid>
          <Group gap={6} mt={8} wrap="nowrap">
            <TbArrowsDownUp color="var(--mantine-color-red-4)" size={13} style={{ flexShrink: 0 }} />
            <Text c="dimmed" fz="xs">
              трафик
            </Text>
            <Text ff="monospace" fw={600} fz="xs">
              {formatBytes((st.downBytes ?? 0) + (st.upBytes ?? 0))}
            </Text>
            <Text c="dimmed" fz={10}>
              ↓ {formatBytes(st.downBytes ?? 0)} · ↑ {formatBytes(st.upBytes ?? 0)}
            </Text>
          </Group>
        </>
      ) : live ? (
        <Group gap={6}>
          <Loader color="red" size={12} />
          <Text c="dimmed" fz="xs">
            запускается…
          </Text>
        </Group>
      ) : (
        <Text c="dimmed" fz="xs">
          ожидает запуска
        </Text>
      )}
    </div>
  );
}

export function RedSpeedtest() {
  const { data: subs } = useQuery({ queryKey: ['red-subscriptions'], queryFn: redApi.subscriptions });
  const { data: nodes } = useQuery({ queryKey: ['red-servers'], queryFn: redApi.servers });
  const agents = (nodes ?? []).filter((n) => n.agentReady);

  const [sel, setSel] = useState<SelServer | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [active, setActive] = useState(false);
  const [activeIds, setActiveIds] = useState<number[]>([]);
  const [stats, setStats] = useState<Record<number, RedSpeedStatus>>({});
  const [startErrors, setStartErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false); // запуск/остановка в процессе

  // при первой загрузке отмечаем ноды на связи; выбор пользователя дальше не трогаем
  const preChecked = useRef(false);
  useEffect(() => {
    if (preChecked.current || agents.length === 0) return;
    preChecked.current = true;
    setChecked(new Set(agents.filter((n) => n.agentStatus === 'connected').map((n) => n.id)));
  }, [agents]);

  const toggleNode = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const checkedAgents = agents.filter((n) => checked.has(n.id));

  const startRun = async () => {
    if (!sel || active || busy) return;
    setBusy(true);
    setStats({});
    setStartErrors({});
    const started: number[] = [];
    // ноды независимы — стартуем параллельно
    await Promise.all(
      checkedAgents.map(async (n) => {
        try {
          await redApi.speedtestStart(sel.subId, sel.key, n.id);
          started.push(n.id);
        } catch (e) {
          setStartErrors((p) => ({ ...p, [n.id]: e instanceof Error ? e.message : 'не удалось запустить' }));
        }
      }),
    );
    setActiveIds(started);
    setActive(started.length > 0);
    setBusy(false);
  };

  const stopRun = async () => {
    setBusy(true);
    await Promise.all(
      activeIds.map(async (id) => {
        try {
          const st = await redApi.speedtestStop(id);
          setStats((p) => ({ ...p, [id]: { ...st, running: false } }));
        } catch {
          /* агент недоступен — без опросов он заглушит замер сам */
        }
      }),
    );
    setActive(false);
    setBusy(false);
  };

  // поллинг живых показателей, пока замер идёт
  useEffect(() => {
    if (!active || activeIds.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      let runningCount = 0;
      await Promise.all(
        activeIds.map(async (id) => {
          try {
            const st = await redApi.speedtestStatus(id);
            if (cancelled) return;
            setStats((p) => ({ ...p, [id]: st }));
            if (st.running) runningCount++;
          } catch {
            runningCount++; // временная потеря связи — не гасим замер
          }
        }),
      );
      // все ноды сами остановились (вотчдог/рестарт агента) — выключаем поллинг
      if (!cancelled && runningCount === 0) setActive(false);
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [active, activeIds]);

  // уход со страницы при живом замере — глушим (вотчдог на ноде подстрахует)
  const activeRef = useRef<number[]>([]);
  activeRef.current = active ? activeIds : [];
  useEffect(
    () => () => {
      activeRef.current.forEach((id) => void redApi.speedtestStop(id).catch(() => {}));
    },
    [],
  );

  return (
    <>
      <PageHeader
        description="Непрерывный замер через сервер подписки силами нод — идёт, пока не остановишь"
        icon={<TbGauge size={22} />}
        title="Speedtest"
      />

      {subs && subs.length === 0 ? (
        <SectionCard.Root gap="sm">
          <SectionCard.Section>
            <Center h={220}>
              <Stack align="center" gap="xs">
                <PiEmptyDuotone color="var(--mantine-color-red-5)" size="3rem" />
                <Text c="dimmed" size="sm">
                  Подписок пока нет — импортируй их в «Конфигурациях»
                </Text>
              </Stack>
            </Center>
          </SectionCard.Section>
        </SectionCard.Root>
      ) : (
        <Grid gutter="md">
          {/* шаг 1: сервер подписки — раскладка как в «Конфигурациях» */}
          <Grid.Col span={{ base: 12, lg: 5 }}>
            <Card className="rr-server-card" padding="md" radius="md">
              <Text fw={600} mb="sm">
                Сервер подписки
              </Text>
              <ScrollArea.Autosize mah={560} type="auto">
                <Stack gap="md">
                  {subs?.map((sub) => (
                    <PickCard key={sub.id} locked={active || busy} onSelect={setSel} sel={sel} sub={sub} />
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            </Card>
          </Grid.Col>

          {/* шаг 2: ноды — каждая гоняет свой замер одновременно с другими */}
          <Grid.Col span={{ base: 12, lg: 3 }}>
            <Card className="rr-server-card" padding="md" radius="md">
              <Text fw={600} mb="sm">
                Ноды
              </Text>
              {agents.length === 0 ? (
                <Text c="dimmed" fz="sm">
                  Нет ноды с агентом — подключи сервер в разделе «Серверы»
                </Text>
              ) : (
                <Stack gap="xs">
                  {agents.map((n) => (
                    <Checkbox
                      checked={checked.has(n.id)}
                      color="red"
                      description={n.address}
                      disabled={active || busy}
                      key={n.id}
                      label={
                        <Group gap={6} wrap="nowrap">
                          <Text fw={600} fz="sm">
                            {n.name}
                          </Text>
                          {n.agentStatus !== 'connected' && (
                            <Text c="yellow.4" fz="xs">
                              не на связи
                            </Text>
                          )}
                        </Group>
                      }
                      onChange={() => toggleNode(n.id)}
                      radius="sm"
                    />
                  ))}
                </Stack>
              )}
              {active ? (
                <Button
                  color="red"
                  fullWidth
                  leftSection={<TbPlayerStop size={16} />}
                  loading={busy}
                  mt="md"
                  onClick={() => void stopRun()}
                  variant="filled"
                >
                  Остановить замер
                </Button>
              ) : (
                <Tooltip
                  disabled={sel != null && checkedAgents.length > 0}
                  label={sel == null ? 'Сначала выбери сервер слева' : 'Отметь хотя бы одну ноду'}
                  radius="md"
                >
                  <Button
                    color="red"
                    disabled={sel == null || checkedAgents.length === 0}
                    fullWidth
                    leftSection={<TbPlayerPlay size={16} />}
                    loading={busy}
                    mt="md"
                    onClick={() => void startRun()}
                    variant="soft"
                  >
                    Запустить замер
                  </Button>
                </Tooltip>
              )}
            </Card>
          </Grid.Col>

          {/* шаг 3: живые показатели — текущее/пик/среднее и трафик по каждой ноде */}
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Card className="rr-server-card" padding="md" radius="md">
              <Text fw={600} mb={4}>
                Результаты
              </Text>
              {sel ? (
                <>
                  <Group gap={6} mb="sm" wrap="nowrap">
                    <span style={{ fontSize: 15 }}>{sel.s.flag ?? '🌐'}</span>
                    <Text c="dimmed" fz="xs" truncate="end">
                      {sel.s.name} · {sel.key}
                    </Text>
                  </Group>
                  {checkedAgents.length === 0 ? (
                    <Text c="dimmed" fz="sm">
                      Отметь ноды, которые будут мерить
                    </Text>
                  ) : (
                    <Stack gap={6}>
                      {checkedAgents.map((n) => (
                        <ResultRow
                          key={n.id}
                          live={active && activeIds.includes(n.id)}
                          node={n}
                          st={stats[n.id]}
                          startError={startErrors[n.id]}
                        />
                      ))}
                    </Stack>
                  )}
                </>
              ) : (
                <Text c="dimmed" fz="sm">
                  Выбери сервер слева — здесь появятся живые замеры по нодам
                </Text>
              )}
            </Card>
          </Grid.Col>
        </Grid>
      )}
    </>
  );
}
