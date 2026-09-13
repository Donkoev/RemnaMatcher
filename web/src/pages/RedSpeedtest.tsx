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
  TbCpu,
  TbDownload,
  TbGauge,
  TbPlayerPlay,
  TbPlayerStop,
  TbServer2,
  TbUpload,
} from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatBytes,
  plural,
  redApi,
  type RedServer,
  type RedSpeedNode,
  type RedSpeedSource,
  type RedSubServer,
  type RedSubscription,
} from '../api';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';

// Speedtest в три шага: слева выбор сервера подписки (раскладка как в «Конфигурациях» —
// балансировщики раскрываются в пул, видно, из какого конфига сервер), в центре ноды
// (можно несколько — каждая гоняет свой трафик сама), справа живые показатели.
// Замер непрерывный и принадлежит серверу панели: он сам опрашивает ноды, а страница только
// читает его состояние — её можно обновлять, переключать и закрывать, замер идёт, пока не
// нажать «Остановить». Нода держит потоки загрузки и отдачи сразу по многим источникам и
// отдаёт текущую/устойчивую/пиковую/среднюю скорость, трафик, CPU и разбивку по источникам.

const POLL_MS = 1000;
const IDLE_POLL_MS = 5000; // без замера — редкий опрос: замер могли запустить из другой вкладки
const CPU_HOT = 85; // нода упёрлась в процессор — канал шире, чем показывает замер

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

/** сервер подписки по ключу «address:port» — в пулах балансировщиков тоже */
function findServer(subs: RedSubscription[], subId: number, key: string): RedSubServer | null {
  const walk = (list: RedSubServer[]): RedSubServer | null => {
    for (const s of list) {
      const inPool = s.pool ? walk(s.pool) : null;
      if (inPool) return inPool;
      if (!s.pool && `${s.address}:${s.port}` === key) return s;
    }
    return null;
  };
  const sub = subs.find((x) => x.id === subId);
  return sub ? walk(sub.servers) : null;
}

/** запуск ссылается на сервер, которого в подписке уже нет — показываем хотя бы адрес */
function placeholderServer(key: string): RedSubServer {
  const i = key.lastIndexOf(':');
  const port = Number(key.slice(i + 1));
  return {
    protocol: '',
    name: key,
    flag: null,
    address: i > 0 ? key.slice(0, i) : key,
    port: Number.isFinite(port) ? port : null,
    transport: null,
    security: null,
  };
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

/** короткая запись для строки «10с · пик · сред» и разбивки по источникам */
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

/** плитка направления: крупное текущее (или среднее после остановки), под ним устойчивое за 10 с, пик и среднее */
function SpeedTile({
  icon,
  title,
  color,
  running,
  cur,
  sustained,
  peak,
  avg,
  error,
}: {
  icon: React.ReactNode;
  title: string;
  color: string;
  running: boolean;
  cur?: number | null;
  sustained?: number | null;
  peak?: number | null;
  avg?: number | null;
  error?: string | null;
}) {
  const main = fmtSpeed(running ? (cur ?? sustained ?? avg) : avg);
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
        <Text c="dimmed" fz={10} lineClamp={1} mt={4}>
          10с <b>{fmtShort(sustained)}</b> · пик <b>{fmtShort(peak)}</b> · сред <b>{fmtShort(avg)}</b>
        </Text>
      )}
    </div>
  );
}

/** разбивка по источникам: на каких зеркалах и приёмниках сидят потоки ноды и что они дают */
function SourceList({ sources }: { sources: RedSpeedSource[] }) {
  const [open, setOpen] = useState(true);
  const downs = sources.filter((s) => s.dir === 'down');
  const ups = sources.filter((s) => s.dir === 'up');
  const shown = [...downs.slice(0, 5), ...ups.slice(0, 3)];
  const hidden = sources.length - shown.length;
  return (
    <div className="rr-speed-sources">
      <div className="rr-speed-sources-head" onClick={() => setOpen((v) => !v)}>
        <TbChevronRight
          size={12}
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
        />
        <Text c="dimmed" fw={700} fz={10} tt="uppercase">
          источники · {sources.length}
        </Text>
      </div>
      {open &&
        shown.map((s) => (
          <div className="rr-speed-src" key={`${s.dir}:${s.name}`}>
            {s.dir === 'down' ? (
              <TbDownload color="var(--mantine-color-teal-4)" size={11} style={{ flexShrink: 0 }} />
            ) : (
              <TbUpload color="var(--mantine-color-cyan-4)" size={11} style={{ flexShrink: 0 }} />
            )}
            <Text fz={11} style={{ flex: 1, minWidth: 0 }} truncate="end">
              {s.name}
            </Text>
            {s.error ? (
              <Tooltip label={s.error} multiline radius="md" w={260}>
                <Text c="red.4" fz={10}>
                  пауза
                </Text>
              </Tooltip>
            ) : (
              <Text ff="monospace" fz={11}>
                {fmtShort(s.mbps)}
              </Text>
            )}
            <Text c="dimmed" ff="monospace" fz={10} style={{ width: 26, textAlign: 'right' }}>
              {s.streams > 0 ? `×${s.streams}` : ''}
            </Text>
          </div>
        ))}
      {open && hidden > 0 && (
        <Text c="dimmed" fz={10}>
          ещё {hidden}
        </Text>
      )}
    </div>
  );
}

/** живая карточка результата по одной ноде */
function ResultRow({ node, rn, active }: { node: RedServer; rn?: RedSpeedNode; active: boolean }) {
  const st = rn?.status ?? undefined;
  const running = !!rn?.running;
  const probing = running && st?.phase === 'probe';
  const hotCpu = st?.cpuPct != null && st.cpuPct >= CPU_HOT;
  // заметки агента (fast.com недоступен и т.п.) — кроме той, что уже показана как причина остановки
  const notes = (st?.notes ?? []).filter((n) => n !== rn?.error);
  return (
    <div className="rr-speed-card">
      <Group justify="space-between" mb={st || rn?.error ? 10 : 0} wrap="nowrap">
        <Group gap={8} style={{ minWidth: 0 }} wrap="nowrap">
          <ThemeIcon color="red" radius="sm" size="sm" variant="soft">
            <TbServer2 size={14} />
          </ThemeIcon>
          <Text fw={700} fz="sm" truncate="end">
            {node.name}
          </Text>
          {running ? (
            <Group gap={6} wrap="nowrap">
              {probing ? <Loader color="red" size={10} /> : <div className="rr-live-dot" />}
              <Text c="red.4" fw={700} fz={10} tt="uppercase">
                {probing ? 'проба' : 'live'}
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
              <Tooltip
                label="Задержка запроса через сервер по прогретому соединению: путь до интернета и обратно, не ICMP-пинг"
                multiline
                radius="md"
                w={250}
              >
                <Group gap={4} wrap="nowrap">
                  <TbActivity color="var(--mantine-color-teal-4)" size={13} />
                  <Text c="dimmed" ff="monospace" fz="xs">
                    {st.pingMs} мс
                  </Text>
                </Group>
              </Tooltip>
            )}
            {st.cpuPct != null && (
              <Tooltip
                label={
                  hotCpu ? 'Нода упёрлась в процессор — канал шире, чем показывает замер' : 'Загрузка CPU ноды во время замера'
                }
                multiline
                radius="md"
                w={230}
              >
                <Group gap={4} wrap="nowrap">
                  <TbCpu color={hotCpu ? 'var(--mantine-color-yellow-4)' : 'var(--mantine-color-red-4)'} size={13} />
                  <Text c={hotCpu ? 'yellow.4' : 'dimmed'} ff="monospace" fz="xs">
                    {st.cpuPct}%
                  </Text>
                </Group>
              </Tooltip>
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

      {st ? (
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
              sustained={st.downSustainedMbps}
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
              sustained={st.upSustainedMbps}
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
            {running && st.streamsDown != null && (
              <Text c="dimmed" fz={10} ml="auto" style={{ flexShrink: 0 }}>
                {st.streamsDown}↓ {st.streamsUp ?? 0}↑ пот.
              </Text>
            )}
          </Group>
          {rn?.error && (
            <Text c="red.4" fz={10} mt={4}>
              {rn.error}
            </Text>
          )}
          {notes.map((n) => (
            <Text c="dimmed" fz={10} key={n} mt={2}>
              {n}
            </Text>
          ))}
          {st.sources && st.sources.length > 0 && <SourceList sources={st.sources} />}
        </>
      ) : rn?.error ? (
        <Text c="red.4" fz="xs">
          {rn.error}
        </Text>
      ) : active ? (
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
  const qc = useQueryClient();
  const { data: subs } = useQuery({ queryKey: ['red-subscriptions'], queryFn: redApi.subscriptions });
  const { data: nodes } = useQuery({ queryKey: ['red-servers'], queryFn: redApi.servers });
  // замер живёт на сервере панели: страница читает его состояние и поллит, пока он идёт
  const { data: state } = useQuery({
    queryKey: ['red-speedtest'],
    queryFn: redApi.speedtest,
    refetchInterval: (q) => (q.state.data?.active ? POLL_MS : IDLE_POLL_MS),
  });
  const run = state?.run ?? null;
  const active = state?.active ?? false;
  const agents = (nodes ?? []).filter((n) => n.agentReady);

  const [sel, setSel] = useState<SelServer | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [startError, setStartError] = useState<string | null>(null);

  // при первой загрузке отмечаем ноды на связи; выбор пользователя дальше не трогаем.
  // Если на сервере есть запуск (живой или последний) — его выбор важнее, см. ниже
  const preChecked = useRef(false);
  useEffect(() => {
    if (preChecked.current || agents.length === 0 || state === undefined) return;
    preChecked.current = true;
    if (state.run) return;
    setChecked(new Set(agents.filter((n) => n.agentStatus === 'connected').map((n) => n.id)));
  }, [agents, state]);

  // открыли (или обновили) страницу при живом или недавнем замере — подхватываем его сервер и ноды
  const syncedRun = useRef<number | null>(null);
  useEffect(() => {
    if (!run || !subs || syncedRun.current === run.startedAt) return;
    syncedRun.current = run.startedAt;
    preChecked.current = true;
    setSel({ subId: run.subId, key: run.key, s: findServer(subs, run.subId, run.key) ?? placeholderServer(run.key) });
    setChecked(new Set(run.nodes.map((n) => n.serverId)));
  }, [run, subs]);

  const toggleNode = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const checkedAgents = agents.filter((n) => checked.has(n.id));

  const start = useMutation({
    mutationFn: () => {
      if (!sel) throw new Error('Сначала выбери сервер слева');
      return redApi.speedtestStart({ subId: sel.subId, key: sel.key, serverIds: checkedAgents.map((n) => n.id) });
    },
    onMutate: async () => {
      setStartError(null);
      await qc.cancelQueries({ queryKey: ['red-speedtest'] });
    },
    onSuccess: (s) => qc.setQueryData(['red-speedtest'], s),
    onError: (e) => setStartError(e instanceof Error ? e.message : 'не удалось запустить'),
  });
  const stop = useMutation({
    mutationFn: () => redApi.speedtestStop(),
    // ответ на стоп — итог; опрос, ушедший раньше, не должен его перекрыть
    onMutate: () => qc.cancelQueries({ queryKey: ['red-speedtest'] }),
    onSuccess: (s) => qc.setQueryData(['red-speedtest'], s),
  });
  const busy = start.isPending || stop.isPending;
  const locked = active || busy;

  // результаты показываем для того сервера, который мерился; сменил сервер — ждём нового запуска
  const runMatches = run != null && sel != null && run.subId === sel.subId && run.key === sel.key;
  const rowFor = (id: number) => (runMatches ? run.nodes.find((n) => n.serverId === id) : undefined);

  return (
    <>
      <PageHeader
        description="Непрерывный замер через сервер подписки силами нод — идёт, пока не остановишь, даже если закрыть страницу"
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
                    <PickCard key={sub.id} locked={locked} onSelect={setSel} sel={sel} sub={sub} />
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
                      disabled={locked}
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
                  loading={stop.isPending}
                  mt="md"
                  onClick={() => stop.mutate()}
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
                    loading={start.isPending}
                    mt="md"
                    onClick={() => start.mutate()}
                    variant="soft"
                  >
                    Запустить замер
                  </Button>
                </Tooltip>
              )}
            </Card>
          </Grid.Col>

          {/* шаг 3: живые показатели — текущее/устойчивое/пик/среднее, трафик и источники по каждой ноде */}
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
                  {startError && (
                    <Text c="red.4" fz="xs" mb="sm">
                      {startError}
                    </Text>
                  )}
                  {checkedAgents.length === 0 ? (
                    <Text c="dimmed" fz="sm">
                      Отметь ноды, которые будут мерить
                    </Text>
                  ) : (
                    <Stack gap={6}>
                      {checkedAgents.map((n) => (
                        <ResultRow active={active} key={n.id} node={n} rn={rowFor(n.id)} />
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
