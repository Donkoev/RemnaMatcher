/**
 * Пулы "сетей" для мок-режима. Префикс = первые два октета.
 * MockGeoProvider резолвит IP в мету по этим префиксам.
 * Названия ASN — реальные, как их отдаёт DB-IP по живым данным панели.
 */
export interface MockPool {
  prefix: string;
  asn: number;
  org: string;
  country: string;
  city: string;
  lat: number;
  lon: number;
  dc: boolean;
}

export const MOCK_POOLS: MockPool[] = [
  { prefix: '31.133', asn: 8359, org: 'MTS PJSC', country: 'RU', city: 'Moscow', lat: 55.75, lon: 37.62, dc: false },
  { prefix: '94.141', asn: 3216, org: 'PJSC Vimpelcom (Beeline)', country: 'RU', city: 'Moscow', lat: 55.75, lon: 37.62, dc: false },
  { prefix: '91.78', asn: 25159, org: 'PJSC MegaFon', country: 'RU', city: 'Moscow', lat: 55.75, lon: 37.62, dc: false },
  { prefix: '109.252', asn: 42610, org: 'NCNET (MGTS)', country: 'RU', city: 'Moscow', lat: 55.75, lon: 37.62, dc: false },
  { prefix: '77.222', asn: 12389, org: 'PJSC Rostelecom', country: 'RU', city: 'Saint Petersburg', lat: 59.94, lon: 30.31, dc: false },
  { prefix: '176.96', asn: 12389, org: 'PJSC Rostelecom', country: 'RU', city: 'Novosibirsk', lat: 55.03, lon: 82.92, dc: false },
  { prefix: '37.99', asn: 39811, org: 'T2 Mobile LLC', country: 'RU', city: 'Krasnodar', lat: 45.04, lon: 38.98, dc: false },
  { prefix: '95.153', asn: 8369, org: 'Intersvyaz-2 JSC', country: 'RU', city: 'Chelyabinsk', lat: 55.15, lon: 61.43, dc: false },
  { prefix: '213.87', asn: 8359, org: 'MTS PJSC', country: 'RU', city: 'Samara', lat: 53.2, lon: 50.15, dc: false },
  { prefix: '178.121', asn: 6697, org: 'Beltelecom', country: 'BY', city: 'Minsk', lat: 53.9, lon: 27.56, dc: false },
  { prefix: '89.218', asn: 9198, org: 'Kaztelecom', country: 'KZ', city: 'Almaty', lat: 43.24, lon: 76.89, dc: false },
  { prefix: '213.230', asn: 8193, org: 'Uztelecom', country: 'UZ', city: 'Tashkent', lat: 41.31, lon: 69.24, dc: false },
  { prefix: '185.163', asn: 62240, org: 'BlueVPS OU', country: 'EE', city: 'Tallinn', lat: 59.44, lon: 24.75, dc: true },
  { prefix: '92.63', asn: 209641, org: 'ESTOXY OU', country: 'EE', city: 'Tallinn', lat: 59.44, lon: 24.75, dc: true },
  { prefix: '157.90', asn: 24940, org: 'Hetzner Online GmbH', country: 'DE', city: 'Falkenstein', lat: 50.48, lon: 12.37, dc: true },
  { prefix: '45.87', asn: 58212, org: 'dataforest GmbH', country: 'DE', city: 'Frankfurt', lat: 50.11, lon: 8.68, dc: true },
  { prefix: '164.92', asn: 14061, org: 'DigitalOcean LLC', country: 'NL', city: 'Amsterdam', lat: 52.37, lon: 4.9, dc: true },
  { prefix: '85.143', asn: 51219, org: '"Cloud Technologies" LLC trading as Cloud.ru', country: 'RU', city: 'Moscow', lat: 55.75, lon: 37.62, dc: true },
];
