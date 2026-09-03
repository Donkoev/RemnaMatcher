import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Menu,
  Modal,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  TbActivity,
  TbArrowsSplit2,
  TbChevronRight,
  TbDotsVertical,
  TbFileImport,
  TbPlus,
  TbRefresh,
  TbSettings,
  TbTrash,
} from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, plural, redApi, timeAgo, type RedSubscription, type RedSubServer } from '../api';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';

// Конфигурации: импорт подписок, как в Happ. Панель качает подписку по URL,
// разбирает серверы (vless/vmess/trojan/ss или JSON-конфиги xray) и показывает
// их в раскладке Happ: флаг · имя+теги · адрес; JSON-балансировщики раскрываются в пул.

// строка тегов под именем: VLESS | WS | TLS | JSON (капс делает CSS)
function tagLine(s: RedSubServer): string {
  const parts = [s.protocol];
  if (s.transport) parts.push(s.transport);
  if (s.security && s.security !== 'none') parts.push(s.security);
  if (s.fromJson) parts.push('json');
  if (s.pool) parts.push(`${s.pool.length} ${plural(s.pool.length, ['сервер', 'сервера', 'серверов'])}`);
  return parts.join(' | ');
}

type PingMap = Record<string, { ok: boolean; latencyMs: number | null; via: 'url' | 'tcp' }>;

/** пинг балансировщика — наименьший из живых замеров его пула */
function bestPoolPing(pool: RedSubServer[], ping: PingMap): PingMap[string] | undefined {
  let best: PingMap[string] | undefined;
  for (const m of pool) {
    const r = m.pool ? bestPoolPing(m.pool, ping) : m.address && m.port ? ping[`${m.address}:${m.port}`] : undefined;
    if (!r) continue;
    if (!best) best = r;
    else if (r.ok && (!best.ok || (r.latencyMs ?? Infinity) < (best.latencyMs ?? Infinity))) best = r;
  }
  return best;
}

function ServerRow({ s, small, ping }: { s: RedSubServer; small?: boolean; ping?: PingMap | null }) {
  const p = s.pool
    ? ping && bestPoolPing(s.pool, ping)
    : s.address && s.port
      ? ping?.[`${s.address}:${s.port}`]
      : undefined;
  return (
    <Group gap="sm" wrap="nowrap">
      <div className={small ? 'rr-flag rr-flag-sm' : 'rr-flag'}>{s.flag ?? '🌐'}</div>
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Text fw={600} fz="sm" truncate="end">
            {s.name}
          </Text>
          {/* значок балансировщика — в конце названия */}
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
      {/* результат пинга: URL-тест через прокси (teal) или TCP-фолбэк (жёлтый, честно) */}
      {p && (
        <Tooltip
          label={
            s.pool
              ? 'Наименьший пинг серверов пула'
              : p.via === 'url'
                ? 'URL-тест: GET generate_204 через этот сервер'
                : 'TCP-коннект до адреса — для URL-теста не хватило данных'
          }
          radius="md"
        >
          <Text
            c={p.ok ? (p.via === 'url' ? 'teal.4' : 'yellow.4') : 'red.4'}
            ff="monospace"
            fw={600}
            fz="xs"
            style={{ flexShrink: 0 }}
          >
            {p.ok ? `${p.latencyMs} мс` : 'н/д'}
          </Text>
        </Tooltip>
      )}
    </Group>
  );
}

// заливка полосы трафика — зеленеет/желтеет/краснеет по мере расхода;
// полупрозрачная, чтобы подпись по центру пилюли оставалась читаемой
function trafficFill(ratio: number): string {
  if (ratio >= 0.9) return 'rgba(250, 82, 82, 0.45)';
  if (ratio >= 0.7) return 'rgba(250, 176, 5, 0.35)';
  return 'rgba(45, 212, 191, 0.3)';
}

/** срок подписки для подписи справа от полосы трафика */
function expireInfo(expireAt: number | null): { text: string; expired: boolean } | null {
  if (!expireAt) return null;
  const diff = expireAt - Date.now();
  if (diff <= 0) return { text: 'истекла', expired: true };
  const days = Math.ceil(diff / 86_400_000);
  return { text: `осталось ${days} ${plural(days, ['день', 'дня', 'дней'])}`, expired: false };
}

function SubscriptionCard({ sub, onDelete }: { sub: RedSubscription; onDelete: () => void }) {
  const qc = useQueryClient();
  // раскрытые пулы балансировщиков (по индексу строки)
  const [openPools, setOpenPools] = useState<Set<number>>(new Set());
  const [opErr, setOpErr] = useState('');
  // результаты пинга серверов, ключ — «address:port»
  const [ping, setPing] = useState<PingMap | null>(null);

  const refresh = useMutation({
    mutationFn: () => redApi.refreshSubscription(sub.id),
    onSuccess: (r) => {
      setOpErr(r.lastError ?? '');
      setPing(null); // список мог смениться — старые замеры больше не о чем
      void qc.invalidateQueries({ queryKey: ['red-subscriptions'] });
    },
    onError: (e) => setOpErr(e instanceof Error ? e.message : 'Ошибка обновления'),
  });

  const pingM = useMutation({
    mutationFn: () => redApi.pingSubscription(sub.id),
    onSuccess: (r) => setPing(r.results),
    onError: (e) => setOpErr(e instanceof Error ? e.message : 'Ошибка пинга'),
  });

  const togglePool = (i: number) =>
    setOpenPools((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const err = opErr || sub.lastError;
  const exp = expireInfo(sub.expireAt);

  return (
    <Card className="rr-server-card" padding="md" radius="md">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon color={sub.servers.length > 0 ? 'red' : 'gray'} radius="md" size="lg" variant="soft">
            <TbFileImport size={20} />
          </ThemeIcon>
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={600} truncate="end">
              {sub.name}
            </Text>
            <Text c="dimmed" ff="monospace" fz="xs" truncate="end">
              {sub.url}
            </Text>
          </Stack>
        </Group>
        <Group gap={4} wrap="nowrap">
          <Tooltip label="Перечитать подписку" radius="md">
            <ActionIcon
              color="red"
              loading={refresh.isPending}
              onClick={() => refresh.mutate()}
              variant="subtle"
            >
              <TbRefresh size={18} />
            </ActionIcon>
          </Tooltip>
          {sub.servers.length > 0 && (
            <Tooltip label="URL-тест: пинг через каждый сервер (GET generate_204)" radius="md">
              <ActionIcon
                color="red"
                loading={pingM.isPending}
                onClick={() => pingM.mutate()}
                variant="subtle"
              >
                <TbActivity size={18} />
              </ActionIcon>
            </Tooltip>
          )}
          <Menu position="bottom-end" shadow="md" width={190}>
            <Menu.Target>
              <ActionIcon color="gray" variant="subtle">
                <TbDotsVertical size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                disabled={refresh.isPending}
                leftSection={<TbRefresh size={15} />}
                onClick={() => refresh.mutate()}
              >
                Обновить
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<TbTrash size={15} />} onClick={onDelete}>
                Удалить подписку
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      {/* трафик из subscription-userinfo — пилюля с подписью по центру, как в Happ */}
      {sub.trafficUsed != null && (
        <Stack gap={4} mb="sm">
          <div className="rr-traffic">
            {sub.trafficTotal != null && sub.trafficTotal > 0 && (
              <div
                className="rr-traffic-fill"
                style={{
                  background: trafficFill(sub.trafficUsed / sub.trafficTotal),
                  width: `${Math.min(100, (sub.trafficUsed / sub.trafficTotal) * 100)}%`,
                }}
              />
            )}
            <div className="rr-traffic-label">
              {formatBytes(sub.trafficUsed)} / {sub.trafficTotal ? formatBytes(sub.trafficTotal) : '∞'}
            </div>
          </div>
          {exp && (
            <Text c={exp.expired ? 'red.4' : 'dimmed'} fz="xs" ta="right">
              {exp.text}
            </Text>
          )}
        </Stack>
      )}

      <Group gap="xs" mb="sm">
        <Badge color={sub.serverCount > 0 ? 'teal' : 'gray'} variant="soft">
          {sub.serverCount} {plural(sub.serverCount, ['сервер', 'сервера', 'серверов'])}
        </Badge>
        <Badge color="gray" variant="soft">
          {sub.updatedAt ? `обновлена ${timeAgo(sub.updatedAt)}` : 'ещё не загружалась'}
        </Badge>
      </Group>

      {err && (
        <Text c="red.4" fz="xs" mb="sm">
          {err}
        </Text>
      )}

      {sub.servers.length > 0 && (
        <ScrollArea.Autosize mah={420} type="auto">
          <Stack gap={6}>
            {sub.servers.map((s, i) =>
              s.pool ? (
                <div key={i}>
                  {/* балансировщик: клик раскрывает пул серверов */}
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
                        <ServerRow ping={ping} s={s} />
                      </div>
                    </Group>
                  </div>
                  {openPools.has(i) && (
                    <div className="rr-pool">
                      {s.pool.map((p, j) => (
                        <div key={j}>
                          <ServerRow ping={ping} s={p} small />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rr-sub-server" key={i}>
                  <ServerRow ping={ping} s={s} />
                </div>
              ),
            )}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </Card>
  );
}

export function RedConfigs() {
  const qc = useQueryClient();
  const { data: subs } = useQuery({ queryKey: ['red-subscriptions'], queryFn: redApi.subscriptions });

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', url: '' });
  const [delTarget, setDelTarget] = useState<RedSubscription | null>(null);
  const [err, setErr] = useState('');

  const add = useMutation({
    mutationFn: () => redApi.addSubscription(form),
    onSuccess: () => {
      setAddOpen(false);
      setForm({ name: '', url: '' });
      void qc.invalidateQueries({ queryKey: ['red-subscriptions'] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Ошибка'),
  });

  const del = useMutation({
    mutationFn: (id: number) => redApi.deleteSubscription(id),
    onSuccess: () => {
      setDelTarget(null);
      void qc.invalidateQueries({ queryKey: ['red-subscriptions'] });
    },
  });

  // настройки импорта: свой HWID вместо авто-выведенного (пусто — авто)
  const { data: settings } = useQuery({ queryKey: ['red-settings'], queryFn: redApi.settings });
  const [hwidOpen, setHwidOpen] = useState(false);
  const [hwidDraft, setHwidDraft] = useState('');
  const [hwidErr, setHwidErr] = useState('');
  const saveHwid = useMutation({
    mutationFn: () => redApi.saveSettings(hwidDraft.trim()),
    onSuccess: () => {
      setHwidOpen(false);
      void qc.invalidateQueries({ queryKey: ['red-settings'] });
    },
    onError: (e) => setHwidErr(e instanceof Error ? e.message : 'Ошибка'),
  });
  const openHwid = () => {
    setHwidDraft(settings?.hwid ?? '');
    setHwidErr('');
    setHwidOpen(true);
  };

  const totalServers = subs?.reduce((n, s) => n + s.serverCount, 0) ?? 0;

  return (
    <>
      <PageHeader
        actions={
          <Group gap="xs" wrap="nowrap">
            <Tooltip label={`Настройки импорта · HWID: ${settings?.hwid || 'авто'}`} radius="md">
              <ActionIcon color="red" onClick={openHwid} size="input-sm" variant="soft">
                <TbSettings size={18} />
              </ActionIcon>
            </Tooltip>
            <Button color="red" leftSection={<TbPlus size={18} />} onClick={() => setAddOpen(true)} variant="soft">
              Добавить подписку
            </Button>
          </Group>
        }
        description="Импорт подписок — панель разбирает серверы, как Happ"
        icon={<TbFileImport size={22} />}
        title="Конфигурации"
      />

      {subs && subs.length > 0 && (
        <Text c="dimmed" fz="sm" mb="md">
          {subs.length} {plural(subs.length, ['подписка', 'подписки', 'подписок'])} · {totalServers}{' '}
          {plural(totalServers, ['сервер', 'сервера', 'серверов'])}
        </Text>
      )}

      {subs && subs.length === 0 ? (
        <SectionCard.Root gap="sm">
          <SectionCard.Section>
            <Center h={220}>
              <Stack align="center" gap="xs">
                <PiEmptyDuotone color="var(--mantine-color-red-5)" size="3rem" />
                <Text c="dimmed" size="sm">
                  Подписок пока нет — импортируй первую
                </Text>
                <Button color="red" leftSection={<TbPlus size={18} />} mt="xs" onClick={() => setAddOpen(true)} variant="soft">
                  Добавить подписку
                </Button>
              </Stack>
            </Center>
          </SectionCard.Section>
        </SectionCard.Root>
      ) : (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" style={{ alignItems: 'start' }}>
          {subs?.map((s) => (
            <SubscriptionCard
              key={s.id}
              onDelete={() => setDelTarget(s)}
              sub={s}
            />
          ))}
        </SimpleGrid>
      )}

      {/* импорт: имя + URL; панель сразу качает и разбирает подписку */}
      <Modal
        centered
        onClose={() => {
          setAddOpen(false);
          setErr('');
        }}
        opened={addOpen}
        title="Импорт подписки"
      >
        <Stack gap="sm">
          <Text c="dimmed" fz="xs">
            Панель скачает подписку по ссылке (представившись Happ) и разберёт список серверов. Поддерживаются ссылки
            vless / vmess / trojan / ss и JSON-конфиги.
          </Text>
          <TextInput
            label="Название"
            description="Необязательно — возьмётся из самой подписки"
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
            placeholder="Моя подписка"
            value={form.name}
          />
          <TextInput
            label="URL подписки"
            onChange={(e) => setForm({ ...form, url: e.currentTarget.value })}
            placeholder="https://sub.example.com/user/…"
            value={form.url}
          />
          {err && (
            <Text c="red.4" fz="sm">
              {err}
            </Text>
          )}
          <Group justify="flex-end" mt="xs">
            <Button color="gray" onClick={() => setAddOpen(false)} variant="subtle">
              Отмена
            </Button>
            <Button
              color="red"
              disabled={!form.url.trim()}
              leftSection={<TbFileImport size={18} />}
              loading={add.isPending}
              variant="soft"
              onClick={() => {
                setErr('');
                add.mutate();
              }}
            >
              Импортировать
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* настройки импорта: HWID, которым панель представляется провайдеру */}
      <Modal centered onClose={() => setHwidOpen(false)} opened={hwidOpen} title="Настройки импорта">
        <Stack gap="sm">
          <Text c="dimmed" fz="xs">
            Панель представляется провайдеру клиентом Happ и шлёт HWID устройства. Свой HWID (например, от реального
            телефона) не займёт у провайдера лишний слот. Пусто — панель выведет стабильный HWID сама. Применяется при
            следующем обновлении подписки.
          </Text>
          <TextInput
            description="Латиница, цифры и дефис, от 4 до 64 символов"
            label="HWID устройства"
            onChange={(e) => setHwidDraft(e.currentTarget.value)}
            placeholder="авто"
            value={hwidDraft}
          />
          {hwidErr && (
            <Text c="red.4" fz="sm">
              {hwidErr}
            </Text>
          )}
          <Group justify="flex-end" mt="xs">
            <Button color="gray" onClick={() => setHwidOpen(false)} variant="subtle">
              Отмена
            </Button>
            <Button
              color="red"
              loading={saveHwid.isPending}
              variant="soft"
              onClick={() => {
                setHwidErr('');
                saveHwid.mutate();
              }}
            >
              Сохранить
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* удаление */}
      <Modal centered onClose={() => setDelTarget(null)} opened={delTarget != null} title="Удалить подписку?">
        <Stack gap="md">
          <Text fz="sm">
            Подписка <b>{delTarget?.name}</b> и разобранный список серверов пропадут из панели.
          </Text>
          <Group justify="flex-end">
            <Button color="gray" onClick={() => setDelTarget(null)} variant="subtle">
              Отмена
            </Button>
            <Button color="red" loading={del.isPending} onClick={() => del.mutate(delTarget!.id)} variant="soft">
              Удалить
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
