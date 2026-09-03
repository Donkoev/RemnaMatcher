import { useMemo } from 'react';
import { Badge, Group, Text, Tooltip } from '@mantine/core';
import { TbChartBar } from 'react-icons/tb';
import { formatBytes, type UserDetail } from '../../api';
import { SectionCard } from '../rw/SectionCard';
import { BlockHeader } from './BlockHeader';

const TRAFFIC_SLOTS = 96;

/** Блок «Потребление трафика»: сумма за сутки, средняя скорость за час и столбики по 15 минут */
export function TrafficCard({ traffic }: { traffic: UserDetail['traffic'] }) {
  const hourlyRate = useMemo(() => {
    if (traffic.length < 2) return null;
    const hourAgo = Date.now() - 3600_000;
    const recent = traffic.filter((t) => t.ts >= hourAgo);
    if (recent.length < 2) return null;
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    if (last.ts === first.ts) return null;
    return Math.max(0, (last.used - first.used) / ((last.ts - first.ts) / 1000));
  }, [traffic]);

  // бары потребления на реальной шкале времени: 96 слотов по 15 минут за сутки,
  // каждый замер ложится в свой слот — пустота слева честно показывает «данных ещё не было»
  const traffic24 = useMemo(() => {
    const slots = new Array<number>(TRAFFIC_SLOTS).fill(0);
    let total = 0;
    const now = Date.now();
    const dayAgo = now - 24 * 3600_000;
    const slotMs = (24 * 3600_000) / TRAFFIC_SLOTS;
    const pts = traffic.filter((t) => t.ts >= dayAgo);
    for (let i = 1; i < pts.length; i++) {
      const bytes = Math.max(0, pts[i]!.used - pts[i - 1]!.used);
      const slot = Math.min(TRAFFIC_SLOTS - 1, Math.max(0, Math.floor((pts[i]!.ts - dayAgo) / slotMs)));
      slots[slot]! += bytes;
      total += bytes;
    }
    return { slots, total, points: pts.length };
  }, [traffic]);

  const maxBar = Math.max(...traffic24.slots, 1);

  return (
    <SectionCard.Root gap="sm" h="100%">
      <SectionCard.Section>
        <Group justify="space-between">
          <BlockHeader color="cyan" icon={<TbChartBar size={18} />} title="Потребление трафика" />
          {hourlyRate !== null && (
            <Tooltip label="Средняя скорость скачивания за последний час">
              <Badge color="cyan" size="sm" variant="soft">
                ≈ {(hourlyRate / 1024 / 1024).toFixed(1)} МБ/с
              </Badge>
            </Tooltip>
          )}
        </Group>
      </SectionCard.Section>
      <SectionCard.Section>
        <Text fw={700} fz="lg" mb={6}>
          {formatBytes(traffic24.total)}{' '}
          <Text c="dimmed" component="span" fw={400} fz="sm">
            скачано за сутки
          </Text>
        </Text>
        {traffic24.points > 1 ? (
          <>
            <svg
              height={64}
              preserveAspectRatio="none"
              style={{ display: 'block' }}
              viewBox={`0 0 ${TRAFFIC_SLOTS * 6} 64`}
              width="100%"
            >
              <line stroke="var(--mantine-color-dark-5)" strokeWidth={1} x1={0} x2={TRAFFIC_SLOTS * 6} y1={63.5} y2={63.5} />
              {traffic24.slots.map((bytes, i) =>
                bytes > 0 ? (
                  <rect
                    fill="var(--mantine-color-cyan-6)"
                    height={Math.max(2, (bytes / maxBar) * 58)}
                    key={i}
                    opacity={0.4 + 0.6 * (bytes / maxBar)}
                    rx={1.5}
                    width={4.4}
                    x={i * 6}
                    y={63 - Math.max(2, (bytes / maxBar) * 58)}
                  />
                ) : null,
              )}
            </svg>
            <Group justify="space-between" mt={2}>
              <Text c="dimmed" fz="sm">
                −24 ч
              </Text>
              <Text c="dimmed" fz="sm">
                −12 ч
              </Text>
              <Text c="dimmed" fz="sm">
                сейчас
              </Text>
            </Group>
          </>
        ) : (
          <Text c="dimmed" fz="sm">
            График накопится за пару часов работы: каждый столбик — сколько юзер скачал за
            15 минут. Постоянная высокая полка = ключом пользуется толпа.
          </Text>
        )}
      </SectionCard.Section>
    </SectionCard.Root>
  );
}
