import {
  ActionIcon,
  Badge,
  Button,
  Card,
  createTheme,
  defaultVariantColorsResolver,
  LoadingOverlay,
  Menu,
  Modal,
  Paper,
  parseThemeColor,
  rgba,
  Switch,
  Table,
  TextInput,
  Tooltip,
  type VariantColorsResolver,
} from '@mantine/core';

// Тема воспроизведена по исходникам remnawave/frontend@2.7.4
// (src/shared/constants/theme) — палитра, вариант "soft", оверрайды компонентов.

const variantColorResolver: VariantColorsResolver = (input) => {
  const defaultResolvedColors = defaultVariantColorsResolver(input);

  if (input.variant === 'soft') {
    const parsed = parseThemeColor({
      color: input.color || 'gray',
      theme: input.theme,
      colorScheme: 'dark',
    });
    const c1 = input.theme.colors[parsed.color]![6]!;
    const c2 = input.theme.colors[parsed.color]![7]!;
    return {
      background: `linear-gradient(135deg, ${rgba(c1, 0.15)} 0%, ${rgba(c2, 0.1)} 100%)`,
      border: `1px solid ${rgba(c1, 0.3)}`,
      color: `var(--mantine-color-${parsed.color}-4)`,
      hover: rgba(input.theme.colors[parsed.color]![4]!, 0.1),
    };
  }

  return defaultResolvedColors;
};

export const theme = createTheme({
  variantColorResolver,
  cursorType: 'pointer',
  fontFamily:
    'Montserrat, Vazirmatn, Apple Color Emoji, Noto Sans SC, Twemoji Country Flags, sans-serif',
  fontFamilyMonospace: 'Fira Mono, monospace',
  breakpoints: {
    xs: '30em',
    sm: '40em',
    md: '48em',
    lg: '64em',
    xl: '80em',
    '2xl': '96em',
    '3xl': '120em',
    '4xl': '160em',
  },
  // шрифты чуть крупнее дефолта — по просьбе владельца
  fontSizes: {
    xs: '0.8125rem',
    sm: '0.9375rem',
    md: '1.0625rem',
    lg: '1.1875rem',
    xl: '1.375rem',
  },
  scale: 1,
  fontSmoothing: true,
  focusRing: 'never',
  white: '#ffffff',
  black: '#24292f',
  colors: {
    dark: [
      '#c9d1d9',
      '#b1bac4',
      '#8b949e',
      '#6e7681',
      '#484f58',
      '#30363d',
      '#21262d',
      '#161b22',
      '#0d1117',
      '#010409',
    ],
  },
  primaryShade: 8,
  primaryColor: 'cyan',
  autoContrast: true,
  luminanceThreshold: 0.3,
  headings: {
    fontWeight: '600',
  },
  defaultRadius: 'md',
  components: {
    ActionIcon: ActionIcon.extend({
      defaultProps: { radius: 'md', variant: 'outline' },
    }),
    Button: Button.extend({
      defaultProps: { radius: 'md', variant: 'light' },
      styles: { root: { transition: 'all 0.2s ease' } },
    }),
    Switch: Switch.extend({ defaultProps: { radius: 'md' } }),
    Badge: Badge.extend({ defaultProps: { radius: 'md', variant: 'outline' } }),
    Paper: Paper.extend({ defaultProps: { radius: 'md' } }),
    TextInput: TextInput.extend({ defaultProps: { radius: 'md' } }),
    Card: Card.extend({
      defaultProps: { radius: 'md', withBorder: true },
      styles: {
        root: {
          background:
            'linear-gradient(135deg, var(--mantine-color-dark-6) 0%, var(--mantine-color-dark-7) 100%)',
          animation: 'rwFadeIn 200ms linear both',
        },
      },
    }),
    Tooltip: Tooltip.extend({
      defaultProps: {
        radius: 'md',
        withArrow: true,
        transitionProps: { transition: 'scale-x', duration: 300 },
        arrowSize: 2,
        color: 'dark.6',
        styles: {
          tooltip: {
            border: '1px solid var(--mantine-color-dark-4)',
          },
        },
      },
    }),
    Menu: Menu.extend({
      defaultProps: {
        shadow: 'lg',
        withArrow: false,
        radius: 'md',
        transitionProps: { transition: 'fade', duration: 180, timingFunction: 'ease-out' },
        styles: {
          dropdown: {
            backgroundColor: 'var(--mantine-color-dark-6)',
            border: '1px solid var(--mantine-color-dark-5)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.2)',
          },
          divider: {
            borderColor: 'var(--mantine-color-dark-5)',
            margin: '4px 0',
          },
        },
      },
    }),
    Modal: Modal.extend({
      defaultProps: { radius: 'md', centered: true },
      styles: {
        content: { border: '1px solid rgba(255, 255, 255, 0.08)' },
        header: {
          background: 'rgba(22, 27, 35, 0.95)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
          padding: 'var(--mantine-spacing-sm) var(--mantine-spacing-lg)',
        },
        body: { padding: 'var(--mantine-spacing-sm)' },
      },
    }),
    Table: Table.extend({
      defaultProps: { highlightOnHover: true },
    }),
    LoadingOverlay: LoadingOverlay.extend({
      defaultProps: {
        zIndex: 1000,
        overlayProps: { radius: 'sm', blur: 4 },
      },
    }),
  },
});
