import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Group, Modal, Progress, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { TbCheck, TbCloudDownload, TbRefresh, TbRocket, TbVersions } from 'react-icons/tb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { updateApi } from '../api';
import { SectionCard } from './rw/SectionCard';

type Phase = 'idle' | 'requested' | 'restarting' | 'done' | 'failed';

const STEPS: { key: Phase; label: string }[] = [
  { key: 'requested', label: 'Запрос принят — хелпер на сервере подхватит за ~20 секунд' },
  { key: 'restarting', label: 'Скачивание образа и перезапуск (панель ненадолго пропадёт)' },
  { key: 'done', label: 'Готово' },
];

/**
 * Секция «Обновление» в настройках: текущая/доступная версия и кнопка обновления
 * с пошаговым прогрессом в стиле Remnawave. Панель пишет файл-флаг, обновляет хост.
 */
export function UpdateSection() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['update-status'],
    queryFn: updateApi.status,
    staleTime: 5 * 60_000,
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedNow, setCheckedNow] = useState(false);

  // «Проверить» бьёт мимо серверного кэша и даёт видимый результат, даже когда обновлений нет
  const check = async () => {
    setChecking(true);
    try {
      const s = await updateApi.check();
      qc.setQueryData(['update-status'], s);
      setCheckedNow(true);
      setTimeout(() => setCheckedNow(false), 3000);
    } catch {
      // сеть/GitHub недоступны — статус останется прежним
    } finally {
      setChecking(false);
    }
  };
  const startedAt = useRef(0);
  const targetVersion = useRef<string | null>(null);

  // после запроса поллим статус: пока панель перезапускается — fetch падает,
  // как только ответила новой версией — готово
  useEffect(() => {
    if (phase !== 'requested' && phase !== 'restarting') return;
    const t = setInterval(async () => {
      if (Date.now() - startedAt.current > 5 * 60_000) {
        setPhase('failed');
        setError('Обновление затянулось — проверь на сервере: docker logs remnamatcher');
        return;
      }
      try {
        const s = await updateApi.status();
        if (targetVersion.current && s.current === targetVersion.current) {
          setPhase('done');
          void qc.invalidateQueries();
        } else if (!s.pending && phase === 'requested') {
          // флаг подобран хелпером — пошла перезагрузка
          setPhase('restarting');
        }
      } catch {
        // панель перезапускается — это ожидаемо
        setPhase('restarting');
      }
    }, 3000);
    return () => clearInterval(t);
  }, [phase, qc]);

  const run = async () => {
    setError(null);
    startedAt.current = Date.now();
    targetVersion.current = data?.latest ?? null;
    try {
      await updateApi.run();
      setPhase('requested');
    } catch (e) {
      setPhase('failed');
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const stepIndex = phase === 'requested' ? 0 : phase === 'restarting' ? 1 : phase === 'done' ? 2 : -1;
  const modalOpen = phase !== 'idle';

  return (
    <>
      <SectionCard.Root gap="sm" w={{ base: '100%', md: 340 }}>
        <SectionCard.Section>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon color="cyan" size="lg" variant="soft">
              <TbCloudDownload size={18} />
            </ThemeIcon>
            <Title c="white" order={5}>
              Обновление
            </Title>
          </Group>
        </SectionCard.Section>

        <SectionCard.Section>
          <Group gap="md" wrap="nowrap">
            <ThemeIcon color={data?.updateAvailable ? 'cyan' : 'teal'} radius="lg" size="xl" variant="soft">
              <TbVersions size={24} />
            </ThemeIcon>
            <Stack gap={0} miw={0}>
              <Text c="dimmed" fw={500} fz="sm" lh={1.4} style={{ letterSpacing: '0.01em' }}>
                Текущая версия
              </Text>
              <Text c="white" ff="monospace" fw={700} fz="xl" lh={1.2}>
                v{data?.current ?? '…'}
              </Text>
              {data?.updateAvailable ? (
                <Badge color="cyan" mt={6} size="sm" variant="soft">
                  доступна v{data.latest}
                </Badge>
              ) : (
                <Text c={checkedNow ? 'teal' : 'dimmed'} fz="xs">
                  {data?.pending
                    ? 'обновление запрошено…'
                    : data?.latest === null
                      ? 'нет данных о релизах — нажми «Проверить»'
                      : 'установлена последняя'}
                </Text>
              )}
            </Stack>
          </Group>
        </SectionCard.Section>

        <SectionCard.Section>
          <Stack gap="xs">
            {data?.updateAvailable && (
              <Button fullWidth leftSection={<TbRocket size={16} />} onClick={() => void run()} variant="soft">
                Обновить до v{data.latest}
              </Button>
            )}
            <Button
              color={checkedNow ? 'teal' : 'gray'}
              fullWidth
              leftSection={checkedNow ? <TbCheck size={15} /> : <TbRefresh size={15} />}
              loading={checking}
              onClick={() => void check()}
              size="xs"
              variant="default"
            >
              {checkedNow && !data?.updateAvailable ? 'Обновлений нет' : 'Проверить обновления'}
            </Button>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <Modal
        centered
        closeOnClickOutside={phase === 'done' || phase === 'failed'}
        onClose={() => setPhase('idle')}
        opened={modalOpen}
        title={
          <Group gap="sm">
            <TbCloudDownload size={20} />
            <Text fw={700}>Обновление до v{targetVersion.current ?? '?'}</Text>
          </Group>
        }
        withCloseButton={phase === 'done' || phase === 'failed'}
      >
        <Stack gap="md" pt="xs">
          <Progress
            animated={phase !== 'done' && phase !== 'failed'}
            color={phase === 'failed' ? 'red' : phase === 'done' ? 'teal' : 'cyan'}
            radius="xl"
            size="lg"
            striped={phase !== 'done'}
            value={phase === 'done' ? 100 : phase === 'restarting' ? 66 : 33}
          />
          <Stack gap={8}>
            {STEPS.map((s, i) => {
              const state = phase === 'failed' && i > stepIndex ? 'skip' : i < stepIndex ? 'done' : i === stepIndex ? 'active' : 'wait';
              return (
                <Group gap="sm" key={s.key} wrap="nowrap">
                  <ThemeIcon
                    color={state === 'done' || (s.key === 'done' && phase === 'done') ? 'teal' : state === 'active' ? 'cyan' : 'gray'}
                    size="sm"
                    variant="soft"
                  >
                    {state === 'done' || (s.key === 'done' && phase === 'done') ? <TbCheck size={13} /> : <Text fz={10}>{i + 1}</Text>}
                  </ThemeIcon>
                  <Text c={state === 'wait' || state === 'skip' ? 'dimmed' : undefined} fz="sm">
                    {s.label}
                  </Text>
                </Group>
              );
            })}
          </Stack>
          {phase === 'done' && (
            <Button fullWidth onClick={() => window.location.reload()} variant="soft">
              Перезагрузить панель
            </Button>
          )}
          {error && (
            <Text c="red" fz="sm">
              {error}
            </Text>
          )}
        </Stack>
      </Modal>
    </>
  );
}
