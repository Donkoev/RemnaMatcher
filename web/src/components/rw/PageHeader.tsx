import { Box, Card, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import type { ReactNode } from 'react';

// Портированный PageHeaderShared из remnawave/frontend

export function PageHeader({
  icon,
  title,
  description,
  actions,
}: {
  actions?: ReactNode;
  description?: string;
  icon: ReactNode;
  title: ReactNode;
}) {
  return (
    <Card className="rw-section-card" mb="md" padding="md" shadow="xl" withBorder={false}>
      <Box
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--mantine-spacing-md)',
        }}
      >
        <Group align="center" gap="md" wrap="nowrap" style={{ flex: '1 1 auto', minWidth: 0 }}>
          <ThemeIcon size="xl" variant="soft">
            {icon}
          </ThemeIcon>
          <Stack gap={0}>
            <Title order={4}>{title}</Title>
            {description && (
              <Text c="dimmed" fz="sm">
                {description}
              </Text>
            )}
          </Stack>
        </Group>
        {actions && (
          <Group gap="sm" justify="flex-end" style={{ marginLeft: 'auto' }} wrap="nowrap">
            {actions}
          </Group>
        )}
      </Box>
    </Card>
  );
}
