import { Button, Center, Group, Stack, Text } from '@mantine/core';
import { TbHeart, TbHeartOff } from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';
import { useUserModal } from '../userModal';

export function Whitelist() {
  const { openUser } = useUserModal();
  const qc = useQueryClient();
  const { data: lists } = useQuery({ queryKey: ['lists'], queryFn: api.lists });

  const unwhitelist = useMutation({
    mutationFn: (userId: number) => api.action('unwhitelist', userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lists'] });
      void qc.invalidateQueries({ queryKey: ['suspects'] });
    },
  });

  return (
    <>
      <PageHeader
        description="Доверенные юзеры — уведомления по ним не приходят"
        icon={<TbHeart size={24} />}
        title="Белый список"
      />

      <SectionCard.Root gap="sm">
        {lists && lists.whitelist.length === 0 && (
          <SectionCard.Section>
            <Center h={160}>
              <Stack align="center" gap="xs">
                <PiEmptyDuotone color="var(--mantine-color-gray-5)" size="2.5rem" />
                <Text c="dimmed" size="sm">
                  Белый список пуст — добавляй через ⋮ на карточке или кнопкой в отчёте
                </Text>
              </Stack>
            </Center>
          </SectionCard.Section>
        )}
        {lists?.whitelist.map((w) => (
          <SectionCard.Section key={w.userId}>
            <Group gap="sm" justify="space-between" wrap="wrap">
              <Group gap="sm" onClick={() => openUser(w.userId)} style={{ cursor: 'pointer' }}>
                <Text fw={600} fz="sm">
                  {w.username ?? `id ${w.userId}`}
                </Text>
                <Text c="dimmed" fz="xs">
                  добавлен {new Date(w.addedAt).toLocaleString('ru-RU')}
                </Text>
              </Group>
              <Button
                color="gray"
                leftSection={<TbHeartOff size={14} />}
                loading={unwhitelist.isPending}
                onClick={() => unwhitelist.mutate(w.userId)}
                size="xs"
                variant="soft"
              >
                Убрать
              </Button>
            </Group>
          </SectionCard.Section>
        ))}
      </SectionCard.Root>
    </>
  );
}
