import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Group, Modal, Progress, Stack, Text, ThemeIcon } from '@mantine/core';
import { TbCheck, TbCloudDownload, TbRefresh, TbRocket } from 'react-icons/tb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { updateApi } from '../api';

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
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['update-status'],
    queryFn: updateApi.status,
    staleTime: 5 * 60_000,
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
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
      <Stack gap="sm">
        <Group gap="xs">
          <Badge color="gray" size="lg" variant="outline">
            v{data?.current ?? '…'}
          </Badge>
          {data?.updateAvailable && (
            <Badge color="cyan" size="lg" variant="soft">
              доступна v{data.latest}
            </Badge>
          )}
        </Group>
        {!data?.updateAvailable && (
          <Text c="dimmed" fz="sm">
            {data?.pending ? 'Обновление уже запрошено…' : 'Это последняя версия'}
          </Text>
        )}
        <Group gap="xs">
          {data?.updateAvailable && (
            <Button leftSection={<TbRocket size={16} />} onClick={() => void run()} size="xs" variant="soft">
              Обновить
            </Button>
          )}
          <Button
            color="gray"
            leftSection={<TbRefresh size={14} />}
            loading={isFetching}
            onClick={() => void refetch()}
            size="xs"
            variant="subtle"
          >
            Проверить
          </Button>
        </Group>
      </Stack>

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
