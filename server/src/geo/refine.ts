import type Database from 'better-sqlite3';
import { env } from '../config.js';

/**
 * Ленивое уточнение городов через ipinfo.io — точнее бесплатной DB-IP.
 * Каждый IP уточняется один раз и кэшируется в ip_meta навсегда (refined=1).
 * Дёргается при открытии отчёта юзера и фоном по IP подозрительных после цикла.
 */
export function createIpinfoRefiner(db: Database.Database): { refineIps: (ips: string[]) => void } {
  const queue = new Set<string>();
  let refining = false;
  let backoffUntil = 0;
  // экономим токен: сначала анонимные запросы, токен подключается,
  // когда ipinfo начинает резать анонимный лимит (429/403); через час пробуем анонимно снова
  let anonBlockedUntil = 0;

  const drain = async (): Promise<void> => {
    if (refining) return;
    refining = true;
    let okAnon = 0;
    let okToken = 0;
    try {
      const markRefined = db.prepare('UPDATE ip_meta SET refined = 1 WHERE ip = ?');
      const updateCity = db.prepare(
        'UPDATE ip_meta SET city = ?, country = COALESCE(?, country), refined = 1 WHERE ip = ?',
      );
      while (queue.size > 0) {
        if (Date.now() < backoffUntil) break;
        const ip = queue.values().next().value as string;
        queue.delete(ip);
        const row = db.prepare<[string], { refined: number }>('SELECT refined FROM ip_meta WHERE ip = ?').get(ip);
        if (!row || row.refined === 1) continue;
        const useToken = env.IPINFO_TOKEN !== undefined && Date.now() < anonBlockedUntil;
        try {
          const url = `https://ipinfo.io/${ip}/json${useToken ? `?token=${env.IPINFO_TOKEN}` : ''}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
          if (res.status === 429 || res.status === 403) {
            queue.add(ip);
            if (!useToken && env.IPINFO_TOKEN) {
              // анонимный лимит кончился — час работаем через токен
              anonBlockedUntil = Date.now() + 60 * 60_000;
              console.warn('[ipinfo] анонимный лимит исчерпан — переключаюсь на токен на час');
            } else {
              backoffUntil = Date.now() + 10 * 60_000;
              console.warn('[ipinfo] лимит запросов, пауза 10 минут');
            }
            continue;
          }
          if (!res.ok) {
            markRefined.run(ip);
            continue;
          }
          const j = (await res.json()) as { city?: string; country?: string };
          if (j.city) {
            updateCity.run(j.city, j.country ?? null, ip);
            if (useToken) okToken++;
            else okAnon++;
          } else {
            markRefined.run(ip);
          }
        } catch {
          // сеть моргнула — вернёмся к этому IP позже
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      refining = false;
      if (okAnon + okToken > 0) {
        const parts = [okAnon > 0 ? `${okAnon} анонимно` : null, okToken > 0 ? `${okToken} по токену` : null];
        console.log(`[ipinfo] уточнено городов: ${parts.filter(Boolean).join(', ')}`);
      }
    }
  };

  return {
    refineIps: (ips: string[]) => {
      for (const ip of ips) queue.add(ip);
      void drain();
    },
  };
}
