import fs from 'node:fs';
import { Reader, type AsnResponse, type CityResponse } from 'maxmind';
import { MOCK_POOLS } from './mock-pools.js';

export interface IpMeta {
  ip: string;
  asn: number | null;
  asnOrg: string | null;
  country: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  isDatacenter: boolean;
}

export interface GeoProvider {
  lookup(ip: string): IpMeta;
}

/** Ключевые слова в названии организации, указывающие на хостинг/ДЦ */
const DC_KEYWORDS = [
  'hosting', 'host', 'datacenter', 'data center', 'server', 'cloud', 'vps', 'vds', 'colo',
  'hetzner', 'ovh', 'digitalocean', 'digital ocean', 'amazon', 'aws', 'google', 'microsoft', 'azure',
  'oracle', 'alibaba', 'vultr', 'linode', 'akamai', 'contabo', 'selectel', 'timeweb', 'aeza',
  'servers.com', 'leaseweb', 'ionos', 'scaleway', 'upcloud', 'kamatera', 'gcore', 'g-core',
  'm247', 'datacamp', 'cdn77', 'stark industries', 'pq hosting', 'melbicom', 'justhost',
  'ihor', 'vdsina', 'firstbyte', 'adman', 'profitserver', '4vps', 'hostkey', 'ruvds',
];

/** Известные ASN датацентров — быстрый путь без анализа названия */
const DC_ASNS = new Set<number>([
  24940, 16509, 14618, 8075, 15169, 396982, 14061, 16276, 20473, 63949, 51167, 9009, 212317,
  216071, 49505, 9123, 197695, 48282, 29182, 20853,
]);

export function looksLikeDatacenter(asn: number | null, org: string | null): boolean {
  if (asn !== null && DC_ASNS.has(asn)) return true;
  if (!org) return false;
  const lower = org.toLowerCase();
  return DC_KEYWORDS.some((k) => lower.includes(k));
}

/** Реальный провайдер: оффлайн mmdb-базы (DB-IP lite / GeoLite2) */
export class MmdbGeoProvider implements GeoProvider {
  private city: Reader<CityResponse> | null = null;
  private asn: Reader<AsnResponse> | null = null;

  constructor(cityPath: string, asnPath: string) {
    if (fs.existsSync(cityPath)) {
      this.city = new Reader<CityResponse>(fs.readFileSync(cityPath));
    }
    if (fs.existsSync(asnPath)) {
      this.asn = new Reader<AsnResponse>(fs.readFileSync(asnPath));
    }
  }

  get ready(): { city: boolean; asn: boolean } {
    return { city: this.city !== null, asn: this.asn !== null };
  }

  lookup(ip: string): IpMeta {
    const cityRes = this.city?.get(ip) ?? null;
    const asnRes = this.asn?.get(ip) ?? null;
    const asn = asnRes?.autonomous_system_number ?? null;
    const asnOrg = asnRes?.autonomous_system_organization ?? null;
    return {
      ip,
      asn,
      asnOrg,
      country: cityRes?.country?.iso_code ?? null,
      city: cityRes?.city?.names?.en ?? null,
      lat: cityRes?.location?.latitude ?? null,
      lon: cityRes?.location?.longitude ?? null,
      isDatacenter: looksLikeDatacenter(asn, asnOrg),
    };
  }
}

/** Мок-провайдер: резолвит по префиксам пулов из mock-pools.ts */
export class MockGeoProvider implements GeoProvider {
  private byPrefix = new Map(MOCK_POOLS.map((p) => [p.prefix, p]));

  lookup(ip: string): IpMeta {
    const prefix = ip.split('.').slice(0, 2).join('.');
    const pool = this.byPrefix.get(prefix);
    if (!pool) {
      return { ip, asn: null, asnOrg: null, country: null, city: null, lat: null, lon: null, isDatacenter: false };
    }
    return {
      ip,
      asn: pool.asn,
      asnOrg: pool.org,
      country: pool.country,
      city: pool.city,
      lat: pool.lat,
      lon: pool.lon,
      isDatacenter: pool.dc,
    };
  }
}
