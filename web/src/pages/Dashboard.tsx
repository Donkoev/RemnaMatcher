import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Group,
  LoadingOverlay,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  TbAlertTriangle,
  TbClock,
  TbFingerprint,
  TbNetwork,
  TbRadar2,
  TbRefresh,
  TbSearch,
  TbServer,
  TbX,
} from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { HiFilter } from 'react-icons/hi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, timeAgo } from '../api';
import { MetricCard } from '../components/rw/MetricCard';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';
import { SuspectCard } from '../components/SuspectCard';

// цвет точки уровня в фильтре
const LEVEL_DOT: Record<string, string> = { yellow: 'yellow', orange: 'orange', red: 'red' };

function LevelDot({ level }: { level: string }) {
  return (
    <Box
      component="span"
      h={8}
      style={{
        background: `var(--mantine-color-${LEVEL_DOT[level]}-5)`,
        borderRadius: '50%',
        display: 'inline-block',
        flexShrink: 0,
      }}
      w={8}
    />
  );
}

export function Dashboard() {
  const qc = useQueryClient();
  const [levelFilter, setLevelFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(30);
  const [debouncedSearch] = useDebouncedValue(search, 300);

  // страница переключается мгновенно: сначала рисуем каркас с крутилкой,
  // тяжёлую сетку карточек монтируем следующим кадром
  const [gridReady, setGridReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGridReady(true), 30);
    return () => clearTimeout(t);
  }, []);

  const { data: overview } = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const { data: suspects, isPlaceholderData } = useQuery({
    queryKey: ['suspects', levelFilter, debouncedSearch],
    queryFn: () => api.suspects(levelFilter === 'all' ? undefined : levelFilter, debouncedSearch || undefined),
    placeholderData: (prev) => prev,
  });

  const suspicious =
    (overview?.levels.yellow ?? 0) + (overview?.levels.orange ?? 0) + (overview?.levels.red ?? 0);
  // окно «нода онлайн» приходит с сервера: на панелях с сотнями нод цикл дольше 5 минут
  const nodeWindow = overview?.nodeOnlineWindowMs ?? 300_000;
  const nodesOnline = overview?.nodes.filter((n) => n.last_ok_at && Date.now() - n.last_ok_at < nodeWindow).length ?? 0;
  const nodesTotal = overview?.nodes.length ?? 0;
  const brokenNodes = overview?.nodes.filter((n) => !n.last_ok_at || Date.now() - n.last_ok_at >= nodeWindow) ?? [];
  // человеческая длительность последнего круга опроса
  const cycleText = overview?.lastCycle
    ? overview.lastCycle.durationMs < 10_000
      ? `${(overview.lastCycle.durationMs / 1000).toFixed(1)} с`
      : overview.lastCycle.durationMs < 120_000
        ? `${Math.round(overview.lastCycle.durationMs / 1000)} с`
        : `${(overview.lastCycle.durationMs / 60_000).toFixed(1)} мин`
    : null;

  return (
    <>
      <PageHeader
        actions={
          <Tooltip label="Обновить">
            <ActionIcon color="teal" onClick={() => void qc.invalidateQueries()} size="input-md" variant="soft">
              <TbRefresh size={20} />
            </ActionIcon>
          </Tooltip>
        }
        icon={<TbRadar2 size={24} />}
        title="Обзор"
      />

      <Stack gap="md">
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="xs">
          <MetricCard icon={<TbAlertTriangle size={24} />} iconColor="orange" title="Подозрительных" value={suspicious} />
          <MetricCard
            icon={<TbNetwork size={24} />}
            iconColor="blue"
            title="Активных IP"
            value={overview?.totals.activeIps ?? '—'}
          />
          <MetricCard
            icon={<TbFingerprint size={24} />}
            iconColor="teal"
            title="Уникальные IP"
            value={overview?.totals.uniqueIps ?? '—'}
          />
          <Tooltip
            disabled={!overview}
            label={
              brokenNodes.length > 0
                ? `нет данных: ${brokenNodes.map((n) => n.name).join(', ')}`
                : overview?.lastCycle
                  ? `последний круг опроса занял ${cycleText}, закончился ${timeAgo(overview.lastCycle.at)}`
                  : 'ждём первый опрос'
            }
          >
            <div>
              <MetricCard
                corner={
                  cycleText ? (
                    <Badge color="gray" leftSection={<TbClock size={11} />} size="sm" variant="soft">
                      {cycleText}
                    </Badge>
                  ) : undefined
                }
                icon={<TbServer size={24} />}
                iconColor={nodesOnline < nodesTotal ? 'red' : 'indigo'}
                title="Нод онлайн"
                value={overview ? `${nodesOnline}/${nodesTotal}` : '—'}
              />
            </div>
          </Tooltip>
        </SimpleGrid>

        <Group gap="xs" wrap="nowrap">
          <TextInput
            leftSection={<TbSearch size={16} />}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Поиск по юзеру, id или IP-адресу…"
            rightSection={
              search ? (
                <ActionIcon color="gray" onClick={() => setSearch('')} size="sm" variant="subtle">
                  <TbX size={14} />
                </ActionIcon>
              ) : null
            }
            style={{ flex: 1 }}
            value={search}
          />
          <Select
            allowDeselect={false}
            data={[
              { value: 'all', label: 'Все уровни' },
              { value: 'yellow', label: `Подозрительные · ${overview?.levels.yellow ?? 0}` },
              { value: 'orange', label: `Вероятный фрод · ${overview?.levels.orange ?? 0}` },
              { value: 'red', label: `Фрод · ${overview?.levels.red ?? 0}` },
            ]}
            leftSection={levelFilter === 'all' ? <HiFilter size={16} /> : <LevelDot level={levelFilter} />}
            onChange={(v) => setLevelFilter(v ?? 'all')}
            renderOption={({ option }) => (
              <Group gap="xs" wrap="nowrap">
                {option.value !== 'all' && <LevelDot level={option.value} />}
                <Text fz="sm">{option.label}</Text>
              </Group>
            )}
            value={levelFilter}
            w={210}
          />
        </Group>

        {suspects && suspects.length === 0 ? (
          <SectionCard.Root gap="sm">
            <SectionCard.Section>
              <Center h={200}>
                <Stack align="center" gap="xs">
                  <PiEmptyDuotone color="var(--mantine-color-gray-5)" size="3rem" />
                  <Text c="dimmed" size="sm">
                    Пока чисто — подозрительных юзеров нет
                  </Text>
                </Stack>
              </Center>
            </SectionCard.Section>
          </SectionCard.Root>
        ) : !gridReady ? (
          <Box pos="relative" style={{ minHeight: 320 }}>
            <LoadingOverlay visible />
          </Box>
        ) : (
          <Box pos="relative">
            {/* только при смене фильтра/поиска; zIndex ниже модалки (200), чтобы не наезжать на неё */}
            <LoadingOverlay visible={isPlaceholderData} zIndex={50} />
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4, '3xl': 5 }} spacing="md">
              {suspects?.slice(0, visibleCount).map((s) => <SuspectCard key={s.userId} suspect={s} />)}
            </SimpleGrid>
            {suspects && suspects.length > visibleCount && (
              <Group justify="center" mt="md">
                <Button onClick={() => setVisibleCount((v) => v + 30)} variant="soft">
                  Показать ещё ({suspects.length - visibleCount})
                </Button>
              </Group>
            )}
          </Box>
        )}
      </Stack>
    </>
  );
}
