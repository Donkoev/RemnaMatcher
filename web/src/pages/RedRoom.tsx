import { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Center,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  TbBolt,
  TbCrosshair,
  TbEyeOff,
  TbFlame,
  TbLock,
  TbSkull,
  TbTarget,
} from 'react-icons/tb';
import { MetricCard } from '../components/rw/MetricCard';
import { RedRoomSkull } from '../components/RedRoomSkull';
import { SectionCard } from '../components/rw/SectionCard';

// Красная комната: скрытый раздел-заглушка (RED_ROOM в .env).
// Пока чистый фронт: макет из мок-данных, наполнение и логика появятся позже.

// Арт заставки: владелец кладёт свою картинку в web/src/assets/redroom-skull.(png|jpg|jpeg|webp) —
// glob подхватит её при сборке; пока файла нет, показывается запасной векторный череп
const skullArt = import.meta.glob('../assets/redroom-skull.{png,jpg,jpeg,webp}', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;
const skullArtUrl = Object.values(skullArt)[0];

// вход-анимация: розжиг с помехами, глитчи арта, живые глаза (~2.5 с), потом створки шлюза
function EntryGate({ onDone }: { onDone: () => void }) {
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const openT = setTimeout(() => setOpening(true), 2500);
    const doneT = setTimeout(onDone, 3300);
    return () => {
      clearTimeout(openT);
      clearTimeout(doneT);
    };
  }, [onDone]);

  const art = { backgroundImage: `url(${skullArtUrl})` };

  return (
    // клик — пропустить заставку и сразу открыть створки
    <div className={`rr-overlay${opening ? ' rr-opening' : ''}`} onClick={() => setOpening(true)}>
      <div className="rr-flash" />
      <div className="rr-door rr-door-top" />
      <div className="rr-door rr-door-bottom" />
      <div className="rr-grain" />
      <div className="rr-splash">
        {skullArtUrl ? (
          <div className="rrp-wrap">
            <div className="rrp-glow" />
            <img alt="" className="rrp-img" src={skullArtUrl} />
            {/* RGB-расслоение: красная и голубая копии вспыхивают сдвинутыми полосами */}
            <div className="rrp-ghost rrp-ghost-r" style={art} />
            <div className="rrp-ghost rrp-ghost-c" style={art} />
            {/* рваные слайсы-помехи */}
            <div className="rrp-slice rrp-slice-a" style={art} />
            <div className="rrp-slice rrp-slice-b" style={art} />
            {/* живые глаза: свечение точно по глазницам арта */}
            <div className="rrp-eye rrp-eye-l" />
            <div className="rrp-eye rrp-eye-r" />
            {/* бегущий скан-луч */}
            <div className="rrp-scanline" />
          </div>
        ) : (
          <RedRoomSkull />
        )}
        <div className="rr-glitch" data-text="КРАСНАЯ КОМНАТА">
          КРАСНАЯ КОМНАТА
        </div>
        <div className="rr-splash-sub">ДОСТУП РАЗРЕШЁН · УРОВЕНЬ 0</div>
      </div>
    </div>
  );
}

// мок-операции для макета
const MOCK_OPS = [
  { name: 'Операция «Гидра»', status: 'в процессе', color: 'red', progress: 64 },
  { name: 'Операция «Невод»', status: 'сбор улик', color: 'orange', progress: 28 },
  { name: 'Операция «Мышеловка»', status: 'ожидание', color: 'gray', progress: 0 },
];

// мок-цели: всё равно размыты заглушкой
const MOCK_TARGETS = [
  { name: 'rs_889041337', note: '3 панели · 41 IP · датацентры', level: 'КРИТ' },
  { name: 'tg_7715026', note: 'перепродажа · 12 устройств', level: 'ВЫСОК' },
  { name: 'rs_102117903', note: 'ботоферма · 6 стран', level: 'ВЫСОК' },
  { name: 'anon_4451', note: 'реселлер · повторник', level: 'СРЕДН' },
];

export function RedRoom() {
  const [entered, setEntered] = useState(false);

  return (
    <>
      {!entered && <EntryGate onDone={() => setEntered(true)} />}

      <div className="red-room">
        <Stack gap="md">
          <Group justify="space-between" wrap="wrap">
            <Group gap="md" wrap="nowrap">
              <ThemeIcon color="red" radius="md" size={48} variant="soft">
                <TbSkull size={30} />
              </ThemeIcon>
              <Stack gap={2}>
                <Group gap="sm">
                  <Title c="red.3" order={2}>
                    Красная комната
                  </Title>
                  <Badge color="red" leftSection={<span className="rr-pulse-dot" />} variant="soft">
                    секретный раздел
                  </Badge>
                </Group>
                <Text c="dimmed" fz="sm">
                  Отдельная панель для спецопераций — пока макет, наполнение обсуждается
                </Text>
              </Stack>
            </Group>
            <Tooltip label="Пока никуда не подключена — исполнительный блок появится позже">
              <Button color="red" leftSection={<TbBolt size={18} />} size="md" variant="filled">
                Красная кнопка
              </Button>
            </Tooltip>
          </Group>

          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="xs">
            <MetricCard icon={<TbTarget size={24} />} iconColor="red" title="Целей под колпаком" value={4} />
            <MetricCard icon={<TbCrosshair size={24} />} iconColor="red" title="Активных операций" value={3} />
            <MetricCard icon={<TbFlame size={24} />} iconColor="orange" title="Ликвидировано" value={0} />
            <MetricCard icon={<TbEyeOff size={24} />} iconColor="gray" title="Режим" value="ТИХИЙ" />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <SectionCard.Root gap="sm">
              <SectionCard.Section>
                <Group gap="sm">
                  <ThemeIcon color="red" size="lg" variant="soft">
                    <TbCrosshair size={18} />
                  </ThemeIcon>
                  <Stack gap={0}>
                    <Title c="white" order={5}>
                      Операции
                    </Title>
                    <Text c="dimmed" fz="xs">
                      Макет — реальных операций ещё нет
                    </Text>
                  </Stack>
                </Group>
              </SectionCard.Section>
              <SectionCard.Section>
                <Stack gap="md">
                  {MOCK_OPS.map((op) => (
                    <Stack gap={6} key={op.name}>
                      <Group justify="space-between">
                        <Text fw={600} fz="sm">
                          {op.name}
                        </Text>
                        <Badge color={op.color} size="sm" variant="soft">
                          {op.status}
                        </Badge>
                      </Group>
                      <Progress color="red" size="sm" value={op.progress} />
                    </Stack>
                  ))}
                </Stack>
              </SectionCard.Section>
            </SectionCard.Root>

            <SectionCard.Root gap="sm">
              <SectionCard.Section>
                <Group gap="sm">
                  <ThemeIcon color="red" size="lg" variant="soft">
                    <TbTarget size={18} />
                  </ThemeIcon>
                  <Stack gap={0}>
                    <Title c="white" order={5}>
                      Цели
                    </Title>
                    <Text c="dimmed" fz="xs">
                      Досье появятся, когда решим, что тут будет
                    </Text>
                  </Stack>
                </Group>
              </SectionCard.Section>
              <SectionCard.Section>
                <Box pos="relative">
                  <Stack className="rr-blur" gap="xs">
                    {MOCK_TARGETS.map((t) => (
                      <Group
                        justify="space-between"
                        key={t.name}
                        px="sm"
                        py={6}
                        style={{
                          border: '1px solid rgba(250, 82, 82, 0.15)',
                          borderRadius: 8,
                        }}
                      >
                        <Stack gap={0}>
                          <Text ff="monospace" fw={600} fz="sm">
                            {t.name}
                          </Text>
                          <Text c="dimmed" fz="xs">
                            {t.note}
                          </Text>
                        </Stack>
                        <Badge color="red" size="sm" variant="outline">
                          {t.level}
                        </Badge>
                      </Group>
                    ))}
                  </Stack>
                  <div className="rr-lock-overlay">
                    <Stack align="center" gap={6}>
                      <TbLock color="var(--mantine-color-red-4)" size={28} />
                      <Text c="red.3" fw={600} fz="sm">
                        Засекречено
                      </Text>
                      <Text c="dimmed" fz="xs">
                        наполнение раздела — следующим этапом
                      </Text>
                    </Stack>
                  </div>
                </Box>
              </SectionCard.Section>
            </SectionCard.Root>
          </SimpleGrid>

          <SectionCard.Root gap="sm">
            <SectionCard.Section>
              <Center h={90}>
                <Stack align="center" gap={4}>
                  <Text c="red.3" ff="monospace" fw={600} fz="sm">
                    [ ЗАРЕЗЕРВИРОВАНО ]
                  </Text>
                  <Text c="dimmed" fz="xs">
                    Здесь встанет главный блок отдельной панели — ждём вводных
                  </Text>
                </Stack>
              </Center>
            </SectionCard.Section>
          </SectionCard.Root>
        </Stack>
      </div>
    </>
  );
}
