import { Badge, Center, Group, Stack, Text } from '@mantine/core';
import { TbGavel } from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';
import { useUserModal } from '../userModal';

const ACTION_LABELS: Record<string, string> = {
  revoke: 'Revoke ключей',
  disable: 'Отключение',
  drop: 'Сброс соединений',
};

export function Punished() {
  const { openUser } = useUserModal();
  const { data: lists } = useQuery({ queryKey: ['lists'], queryFn: api.lists });

  return (
    <>
      <PageHeader
        description="Юзеры, к которым применялись меры: revoke, отключение, сброс соединений"
        icon={<TbGavel size={24} />}
        title="Наказанные"
      />

      <SectionCard.Root gap="sm">
        {lists && lists.punished.length === 0 && (
          <SectionCard.Section>
            <Center h={160}>
              <Stack align="center" gap="xs">
                <PiEmptyDuotone color="var(--mantine-color-gray-5)" size="2.5rem" />
                <Text c="dimmed" size="sm">
                  Пока никто не наказан
                </Text>
              </Stack>
            </Center>
          </SectionCard.Section>
        )}
        {lists?.punished.map((p) => (
          <SectionCard.Section key={p.userId} onClick={() => openUser(p.userId)} style={{ cursor: 'pointer' }}>
            <Group gap="sm" justify="space-between" wrap="wrap">
              <Group gap="sm">
                <Text fw={600} fz="sm">
                  {p.username ?? `id ${p.userId}`}
                </Text>
                {p.status === 'DISABLED' && (
                  <Badge color="red" size="sm" variant="soft">
                    отключён
                  </Badge>
                )}
                {(p.actions ?? '')
                  .split(',')
                  .filter(Boolean)
                  .map((a) => (
                    <Badge color="orange" key={a} size="sm" variant="soft">
                      {ACTION_LABELS[a] ?? a}
                    </Badge>
                  ))}
                {p.actionCount > 1 && (
                  <Text c="dimmed" fz="xs">
                    ×{p.actionCount}
                  </Text>
                )}
              </Group>
              <Text c="dimmed" fz="xs">
                {new Date(p.lastTs).toLocaleString('ru-RU')}
              </Text>
            </Group>
          </SectionCard.Section>
        ))}
      </SectionCard.Root>
    </>
  );
}
