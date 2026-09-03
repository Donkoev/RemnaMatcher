import type { UserIp } from '../../api';

// Сортировка таблицы IP в отчёте: многоуровневая цепочка критериев (см. IpAddressesCard).
// Чистая логика без React — отдельно, чтобы её можно было тестировать и читать целиком.

export type IpSort =
  | 'recent'
  | 'oldest'
  | 'ip_asc'
  | 'ip_desc'
  | 'ip_subnet'
  | 'node_asc'
  | 'node_desc'
  | 'city_asc'
  | 'city_desc'
  | 'org_asc'
  | 'org_desc';

/** подсеть /24 — первые три октета */
export const subnetOf = (ip: string): string => ip.split('.').slice(0, 3).join('.');

/** числовое сравнение IP по октетам — заодно группирует подсети по первым трём октетам */
export function compareIp(a: string, b: string): number {
  const oa = a.split('.').map(Number);
  const ob = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (oa[i] ?? 0) - (ob[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** компаратор для одного критерия */
function compareBy(sort: IpSort, subnetCounts: Map<string, number>, now: number): (a: UserIp, b: UserIp) => number {
  // активность сравниваем по возрасту в минутах — ровно так, как она показана в строке:
  // иначе секунды всегда различаются и до следующих критериев цепочки очередь не доходит
  const ageMin = (t: number) => Math.floor(Math.max(0, now - t) / 60_000);
  switch (sort) {
    case 'recent': return (a, b) => ageMin(a.lastSeen) - ageMin(b.lastSeen);
    case 'oldest': return (a, b) => ageMin(b.lastSeen) - ageMin(a.lastSeen);
    case 'ip_asc': return (a, b) => compareIp(a.ip, b.ip);
    case 'ip_desc': return (a, b) => compareIp(b.ip, a.ip);
    case 'ip_subnet':
      // подсети с наибольшим числом IP — сверху, внутри по адресу
      return (a, b) => {
        const d = (subnetCounts.get(subnetOf(b.ip)) ?? 0) - (subnetCounts.get(subnetOf(a.ip)) ?? 0);
        if (d !== 0) return d;
        const sa = subnetOf(a.ip);
        const sb = subnetOf(b.ip);
        if (sa !== sb) return compareIp(a.ip, b.ip);
        return 0;
      };
    case 'node_asc': return (a, b) => (a.nodes ?? 'я').localeCompare(b.nodes ?? 'я', 'ru');
    case 'node_desc': return (a, b) => (b.nodes ?? 'я').localeCompare(a.nodes ?? 'я', 'ru');
    case 'city_asc': return (a, b) => (a.city ?? 'я').localeCompare(b.city ?? 'я', 'ru');
    case 'city_desc': return (a, b) => (b.city ?? 'я').localeCompare(a.city ?? 'я', 'ru');
    case 'org_asc': return (a, b) => (a.asnOrg ?? 'я').localeCompare(b.asnOrg ?? 'я', 'ru');
    case 'org_desc': return (a, b) => (b.asnOrg ?? 'я').localeCompare(a.asnOrg ?? 'я', 'ru');
  }
}

/**
 * Многоуровневая сортировка. «По подсетям» во главе цепочки — это ГРУППИРОВКА:
 * строки внутри группы и порядок самих групп подчиняются остальным критериям
 * (группы сперва по размеру, при равенстве — по верхней строке группы).
 */
export function sortIps(ips: UserIp[], chain: IpSort[], now = Date.now()): UserIp[] {
  const subnetCounts = new Map<string, number>();
  for (const i of ips) subnetCounts.set(subnetOf(i.ip), (subnetCounts.get(subnetOf(i.ip)) ?? 0) + 1);

  // когда все критерии цепочки равны — добиваем точным временем и адресом,
  // чтобы порядок был строгим сверху вниз, без «как получится»
  const finalCmp = (a: UserIp, b: UserIp): number => {
    const d = b.lastSeen - a.lastSeen;
    if (d !== 0) return d;
    return compareIp(a.ip, b.ip);
  };

  if (chain[0] === 'ip_subnet') {
    const rest = chain.slice(1).filter((c) => c !== 'ip_subnet');
    const restCmp = (a: UserIp, b: UserIp): number => {
      for (const c of rest) {
        const d = compareBy(c, subnetCounts, now)(a, b);
        if (d !== 0) return d;
      }
      return finalCmp(a, b);
    };
    const groups = new Map<string, UserIp[]>();
    for (const ip of ips) {
      const s = subnetOf(ip.ip);
      const g = groups.get(s) ?? [];
      g.push(ip);
      groups.set(s, g);
    }
    const sorted = [...groups.values()].map((rows) => [...rows].sort(restCmp));
    sorted.sort((ga, gb) => {
      const d = gb.length - ga.length;
      if (d !== 0) return d;
      return restCmp(ga[0]!, gb[0]!);
    });
    return sorted.flat();
  }

  const comparators = chain.map((c) => compareBy(c, subnetCounts, now));
  return [...ips].sort((a, b) => {
    for (const cmp of comparators) {
      const d = cmp(a, b);
      if (d !== 0) return d;
    }
    return finalCmp(a, b);
  });
}
