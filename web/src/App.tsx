import { useEffect, useMemo } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ActionIcon, AppShell, Badge, Burger, Group, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { TbDeviceMobileOff, TbGavel, TbHeart, TbHistory, TbLogout, TbRadar2, TbSettings } from 'react-icons/tb';
import { PiShieldCheckeredDuotone } from 'react-icons/pi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, authApi } from './api';
import { UserModalHost } from './components/UserModalHost';
import { Dashboard } from './pages/Dashboard';
import { Journal } from './pages/Journal';
import { Hwid } from './pages/Hwid';
import { Punished } from './pages/Punished';
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

        <AppShell.Navbar className="rw-sidebar" p="md" withBorder={false}>
          <Stack gap="lg" h="100%">
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
        </AppShell.Navbar>

        <AppShell.Main pt="calc(var(--app-shell-header-height) + 12px)">
          <Routes>
            <Route element={<Dashboard />} path="/" />
            <Route element={<Journal />} path="/journal" />
            <Route element={<Punished />} path="/punished" />
            <Route element={<Whitelist />} path="/whitelist" />
            <Route element={<Hwid />} path="/hwid" />
            <Route element={<Settings />} path="/settings" />
          </Routes>
        </AppShell.Main>
      </AppShell>

      <UserModalHost />
    </UserModalContext.Provider>
  );
}
