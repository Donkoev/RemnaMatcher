import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Grid,
  Group,
  LoadingOverlay,
  Menu,
  Modal,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { TbBan, TbCalendarTime, TbCheck, TbDevices, TbDotsVertical, TbGavel, TbHistory, TbNotes } from 'react-icons/tb';
import { PiUserCircle } from 'react-icons/pi';
import { useMediaQuery } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, plural, type ActionName } from '../api';
import { LevelBadge } from './LevelBadge';
import { SectionCard } from './rw/SectionCard';
import { USER_ACTIONS, type ActionDef } from './userActions';
import { BlockHeader } from './user-report/BlockHeader';
import { ChecksCard } from './user-report/ChecksCard';
import { DevicesDrawer } from './user-report/DevicesDrawer';
import { IpAddressesCard } from './user-report/IpAddressesCard';
import { TrafficCard } from './user-report/TrafficCard';

const ACTION_LABELS: Record<string, string> = {
  revoke: 'Revoke',
  disable: 'Отключение',
  enable: 'Включение',
  drop: 'Сброс соединений',
  whitelist: 'В белый список',
  unwhitelist: 'Из белого списка',
  hwid_ban: 'HWID-бан',
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
 * Отчёт по юзеру — только антифрод-данные, которых НЕТ в панели Remnawave.
 * Раскладка: сетка компактных блоков сверху (2×2), IP-адреса — вниз на всю ширину.
 * Тяжёлые блоки живут в components/user-report/: проверки, трафик, IP-таблица, устройства.
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

  useEffect(() => {
    setContentReady(false);
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

  const hwidOverLimit = !!data?.hwid.limit && (data.hwid.count ?? 0) >= data.hwid.limit;

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
            {data.punished.count > 0 && (
              <Tooltip
                label={`${(data.punished.actions ?? '')
                  .split(',')
                  .map((a) => ACTION_LABELS[a] ?? a)
                  .join(', ')} · последнее ${data.punished.lastTs ? new Date(data.punished.lastTs).toLocaleString('ru-RU') : ''}`}
                radius="md"
              >
                <Badge
                  color="red"
                  leftSection={<TbGavel size={13} />}
                  size="md"
                  style={{ cursor: 'help' }}
                  variant="outline"
                >
                  наказывали ×{data.punished.count}
                </Badge>
              </Tooltip>
            )}
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
              <ChecksCard cfg={cfg} score={data.score} />
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <TrafficCard traffic={data.traffic} />
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <SectionCard.Root gap="sm" h="100%">
                <SectionCard.Section>
                  <Group justify="space-between" wrap="nowrap">
                    <BlockHeader color="teal" icon={<TbNotes size={18} />} title="Описание" />
                    {data.user.tag && (
                      <Badge color="cyan" size="md" variant="soft">
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
                      <Badge color={hwidOverLimit ? 'red' : 'teal'} size="sm" variant="soft">
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
                    {/* строки фикс-высоты 24 + gap 8, окно кратно шагу — обрезка всегда по границе строки */}
                    <ScrollArea.Autosize mah={152}>
                      <Stack gap={8}>
                        {data.incidents.map((inc) => (
                          <Group gap="sm" h={24} key={`i${inc.id}`} wrap="nowrap">
                            <LevelBadge level={inc.level} score={inc.score} size="sm" />
                            <Text c="dimmed" fz="sm" style={{ whiteSpace: 'nowrap' }}>
                              {new Date(inc.createdAt).toLocaleString('ru-RU')}
                            </Text>
                            <Badge color={inc.status === 'open' ? 'red' : 'gray'} size="sm" variant="soft">
                              {inc.status === 'open' ? 'открыт' : inc.status === 'actioned' ? 'обработан' : 'закрыт'}
                            </Badge>
                          </Group>
                        ))}
                        {data.log.map((l, i) => (
                          <Group gap="sm" h={24} key={`l${i}`} wrap="nowrap">
                            <Text c={l.ok ? 'dimmed' : 'red'} fz="sm" truncate>
                              {new Date(l.ts).toLocaleString('ru-RU')} · {ACTION_LABELS[l.action] ?? l.action} ·{' '}
                              {l.source === 'telegram' ? 'Telegram' : 'веб'}
                              {l.error ? ` · ${l.error}` : ''}
                            </Text>
                          </Group>
                        ))}
                      </Stack>
                    </ScrollArea.Autosize>
                  </SectionCard.Section>
                </SectionCard.Root>
              </Grid.Col>
            )}
          </Grid>

          {/* IP-адреса — на всю ширину, занимают остаток высоты; key по юзеру сбрасывает сортировку */}
          <IpAddressesCard cfg={cfg} data={data} isMobile={isMobile ?? false} key={data.user.id} />

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

      <DevicesDrawer data={data} onClose={() => setDevicesOpen(false)} opened={devicesOpen} />

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
