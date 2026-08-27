/**
 * Скачивает бесплатные оффлайн-базы DB-IP Lite (city + ASN) в server/data/.
 * Лицензия: https://db-ip.com/db/lite.php (CC BY 4.0, регистрация не нужна).
 * Запуск: npm run -w server geoip
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DATA_DIR = path.resolve('data');

function monthTag(offset = 0): string {
  const d = new Date();
  d.setMonth(d.getMonth() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function download(kind: 'city' | 'asn', dest: string): Promise<void> {
  for (const offset of [0, 1, 2]) {
    const url = `https://download.db-ip.com/free/dbip-${kind}-lite-${monthTag(offset)}.mmdb.gz`;
    process.stdout.write(`Пробую ${url} ... `);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`HTTP ${res.status}`);
      continue;
    }
    const gz = Buffer.from(await res.arrayBuffer());
    const raw = zlib.gunzipSync(gz);
    fs.writeFileSync(dest, raw);
    console.log(`ok, ${(raw.length / 1024 / 1024).toFixed(1)} МБ -> ${dest}`);
    return;
  }
  throw new Error(`Не удалось скачать базу dbip-${kind}-lite`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
await download('city', path.join(DATA_DIR, 'dbip-city-lite.mmdb'));
await download('asn', path.join(DATA_DIR, 'dbip-asn-lite.mmdb'));
console.log('Готово.');
