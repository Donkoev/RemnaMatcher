import React from 'react';
import ReactDOM from 'react-dom/client';
import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill';
import { BrowserRouter } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import './global.css';
import { theme } from './theme';
import { App } from './App';
import { AuthGate } from './components/AuthGate';

// Windows не рендерит emoji-флаги стран — Remnawave решает это шрифтом
// Twemoji Country Flags (он уже прописан в fontFamily темы), полифилл его подгружает
polyfillCountryFlagEmojis();

export const queryClient = new QueryClient({
  defaultOptions: {
    // staleTime повыше + placeholderData: при переключении вкладок показываем
    // кэш мгновенно, не дожидаясь refetch (SSE и так инвалидирует после каждого цикла)
    queries: { refetchInterval: 60_000, staleTime: 30_000, retry: 1 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} forceColorScheme="dark">
        <BrowserRouter>
          <AuthGate>
            <App />
          </AuthGate>
        </BrowserRouter>
      </MantineProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
