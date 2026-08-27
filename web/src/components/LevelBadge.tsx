import { Badge, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api, plural, type Level } from '../api';

const COLORS: Record<Level, string> = {
  green: 'teal',
  yellow: 'yellow',
  orange: 'orange',
  red: 'red',
};

export function LevelBadge({
  level,
  score,
  size = 'lg',
  tooltip,
}: {
  level: Level;
  score?: number;
  size?: string;
  /** свой контент тултипа вместо стандартного объяснения вероятности */
  tooltip?: React.ReactNode;
}) {
  // вероятность нормируется на порог красного уровня, чтобы 100% означало «точно раздача»
  const { data: cfg } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const red = cfg?.thresholds.red ?? 100;

  if (score === undefined) {
    return (
      <Badge color={COLORS[level]} size={size} variant="soft">
        {level === 'green' ? 'чистый' : level}
      </Badge>
    );
  }
  const pct = Math.min(100, Math.floor((score / red) * 100));
  return (
    <Tooltip
      label={
        tooltip ??
        `Вероятность, что ключ утёк и раздаётся (${Math.round(score)} ${plural(Math.round(score), ['очко фрода', 'очка фрода', 'очков фрода'])} из ${red})`
      }
      maw={380}
      multiline
      radius="md"
    >
      <Badge color={COLORS[level]} size={size} style={{ cursor: 'help' }} variant="soft">
        утечка · {pct}%
      </Badge>
    </Tooltip>
  );
}
