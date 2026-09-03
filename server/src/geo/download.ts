import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Бесплатные оффлайн-базы DB-IP Lite (city + ASN). Лицензия: https://db-ip.com/db/lite.php
 * (CC BY 4.0, регистрация не нужна). Выходят раз в месяц — старше этого срока базу считаем
 * протухшей: ASN и страны у адресов со временем дрейфуют.
 */
export const GEOIP_MAX_AGE_DAYS = 30;

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function monthTag(offset = 0): string {
  const d = new Date();
  d.setMonth(d.getMonth() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function downloadOne(kind: 'city' | 'asn', dest: string, log: (line: string) => void): Promise<void> {
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  // база за текущий месяц может ещё не выйти — пробуем до трёх последних
  for (const offset of [0, 1, 2]) {
    const url = `https://download.db-ip.com/free/dbip-${kind}-lite-${monthTag(offset)}.mmdb.gz`;
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      log(`${url}: HTTP ${res.status}`);
      continue;
    }
    const raw = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
    // пишем рядом и подменяем — оборванная закачка не оставит битый файл на месте рабочего
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, dest);
    log(`${url}: ok, ${(raw.length / 1024 / 1024).toFixed(1)} МБ -> ${dest}`);
    return;
  }
  throw new Error(`не удалось скачать базу dbip-${kind}-lite`);
}

export async function downloadGeoip(
  cityPath: string,
  asnPath: string,
  log: (line: string) => void = console.log,
): Promise<void> {
  await downloadOne('city', cityPath, log);
  await downloadOne('asn', asnPath, log);
}

/** возраст файла в днях; Infinity — файла нет */
export function fileAgeDays(p: string): number {
  try {
    return (Date.now() - fs.statSync(p).mtimeMs) / 864e5;
  } catch {
    return Infinity;
  }
}

/** пора перекачивать: хотя бы одной базы нет или она старше GEOIP_MAX_AGE_DAYS */
export function geoipStale(cityPath: string, asnPath: string): boolean {
  return Math.max(fileAgeDays(cityPath), fileAgeDays(asnPath)) > GEOIP_MAX_AGE_DAYS;
}
