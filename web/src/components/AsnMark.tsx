import { Avatar, Text, Tooltip } from '@mantine/core';

/**
 * «Логотип» провайдера, как у 2ip: для известных ASN тянем фавиконку сайта
 * провайдера (сервис иконок DuckDuckGo), для остальных — цветная монограмма.
 * Если фавиконка не загрузилась (нет сети/иконки) — Avatar сам падает на монограмму.
 */

const ASN_DOMAINS: Record<number, string> = {
  // мобильные и домашние операторы
  8359: 'mts.ru',
  13174: 'mts.ru',
  25159: 'megafon.ru',
  31133: 'megafon.ru',
  31163: 'megafon.ru',
  3216: 'beeline.ru',
  16345: 'beeline.ru',
  12958: 't2.ru',
  39811: 't2.ru',
  42437: 't2.ru',
  12389: 'rt.ru',
  43574: 'rt.ru',
  42610: 'mgts.ru',
  8369: 'is74.ru',
  9049: 'ertelecom.ru',
  31200: 'novotelecom.ru',
  41786: 'ufanet.ru',
  205638: 'tbank.ru',
  6697: 'beltelecom.by',
  9198: 'telecom.kz',
  44725: 'kcell.kz',
  29555: 'beeline.kz',
  8193: 'uztelecom.uz',
  // датацентры и облака (ASN сверены с живыми данными панели)
  24940: 'hetzner.com',
  14061: 'digitalocean.com',
  20473: 'vultr.com',
  16276: 'ovhcloud.com',
  16509: 'aws.amazon.com',
  14618: 'aws.amazon.com',
  15169: 'cloud.google.com',
  396982: 'cloud.google.com',
  8075: 'azure.microsoft.com',
  63949: 'linode.com',
  62005: 'bluevps.com',
  62240: 'bluevps.com',
  61254: 'estoxy.com',
  209641: 'estoxy.com',
  58212: 'dataforest.net',
  208677: 'cloud.ru',
  51219: 'cloud.ru',
  216071: 'aeza.net',
  9123: 'timeweb.cloud',
  49505: 'selectel.ru',
  92: 'contabo.com',
  51167: 'contabo.com',
  // региональные операторы с живых данных
  49724: 'vainahtelecom.ru',
  44507: 'kmtn.ru',
  24955: 'ufanet.ru',
  47895: 'r-line.ru',
  57227: 'subnet05.ru',
  39434: 'subnet05.ru',
  3920: 'pushpkt.com',
  25513: 'mgts.ru',
  28840: 'tattelecom.ru',
  201776: 'miranda-media.ru',
  47204: 'mcs.ooo',
  210616: 'sm117.ru',
  62440: 'plazma.vip',
};

// фолбэк по названию организации — ловит региональные ASN крупных брендов
const ORG_DOMAINS: [RegExp, string][] = [
  [/megafon/i, 'megafon.ru'],
  [/mts/i, 'mts.ru'],
  [/vimpelcom|beeline/i, 'beeline.ru'],
  [/rostelecom/i, 'rt.ru'],
  [/t2 mobile|tele2/i, 't2.ru'],
  [/er-?telecom/i, 'ertelecom.ru'],
  [/ufanet/i, 'ufanet.ru'],
  [/tbank/i, 'tbank.ru'],
  [/yota/i, 'yota.ru'],
  [/sber/i, 'sber.ru'],
  [/hetzner/i, 'hetzner.com'],
  [/digitalocean/i, 'digitalocean.com'],
  [/cloud\.ru|cloud technologies/i, 'cloud.ru'],
  [/bluevps/i, 'bluevps.com'],
  [/estoxy/i, 'estoxy.com'],
  [/dataforest/i, 'dataforest.net'],
  [/aeza/i, 'aeza.net'],
  [/timeweb/i, 'timeweb.cloud'],
  [/selectel/i, 'selectel.ru'],
  [/beltelecom/i, 'beltelecom.by'],
  [/kaspnet/i, 'kaspnet.ru'],
  [/subnet/i, 'subnet05.ru'],
  [/erline|r-line/i, 'r-line.ru'],
  [/pushpkt/i, 'pushpkt.com'],
  [/tattelecom/i, 'tattelecom.ru'],
  [/moscow city telephone/i, 'mgts.ru'],
  [/miranda-?media/i, 'miranda-media.ru'],
  [/plazmatelekom/i, 'plazma.vip'],
  [/kaztelecom|kazakhtelecom/i, 'telecom.kz'],
  [/kcell/i, 'kcell.kz'],
  [/uztelecom/i, 'uztelecom.uz'],
];

function resolveDomain(asn: number | null, org: string | null): string | undefined {
  if (asn !== null && ASN_DOMAINS[asn]) return ASN_DOMAINS[asn];
  if (org) {
    for (const [re, domain] of ORG_DOMAINS) if (re.test(org)) return domain;
  }
  return undefined;
}

const ASN_COLORS = ['blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'grape', 'violet', 'indigo', 'pink'];
const ORG_NOISE = /^(pjsc|llc|jsc|ltd\.?|oao|ooo|zao|gmbh|ou|inc\.?|corp\.?|s\.?a\.?|trading|as)$/i;

export function AsnMark({ asn, org }: { asn: number | null; org: string | null }) {
  const words = (org ?? '')
    .replace(/["«»]/g, '')
    .split(/[\s,]+/)
    .filter((w) => w && !ORG_NOISE.test(w));
  const initials =
    words.length >= 2
      ? `${words[0]![0]}${words[1]![0]}`.toUpperCase()
      : (words[0] ?? 'AS').slice(0, 2).toUpperCase();
  const color = ASN_COLORS[(asn ?? 0) % ASN_COLORS.length]!;
  const domain = resolveDomain(asn, org);

  return (
    <Tooltip label={org ?? (asn ? `AS${asn}` : 'провайдер неизвестен')} radius="md">
      <Avatar
        color={color}
        radius="sm"
        size={22}
        src={domain ? `/api/asn-icon/${domain}` : undefined}
        variant="light"
      >
        <Text fw={700} fz={9}>
          {initials}
        </Text>
      </Avatar>
    </Tooltip>
  );
}
