import { useState } from 'react';
import { Badge, Box, Drawer, Group, Progress, Stack, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { TbBrandAndroid, TbBrandApple, TbBrandWindows, TbDeviceDesktop, TbDevices } from 'react-icons/tb';
import { PiUserCircle } from 'react-icons/pi';
import { hwidApi, timeAgo, type HwidDeviceInfo, type HwidLookupEntry, type UserDetail } from '../../api';
import { useUserModal } from '../../userModal';
import { CopyableField } from '../rw/CopyableField';
import { SectionCard } from '../rw/SectionCard';

const PLATFORM_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  ios: TbBrandApple,
  macos: TbBrandApple,
  android: TbBrandAndroid,
  windows: TbBrandWindows,
  linux: TbDeviceDesktop,
};

/** статус подписки в раскрытии «ещё в N» — цвет и русская подпись */
const SUB_STATUS: Record<string, { color: string; label: string }> = {
  ACTIVE: { color: 'teal', label: 'активна' },
  DISABLED: { color: 'red', label: 'отключена' },
  EXPIRED: { color: 'gray', label: 'истекла' },
  LIMITED: { color: 'orange', label: 'лимит' },
};

/**
 * Карточка HWID-устройства в стиле панели Remnawave: иконка платформы
 * в soft-квадрате, номер и модель, копируемое поле HWID, пересечения и метка ЧС.
 */
function DeviceCard({ device, index, ownUserId }: { device: HwidDeviceInfo; index: number; ownUserId: number }) {
  const { openUser } = useUserModal();
  const [shared, setShared] = useState<HwidLookupEntry[] | null>(null);
  const Icon = PLATFORM_ICONS[(device.platform ?? '').toLowerCase()] ?? TbDevices;
  return (
    <SectionCard.Root dividerOpacity={0} gap={0} p="sm">
      <SectionCard.Section>
        <Group gap="sm" justify="space-between" wrap="nowrap">
          <Group gap="sm" style={{ minWidth: 0 }} wrap="nowrap">
            <ThemeIcon color={device.blacklisted ? 'red' : 'indigo'} radius="md" size="lg" variant="soft">
              <Icon size={20} />
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
                    // свою же подписку в списке «ещё в N» не показываем
                    void hwidApi.lookup(device.hwid).then((r) => setShared(r.entries.filter((e) => e.userId !== ownUserId)));
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

        <Box mt={10}>
          <CopyableField size="sm" value={device.hwid} />
        </Box>

        {shared && (
          <Stack gap={4} mt={8}>
            {shared.map((e) => (
              <UnstyledButton
                className="rw-device-user-row"
                key={`${e.userId}-${e.firstSeen}`}
                onClick={() => openUser(e.userId)}
              >
                <Group gap="xs" justify="space-between" wrap="nowrap">
                  <Group gap={8} style={{ minWidth: 0 }} wrap="nowrap">
                    <PiUserCircle color="var(--mantine-color-cyan-4)" size={16} style={{ flexShrink: 0 }} />
                    <Text c="white" fw={600} fz="xs" truncate>
                      {e.username ?? `id ${e.userId}`}
                    </Text>
                  </Group>
                  <Group gap={6} style={{ flexShrink: 0 }} wrap="nowrap">
                    {e.deletedAt ? (
                      <Badge color="gray" size="xs" variant="soft">
                        устройство удалено
                      </Badge>
                    ) : (
                      <Badge color={SUB_STATUS[e.status ?? '']?.color ?? 'gray'} size="xs" variant="soft">
                        {SUB_STATUS[e.status ?? '']?.label ?? (e.status?.toLowerCase() ?? '—')}
                      </Badge>
                    )}
                    <Text c="dimmed" fz={11}>
                      {timeAgo(e.lastSeen)}
                    </Text>
                  </Group>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </SectionCard.Section>
    </SectionCard.Root>
  );
}

/** Выдвижная панель устройств — как drawer «Устройства HWID» в Remnawave */
export function DevicesDrawer({ data, opened, onClose }: { data: UserDetail | undefined; opened: boolean; onClose: () => void }) {
  const overLimit = !!data?.hwid.limit && (data.hwid.count ?? 0) >= data.hwid.limit;
  return (
    <Drawer
      onClose={onClose}
      opened={opened}
      position="right"
      size={440}
      title={
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon color="indigo" size="lg" variant="soft">
            <TbDevices size={18} />
          </ThemeIcon>
          <Text fw={700} fz="lg">
            Устройства HWID
          </Text>
          {data && (
            <Badge color={overLimit ? 'red' : 'teal'} size="lg" variant="soft">
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
              color={overLimit ? 'red' : 'teal'}
              size="sm"
              value={Math.min(100, ((data.hwid.count ?? 0) / data.hwid.limit) * 100)}
            />
          )}
          {data.hwid.devices.length === 0 ? (
            <Text c="dimmed" fz="sm" py="lg" ta="center">
              Устройств в зеркале пока нет — появятся после ближайшей синхронизации
            </Text>
          ) : (
            data.hwid.devices.map((d, i) => <DeviceCard device={d} index={i} key={d.hwid} ownUserId={data.user.id} />)
          )}
        </Stack>
      )}
    </Drawer>
  );
}
