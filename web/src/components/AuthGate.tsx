import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  LoadingOverlay,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { PiShieldCheckeredDuotone, PiSignInDuotone } from 'react-icons/pi';
import { TbAlertCircle } from 'react-icons/tb';
import { useQueryClient } from '@tanstack/react-query';
import { authApi } from '../api';

type AuthState = 'loading' | 'setup' | 'login' | 'ready';

/**
 * Ворота авторизации в стиле логин-страницы Remnawave: двухцветный заголовок
 * шрифтом Unbounded + минималистичная форма. При первом запуске просят придумать
 * пароль администратора, дальше — вход. Приложение монтируется только после сессии.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<AuthState>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi
      .status()
      .then((s) => setState(s.setup ? 'setup' : s.authorized ? 'ready' : 'login'))
      .catch(() => setState('login'));
  }, []);

  // любой запрос словил 401 — сессия истекла, возвращаемся на вход
  useEffect(() => {
    const onUnauthorized = () => setState((prev) => (prev === 'ready' ? 'login' : prev));
    window.addEventListener('rm-unauthorized', onUnauthorized);
    return () => window.removeEventListener('rm-unauthorized', onUnauthorized);
  }, []);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (state === 'setup') {
      if (password.length < 8) return setError('Минимум 8 символов');
      if (password !== confirm) return setError('Пароли не совпадают');
    }
    setBusy(true);
    try {
      if (state === 'setup') await authApi.setup(password);
      else await authApi.login(password);
      setPassword('');
      setConfirm('');
      qc.clear();
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'ready') return <>{children}</>;

  if (state === 'loading') {
    return (
      <Box h="100dvh" pos="relative">
        <LoadingOverlay visible />
      </Box>
    );
  }

  return (
    <Center mih="100dvh" p="md">
      <Stack align="center" gap="xs">
        {/* как у Remnawave: иконка + двухцветный заголовок Unbounded */}
        <Group align="center" gap={10} justify="center">
          <PiShieldCheckeredDuotone color="var(--mantine-color-cyan-4)" size="3rem" />
          <Title ff="Unbounded, Montserrat, sans-serif" order={1}>
            <Text c="cyan" component="span" fw="inherit" fz="inherit" inherit>
              Remna
            </Text>
            <Text c="white" component="span" fw="inherit" fz="inherit" inherit>
              Matcher
            </Text>
          </Title>
        </Group>

        {state === 'setup' && (
          <Text c="dimmed" fz="sm">
            Первый запуск — придумай пароль администратора
          </Text>
        )}

        <Box maw="100%" p={30} w={{ base: '100%', xs: 440 }}>
          <form onSubmit={(e) => void submit(e)}>
            <Paper>
              <Stack gap="md">
                {error && (
                  <Alert color="red" icon={<TbAlertCircle size={16} />} py={8} variant="light">
                    {error}
                  </Alert>
                )}
                <PasswordInput
                  autoFocus
                  label="Пароль"
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  placeholder={state === 'setup' ? 'Минимум 8 символов' : 'Твой пароль'}
                  required
                  value={password}
                />
                {state === 'setup' && (
                  <PasswordInput
                    label="Повтор пароля"
                    onChange={(e) => setConfirm(e.currentTarget.value)}
                    placeholder="Ещё раз"
                    required
                    value={confirm}
                  />
                )}
                <Button
                  fullWidth
                  leftSection={<PiSignInDuotone size="16px" />}
                  loading={busy}
                  mt="md"
                  type="submit"
                  variant="default"
                >
                  {state === 'setup' ? 'Сохранить и войти' : 'Войти'}
                </Button>
              </Stack>
            </Paper>
          </form>
        </Box>
      </Stack>
    </Center>
  );
}
