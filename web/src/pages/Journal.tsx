import { useState } from 'react';
import { Badge, Center, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { TbHistory } from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { LevelBadge } from '../components/LevelBadge';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';
import { useUserModal } from '../userModal';

const ACTION_LABELS: Record<string, string> = {
  revoke: 'Revoke ключей',
  disable: 'Отключение',
  enable: 'Включение',
  drop: 'Сброс соединений',
  whitelist: 'В белый список',
  unwhitelist: 'Из белого списка',
};

function Empty({ text }: { text: string }) {
  return (
    <Center h={140}>
      <Stack align="center" gap="xs">
        <PiEmptyDuotone color="var(--mantine-color-gray-5)" size="2.5rem" />
        <Text c="dimmed" size="sm">
          {text}
        </Text>
      </Stack>
    </Center>
  );
}

export function Journal() {
  const { openUser } = useUserModal();
  const [tab, setTab] = useState('incidents');
  const [status, setStatus] = useState('open');

  const { data: incidents } = useQuery({
    queryKey: ['incidents', status],
    queryFn: () => api.incidents(status === 'all' ? undefined : status),
    placeholderData: (prev) => prev,
  });
  const { data: log } = useQuery({ queryKey: ['actions-log'], queryFn: api.actionsLog });

  return (
    <>
      <PageHeader
        actions={
          <SegmentedControl
            data={[
              { label: 'Инциденты', value: 'incidents' },
              { label: 'Действия', value: 'actions' },
            ]}
            onChange={setTab}
            value={tab}
          />
        }
        description="История срабатываний и выполненных действий"
        icon={<TbHistory size={24} />}
        title="Журнал"
      />

      {tab === 'incidents' && (
        <Stack gap="md">
          <SegmentedControl
            data={[
              { label: 'Открытые', value: 'open' },
              { label: 'Обработанные', value: 'actioned' },
              { label: 'Закрытые', value: 'ignored' },
              { label: 'Все', value: 'all' },
            ]}
            onChange={setStatus}
            size="xs"
            value={status}
            w="fit-content"
          />
          <SectionCard.Root gap="sm">
            {incidents && incidents.length === 0 && (
              <SectionCard.Section>
                <Empty text="Пусто" />
              </SectionCard.Section>
            )}
            {incidents?.map((inc) => (
              <SectionCard.Section
                key={inc.id}
                onClick={() => openUser(inc.userId)}
                style={{ cursor: 'pointer' }}
              >
                <Group gap="sm" justify="space-between" wrap="wrap">
                  <Group gap="sm" style={{ minWidth: 0 }}>
                    <Text fw={600} fz="sm">
                      {inc.username ?? `id ${inc.userId}`}
                    </Text>
                    <LevelBadge level={inc.level} score={inc.score} size="sm" />
                    <Text c="dimmed" fz="xs">
                      {inc.signals.map((s) => s.label).join(' · ')}
                    </Text>
                  </Group>
                  <Group gap="sm" style={{ flexShrink: 0 }}>
                    <Text c="dimmed" fz="xs">
                      {new Date(inc.createdAt).toLocaleString('ru-RU')}
                    </Text>
                    <Badge
                      color={inc.status === 'open' ? 'red' : inc.status === 'actioned' ? 'teal' : 'gray'}
                      size="sm"
                      variant="soft"
                    >
                      {inc.status === 'open' ? 'открыт' : inc.status === 'actioned' ? 'обработан' : 'закрыт'}
                    </Badge>
                  </Group>
                </Group>
              </SectionCard.Section>
            ))}
          </SectionCard.Root>
        </Stack>
      )}

      {tab === 'actions' && (
        <SectionCard.Root gap="sm">
          {log && log.length === 0 && (
            <SectionCard.Section>
              <Empty text="Действий ещё не было" />
            </SectionCard.Section>
          )}
          {log?.map((l) => (
            <SectionCard.Section
              key={l.id}
              onClick={() => l.userId && openUser(l.userId)}
              style={{ cursor: l.userId ? 'pointer' : 'default' }}
            >
              <Group gap="sm" justify="space-between" wrap="wrap">
                <Group gap="sm">
                  <Badge color={l.ok ? 'teal' : 'red'} size="sm" variant="soft">
                    {ACTION_LABELS[l.action] ?? l.action}
                  </Badge>
                  <Text fw={600} fz="sm">
                    {l.username ?? (l.userId ? `id ${l.userId}` : '—')}
                  </Text>
                  <Text c="dimmed" fz="xs">
                    из {l.source === 'telegram' ? 'Telegram' : 'веб-панели'}
                  </Text>
                  {l.error && (
                    <Text c="red" fz="xs">
                      {l.error}
                    </Text>
                  )}
                </Group>
                <Text c="dimmed" fz="xs">
                  {new Date(l.ts).toLocaleString('ru-RU')}
                </Text>
              </Group>
            </SectionCard.Section>
          ))}
        </SectionCard.Root>
      )}
    </>
  );
}
