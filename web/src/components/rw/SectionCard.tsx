import { Box, Card, Divider, Stack, type BoxProps, type CardProps, type MantineSpacing } from '@mantine/core';
import { Children, type ReactNode } from 'react';

// Портированный SectionCard из remnawave/frontend: плоская карточка
// rgba(255,255,255,0.02) с рамкой 0.08 и разделителями между секциями.

interface RootProps
  extends Omit<CardProps, 'children'>,
    Omit<React.ComponentPropsWithoutRef<'div'>, keyof CardProps | 'children'> {
  children: ReactNode;
  dividerOpacity?: number;
  gap?: MantineSpacing;
}

function Root({ children, dividerOpacity = 0.3, gap = 'md', p = 'md', radius = 'md', className, ...props }: RootProps) {
  const childArray = Children.toArray(children).filter(Boolean);
  const withDividers = childArray.reduce<ReactNode[]>((acc, child, i) => {
    acc.push(child);
    if (i < childArray.length - 1) {
      acc.push(<Divider key={`divider-${i}`} style={{ opacity: dividerOpacity }} />);
    }
    return acc;
  }, []);

  return (
    <Card className={`rw-section-card ${className ?? ''}`} p={p} radius={radius} withBorder={false} {...props}>
      <Stack gap={gap}>{withDividers}</Stack>
    </Card>
  );
}

interface SectionProps extends BoxProps, Omit<React.ComponentPropsWithoutRef<'div'>, keyof BoxProps | 'children'> {
  children: ReactNode;
}

function Section({ children, ...props }: SectionProps) {
  return <Box {...props}>{children}</Box>;
}

export const SectionCard = { Root, Section };
