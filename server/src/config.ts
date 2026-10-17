import { resolve } from 'node:path';

export interface Config {
  host: string; port: number; allowedOrigins: string[]; maxRooms: number; maxPlayers: number; roomCapacity: number;
  staticDir?: string;
}
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

export function validateOrigins(origins: string[]): string[] {
  if (!origins.length) throw new Error('ALLOWED_ORIGINS: укажите хотя бы один полный HTTP(S) origin сайта.');
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error(`ALLOWED_ORIGINS: некорректный origin ${origin}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
      throw new Error('ALLOWED_ORIGINS: разрешены только точные HTTP(S) origin без пути, завершающего / и wildcard.');
    }
  }
  return [...new Set(origins)];
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPort = env.PORT ?? env.SERVER_PORT ?? '3000';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65_535) {
    throw new Error('PORT/SERVER_PORT должен быть целым числом 1–65535.');
  }
  let origins: string[];
  if (env.ALLOWED_ORIGINS !== undefined) {
    origins = validateOrigins(env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean));
  } else if (env.PUBLIC_URL !== undefined || env.RENDER_EXTERNAL_URL !== undefined) {
    const source = env.PUBLIC_URL !== undefined ? 'PUBLIC_URL' : 'RENDER_EXTERNAL_URL';
    let publicUrl: URL;
    try { publicUrl = new URL(env[source]!); } catch { throw new Error(`${source}: укажите публичный HTTPS-адрес сайта.`); }
    if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
      throw new Error(`${source}: нужен HTTPS origin без пути, параметров и данных авторизации.`);
    }
    origins = [publicUrl.origin];
  } else if (env.NODE_ENV === 'production') {
    throw new Error('Для production задайте ALLOWED_ORIGINS, PUBLIC_URL или RENDER_EXTERNAL_URL.');
  } else {
    origins = [...DEV_ORIGINS, `http://localhost:${Number(rawPort)}`, `http://127.0.0.1:${Number(rawPort)}`];
  }
  if (env.STATIC_DIR !== undefined && !env.STATIC_DIR.trim()) {
    throw new Error('STATIC_DIR: укажите каталог собранного клиента или удалите переменную.');
  }
  return {
    host: '0.0.0.0', port: Number(rawPort), allowedOrigins: validateOrigins(origins),
    maxRooms: 4, maxPlayers: 32, roomCapacity: 8,
    ...(env.STATIC_DIR !== undefined ? { staticDir: resolve(env.STATIC_DIR) } : {}),
  };
}
