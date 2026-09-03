import { useEffect, useMemo } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ActionIcon, AppShell, Badge, Burger, Button, Group, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
  TbDeviceMobileOff,
  TbDoorExit,
  TbFileImport,
  TbGauge,
  TbGavel,
  TbHeart,
  TbHistory,
  TbLogout,
  TbRadar2,
  TbServer2,
  TbSettings,
  TbSkull,
} from 'react-icons/tb';
import { PiShieldCheckeredDuotone } from 'react-icons/pi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, authApi } from './api';
import { UserModalHost } from './components/UserModalHost';
import { Dashboard } from './pages/Dashboard';
import { Journal } from './pages/Journal';
import { Hwid } from './pages/Hwid';
import { Punished } from './pages/Punished';
import { NodePanel } from './pages/NodePanel';
import { Settings } from './pages/Settings';
import { Whitelist } from './pages/Whitelist';
import { UserModalContext, userModalController } from './userModal';

const NAV_SECTIONS: { title: string; items: { to: string; label: string; Icon: React.ComponentType }[] }[] = [
  {
    title: 'Мониторинг',
    items: [
      { to: '/', label: 'Обзор', Icon: TbRadar2 },
      { to: '/journal', label: 'Журнал', Icon: TbHistory },
    ],
  },
  {
    title: 'Списки',
    items: [
      { to: '/punished', label: 'Наказанные', Icon: TbGavel },
      { to: '/whitelist', label: 'Белый список', Icon: TbHeart },
      { to: '/hwid', label: 'HWID', Icon: TbDeviceMobileOff },
    ],
  },
  {
    title: 'Система',
    items: [{ to: '/settings', label: 'Настройки', Icon: TbSettings }],
  },
];

export function App() {
  const qc = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure();
  const [desktopNavOpened, { toggle: toggleDesktopNav }] = useDisclosure(true);
  const isMobile = useMediaQuery('(max-width: 48em)');
  const { data: overview } = useQuery({ queryKey: ['overview'], queryFn: api.overview });

  // SSE: обновляем данные после каждого цикла коллектора и при инцидентах
  useEffect(() => {
    const es = new EventSource('/api/events');
    const invalidate = () => {
      void qc.invalidateQueries({ queryKey: ['overview'] });
      void qc.invalidateQueries({ queryKey: ['suspects'] });
      void qc.invalidateQueries({ queryKey: ['incidents'] });
      void qc.invalidateQueries({ queryKey: ['actions-log'] });
      void qc.invalidateQueries({ queryKey: ['lists'] });
      void qc.invalidateQueries({ queryKey: ['user'] }); // открытая карточка юзера тоже обновляется
    };
    es.addEventListener('cycle', invalidate);
    es.addEventListener('incident', invalidate);
    return () => es.close();
  }, [qc]);

  const modalCtx = useMemo(() => ({ openUser: (id: number) => userModalController.open(id) }), []);
  const newIncidents = overview?.totals.newIncidents ?? 0;
  // режим инфраструктуры: внутри раздела узлов вся оболочка преображается — как отдельная панель
  const nodeMode = location.pathname.startsWith('/nodes') && Boolean(overview?.nodePanel);

  // вход в раздел инфраструктуры — набрать кодовое слово SSS (физические клавиши —
  // работает на любой раскладке); повторный набор внутри выкидывает обратно в панель
  useEffect(() => {
    if (!overview?.nodePanel) return;
    const SEQ = ['KeyS', 'KeyS', 'KeyS'];
    let buf: string[] = [];
    let lastTs = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // не-буква или пауза дольше 1.5 c сбрасывают набор — слово надо ввести подряд
      if (!/^Key[A-Z]$/.test(e.code)) {
        buf = [];
        return;
      }
      const now = Date.now();
      if (now - lastTs > 1500) buf = [];
      lastTs = now;
      buf.push(e.code);
      if (buf.length > SEQ.length) buf.shift();
      if (SEQ.every((c, i) => buf[i] === c)) {
        buf = [];
        void navigate(location.pathname.startsWith('/nodes') ? '/' : '/nodes');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overview?.nodePanel, location.pathname, navigate]);

  return (
    <UserModalContext.Provider value={modalCtx}>
      <AppShell
        header={{ height: 56, offset: false }}
        layout="alt"
        navbar={{
          width: 300,
          breakpoint: 'sm',
          collapsed: { mobile: !navOpened, desktop: !desktopNavOpened },
        }}
        padding={{ base: 'md', sm: 'xl' }}
      >
        {/* как в Remnawave: прозрачная шапка с блюром, бургер слева; сайдбар — на всю высоту */}
        <AppShell.Header
          style={{ background: 'transparent', backdropFilter: 'blur(7px)', WebkitBackdropFilter: 'blur(7px)' }}
          withBorder={false}
        >
          <Group gap="sm" h="100%" px="lg">
            <Burger
              onClick={isMobile ? toggleNav : toggleDesktopNav}
              opened={isMobile ? navOpened : desktopNavOpened}
              size="sm"
            />
          </Group>
        </AppShell.Header>

        <AppShell.Navbar className={nodeMode ? 'rw-sidebar rw-sidebar-red' : 'rw-sidebar'} p="md" withBorder={false}>
          {nodeMode ? (
            // ---- режим инфраструктуры: свой сайдбар, обычные кнопки скрыты ----
            <Stack gap="lg" h="100%" key="red">
              <div className="rw-logo-section">
                <Group gap="sm" justify="center" wrap="nowrap">
                  <Burger
                    hiddenFrom="sm"
                    onClick={closeNav}
                    opened
                    size="sm"
                    style={{ position: 'absolute', left: 4 }}
                  />
                  <ThemeIcon color="red" radius="md" size={40} variant="soft">
                    <TbSkull size={26} />
                  </ThemeIcon>
                  <Stack gap={0}>
                    <Text c="red.3" fw={700} fz="lg" lh={1.1}>
                      Инфраструктура
                    </Text>
                    <Text c="dimmed" fz="xs">
                      узлы RemnaMatcher
                    </Text>
                  </Stack>
                </Group>
              </div>

              <Stack gap="md">
                <div>
                  <div className="rw-section-title rw-section-title-red">Управление</div>
                  <Stack gap={4}>
                    <NavLink
                      className="rw-nav-link rw-nav-link-red"
                      data-active={location.pathname.startsWith('/nodes/servers') || undefined}
                      onClick={closeNav}
                      to="/nodes/servers"
                    >
                      <TbServer2 />
                      <span style={{ flex: 1 }}>Серверы</span>
                    </NavLink>
                    <NavLink
                      className="rw-nav-link rw-nav-link-red"
                      data-active={location.pathname.startsWith('/nodes/configs') || undefined}
                      onClick={closeNav}
                      to="/nodes/configs"
                    >
                      <TbFileImport />
                      <span style={{ flex: 1 }}>Конфигурации</span>
                    </NavLink>
                    <NavLink
                      className="rw-nav-link rw-nav-link-red"
                      data-active={location.pathname.startsWith('/nodes/speedtest') || undefined}
                      onClick={closeNav}
                      to="/nodes/speedtest"
                    >
                      <TbGauge />
                      <span style={{ flex: 1 }}>Speedtest</span>
                    </NavLink>
                    {/* будущие разделы добавятся сюда по мере готовности */}
                  </Stack>
                </div>
              </Stack>

              <div style={{ flexGrow: 1 }} />

              {/* выход из раздела — обратно в обычную панель */}
              <Button
                color="red"
                fullWidth
                leftSection={<TbDoorExit size={18} />}
                onClick={() => {
                  closeNav();
                  void navigate('/');
                }}
                variant="soft"
              >
                Вернуться в панель
              </Button>
            </Stack>
          ) : (
          <Stack gap="lg" h="100%" key="normal">
            <div className="rw-logo-section">
              <Group gap="sm" justify="center" wrap="nowrap">
                <Burger
                  hiddenFrom="sm"
                  onClick={closeNav}
                  opened
                  size="sm"
                  style={{ position: 'absolute', left: 4 }}
                />
                <ThemeIcon color="cyan" radius="md" size={40} variant="soft">
                  <PiShieldCheckeredDuotone size={26} />
                </ThemeIcon>
                <Stack gap={0}>
                  <Text fw={700} fz="lg" lh={1.1}>
                    RemnaMatcher
                  </Text>
                  <Text c="dimmed" fz="xs">
                    антифрод для Remnawave
                  </Text>
                </Stack>
              </Group>
            </div>

            <Stack gap="md">
              {NAV_SECTIONS.map((section) => (
                <div key={section.title}>
                  <div className="rw-section-title">{section.title}</div>
                  <Stack gap={4}>
                    {section.items.map(({ to, label, Icon }) => (
                      <NavLink
                        className="rw-nav-link"
                        data-active={location.pathname === to || undefined}
                        key={to}
                        onClick={closeNav}
                        to={to}
                      >
                        <Icon />
                        <span style={{ flex: 1 }}>{label}</span>
                        {to === '/journal' && newIncidents > 0 && (
                          <Badge circle color="red" size="sm" variant="filled">
                            {newIncidents}
                          </Badge>
                        )}
                      </NavLink>
                    ))}
                  </Stack>
                </div>
              ))}
            </Stack>

            <div style={{ flexGrow: 1 }} />

            <Group gap="xs" justify="space-between" pb="xs" px={4}>
              {overview ? (
                <Group gap="xs">
                  <Badge color={overview.mode === 'mock' ? 'yellow' : 'teal'} size="sm" variant="soft">
                    {overview.mode === 'mock' ? 'MOCK' : 'LIVE'}
                  </Badge>
                  <Text c="dimmed" fz="xs">
                    {overview.totals.totalUsers.toLocaleString('en-US')} юзеров
                  </Text>
                </Group>
              ) : (
                <span />
              )}
              <Tooltip label="Выйти" radius="md">
                <ActionIcon
                  color="gray"
                  onClick={() => {
                    void authApi.logout().finally(() => window.location.reload());
                  }}
                  size="sm"
                  variant="subtle"
                >
                  <TbLogout size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Stack>
          )}
        </AppShell.Navbar>

        <AppShell.Main pt="calc(var(--app-shell-header-height) + 12px)">
          <Routes>
            <Route element={<Dashboard />} path="/" />
            <Route element={<Journal />} path="/journal" />
            <Route element={<Punished />} path="/punished" />
            <Route element={<Whitelist />} path="/whitelist" />
            <Route element={<Hwid />} path="/hwid" />
            <Route element={<Settings />} path="/settings" />
            {overview?.nodePanel && <Route element={<NodePanel />} path="/nodes/*" />}
          </Routes>
        </AppShell.Main>
      </AppShell>

      <UserModalHost />
    </UserModalContext.Provider>
  );
}
