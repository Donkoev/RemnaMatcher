import { Card, Group, Stack, Text, ThemeIcon, type ThemeIconProps } from '@mantine/core';

// Портированный MetricCardShared из remnawave/frontend:
// градиентная карточка, иконка в soft-квадрате, значение моноширинным жирным.

export function MetricCard({
  icon,
  iconColor,
  title,
  value,
  subtitle,
}: {
  icon: React.ReactNode;
  iconColor?: ThemeIconProps['color'];
  subtitle?: string;
  title: string;
  value: number | string;
}) {
  return (
    <Card p="md" radius="md">
      <Group gap="md" wrap="nowrap">
        <ThemeIcon color={iconColor} radius="lg" size="xl" variant="soft">
          {icon}
        </ThemeIcon>
        <Stack gap={0} miw={0}>
          <Text
            c="dimmed"
            fw={500}
            fz="sm"
            lh={1.4}
            style={{ letterSpacing: '0.01em' }}
            truncate="end"
          >
            {title}
          </Text>
          <Text c="white" ff="monospace" fw={700} fz="xl" lh={1.2} truncate="end">
            {typeof value === 'number' ? value.toLocaleString('en-US') : value}
          </Text>
          {subtitle && (
            <Text c="dimmed" fz="xs">
              {subtitle}
            </Text>
          )}
        </Stack>
      </Group>
    </Card>
  );
}
