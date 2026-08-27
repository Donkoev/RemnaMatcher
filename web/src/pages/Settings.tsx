import { useEffect, useState } from 'react';
import { Badge, Button, Flex, Group, NumberInput, PasswordInput, SimpleGrid, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { TbCheck, TbSettings } from 'react-icons/tb';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, authApi, type ScoringConfig } from '../api';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';
import { UpdateSection } from '../components/UpdateSection';

// одинаковая высота под лейбл (до 2 строк) и подсказку — инпуты ряда стоят по одной линии
const alignedField = {
  label: { alignItems: 'flex-end', display: 'flex', minHeight: 46 },
  description: { minHeight: 40 },
} as const;

// смена пароля администратора: после успеха все сессии сбрасываются, кроме текущей
function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setState(null);
    if (next.length < 8) return setState({ ok: false, message: 'Новый пароль — минимум 8 символов' });
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      setState({ ok: true, message: 'Пароль изменён — остальные сессии разлогинены' });
    } catch (e) {
      setState({ ok: false, message: e instanceof Error ? e.message : 'Ошибка' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm">
      <Group align="flex-end" gap="sm" wrap="wrap">
        <PasswordInput
          label="Текущий пароль"
          onChange={(e) => setCurrent(e.currentTarget.value)}
          value={current}
          w={220}
        />
        <PasswordInput
          label="Новый пароль"
          onChange={(e) => setNext(e.currentTarget.value)}
          value={next}
          w={220}
        />
        <Button disabled={!current || !next} loading={busy} onClick={() => void submit()} variant="soft">
          Сменить пароль
        </Button>
      </Group>
      {state && (
        <Text c={state.ok ? 'teal' : 'red'} fz="sm">
          {state.message}
        </Text>
      )}
    </Stack>
  );
}

// цветная точка уровня в лейбле порога — вместо эмодзи-кружка
function LevelLabel({ color, text }: { color: string; text: string }) {
  return (
    <Group component="span" gap={7} wrap="nowrap">
      <span
        style={{
          background: `var(--mantine-color-${color}-5)`,
          borderRadius: '50%',
          display: 'inline-block',
          flexShrink: 0,
          height: 9,
          width: 9,
        }}
      />
      <span>{text}</span>
    </Group>
  );
}

export function Settings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [cfg, setCfg] = useState<ScoringConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data && !cfg) setCfg(data);
  }, [data, cfg]);

  const mutation = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['settings'] });
      setTimeout(() => setSaved(false), 3000);
    },
  });

  if (!cfg) return null;

  return (
    <>
      <PageHeader
        description="Очки фрода, пороги и окна — применяются со следующего цикла, без перезапуска"
        icon={<TbSettings size={24} />}
        title="Настройки"
      />

      <Flex align="flex-start" direction={{ base: 'column-reverse', md: 'row' }} gap="md">
      <SectionCard.Root gap="md" maw={860} style={{ flex: 1 }}>
        <SectionCard.Section>
          <Text fw={600} fz="sm" mb="sm">
            Окна и затухание
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
            <NumberInput
              description="IP активен, пока виден в этом окне"
              label="Окно активности, мин"
              min={1}
              onChange={(v) => setCfg({ ...cfg, activeWindowMin: Number(v) || 1 })}
              value={cfg.activeWindowMin}
            />
            <NumberInput
              description="Для счётчиков уникальных IP"
              label="Окно уникальных, мин"
              min={1}
              onChange={(v) => setCfg({ ...cfg, uniqueWindowMin: Number(v) || 1 })}
              value={cfg.uniqueWindowMin}
            />
            <NumberInput
              description="Очки тают вдвое за это время"
              label="Полураспад очков, ч"
              min={1}
              onChange={(v) => setCfg({ ...cfg, decayHalfLifeHours: Number(v) || 1 })}
              value={cfg.decayHalfLifeHours}
            />
          </SimpleGrid>
        </SectionCard.Section>

        <SectionCard.Section>
          <Text fw={600} fz="sm" mb="sm">
            Сбор данных
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
            <NumberInput
              description="Полный цикл по всем нодам"
              label="Опрос нод, сек"
              min={15}
              onChange={(v) =>
                setCfg({ ...cfg, collector: { ...cfg.collector, pollIntervalSec: Number(v) || 15 } })
              }
              styles={alignedField}
              value={cfg.collector.pollIntervalSec}
            />
            <NumberInput
              decimalScale={2}
              description="Ноды опрашиваются по очереди"
              label="Пауза между нодами, сек"
              min={0}
              onChange={(v) =>
                setCfg({ ...cfg, collector: { ...cfg.collector, nodePollGapMs: Math.round((Number(v) || 0) * 1000) } })
              }
              step={0.5}
              styles={alignedField}
              value={cfg.collector.nodePollGapMs / 1000}
            />
            <NumberInput
              description="Справочник и HWID-лимиты"
              label="Синхронизация пользователей, сек"
              min={60}
              onChange={(v) =>
                setCfg({ ...cfg, collector: { ...cfg.collector, userSyncIntervalSec: Number(v) || 60 } })
              }
              styles={alignedField}
              value={cfg.collector.userSyncIntervalSec}
            />
            <NumberInput
              description="Всё, что старше, удаляется"
              label="Хранение данных, ч"
              min={6}
              onChange={(v) =>
                setCfg({ ...cfg, collector: { ...cfg.collector, retentionHours: Number(v) || 6 } })
              }
              styles={alignedField}
              value={cfg.collector.retentionHours}
            />
          </SimpleGrid>
        </SectionCard.Section>

        <SectionCard.Section>
          <Text fw={600} fz="sm" mb="sm">
            Пороги уровней
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
            <NumberInput
              description="Подозрительный"
              label={<LevelLabel color="yellow" text="Жёлтый порог" />}
              min={1}
              onChange={(v) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, yellow: Number(v) || 1 } })}
              value={cfg.thresholds.yellow}
            />
            <NumberInput
              description="Вероятный фрод, алерт в TG"
              label={<LevelLabel color="orange" text="Оранжевый порог" />}
              min={1}
              onChange={(v) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, orange: Number(v) || 1 } })}
              value={cfg.thresholds.orange}
            />
            <NumberInput
              description="Фрод"
              label={<LevelLabel color="red" text="Красный порог" />}
              min={1}
              onChange={(v) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, red: Number(v) || 1 } })}
              value={cfg.thresholds.red}
            />
          </SimpleGrid>
        </SectionCard.Section>

        <SectionCard.Section>
          <Text fw={600} fz="sm" mb="sm">
            Проверки — в порядке приоритета
          </Text>
          <Stack gap="sm">
            <Group justify="space-between" wrap="nowrap">
              <Switch
                checked={cfg.signals.ipCount.enabled}
                description="Главный сигнал: порог персональный — HWID-лимит юзера × запас на устройство; «от N IP» — для юзеров без лимита"
                label="Много одновременных IP"
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    signals: { ...cfg.signals, ipCount: { ...cfg.signals.ipCount, enabled: e.currentTarget.checked } },
                  })
                }
              />
              {/* сдвиг вверх на полвысоты подписей «с HWID/без HWID»: сами поля и баллы — по центру блока */}
              <Group align="center" gap="xs" style={{ marginTop: -20 }} wrap="nowrap">
                <div>
                  <Text c="dimmed" fw={500} fz={11} mb={2} ta="center">
                    с HWID
                  </Text>
                  <Tooltip label="Запас IP на одно устройство (смена Wi-Fi/LTE даёт несколько IP)">
                    <NumberInput
                      decimalScale={1}
                      min={1}
                      onChange={(v) =>
                        setCfg({
                          ...cfg,
                          signals: {
                            ...cfg.signals,
                            ipCount: { ...cfg.signals.ipCount, perDeviceIps: Number(v) || 1 },
                          },
                        })
                      }
                      prefix="× "
                      size="xs"
                      step={0.5}
                      suffix=" / устр."
                      value={cfg.signals.ipCount.perDeviceIps}
                      w={110}
                    />
                  </Tooltip>
                </div>
                <div>
                  <Text c="dimmed" fw={500} fz={11} mb={2} ta="center">
                    без HWID
                  </Text>
                  <Tooltip label="Запасной порог для юзеров без HWID-лимита">
                    <NumberInput
                      min={2}
                      onChange={(v) =>
                        setCfg({
                          ...cfg,
                          signals: { ...cfg.signals, ipCount: { ...cfg.signals.ipCount, minIps: Number(v) || 2 } },
                        })
                      }
                      prefix="от "
                      size="xs"
                      suffix=" IP"
                      value={cfg.signals.ipCount.minIps}
                      w={110}
                    />
                  </Tooltip>
                </div>
                <div>
                  {/* фантомный заголовок — бейдж встаёт на одну линию с полями ввода */}
                  <Text fw={500} fz={11} mb={2}>
                    {' '}
                  </Text>
                  <div style={{ alignItems: 'center', display: 'flex', height: 30 }}>
                    <Tooltip label="Очки фрода за срабатывание">
                      <Badge color="red" size="sm" style={{ flexShrink: 0, width: 64, justifyContent: 'center' }} variant="soft">
                        +40–60
                      </Badge>
                    </Tooltip>
                  </div>
                </div>
              </Group>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Switch
                checked={cfg.signals.trafficRate.enabled}
                description="Средняя скорость за час выше порога, выше двойного — усиленный"
                label="Всплеск трафика"
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    signals: { ...cfg.signals, trafficRate: { enabled: e.currentTarget.checked } },
                  })
                }
              />
              <Group gap="xs" wrap="nowrap">
                <Tooltip label="Порог средней скорости за час">
                  <NumberInput
                    min={0}
                    onChange={(v) => setCfg({ ...cfg, trafficRateBps: Math.round((Number(v) || 0) * 1024 * 1024) })}
                    prefix="от "
                    size="xs"
                    step={0.5}
                    suffix=" МБ/с"
                    value={Math.round((cfg.trafficRateBps / 1024 / 1024) * 10) / 10}
                    w={110}
                  />
                </Tooltip>
                <Tooltip label="Очки фрода за срабатывание">
                  <Badge color="orange" size="sm" style={{ flexShrink: 0, width: 64, justifyContent: 'center' }} variant="soft">
                    +30–55
                  </Badge>
                </Tooltip>
              </Group>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Switch
                checked={cfg.signals.multiAsn.enabled}
                description="Проверяется только при превышении порога числа IP (персонального или общего)"
                label="Одновременно с разных провайдеров"
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    signals: { ...cfg.signals, multiAsn: { ...cfg.signals.multiAsn, enabled: e.currentTarget.checked } },
                  })
                }
              />
              <Group gap="xs" wrap="nowrap">
                <Tooltip label="Меньше этого числа ASN — не сигнал">
                  <NumberInput
                    min={2}
                    onChange={(v) =>
                      setCfg({
                        ...cfg,
                        signals: { ...cfg.signals, multiAsn: { ...cfg.signals.multiAsn, minAsns: Number(v) || 2 } },
                      })
                    }
                    prefix="от "
                    size="xs"
                    suffix=" ASN"
                    value={cfg.signals.multiAsn.minAsns}
                    w={110}
                  />
                </Tooltip>
                <Tooltip label="Очки фрода за срабатывание">
                  <Badge color="yellow" size="sm" style={{ flexShrink: 0, width: 64, justifyContent: 'center' }} variant="soft">
                    +25–50
                  </Badge>
                </Tooltip>
              </Group>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Switch
                checked={cfg.signals.multiCountry.enabled}
                description="Слабый сигнал: друзья могут быть и за границей"
                label="Одновременно из разных стран"
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    signals: { ...cfg.signals, multiCountry: { enabled: e.currentTarget.checked } },
                  })
                }
              />
              <Tooltip label="Очки фрода за срабатывание">
                <Badge color="lime" size="sm" style={{ flexShrink: 0, width: 64, justifyContent: 'center' }} variant="soft">
                  +15–30
                </Badge>
              </Tooltip>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Switch
                checked={cfg.signals.datacenter.enabled}
                description="У обычного юзера не бывает IP хостингов"
                label="Подключения из датацентров"
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    signals: { ...cfg.signals, datacenter: { enabled: e.currentTarget.checked } },
                  })
                }
              />
              <Tooltip label="Очки фрода за срабатывание">
                <Badge color="cyan" size="sm" style={{ flexShrink: 0, width: 64, justifyContent: 'center' }} variant="soft">
                  +20–35
                </Badge>
              </Tooltip>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Switch
                checked={cfg.signals.torrent.enabled}
                description="Блокировки встроенным торрент-блокером панели"
                label="Ловится торрент-блокером"
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    signals: { ...cfg.signals, torrent: { enabled: e.currentTarget.checked } },
                  })
                }
              />
              <Tooltip label="Очки фрода за срабатывание">
                <Badge color="gray" size="sm" style={{ flexShrink: 0, width: 64, justifyContent: 'center' }} variant="soft">
                  +10–20
                </Badge>
              </Tooltip>
            </Group>
          </Stack>
        </SectionCard.Section>

        <SectionCard.Section>
          <Text fw={600} fz="sm" mb="sm">
            Уведомления
          </Text>
          <Group justify="space-between" wrap="nowrap">
            <Switch
              checked={cfg.telegramAlertsEnabled}
              description="Алерты и дайджесты; кнопки в боте продолжат работать"
              label="Уведомления в Telegram"
              onChange={(e) => setCfg({ ...cfg, telegramAlertsEnabled: e.currentTarget.checked })}
            />
            <Tooltip label="Кулдаун: не чаще одного алерта на юзера, если уровень не вырос">
              <NumberInput
                disabled={!cfg.telegramAlertsEnabled}
                min={0}
                onChange={(v) => setCfg({ ...cfg, alertCooldownHours: Number(v) || 0 })}
                prefix="раз в "
                size="xs"
                suffix=" ч"
                value={cfg.alertCooldownHours}
                w={110}
              />
            </Tooltip>
          </Group>
        </SectionCard.Section>

        <SectionCard.Section>
          <Text fw={600} fz="sm" mb="sm">
            Безопасность
          </Text>
          <PasswordSection />
        </SectionCard.Section>

        <SectionCard.Section>
          <Group>
            <Button
              color={saved ? 'teal' : 'cyan'}
              leftSection={saved ? <TbCheck size={16} /> : undefined}
              loading={mutation.isPending}
              onClick={() => mutation.mutate(cfg)}
              variant="soft"
            >
              {saved ? 'Сохранено' : 'Сохранить'}
            </Button>
          </Group>
        </SectionCard.Section>
      </SectionCard.Root>

      {/* обновление — отдельной карточкой справа, чтобы не раздувать основной блок */}
      <SectionCard.Root gap="sm" w={{ base: '100%', md: 300 }}>
        <SectionCard.Section>
          <Text fw={600} fz="sm" mb="sm">
            Обновление
          </Text>
          <UpdateSection />
        </SectionCard.Section>
      </SectionCard.Root>
      </Flex>
    </>
  );
}
