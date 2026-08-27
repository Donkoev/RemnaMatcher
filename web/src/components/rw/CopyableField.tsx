import { ActionIcon, CopyButton, Group, Input } from '@mantine/core';
import { PiCheck, PiCopy } from 'react-icons/pi';
import type { ReactNode } from 'react';

// Портированный CopyableFieldShared из remnawave/frontend:
// readonly-инпут с моноширинным значением, клик копирует.
// meta — необязательные значки (флаг, датацентр) в правом краю поля, перед кнопкой копирования.

export function CopyableField({
  value,
  leftSection,
  meta,
  metaWidth = 0,
  size = 'sm',
}: {
  leftSection?: ReactNode;
  meta?: ReactNode;
  metaWidth?: number;
  size?: 'lg' | 'md' | 'sm' | 'xl' | 'xs';
  value: number | string;
}) {
  return (
    <CopyButton timeout={2000} value={value.toString()}>
      {({ copied, copy }) => (
        <Input
          leftSection={leftSection}
          leftSectionPointerEvents={leftSection ? 'all' : 'none'}
          onClick={copy}
          readOnly
          rightSection={
            <Group gap={4} pr={2} wrap="nowrap">
              {meta}
              <ActionIcon color={copied ? 'teal' : 'gray'} onClick={copy} variant="subtle">
                {copied ? <PiCheck size={16} /> : <PiCopy size={16} />}
              </ActionIcon>
            </Group>
          }
          rightSectionPointerEvents="all"
          rightSectionWidth={34 + metaWidth}
          size={size}
          styles={{
            input: {
              cursor: 'copy',
              fontFamily: 'var(--mantine-font-family-monospace)',
              overflow: 'hidden',
              textOverflow: 'clip',
              whiteSpace: 'nowrap',
            },
          }}
          value={value.toString()}
        />
      )}
    </CopyButton>
  );
}
