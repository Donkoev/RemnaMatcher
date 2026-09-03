import { Group, ThemeIcon, Title } from '@mantine/core';

/** Заголовок блока в стиле Remnawave: иконка в soft-квадрате + название */
export function BlockHeader({ color, icon, title }: { color: string; icon: React.ReactNode; title: string }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <ThemeIcon color={color} size="lg" variant="soft">
        {icon}
      </ThemeIcon>
      <Title c="white" order={5}>
        {title}
      </Title>
    </Group>
  );
}
