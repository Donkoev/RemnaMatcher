import { Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { PiWarningDuotone } from 'react-icons/pi';
import { timeAgo, type ScoringConfig, type UserDetail } from '../../api';
import { SectionCard } from '../rw/SectionCard';
import { BlockHeader } from './BlockHeader';

/** Чек-лист проверок в порядке приоритета: короткие однозначные названия */
const CHECKS: { cfgKey: keyof ScoringConfig['signals']; key: string; label: string }[] = [
  { key: 'ip_count', cfgKey: 'ipCount', label: 'Слишком много IP' },
  { key: 'traffic_rate', cfgKey: 'trafficRate', label: 'Всплеск трафика' },
  { key: 'multi_asn', cfgKey: 'multiAsn', label: 'Разные провайдеры' },
  { key: 'multi_country', cfgKey: 'multiCountry', label: 'Разные страны' },
  { key: 'datacenter', cfgKey: 'datacenter', label: 'IP датацентров' },
  { key: 'torrent', cfgKey: 'torrent', label: 'Торренты' },
];

/** Блок «Проверки»: есть / было (очки ещё затухают) / нет — по каждой включённой проверке */
export function ChecksCard({ score, cfg }: { score: UserDetail['score']; cfg: ScoringConfig | undefined }) {
  return (
    <SectionCard.Root gap="sm" h="100%">
      <SectionCard.Section>
        <BlockHeader color="orange" icon={<PiWarningDuotone size={18} />} title="Проверки" />
      </SectionCard.Section>
      <SectionCard.Section>
        <Stack gap={6}>
          {CHECKS.filter((c) => !cfg || cfg.signals[c.cfgKey].enabled).map((c) => {
            const hit = score?.signals.find((s) => s.key === c.key);
            // проверка сейчас чистая, но срабатывала раньше — её очки ещё затухают
            const seen = !hit ? score?.signalsSeen?.[c.key] : undefined;
            return (
              <Group gap="sm" justify="space-between" key={c.key} wrap="nowrap">
                <Text c={hit || seen ? undefined : 'dimmed'} fz="sm" lh={1.3}>
                  {c.label}
                </Text>
                {hit ? (
                  <Tooltip label={hit.evidence} maw={360} multiline radius="md">
                    <Badge color="red" size="sm" style={{ cursor: 'help', flexShrink: 0 }} variant="soft">
                      есть
                    </Badge>
                  </Tooltip>
                ) : seen ? (
                  <Tooltip
                    label={`Срабатывало ${timeAgo(seen.at)}: ${seen.evidence}. Очки фрода за это ещё не затухли — поэтому уровень держится.`}
                    maw={360}
                    multiline
                    radius="md"
                  >
                    <Badge color="yellow" size="sm" style={{ cursor: 'help', flexShrink: 0 }} variant="soft">
                      было
                    </Badge>
                  </Tooltip>
                ) : (
                  <Badge color="teal" size="sm" style={{ flexShrink: 0 }} variant="soft">
                    нет
                  </Badge>
                )}
              </Group>
            );
          })}
        </Stack>
      </SectionCard.Section>
    </SectionCard.Root>
  );
}
