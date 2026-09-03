import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Checkbox,
  Code,
  Group,
  Menu,
  Modal,
  NumberInput,
  PasswordInput,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  TbCpu,
  TbDatabase,
  TbDeviceDesktop,
  TbDotsVertical,
  TbPlugConnected,
  TbPlus,
  TbCloudUpload,
  TbReload,
  TbServer2,
  TbServerBolt,
  TbTrash,
} from 'react-icons/tb';
import { PiEmptyDuotone } from 'react-icons/pi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { redApi, timeAgo, type RedInstallJob, type RedServer } from '../api';
import { PageHeader } from '../components/rw/PageHeader';
import { SectionCard } from '../components/rw/SectionCard';

// цвет и подпись статуса агента
const AGENT_META: Record<RedServer['agentStatus'], { color: string; label: string }> = {
  none: { color: 'gray', label: 'не установлен' },
  installing: { color: 'yellow', label: 'установка…' },
  connected: { color: 'teal', label: 'подключён' },
  error: { color: 'red', label: 'ошибка' },
};

function SpecRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Group gap={8} wrap="nowrap">
      <ThemeIcon color="gray" size="sm" variant="transparent">
        {icon}
      </ThemeIcon>
      <Text c="dimmed" fz="xs" style={{ minWidth: 52 }}>
        {label}
      </Text>
      <Text fz="xs" truncate="end">
        {value}
      </Text>
    </Group>
  );
}

function ServerCard({
  server,
  onReinstall,
  onDelete,
}: {
  server: RedServer;
  onDelete: () => void;
  onReinstall: () => void;
}) {
  const qc = useQueryClient();
  const online = server.status === 'online';
  const agent = AGENT_META[server.agentStatus];
  // ошибка последней операции с карточки (обновление агента) — иначе она падала молча
  const [opErr, setOpErr] = useState('');

  const updateAgent = useMutation({
    mutationFn: () => redApi.updateAgent(server.id),
    onSuccess: () => {
      setOpErr('');
      void qc.invalidateQueries({ queryKey: ['red-servers'] });
    },
    onError: (e) => {
      setOpErr(e instanceof Error ? e.message : 'Ошибка обновления агента');
      void qc.invalidateQueries({ queryKey: ['red-servers'] });
    },
  });

  return (
    <Card className="rr-server-card" padding="md" radius="md">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon color={online ? 'red' : 'gray'} radius="md" size="lg" variant="soft">
            <TbServer2 size={20} />
          </ThemeIcon>
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={600} truncate="end">
              {server.name}
            </Text>
            <Text c="dimmed" ff="monospace" fz="xs" truncate="end">
              {server.sshUser}@{server.address}:{server.port}
            </Text>
          </Stack>
        </Group>
        <Menu position="bottom-end" shadow="md" width={190}>
          <Menu.Target>
            <ActionIcon color="gray" variant="subtle">
              <TbDotsVertical size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {server.agentReady && (
              <Menu.Item
                disabled={updateAgent.isPending}
                leftSection={<TbCloudUpload size={15} />}
                onClick={() => updateAgent.mutate()}
              >
                {updateAgent.isPending ? 'Обновляю…' : 'Обновить агента'}
              </Menu.Item>
            )}
            <Menu.Item leftSection={<TbReload size={15} />} onClick={onReinstall}>
              Переустановить агента
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<TbTrash size={15} />} onClick={onDelete}>
              Удалить сервер
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Group gap="xs" mb="sm">
        <Badge
          color={online ? 'teal' : server.status === 'never' ? 'gray' : 'red'}
          leftSection={<span className={online ? 'rr-dot rr-dot-on' : 'rr-dot'} />}
          variant="soft"
        >
          {online ? 'в сети' : server.status === 'never' ? 'нет данных' : 'офлайн'}
        </Badge>
        <Badge color={agent.color} variant="soft">
          агент: {agent.label}
        </Badge>
        {server.agentReady && server.agentStatus !== 'installing' && !server.tls && (
          <Tooltip label="Агент старой установки отвечает по открытому HTTP — переустанови его, чтобы включить TLS" radius="md">
            <Badge color="orange" style={{ cursor: 'help' }} variant="soft">
              без TLS
            </Badge>
          </Tooltip>
        )}
        {online && server.latencyMs != null && (
          <Badge color="gray" variant="soft">
            {server.latencyMs} мс
          </Badge>
        )}
      </Group>

      {(opErr || (server.agentStatus === 'error' && server.lastError)) && (
        <Text c="red.4" fz="xs" mb="sm">
          {opErr || server.lastError}
        </Text>
      )}

      <Stack gap={4}>
        <SpecRow icon={<TbDeviceDesktop size={15} />} label="ОС" value={server.os ?? '—'} />
        <SpecRow
          icon={<TbCpu size={15} />}
          label="CPU"
          value={server.cpu ? `${server.cpu}${server.cores ? ` · ${server.cores} ядер` : ''}` : '—'}
        />
        <SpecRow
          icon={<TbServerBolt size={15} />}
          label="RAM"
          value={server.memMb ? `${(server.memMb / 1024).toFixed(1)} ГБ` : '—'}
        />
        <SpecRow icon={<TbDatabase size={15} />} label="Диск" value={server.diskFree ? `${server.diskFree} свободно` : '—'} />
      </Stack>

      <Text c="dimmed" fz="xs" mt="sm">
        {server.lastCheckAt ? `проверен ${timeAgo(server.lastCheckAt)}` : 'ещё не проверялся'}
      </Text>
    </Card>
  );
}

// живой лог установки: поллит install-log, пока job.done не станет true
function InstallLog({ serverId }: { serverId: number }) {
  const qc = useQueryClient();
  const [job, setJob] = useState<RedInstallJob | null>(null);
  // лог живёт в памяти сервера: если панель перезапустилась — он пропал, поллить вечно нельзя
  const [lost, setLost] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    let fails = 0;
    const poll = async () => {
      try {
        const j = await redApi.installLog(serverId);
        if (stop) return;
        fails = 0;
        setJob(j);
        if (j.done) {
          void qc.invalidateQueries({ queryKey: ['red-servers'] });
          return;
        }
      } catch {
        if (stop) return;
        if (++fails >= 4) {
          setLost(true);
          void qc.invalidateQueries({ queryKey: ['red-servers'] });
          return;
        }
      }
      if (!stop) setTimeout(() => void poll(), 700);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [serverId, qc]);

  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: 'smooth' });
  }, [job?.lines.length]);

  return (
    <Stack gap="sm">
      <ScrollArea.Autosize mah={260} type="auto" viewportRef={viewport}>
        <Code block style={{ background: 'rgba(0,0,0,0.4)' }}>
          {(job?.lines ?? ['Запускаю установку…']).join('\n')}
        </Code>
      </ScrollArea.Autosize>
      {job?.done && (
        <Badge color={job.ok ? 'teal' : 'red'} size="lg" variant="soft">
          {job.ok ? 'Готово — сервер подключён' : 'Установка не удалась'}
        </Badge>
      )}
      {lost && (
        <Text c="red.4" fz="sm">
          Лог установки недоступен — похоже, панель перезапускалась во время установки. Запусти переустановку ноды.
        </Text>
      )}
    </Stack>
  );
}

export function RedServers() {
  const qc = useQueryClient();
  const { data: servers } = useQuery({
    queryKey: ['red-servers'],
    queryFn: redApi.servers,
    // страница живёт сама: поллер на сервере меряет ноды раз в 5с, фронт подтягивает так же
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.agentStatus === 'installing') ? 2000 : 5000,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', address: '', port: 22, username: 'root', password: '' });
  const [installId, setInstallId] = useState<number | null>(null);
  const [reinstall, setReinstall] = useState<RedServer | null>(null);
  const [reinstallPw, setReinstallPw] = useState('');
  const [acceptHostKey, setAcceptHostKey] = useState(false);
  const [delTarget, setDelTarget] = useState<RedServer | null>(null);
  const [err, setErr] = useState('');

  const add = useMutation({
    mutationFn: () => redApi.addServer(form),
    onSuccess: (r) => {
      setAddOpen(false);
      setInstallId(r.id);
      setForm({ name: '', address: '', port: 22, username: 'root', password: '' });
      void qc.invalidateQueries({ queryKey: ['red-servers'] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Ошибка'),
  });

  const reinstallM = useMutation({
    mutationFn: (v: { id: number; password?: string; acceptNewHostKey?: boolean }) =>
      redApi.reinstall(v.id, v.password, v.acceptNewHostKey),
    onSuccess: (r) => {
      setReinstall(null);
      setReinstallPw('');
      setAcceptHostKey(false);
      setInstallId(r.id);
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Ошибка'),
  });

  const del = useMutation({
    mutationFn: (id: number) => redApi.deleteServer(id),
    onSuccess: () => {
      setDelTarget(null);
      void qc.invalidateQueries({ queryKey: ['red-servers'] });
    },
  });

  const online = servers?.filter((s) => s.status === 'online').length ?? 0;

  return (
    <>
      <PageHeader
        actions={
          <Button color="red" leftSection={<TbPlus size={18} />} onClick={() => setAddOpen(true)} variant="soft">
            Добавить сервер
          </Button>
        }
        description="Узлы — панель ставит их сама по SSH"
        icon={<TbServer2 size={22} />}
        title="Серверы"
      />

      {servers && servers.length > 0 && (
        <Text c="dimmed" fz="sm" mb="md">
          {servers.length} серверов · {online} в сети
        </Text>
      )}

      {servers && servers.length === 0 ? (
        <SectionCard.Root gap="sm">
          <SectionCard.Section>
            <Center h={220}>
              <Stack align="center" gap="xs">
                <PiEmptyDuotone color="var(--mantine-color-red-5)" size="3rem" />
                <Text c="dimmed" size="sm">
                  Серверов пока нет — добавь первый
                </Text>
                <Button color="red" leftSection={<TbPlus size={18} />} mt="xs" onClick={() => setAddOpen(true)} variant="soft">
                  Добавить сервер
                </Button>
              </Stack>
            </Center>
          </SectionCard.Section>
        </SectionCard.Root>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {servers?.map((s) => (
            <ServerCard
              key={s.id}
              onDelete={() => setDelTarget(s)}
              onReinstall={() => setReinstall(s)}
              server={s}
            />
          ))}
        </SimpleGrid>
      )}

      {/* добавление: SSH-креды + установка */}
      <Modal
        centered
        onClose={() => {
          setAddOpen(false);
          setErr('');
        }}
        opened={addOpen}
        title="Новый сервер контура"
      >
        <Stack gap="sm">
          <Text c="dimmed" fz="xs">
            Панель зайдёт по SSH и установит ноду сама. Пароль хранится только в панели в зашифрованном виде — переустановка не потребует повторного ввода.
          </Text>
          <TextInput
            label="Название"
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
            placeholder="Амстердам-1"
            value={form.name}
          />
          <Group align="flex-end" gap="sm" grow>
            <TextInput
              label="Адрес (IP или домен)"
              onChange={(e) => setForm({ ...form, address: e.currentTarget.value })}
              placeholder="45.140.0.10"
              value={form.address}
            />
            <NumberInput
              label="SSH-порт"
              max={65535}
              min={1}
              onChange={(v) => setForm({ ...form, port: Number(v) || 22 })}
              style={{ maxWidth: 110 }}
              value={form.port}
            />
          </Group>
          <Group align="flex-end" gap="sm" grow>
            <TextInput
              label="SSH-логин"
              onChange={(e) => setForm({ ...form, username: e.currentTarget.value })}
              placeholder="root"
              value={form.username}
            />
            <PasswordInput
              label="SSH-пароль"
              onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
              value={form.password}
            />
          </Group>
          {err && (
            <Text c="red.4" fz="sm">
              {err}
            </Text>
          )}
          <Group justify="flex-end" mt="xs">
            <Button color="gray" onClick={() => setAddOpen(false)} variant="subtle">
              Отмена
            </Button>
            <Button
              color="red"
              disabled={!form.name || !form.address || !form.password}
              leftSection={<TbPlugConnected size={18} />}
              loading={add.isPending}
              variant="soft"
              onClick={() => {
                setErr('');
                add.mutate();
              }}
            >
              Подключить и установить
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* живой лог установки */}
      <Modal
        centered
        onClose={() => setInstallId(null)}
        opened={installId != null}
        size="lg"
        title="Установка ноды"
      >
        {installId != null && <InstallLog serverId={installId} />}
      </Modal>

      {/* переустановка: подтверждение одним кликом; пароль спрашиваем, только если не сохранён */}
      <Modal
        centered
        onClose={() => {
          setReinstall(null);
          setReinstallPw('');
          setAcceptHostKey(false);
          setErr('');
        }}
        opened={reinstall != null}
        title="Переустановить агента"
      >
        <Stack gap="sm">
          <Text c="dimmed" fz="sm">
            {reinstall?.name} · {reinstall?.sshUser}@{reinstall?.address}. Панель зайдёт по SSH, снесёт старого агента и развернёт заново, начисто.
            {reinstall?.hasPass ? ' Пароль сохранён — вводить ничего не нужно.' : ''}
          </Text>
          {!reinstall?.hasPass && (
            <PasswordInput
              label="SSH-пароль"
              onChange={(e) => setReinstallPw(e.currentTarget.value)}
              value={reinstallPw}
            />
          )}
          {reinstall?.hostKeyChanged && (
            <Checkbox
              checked={acceptHostKey}
              color="red"
              description="Ключ хоста SSH не совпал с запомненным. Ставь галочку, только если сервер переустанавливали — иначе пароль уйдёт тому, кто подменил сервер"
              label="Сервер переустанавливали — принять новый ключ хоста"
              onChange={(e) => setAcceptHostKey(e.currentTarget.checked)}
            />
          )}
          {err && (
            <Text c="red.4" fz="sm">
              {err}
            </Text>
          )}
          <Group justify="flex-end" mt="xs">
            <Button color="gray" onClick={() => setReinstall(null)} variant="subtle">
              Отмена
            </Button>
            <Button
              color="red"
              disabled={(!reinstallPw && !reinstall?.hasPass) || (Boolean(reinstall?.hostKeyChanged) && !acceptHostKey)}
              loading={reinstallM.isPending}
              variant="soft"
              onClick={() => {
                setErr('');
                reinstallM.mutate({
                  id: reinstall!.id,
                  password: reinstallPw || undefined,
                  acceptNewHostKey: acceptHostKey || undefined,
                });
              }}
            >
              Переустановить
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* удаление */}
      <Modal centered onClose={() => setDelTarget(null)} opened={delTarget != null} title="Удалить сервер?">
        <Stack gap="md">
          <Text fz="sm">
            Сервер <b>{delTarget?.name}</b> ({delTarget?.address}) пропадёт из контура. Ноду на самом сервере это не трогает.
          </Text>
          <Group justify="flex-end">
            <Button color="gray" onClick={() => setDelTarget(null)} variant="subtle">
              Отмена
            </Button>
            <Button color="red" loading={del.isPending} onClick={() => del.mutate(delTarget!.id)} variant="soft">
              Удалить
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
