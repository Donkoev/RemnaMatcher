/**
 * Скачивает бесплатные оффлайн-базы DB-IP Lite (city + ASN) в server/data/.
 * Запуск вручную: npm run -w server geoip. В live-режиме сервер качает их сам при старте
 * и обновляет раз в месяц (см. geo/download.ts).
 */
import { env } from '../config.js';
import { downloadGeoip } from '../geo/download.js';

await downloadGeoip(env.GEOIP_CITY_MMDB, env.GEOIP_ASN_MMDB);
console.log('Готово.');
