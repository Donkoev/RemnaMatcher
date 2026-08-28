import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  MODE: z.enum(['mock', 'live']).default('mock'),
  PORT: z.coerce.number().default(3300),

  REMNAWAVE_URL: z.string().url().optional(),
  REMNAWAVE_TOKEN: z.string().optional(),
  /** Секрет nginx-защиты панели в формате key=value; добавляется к каждому запросу (query + cookie) */
  REMNAWAVE_SECRET: z.string().optional(),
  /** Токен ipinfo.io для уточнения городов (бесплатный, 50k запросов/мес) */
  IPINFO_TOKEN: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.coerce.number().optional(),

  // периоды опроса/синка, окна и ретеншн живут в настройках панели (settings в БД), не в env

  DB_PATH: z.string().default('./data/remnamatcher.db'),
  GEOIP_CITY_MMDB: z.string().default('./data/dbip-city-lite.mmdb'),
  GEOIP_ASN_MMDB: z.string().default('./data/dbip-asn-lite.mmdb'),
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const res = EnvSchema.safeParse(process.env);
  if (!res.success) {
    console.error('[config] .env содержит ошибки — исправь и перезапусти:');
    for (const issue of res.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      if (issue.path[0] === 'REMNAWAVE_URL') {
        console.error('    подсказка: нужен полный URL панели Remnawave, например https://panel.example.com');
      }
    }
    process.exit(1);
  }
  return res.data;
}

export const env: Env = parseEnv();

export function assertLiveConfig(e: Env): asserts e is Env & { REMNAWAVE_URL: string; REMNAWAVE_TOKEN: string } {
  if (!e.REMNAWAVE_URL || !e.REMNAWAVE_TOKEN) {
    throw new Error('MODE=live требует REMNAWAVE_URL и REMNAWAVE_TOKEN в .env');
  }
}
