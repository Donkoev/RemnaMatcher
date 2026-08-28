import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { TbDeviceMobileOff, TbPlus, TbSearch, TbTrash, TbX } from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hwidApi, timeAgo, type HwidLookupEntry } from '../api';
import { useUserModal } from '../userModal';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';

/** Чёрный список HWID + поиск: в каких подписках светилось устройство */
export function Hwid() {
  const qc = useQueryClient();
  const { openUser } = useUserModal();
  const { data: blacklist } = useQuery({ queryKey: ['hwid-blacklist'], queryFn: hwidApi.blacklist });

  const [manualHwid, setManualHwid] = useState('');
  const [search, setSearch] = useState('');
  const [lookup, setLookup] = useState<{ hwid: string; blacklisted: boolean; entries: HwidLookupEntry[] } | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['hwid-blacklist'] });
  const addMutation = useMutation({
    mutationFn: (hwid: string) => hwidApi.addToBlacklist(hwid),
    onSuccess: () => {
      setManualHwid('');
      invalidate();
    },
  });
  const removeMutation = useMutation({ mutationFn: hwidApi.removeFromBlacklist, onSuccess: invalidate });

  const runLookup = async () => {
    const q = search.trim();
    if (!q) return setLookup(null);
    setLookup(await hwidApi.lookup(q));
  };

  return (
    <>
      <PageHeader
        description="Устройства из чёрного списка при появлении в любой подписке отключают её автоматически"
        icon={<TbDeviceMobileOff size={24} />}
        title="HWID"
      />

      <Stack gap="md" maw={1000}>
        <SectionCard.Root gap="sm">
          <SectionCard.Section>
            <Group justify="space-between" wrap="wrap">
              <Text fw={600} fz="sm">
                Поиск по устройству — в каких подписках светился
              </Text>
              <Group gap="xs" wrap="nowrap">
                <TextInput
                  leftSection={<TbSearch size={15} />}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void runLookup()}
                  placeholder="hwid устройства"
                  rightSection={
                    search ? (
                      <ActionIcon
                        color="gray"
                        onClick={() => {
                          setSearch('');
                          setLookup(null);
                        }}
                        size="sm"
                        variant="subtle"
                      >
                        <TbX size={14} />
                      </ActionIcon>
                    ) : null
                  }
                  size="xs"
                  value={search}
                  w={280}
                />
                <Button onClick={() => void runLookup()} size="xs" variant="soft">
                  Найти
                </Button>
              </Group>
            </Group>
          </SectionCard.Section>
          {lookup && (
            <SectionCard.Section>
              <Group gap="xs" mb="xs">
                <Text className="mono" fz="sm">
                  {lookup.hwid}
                </Text>
                {lookup.blacklisted && (
                  <Badge color="red" size="sm" variant="soft">
                    в чёрном списке
                  </Badge>
                )}
              </Group>
              {lookup.entries.length === 0 ? (
                <Text c="dimmed" fz="sm">
                  Это устройство не встречалось ни в одной подписке
                </Text>
              ) : (
                <Table verticalSpacing={6}>
                  <Table.Tbody>
                    {lookup.entries.map((e) => (
                      <Table.Tr key={`${e.userId}-${e.firstSeen}`}>
                        <Table.Td>
                          <Text c="cyan" fz="sm" onClick={() => openUser(e.userId)} style={{ cursor: 'pointer' }}>
                            {e.username ?? `id ${e.userId}`}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text c="dimmed" fz="sm">
                            {e.deviceModel ?? e.platform ?? '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          {e.deletedAt ? (
                            <Badge color="gray" size="sm" variant="soft">
                              удалено из панели
                            </Badge>
                          ) : e.status === 'DISABLED' ? (
                            <Badge color="red" size="sm" variant="soft">
                              подписка отключена
                            </Badge>
                          ) : (
                            <Badge color="teal" size="sm" variant="soft">
                              активно
                            </Badge>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text c="dimmed" fz="xs">
                            {timeAgo(e.lastSeen)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </SectionCard.Section>
          )}
        </SectionCard.Root>

        <SectionCard.Root gap="sm">
          <SectionCard.Section>
            <Group justify="space-between" wrap="wrap">
              <Text fw={600} fz="sm">
                Чёрный список
              </Text>
              <Group gap="xs" wrap="nowrap">
                <TextInput
                  onChange={(e) => setManualHwid(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Enter' && manualHwid.trim() && addMutation.mutate(manualHwid.trim())}
                  placeholder="добавить hwid вручную"
                  size="xs"
                  value={manualHwid}
                  w={280}
                />
                <Button
                  disabled={!manualHwid.trim()}
                  leftSection={<TbPlus size={14} />}
                  loading={addMutation.isPending}
                  onClick={() => addMutation.mutate(manualHwid.trim())}
                  size="xs"
                  variant="soft"
                >
                  В список
                </Button>
              </Group>
            </Group>
          </SectionCard.Section>
          <SectionCard.Section>
            {!blacklist || blacklist.length === 0 ? (
              <Center h={120}>
                <Stack align="center" gap="xs">
                  <PiEmptyDuotone color="var(--mantine-color-gray-5)" size="2.5rem" />
                  <Text c="dimmed" size="sm">
                    Чёрный список пуст — банить устройства можно из карточки юзера
                  </Text>
                </Stack>
              </Center>
            ) : (
              <Table verticalSpacing={6}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>HWID</Table.Th>
                    <Table.Th>Причина</Table.Th>
                    <Table.Th>Светился в</Table.Th>
                    <Table.Th>Добавлен</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {blacklist.map((b) => (
                    <Table.Tr key={b.hwid}>
                      <Table.Td>
                        <Text
                          c="cyan"
                          className="mono"
                          fz="sm"
                          onClick={() => {
                            setSearch(b.hwid);
                            void hwidApi.lookup(b.hwid).then(setLookup);
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          {b.hwid.length > 40 ? `${b.hwid.slice(0, 40)}…` : b.hwid}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text c="dimmed" fz="sm">
                          {b.sourceUserId ? (
                            <Text
                              c="cyan"
                              component="span"
                              fz="sm"
                              onClick={() => openUser(b.sourceUserId!)}
                              style={{ cursor: 'pointer' }}
                            >
                              {b.sourceUsername ?? `id ${b.sourceUserId}`}
                            </Text>
                          ) : (
                            (b.reason ?? '—')
                          )}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={b.seenIn > 1 ? 'orange' : 'gray'} size="sm" variant="soft">
                          {b.seenIn} подписк{b.seenIn === 1 ? 'е' : 'ах'}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text c="dimmed" fz="xs">
                          {timeAgo(b.addedAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Tooltip label="Убрать из чёрного списка" radius="md">
                          <ActionIcon
                            color="gray"
                            loading={removeMutation.isPending}
                            onClick={() => removeMutation.mutate(b.hwid)}
                            size="sm"
                            variant="subtle"
                          >
                            <TbTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </SectionCard.Section>
        </SectionCard.Root>
      </Stack>
    </>
  );
}
