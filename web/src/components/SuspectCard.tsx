import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  TbBan,
  TbDeviceMobileOff,
  TbDotsVertical,
  TbFingerprint,
  TbGavel,
  TbHeart,
  TbPlugOff,
  TbRefreshAlert,
  TbSum,
  TbWifi,
} from 'react-icons/tb';
import { PiUserCircle } from 'react-icons/pi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserModal } from '../userModal';
import { api, flagEmoji, plural, type ActionName, type Level, type Suspect } from '../api';
import { LevelBadge } from './LevelBadge';
import { SectionCard } from './rw/SectionCard';

const LEVEL_COLORS: Record<Level, string> = { green: 'teal', yellow: 'yellow', orange: 'orange', red: 'red' };

const ACTIONS: { action: ActionName; color: string; confirm: string; Icon: React.ComponentType<{ size?: number }>; label: string }[] = [
  {
    action: 'revoke',
    color: 'orange',
    Icon: TbRefreshAlert,
    label: 'Revoke ключей',
    confirm: 'Перегенерировать ключи? Утёкший vless умрёт, легитимный юзер обновится по своей ссылке подписки.',
  },
  {
    action: 'disable',
    color: 'red',
    Icon: TbBan,
    label: 'Отключить',
    confirm: 'Полностью отключить юзера в панели?',
  },
  {
    action: 'drop',
    color: 'blue',
    Icon: TbPlugOff,
    label: 'Сбросить соединения',
    confirm: 'Сбросить все активные соединения юзера на всех нодах?',
  },
  {
    action: 'hwid_ban',
    color: 'red',
    Icon: TbDeviceMobileOff,
    label: 'Забанить устройства',
    confirm:
      'Все HWID-устройства юзера уйдут в чёрный список, подписка отключится. Всплывут в другой подписке — та отключится автоматически.',
  },
  {
    action: 'whitelist',
    color: 'teal',
    Icon: TbHeart,
    label: 'В белый список',
    confirm: 'Добавить в белый список? Уведомления по этому юзеру прекратятся.',
  },
];

export function SuspectCard({ suspect }: { suspect: Suspect }) {
  const qc = useQueryClient();
  const { openUser } = useUserModal();
  const [confirm, setConfirm] = useState<(typeof ACTIONS)[number] | null>(null);

  const mutation = useMutation({
    mutationFn: (action: ActionName) => api.action(action, suspect.userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['suspects'] });
      void qc.invalidateQueries({ queryKey: ['incidents'] });
      void qc.invalidateQueries({ queryKey: ['actions-log'] });
      void qc.invalidateQueries({ queryKey: ['lists'] });
    },
  });

  const totalIps = suspect.nodes.reduce((sum, n) => sum + n.ips.length, 0);
  const levelColor = LEVEL_COLORS[suspect.level];
  const { data: cfg } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const activeWindowMin = cfg?.activeWindowMin ?? 5;

  // все улики — в одном тултипе на цветном бейдже, не текстом на карточке
  const evidenceTooltip = (
    <Stack gap={4} p={4}>
      <Text fw={600} fz="xs">
        {Math.round(suspect.score)} {plural(Math.round(suspect.score), ['очко фрода', 'очка фрода', 'очков фрода'])} ·{' '}
        {suspect.uniqueIps} уникальных IP · {suspect.activeIps} онлайн
      </Text>
      {suspect.signals.map((s) => (
        <Text fz="xs" key={s.key}>
          {s.label}
          <Text c="dimmed" component="span" fz="xs">
            {' — '}
            {s.evidence}
          </Text>
        </Text>
      ))}
      {suspect.signals.length === 0 && (
        <Text c="dimmed" fz="xs">
          Свежих сигналов нет, очки затухают
        </Text>
      )}
    </Stack>
  );

  return (
    <SectionCard.Root dividerOpacity={0} gap="xs">
      {/* шапка в два этажа: имени — вся ширина, счётчикам — своя строка */}
      <SectionCard.Section>
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Tooltip label="Открыть полный отчёт" openDelay={400}>
            <Group
              gap="sm"
              onClick={() => openUser(suspect.userId)}
              style={{ minWidth: 0, cursor: 'pointer' }}
              wrap="nowrap"
            >
              <ThemeIcon color={levelColor} size="lg" variant="soft">
                <PiUserCircle size={20} />
              </ThemeIcon>
              <Title
                c="white"
                order={5}
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {suspect.username ?? String(suspect.userId)}
              </Title>
            </Group>
          </Tooltip>

          <Menu position="bottom-end" radius="md" shadow="md" width={230}>
            <Menu.Target>
              <ActionIcon color="gray" size="lg" style={{ flexShrink: 0 }} variant="subtle">
                <TbDotsVertical size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>
                {suspect.username ?? '—'} · id {suspect.userId}
              </Menu.Label>
              {ACTIONS.map((a) => (
                <Menu.Item
                  color={a.color === 'gray' ? undefined : a.color}
                  key={a.action}
                  leftSection={<a.Icon size={16} />}
                  onClick={() => setConfirm(a)}
                >
                  {a.action === 'whitelist' && suspect.whitelisted ? 'Из белого списка' : a.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </Group>

        <Group gap="xs" justify="space-between" mt={8} wrap="nowrap">
          <Group gap={6} wrap="nowrap">
            <LevelBadge level={suspect.level} score={suspect.score} size="md" tooltip={evidenceTooltip} />
            {suspect.punishedCount > 0 && (
              <Tooltip label={`Уже наказывали: ${suspect.punishedCount} ${plural(suspect.punishedCount, ['действие', 'действия', 'действий'])} в журнале`} radius="md">
                <Badge color="red" size="md" style={{ cursor: 'help', paddingInline: 6 }} variant="outline">
                  <TbGavel size={13} style={{ display: 'block' }} />
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Group gap={6} style={{ flexShrink: 0 }} wrap="nowrap">
            <Tooltip label={`Уникальные IP за последние ${cfg?.uniqueWindowMin ?? 10} минут`} radius="md">
              <Badge color={levelColor} leftSection={<TbFingerprint size={16} />} size="lg" variant="soft">
                {suspect.uniqueIps}
              </Badge>
            </Tooltip>
            <Tooltip label={`Онлайн IP за последние ${activeWindowMin} минут`} radius="md">
              <Badge color="teal" leftSection={<TbWifi size={16} />} size="lg" variant="soft">
                {suspect.activeIps}
              </Badge>
            </Tooltip>
            <Tooltip label={`Всего IP по всем нодам за последние ${activeWindowMin} минут`} radius="md">
              <Badge leftSection={<TbSum size={16} />} size="lg" variant="default">
                {totalIps}
              </Badge>
            </Tooltip>
          </Group>
        </Group>
      </SectionCard.Section>

      {suspect.nodes.length === 0 && (
        <SectionCard.Section>
          <Text c="dimmed" fz="xs" py="xs" ta="center">
            Сейчас нет активных сессий — очки затухают
          </Text>
        </SectionCard.Section>
      )}

      {/* по каждой ноде — только количество IP, сами адреса живут в полном отчёте */}
      {suspect.nodes.length > 0 && (
        <ScrollArea.Autosize mah={400}>
          <Stack gap={6}>
            {suspect.nodes.map((node) => (
              <SectionCard.Root dividerOpacity={0} gap={0} key={node.nodeName} p="sm">
                <SectionCard.Section>
                  <Group justify="space-between" wrap="nowrap">
                    <Group gap="sm" style={{ minWidth: 0 }} wrap="nowrap">
                      <Text fz="1.35em" lh={1}>
                        {flagEmoji(node.nodeCountry)}
                      </Text>
                      <Title c="white" order={6} style={{ whiteSpace: 'nowrap' }}>
                        {node.nodeName}
                      </Title>
                    </Group>
                    <Tooltip label={`${node.ips.length} IP на ноде`} radius="md">
                      <Badge size="lg" style={{ flexShrink: 0 }} variant="default">
                        {node.ips.length}
                      </Badge>
                    </Tooltip>
                  </Group>
                </SectionCard.Section>
              </SectionCard.Root>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}

      <Modal
        centered
        onClose={() => setConfirm(null)}
        opened={confirm !== null}
        title={confirm?.action === 'whitelist' && suspect.whitelisted ? 'Из белого списка' : confirm?.label}
      >
        <Text mb="lg" size="sm">
          {confirm?.action === 'whitelist' && suspect.whitelisted
            ? 'Убрать юзера из белого списка? Проверки и уведомления по нему снова заработают.'
            : confirm?.confirm}
        </Text>
        <Group justify="flex-end">
          <Button onClick={() => setConfirm(null)} variant="default">
            Отмена
          </Button>
          <Button
            color={confirm?.color}
            loading={mutation.isPending}
            onClick={() => {
              if (confirm) {
                mutation.mutate(
                  confirm.action === 'whitelist' && suspect.whitelisted ? 'unwhitelist' : confirm.action,
                );
                setConfirm(null);
              }
            }}
            variant="soft"
          >
            Выполнить
          </Button>
        </Group>
      </Modal>
    </SectionCard.Root>
  );
}
